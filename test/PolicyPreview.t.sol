// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {KeeperPolicyCalls} from "../src/KeeperPolicyCalls.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";

/// @dev Pool-context previews agree with execution. R95 replaced the caller-sensitive creator policy this test once used
///      with the in-library formula, so the previews are checked against independent V1 arithmetic and the real listing.
contract PolicyPreviewTest is ForkBase {
    function test_poolContextQuotesMatchCallerSensitiveExecution() public {
        setUpFork();
        GasProbe probe = new GasProbe();
        probe.record();
        assertEq(probe.baseFee(), 0.5 gwei);
        assertEq(probe.gasPrice(), 1 gwei);
        createBalancer(3 ether);
        assertLe(factory.implementation().code.length, 24_576, "EIP-170 runtime limit");
        configure(plan([uint256(20),0,0,0,0,0,0,0,0]));
        listCurated(1, 0.2 ether);
        vm.prank(creator); balancer.open();
        fillUp();
        uint256 fee = balancer.restockFeeFor(0);
        assertEq(fee, V1_RESTOCK_GAS * _v1Price() + 0.0002 ether, "restockGas * min(basefee + allowance, ceiling) + flat");
        assertEq(balancer.restockFeeFor(9), 2 * fee, "a 0.02 ETH pack pays the per-Shape surcharge for each of its two Shapes");
        KeeperPolicyCalls.Work memory w = KeeperPolicyCalls.Work(1_000_000, 1 gwei, 0.5 gwei, 0, 1, 1, 0);
        // min(1.0M measured, 200k + 700k + 150k bound) = 1.0M; price min(1, 0.55, 5) gwei; one listed Shape unit.
        assertEq(balancer.quoteKeeperReward(w), (1_000_000 + V1_OVERHEAD) * 0.55 gwei + 0.00002 ether);
        uint256[] memory ids = balancer.getActiveIds();
        uint256[] memory one = new uint256[](1);
        for (uint256 i; i < ids.length; ++i) {
            (uint8 candidateKind,,,,) = balancer.items(ids[i]);
            if (candidateKind == 2) { one[0] = ids[i]; break; }
        }
        vm.prank(creator); balancer.unlistShapes(one);
        uint256 last = lastListingId();
        upkeep();
        (uint8 kind,,, uint112 base, uint112 price) = balancer.items(last + 1);
        assertEq(kind, 2);
        assertEq(uint256(price) - base, fee, "real FWA listing matches pool-context surcharge");
    }
}
