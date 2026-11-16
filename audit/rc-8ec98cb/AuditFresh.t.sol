// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {console2} from "forge-std/console2.sol";
import {ERC721} from "solady/tokens/ERC721.sol";

interface IFWAOwnerSwitch {
    function owner() external view returns (address);
    function setGlobalWithdrawOnly(bool enabled) external;
}

interface IFWAPlayerRefund {
    function acquisitionRefundCredit(address purchaser) external view returns (uint256);
    function withdrawAcquisitionRefund() external returns (uint256);
}

contract GasContextProbe {
    uint256 public seenBasefee;
    uint256 public seenGasprice;
    function sample() external {
        seenBasefee = block.basefee;
        seenGasprice = tx.gasprice;
    }
}

// A creator-curated collection is untrusted by design. This contract is an attacker, not a stand-in for FWA.
contract ReentrantCurated is ERC721 {
    address public target;
    uint256 public attempts;
    uint256 public blocked;
    uint256 public succeeded;
    function name() public pure override returns (string memory) { return "Reentrant Curated"; }
    function symbol() public pure override returns (string memory) { return "RC"; }
    function tokenURI(uint256) public pure override returns (string memory) { return ""; }
    function mint(address to, uint256 id) external { _mint(to, id); }
    function arm(address balancer) external { target = balancer; }
    function _beforeTokenTransfer(address from, address, uint256) internal override {
        if (from == address(0) || target == address(0)) return;
        ++attempts;
        (bool ok,) = target.call(abi.encodeWithSignature("collectProceeds()"));
        if (ok) ++succeeded;
        else ++blocked;
    }
}

