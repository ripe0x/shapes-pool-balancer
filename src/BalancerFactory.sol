// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LibClone} from "solady/utils/LibClone.sol";
import {PoolBalancer} from "./PoolBalancer.sol";
import {KeeperPolicyCalls} from "./KeeperPolicyCalls.sol";

/// @title BalancerFactory
/// @notice Deploys immutable pool clones. Keeper eligibility and keeper economics have separate authorities.
///         The policy admin may change the implementation new clones copy; existing clones never change.
///         The policy admin's economics and product-limit changes take effect immediately, in constant work: every pool
///         that follows the factory reads `economics()` at its next operation (pools with local economics keep
///         theirs), and product limits apply to designs submitted after the change.
contract BalancerFactory {
    /// @notice The code new Balancers clone. Changing it affects only pools created afterwards: each clone is a
    ///         fixed EIP-1167 proxy of the implementation it was created with. It is part of `creationSettingsHash`,
    ///         so a creation reviewed against another implementation is refused.
    /// @dev Trust: the policy admin chooses the code future pools run. A replacement must keep `initialize`,
    ///      `SHAPES()` and `pool()`, which this factory calls.
    address public implementation;

    mapping(address balancer => bool) public isBalancer;

    address public keeperAdmin;
    address public pendingKeeperAdmin;
    /// @dev When true, only approved keepers (and each pool's creator) may run upkeep on this factory's Balancers.
    bool public keepersRestricted;
    mapping(address keeper => bool) public approvedKeeper;
    address public policyAdmin;
    address public pendingPolicyAdmin;
    /// @dev The one factory keeper economic configuration (see `KeeperPolicyCalls.Economics`).
    KeeperPolicyCalls.Economics internal _economics;
    /// @dev Spending bucket a new pool starts with. Its creator controls it afterwards; later changes here never touch it.
    uint128 public defaultBucketCapacity;
    uint96 public defaultBucketRefill;

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
    event EconomicsChanged(KeeperPolicyCalls.Economics economics);
    event DefaultBucketChanged(uint256 capacity, uint256 refillPerSecond);
    event PolicyAdminTransferStarted(address indexed admin, address indexed pendingAdmin);
    event PolicyAdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event ProductLimitsChanged(uint16 maxPrizes, uint16 minMarkupBps, uint16 maxMarkupBps);
    event ImplementationChanged(address indexed previousImplementation, address indexed newImplementation);

    error Unauthorized();
    error InvalidLimits();
    error StaleSettings();
    error InvalidImplementation();

    modifier onlyKeeperAdmin() {
        if (msg.sender != keeperAdmin) revert Unauthorized();
        _;
    }

    /// @dev Initial economics are the V1 schedule with two measured
    ///      recalibrations: work fee 0.00002 ETH, 3.2M reimbursable gas, OVERHEAD_GAS (V1: 50k), 5 gwei ceiling,
    ///      0.05 gwei priority allowance, RESTOCK_GAS (V1: 900k) plus 0.0002 ETH restocking per Shape, and the
    ///      per-operation gas bounds, and a processing grace of 50 blocks (about 10 minutes), 10 while purchases are
    ///      paused. Derived maxima: 0.0165 ETH per payment (V1: 0.01645), 0.00475 ETH restocking per
    ///      Shape (V1: 0.0047). Bucket: 0.622 ETH, refilling floor(0.05 ETH / 12) per
    ///      second.
    constructor(address implementation_, address keeperAdmin_, address policyAdmin_) {
        if (keeperAdmin_ == address(0) || policyAdmin_ == address(0)) revert Unauthorized();
        implementation = implementation_;
        emit ImplementationChanged(address(0), implementation_);
        keeperAdmin = keeperAdmin_;
        policyAdmin = policyAdmin_;
        emit KeeperAdminTransferred(address(0), keeperAdmin_);
        emit PolicyAdminTransferred(address(0), policyAdmin_);
        _setEconomics(KeeperPolicyCalls.Economics(0.00002 ether, 3_200_000, OVERHEAD_GAS, 5 gwei, 0.05 gwei,
            RESTOCK_GAS, 0.0002 ether, 200_000, 1_800_000, 150_000, 700_000, 150_000, 50, 10));
        _setDefaultBucket(0.622 ether, uint96(uint256(0.05 ether) / 12));
        _setProductLimits(1_000, 1_000, 10_000);
    }

    /// @dev Initial gas outside a paid call's measured span: intrinsic gas, the reward calculation, bucket update, ETH
    ///      transfer and event. Recalibrated from V1's 50k while the reward still called an external policy: isolated
    ///      receipts at 5 gwei measured up to 56,724 billed-minus-measured gas (closed, reconcile five) and 54,651
    ///      (reconcile one processed draw); 60k kept a 5.8% margin. The in-library formula (R95) removed that call, so
    ///      the margin is larger (test/KeeperPay.t.sol test_overheadCoversBilledGasPerOperationClass, docs/GAS.md).
    uint32 internal constant OVERHEAD_GAS = 60_000;
    /// @dev Initial restocking gas per Shape, recalibrated from V1's 900k with the overhead: at the 5 gwei ceiling the
    ///      surcharge on a replacement must cover the keeper pay for the call that lists it. The measured single-Shape
    ///      reconcile-and-replace call pays (874,586 + 60,000) gas plus two work fees, which needs at least 902,586;
    ///      910k keeps V1's 7,414-gas margin (test/Hardening.t.sol test_gasJumpRestockPaidByTheNewListingsFee).
    uint32 internal constant RESTOCK_GAS = 910_000;

    /// @notice The economics every following pool uses now.
    function economics() external view returns (KeeperPolicyCalls.Economics memory) { return _economics; }

    /// @notice Replace the whole economic configuration. Immediate, constant work: followers adopt it at their next
    ///         operation and no follower balance is inspected. Pools with local economics are unaffected.
    /// @dev Every number is valid at its field width (see `KeeperPolicyCalls.Economics`); only the grace order is checked.
    function setEconomics(KeeperPolicyCalls.Economics calldata e) external {
        if (msg.sender != policyAdmin) revert Unauthorized();
        _setEconomics(e);
    }

    function _setEconomics(KeeperPolicyCalls.Economics memory e) internal {
        KeeperPolicyCalls.validate(e);
        _economics = e;
        emit EconomicsChanged(e);
    }

    /// @notice Spending bucket for pools created after this call. Existing pools keep their own.
    function setDefaultBucket(uint128 capacity, uint96 refillPerSecond) external {
        if (msg.sender != policyAdmin) revert Unauthorized();
        _setDefaultBucket(capacity, refillPerSecond);
    }

    function _setDefaultBucket(uint128 capacity, uint96 refillPerSecond) internal {
        defaultBucketCapacity = capacity;
        defaultBucketRefill = refillPerSecond;
        emit DefaultBucketChanged(capacity, refillPerSecond);
    }

    /// @notice What a pool created now starts with: the pool's own `settingsHash` (these economics followed, paid upkeep
    ///         on, the live Shapes mint fee) bound to the default spending bucket it copies and the implementation it
    ///         clones. `createBalancer` requires it in `CreationConfig.settingsHash`, so any of these changing after the
    ///         creator's review refuses creation.
    /// @dev    keccak256(abi.encode(poolSettingsHash, defaultBucketCapacity, defaultBucketRefill, implementation)). The
    ///         pool's own `settingsHash` leaves the bucket out: it is the creator's spending limit, not economics a keeper
    ///         prices.
    function creationSettingsHash() public view returns (bytes32) {
        return keccak256(abi.encode(KeeperPolicyCalls.settingsHash(_economics, KeeperPolicyCalls.FOLLOW, 0, true,
            PoolBalancer(payable(implementation)).SHAPES().mintFee()), defaultBucketCapacity, defaultBucketRefill,
            implementation));
    }

    /// @notice Clone `next` for pools created after this call. Existing pools keep their code. Immediate; a creation
    ///         reviewed against the previous implementation is refused (`StaleSettings`), and the predicted address of a
    ///         creator's next pool changes with it.
    function setImplementation(address next) external {
        if (msg.sender != policyAdmin) revert Unauthorized();
        if (next.code.length == 0) revert InvalidImplementation();
        emit ImplementationChanged(implementation, next);
        implementation = next;
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
        if (config.settingsHash != creationSettingsHash()) revert StaleSettings();
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
