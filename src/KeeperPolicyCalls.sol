// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {Settings, SettingsLib} from "./Settings.sol";
import {IKeeperPolicy} from "./interfaces/IKeeperPolicy.sol";

/// @dev Fixed returndata buffer and gas stipend bound even a reverting, gas-burning or returndata-bomb policy.
library KeeperPolicyCalls {
    uint256 internal constant GAS_LIMIT = 100_000;
    uint256 internal constant HARD_MAX_REWARD = 0.311 ether;
    error InvalidPolicy();
    error PolicyUnavailable();

    struct State {
        address policy;
        address pending;
        uint64 activationTime;
        uint64 generation;
        bool enabled;
        uint256 maxReward;
        uint256 allowance;
        uint64 allowanceTime;
    }
    struct Reserve {
        bool enabled;
        uint256 owed;
        uint256 target;
        uint16[16] have;
        uint256 mintFee;
        uint256 listedPrizes;
        uint256 listedFees;
    }
    event KeeperPolicyProposed(address indexed policy, uint256 activationTime);
    event KeeperPolicyCancelled(address indexed policy);
    event KeeperPolicyChanged(address indexed previousPolicy, address indexed newPolicy);
    event PaidUpkeepChanged(bool enabled);
    event KeeperPaid(address indexed keeper, uint256 amount, uint256 gasUsed);
    error PolicyNotReady();
    error PaymentUnavailable();
    error ReserveNotFunded();

    function initialize(State storage s, address policy) public {
        s.policy = policy;
        s.maxReward = validate(policy);
        s.enabled = true;
        s.allowance = 10 * HARD_MAX_REWARD;
        s.allowanceTime = uint64(block.timestamp);
        emit KeeperPolicyChanged(address(0), policy);
    }
    function propose(State storage s, address policy) public {
        validate(policy);
        s.pending = policy;
        s.activationTime = uint64(block.timestamp + 2 days);
        emit KeeperPolicyProposed(policy, s.activationTime);
    }
    function cancel(State storage s) public {
        emit KeeperPolicyCancelled(s.pending);
        s.pending = address(0);
        s.activationTime = 0;
    }
    function activate(State storage s, uint256 fund, Reserve memory r) public {
        if (s.pending == address(0) || block.timestamp < s.activationTime) revert PolicyNotReady();
        uint256 bound = validate(s.pending);
        if (fund < reserve(bound, r)) revert ReserveNotFunded();
        emit KeeperPolicyChanged(s.policy, s.pending);
        s.policy = s.pending;
        s.maxReward = bound;
        s.enabled = true;
        ++s.generation;
        cancel(s);
        emit PaidUpkeepChanged(true);
    }
    function disable(State storage s, bool value) public {
        if (value) revert PolicyNotReady();
        s.enabled = false;
        ++s.generation;
        // An already matured proposal must not let a public executor undo the creator's emergency stop.
        cancel(s);
        emit PaidUpkeepChanged(false);
    }
    function available(State storage s) public view returns (uint256) {
        uint256 elapsed = block.timestamp - s.allowanceTime;
        uint256 burst = 10 * HARD_MAX_REWARD;
        uint256 refill = HARD_MAX_REWARD / 12;
        if (elapsed >= burst / refill + 1) return burst;
        uint256 amount = s.allowance + elapsed * refill;
        return amount > burst ? burst : amount;
    }
    function pay(State storage s, IKeeperPolicy.Work memory w, uint256 fund) public returns (uint256 amount) {
        amount = reward(s.policy, s.maxReward, w);
        uint256 balance = available(s);
        if (amount > balance || amount > fund) revert PaymentUnavailable();
        s.allowance = balance - amount;
        s.allowanceTime = uint64(block.timestamp);
        if (amount != 0) {
            SafeTransferLib.forceSafeTransferETH(msg.sender, amount);
            emit KeeperPaid(msg.sender, amount, w.measuredGas);
        }
    }
    function reserve(uint256 maxReward, Reserve memory r) public pure returns (uint256 need) {
        if (!r.enabled) return r.owed * maxReward;
        uint256 units;
        uint256 largest;
        uint256 targetPrizes;
        uint256 amounts = 0x9c400fa00c800190014000300022710138803e801f400640032000a00050001;
        for (uint256 d; d < 16; ++d) {
            uint256 want = (r.target >> (16 * d)) & 0xFFFF;
            if (want == 0) continue;
            targetPrizes += want;
            uint256 shapeUnits = (0x3323232111111111 >> (4 * d)) & 0xF;
            uint256 cost = ((amounts >> (16 * d)) & 0xFFFF) * 0.01 ether + shapeUnits * r.mintFee;
            if (cost > largest) largest = cost;
            uint256 have = r.have[d];
            if (want > have) {
                need += (want - have) * cost;
                units += (want - have) * shapeUnits;
            }
        }
        uint256 draws = r.owed + 1;
        need += draws * largest;
        units += draws * 3;
        need += (units + draws) * maxReward;
        uint256 prizes = targetPrizes > r.listedPrizes ? targetPrizes : r.listedPrizes;
        uint256 cycleCost = 2 * prizes * maxReward;
        if (cycleCost > r.listedFees) need += cycleCost - r.listedFees;
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
        uint256 price = w.baseFee + 2 gwei;
        if (price > w.gasPrice) price = w.gasPrice;
        if (price > 50 gwei) price = 50 gwei;
        uint256 envelope = ((w.measuredGas > 6_000_000 ? 6_000_000 : w.measuredGas) + 200_000) * price
            + (w.reconciledDraws + w.listedShapeUnits) * 0.001 ether;
        amount = quote;
        if (amount > envelope) amount = envelope;
        if (amount > maxReward) amount = maxReward;
        if (amount > HARD_MAX_REWARD) amount = HARD_MAX_REWARD;
    }

    function restock(address policy, uint8 d, uint256 units, bool paid, uint256 baseFee) public view returns (uint256) {
        (bool ok, uint256 quote) = word(policy, abi.encodeCall(IKeeperPolicy.quoteRestock, (d, units, baseFee)));
        // Unpaid callers cannot select cheaper pricing while the creator's chosen policy is healthy.
        if (ok && quote <= units * 0.102 ether) return quote;
        if (paid) revert PolicyUnavailable();
        uint256 price = baseFee + 0.05 gwei;
        if (price > 5 gwei) price = 5 gwei;
        return units * (900_000 * price + 0.0002 ether);
    }

    function metadata(address policy) public view returns (Settings memory s) {
        s = SettingsLib.defaults();
        bytes memory input = abi.encodeWithSignature("settings()");
        bool ok;
        bytes memory output = new bytes(256);
        assembly ("memory-safe") {
            ok := staticcall(100000, policy, add(input, 32), mload(input), add(output, 32), 256)
            ok := and(ok, eq(returndatasize(), 256))
        }
        if (ok) {
            uint256[8] memory fields;
            assembly ("memory-safe") { fields := add(output, 32) }
            if (fields[0] <= type(uint64).max && fields[1] <= type(uint64).max && fields[2] <= type(uint64).max
                && fields[3] <= type(uint64).max && fields[4] <= type(uint32).max && fields[5] <= type(uint32).max
                && fields[6] <= type(uint32).max && fields[7] <= type(uint32).max) s = abi.decode(output, (Settings));
        }
        s.maxPrizes = 1_000;
    }
}
