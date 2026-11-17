// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IKeeperPolicy} from "../src/interfaces/IKeeperPolicy.sol";
import {KeeperPolicyV1} from "../src/KeeperPolicyV1.sol";
import {KeeperPolicyCalls} from "../src/KeeperPolicyCalls.sol";

/// @dev Quote arithmetic only. A real CALL gives each measurement its own isolated access list. Intrinsic gas,
///      payment transfers, accounting and cap-storage reads are outside the measured spans.
contract PolicyQuoteGasMeter {
    function compare(address policy, IKeeperPolicy.Work calldata input, bool warm)
        external returns (uint256 inlineReward, uint256 boundedReward, uint256 inlineGas, uint256 boundedGas)
    {
        IKeeperPolicy.Work memory w = input;
        if (warm) {
            uint256 primed = KeeperPolicyCalls.reward(policy, 0.01645 ether, w);
            require(primed != 0, "warm-up quote");
        }
        uint256 g = gasleft();
        uint256 measured = w.measuredGas > 3_200_000 ? 3_200_000 : w.measuredGas;
        uint256 price = w.baseFee + 0.05 gwei;
        if (price > 5 gwei) price = 5 gwei;
        if (price > w.gasPrice) price = w.gasPrice;
        inlineReward = (measured + 50_000) * price + (w.reconciledDraws + w.listedShapeUnits) * 0.00002 ether;
        inlineGas = g - gasleft();
        g = gasleft();
        boundedReward = KeeperPolicyCalls.reward(policy, 0.01645 ether, w);
        boundedGas = g - gasleft();
    }
}

contract PolicyGasOverheadTest is Test {
    function test_inlineVersusBoundedQuoteColdAndWarm() public {
        KeeperPolicyV1 policy = new KeeperPolicyV1();
        PolicyQuoteGasMeter meter = new PolicyQuoteGasMeter();
        IKeeperPolicy.Work memory w = IKeeperPolicy.Work(864_000, 0.55 gwei, 0.5 gwei, 1, 1, 1, 0);
        vm.cool(address(policy));
        vm.cool(address(KeeperPolicyCalls));
        (uint256 inlineCold, uint256 boundedCold, uint256 inlineGasCold, uint256 boundedGasCold) =
            meter.compare(address(policy), w, false);
        vm.cool(address(policy));
        vm.cool(address(KeeperPolicyCalls));
        (uint256 inlineWarm, uint256 boundedWarm, uint256 inlineGasWarm, uint256 boundedGasWarm) =
            meter.compare(address(policy), w, true);
        assertEq(inlineCold, 0.0005427 ether, "independent V1 amount at the stated inputs");
        assertEq(boundedCold, inlineCold);
        assertEq(inlineWarm, inlineCold);
        assertEq(boundedWarm, inlineWarm);
        assertGt(boundedGasCold, boundedGasWarm, "the explicit warm-up reduces quote-boundary gas");
        assertGt(boundedGasCold, inlineGasCold);
        assertGt(boundedGasWarm, inlineGasWarm);
        emit log_named_uint("inline V1 gas, no prior external quote", inlineGasCold);
        emit log_named_uint("bounded V1 gas, cold policy and linked helper", boundedGasCold);
        emit log_named_uint("additional gas over inline, cold", boundedGasCold - inlineGasCold);
        emit log_named_uint("inline V1 gas, after quote warm-up", inlineGasWarm);
        emit log_named_uint("bounded V1 gas, warm policy and linked helper", boundedGasWarm);
        emit log_named_uint("additional gas over inline, warm", boundedGasWarm - inlineGasWarm);
    }
}
