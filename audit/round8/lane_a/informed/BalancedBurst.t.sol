// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {PoolBalancer} from "../../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../../src/BalancerFactory.sol";
import {IFWAPool, IERC721Min} from "../../../../src/interfaces/External.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";

contract BalancedBurstInformedTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant BAYC = 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;
    address constant FWA_VRF_SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;
    address constant KEEPER = address(0xBEEF);
    address constant PLAYER = address(0xCAFE);

    PoolBalancer balancer;
    IFWAPool pool;

    function setUp() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.05 gwei);
        address creator = IERC721Min(BAYC).ownerOf(1);
        assertEq(creator.code.length, 0, "BAYC #1 owner must be an EOA actor");
        vm.deal(creator, 10 ether);
        vm.deal(KEEPER, 1 ether);
        vm.deal(PLAYER, 1 ether);

        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        ShapePacks packs = new ShapePacks(SHAPES, address(renderer), creator, "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        BalancerFactory factory = new BalancerFactory(address(impl), creator);

        vm.startPrank(creator);
        balancer = PoolBalancer(payable(factory.createBalancer{value: 4 ether}(bytes32(uint256(9001)))));
        pool = balancer.pool();
        uint256 plan = uint256(20) | (uint256(10) << 16) | (uint256(2) << 32) | (uint256(1) << 48)
            | (uint256(7) << (16 * 9));
        balancer.configure(1500, plan);
        IERC721Min(BAYC).approve(address(balancer), 1);
        balancer.listCurated(BAYC, 1, 0.3 ether);
        balancer.open();
        vm.stopPrank();

        for (uint256 i; i < 20 && balancer.creatorWork(); ++i) {
            vm.prank(KEEPER);
            balancer.performUpkeep();
        }
        assertFalse(balancer.creatorWork(), "stockup incomplete");
        assertEq(balancer.admissionStatus(), 0, "initial gate closed");
    }

    function testActualPayerTwoWinReserveAndGate() public {
        address creator = balancer.creator();
        uint256 claim = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(claim, creator);
        assertEq(address(balancer).balance, balancer.requiredReserve(), "not at maximum claim");
        assertEq(address(balancer).balance, 0.534 ether, "pre-burst reserve changed");

        (uint256 fee,, uint256 total) = pool.quoteAcquisitionPrice(2);
        uint256 version = pool.inventoryVersion();
        uint256 playerBefore = PLAYER.balance;
        vm.prank(PLAYER);
        uint256[] memory requests = pool.acquireBatch{value: total}(
            PLAYER, 2, fee, 0, 10_000, version, block.timestamp + 1 days
        );
        assertEq(playerBefore - PLAYER.balance, total, "actual EOA payer did not fund batch");
        assertEq(requests.length, 2);
        assertEq(pool.unsettledAcquisitionCount(), 2);
        assertEq(balancer.reconciledSequence(), 0);
        uint256 lost = 2 * (1e36 / 0.01 ether);
        uint256 tracked = balancer.prizeWeight();
        assertGt(tracked, lost);
        uint256 conservativeFillBps = (tracked - lost) * 10_000 / balancer.targetWeight();
        assertEq(balancer.admissionStatus(), conservativeFillBps < 7_000 ? 6 : 0, "M8 gate mismatch at 2 in flight");
        console2.log("M8 fill bps with 2 in flight", conservativeFillBps);

        vm.roll(block.number + 1);
        uint256 triesLarge = _selectRealOutcome(requests[0], 3);
        uint256 triesMedium = _selectRealOutcome(requests[1], 2);
        assertEq(pool.unsettledAcquisitionCount(), 0);
        uint256 proceeds = pool.ownerProceeds();
        assertGt(proceeds, 0);
        vm.prank(KEEPER);
        balancer.performUpkeep();

        uint16[16] memory have = balancer.getActiveShapes();
        assertEq(have[2], 2, "medium restock failed");
        assertEq(have[3], 0, "large restock unexpectedly succeeded");
        uint256 liquid = address(balancer).balance;
        uint256 reserve = balancer.requiredReserve();
        uint256 nextCost = 0.501 ether + 3_200_000 * 1.05 gwei + 0.0005 ether;
        assertLt(liquid, nextCost, "liquid balance unexpectedly funds next upkeep");
        vm.prank(KEEPER);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep();
        assertEq(balancer.admissionStatus(), 0, "gate should remain open above 70% weight");
        uint256 finalFillBps = balancer.prizeWeight() * 10_000 / balancer.targetWeight();
        assertGe(finalFillBps, 7_000);

        console2.log("fork block", block.number - 1);
        console2.log("creator max withdrawal wei", claim);
        console2.log("actual player payment wei", total);
        console2.log("large word trials", triesLarge);
        console2.log("medium word trials", triesMedium);
        console2.log("FWA owner proceeds wei", proceeds);
        console2.log("Balancer liquid wei", liquid);
        console2.log("restoration call shortfall wei", nextCost - liquid);
        console2.log("reported reserve shortfall wei", reserve - liquid);
        console2.log("M8 fill bps after upkeep", finalFillBps);
    }

    function testNoOpConfigureDuringIssuedDrawKeepsKeeperCreditCap() public {
        (uint256 fee,, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 version = pool.inventoryVersion();
        vm.prank(PLAYER);
        uint256 request = pool.acquire{value: total}(
            PLAYER, fee, 0, 10_000, version, block.timestamp + 1 days
        );
        assertEq(pool.unsettledAcquisitionCount(), 1);
        uint16 markup = balancer.markupBps();
        uint256 target = balancer.target();
        vm.prank(balancer.creator());
        balancer.configure(markup, target);
        assertFalse(balancer.creatorWork(), "no-op reclassified unsettled draw as creator work");

        vm.roll(block.number + 1);
        uint256 tries = _selectRealOutcome(request, 0);
        assertEq(pool.unsettledAcquisitionCount(), 0);
        uint256 creditBefore = balancer.keeperCredit();
        assertEq(creditBefore, 0);
        uint256 keeperBefore = KEEPER.balance;
        vm.prank(KEEPER);
        uint256 reward = balancer.performUpkeep();
        assertEq(KEEPER.balance - keeperBefore, reward);
        uint256 creditAfter = balancer.keeperCredit();
        uint256 restockCredit = balancer.restockFee();
        assertLe(reward, restockCredit, "purchase work exceeded credited restock fee");
        assertEq(creditAfter, restockCredit - reward);
        console2.log("F5 0.01 Shape word trials", tries);
        console2.log("F5 keeper reward wei", reward);
        console2.log("F5 restock credit wei", restockCredit);
    }

    function testTargetShrinkLeavesOldPrizesPurchasableUntilUnlisted() public {
        uint256 oldQuote = pool.acquisitionFee();
        uint256 oldWeight = pool.totalWeight();
        uint256 oldCount = pool.activeListingCount();
        vm.prank(balancer.creator());
        balancer.configure(1500, 20); // New target: only twenty 0.01 ETH Shapes.
        assertFalse(balancer.creatorWork());
        assertEq(pool.totalWeight(), oldWeight, "configure unexpectedly removed FWA inventory");
        assertEq(pool.activeListingCount(), oldCount);
        assertEq(pool.acquisitionFee(), oldQuote, "live quote changed despite unchanged FWA listings");
        assertEq(balancer.admissionStatus(), 0);

        (uint256 fee,, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 version = pool.inventoryVersion();
        uint256 playerBefore = PLAYER.balance;
        vm.prank(PLAYER);
        uint256 request = pool.acquire{value: total}(
            PLAYER, fee, 0, 10_000, version, block.timestamp + 1 days
        );
        assertEq(playerBefore - PLAYER.balance, total);
        vm.roll(block.number + 1);
        uint256 trials = _selectRealOutcome(request, 3); // Removed 0.5 ETH denomination remains live.
        (,,, uint256 lid, uint8 status,) = pool.acquisitions(request);
        (uint8 kind, uint8 denom,,,) = balancer.items(lid);
        assertEq(status, 2);
        assertEq(kind, 2);
        assertEq(denom, 3);
        vm.prank(KEEPER);
        balancer.performUpkeep();
        uint16[16] memory have = balancer.getActiveShapes();
        assertEq(have[3], 0, "removed denomination was restocked");
        console2.log("Q-R8-008 old live acquisition fee wei", oldQuote);
        console2.log("Q-R8-008 player payment wei", total);
        console2.log("Q-R8-008 removed-denom word trials", trials);
    }

    function _selectRealOutcome(uint256 requestId, uint8 wantedDenom) internal returns (uint256) {
        for (uint256 candidate = 1; candidate <= 8_000; ++candidate) {
            uint256 snapshot = vm.snapshotState();
            uint256[] memory words = new uint256[](1);
            words[0] = uint256(keccak256(abi.encodePacked("lane-a-independent-inform", requestId, candidate)));
            vm.prank(FWA_VRF_SERVICE); // The real FWA service delivers a candidate word on this fork.
            pool.rawFulfillRandomWords(requestId, words);
            pool.processAcquisitions(5);
            (,,, uint256 lid, uint8 status,) = pool.acquisitions(requestId);
            (uint8 kind, uint8 denom,,,) = balancer.items(lid);
            if (status == 2 && kind == 2 && denom == wantedDenom) return candidate;
            vm.revertToState(snapshot);
        }
        fail("selected outcome not reached in 8,000 real FWA deliveries");
        return 0;
    }
}
