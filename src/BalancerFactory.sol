// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LibClone} from "solady/utils/LibClone.sol";
import {PoolBalancer} from "./PoolBalancer.sol";
import {KeeperPolicyCalls} from "./KeeperPolicyCalls.sol";

/// @title BalancerFactory
/// @notice Deploys immutable pool clones. Keeper eligibility and the recommended policy have separate authorities;
///         a default-policy change only affects future clones, after a two-day publicly observable delay.
contract BalancerFactory {
    address public immutable implementation;

    mapping(address balancer => bool) public isBalancer;

    address public keeperAdmin;
    address public pendingKeeperAdmin;
    /// @dev When true, only approved keepers (and each pool's creator) may run upkeep on this factory's Balancers.
    bool public keepersRestricted;
    mapping(address keeper => bool) public approvedKeeper;
    uint256 public constant POLICY_DELAY = 2 days;
    address public policyAdmin;
    address public pendingPolicyAdmin;
    address public defaultKeeperPolicy;
    address public pendingDefaultKeeperPolicy;
    uint64 public defaultPolicyActivationTime;

    event BalancerCreated(address indexed creator, address indexed balancer, address indexed pool, bytes32 salt);
    event KeeperAdminTransferStarted(address indexed keeperAdmin, address indexed pendingKeeperAdmin);
    event KeeperAdminTransferred(address indexed oldKeeperAdmin, address indexed newKeeperAdmin);
    event KeepersRestricted(bool restricted);
    event KeeperApproved(address indexed keeper, bool approved);
    event DefaultPolicyProposed(address indexed policy, uint256 activationTime);
    event DefaultPolicyCancelled(address indexed policy);
    event DefaultPolicyChanged(address indexed previousPolicy, address indexed newPolicy);
    event PolicyAdminTransferStarted(address indexed admin, address indexed pendingAdmin);
    event PolicyAdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    error Unauthorized();
    error PolicyNotReady();

    modifier onlyKeeperAdmin() {
        if (msg.sender != keeperAdmin) revert Unauthorized();
        _;
    }

    constructor(address implementation_, address keeperAdmin_, address policyAdmin_, address policy_) {
        if (keeperAdmin_ == address(0) || policyAdmin_ == address(0)) revert Unauthorized();
        KeeperPolicyCalls.validate(policy_);
        implementation = implementation_;
        keeperAdmin = keeperAdmin_;
        policyAdmin = policyAdmin_;
        defaultKeeperPolicy = policy_;
        emit KeeperAdminTransferred(address(0), keeperAdmin_);
        emit PolicyAdminTransferred(address(0), policyAdmin_);
        emit DefaultPolicyChanged(address(0), policy_);
    }

    function proposeDefaultKeeperPolicy(address policy) external {
        if (msg.sender != policyAdmin) revert Unauthorized();
        KeeperPolicyCalls.validate(policy);
        pendingDefaultKeeperPolicy = policy;
        defaultPolicyActivationTime = uint64(block.timestamp + POLICY_DELAY);
        emit DefaultPolicyProposed(policy, defaultPolicyActivationTime);
    }

    function cancelDefaultKeeperPolicy() external {
        if (msg.sender != policyAdmin) revert Unauthorized();
        emit DefaultPolicyCancelled(pendingDefaultKeeperPolicy);
        pendingDefaultKeeperPolicy = address(0);
        defaultPolicyActivationTime = 0;
    }

    function activateDefaultKeeperPolicy() external {
        address next = pendingDefaultKeeperPolicy;
        if (next == address(0) || block.timestamp < defaultPolicyActivationTime) revert PolicyNotReady();
        KeeperPolicyCalls.validate(next);
        emit DefaultPolicyChanged(defaultKeeperPolicy, next);
        defaultKeeperPolicy = next;
        pendingDefaultKeeperPolicy = address(0);
        defaultPolicyActivationTime = 0;
    }

    function transferPolicyAdmin(address next) external {
        if (msg.sender != policyAdmin) revert Unauthorized();
        pendingPolicyAdmin = next;
        emit PolicyAdminTransferStarted(policyAdmin, next);
    }

    function acceptPolicyAdmin() external {
        if (msg.sender != pendingPolicyAdmin || msg.sender == address(0)) revert Unauthorized();
        emit PolicyAdminTransferred(policyAdmin, msg.sender);
        policyAdmin = msg.sender;
        pendingPolicyAdmin = address(0);
        // A departing authority cannot leave a queued default change for its successor.
        emit DefaultPolicyCancelled(pendingDefaultKeeperPolicy);
        pendingDefaultKeeperPolicy = address(0);
        defaultPolicyActivationTime = 0;
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
    function createBalancer(bytes32 salt, PoolBalancer.CreationConfig calldata config, PoolBalancer.CuratedInput[] calldata curated)
        external payable returns (address balancer)
    {
        balancer = LibClone.cloneDeterministic(implementation, _salt(msg.sender, salt));
        isBalancer[balancer] = true;
        PoolBalancer(payable(balancer)).initialize{value: msg.value}(msg.sender, config, curated);
        emit BalancerCreated(msg.sender, balancer, address(PoolBalancer(payable(balancer)).pool()), salt);
    }

    function predictBalancer(address creator, bytes32 salt) external view returns (address) {
        return LibClone.predictDeterministicAddress(implementation, _salt(creator, salt), address(this));
    }


    function _salt(address creator, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }
}
