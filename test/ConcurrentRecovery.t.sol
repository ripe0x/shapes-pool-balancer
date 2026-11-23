// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {ForkBase, ITimeout} from "./utils/ForkBase.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {IKeeperPolicy} from "../src/interfaces/IKeeperPolicy.sol";
import {IERC721Min} from "../src/interfaces/External.sol";

interface IConcurrentFwaCash {
    function acquisitionEscrowTotal() external view returns (uint256);
    function deliveryEscrowTotal() external view returns (uint256);
    function acquisitionRefundCreditTotal() external view returns (uint256);
    function acquisitionRefundCredit(address) external view returns (uint256);
    function accruedProtocolFees() external view returns (uint256);
    function withdrawAcquisitionRefund() external returns (uint256);
}

/// @dev Deliberately mutable, untrusted creator-selected economics, accepted by the real pool interface.
contract HostileRecoveryPolicy is IKeeperPolicy {
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

/// @notice Minimum-capital concurrent purchaser refund rights survive a hostile policy, gas growth and full creator exit.
///         Uses real FWA cash and inventory paths; inherited controlled coordinator delivery does not prove VRF timing.
contract ConcurrentRecoveryTest is ForkBase {
    GasProbe internal probe;
    HostileRecoveryPolicy internal policy;
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
        assertEq(IConcurrentFwaCash(address(pool)).acquisitionEscrowTotal(), 2 * fee);
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
        assertEq(IConcurrentFwaCash(address(pool)).acquisitionRefundCredit(buyer), fee);
        assertEq(IConcurrentFwaCash(address(pool)).acquisitionRefundCredit(stranger), fee);
        _ledger("hostile maximum payment");
        assertTrue(vm.revertToState(before));
        policy.setBroken(true);
        bytes32 expected = balancer.settingsHash();
        vm.prank(keeper, keeper);
        vm.expectRevert(PoolBalancer.PolicyUnavailable.selector);
        balancer.performUpkeep(expected, 0, 0);
        assertEq(pool.unsettledAcquisitionCount(), 2, "failed paid operation reverted all FWA processing atomically");
        assertEq(IConcurrentFwaCash(address(pool)).acquisitionEscrowTotal(), 2 * fee);
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
        balancer.performUpkeep(expected, 0, 0);
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
        assertEq(IConcurrentFwaCash(address(pool)).acquisitionRefundCredit(buyer), fee);
        assertEq(IConcurrentFwaCash(address(pool)).acquisitionRefundCredit(stranger), fee);
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
        keeperStart = keeper.balance;
        createBalancer(0);
        vm.startPrank(creator);
        balancer.configure(uint16(markup), plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]), shapes.mintFee());
        vm.stopPrank();
        listCurated(1, 0.2 ether);
        if (custom) {
            policy = new HostileRecoveryPolicy();
            policy.setFee(fee);
            vm.prank(creator);
            balancer.setKeeperPolicy(address(policy));
        }
        uint256 refPrice = block.basefee + 0.1 gwei;
        if (refPrice > 50 gwei) refPrice = 50 gwei;
        uint256 cap = balancer.policyMaxReward();
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
            try balancer.performUpkeep(expected, 0, 0) {
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
        uint256 before = balancer.creatorCredit();
        uint256 amount = pool.ownerProceeds();
        uint256 fwaBefore = address(pool).balance;
        uint256 balBefore = address(balancer).balance;
        uint256 got = balancer.collectProceeds();
        collected += got;
        assertEq(got, amount);
        assertEq(address(pool).balance + got, fwaBefore);
        assertEq(address(balancer).balance, balBefore + got);
        maker = balancer.creatorCredit() - before;
        assertEq(maker, got * balancer.creatorRevenueBps() / 10_000, "actual collected cash uses the stored percentage");
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

    function _withdrawRefund(address who) internal {
        IConcurrentFwaCash p = IConcurrentFwaCash(address(pool));
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
        IConcurrentFwaCash p = IConcurrentFwaCash(address(pool));
        assertEq(address(pool).balance, pool.ownerProceeds() + p.accruedProtocolFees() + p.acquisitionEscrowTotal()
            + p.deliveryEscrowTotal() + p.acquisitionRefundCreditTotal(), "every real FWA wei remains a named obligation");
    }

    function _ledger(string memory label) internal {
        assertEq(deposited + collected + redeemed, address(balancer).balance + claimed + minted + paid,
            "actual Balancer cash: deposits/proceeds/redemptions = operating cash/credit/claims/minting/keeper transfers");
        assertEq(keeper.balance - keeperStart, paid, "keeper really received only the tracked Balancer transfers");
        assertLe(balancer.creatorCredit(), address(balancer).balance);
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
        emit log_named_decimal_uint("creator credit included in liquid", balancer.creatorCredit(), 18);
        emit log_named_decimal_uint("creator-owned operating cash", address(balancer).balance - balancer.creatorCredit(), 18);
        emit log_named_decimal_uint("current reserve target", balancer.requiredReserve(), 18);
        emit log_named_decimal_uint("FWA separate ETH obligations", address(pool).balance, 18);
        emit log_named_decimal_uint("actual remaining Shape backing", backing, 18);
        emit log_named_decimal_uint("actual creator claims", claimed, 18);
        emit log_named_decimal_uint("actual keeper transfers", paid, 18);
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
        assertEq(balancer.creatorCredit(), 0);
        assertEq(pool.ownerProceeds(), 0);
        _ledger("complete creator closeout; FWA purchaser/protocol rights remain separate");
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) { return a < b ? a : b; }
}
