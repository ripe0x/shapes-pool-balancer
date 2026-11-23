// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IKeeperPolicy} from "./interfaces/IKeeperPolicy.sol";

/// @dev Fixed returndata buffer and gas stipend bound even a reverting, gas-burning or returndata-bomb policy.
library KeeperPolicyCalls {
    uint256 internal constant GAS_LIMIT = 100_000;
    uint256 internal constant HARD_MAX_REWARD = 0.311 ether;
    uint256 internal constant MAX_GAS = 6_000_000;
    uint256 internal constant OVERHEAD_GAS = 100_000;
    uint256 internal constant BASE_GAS = 200_000;
    uint256 internal constant PROCESS_GAS = 1_800_000;
    uint256 internal constant RECONCILE_GAS = 150_000;
    uint256 internal constant SHAPE_GAS = 700_000;
    uint256 internal constant PRIZE_GAS = 150_000;
    uint256 internal constant PRIORITY_ALLOWANCE = 0.1 gwei;
    uint256 internal constant GAS_PRICE_CEILING = 50 gwei;
    uint256 internal constant WORK_FEE = 0.00005 ether;
    uint256 internal constant BY_VALUE = 0x87f65ed43cb21a90;
    error InvalidPolicy();
    error PolicyUnavailable();

    struct State {
        address policy;
        bool enabled;
        uint256 maxReward;
    }
    struct Reserve {
        bool enabled;
        uint256 owed;
        uint256 target;
        uint16[16] have;
        uint256 mintFee;
        uint256 baseFee;
    }
    event KeeperPolicyChanged(address indexed previousPolicy, address indexed newPolicy);
    event PaidUpkeepChanged(bool enabled);
    event KeeperPaid(address indexed keeper, uint256 amount, uint256 gasUsed);
    error PaymentUnavailable();
    error ReserveNotFunded();

    function initialize(State storage s, address policy) public {
        s.policy = policy;
        s.maxReward = validate(policy);
        s.enabled = true;
        emit KeeperPolicyChanged(address(0), policy);
    }
    /// @dev Immediate replacement (creator-authorized in PoolBalancer). Keeps the funding check: a greater maintenance
    ///      exposure than the current one must be funded from operating capital. Always (re)enables paid upkeep.
    function setPolicy(State storage s, address policy, uint256 fund, Reserve memory r) public {
        uint256 bound = validate(policy);
        uint256 candidate = maintenanceBudget(bound, r);
        uint256 previous = maintenanceBudget(s.enabled ? s.maxReward : 0, r);
        // A lower bound need not quote less for each job; only immutable maintenance exposure is compared.
        if (candidate > previous && fund < candidate) revert ReserveNotFunded();
        emit KeeperPolicyChanged(s.policy, policy);
        s.policy = policy;
        s.maxReward = bound;
        s.enabled = true;
        emit PaidUpkeepChanged(true);
    }
    /// @dev Immediate emergency stop.
    function disable(State storage s) public {
        s.enabled = false;
        emit PaidUpkeepChanged(false);
    }
    /// @dev Immediate re-enable with the same funding check, against zero current paid exposure.
    function enable(State storage s, uint256 fund, Reserve memory r) public {
        uint256 need = maintenanceBudget(s.maxReward, r);
        if (need != 0 && fund < need) revert ReserveNotFunded();
        s.enabled = true;
        emit PaidUpkeepChanged(true);
    }
    function pay(State storage s, IKeeperPolicy.Work memory w, uint256 fund) public returns (uint256 amount) {
        amount = reward(s.policy, s.maxReward, w);
        if (amount > fund) revert PaymentUnavailable();
        if (amount != 0) {
            SafeTransferLib.forceSafeTransferETH(msg.sender, amount);
            emit KeeperPaid(msg.sender, amount, w.measuredGas);
        }
    }
    /// @dev Actual issued work plus one bounded operating call, independent of inventory restoration and policy quotes.
    function maintenanceBudget(uint256 maxReward, Reserve memory r) public pure returns (uint256 need) {
        need = r.owed * paymentBound(maxReward, r.baseFee, 1, 1, 0, 0);
        if (!r.enabled) return need;
        uint256 operating = paymentBound(maxReward, r.baseFee, 0, 5, 5, 5);
        uint256 process = paymentBound(maxReward, r.baseFee, 2, 5, 0, 0);
        need += operating > process ? operating : process;
    }

    /// @dev Full withdrawal/opening target. Missing prize capital never enters policy activation funding.
    function reserve(uint256 maxReward, Reserve memory r) public pure returns (uint256 need) {
        need = maintenanceBudget(maxReward, r);
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
                        need += batches * paymentBound(maxReward, r.baseFee, 0, 0, perBatch * w, perBatch);
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
                    need += paymentBound(maxReward, r.baseFee, 0, 0, units, prizes);
                    units = 0;
                    prizes = 0;
                    sizes = 0;
                }
            }
        }
        if (units != 0) need += paymentBound(maxReward, r.baseFee, 0, 0, units, prizes);
    }

    /// @dev Operation coefficients are immutable payment ceilings, not claims about actual execution gas.
    function workGas(uint256 processed, uint256 draws, uint256 units, uint256 prizes) internal pure returns (uint256 gas) {
        gas = BASE_GAS + processed * PROCESS_GAS + draws * RECONCILE_GAS + units * SHAPE_GAS + prizes * PRIZE_GAS;
        if (gas > MAX_GAS) gas = MAX_GAS;
    }

    function referencePrice(uint256 baseFee) internal pure returns (uint256 price) {
        price = baseFee + PRIORITY_ALLOWANCE;
        if (price > GAS_PRICE_CEILING) price = GAS_PRICE_CEILING;
    }

    function paymentBound(uint256 maxReward, uint256 baseFee, uint256 processed, uint256 draws, uint256 units, uint256 prizes)
        public pure returns (uint256)
    {
        return _bound(maxReward, workGas(processed, draws, units, prizes), referencePrice(baseFee), draws + units);
    }

    function listingPaymentBound(uint256 maxReward, uint256 draws, uint256 units, uint256 prizes)
        public view returns (uint256)
    {
        uint256 price = referencePrice(block.basefee);
        if (price > tx.gasprice) price = tx.gasprice;
        return _bound(maxReward, workGas(0, draws, units, prizes), price, draws + units);
    }

    function _bound(uint256 maxReward, uint256 measured, uint256 price, uint256 serviceUnits) internal pure returns (uint256 amount) {
        amount = (measured + OVERHEAD_GAS) * price + serviceUnits * WORK_FEE;
        if (amount > maxReward) amount = maxReward;
        if (amount > HARD_MAX_REWARD) amount = HARD_MAX_REWARD;
    }

    function word(address policy, bytes memory input) internal view returns (bool ok, uint256 value) {
        assembly ("memory-safe") {
            let out := mload(0x40)
            ok := staticcall(GAS_LIMIT, policy, add(input, 32), mload(input), out, 32)
            ok := and(ok, eq(returndatasize(), 32))
            value := mload(out)
        }
    }
    function validate(address policy) public view returns (uint256 bound) {
        (bool ok, uint256 v) = word(policy, abi.encodeCall(IKeeperPolicy.interfaceVersion, ()));
        if (!ok || v != 1 || policy.code.length == 0) revert InvalidPolicy();
        (ok, bound) = word(policy, abi.encodeCall(IKeeperPolicy.maxReward, ()));
        if (!ok || bound == 0 || bound > HARD_MAX_REWARD) revert InvalidPolicy();
    }
    function reward(address policy, uint256 maxReward, IKeeperPolicy.Work memory w) public view returns (uint256 amount) {
        (bool ok, uint256 quote) = word(policy, abi.encodeCall(IKeeperPolicy.quoteReward, (w)));
        if (!ok) revert PolicyUnavailable();
        uint256 price = referencePrice(w.baseFee);
        if (price > w.gasPrice) price = w.gasPrice;
        uint256 measured = workGas(w.processedDraws, w.reconciledDraws, w.listedShapeUnits, w.listedPrizes);
        if (measured > w.measuredGas) measured = w.measuredGas;
        uint256 envelope = _bound(maxReward, measured, price, w.reconciledDraws + w.listedShapeUnits);
        return quote < envelope ? quote : envelope;
    }

    function restock(address policy, uint8 d, uint256 units, bool paid, uint256 baseFee) public view returns (uint256) {
        (bool ok, uint256 quote) = word(policy, abi.encodeCall(IKeeperPolicy.quoteRestock, (d, units, baseFee)));
        // Unpaid callers cannot select cheaper pricing while the creator's chosen policy is healthy. The per-Shape cap
        // is basefee-indexed at 2x V1's 900k gas and 0.0002 ETH flat, measured at the reference price, so V1 always
        // passes and any policy that quotes materially above a reasonable gas cost is refused.
        if (ok && quote <= units * (1_800_000 * referencePrice(baseFee) + 0.0004 ether)) return quote;
        if (paid) revert PolicyUnavailable();
        uint256 price = baseFee + 0.05 gwei;
        if (price > 5 gwei) price = 5 gwei;
        return units * (900_000 * price + 0.0002 ether);
    }

}
