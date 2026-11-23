// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LibClone} from "solady/utils/LibClone.sol";
import {PoolBalancer} from "./PoolBalancer.sol";
import {KeeperPolicyCalls} from "./KeeperPolicyCalls.sol";

/// @title BalancerFactory
/// @notice Deploys immutable pool clones. Keeper eligibility and the recommended policy have separate authorities.
///         The policy admin's default-policy and product-limit changes take effect immediately: the default policy
///         applies to future clones, and product limits apply to designs submitted after the change.
contract BalancerFactory {
    address public immutable implementation;

    mapping(address balancer => bool) public isBalancer;

    address public keeperAdmin;
    address public pendingKeeperAdmin;
    /// @dev When true, only approved keepers (and each pool's creator) may run upkeep on this factory's Balancers.
    bool public keepersRestricted;
    mapping(address keeper => bool) public approvedKeeper;
    address public policyAdmin;
    address public pendingPolicyAdmin;
    address public defaultKeeperPolicy;

    /// @dev Limits on newly submitted designs (creation and `configure`), never on upkeep, recovery or withdrawals.
    ///      `maxPrizes` counts the target's Shape and Draw Pack prizes, not curated NFTs. See `PoolInventory.validateTarget`
    ///      for how a pool already above a lowered limit may still change its design.
    struct ProductLimits {
        uint16 maxPrizes;
        uint16 minMarkupBps;
        uint16 maxMarkupBps;
    }
    ProductLimits public productLimits;

    event BalancerCreated(address indexed creator, address indexed balancer, address indexed pool, bytes32 salt);
    event KeeperAdminTransferStarted(address indexed keeperAdmin, address indexed pendingKeeperAdmin);
    event KeeperAdminTransferred(address indexed oldKeeperAdmin, address indexed newKeeperAdmin);
    event KeepersRestricted(bool restricted);
    event KeeperApproved(address indexed keeper, bool approved);
    event DefaultPolicyChanged(address indexed previousPolicy, address indexed newPolicy);
    event PolicyAdminTransferStarted(address indexed admin, address indexed pendingAdmin);
    event PolicyAdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event ProductLimitsChanged(uint16 maxPrizes, uint16 minMarkupBps, uint16 maxMarkupBps);

    error Unauthorized();
    error InvalidLimits();

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
        _setProductLimits(1_000, 1_000, 10_000);
    }

    /// @notice Change the recommended policy for pools created after this call. Immediate; existing pools keep theirs.
    function setDefaultKeeperPolicy(address policy) external {
        if (msg.sender != policyAdmin) revert Unauthorized();
        KeeperPolicyCalls.validate(policy);
        emit DefaultPolicyChanged(defaultKeeperPolicy, policy);
        defaultKeeperPolicy = policy;
    }

    /// @notice Set the limits on newly submitted designs. Immediate; existing listings keep their prices.
    /// @dev Bounds are storage widths, not product preferences: a target holds 16-bit counts and markup is a uint16.
    ///      `minMarkupBps` stays above zero because a zero markup marks an unconfigured pool.
    function setProductLimits(uint16 maxPrizes, uint16 minMarkupBps, uint16 maxMarkupBps) external {
        if (msg.sender != policyAdmin) revert Unauthorized();
        _setProductLimits(maxPrizes, minMarkupBps, maxMarkupBps);
    }

    function _setProductLimits(uint16 maxPrizes, uint16 minMarkupBps, uint16 maxMarkupBps) internal {
        if (maxPrizes == 0 || minMarkupBps == 0 || minMarkupBps > maxMarkupBps) revert InvalidLimits();
        productLimits = ProductLimits(maxPrizes, minMarkupBps, maxMarkupBps);
        emit ProductLimitsChanged(maxPrizes, minMarkupBps, maxMarkupBps);
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
