// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {ForkBase, ITimeout} from "./utils/ForkBase.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {IKeeperPolicy} from "../src/interfaces/IKeeperPolicy.sol";
import {IERC721Min} from "../src/interfaces/External.sol";

interface IAllocationFwaCash {
    function acquisitionEscrowTotal() external view returns (uint256);
    function deliveryEscrowTotal() external view returns (uint256);
    function acquisitionRefundCreditTotal() external view returns (uint256);
    function acquisitionRefundCredit(address) external view returns (uint256);
    function accruedProtocolFees() external view returns (uint256);
    function withdrawAcquisitionRefund() external returns (uint256);
}

/// @dev Deliberately mutable, untrusted creator-selected economics, accepted by the real pool interface.
contract AllocationQuotePolicy is IKeeperPolicy {
    uint256 public fee;
    bool public maximum;
    bool public broken;
    function setFee(uint256 value) external { fee = value; }
    function setMaximum(bool value) external { maximum = value; }
    function setBroken(bool value) external { broken = value; }
    function interfaceVersion() external pure returns (uint256) { return 1; }
    function version() external pure returns (uint256) { return 91; }
    function maxReward() external pure returns (uint256) { return 0.311 ether; }
    function quoteReward(Work calldata) external view returns (uint256) {
        require(!broken, "unavailable policy");
        return maximum ? type(uint256).max : 0.0001 ether;
    }
    function quoteRestock(uint8, uint256 units, uint256) external view returns (uint256) {
        require(!broken, "unavailable policy");
        return units * fee;
    }
}

