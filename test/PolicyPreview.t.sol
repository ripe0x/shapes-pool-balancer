// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {IKeeperPolicy} from "../src/interfaces/IKeeperPolicy.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";

/// @dev A deliberately caller-sensitive creator-selected policy, not a replacement protocol dependency.
contract CallerSensitivePolicy is IKeeperPolicy {
    address immutable balancer;
    constructor(address b) { balancer = b; }
    function interfaceVersion() external pure returns (uint256) { return 1; }
    function version() external pure returns (uint256) { return 99; }
    function maxReward() external pure returns (uint256) { return 0.311 ether; }
    function quoteRestock(uint8, uint256 units, uint256) external view returns (uint256) {
        // Pool-context quote stays within the basefee-indexed restock cap (0.00148 ETH/unit at 0.5 gwei).
        return units * (msg.sender == balancer ? 0.001 ether : 0.0002 ether);
    }
    function quoteReward(Work calldata) external view returns (uint256) {
        return msg.sender == balancer ? 0.0003 ether : 0.0001 ether;
    }
}

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
        CallerSensitivePolicy policy = new CallerSensitivePolicy(address(balancer));
        vm.prank(creator); balancer.setKeeperPolicy(address(policy));
        assertEq(policy.quoteRestock(0, 1, block.basefee), 0.0002 ether);
        uint256 fee = balancer.restockFeeFor(0);
        assertEq(fee, 0.001 ether);
        IKeeperPolicy.Work memory w = IKeeperPolicy.Work(1_000_000, 1 gwei, 0.5 gwei, 0, 1, 1, 0);
        assertEq(policy.quoteReward(w), 0.0001 ether);
        assertEq(balancer.quoteKeeperReward(w), 0.0003 ether);
        uint256[] memory ids = balancer.getActiveIds();
        uint256[] memory one = new uint256[](1);
        for (uint256 i; i < ids.length; ++i) {
            (uint8 candidateKind,,,,) = balancer.items(ids[i]);
            if (candidateKind == 2) { one[0] = ids[i]; break; }
        }
        vm.prank(creator); balancer.unlistShapes(one);
        uint256 last = lastListingId();
        uint256 beforeReward = keeper.balance;
        upkeep();
        (uint8 kind,,, uint112 base, uint112 price) = balancer.items(last + 1);
        assertEq(kind, 2);
        assertEq(uint256(price) - base, fee, "real FWA listing matches pool-context surcharge");
        assertEq(keeper.balance - beforeReward, 0.0003 ether, "real payment matches pool-context quote");
    }
}
