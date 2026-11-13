// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {PoolBalancer} from "../../../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../../../src/BalancerFactory.sol";
import {IFWAPool} from "../../../../../src/interfaces/External.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";
import {FeeCreator} from "../mint_fee/MintFeeFork.t.sol";

interface IHighFeeShapes {
    function admin() external view returns (address);
    function mintFee() external view returns (uint256);
    function setMintFee(uint256 newFee) external;
    function feeRecipient() external view returns (address);
    function pendingFees() external view returns (uint256);
    function feesOwedTo(address recipient) external view returns (uint256);
    function redeemableBacking() external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function backingOf(uint256 tokenId) external view returns (uint256);
    function redeem(uint256 tokenId) external;
    function withdrawFees(address recipient) external;
}

interface IHighFeeVRFService {
    function coordinator() external view returns (address);
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata words) external;
}

contract HighFeeWinnerForkTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant ADMIN = 0xCB43078C32423F5348Cab5885911C3B5faE217F9;
    address constant RECIPIENT = 0xD4ba7cA95f3983514DDa317C4428CDb8F59c7e72;
    address constant PLAYER = address(0xB0B);
    address constant KEEPER = address(0xBEEF);
    address constant SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;
    address constant COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;

    FeeCreator creator;
    PoolBalancer balancer;
    IFWAPool pool;
    IHighFeeShapes shapes = IHighFeeShapes(SHAPES);

    function setUp() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.05 gwei);
        assertEq(PLAYER.code.length, 0);
        assertEq(KEEPER.code.length, 0);
        assertEq(shapes.admin(), ADMIN);
        assertEq(shapes.feeRecipient(), RECIPIENT);
        assertEq(shapes.mintFee(), 0.001 ether);
        assertEq(keccak256(ADMIN.code), keccak256(hex"ef0100612373d7003d694220f7800eeaf8e3924c0951d3"));
        assertEq(IHighFeeVRFService(SERVICE).coordinator(), COORDINATOR);
        vm.deal(address(this), 3 ether);
        vm.deal(PLAYER, 1 ether);
        vm.deal(KEEPER, 1 ether);
        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        ShapePacks packs = new ShapePacks(SHAPES, address(renderer), address(this), "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        BalancerFactory factory = new BalancerFactory(address(impl), address(this));
        creator = new FeeCreator();
        creator.makePool{value: 1 ether}(factory);
        balancer = creator.balancer();
        pool = balancer.pool();
    }

    function testWinnerPaysAt005MintFeeAndRedeemsBacking() public { _run(0.005 ether); }
    function testWinnerPaysAt010MintFeeAndRedeemsBacking() public { _run(0.01 ether); }

    function _run(uint256 newFee) internal {
        uint256 feesBefore = shapes.pendingFees();
        uint256 owedBefore = shapes.feesOwedTo(RECIPIENT);
        uint256 backingBefore = shapes.redeemableBacking();
        vm.prank(ADMIN); // EIP-7702 delegated external admin, not a protocol contract.
        shapes.setMintFee(newFee);
        creator.configure(1); // Explicitly accept the live mint fee before opening.
        assertEq(balancer.mintFeeCap(), newFee);
        creator.list();
        creator.open();
        vm.prank(KEEPER);
        balancer.performUpkeep();
        assertEq(balancer.admissionStatus(), 0);
        assertEq(shapes.pendingFees() - feesBefore, newFee);
        assertEq(shapes.feesOwedTo(RECIPIENT) - owedBefore, newFee);
        assertEq(shapes.redeemableBacking() - backingBefore, 0.01 ether);
        uint256[] memory ids = balancer.getActiveIds();
        assertEq(ids.length, 2);
        uint256 shapeListing;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = balancer.items(ids[i]);
            if (kind == 2) shapeListing = ids[i];
        }
        assertGt(shapeListing, 0);
        (,,, uint256 tokenId,, uint256 shapePrice,, uint8 listingStatusBefore) = pool.listings(shapeListing);
        assertEq(listingStatusBefore, 1);
        assertEq(shapes.ownerOf(tokenId), address(pool));
        assertEq(shapes.backingOf(tokenId), 0.01 ether);
        assertEq(shapePrice, 0.01 ether + newFee + balancer.restockFee());

        (uint256 acquisitionFee, uint256 vrfFee, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 version = pool.inventoryVersion();
        uint256 playerBefore = PLAYER.balance;
        vm.prank(PLAYER);
        uint256 request = pool.acquire{value: total}(
            PLAYER, acquisitionFee, 0, 10_000, version, block.timestamp + 1 days
        );
        assertEq(playerBefore - PLAYER.balance, total);
        vm.roll(block.number + 1);
        uint256 trials = _selectShape(request, shapeListing);
        (,,, uint256 selected, uint8 acquisitionStatus,) = pool.acquisitions(request);
        (,,,,,,, uint8 listingStatusAfter) = pool.listings(shapeListing);
        assertEq(selected, shapeListing);
        assertEq(acquisitionStatus, 2);
        assertEq(listingStatusAfter, 4);
        assertEq(shapes.ownerOf(tokenId), PLAYER);
        assertEq(shapes.backingOf(tokenId), 0.01 ether);
        uint256 proceeds = pool.ownerProceeds();
        assertGt(proceeds, 0);
        uint256 balancerBeforeCollect = address(balancer).balance;
        vm.prank(KEEPER);
        assertEq(balancer.collectProceeds(), proceeds);
        assertEq(pool.ownerProceeds(), 0);
        assertEq(address(balancer).balance - balancerBeforeCollect, proceeds);

        uint256 recipientBefore = RECIPIENT.balance;
        uint256 owedAtWithdraw = shapes.feesOwedTo(RECIPIENT);
        shapes.withdrawFees(RECIPIENT);
        assertEq(RECIPIENT.balance - recipientBefore, owedAtWithdraw);
        assertEq(shapes.feesOwedTo(RECIPIENT), 0);
        uint256 winnerBeforeRedeem = PLAYER.balance;
        vm.prank(PLAYER);
        shapes.redeem(tokenId);
        assertEq(PLAYER.balance - winnerBeforeRedeem, 0.01 ether);
        assertEq(shapes.redeemableBacking(), backingBefore);
        console2.log("accepted Shapes mint fee wei", newFee);
        console2.log("Shape FWA listing price wei", shapePrice);
        console2.log("player acquisition fee wei", acquisitionFee);
        console2.log("player VRF fee wei", vrfFee);
        console2.log("player total paid wei", total);
        console2.log("FWA owner proceeds wei", proceeds);
        console2.log("new Shapes fee owed before withdraw wei", newFee);
        console2.log("fee recipient total payout wei", owedAtWithdraw);
        console2.log("winner backing redeemed wei", uint256(0.01 ether));
        console2.log("VRF word trials", trials);
    }

    function _selectShape(uint256 request, uint256 wantedListing) internal returns (uint256) {
        for (uint256 candidate = 1; candidate <= 5_000; ++candidate) {
            uint256 snapshot = vm.snapshotState();
            uint256[] memory words = new uint256[](1);
            words[0] = uint256(keccak256(abi.encodePacked("high-fee-winner", request, candidate)));
            vm.prank(COORDINATOR);
            IHighFeeVRFService(SERVICE).rawFulfillRandomWords(request, words);
            pool.processAcquisitions(5);
            (,,, uint256 selected, uint8 status,) = pool.acquisitions(request);
            if (status == 2 && selected == wantedListing) return candidate;
            vm.revertToState(snapshot);
        }
        fail("Shape outcome not reached");
        return 0;
    }
}
