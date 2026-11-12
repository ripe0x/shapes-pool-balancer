// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoolBalancer} from "../../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../../src/BalancerFactory.sol";
import {IFWAPool, IERC721Min} from "../../../../src/interfaces/External.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";

interface IRealVRFService {
    function coordinator() external view returns (address);
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata words) external;
}

contract BalancedRouterTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant BAYC = 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;
    address constant CREATOR = 0x46EFbAedc92067E6d60E84ED6395099723252496;
    address constant PLAYER = address(0xCAFE);
    address constant KEEPER = address(0xBEEF);
    address constant VRF_SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;
    address constant COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;

    PoolBalancer b;
    IFWAPool p;

    function setUp() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.05 gwei);
        assertEq(IRealVRFService(VRF_SERVICE).coordinator(), COORDINATOR);
        assertEq(PLAYER.code.length, 0);
        vm.deal(CREATOR, 10 ether);
        vm.deal(PLAYER, 2 ether);
        vm.deal(KEEPER, 1 ether);
        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        ShapePacks packs = new ShapePacks(SHAPES, address(renderer), CREATOR, "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        BalancerFactory factory = new BalancerFactory(address(impl), CREATOR);
        vm.startPrank(CREATOR);
        b = PoolBalancer(payable(factory.createBalancer{value: 4 ether}(bytes32(uint256(1)))));
        p = b.pool();
        uint256 plan = uint256(20) | (uint256(10) << 16) | (uint256(2) << 32) | (uint256(1) << 48)
            | (uint256(7) << (16 * 9));
        b.configure(1500, plan);
        IERC721Min(BAYC).approve(address(b), 1);
        b.listCurated(BAYC, 1, 0.3 ether);
        b.open();
        vm.stopPrank();
        for (uint256 i; i < 20 && b.creatorWork(); ++i) {
            vm.prank(KEEPER);
            b.performUpkeep();
        }
        assertFalse(b.creatorWork());
        assertEq(b.admissionStatus(), 0);
    }

    function testRealRouterTwoWinsThenNextPurchase() public {
        uint256 withdrawable = b.withdrawableSurplus();
        vm.prank(CREATOR);
        b.claimSurplus(withdrawable, CREATOR);
        assertEq(address(b).balance, b.requiredReserve());

        (uint256 fee,, uint256 total) = p.quoteAcquisitionPrice(2);
        uint256 version = p.inventoryVersion();
        uint256 payerBefore = PLAYER.balance;
        vm.prank(PLAYER, PLAYER);
        uint256[] memory requests = p.acquireBatch{value: total}(
            PLAYER, 2, fee, 0, 10_000, version, block.timestamp + 1 days
        );
        assertEq(payerBefore - PLAYER.balance, total);
        assertEq(p.unsettledAcquisitionCount(), 2);
        vm.roll(block.number + 1);
        uint256 triesLarge = _deliverSelectingDenom(requests[0], 3);
        uint256 triesMedium = _deliverSelectingDenom(requests[1], 2);
        assertEq(p.unsettledAcquisitionCount(), 0);
        vm.prank(KEEPER);
        b.performUpkeep();
        uint16[16] memory have = b.getActiveShapes();
        assertEq(have[2], 2);
        assertEq(have[3], 0);
        assertEq(b.admissionStatus(), 0);
        emit log_named_uint("largeWordTrials", triesLarge);
        emit log_named_uint("mediumWordTrials", triesMedium);
        emit log_named_uint("twoDrawTotal", total);
        emit log_named_uint("ownerProceeds", p.ownerProceeds());
        emit log_named_uint("balancerBalance", address(b).balance);
        emit log_named_uint("requiredReserve", b.requiredReserve());

        (uint256 nextFee,, uint256 nextTotal) = p.quoteAcquisitionPrice(1);
        uint256 nextVersion = p.inventoryVersion();
        uint256 nextBefore = PLAYER.balance;
        vm.prank(PLAYER, PLAYER);
        uint256 nextId = p.acquire{value: nextTotal}(
            PLAYER, nextFee, 0, 10_000, nextVersion, block.timestamp + 1 days
        );
        assertEq(nextBefore - PLAYER.balance, nextTotal);
        assertEq(p.unsettledAcquisitionCount(), 1);
        assertTrue(nextId != requests[0] && nextId != requests[1]);
        emit log_named_uint("thirdRequestId", nextId);
    }

    function _deliverSelectingDenom(uint256 requestId, uint8 wanted) internal returns (uint256 trials) {
        for (uint256 word = 1; word <= 5000; ++word) {
            uint256 snapshot = vm.snapshotState();
            uint256[] memory words = new uint256[](1);
            words[0] = uint256(keccak256(abi.encodePacked("lane-b-heavy", requestId, word)));
            vm.prank(COORDINATOR);
            IRealVRFService(VRF_SERVICE).rawFulfillRandomWords(requestId, words);
            p.processAcquisitions(5);
            (,,, uint256 lid, uint8 status,) = p.acquisitions(requestId);
            (uint8 kind, uint8 denom,,,) = b.items(lid);
            if (status == 2 && kind == 2 && denom == wanted) return word;
            vm.revertToState(snapshot);
        }
        fail("requested prize not selected within 5000 deliveries");
    }
}
