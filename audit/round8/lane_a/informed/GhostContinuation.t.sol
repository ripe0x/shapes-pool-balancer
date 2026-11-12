// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {PoolBalancer} from "../../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../../src/BalancerFactory.sol";
import {IFWAPool} from "../../../../src/interfaces/External.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";
import {AdversarialCurated, IFWARefund} from "./HostileCurated.t.sol";

contract GhostCreator is AdversarialCurated {
    function unlist(uint256[] calldata ids) external { balancer.unlistShapes(ids); }
    function claimAll(address to) external { balancer.claimSurplus(address(balancer).balance, to); }
}

contract GhostContinuationInformedTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant FWA_VRF_SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;
    address constant PLAYER = address(0xB0B);
    address constant THIEF = address(0xBAD);
    address constant KEEPER = address(0xBEEF);

    GhostCreator creator;
    PoolBalancer balancer;
    IFWAPool pool;

    function setUp() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.05 gwei);
        vm.deal(address(this), 10 ether); // Funds the external creator contract through its factory call.
        vm.deal(PLAYER, 1 ether);
        vm.deal(KEEPER, 1 ether);
        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        ShapePacks packs = new ShapePacks(SHAPES, address(renderer), address(this), "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        BalancerFactory factory = new BalancerFactory(address(impl), address(this));
        creator = new GhostCreator();
        creator.makePool{value: 2 ether}(factory);
        balancer = creator.balancer();
        pool = balancer.pool();
    }

    function testGhostDrawRefundAndPartialCreatorExit() public {
        uint256 ghostId = creator.list(false);
        creator.open();
        vm.prank(KEEPER);
        balancer.performUpkeep();
        assertEq(balancer.admissionStatus(), 0);
        uint256 activeBeforeSeize = pool.activeListingCount();
        vm.prank(THIEF);
        creator.seize(THIEF);
        assertEq(creator.ownerOf(1), THIEF);
        assertEq(pool.activeListingCount(), activeBeforeSeize);
        assertEq(balancer.admissionStatus(), 0);

        (uint256 fee, uint256 vrf, uint256 total) = pool.quoteAcquisitionPrice(1);
        assertEq(total, fee + vrf);
        uint256 version = pool.inventoryVersion();
        uint256 playerBefore = PLAYER.balance;
        vm.prank(PLAYER);
        uint256 request = pool.acquire{value: total}(
            PLAYER, fee, 0, 10_000, version, block.timestamp + 1 days
        );
        assertEq(playerBefore - PLAYER.balance, total, "EOA did not fund real FWA purchase");
        vm.roll(block.number + 1);
        uint256 trials = _selectGhost(request, ghostId);
        (,,, uint256 selected, uint8 acquisitionStatus,) = pool.acquisitions(request);
        assertEq(selected, ghostId);
        assertEq(acquisitionStatus, 7, "ghost delivery should fail");
        (,,,,,,, uint8 listingStatus) = pool.listings(ghostId);
        assertEq(listingStatus, 6, "ghost listing should be delivery-pending");
        assertEq(creator.ownerOf(1), THIEF);
        assertEq(pool.ownerProceeds(), 0, "failed delivery paid creator proceeds");

        vm.prank(KEEPER);
        balancer.performUpkeep();
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence());
        assertEq(balancer.admissionStatus(), 3, "single curated item was drawn");
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(PLAYER);
        pool.refundFailedDelivery(ghostId);
        vm.prank(PLAYER);
        IFWARefund(address(pool)).withdrawAcquisitionRefund();
        assertEq(PLAYER.balance, playerBefore - vrf, "acquisition fee was not refunded exactly");
        (,,,,,,, uint8 refundedStatus) = pool.listings(ghostId);
        assertEq(refundedStatus, 7, "listing not marked delivery-refunded");
        vm.expectRevert();
        creator.recover(ghostId, address(0xCAFE));
        assertEq(creator.ownerOf(1), THIEF, "failed recovery changed thief custody");

        creator.close();
        uint256[] memory ids = balancer.getActiveIds();
        assertEq(ids.length, 1, "Shape should be the only active item");
        uint256 beforeUnlist = address(balancer).balance;
        creator.unlist(ids);
        assertEq(address(balancer).balance - beforeUnlist, 0.01 ether, "Shape backing did not return");
        assertEq(balancer.getActiveIds().length, 0);
        uint256 liquid = address(balancer).balance;
        creator.claimAll(address(0xCAFE));
        assertEq(address(balancer).balance, 0);
        console2.log("ghost listing id", ghostId);
        console2.log("ghost word trials", trials);
        console2.log("player acquisition fee refunded wei", fee);
        console2.log("player VRF fee retained by router wei", vrf);
        console2.log("creator liquid exit wei", liquid);
    }

    function _selectGhost(uint256 request, uint256 ghostId) internal returns (uint256) {
        for (uint256 candidate = 1; candidate <= 8_000; ++candidate) {
            uint256 snapshot = vm.snapshotState();
            uint256[] memory words = new uint256[](1);
            words[0] = uint256(keccak256(abi.encodePacked("lane-a-ghost-continuation", request, candidate)));
            vm.prank(FWA_VRF_SERVICE); // Authorized real FWA coordinator-word delivery only.
            pool.rawFulfillRandomWords(request, words);
            pool.processAcquisitions(5);
            (,,, uint256 lid,,) = pool.acquisitions(request);
            if (lid == ghostId) return candidate;
            vm.revertToState(snapshot);
        }
        fail("ghost selection not reached");
        return 0;
    }
}
