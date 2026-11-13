// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LibClone} from "solady/utils/LibClone.sol";
import {PoolBalancer} from "./PoolBalancer.sol";

/// @title BalancerFactory
/// @notice Deploys one PoolBalancer minimal-proxy clone per creator call, and keeps the keeper list every Balancer it
///         deployed reads. The keeper admin's only power is that list: whether upkeep is open to anyone (the default)
///         or restricted to approved keepers. It has no authority over Balancers' settings, FWA pools or assets, and a
///         pool's creator can always run its upkeep.
contract BalancerFactory {
    address public immutable implementation;

    address[] public allBalancers;
    mapping(address balancer => bool) public isBalancer;

    address public keeperAdmin;
    address public pendingKeeperAdmin;
    /// @dev When true, only approved keepers (and each pool's creator) may run upkeep on this factory's Balancers.
    bool public keepersRestricted;
    mapping(address keeper => bool) public approvedKeeper;

    event BalancerCreated(address indexed creator, address indexed balancer, address indexed pool, bytes32 salt);
    event KeeperAdminTransferStarted(address indexed keeperAdmin, address indexed pendingKeeperAdmin);
    event KeeperAdminTransferred(address indexed oldKeeperAdmin, address indexed newKeeperAdmin);
    event KeepersRestricted(bool restricted);
    event KeeperApproved(address indexed keeper, bool approved);

    error Unauthorized();

    modifier onlyKeeperAdmin() {
        if (msg.sender != keeperAdmin) revert Unauthorized();
        _;
    }

    constructor(address implementation_, address keeperAdmin_) {
        if (keeperAdmin_ == address(0)) revert Unauthorized();
        implementation = implementation_;
        keeperAdmin = keeperAdmin_;
        emit KeeperAdminTransferred(address(0), keeperAdmin_);
    }

    /// @notice Whether `keeper` may run upkeep on this factory's Balancers (each Balancer also always admits its
    ///         creator).
    function canKeep(address keeper) external view returns (bool) {
        return !keepersRestricted || approvedKeeper[keeper];
    }

    /// @notice Restrict upkeep to approved keepers, or open it to anyone (the default).
    /// @dev Restricting trades liveness for control: if every approved keeper stops, a pool is restocked only when its
    ///      creator runs upkeep. Rewards follow the same rules either way.
    function setKeepersRestricted(bool restricted) external onlyKeeperAdmin {
        keepersRestricted = restricted;
        emit KeepersRestricted(restricted);
    }

    function setKeeperApproved(address keeper, bool approved) external onlyKeeperAdmin {
        approvedKeeper[keeper] = approved;
        emit KeeperApproved(keeper, approved);
    }

    function transferKeeperAdmin(address next) external onlyKeeperAdmin {
        pendingKeeperAdmin = next;
        emit KeeperAdminTransferStarted(keeperAdmin, next);
    }

    function acceptKeeperAdmin() external {
        if (msg.sender != pendingKeeperAdmin || msg.sender == address(0)) revert Unauthorized();
        emit KeeperAdminTransferred(keeperAdmin, msg.sender);
        keeperAdmin = msg.sender;
        pendingKeeperAdmin = address(0);
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