contract AuditFreshTest is ForkBase {
    function setUp() public { setUpFork(); }

    ReentrantCurated internal attackerCollection;

    function listAttackerCurated(uint256 id, uint256 base) internal returns (uint256 lid) {
        if (address(attackerCollection) == address(0)) attackerCollection = new ReentrantCurated();
        attackerCollection.mint(creator, id);
        PoolBalancer.CuratedInput[] memory input = new PoolBalancer.CuratedInput[](1);
        input[0] = PoolBalancer.CuratedInput(address(attackerCollection), id, base);
        vm.startPrank(creator);
        attackerCollection.approve(address(balancer), id);
        uint256[] memory lids = balancer.listCuratedBatch(input);
        vm.stopPrank();
        lid = lids[0];
    }

    function test_noCreatorRelistStopsSales() public {
        vm.fee(4.95 gwei);
        vm.txGasPrice(5 gwei);
        GasContextProbe probe = new GasContextProbe();
        probe.sample();
        assertEq(probe.seenBasefee(), 4.95 gwei);
        assertEq(probe.seenGasprice(), 5 gwei);
        createBalancer(5 ether);
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1);
        vm.prank(creator);
        balancer.configure(2500, plan16(c));
        uint256 curatedId = listAttackerCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256[] memory ids = buy(buyer, 1);
        assertEq(ids.length, 1);
        fulfill(ids[0], wordForSlot(1));
        vm.prank(keeper, keeper);
        balancer.performUpkeep();
        (,,, uint256 selected, uint8 status,) = pool.acquisitions(ids[0]);
        assertEq(status, 2, "real FWA draw fulfilled");
        assertEq(selected, curatedId, "the only creator NFT was won");
        assertEq(attackerCollection.ownerOf(1), buyer);
        assertEq(balancer.admissionStatus(), 3, "no curated NFT remains");
        (,, uint256 quote) = pool.quoteAcquisitionPrice(1);
        uint256 version = pool.inventoryVersion();
        vm.expectRevert();
        vm.prank(buyer, buyer);
        pool.acquireBatch{value: quote}(buyer, 1, 0, 0, 10_000, version, block.timestamp + 1);
        console2.log("one-draw price wei", quote);
        console2.log("admission status", balancer.admissionStatus());
    }

    function test_largestPrizeRoundTripAtCap() public {
        vm.fee(4.95 gwei);
        vm.txGasPrice(5 gwei);
        GasContextProbe probe = new GasContextProbe();
        probe.sample();
        assertEq(probe.seenBasefee(), 4.95 gwei);
        assertEq(probe.seenGasprice(), 5 gwei);
        createBalancer(201 ether);
        uint256[16] memory c;
        c[8] = 1; // largest permitted Shape denomination, 100 ETH
        vm.prank(creator);
        balancer.configure(2500, plan16(c));
        listAttackerCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertEq(balancer.getActiveShapes()[8], 1);
        uint256 beforeFund = address(balancer).balance;
        uint256 beforeBuyer = buyer.balance;
        uint256[] memory ids = buy(buyer, 1);
        uint256 drawCost = beforeBuyer - buyer.balance;
        fulfill(ids[0], wordForSlot(2));
        vm.prank(keeper, keeper);
        balancer.performUpkeep();
        (,,, uint256 selected, uint8 status,) = pool.acquisitions(ids[0]);
        console2.log("selected listing", selected);
        console2.log("acquisition status", status);
        console2.log("shape count", balancer.getActiveShapes()[8]);
        assertEq(status, 2);
        assertEq(selected, 2, "largest prize selected");
        (,,, uint256 wonToken,,,,) = pool.listings(selected);
        assertEq(shapes.ownerOf(wonToken), buyer, "winner holds the real 100 ETH Shape");
        assertEq(balancer.getActiveShapes()[8], 1, "upkeep restocked the 100 ETH prize");
        uint256 shortfall = balancer.requiredReserve() > address(balancer).balance
            ? balancer.requiredReserve() - address(balancer).balance : 0;
        console2.log("buyer draw cost", drawCost);
        console2.log("fund before draw", beforeFund);
        console2.log("fund after draw", address(balancer).balance);
        console2.log("reserve shortfall", shortfall);
        assertGt(shortfall, 0);
        uint256[] memory secondIds = buy(buyer, 1);
        fulfill(secondIds[0], wordForSlot(2));
        vm.prank(keeper, keeper);
        balancer.performUpkeep();
        (,,, uint256 secondSelected, uint8 secondStatus,) = pool.acquisitions(secondIds[0]);
        assertEq(secondStatus, 2, "second largest prize delivered");
        (,,, uint256 secondWonToken,,,,) = pool.listings(secondSelected);
        assertEq(shapes.ownerOf(secondWonToken), buyer);
        assertEq(balancer.getActiveShapes()[8], 0, "no ETH to restore the second win");
        console2.log("two-draw buyer cost", beforeBuyer - buyer.balance);
        console2.log("fund after second win", address(balancer).balance);
        console2.log("admission after second win", balancer.admissionStatus());
        vm.prank(creator);
        balancer.close();
        vm.prank(creator);
        balancer.withdrawCurated(1, creator);
        assertEq(attackerCollection.ownerOf(1), creator);
        uint256 take = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(take, creator);
        assertEq(address(balancer).balance, 0, "closeout returned liquid ETH");
        console2.log("creator closeout claim", take);
        vm.expectRevert();
        vm.prank(creator);
        balancer.open();
        vm.prank(creator);
        balancer.depositETH{value: 201 ether}();
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertEq(balancer.getActiveShapes()[8], 1, "reopening restored the design");
        console2.log("reopen reserve", balancer.requiredReserve());
    }

    function test_closedReserveSequentialExpiry() public {
        vm.fee(4.95 gwei);
        vm.txGasPrice(5 gwei);
        GasContextProbe probe = new GasContextProbe();
        probe.sample();
        assertEq(probe.seenBasefee(), 4.95 gwei);
        assertEq(probe.seenGasprice(), 5 gwei);

        createBalancer(5 ether);
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1);
        vm.prank(creator);
        balancer.configure(2500, plan16(c));
        listAttackerCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256 firstExpired = buyOnePerBlock(buyer, 5);
        assertEq(pool.unsettledAcquisitionCount(), 5);
        vm.prank(creator);
        balancer.close();
        uint256 held = balancer.requiredReserve();
        uint256 maxReward = balancer.MAX_KEEPER_REWARD();
        assertEq(held, 3 * maxReward, "closed reserve uses one reward per two draws");
        uint256 claim = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(claim, creator);
        assertEq(address(balancer).balance, held);

        uint256 paid;
        for (uint256 i; i < 5; ++i) {
            vm.roll(firstExpired + i);
            uint256 before = keeper.balance;
            vm.prank(keeper, keeper);
            balancer.performUpkeep();
            uint256 got = keeper.balance - before;
            paid += got;
            console2.log("keeper reward", i, got);
            assertEq(balancer.reconciledSequence(), i + 1);
        }
        console2.log("held", held);
        console2.log("paid", paid);
        console2.log("remaining", address(balancer).balance);
        assertEq(pool.unsettledAcquisitionCount(), 0);
    }

    function test_globalWithdrawOnlyRoundTrip() public {
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        GasContextProbe probe = new GasContextProbe();
        probe.sample();
        assertEq(probe.seenBasefee(), 0.5 gwei);
        assertEq(probe.seenGasprice(), 0.55 gwei);
        createBalancer(1 ether);
        uint256[9] memory c;
        c[0] = 10;
        configure(plan(c));
        listAttackerCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertEq(balancer.admissionStatus(), 0);
        IFWAOwnerSwitch admin = IFWAOwnerSwitch(FWA_FACTORY);
        vm.prank(admin.owner());
        admin.setGlobalWithdrawOnly(true);
        assertEq(balancer.admissionStatus(), 0, "Balancer does not surface FWA global halt");
        (,, uint256 quote) = pool.quoteAcquisitionPrice(1);
        uint256 version = pool.inventoryVersion();
        vm.expectRevert();
        vm.prank(buyer, buyer);
        pool.acquireBatch{value: quote}(buyer, 1, 0, 0, 10_000, version, block.timestamp + 1);
        vm.prank(admin.owner());
        admin.setGlobalWithdrawOnly(false);
        uint256[] memory ids = buy(buyer, 1);
        assertEq(ids.length, 1, "real factory switch restored purchases");
        console2.log("global halt reverted despite admission 0; recovery draw", ids[0]);
    }

    function test_retirementAndAttemptedReopen() public {
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        GasContextProbe probe = new GasContextProbe();
        probe.sample();
        assertEq(probe.seenBasefee(), 0.5 gwei);
        assertEq(probe.seenGasprice(), 0.55 gwei);
        createBalancer(1 ether);
        uint256[9] memory c;
        c[0] = 10;
        configure(plan(c));
        listAttackerCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        vm.prank(creator);
        balancer.close();
        vm.prank(creator);
        balancer.retire();
        assertTrue(pool.retired());
        vm.expectRevert();
        vm.prank(creator);
        balancer.open();
        assertFalse(balancer.enabled());
        vm.prank(creator);
        balancer.withdrawCurated(1, creator);
        uint256[] memory shapeIds = balancer.getActiveIds();
        uint256[] memory toUnlist = new uint256[](shapeIds.length);
        uint256 n;
        for (uint256 i; i < shapeIds.length; ++i) {
            (uint8 kind,,,,) = balancer.items(shapeIds[i]);
            if (kind == 2) toUnlist[n++] = shapeIds[i];
        }
        assembly ("memory-safe") { mstore(toUnlist, n) }
        vm.prank(creator);
        balancer.unlistShapes(toUnlist);
        uint256 claim = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(claim, creator);
        assertEq(address(balancer).balance, 0);
        console2.log("retired pool closeout claim", claim);
    }

    function test_compromisedCreatorCannotTakePendingPlayerRefund() public {
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        GasContextProbe probe = new GasContextProbe();
        probe.sample();
        assertEq(probe.seenBasefee(), 0.5 gwei);
        assertEq(probe.seenGasprice(), 0.55 gwei);
        createBalancer(5 ether);
        uint256[9] memory c;
        c[0] = 10;
        configure(plan(c));
        uint256 nftId = listAttackerCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256 firstExpired = buyOnePerBlock(buyer, 1);
        assertEq(pool.unsettledAcquisitionCount(), 1);
        address attacker = makeAddr("stolen creator key");
        vm.prank(creator);
        balancer.transferCreator(attacker);
        vm.prank(attacker);
        balancer.acceptCreator();
        vm.prank(attacker);
        balancer.close();
        uint256 firstClaim = balancer.withdrawableSurplus();
        vm.prank(attacker);
        balancer.claimSurplus(firstClaim, attacker);
        vm.expectRevert();
        vm.prank(attacker);
        balancer.withdrawCurated(nftId, attacker);
        vm.roll(firstExpired);
        vm.prank(attacker, attacker);
        balancer.performUpkeep();
        uint256 refund = IFWAPlayerRefund(address(pool)).acquisitionRefundCredit(buyer);
        assertGt(refund, 0);
        vm.expectRevert();
        vm.prank(attacker);
        IFWAPlayerRefund(address(pool)).withdrawAcquisitionRefund();
        uint256 buyerBefore = buyer.balance;
        vm.prank(buyer);
        IFWAPlayerRefund(address(pool)).withdrawAcquisitionRefund();
        assertEq(buyer.balance - buyerBefore, refund);
        vm.prank(attacker);
        balancer.withdrawCurated(nftId, attacker);
        assertEq(attackerCollection.ownerOf(1), attacker);
        console2.log("player's protected price refund", refund);
        console2.log("attacker closed and recovered curated NFT after expiry");
    }

    function test_restrictedEmptyKeeperListStallsAndCreatorRestarts() public {
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        GasContextProbe probe = new GasContextProbe();
        probe.sample();
        assertEq(probe.seenBasefee(), 0.5 gwei);
        assertEq(probe.seenGasprice(), 0.55 gwei);
        createBalancer(5 ether);
        uint256[9] memory c;
        c[0] = 10;
        configure(plan(c));
        listAttackerCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256 firstExpired = buyOnePerBlock(buyer, 1);
        vm.prank(keeperAdmin);
        factory.setKeepersRestricted(true);
        vm.roll(firstExpired + 7200);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(PoolBalancer.KeeperNotApproved.selector);
        vm.prank(keeper, keeper);
        balancer.performUpkeep();
        assertEq(pool.unsettledAcquisitionCount(), 1, "no approved keeper processed FWA queue");
        assertEq(balancer.reconciledSequence(), 0);
        vm.prank(creator, creator);
        balancer.performUpkeep();
        assertEq(pool.unsettledAcquisitionCount(), 0, "creator can restart");
        assertEq(balancer.reconciledSequence(), 1);
        console2.log("unsettled after one day without authorized keeper", uint256(1));
    }

    function test_repriceAndStageDuringDrawBooksOldSaleAsNewProfit() public {
        vm.fee(4.95 gwei);
        vm.txGasPrice(5 gwei);
        GasContextProbe probe = new GasContextProbe();
        probe.sample();
        assertEq(probe.seenBasefee(), 4.95 gwei);
        assertEq(probe.seenGasprice(), 5 gwei);
        createBalancer(300 ether);
        uint256[16] memory low;
        low[8] = 1; // 100 ETH Shape at the game's minimum 10% markup
        vm.prank(creator);
        balancer.configure(1000, plan16(low));
        listAttackerCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256 available = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(available, creator);
        assertEq(balancer.profit(), 0);
        uint256[] memory ids = buy(buyer, 1);
        assertEq(pool.unsettledAcquisitionCount(), 1);
        uint256[16] memory high;
        high[8] = 2;
        vm.prank(creator);
        balancer.configure(10000, plan16(high));
        vm.prank(keeper, keeper);
        balancer.performUpkeep();
        assertEq(balancer.getActiveShapes()[8], 2, "a 100 ETH replacement was staged");
        fulfill(ids[0], wordForSlot(1)); // old board selects the curated NFT
        uint256 proceeds = pool.ownerProceeds();
        assertGt(proceeds, 0, "old-board sale has proceeds");
        vm.prank(keeper, keeper);
        balancer.performUpkeep();
        uint256 booked = balancer.profit();
        console2.log("old-board owner proceeds", proceeds);
        console2.log("profit booked from new-board share", booked);
        assertGt(booked, 0, "old board had no above-10-percent Shape markup");
        uint256 beforeClaim = creator.balance;
        vm.prank(creator);
        balancer.claimSurplus(booked, creator);
        assertEq(creator.balance - beforeClaim, booked);
        console2.log("creator withdrew overbooked profit", booked);
    }

    function test_reentrantCuratedCallbacksDoNotDivertFunds() public {
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        GasContextProbe probe = new GasContextProbe();
        probe.sample();
        assertEq(probe.seenBasefee(), 0.5 gwei);
        assertEq(probe.seenGasprice(), 0.55 gwei);
        createBalancer(5 ether);
        uint256[9] memory c;
        c[0] = 10;
        configure(plan(c));
        ReentrantCurated hostile = new ReentrantCurated();
        hostile.mint(creator, 1);
        hostile.arm(address(balancer));
        PoolBalancer.CuratedInput[] memory input = new PoolBalancer.CuratedInput[](1);
        input[0] = PoolBalancer.CuratedInput(address(hostile), 1, 0.2 ether);
        vm.startPrank(creator);
        hostile.approve(address(balancer), 1);
        balancer.listCuratedBatch(input);
        vm.stopPrank();
        assertGe(hostile.blocked(), 2, "listing transfer callbacks hit the Balancer lock");
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256[] memory ids = buy(buyer, 1);
        uint256 fundsBefore = address(balancer).balance;
        fulfill(ids[0], wordForSlot(1));
        vm.prank(keeper, keeper);
        balancer.performUpkeep();
        assertEq(hostile.ownerOf(1), buyer, "real FWA delivered the hostile NFT");
        assertGe(hostile.attempts(), 3, "delivery invoked the collection callback");
        assertGt(address(balancer).balance, fundsBefore, "owner proceeds arrived at the Balancer");
        console2.log("collection callback attempts", hostile.attempts());
        console2.log("blocked during locked calls", hostile.blocked());
        console2.log("other callbacks completed", hostile.succeeded());
    }

    function test_keeperChosenGasLimitCannotEarnWithoutQueueProgress() public {
        vm.fee(4.95 gwei);
        vm.txGasPrice(5 gwei);
        GasContextProbe probe = new GasContextProbe();
        probe.sample();
        assertEq(probe.seenBasefee(), 4.95 gwei);
        assertEq(probe.seenGasprice(), 5 gwei);
        createBalancer(5 ether);
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1);
        vm.prank(creator);
        balancer.configure(2500, plan16(c));
        listAttackerCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256 firstExpired = buyOnePerBlock(buyer, 5);
        vm.roll(firstExpired + 4);
        assertEq(pool.nextSequenceToProcess(), 1);
        uint256[7] memory limits = [uint256(200_000), 300_000, 400_000, 600_000, 1_000_000, 2_000_000, 4_000_000];
        uint256 successes;
        uint256 failures;
        for (uint256 i; i < limits.length; ++i) {
            uint256 snap = vm.snapshotState();
            uint256 before = keeper.balance;
            vm.prank(keeper, keeper);
            try balancer.performUpkeep{gas: limits[i]}() returns (uint256 reward) {
                (bool ok, bytes memory data) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
                assertTrue(ok);
                (, uint64 billed,,,) = abi.decode(data, (uint64, uint64, uint64, int64, uint64));
                ++successes;
                assertGt(pool.nextSequenceToProcess(), 1, "paid call processed the queue");
                assertEq(keeper.balance - before, reward);
                console2.log("gas limit succeeded", limits[i]);
                console2.log("reward", reward);
                console2.log("billed gas plus intrinsic", uint256(billed) + 21_000);
                console2.log("keeper margin wei", int256(reward) - int256((uint256(billed) + 21_000) * 5 gwei));
            } catch {
                ++failures;
                assertEq(pool.nextSequenceToProcess(), 1, "failed call changed no queue state");
                assertEq(keeper.balance, before, "failed call paid nothing");
                console2.log("gas limit reverted", limits[i]);
            }
            vm.revertToStateAndDelete(snap);
        }
        assertGt(successes, 0);
        assertGt(failures, 0);
    }

    function test_emptyFundingThenTopUpAndRedeemRoundTrip() public {
        vm.fee(4.95 gwei);
        vm.txGasPrice(5 gwei);
        GasContextProbe probe = new GasContextProbe();
        probe.sample();
        assertEq(probe.seenBasefee(), 4.95 gwei);
        assertEq(probe.seenGasprice(), 5 gwei);
        createBalancer(1 ether);
        uint256[9] memory small;
        small[0] = 1;
        configure(plan(small));
        listAttackerCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256 surplus = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(surplus, creator);
        uint256[16] memory bigger;
        bigger[0] = 1;
        bigger[8] = 1;
        vm.prank(creator);
        balancer.configure(2500, plan16(bigger));
        assertTrue(balancer.creatorWork());
        assertEq(balancer.admissionStatus(), 2);
        uint256 keeperBefore = keeper.balance;
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        vm.prank(keeper, keeper);
        balancer.performUpkeep();
        assertEq(keeper.balance, keeperBefore, "empty fund pays no idle upkeep");
        uint256 topUp = balancer.requiredReserve() - address(balancer).balance;
        vm.prank(creator);
        balancer.depositETH{value: topUp}();
        fillUp();
        assertFalse(balancer.creatorWork());
        assertEq(balancer.getActiveShapes()[8], 1);
        assertEq(balancer.admissionStatus(), 0);
        uint256[] memory ids = balancer.getActiveIds();
        uint256 prizeId;
        for (uint256 i; i < ids.length; ++i) {
            (, uint8 d,,,) = balancer.items(ids[i]);
            if (d == 8) prizeId = ids[i];
        }
        assertTrue(prizeId != 0);
        uint256[] memory one = new uint256[](1);
        one[0] = prizeId;
        uint256 beforeRedeem = address(balancer).balance;
        vm.prank(creator);
        balancer.unlistShapes(one);
        assertEq(address(balancer).balance - beforeRedeem, 100 ether, "100 ETH backing returned exactly");
        vm.prank(creator);
        balancer.configure(2500, plan(small));
        uint256 recoverable = balancer.withdrawableSurplus();
        console2.log("top-up to continue wei", topUp);
        console2.log("backing redeemed wei", uint256(100 ether));
        console2.log("creator claimable after dropping top prize", recoverable);
        vm.prank(creator);
        balancer.close();
        vm.prank(creator);
        balancer.withdrawCurated(1, creator);
        ids = balancer.getActiveIds();
        one[0] = ids[0];
        vm.prank(creator);
        balancer.unlistShapes(one);
        uint256 finalClaim = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(finalClaim, creator);
        assertEq(address(balancer).balance, 0, "all remaining creator ETH returned after closeout");
    }

    function test_settingsAndCuratedBatchHardBounds() public {
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        GasContextProbe probe = new GasContextProbe();
        probe.sample();
        assertEq(probe.seenBasefee(), 0.5 gwei);
        assertEq(probe.seenGasprice(), 0.55 gwei);
        createBalancer(5 ether);
        uint256[9] memory c;
        c[0] = 1;
        uint256 one = plan(c);
        vm.prank(creator);
        balancer.configure(1000, one);
        vm.prank(creator);
        balancer.configure(10000, one);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        vm.prank(creator);
        balancer.configure(999, one);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        vm.prank(creator);
        balancer.configure(10001, one);
        vm.expectRevert(PoolBalancer.InvalidPlan.selector);
        vm.prank(creator);
        balancer.configure(1000, 0);
        c[0] = 80;
        vm.prank(creator);
        balancer.configure(1000, plan(c));
        c[0] = 81;
        vm.expectRevert(PoolBalancer.InvalidPlan.selector);
        vm.prank(creator);
        balancer.configure(1000, plan(c));

        ReentrantCurated externalCollection = new ReentrantCurated();
        PoolBalancer.CuratedInput[] memory twenty = new PoolBalancer.CuratedInput[](20);
        for (uint256 i; i < 20; ++i) {
            externalCollection.mint(creator, i + 1);
            twenty[i] = PoolBalancer.CuratedInput(address(externalCollection), i + 1, 0.2 ether);
        }
        vm.startPrank(creator);
        externalCollection.setApprovalForAll(address(balancer), true);
        uint256[] memory lids = balancer.listCuratedBatch(twenty);
        vm.stopPrank();
        assertEq(lids.length, 20);
        assertEq(pool.activeListingCount(), 20);
        PoolBalancer.CuratedInput[] memory twentyOne = new PoolBalancer.CuratedInput[](21);
        vm.expectRevert(PoolBalancer.InvalidBatch.selector);
        vm.prank(creator);
        balancer.listCuratedBatch(twentyOne);
        vm.expectRevert(PoolBalancer.ValueTooHigh.selector);
        vm.prank(creator);
        balancer.updateCuratedPrice(lids[0], type(uint104).max);
        console2.log("80-prize plan and 20-NFT batch reached hard bounds");
    }

    function test_launchBoardConfigChangeExceedsProfitDriftBound() public {
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        GasContextProbe probe = new GasContextProbe();
        probe.sample();
        assertEq(probe.seenBasefee(), 0.5 gwei);
        assertEq(probe.seenGasprice(), 0.55 gwei);
        createBalancer(5 ether);
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1);
        vm.prank(creator);
        balancer.configure(2500, plan16(c));
        listAttackerCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256 oldShare = balancer.profitShareSum();
        uint256 oldN = balancer.getActiveIds().length;
        uint256 surplus = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(surplus, creator);
        uint256[] memory ids = buy(buyer, 1);
        assertEq(pool.unsettledAcquisitionCount(), 1);
        c[0] = 57; // 80 prizes total, the hard bound
        vm.prank(creator);
        balancer.configure(10000, plan16(c));
        uint256 calls = fillUp();
        assertEq(calls, 7, "33 higher-markup Shapes staged while the draw waits");
        assertFalse(balancer.creatorWork());
        fulfill(ids[0], wordForSlot(1));
        uint256 proceeds = pool.ownerProceeds();
        assertGt(proceeds, 0);
        uint256 expected = proceeds * oldShare / (oldN * 1e18);
        vm.prank(keeper, keeper);
        balancer.performUpkeep();
        uint256 booked = balancer.profit();
        assertGt(booked, expected);
        uint256 overbooked = booked - expected;
        console2.log("old-board proceeds", proceeds);
        console2.log("old-board creator share", expected);
        console2.log("new-board profit booked", booked);
        console2.log("one-draw overbooking", overbooked);
        assertGt(overbooked, 0.001 ether, "O9's 180-draw bound exceeded by one draw");
        uint256 creatorBefore = creator.balance;
        vm.prank(creator);
        balancer.claimSurplus(booked, creator);
        assertEq(creator.balance - creatorBefore, booked, "creator can take the overstated share");
    }
}