/// @notice Quantifies retained approximate allocation without serializing FWA purchases or inventing capital.
///         Values are real-fork principal transfers; Foundry actor transaction gas is not in this cash ledger.
contract AllocationConcurrencyTest is ForkBase {
    GasProbe internal probe;
    AllocationQuotePolicy internal policy;
    uint256 internal allocationMarkup;
    uint256 internal deposited;
    uint256 internal collected;
    uint256 internal claimed;
    uint256 internal minted;
    uint256 internal redeemed;
    uint256 internal paid;
    uint256 internal keeperStart;
    bytes32 internal constant COLLECTED = keccak256("ProceedsCollected(uint256)");
    bytes32 internal constant MINTED = keccak256("ShapesMinted(uint8,uint256,uint256,uint256)");

    function setUp() public {
        setUpFork();
        probe = new GasProbe();
        assertEq(FWA_IMPL.codehash, FWA_CODEHASH, "reviewed deployed implementation");
        assertEq(shapes.mintFee(), 0.001 ether);
    }

    function test_V1ValidGasDropReportsDriftAndPreservesPurchaserAssets() public {
        _context(4.95 gwei, 5 gwei);
        _openMinimum(10_000, false, 0);
        assertEq(deposited, 0.30225 ether, "exact V1 opening bound at this fee, not a five-ETH subsidy");
        address originalPolicy = balancer.keeperPolicy();
        bytes32 originalSettings = balancer.settingsHash();
        uint256[] memory first = buy(buyer, 5);
        for (uint256 i; i < first.length; ++i) fulfill(first[i], _shapeWord());
        settle();
        _assertFulfilled(first, 5);
        (uint256 requestBase, uint256 expectedPerDraw) = _requestBoard();
        uint256[] memory old = buy(buyer, 5);
        assertEq(pool.unsettledAcquisitionCount(), 5, "new purchases remain possible before older wins reconcile");
        assertEq(balancer.reconciledSequence(), 0, "sale was not serialized behind keeper maintenance");
        uint256 base = 4.95 gwei;
        for (uint256 i; i < 17; ++i) {
            uint256 prior = base;
            base -= base / 8;
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + 12);
            _context(base, base + 0.05 gwei);
            assertGe(base, prior - prior / 8, "EIP-1559 down-step");
        }
        assertGe(0.5 gwei, base - base / 8);
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 12);
        _context(0.5 gwei, 0.55 gwei);
        assertEq(balancer.keeperPolicy(), originalPolicy);
        assertEq(balancer.settingsHash(), originalSettings);
        _upkeep();
        assertEq(balancer.getActiveShapes()[0], 20, "five lower-fee restocks coexist with old requests");
        _claimAll();
        for (uint256 i; i < old.length; ++i) fulfill(old[i], i + 100);
        settle();
        uint256 completed = _assertOutcomes(old);
        assertEq(completed, 4, "four old-price deliveries and a real deadline expiry");
        uint256 amount = pool.ownerProceeds();
        assertEq(amount, requestBase * completed);
        uint256 booked = _collectMeasured();
        _reportDrift("V1 gas drop", amount, expectedPerDraw * completed, booked);
        assertGt(booked - expectedPerDraw * completed, 0.001 ether,
            "old O9 seed threshold remains violated; this test does not quietly raise it");
        _claimAll();
        _fillUntilIdle();
        _ledger("V1 after maximum creator claim");
        _withdrawRefund(buyer);
        _closeout();
    }

    function test_mutableLoweredFeeAt25PercentReportsDriftAndClaimRoundTrip() public {
        _mutableDrift(2_500, 0.102 ether, 0.0002 ether, true);
    }

    function test_mutableLoweredFeeAt100PercentReportsDriftAndClaimRoundTrip() public {
        _mutableDrift(10_000, 0.102 ether, 0.0002 ether, true);
    }

    function test_mutableRaisedFeeReportsUnderbookingWithoutZeroingMakerProfit() public {
        _mutableDrift(10_000, 0.0002 ether, 0.102 ether, false);
    }

    function _mutableDrift(uint256 markup, uint256 oldFee, uint256 newFee, bool over) internal {
        _context(0.5 gwei, 0.55 gwei);
        _openMinimum(markup, true, oldFee);
        assertEq(deposited, 0.2356 ether, "same minimum despite high uncollected listing fees");
        uint256 first = buy(buyer, 1)[0];
        fulfill(first, _shapeWord());
        settle();
        (uint256 requestBase, uint256 expectedPerDraw) = _requestBoard();
        uint256[] memory old = buy(buyer, 5);
        assertEq(pool.unsettledAcquisitionCount(), 5);
        assertEq(balancer.reconciledSequence(), 0, "older win did not block another buyer transaction");
        bytes32 originalSettings = balancer.settingsHash();
        policy.setFee(newFee);
        assertEq(balancer.settingsHash(), originalSettings);
        _upkeep();
        assertEq(balancer.getActiveShapes()[0], 20, "replacement really listed while old requests pending");
        (uint8 kind,,, uint112 base, uint112 price) = balancer.items(lastListingId());
        assertEq(kind, 2);
        assertEq(price - base, newFee);
        _claimAll();
        for (uint256 i; i < old.length; ++i) fulfill(old[i], i);
        settle();
        uint256 completed = _assertOutcomes(old);
        assertEq(completed, 5);
        uint256 amount = pool.ownerProceeds();
        assertEq(amount, requestBase * completed, "actual request-time FWA proceeds");
        uint256 booked = _collectMeasured();
        uint256 expected = expectedPerDraw * completed;
        _reportDrift(over ? "mutable lower fee" : "mutable raised fee", amount, expected, booked);
        assertGt(booked, 0, "the approximation keeps a real maker entitlement");
        if (over) assertGt(booked - expected, 0.001 ether, "reported overbooking remains visible");
        else assertGt(expected - booked, 0.001 ether, "underbooking is also measured");
        _claimAll();
        _fillUntilIdle();
        _ledger("mutable policy after maximum creator claim");
        _withdrawRefund(buyer);
        _closeout();
    }

    function test_minimumCapitalConcurrentBuyersHostilePolicyAndUnpaidCloseout() public {
        _context(0.5 gwei, 0.55 gwei);
        _openMinimum(2_500, true, 0.000695 ether);
        _claimAll();
        assertEq(address(balancer).balance, 0.00368 ether, "claim leaves only ordinary working capital");
        (uint256 fee, uint256 vrf,) = pool.quoteAcquisitionPrice(1);
        assertEq(vrf, 0.001287 ether, "actual nonrefundable service charge at the witnessed bid");
        uint256 first = buy(buyer, 1)[0];
        uint256 second = buy(stranger, 1)[0];
        assertEq(pool.unsettledAcquisitionCount(), 2, "independent buyers hold concurrent requests");
        assertEq(IAllocationFwaCash(address(pool)).acquisitionEscrowTotal(), 2 * fee);
        _assertFwaCash();
        vm.roll(vm.getBlockNumber() + ITimeout(address(pool)).selectionTimeoutBlocks() + 1);
        uint256 before = vm.snapshotState();
        uint256 poolCash = address(pool).balance;
        uint256 creatorFund = address(balancer).balance;
        policy.setMaximum(true);
        _upkeep();
        uint256 reward = creatorFund - address(balancer).balance;
        assertGt(reward, 0);
        assertLe(reward, 0.0028 ether, "immutable actual-work envelope, not hostile declared maximum");
        assertEq(address(pool).balance, poolCash, "maximum keeper reward used no FWA escrow");
        assertEq(IAllocationFwaCash(address(pool)).acquisitionRefundCredit(buyer), fee);
        assertEq(IAllocationFwaCash(address(pool)).acquisitionRefundCredit(stranger), fee);
        _ledger("hostile maximum payment");
        assertTrue(vm.revertToState(before));
        policy.setBroken(true);
        bytes32 expected = balancer.settingsHash();
        vm.prank(keeper, keeper);
        vm.expectRevert(PoolBalancer.PolicyUnavailable.selector);
        balancer.performUpkeep(expected);
        assertEq(pool.unsettledAcquisitionCount(), 2, "failed paid operation reverted all FWA processing atomically");
        assertEq(IAllocationFwaCash(address(pool)).acquisitionEscrowTotal(), 2 * fee);
        policy.setBroken(false);
        policy.setMaximum(true);
        vm.prank(creator);
        balancer.close();
        _claimAll();
        assertEq(address(balancer).balance, 0.0028 ether, "only actual pending work's current-fee hold remains");
        uint256 base = 0.5 gwei;
        for (uint256 i; i < 31; ++i) {
            uint256 prior = base;
            base += base / 8;
            assertLe(base, prior + prior / 8);
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + 12);
            _context(base, base + 0.1 gwei);
        }
        assertGt(balancer.requiredReserve(), address(balancer).balance,
            "later high-fee paid continuity can be short without purchaser insolvency");
        expected = balancer.settingsHash();
        vm.prank(keeper, keeper);
        vm.expectRevert(PoolBalancer.PaymentUnavailable.selector);
        balancer.performUpkeep(expected);
        assertEq(pool.unsettledAcquisitionCount(), 2);
        assertEq(address(pool).balance, poolCash);
        uint256 priorPaid = paid;
        balancer.performUpkeepUnpaid();
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(paid, priorPaid, "public unpaid recovery takes no keeper reward");
        (,,,, uint8 firstStatus,) = pool.acquisitions(first);
        (,,,, uint8 secondStatus,) = pool.acquisitions(second);
        assertEq(firstStatus, 3);
        assertEq(secondStatus, 3);
        assertEq(IAllocationFwaCash(address(pool)).acquisitionRefundCredit(buyer), fee);
        assertEq(IAllocationFwaCash(address(pool)).acquisitionRefundCredit(stranger), fee);
        _ledger("unpaid recovery of both purchaser claims");
        _closeout();
        assertEq(address(pool).balance, 2 * fee, "complete creator exit leaves every refund wei at real FWA");
        _withdrawRefund(buyer);
        _withdrawRefund(stranger);
        assertEq(address(pool).balance, 0);
        emit log_named_decimal_uint("purchaser principal shortfall", 0, 18);
        emit log_named_decimal_uint("nonrefundable VRF cost for the two expired draws", 2 * vrf, 18);
    }

    function _openMinimum(uint256 markup, bool custom, uint256 fee) internal {
        allocationMarkup = markup;
        keeperStart = keeper.balance;
        createBalancer(0);
        vm.prank(creator);
        balancer.configure(uint16(markup), plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        listCurated(1, 0.2 ether);
        if (custom) {
            policy = new AllocationQuotePolicy();
            policy.setFee(fee);
            vm.prank(creator);
            balancer.proposeKeeperPolicy(address(policy));
            vm.warp(vm.getBlockTimestamp() + 2 days);
            balancer.activateKeeperPolicy();
        }
        uint256 refPrice = block.basefee + 0.1 gwei;
        if (refPrice > 50 gwei) refPrice = 50 gwei;
        uint256 cap = balancer.maxKeeperReward();
        uint256 listing = _min(cap, 4_550_000 * refPrice + 0.00025 ether);
        uint256 buffer = _min(cap, 5_300_000 * refPrice + 0.0005 ether);
        deposited = 0.22 ether + 4 * listing + buffer;
        vm.prank(creator);
        balancer.depositETH{value: deposited}();
        // Test the exact boundary by withdrawing one wei on a private snapshot, not by faking a protocol balance.
        uint256 before = vm.snapshotState();
        vm.prank(creator);
        balancer.claimSurplus(1, creator);
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.ReserveNotFunded.selector);
        balancer.open();
        assertTrue(vm.revertToState(before));
        vm.prank(creator);
        balancer.open();
        assertEq(balancer.requiredReserve(), deposited);
        _fillUntilIdle();
        assertEq(balancer.getActiveShapes()[0], 20);
        assertEq(minted, 0.22 ether, "actual inventory backing plus one-way mint fees");
        _ledger("exact minimum opening");
    }

    function _context(uint256 base, uint256 bid) internal {
        vm.fee(base);
        vm.txGasPrice(bid);
        probe.record();
        assertEq(probe.baseFee(), base, "basefee inside actual state-changing call");
        assertEq(probe.gasPrice(), bid, "bid inside actual state-changing call");
    }

    function _upkeep() internal {
        uint256 before = keeper.balance;
        vm.recordLogs();
        upkeep();
        paid += keeper.balance - before;
        _captureFlows();
    }

    function _fillUntilIdle() internal {
        for (uint256 i; i < 20; ++i) {
            uint256 before = keeper.balance;
            bytes32 expected = balancer.settingsHash();
            vm.recordLogs();
            vm.prank(keeper, keeper);
            try balancer.performUpkeep(expected) {
                paid += keeper.balance - before;
                _captureFlows();
            } catch (bytes memory reason) {
                if (reason.length >= 4 && bytes4(reason) == PoolBalancer.NoUpkeepNeeded.selector) return;
                assembly ("memory-safe") { revert(add(reason, 0x20), mload(reason)) }
            }
        }
        revert("bounded maintenance did not become idle");
    }

    function _captureFlows() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(balancer) || logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] == COLLECTED) collected += abi.decode(logs[i].data, (uint256));
            else if (logs[i].topics[0] == MINTED) {
                (,, uint256 cost) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                minted += cost;
            }
        }
    }

    function _collectMeasured() internal returns (uint256 maker) {
        uint256 before = balancer.profit();
        uint256 amount = pool.ownerProceeds();
        uint256 fwaBefore = address(pool).balance;
        uint256 balBefore = address(balancer).balance;
        uint256 got = balancer.collectProceeds();
        collected += got;
        assertEq(got, amount);
        assertEq(address(pool).balance + got, fwaBefore);
        assertEq(address(balancer).balance, balBefore + got);
        maker = balancer.profit() - before;
        assertLe(maker, got * 45 / 100, "creator allocation is universally bounded by45%of actual owner proceeds");
        _assertFwaCash();
    }

    function _claimAll() internal {
        if (pool.ownerProceeds() != 0) _collectMeasured();
        uint256 amount = balancer.withdrawableSurplus();
        uint256 before = creator.balance;
        uint256 fwaBefore = address(pool).balance;
        vm.prank(creator);
        balancer.claimSurplus(amount, creator);
        claimed += amount;
        assertEq(creator.balance - before, amount, "claim actually reaches creator");
        assertEq(address(pool).balance, fwaBefore, "claim has no authority over real FWA obligations");
        _assertFwaCash();
    }

    function _requestBoard() internal view returns (uint256 base, uint256 maker) {
        uint256 w;
        uint256 wp;
        uint256 n;
        uint256 share;
        uint256 end = lastListingId();
        for (uint256 lid = 1; lid <= end; ++lid) {
            (,,,, uint256 weight, uint256 price,, uint8 status) = pool.listings(lid);
            if (status != 1) continue;
            w += weight;
            wp += weight * price;
            ++n;
            (uint8 kind, uint8 d,,,) = balancer.items(lid);
            if (kind == 2) share += balancer.denominationAmount(d) * (allocationMarkup - 1_000) * 1e18 / (10_000 * price);
        }
        base = wp / w;
        maker = base * share / (n * 1e18);
    }

    function _shapeWord() internal view returns (uint256) {
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = balancer.items(ids[i]);
            (,,,,,, uint256 slot, uint8 status) = pool.listings(ids[i]);
            if (kind == 2 && status == 1) return wordForSlot(slot);
        }
        revert("no active Shape");
    }

    function _assertFulfilled(uint256[] memory requests, uint256 expected) internal view {
        assertEq(_assertOutcomes(requests), expected);
    }

    function _assertOutcomes(uint256[] memory requests) internal view returns (uint256 complete) {
        for (uint256 i; i < requests.length; ++i) {
            (address who,,, uint256 lid, uint8 status,) = pool.acquisitions(requests[i]);
            if (status == 2) {
                (address collection,,, uint256 id,,,, uint8 listingStatus) = pool.listings(lid);
                assertEq(listingStatus, 4);
                assertEq(IERC721Min(collection).ownerOf(id), who, "real purchaser owns the actual delivered prize");
                ++complete;
            } else assertTrue(status == 3 || status == 4, "only actual refund/expiry, never an unfinished delivery");
        }
        _assertFwaCash();
    }

    function _withdrawRefund(address who) internal {
        IAllocationFwaCash p = IAllocationFwaCash(address(pool));
        uint256 amount = p.acquisitionRefundCredit(who);
        if (amount == 0) return;
        uint256 before = who.balance;
        vm.prank(who, who);
        assertEq(p.withdrawAcquisitionRefund(), amount);
        assertEq(who.balance - before, amount, "actual full principal refund round trip");
        assertEq(p.acquisitionRefundCredit(who), 0);
        _assertFwaCash();
    }

    function _assertFwaCash() internal view {
        IAllocationFwaCash p = IAllocationFwaCash(address(pool));
        assertEq(address(pool).balance, pool.ownerProceeds() + p.accruedProtocolFees() + p.acquisitionEscrowTotal()
            + p.deliveryEscrowTotal() + p.acquisitionRefundCreditTotal(), "every real FWA wei remains a named obligation");
    }

    function _ledger(string memory label) internal {
        assertEq(deposited + collected + redeemed, address(balancer).balance + claimed + minted + paid,
            "actual Balancer cash: deposits/proceeds/redemptions = fund/profit/claims/minting/keeper transfers");
        assertEq(keeper.balance - keeperStart, paid, "keeper really received only the tracked Balancer transfers");
        assertLe(balancer.profit(), address(balancer).balance);
        _assertFwaCash();
        uint256 backing;
        uint256 end = lastListingId();
        for (uint256 lid = 1; lid <= end; ++lid) {
            (address collection,,, uint256 tokenId,,,, uint8 status) = pool.listings(lid);
            if (collection != SHAPES || (status != 1 && status != 5)) continue;
            assertEq(shapes.ownerOf(tokenId), address(pool), "listed prize retains FWA custody");
            assertEq(shapes.backingOf(tokenId), 0.01 ether, "each listed small Shape retains actual backing");
            backing += 0.01 ether;
        }
        emit log_string(label);
        emit log_named_decimal_uint("deposited", deposited, 18);
        emit log_named_decimal_uint("Balancer liquid ETH", address(balancer).balance, 18);
        emit log_named_decimal_uint("booked creator profit included in liquid", balancer.profit(), 18);
        emit log_named_decimal_uint("creator-owned operating cash", address(balancer).balance - balancer.profit(), 18);
        emit log_named_decimal_uint("current reserve target", balancer.requiredReserve(), 18);
        emit log_named_decimal_uint("FWA separate ETH obligations", address(pool).balance, 18);
        emit log_named_decimal_uint("actual remaining Shape backing", backing, 18);
        emit log_named_decimal_uint("actual creator claims", claimed, 18);
        emit log_named_decimal_uint("actual keeper transfers", paid, 18);
    }

    function _reportDrift(string memory label, uint256 amount, uint256 expected, uint256 booked) internal {
        uint256 drift = booked > expected ? booked - expected : expected - booked;
        assertLe(expected, amount * 45 / 100);
        assertLe(booked, amount * 45 / 100);
        assertLe(drift, amount * 45 / 100, "universal absolute bound is45%of owner proceeds, not0.001ETH");
        emit log_string(label);
        emit log_named_decimal_uint("actual owner proceeds", amount, 18);
        emit log_named_decimal_uint("request-board maker entitlement", expected, 18);
        emit log_named_decimal_uint("current-board maker credit", booked, 18);
        emit log_named_decimal_uint("overbooking", booked > expected ? booked - expected : 0, 18);
        emit log_named_decimal_uint("underbooking", expected > booked ? expected - booked : 0, 18);
        emit log_named_decimal_uint("observed-share floor credit on this collection", _min(expected, booked), 18);
        emit log_named_decimal_uint("maker income lost if ambiguous credit were zeroed", booked, 18);
    }

    function _closeout() internal {
        if (pool.lastIssuedSequence() != balancer.reconciledSequence()) _fillUntilIdle();
        vm.prank(creator);
        balancer.close();
        uint256[] memory all = balancer.getActiveIds();
        uint256[] memory shapeIds = new uint256[](all.length);
        uint256 n;
        for (uint256 i; i < all.length; ++i) {
            (uint8 kind,,,,) = balancer.items(all[i]);
            if (kind == 2) shapeIds[n++] = all[i];
            else { vm.prank(creator); balancer.withdrawCurated(all[i], creator); }
        }
        assembly ("memory-safe") { mstore(shapeIds, n) }
        uint256 before = address(balancer).balance;
        if (n != 0) {
            vm.prank(creator);
            balancer.unlistShapes(shapeIds);
        }
        assertEq(address(balancer).balance - before, n * 0.01 ether, "exact real backing redemption");
        redeemed += n * 0.01 ether;
        vm.prank(creator);
        balancer.retire();
        _claimAll();
        assertEq(address(balancer).balance, 0);
        assertEq(balancer.getActiveIds().length, 0);
        assertEq(balancer.profit(), 0);
        assertEq(pool.ownerProceeds(), 0);
        _ledger("complete creator closeout; FWA purchaser/protocol rights remain separate");
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) { return a < b ? a : b; }
}
