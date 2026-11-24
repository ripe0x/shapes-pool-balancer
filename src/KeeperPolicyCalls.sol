// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IFWAPool} from "./interfaces/External.sol";

/// @dev Keeper money path over one effective `Economics`, resolved once per operation by PoolBalancer and passed to
///      every payment, payment bound, reserve and restocking price here. There is no external pricing policy: the V1
///      formula below is the payment algorithm (owner decision R95), and changing it needs a new release.
library KeeperPolicyCalls {
    /// @dev Paid service units one call can complete: MAX_RECONCILE (5) draws plus MAX_OPS (5) Shape units. A call that
    ///      processes (at most two) draws lists nothing, so it stays below this.
    uint256 internal constant MAX_SERVICE_UNITS = 10;
    uint256 internal constant BY_VALUE = 0x87f65ed43cb21a90;
    /// @dev `State.source`: follow the factory's current economics, or use the pool's own copy. "Pinning" is an app
    ///      action that saves the factory's current values as local economics.
    uint8 internal constant FOLLOW = 0;
    uint8 internal constant LOCAL = 1;
    error InvalidGrace();

    struct Work {
        uint256 measuredGas;
        uint256 gasPrice;
        uint256 baseFee;
        uint256 reconciledDraws;
        uint256 listedShapeUnits;
        uint256 listedPrizes;
        uint256 processedDraws;
    }

    /// @notice One keeper economic configuration: the factory default, or a pool's local copy.
    /// @dev Field widths are the only numeric bounds: they keep every payment, reserve and listing-price product far
    ///      below uint256 and every restocking surcharge below 2^98, inside a listing's uint104 price record.
    ///      Derived, never stored: the maximum keeper payment `(maxGas + overheadGas) * gasPriceCeiling + 10 * workFee`
    ///      (10 = five reconciles plus five Shape units per call; a call that processes draws lists nothing, so its at
    ///      most two processed draws plus five reconciles stay within 10) and the maximum restocking surcharge per Shape
    ///      `restockGas * gasPriceCeiling + restockFlat`.
    struct Economics {
        uint64 workFee; // per processed draw, per reconciled draw sequence and per listed Shape unit
        uint32 maxGas; // reimbursable measured gas per call
        uint32 overheadGas; // transaction gas outside the measured span: intrinsic, payment, transfer
        uint64 gasPriceCeiling;
        uint64 priorityAllowance; // reimbursed price = min(basefee + allowance, ceiling, transaction gas price)
        uint32 restockGas; // restocking surcharge gas per Shape
        uint64 restockFlat; // restocking surcharge flat amount per Shape
        // Gas bounds per verified operation: measured gas is paid only up to their sum (and maxGas).
        uint32 baseGas;
        uint32 processGas;
        uint32 reconcileGas;
        uint32 shapeGas;
        uint32 prizeGas;
        // Upkeep processes FWA's queue only for stuck draws (Ready, or expired without randomness) requested at least
        // this many blocks ago (FWA stores no fulfillment time; randomness arrives about three blocks after the
        // request), and the shorter value while purchases are paused BUSY or LOW_INVENTORY. paused <= normal.
        uint16 processGraceBlocks;
        uint16 pausedProcessGraceBlocks;
    }

    struct State {
        uint8 source;
        bool enabled;
        /// @dev Advances on every economics, source or paid-upkeep change, so a disable/re-enable cycle changes `settingsHash`.
        uint64 generation;
        uint64 allowanceTime;
        uint96 refill; // wei per second
        uint128 allowance;
        uint128 capacity;
        Economics local; // used while `source == LOCAL`
    }
    struct Reserve {
        bool enabled;
        uint256 owed;
        uint256 target;
        uint16[16] have;
        uint256 mintFee;
        uint256 baseFee;
    }
    event EconomicsSelected(uint8 indexed source, Economics economics);
    event PaidUpkeepChanged(bool enabled);
    event KeeperBucketChanged(uint256 capacity, uint256 refillPerSecond);
    event KeeperPaid(address indexed keeper, uint256 amount, uint256 gasUsed);
    error PaymentUnavailable();
    error ReserveNotFunded();

    /// @dev A new pool follows the factory with paid upkeep on and a full bucket. Later factory changes never touch it.
    function initialize(State storage s, uint128 capacity, uint96 refill) public {
        s.enabled = true;
        s.capacity = capacity;
        s.refill = refill;
        s.allowance = capacity;
        s.allowanceTime = uint64(block.timestamp);
        emit KeeperBucketChanged(capacity, refill);
    }

    /// @dev Creator change of source or local economics. Only a larger maintenance exposure than the current one must be
    ///      funded from operating capital; missing prize capital never enters this check, and while paid upkeep is off
    ///      there is no exposure. Paid-upkeep state and the bucket are untouched.
    function select(State storage s, uint8 source, Economics memory next,
        Economics memory current, uint256 fund, Reserve memory r) public
    {
        if (source == LOCAL) validate(next);
        if (s.enabled) _requireFunded(next, current, fund, r);
        s.source = source;
        if (source == LOCAL) s.local = next;
        ++s.generation;
        emit EconomicsSelected(source, next);
    }
    /// @dev Immediate emergency stop or re-enable. Re-enabling compares the effective maintenance budget against zero
    ///      paid exposure. The spending allowance is untouched either way, so no change refills it.
    function setEnabled(State storage s, bool value, Economics memory e, uint256 fund, Reserve memory r)
        public
    {
        Economics memory none;
        if (value && !s.enabled) _requireFunded(e, none, fund, r);
        s.enabled = value;
        ++s.generation;
        emit PaidUpkeepChanged(value);
    }
    function _requireFunded(Economics memory next, Economics memory current, uint256 fund,
        Reserve memory r) private pure
    {
        uint256 candidate = maintenanceBudget(next, r);
        if (candidate > maintenanceBudget(current, r) && fund < candidate) revert ReserveNotFunded();
    }

    /// @dev Accrues elapsed time at the old rate first, keeps what was spent, clamps to a lower capacity, and never
    ///      fills new headroom: the new rate applies only from now.
    function setBucket(State storage s, uint128 capacity, uint96 refill) public {
        uint256 a = available(s);
        if (a > capacity) a = capacity;
        s.allowance = uint128(a);
        s.allowanceTime = uint64(block.timestamp);
        s.capacity = capacity;
        s.refill = refill;
        emit KeeperBucketChanged(capacity, refill);
    }
    function available(State storage s) public view returns (uint256 a) {
        a = s.allowance + (block.timestamp - s.allowanceTime) * s.refill;
        uint256 c = s.capacity;
        if (a > c) a = c;
    }
    function pay(State storage s, Economics memory e, Work memory w, uint256 fund)
        public returns (uint256 amount)
    {
        amount = reward(e, w);
        uint256 balance = available(s);
        if (amount > balance || amount > fund) revert PaymentUnavailable();
        s.allowance = uint128(balance - amount);
        s.allowanceTime = uint64(block.timestamp);
        if (amount != 0) {
            SafeTransferLib.forceSafeTransferETH(msg.sender, amount);
            emit KeeperPaid(msg.sender, amount, w.measuredGas);
        }
    }

    /// @dev Actual issued work plus one bounded operating call, independent of inventory restoration.
    ///      Zero economics (paid upkeep off) budget nothing.
    function maintenanceBudget(Economics memory e, Reserve memory r) public pure returns (uint256 need) {
        need = r.owed * paymentBound(e, r.baseFee, 1, 1, 0, 0);
        if (!r.enabled) return need;
        uint256 operating = paymentBound(e, r.baseFee, 0, 5, 5, 5);
        uint256 processing = paymentBound(e, r.baseFee, 2, 5, 0, 0);
        need += operating > processing ? operating : processing;
    }

    /// @dev Full withdrawal/opening target. Missing prize capital never enters economics-change funding.
    function reserve(Economics memory e, Reserve memory r) public pure returns (uint256 need) {
        need = maintenanceBudget(e, r);
        if (!r.enabled) return need;
        uint256 units;
        uint256 prizes;
        uint256 sizes;
        uint256 amounts = 0x9c400fa00c800190014000300022710138803e801f400640032000a00050001;
        for (uint256 k; k < 16; ++k) {
            uint256 d = (BY_VALUE >> (4 * k)) & 0xF;
            uint256 want = (r.target >> (16 * d)) & 0xFFFF;
            if (want <= r.have[d]) continue;
            uint256 missing = want - r.have[d];
            uint256 w = (0x3323232111111111 >> (4 * d)) & 0xF;
            uint256 cost = ((amounts >> (16 * d)) & 0xFFFF) * 0.01 ether + w * r.mintFee;
            need += missing * cost;
            while (missing != 0) {
                // Compress all complete same-size batches except the last, which can share its remaining slots.
                if (units == 0) {
                    uint256 perBatch = 5 / w;
                    uint256 batches = (missing - 1) / perBatch;
                    if (batches != 0) {
                        need += batches * paymentBound(e, r.baseFee, 0, 0, perBatch * w, perBatch);
                        missing -= batches * perBatch;
                    }
                }
                uint256 take = (5 - units) / w;
                if (take > missing) take = missing;
                if (take != 0) {
                    units += take * w;
                    prizes += take;
                    ++sizes;
                    missing -= take;
                }
                if (missing != 0 || units == 5 || sizes == 4) {
                    need += paymentBound(e, r.baseFee, 0, 0, units, prizes);
                    units = 0;
                    prizes = 0;
                    sizes = 0;
                }
            }
        }
        if (units != 0) need += paymentBound(e, r.baseFee, 0, 0, units, prizes);
    }

    /// @dev Gas paid for the verified work: the sum of the operation bounds, never above `maxGas`.
    function workGas(Economics memory e, uint256 processed, uint256 draws, uint256 units, uint256 prizes)
        internal pure returns (uint256 gas)
    {
        gas = e.baseGas + processed * e.processGas + draws * e.reconcileGas + units * e.shapeGas + prizes * e.prizeGas;
        if (gas > e.maxGas) gas = e.maxGas;
    }

    function referencePrice(Economics memory e, uint256 baseFee) internal pure returns (uint256 price) {
        price = baseFee + e.priorityAllowance;
        if (price > e.gasPriceCeiling) price = e.gasPriceCeiling;
    }

    function paymentBound(Economics memory e, uint256 baseFee, uint256 processed, uint256 draws,
        uint256 units, uint256 prizes) public pure returns (uint256)
    {
        return _bound(e, workGas(e, processed, draws, units, prizes), referencePrice(e, baseFee), processed + draws + units);
    }

    function listingPaymentBound(Economics memory e, uint256 draws, uint256 units, uint256 prizes)
        public view returns (uint256)
    {
        uint256 price = referencePrice(e, block.basefee);
        if (price > tx.gasprice) price = tx.gasprice;
        return _bound(e, workGas(e, 0, draws, units, prizes), price, draws + units);
    }

    function _bound(Economics memory e, uint256 measured, uint256 price, uint256 serviceUnits)
        internal pure returns (uint256)
    {
        return (measured + e.overheadGas) * price + serviceUnits * e.workFee;
    }

    /// @dev Derived bound, never a per-call charge: the most one call can be paid under `e`.
    function maxPayment(Economics memory e) internal pure returns (uint256) {
        return (uint256(e.maxGas) + e.overheadGas) * e.gasPriceCeiling + MAX_SERVICE_UNITS * e.workFee;
    }
    /// @dev Derived bound: the restocking surcharge per Shape at the gas price ceiling.
    function maxSurcharge(Economics memory e) internal pure returns (uint256) {
        return uint256(e.restockGas) * e.gasPriceCeiling + e.restockFlat;
    }

    /// @dev Keeper-payment identity: economics, their source, paid state and generation, and the live Shapes mint fee.
    function settingsHash(Economics memory e, uint8 source, uint64 generation, bool enabled,
        uint256 mintFee) internal pure returns (bytes32)
    {
        return keccak256(abi.encode(e, source, generation, enabled, mintFee));
    }

    /// @dev Every number in `e` is valid at its field width; only the paused grace must not exceed the normal one
    ///      (`stuck` applies the shorter grace first).
    function validate(Economics memory e) public pure {
        if (e.pausedProcessGraceBlocks > e.processGraceBlocks) revert InvalidGrace();
    }
    /// @dev Pay for verified work: (min(measured gas, operation gas bound, maxGas) + overheadGas)
    ///      * min(transaction gas price, basefee + priorityAllowance, gasPriceCeiling)
    ///      + workFee * (processed + reconciled draws + listed Shape units).
    function reward(Economics memory e, Work memory w) public pure returns (uint256) {
        uint256 price = referencePrice(e, w.baseFee);
        if (price > w.gasPrice) price = w.gasPrice;
        uint256 measured = workGas(e, w.processedDraws, w.reconciledDraws, w.listedShapeUnits, w.listedPrizes);
        if (measured > w.measuredGas) measured = w.measuredGas;
        return _bound(e, measured, price, w.processedDraws + w.reconciledDraws + w.listedShapeUnits);
    }

    /// @dev Draws at the head of FWA's queue that FWA's processor will settle or expire, at most two, each requested at
    ///      least `grace` blocks ago; `nShort` counts the same under `shortGrace`. That is Ready (5, randomness cached),
    ///      TimedOut (6, randomness arrived late) or Pending (1) past its word deadline (randomness never arrived); a
    ///      draw still within its deadline stops it. Two per call keeps the worst upkeep under the default 3.2M gas.
    function stuck(IFWAPool p, uint64 s, uint256 grace, uint256 shortGrace)
        public view returns (uint256 n, uint256 nShort)
    {
        uint64 last = p.lastIssuedSequence();
        for (; nShort < 2 && s <= last; ++s) {
            uint256 id = p.requestIdAtSequence(s);
            (, uint256 requested,,, uint8 status,) = p.acquisitions(id);
            if (block.number < requested + shortGrace) break;
            // FWA expires a Pending draw only once block.number > wordDeadlineBlock (StandardPool.processAcquisitions).
            if (status == 1) {
                (, uint64 deadline,,,,) = p.acquisitionMeta(id);
                if (block.number > deadline) status = 6;
            }
            if (status != 5 && status != 6) break;
            ++nShort;
            if (n + 1 == nShort && block.number >= requested + grace) ++n;
        }
    }

    /// @dev Gas a failed processing call can hand back and still have been starved: FWA reverts on purpose when its
    ///      notifier would start with under 290,000 gas, and the pool is a proxy that keeps 1/64 of what it forwards,
    ///      so a starved failure hands back at most about 343,000 (measured, 48 to 2,048 listings). A failure with more
    ///      than this left was not for want of gas. The proxy's share grows with the gas processing needs, so the bound
    ///      holds for two processed draws (`stuck`) and FWA's six-listing reservations (at most about 3.3M).
    uint256 internal constant PROCESS_STARVED_GAS = 400_000;
    error InsufficientGas();

    /// @dev Processes `n` stuck draws on FWA (run by delegatecall, as the pool). Returns the draws processed and the
    ///      gas of a reverted attempt, which the caller leaves unpaid. Processing that failed for want of gas reverts.
    function process(IFWAPool p, uint64 next, uint256 n) public returns (uint256 processed, uint256 unpaid) {
        uint256 g = gasleft();
        try p.processAcquisitions(n) {
            processed = p.nextSequenceToProcess() - next;
        } catch {
            uint256 left = gasleft();
            if (left < g / 64 + PROCESS_STARVED_GAS) revert InsufficientGas();
            unpaid = g - left;
        }
    }

    /// @dev Restocking surcharge for one prize of `units` Shapes: units * (restockGas * min(basefee + priorityAllowance,
    ///      gasPriceCeiling) + restockFlat). Paid and unpaid callers price alike. Existing listings never change.
    function restock(Economics memory e, uint256 units, uint256 baseFee) internal pure returns (uint256) {
        return units * (uint256(e.restockGas) * referencePrice(e, baseFee) + e.restockFlat);
    }
}
