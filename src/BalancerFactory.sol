// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LibClone} from "solady/utils/LibClone.sol";
import {PoolBalancer, IBalancerFactory} from "./PoolBalancer.sol";
import {KeeperPolicyCalls} from "./KeeperPolicyCalls.sol";

/// @title BalancerFactory
/// @notice Deploys immutable pool clones. Keeper eligibility and the recommended policy have separate authorities;
///         a default-policy change takes effect immediately and only affects future clones. The policyAdmin also
///         holds the adjustable behaviour-shaping settings (see `IBalancerFactory.Settings`); each change is
///         immediate and only bounds future actions, never an already-configured pool.
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

    IBalancerFactory.Settings internal _settings;

    event BalancerCreated(address indexed creator, address indexed balancer, address indexed pool, bytes32 salt);
    event KeeperAdminTransferStarted(address indexed keeperAdmin, address indexed pendingKeeperAdmin);
    event KeeperAdminTransferred(address indexed oldKeeperAdmin, address indexed newKeeperAdmin);
    event KeepersRestricted(bool restricted);
    event KeeperApproved(address indexed keeper, bool approved);
    event DefaultPolicyChanged(address indexed previousPolicy, address indexed newPolicy);
    event PolicyAdminTransferStarted(address indexed admin, address indexed pendingAdmin);
    event PolicyAdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    /// @dev Emitted on every settings change. `key` is the field name (e.g. "maxPrizes").
    event SettingChanged(bytes32 indexed key, uint256 value);

    error Unauthorized();
    error OutOfRange();

    modifier onlyKeeperAdmin() {
        if (msg.sender != keeperAdmin) revert Unauthorized();
        _;
    }

    modifier onlyPolicyAdmin() {
        if (msg.sender != policyAdmin) revert Unauthorized();
        _;
    }

    constructor(address implementation_, address keeperAdmin_, address policyAdmin_, address policy_) {
        if (keeperAdmin_ == address(0) || policyAdmin_ == address(0)) revert Unauthorized();
        KeeperPolicyCalls.validate(policy_);
        implementation = implementation_;
        keeperAdmin = keeperAdmin_;
        policyAdmin = policyAdmin_;
        defaultKeeperPolicy = policy_;
        // Defaults equal the former constants, so new pools behave exactly as before until the admin acts.
        _settings = IBalancerFactory.Settings({
            maxPrizes: 1000,
            fillGateBps: 7000,
            minMarkupBps: 1000,
            maxMarkupBps: 10000,
            maxOps: 5,
            maxReconcile: 5,
            maxProcess: 2,
            maxRestockSizes: 4,
            curatedBatch: 20
        });
        emit KeeperAdminTransferred(address(0), keeperAdmin_);
        emit PolicyAdminTransferred(address(0), policyAdmin_);
        emit DefaultPolicyChanged(address(0), policy_);
    }

    /// @notice Change the recommended policy for pools created after this call. Immediate; existing pools keep theirs.
    function setDefaultKeeperPolicy(address policy) external onlyPolicyAdmin {
        KeeperPolicyCalls.validate(policy);
        emit DefaultPolicyChanged(defaultKeeperPolicy, policy);
        defaultKeeperPolicy = policy;
    }

    /*//////////////////////////////////////////////////////////////
                        ADJUSTABLE SETTINGS (policyAdmin)
    //////////////////////////////////////////////////////////////*/

    function getSettings() external view returns (IBalancerFactory.Settings memory) {
        return _settings;
    }

    /// @dev Fixed sanity bounds. Work-per-upkeep ceilings keep the worst upkeep within the immutable payment
    ///      envelope (KeeperPolicyCalls.MAX_GAS, 6M) and well under the block gas limit; measured in test/Gas.t.sol.
    ///      maxProcess stays <= 2 because the immutable PROCESS_STARVED_GAS bound was derived for two processed draws.
    function setMaxPrizes(uint16 v) external onlyPolicyAdmin {
        if (v < 1 || v > 1000) revert OutOfRange();
        _settings.maxPrizes = v;
        emit SettingChanged("maxPrizes", v);
    }
    function setFillGateBps(uint16 v) external onlyPolicyAdmin {
        if (v > 10000) revert OutOfRange();
        _settings.fillGateBps = v;
        emit SettingChanged("fillGateBps", v);
    }
    function setMinMarkupBps(uint16 v) external onlyPolicyAdmin {
        if (v < 1 || v > _settings.maxMarkupBps) revert OutOfRange();
        _settings.minMarkupBps = v;
        emit SettingChanged("minMarkupBps", v);
    }
    function setMaxMarkupBps(uint16 v) external onlyPolicyAdmin {
        if (v > 10000 || v < _settings.minMarkupBps) revert OutOfRange();
        _settings.maxMarkupBps = v;
        emit SettingChanged("maxMarkupBps", v);
    }
    function setMaxOps(uint8 v) external onlyPolicyAdmin {
        if (v < 1 || v > 8) revert OutOfRange();
        _settings.maxOps = v;
        emit SettingChanged("maxOps", v);
    }
    function setMaxReconcile(uint8 v) external onlyPolicyAdmin {
        if (v < 1 || v > 10) revert OutOfRange();
        _settings.maxReconcile = v;
        emit SettingChanged("maxReconcile", v);
    }
    function setMaxProcess(uint8 v) external onlyPolicyAdmin {
        if (v < 1 || v > 2) revert OutOfRange();
        _settings.maxProcess = v;
        emit SettingChanged("maxProcess", v);
    }
    function setMaxRestockSizes(uint8 v) external onlyPolicyAdmin {
        if (v < 1 || v > 8) revert OutOfRange();
        _settings.maxRestockSizes = v;
        emit SettingChanged("maxRestockSizes", v);
    }
    function setCuratedBatch(uint8 v) external onlyPolicyAdmin {
        if (v < 1 || v > 50) revert OutOfRange();
        _settings.curatedBatch = v;
        emit SettingChanged("curatedBatch", v);
    }

    function transferPolicyAdmin(address next) external onlyPolicyAdmin {
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
