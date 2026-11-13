// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {PoolBalancer} from "../../../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../../../src/BalancerFactory.sol";
import {IFWAPool, IShapes, IERC721Min} from "../../../../../src/interfaces/External.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";

// An actual purchaser contract that rejects any ERC721 safe-transfer callback.
contract RejectingShapeBuyer {
    receive() external payable {}

    function buy(IFWAPool pool, uint256 fee, uint256 version) external payable returns (uint256) {
        return pool.acquire{value: msg.value}(address(this), fee, 0, 10_000, version, block.timestamp + 1 days);
    }

    function refund(IFWAPool pool, uint256 lid) external { pool.refundFailedDelivery(lid); }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert("BuyerRejectsERC721");
    }
}

contract ReceiverGriefInformedTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant BAYC = 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;
    address constant FWA_VRF_SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;
    address constant PAYER = address(0xB0B);
    address constant KEEPER = address(0xBEEF);

    PoolBalancer balancer;
    IFWAPool pool;

    function setUp() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.05 gwei);
        assertEq(PAYER.code.length, 0);
        assertEq(KEEPER.code.length, 0);
        address creator = IERC721Min(BAYC).ownerOf(1);
        assertEq(creator.code.length, 0);
        vm.deal(creator, 2 ether);
        vm.deal(PAYER, 1 ether);
        vm.deal(KEEPER, 1 ether);
        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        ShapePacks packs = new ShapePacks(SHAPES, address(renderer), creator, "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        BalancerFactory factory = new BalancerFactory(address(impl), creator);
        vm.startPrank(creator);
        balancer = PoolBalancer(payable(factory.createBalancer{value: 1 ether}(bytes32(uint256(480)))));
        IERC721Min(BAYC).approve(address(balancer), 1);
        balancer.listCurated(BAYC, 1, 0.1 ether);
        balancer.configure(1500, 1);
        balancer.open();
        vm.stopPrank();
        pool = balancer.pool();
        vm.prank(KEEPER);
        balancer.performUpkeep();
        assertEq(balancer.admissionStatus(), 0);
    }

    function testRejectingBuyerStillReceivesShapeAndCannotRefund() public {
        RejectingShapeBuyer buyer = new RejectingShapeBuyer();
        (uint256 fee, uint256 vrf, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 version = pool.inventoryVersion();
        uint256 payerBefore = PAYER.balance;
        vm.prank(PAYER);
        uint256 request = buyer.buy{value: total}(pool, fee, version);
        assertEq(payerBefore - PAYER.balance, total, "code-free payer did not fund FWA request");
        vm.roll(block.number + 1);
        uint256 trials = _selectShape(request);
        (,,, uint256 lid, uint8 acqStatus,) = pool.acquisitions(request);
        assertEq(acqStatus, 2, "delivery failed despite FWA transferFrom");
        (address collection,, address recipient, uint256 tokenId,,,, uint8 listingStatus) = pool.listings(lid);
        assertEq(collection, SHAPES);
        assertEq(recipient, address(buyer));
        assertEq(listingStatus, 4, "listing should be delivered");
        assertEq(IShapes(SHAPES).ownerOf(tokenId), address(buyer));
        assertEq(IShapes(SHAPES).backingOf(tokenId), 0.01 ether);
        uint256 proceeds = pool.ownerProceeds();
        assertGt(proceeds, 0);
        uint256 keeperBefore = KEEPER.balance;
        uint256 liquidBefore = address(balancer).balance;
        vm.prank(KEEPER);
        uint256 reward = balancer.performUpkeep();
        assertEq(KEEPER.balance - keeperBefore, reward);
        assertEq(balancer.getActiveShapes()[0], 1, "winner Shape was not restocked");
        assertEq(balancer.keeperCredit(), 0);
        vm.warp(block.timestamp + 7 days + 1);
        vm.expectRevert();
        buyer.refund(pool, lid);
        assertEq(IShapes(SHAPES).ownerOf(tokenId), address(buyer));
        console2.log("actual payer total wei", total);
        console2.log("router fee wei", vrf);
        console2.log("owner proceeds wei", proceeds);
        console2.log("keeper reward wei", reward);
        console2.log("Balancer liquid before upkeep wei", liquidBefore);
        console2.log("Balancer liquid after upkeep wei", address(balancer).balance);
        console2.log("Shape word trials", trials);
    }

    function _selectShape(uint256 request) internal returns (uint256) {
        for (uint256 i = 1; i <= 1_000; ++i) {
            uint256 snapshot = vm.snapshotState();
            uint256[] memory words = new uint256[](1);
            words[0] = uint256(keccak256(abi.encodePacked("receiver-grief", request, i)));
            vm.prank(FWA_VRF_SERVICE);
            pool.rawFulfillRandomWords(request, words);
            pool.processAcquisitions(5);
            (,,, uint256 lid, uint8 status,) = pool.acquisitions(request);
            if (status == 2) {
                (address collection,,,,,,,) = pool.listings(lid);
                if (collection == SHAPES) return i;
            }
            vm.revertToState(snapshot);
        }
        fail("Shape selection not reached");
        return 0;
    }
}
