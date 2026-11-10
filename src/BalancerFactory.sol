// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LibClone} from "solady/utils/LibClone.sol";
import {PoolBalancer} from "./PoolBalancer.sol";

/// @title BalancerFactory
/// @notice Deploys one PoolBalancer minimal-proxy clone per creator call. Ownerless: it keeps no
///         authority over deployed Balancers, their FWA pools or their assets.
contract BalancerFactory {
    address public immutable implementation;

    address[] public allBalancers;
    mapping(address balancer => bool) public isBalancer;

    event BalancerCreated(address indexed creator, address indexed balancer, address indexed pool, bytes32 salt);

    constructor(address implementation_) {
        implementation = implementation_;
    }

    /// @notice Deploy a Balancer for `msg.sender`, which immediately creates and owns a new FWA pool.
    ///         Any ETH sent is deposited into the Balancer.
    function createBalancer(bytes32 salt) external payable returns (address balancer) {
        balancer = LibClone.cloneDeterministic(implementation, _salt(msg.sender, salt));
        isBalancer[balancer] = true;
        allBalancers.push(balancer);
        PoolBalancer(payable(balancer)).initialize{value: msg.value}(msg.sender);
        emit BalancerCreated(msg.sender, balancer, address(PoolBalancer(payable(balancer)).pool()), salt);
    }

    function predictBalancer(address creator, bytes32 salt) external view returns (address) {
        return LibClone.predictDeterministicAddress(implementation, _salt(creator, salt), address(this));
    }

    function balancerCount() external view returns (uint256) {
        return allBalancers.length;
    }

    function _salt(address creator, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }
}
