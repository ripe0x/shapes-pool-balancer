// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IKeeperPolicy} from "./interfaces/IKeeperPolicy.sol";

/// @dev Keeper money path over one effective `Economics`, resolved once per operation by PoolBalancer and passed to
///      every quote, payment bound, reserve and restocking price here. Policy calls use a fixed returndata buffer and gas
///      stipend, which bound even a reverting, gas-burning or returndata-bomb policy.
library KeeperPolicyCalls {
    /// @dev Gas forwarded to a policy quote. A technical bound on an untrusted call, not an economic setting.
    uint256 internal constant GAS_LIMIT = 100_000;
    /// @dev Paid service units one call can complete: MAX_RECONCILE (5) draws plus MAX_OPS (5) Shape units.
    uint256 internal constant MAX_SERVICE_UNITS = 10;
    uint256 internal constant BY_VALUE = 0x87f65ed43cb21a90;
    /// @dev `State.source`: follow the factory's current economics, or use the pool's own copy (set or pinned).
    uint8 internal constant FOLLOW = 0;
    uint8 internal constant LOCAL = 1;
    uint8 internal constant PINNED = 2;
    error InvalidPolicy();
    error PolicyUnavailable();

    struct State {
        uint8 source;
        bool enabled;
        /// @dev Advances on every economics, source or paid-upkeep change, so a disable/re-enable cycle changes `settingsHash`.
        uint64 generation;
        uint64 allowanceTime;
        uint96 refill; // wei per second
        uint128 allowance;
        uint128 capacity;
        IKeeperPolicy.Economics local; // used unless `source == FOLLOW`
    }
    struct Reserve {
        bool enabled;
        uint256 owed;
        uint256 target;
        uint16[16] have;
        uint256 mintFee;
        uint256 baseFee;
    }
    event EconomicsSelected(uint8 indexed source, IKeeperPolicy.Economics economics);
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
    function select(State storage s, uint8 source, IKeeperPolicy.Economics memory next,
        IKeeperPolicy.Economics memory current, uint256 fund, Reserve memory r) public
    {
        if (source == LOCAL) validate(next);
        if (s.enabled) _requireFunded(next, current, fund, r);
        s.source = source;
        if (source != FOLLOW) s.local = next;
        ++s.generation;
        emit EconomicsSelected(source, next);
    }
    /// @dev Immediate emergency stop or re-enable. Re-enabling compares the effective maintenance budget against zero
    ///      paid exposure. The spending allowance is untouched either way, so no change refills it.
    function setEnabled(State storage s, bool value, IKeeperPolicy.Economics memory e, uint256 fund, Reserve memory r)
        public
    {
        IKeeperPolicy.Economics memory none;
        if (value && !s.enabled) _requireFunded(e, none, fund, r);
        s.enabled = value;
        ++s.generation;
        emit PaidUpkeepChanged(value);
    }
    function _requireFunded(IKeeperPolicy.Economics memory next, IKeeperPolicy.Economics memory current, uint256 fund,
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
    function pay(State storage s, IKeeperPolicy.Economics memory e, IKeeperPolicy.Work memory w, uint256 fund)
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

    /// @dev Actual issued work plus one bounded operating call, independent of inventory restoration and policy quotes.
    ///      Zero economics (paid upkeep off) budget nothing.
    function maintenanceBudget(IKeeperPolicy.Economics memory e, Reserve memory r) public pure returns (uint256 need) {
        need = r.owed * paymentBound(e, r.baseFee, 1, 1, 0, 0);
        if (!r.enabled) return need;
        uint256 operating = paymentBound(e, r.baseFee, 0, 5, 5, 5);
        uint256 process = paymentBound(e, r.baseFee, 2, 5, 0, 0);
        need += operating > process ? operating : process;
    }

    /// @dev Full withdrawal/opening target. Missing prize capital never enters policy-change funding.
    function reserve(IKeeperPolicy.Economics memory e, Reserve memory r) public pure returns (uint256 need) {
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
    function workGas(IKeeperPolicy.Economics memory e, uint256 processed, uint256 draws, uint256 units, uint256 prizes)
        internal pure returns (uint256 gas)
    {
        gas = e.baseGas + processed * e.processGas + draws * e.reconcileGas + units * e.shapeGas + prizes * e.prizeGas;
        if (gas > e.maxGas) gas = e.maxGas;
    }

    function referencePrice(IKeeperPolicy.Economics memory e, uint256 baseFee) internal pure returns (uint256 price) {
        price = baseFee + e.priorityAllowance;
        if (price > e.gasPriceCeiling) price = e.gasPriceCeiling;
    }

    function paymentBound(IKeeperPolicy.Economics memory e, uint256 baseFee, uint256 processed, uint256 draws,
        uint256 units, uint256 prizes) public pure returns (uint256)
    {
        return _bound(e, workGas(e, processed, draws, units, prizes), referencePrice(e, baseFee), draws + units);
    }

    function listingPaymentBound(IKeeperPolicy.Economics memory e, uint256 draws, uint256 units, uint256 prizes)
        public view returns (uint256)
    {
        uint256 price = referencePrice(e, block.basefee);
        if (price > tx.gasprice) price = tx.gasprice;
        return _bound(e, workGas(e, 0, draws, units, prizes), price, draws + units);
    }

    function _bound(IKeeperPolicy.Economics memory e, uint256 measured, uint256 price, uint256 serviceUnits)
        internal pure returns (uint256)
    {
        return (measured + e.overheadGas) * price + serviceUnits * e.workFee;
    }

    /// @dev Derived bound, never a per-call charge: the most one call can be paid under `e`.
    function maxPayment(IKeeperPolicy.Economics memory e) internal pure returns (uint256) {
        return (uint256(e.maxGas) + e.overheadGas) * e.gasPriceCeiling + MAX_SERVICE_UNITS * e.workFee;
    }
    /// @dev Derived bound on a policy's restocking quote per Shape, and the fallback schedule's value at the ceiling.
    function maxSurcharge(IKeeperPolicy.Economics memory e) internal pure returns (uint256) {
        return uint256(e.restockGas) * e.gasPriceCeiling + e.restockFlat;
    }

    /// @dev Keeper-payment identity: economics, their source, paid state and generation, and the live Shapes mint fee.
    function settingsHash(IKeeperPolicy.Economics memory e, uint8 source, uint64 generation, bool enabled,
        uint256 mintFee) internal pure returns (bytes32)
    {
        return keccak256(abi.encode(e, source, generation, enabled, mintFee));
    }

    function word(address policy, bytes memory input) internal view returns (bool ok, uint256 value) {
        assembly ("memory-safe") {
            let out := mload(0x40)
            ok := staticcall(GAS_LIMIT, policy, add(input, 32), mload(input), out, 32)
            ok := and(ok, eq(returndatasize(), 32))
            value := mload(out)
        }
    }
    /// @dev Only the algorithm is checked: every number in `e` is valid at its field width.
    function validate(IKeeperPolicy.Economics memory e) public view {
        (bool ok, uint256 v) = word(e.policy, abi.encodeCall(IKeeperPolicy.interfaceVersion, ()));
        if (!ok || v != 2 || e.policy.code.length == 0) revert InvalidPolicy();
    }
    function reward(IKeeperPolicy.Economics memory e, IKeeperPolicy.Work memory w) public view returns (uint256) {
        (bool ok, uint256 quote) = word(e.policy, abi.encodeCall(IKeeperPolicy.quoteReward, (w, e)));
        if (!ok) revert PolicyUnavailable();
        uint256 price = referencePrice(e, w.baseFee);
        if (price > w.gasPrice) price = w.gasPrice;
        uint256 measured = workGas(e, w.processedDraws, w.reconciledDraws, w.listedShapeUnits, w.listedPrizes);
        if (measured > w.measuredGas) measured = w.measuredGas;
        uint256 envelope = _bound(e, measured, price, w.reconciledDraws + w.listedShapeUnits);
        return quote < envelope ? quote : envelope;
    }

    function restock(IKeeperPolicy.Economics memory e, uint8 d, uint256 units, bool paid, uint256 baseFee)
        public view returns (uint256)
    {
        (bool ok, uint256 quote) = word(e.policy, abi.encodeCall(IKeeperPolicy.quoteRestock, (d, units, baseFee, e)));
        // Unpaid callers cannot select cheaper pricing while the selected policy is healthy.
        if (ok && quote <= units * maxSurcharge(e)) return quote;
        if (paid) revert PolicyUnavailable();
        // Explicit fallback: the selected economics' own restocking schedule.
        return units * (uint256(e.restockGas) * referencePrice(e, baseFee) + e.restockFlat);
    }
}
