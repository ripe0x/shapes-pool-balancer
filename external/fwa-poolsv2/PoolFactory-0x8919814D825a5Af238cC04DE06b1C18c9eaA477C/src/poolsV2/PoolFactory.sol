// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "solady/src/auth/Ownable.sol";
import {ReentrancyGuard} from "solady/src/utils/ReentrancyGuard.sol";
import {LibClone} from "solady/src/utils/LibClone.sol";

import {IVRFCoordinatorV2Plus} from "@chainlink/contracts/src/v0.8/vrf/interfaces/IVRFCoordinatorV2Plus.sol";
import {IVRFV2PlusMigrate} from "@chainlink/contracts/src/v0.8/vrf/interfaces/IVRFV2PlusMigrate.sol";

import {IFWACloneFactory, IFWACloneVRFServiceAdmin} from "../userowned/interfaces/IFWACloneFactory.sol";

/// @dev Infrastructure identities are pinned during one-time wiring.
interface IPoolsV2Infrastructure {
    function factory() external view returns (address);
    function fwaToken() external view returns (address);
    function feeRouter() external view returns (address);
}

interface IPoolsV2OwnedPool {
    function owner() external view returns (address);
    function retired() external view returns (bool);
}

interface IPoolsV2LaunchedToken {
    function owner() external view returns (address);
    function launched() external view returns (bool);
    function quoteToken() external view returns (address);
    function isLocalDistributor(address account) external view returns (bool);
}

/// @dev Immutable and initialization surface required for each standard pool implementation.
interface IPoolsV2Implementation {
    function FACTORY() external view returns (address);
    function vrfService() external view returns (address);
    function IMPLEMENTATION_KIND() external view returns (uint8);
    function initialize(address poolOwner) external;
}

/// @dev Fail-closed migration reads exposed by the official Chainlink VRF v2.5 coordinator.
interface IPoolsV2VRFCoordinatorConfig {
    function s_provingKeys(bytes32 keyHash) external view returns (bool exists, uint64 maxGasPriceWei);

    function s_config()
        external
        view
        returns (
            uint16 minimumRequestConfirmations,
            uint32 maxGasLimit,
            bool reentrancyLock,
            uint32 stalenessSeconds,
            uint32 gasAfterPaymentCalculation,
            uint32 fulfillmentFlatFeeNativePPM,
            uint32 fulfillmentFlatFeeLinkDiscountPPM,
            uint8 nativePremiumPercentage,
            uint8 linkPremiumPercentage
        );
}

/// @title PoolFactory
/// @notice Deploys free deterministic standard pools and owns their one
///         shared Chainlink VRF v2.5 subscription. The subscription has exactly one consumer: the
///         immutable router/service.
/// @dev Global request-side controls never gate callbacks, stored-word delivery, canonical processing,
///      settlement, refunds, NFT claims, or withdrawals. This contract deliberately exposes neither a
///      generic external-call executor nor a direct wrapper around the service's coordinator setter.
contract PoolFactory is Ownable, ReentrancyGuard {
    enum PoolKind {
        Unknown,
        Standard
    }

    uint16 public constant BPS = 10_000;
    uint32 public constant MIN_POOL_CALLBACK_GAS_LIMIT = 1_200_000;
    uint32 public constant MAX_CALLBACK_GAS_LIMIT = 2_500_000;
    uint256 public constant VRF_MAX_VERIFICATION_GAS_ESTIMATE = 200_000;

    uint256 public constant INITIAL_MAX_OUTSTANDING_PER_POOL = 10;
    uint256 public constant INITIAL_MAX_OUTSTANDING_GLOBAL = 100;

    uint16 public constant maxActivationsPerAcquisition = 6;
    uint16 public constant maxAcquisitionsPerTx = 5;
    uint16 public constant selectionSlippageBps = 1_000;
    uint256 public constant maxStagedListings = 0;

    /// @notice The real authenticated Chainlink coordinator. It changes only after that coordinator's
    ///         official registered migration flow has successfully moved the singleton subscription.
    address public chainlinkCoordinator;
    address public immutable fwaToken;
    uint256 public immutable vrfSubscriptionId;
    bytes32 public vrfKeyHash;
    uint32 public immutable callbackGasLimit;
    uint32 public immutable routerCallbackGasLimit;
    uint16 public immutable requestConfirmations;
    uint32 public immutable selectionTimeoutBlocks;

    address public implementation;
    address public vrfService;
    address public protocolFeeRecipient;

    uint16 public constant edgeBps = 500;
    uint256 public constant poolCreationFee = 0;
    address public tokenLauncher;
    /// @notice Shared-interface compatibility; purchases bind the inventory version without a delay.
    uint32 public constant inventoryChangeCooldown = 0;
    bool public globalPurchasesEnabled;
    bool public globalWithdrawOnly;
    bool public poolCreationEnabled;
    bool public vrfSubscriptionActive;
    bool public vrfSubscriptionTerminated;
    bool public vrfRequestsPaused = true;
    address payable public vrfRecoveryRecipient;
    uint32 public maxPoolsPerWallet = 1;
    uint256 public maxOutstandingRequestsPerPool = INITIAL_MAX_OUTSTANDING_PER_POOL;
    uint256 public maxOutstandingRequestsGlobal = INITIAL_MAX_OUTSTANDING_GLOBAL;

    /// @notice Each pool can launch exactly one token through the pinned launcher.
    mapping(address pool => address token) public poolToken;

    address[] public allPools;
    mapping(address pool => bool registered) public isPool;
    mapping(address pool => bool ready) public consumerReady;
    mapping(address pool => PoolKind kind) public poolKind;
    /// @notice Implementation embedded permanently in each pool's immutable clone bytecode.
    mapping(address pool => address implementationAddress) public poolImplementation;
    mapping(address poolOwner => address[] pools) internal ownerPools;

    event InfrastructureSet(address indexed implementation, address indexed vrfService, address indexed feeRecipient);
    event ImplementationUpdated(
        PoolKind indexed kind, address indexed oldImplementation, address indexed newImplementation
    );
    event PoolImplementationRegistered(address indexed pool, address indexed implementation);
    event PoolCreated(address indexed poolOwner, address indexed pool, uint256 indexed subId, bytes32 userSalt);
    event PoolKindRegistered(address indexed poolOwner, address indexed pool, PoolKind indexed kind, bytes32 userSalt);
    event VrfSubscriptionActivated(
        uint256 indexed subId, address indexed coordinator, address indexed consumer, uint96 nativeBalance
    );
    event VrfRecoveryRecipientSet(address indexed oldRecipient, address indexed newRecipient);
    event VrfSubscriptionTerminated(
        uint256 indexed subId,
        address indexed coordinator,
        address indexed recoveryRecipient,
        uint96 linkRefund,
        uint96 nativeRefund,
        uint256 serviceEthRefund
    );
    event VrfCoordinatorMigrated(
        uint256 indexed subId,
        address indexed oldCoordinator,
        address indexed newCoordinator,
        bytes32 oldKeyHash,
        bytes32 newKeyHash
    );
    event VrfRequestsPausedSet(bool paused);
    event VrfRequestLimitsSet(uint256 perPoolLimit, uint256 globalLimit);
    event GlobalPurchasesEnabledSet(bool enabled);
    event GlobalWithdrawOnlySet(bool enabled);
    event PoolCreationEnabledSet(bool enabled);
    event TokenLauncherSet(address indexed launcher);
    event PoolTokenRegistered(address indexed pool, address indexed token);
    event MaxPoolsPerWalletSet(uint32 oldLimit, uint32 newLimit);
    event ProtocolFeeRecipientSet(address indexed oldRecipient, address indexed newRecipient);

    error ZeroAddress();
    error InvalidConfig();
    error InfrastructureAlreadySet();
    error PoolCreationMustBeDisabled();
    error UnexpectedImplementation(address expected, address actual);
    error InfrastructureNotSet();
    error SubscriptionAlreadyActive();
    error SubscriptionNotActive();
    error SubscriptionNotOwned();
    error SubscriptionNotPristine();
    error SubscriptionNotFunded();
    error SoleConsumerInvariant();
    error PoolCreationDisabled();
    error PoolCreationLimitReached(address wallet, uint256 created, uint256 allowed);
    error MigrationNotReady();
    error VrfRequestsPending();
    error VrfShutdownNotReady();
    error VrfAlreadyTerminated();
    error TokenLauncherAlreadySet();
    error OnlyTokenLauncher();
    error InvalidPoolToken();

    constructor(
        address owner_,
        address coordinator_,
        uint256 subscriptionId_,
        bytes32 keyHash_,
        uint32 callbackGasLimit_,
        uint32 routerCallbackGasLimit_,
        uint16 requestConfirmations_,
        uint32 selectionTimeoutBlocks_,
        address fwaToken_
    ) {
        if (
            owner_ == address(0) || coordinator_ == address(0) || coordinator_.code.length == 0
                || fwaToken_ == address(0) || fwaToken_.code.length == 0
        ) {
            revert ZeroAddress();
        }
        if (
            subscriptionId_ == 0 || keyHash_ == bytes32(0) || callbackGasLimit_ < MIN_POOL_CALLBACK_GAS_LIMIT
                || callbackGasLimit_ > MAX_CALLBACK_GAS_LIMIT || routerCallbackGasLimit_ <= callbackGasLimit_
                || routerCallbackGasLimit_ > MAX_CALLBACK_GAS_LIMIT || requestConfirmations_ < 3
                || requestConfirmations_ > 200 || selectionTimeoutBlocks_ < uint256(requestConfirmations_) + 2
                || selectionTimeoutBlocks_ > 7_200
        ) revert InvalidConfig();

        _initializeOwner(owner_);
        chainlinkCoordinator = coordinator_;
        fwaToken = fwaToken_;
        vrfSubscriptionId = subscriptionId_;
        vrfKeyHash = keyHash_;
        callbackGasLimit = callbackGasLimit_;
        routerCallbackGasLimit = routerCallbackGasLimit_;
        requestConfirmations = requestConfirmations_;
        selectionTimeoutBlocks = selectionTimeoutBlocks_;

        emit GlobalPurchasesEnabledSet(false);
        emit GlobalWithdrawOnlySet(false);
        emit PoolCreationEnabledSet(false);
        emit MaxPoolsPerWalletSet(0, maxPoolsPerWallet);
        emit VrfRequestsPausedSet(true);
        emit VrfRequestLimitsSet(INITIAL_MAX_OUTSTANDING_PER_POOL, INITIAL_MAX_OUTSTANDING_GLOBAL);
    }

    /// @notice Logical coordinator seen by every clone. Before the one-time infrastructure wiring it is
    ///         zero; afterward it is permanently the singleton service/router, including across official
    ///         migrations of the underlying Chainlink coordinator.
    function vrfCoordinator() external view returns (address) {
        return vrfService;
    }

    /// @notice Read the complete clone initialization configuration in one call.
    function getPoolInitializationConfig()
        external
        view
        returns (IFWACloneFactory.PoolInitializationConfig memory config)
    {
        config = IFWACloneFactory.PoolInitializationConfig({
            coordinator: vrfService,
            subId: vrfSubscriptionId,
            keyHash: vrfKeyHash,
            gasLimit: callbackGasLimit,
            confirmations: requestConfirmations,
            timeoutBlocks: selectionTimeoutBlocks,
            activationLimit: maxActivationsPerAcquisition,
            acquisitionLimit: maxAcquisitionsPerTx,
            slippageBps: selectionSlippageBps,
            maxStagedListings: maxStagedListings,
            protocolFeeRecipient: protocolFeeRecipient
        });
    }

    /// @notice One-time wiring performed after deploying the router and implementation. The initial
    ///         fee router is pinned for every existing and future pool.
    function setInfrastructure(address implementation_, address service_, address feeRecipient_) external onlyOwner {
        if (implementation != address(0) || vrfService != address(0)) revert InfrastructureAlreadySet();
        if (
            implementation_ == address(0) || implementation_.code.length == 0 || service_ == address(0)
                || service_.code.length == 0 || feeRecipient_ == address(0) || feeRecipient_.code.length == 0
        ) revert ZeroAddress();

        if (
            IPoolsV2Infrastructure(feeRecipient_).factory() != address(this)
                || IPoolsV2Infrastructure(feeRecipient_).fwaToken() != fwaToken
        ) revert InvalidConfig();

        IFWACloneVRFServiceAdmin service = IFWACloneVRFServiceAdmin(service_);
        _validateImplementation(implementation_, service_, PoolKind.Standard);
        if (
            service.factory() != address(this) || service.coordinator() != chainlinkCoordinator
                || service.subscriptionId() != vrfSubscriptionId || service.approvedVrfKeyHash() != vrfKeyHash
                || service.approvedCallbackGasLimit() != callbackGasLimit
                || service.routerCallbackGasLimit() != routerCallbackGasLimit
                || service.requestConfirmations() != requestConfirmations || service.subscriptionActive()
                || service.totalPrepared() != 0 || service.totalCoordinatorOutstanding() != 0
        ) revert InvalidConfig();

        implementation = implementation_;
        vrfService = service_;
        protocolFeeRecipient = feeRecipient_;

        // The service constructor has proposed this factory as the official consumer-base owner. Accepting
        // from this narrow contract removes the deployment EOA without exposing an arbitrary admin call path.
        if (service.owner() != address(this)) service.acceptOwnership();
        if (service.owner() != address(this)) revert InvalidConfig();

        service.setRequestLimits(maxOutstandingRequestsPerPool, maxOutstandingRequestsGlobal);
        service.setRequestsPaused(true);
        if (!service.requestsPaused()) revert InvalidConfig();

        emit InfrastructureSet(implementation_, service_, feeRecipient_);
        emit ImplementationUpdated(PoolKind.Standard, address(0), implementation_);
        emit ProtocolFeeRecipientSet(address(0), feeRecipient_);
    }

    /// @notice Select the implementation for future standard pools. Existing pools keep their embedded
    ///         implementation, registration, service, and lifetime creation allowance unchanged.
    /// @dev Disable pool creation before rotating the implementation, then explicitly re-enable it.
    function setImplementation(address implementation_) external onlyOwner {
        _requireInfrastructure();
        if (poolCreationEnabled) revert PoolCreationMustBeDisabled();
        _validateImplementation(implementation_, vrfService, PoolKind.Standard);
        address oldImplementation = implementation;
        implementation = implementation_;
        emit ImplementationUpdated(PoolKind.Standard, oldImplementation, implementation_);
    }

    function _validateImplementation(address implementation_, address service_, PoolKind kind) internal view {
        if (implementation_ == address(0) || implementation_.code.length == 0) revert ZeroAddress();
        IPoolsV2Implementation candidate = IPoolsV2Implementation(implementation_);
        try candidate.IMPLEMENTATION_KIND() returns (uint8 candidateKind) {
            if (candidateKind != uint8(kind)) revert InvalidConfig();
        } catch {
            revert InvalidConfig();
        }
        if (candidate.FACTORY() != address(this) || candidate.vrfService() != service_) revert InvalidConfig();
    }

    /*//////////////////////////////////////////////////////////////
                         SUBSCRIPTION ACTIVATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Accept the prior owner's pending transfer, then activate the pristine singleton.
    function acceptAndActivateVrfSubscription() external onlyOwner nonReentrant {
        _requireInfrastructure();
        if (vrfSubscriptionTerminated) revert VrfAlreadyTerminated();
        if (vrfSubscriptionActive) revert SubscriptionAlreadyActive();
        IVRFCoordinatorV2Plus(chainlinkCoordinator).acceptSubscriptionOwnerTransfer(vrfSubscriptionId);
        _activateVrfSubscription();
    }

    /// @notice Activate a pristine singleton that this factory already owns.
    function activateVrfSubscription() external onlyOwner nonReentrant {
        _requireInfrastructure();
        if (vrfSubscriptionTerminated) revert VrfAlreadyTerminated();
        if (vrfSubscriptionActive) revert SubscriptionAlreadyActive();
        _activateVrfSubscription();
    }

    function _activateVrfSubscription() internal {
        address coordinator_ = chainlinkCoordinator;
        uint256 subId = vrfSubscriptionId;
        address service_ = vrfService;
        IVRFCoordinatorV2Plus coordinator = IVRFCoordinatorV2Plus(coordinator_);
        IFWACloneVRFServiceAdmin service = IFWACloneVRFServiceAdmin(service_);

        (, uint96 nativeBalance, uint64 requestCount, address subOwner, address[] memory consumers) =
            coordinator.getSubscription(subId);
        if (subOwner != address(this)) revert SubscriptionNotOwned();
        if (requestCount != 0 || consumers.length != 0 || coordinator.pendingRequestExists(subId)) {
            revert SubscriptionNotPristine();
        }
        if (nativeBalance < service.minimumSubscriptionBuffer()) revert SubscriptionNotFunded();
        if (service.owner() != address(this) || service.coordinator() != coordinator_) revert InvalidConfig();

        coordinator.addConsumer(subId, service_);

        (, uint96 verifiedNativeBalance,, address verifiedOwner, address[] memory verifiedConsumers) =
            coordinator.getSubscription(subId);
        if (verifiedOwner != address(this)) revert SubscriptionNotOwned();
        if (verifiedConsumers.length != 1 || verifiedConsumers[0] != service_) revert SoleConsumerInvariant();

        service.activateSubscription();
        if (!service.subscriptionActive()) revert InvalidConfig();
        vrfSubscriptionActive = true;

        emit VrfSubscriptionActivated(subId, coordinator_, service_, verifiedNativeBalance);
    }

    /*//////////////////////////////////////////////////////////////
                           POOL DEPLOYMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Create a standard pool without a creation payment or token approval.
    function createPool(bytes32 userSalt) external nonReentrant returns (address pool) {
        pool = _createPool(implementation, userSalt);
    }

    /// @notice Bind creation to the quoted implementation if governance rotates it while queued.
    function createPool(bytes32 userSalt, address expectedImplementation) external nonReentrant returns (address pool) {
        address implementation_ = implementation;
        if (expectedImplementation != implementation_) {
            revert UnexpectedImplementation(expectedImplementation, implementation_);
        }
        pool = _createPool(implementation_, userSalt);
    }

    function _createPool(address implementation_, bytes32 userSalt) internal returns (address pool) {
        address service_ = vrfService;
        if (implementation_ == address(0) || service_ == address(0)) revert InfrastructureNotSet();
        if (vrfSubscriptionTerminated) revert VrfAlreadyTerminated();
        if (!vrfSubscriptionActive) revert SubscriptionNotActive();
        if (!poolCreationEnabled) revert PoolCreationDisabled();

        uint256 created = ownerPools[msg.sender].length;
        uint256 allowed = poolCreationLimit(msg.sender);
        if (created >= allowed) revert PoolCreationLimitReached(msg.sender, created, allowed);

        pool = LibClone.cloneDeterministic(implementation_, _poolSalt(msg.sender, userSalt));

        // Register the address before initialization so the service can prove the caller is a clone from
        // this factory. `consumerReady` is set only after every configuration check succeeds.
        isPool[pool] = true;
        poolKind[pool] = PoolKind.Standard;
        poolImplementation[pool] = implementation_;
        allPools.push(pool);
        ownerPools[msg.sender].push(pool);

        IPoolsV2Implementation(pool).initialize(msg.sender);
        IFWACloneVRFServiceAdmin(service_).registerPool(pool);
        consumerReady[pool] = true;

        emit PoolCreated(msg.sender, pool, vrfSubscriptionId, userSalt);
        emit PoolKindRegistered(msg.sender, pool, PoolKind.Standard, userSalt);
        emit PoolImplementationRegistered(pool, implementation_);
    }

    /// @notice Predict using the current standard implementation. Rotating it changes the CREATE2 address
    ///         for the same owner and salt; the wallet's lifetime pool allowance never resets.
    function predictPoolAddress(address poolOwner, bytes32 userSalt) external view returns (address predicted) {
        address implementation_ = implementation;
        if (implementation_ == address(0)) revert InfrastructureNotSet();
        predicted = LibClone.predictDeterministicAddress(implementation_, _poolSalt(poolOwner, userSalt), address(this));
    }

    function _poolSalt(address poolOwner, bytes32 userSalt) internal pure returns (bytes32) {
        return keccak256(abi.encode(poolOwner, userSalt));
    }

    function poolCount() external view returns (uint256) {
        return allPools.length;
    }

    function poolsOf(address poolOwner) external view returns (address[] memory) {
        return ownerPools[poolOwner];
    }

    /// @notice Number of pools this wallet has created over the factory's lifetime.
    function poolCountOf(address poolOwner) external view returns (uint256) {
        return ownerPools[poolOwner].length;
    }

    /// @notice Lifetime pool allowance; retiring a pool does not restore the allowance.
    function poolCreationLimit(address) public view returns (uint256) {
        return maxPoolsPerWallet;
    }

    function remainingPoolAllowance(address wallet) external view returns (uint256 remaining) {
        uint256 allowed = poolCreationLimit(wallet);
        uint256 created = ownerPools[wallet].length;
        if (allowed > created) remaining = allowed - created;
    }

    /*//////////////////////////////////////////////////////////////
                           GLOBAL GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    /// @notice Set the lifetime per-wallet pool cap.
    function setMaxPoolsPerWallet(uint32 newLimit) external onlyOwner {
        if (newLimit == 0) revert InvalidConfig();
        uint32 oldLimit = maxPoolsPerWallet;
        maxPoolsPerWallet = newLimit;
        emit MaxPoolsPerWalletSet(oldLimit, newLimit);
    }

    /// @notice Pin the atomic launcher after infrastructure setup. The router cannot later change.
    function setTokenLauncher(address launcher) external onlyOwner {
        _requireInfrastructure();
        if (tokenLauncher != address(0)) revert TokenLauncherAlreadySet();
        if (launcher == address(0) || launcher.code.length == 0) revert ZeroAddress();
        if (
            IPoolsV2Infrastructure(launcher).factory() != address(this)
                || IPoolsV2Infrastructure(launcher).feeRouter() != protocolFeeRecipient
        ) revert InvalidConfig();
        tokenLauncher = launcher;
        emit TokenLauncherSet(launcher);
    }

    /// @notice Complete a launch only after live FWA liquidity, distributor grants, and owner handoff.
    /// @dev The pinned launcher enforces the ERC20T implementation, hook, taxes and liquidity setup.
    function registerPoolToken(address pool, address token) external {
        if (msg.sender != tokenLauncher || tokenLauncher == address(0)) revert OnlyTokenLauncher();
        if (!isPool[pool] || poolToken[pool] != address(0) || token == address(0) || token.code.length == 0) {
            revert InvalidPoolToken();
        }
        IPoolsV2OwnedPool host = IPoolsV2OwnedPool(pool);
        IPoolsV2LaunchedToken launchedToken = IPoolsV2LaunchedToken(token);
        if (
            host.retired() || !launchedToken.launched() || launchedToken.quoteToken() != fwaToken
                || !launchedToken.isLocalDistributor(pool) || !launchedToken.isLocalDistributor(protocolFeeRecipient)
                || launchedToken.owner() != host.owner()
        ) revert InvalidPoolToken();
        poolToken[pool] = token;
        emit PoolTokenRegistered(pool, token);
    }

    function setGlobalPurchasesEnabled(bool enabled) external onlyOwner {
        if (enabled && vrfSubscriptionTerminated) revert VrfAlreadyTerminated();
        globalPurchasesEnabled = enabled;
        emit GlobalPurchasesEnabledSet(enabled);
    }

    function setGlobalWithdrawOnly(bool enabled) external onlyOwner {
        globalWithdrawOnly = enabled;
        emit GlobalWithdrawOnlySet(enabled);
    }

    /// @notice Enable or disable public clone creation. Creation always costs zero FWA.
    function setPoolCreationEnabled(bool enabled) external onlyOwner {
        if (enabled && vrfSubscriptionTerminated) revert VrfAlreadyTerminated();
        poolCreationEnabled = enabled;
        emit PoolCreationEnabledSet(enabled);
    }

    /// @notice Pause only new singleton requests. Existing callbacks and every downstream liveness path
    ///         remain callable. Unpausing requires an activated, still-valid singleton.
    function setVrfRequestsPaused(bool paused) external onlyOwner {
        _requireInfrastructure();
        if (!paused && vrfSubscriptionTerminated) revert VrfAlreadyTerminated();
        if (!paused && !vrfSubscriptionActive) revert SubscriptionNotActive();
        IFWACloneVRFServiceAdmin(vrfService).setRequestsPaused(paused);
        vrfRequestsPaused = paused;
        emit VrfRequestsPausedSet(paused);
    }

    /// @notice Configure prepared-plus-coordinator-outstanding launch caps. Zero removes that cap.
    ///         Lowering a cap never affects an existing request or callback.
    function setVrfRequestLimits(uint256 perPoolLimit, uint256 globalLimit) external onlyOwner {
        _requireInfrastructure();
        IFWACloneVRFServiceAdmin(vrfService).setRequestLimits(perPoolLimit, globalLimit);
        maxOutstandingRequestsPerPool = perPoolLimit;
        maxOutstandingRequestsGlobal = globalLimit;
        emit VrfRequestLimitsSet(perPoolLimit, globalLimit);
    }

    function setVrfFeeConfig(uint256 gasEstimate, uint256 marginBps, uint256 flatWei) external onlyOwner {
        _requireInfrastructure();
        IFWACloneVRFServiceAdmin(vrfService).setFeeConfig(gasEstimate, marginBps, flatWei);
    }

    function setVrfCoverageConfig(uint256 minimumBuffer, uint256 maxFulfillmentCost) external onlyOwner {
        _requireInfrastructure();
        IFWACloneVRFServiceAdmin(vrfService).setCoverageConfig(minimumBuffer, maxFulfillmentCost);
    }

    /// @notice Approve or remove an operator from the singleton's callback-safe reimbursed processor.
    ///         Direct processing on every clone remains permissionless regardless of this setting.
    function setVrfProcessorOperator(address operator, bool allowed) external onlyOwner {
        _requireInfrastructure();
        IFWACloneVRFServiceAdmin(vrfService).setOperator(operator, allowed);
    }

    /// @notice Configure global reimbursement bounds shared by sponsored processing across all clones.
    function setVrfReimbursementConfig(
        uint256 sponsoredCount,
        uint256 reimbursementGas,
        uint256 gasOverhead,
        uint256 maxBaseFeeWei,
        uint256 maxPriorityFeeWei,
        uint256 reimbursementWei
    ) external onlyOwner {
        _requireInfrastructure();
        IFWACloneVRFServiceAdmin(vrfService)
            .setReimbursementConfig(
                sponsoredCount, reimbursementGas, gasOverhead, maxBaseFeeWei, maxPriorityFeeWei, reimbursementWei
            );
    }

    /// @notice Push only mathematically proven service surplus to the current protocol fee recipient.
    function payoutVrfSurplus(uint256 amount) external onlyOwner {
        _requireInfrastructure();
        IFWACloneVRFServiceAdmin(vrfService).withdrawSurplus(protocolFeeRecipient, amount);
    }

    /*//////////////////////////////////////////////////////////////
                         TERMINAL VRF SHUTDOWN
    //////////////////////////////////////////////////////////////*/

    /// @notice Configure the only address that can receive the service treasury and coordinator LINK/native
    ///         refunds during irreversible shutdown. Governance may update it until shutdown begins.
    function setVrfRecoveryRecipient(address payable newRecipient) external onlyOwner {
        if (vrfSubscriptionTerminated) revert VrfAlreadyTerminated();
        if (newRecipient == address(0)) revert ZeroAddress();
        if (
            newRecipient == address(this) || newRecipient == chainlinkCoordinator
                || (vrfService != address(0) && newRecipient == vrfService)
        ) revert InvalidConfig();
        address oldRecipient = vrfRecoveryRecipient;
        vrfRecoveryRecipient = newRecipient;
        emit VrfRecoveryRecipientSet(oldRecipient, newRecipient);
    }

    /// @notice Irreversibly stop all new VRF activity, recover the complete service treasury, and cancel
    ///         the factory-owned singleton directly with Chainlink. Existing stored-word delivery and all
    ///         clone-local processing, settlement, refunds, claims, and withdrawals remain independent.
    /// @dev Every balance and subscription invariant is read before cancellation. The service refund occurs
    ///      first in this same call; a rejected native refund from either transfer reverts the entire state
    ///      transition, including the service transfer and both terminal flags.
    function terminateVrfSubscription() external onlyOwner nonReentrant {
        _requireInfrastructure();
        if (vrfSubscriptionTerminated) revert VrfAlreadyTerminated();
        if (!vrfSubscriptionActive) revert SubscriptionNotActive();

        address payable recoveryRecipient = vrfRecoveryRecipient;
        address coordinator_ = chainlinkCoordinator;
        address service_ = vrfService;
        if (
            recoveryRecipient == address(0) || recoveryRecipient == address(this) || recoveryRecipient == coordinator_
                || recoveryRecipient == service_ || globalPurchasesEnabled || poolCreationEnabled || !vrfRequestsPaused
        ) revert VrfShutdownNotReady();

        IFWACloneVRFServiceAdmin service = IFWACloneVRFServiceAdmin(service_);
        if (
            !service.subscriptionActive() || service.subscriptionTerminated() || !service.requestsPaused()
                || service.totalPrepared() != 0 || service.totalCoordinatorOutstanding() != 0
                || service.owner() != address(this) || service.coordinator() != coordinator_
        ) revert VrfShutdownNotReady();

        IVRFCoordinatorV2Plus coordinator = IVRFCoordinatorV2Plus(coordinator_);
        uint256 subId = vrfSubscriptionId;
        if (coordinator.pendingRequestExists(subId)) revert VrfRequestsPending();

        (uint96 linkRefund, uint96 nativeRefund,, address subOwner, address[] memory consumers) =
            coordinator.getSubscription(subId);
        if (subOwner != address(this)) revert SubscriptionNotOwned();
        if (consumers.length != 1 || consumers[0] != service_) revert SoleConsumerInvariant();

        // Publish the irreversible intent before either recipient callback. Every outbound factory and
        // service path checks this terminal state. A later revert rolls it back with both refunds.
        vrfSubscriptionTerminated = true;
        uint256 serviceEthRefund = service.terminateSubscription(recoveryRecipient);
        if (service.subscriptionActive() || !service.subscriptionTerminated()) revert VrfShutdownNotReady();

        coordinator.cancelSubscription(subId, recoveryRecipient);

        // Never query `getSubscription` after cancellation: the coordinator has deleted the record.
        vrfSubscriptionActive = false;
        emit VrfSubscriptionTerminated(
            subId, coordinator_, recoveryRecipient, linkRefund, nativeRefund, serviceEthRefund
        );
    }

    /*//////////////////////////////////////////////////////////////
                      OFFICIAL COORDINATOR MIGRATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Follow Chainlink's registered v2.5 subscription migration without changing the logical
    ///         service address seen by any child pool. The old coordinator itself authenticates and updates
    ///         the service's consumer base; governance cannot invoke that setter through this factory.
    function migrateVrfCoordinator(address newCoordinator, bytes32 newKeyHash) external onlyOwner nonReentrant {
        _requireInfrastructure();
        if (vrfSubscriptionTerminated) revert VrfAlreadyTerminated();
        if (!vrfSubscriptionActive) revert SubscriptionNotActive();
        address oldCoordinator = chainlinkCoordinator;
        if (
            newCoordinator == address(0) || newCoordinator.code.length == 0 || newCoordinator == oldCoordinator
                || newKeyHash == bytes32(0) || newKeyHash == vrfKeyHash || globalPurchasesEnabled || !vrfRequestsPaused
        ) revert MigrationNotReady();

        IFWACloneVRFServiceAdmin service = IFWACloneVRFServiceAdmin(vrfService);
        if (!service.requestsPaused()) revert MigrationNotReady();
        if (service.usedVrfKeyHash(newKeyHash)) revert MigrationNotReady();
        if (service.totalPrepared() != 0 || service.totalCoordinatorOutstanding() != 0) {
            revert VrfRequestsPending();
        }
        if (IVRFCoordinatorV2Plus(oldCoordinator).pendingRequestExists(vrfSubscriptionId)) {
            revert VrfRequestsPending();
        }

        _validateMigrationTarget(service, newCoordinator, newKeyHash);

        IVRFV2PlusMigrate(oldCoordinator).migrate(vrfSubscriptionId, newCoordinator);

        // The registered old coordinator calls `setCoordinator` on its sole consumer during migration.
        // Verify that authentication moved and that the migrated subscription retained the exact owner and
        // consumer set before this factory records the new real coordinator.
        if (service.coordinator() != newCoordinator) revert SoleConsumerInvariant();
        (,,, address subOwner, address[] memory consumers) =
            IVRFCoordinatorV2Plus(newCoordinator).getSubscription(vrfSubscriptionId);
        if (subOwner != address(this)) revert SubscriptionNotOwned();
        if (consumers.length != 1 || consumers[0] != vrfService) revert SoleConsumerInvariant();
        if (IVRFCoordinatorV2Plus(newCoordinator).pendingRequestExists(vrfSubscriptionId)) {
            revert VrfRequestsPending();
        }

        bytes32 oldKeyHash = vrfKeyHash;
        chainlinkCoordinator = newCoordinator;
        vrfKeyHash = newKeyHash;
        service.setVrfKeyHash(newKeyHash);
        if (service.approvedVrfKeyHash() != newKeyHash || !service.usedVrfKeyHash(newKeyHash)) {
            revert SoleConsumerInvariant();
        }

        emit VrfCoordinatorMigrated(vrfSubscriptionId, oldCoordinator, newCoordinator, oldKeyHash, newKeyHash);
    }

    /// @dev Chainlink accepts an unknown key hash when requesting but will never fulfill it. Validate the
    ///      destination lane and coordinator limits before the irreversible subscription move, and require
    ///      the service's coverage ceiling to underwrite the lane's configured maximum gas price.
    function _validateMigrationTarget(IFWACloneVRFServiceAdmin service, address newCoordinator, bytes32 newKeyHash)
        internal
        view
    {
        IPoolsV2VRFCoordinatorConfig target = IPoolsV2VRFCoordinatorConfig(newCoordinator);
        (bool keyExists, uint64 laneMaxGasPriceWei) = target.s_provingKeys(newKeyHash);
        if (!keyExists || laneMaxGasPriceWei == 0) revert MigrationNotReady();

        (
            uint16 coordinatorMinimumConfirmations,
            uint32 coordinatorMaxGas,,,
            uint32 gasAfterPaymentCalculation,
            uint32 flatFeeNativePPM,,
            uint8 nativePremiumPercentage,
        ) = target.s_config();
        if (requestConfirmations < coordinatorMinimumConfirmations || routerCallbackGasLimit > coordinatorMaxGas) {
            revert MigrationNotReady();
        }

        uint256 maximumGasCost = uint256(laneMaxGasPriceWei)
            * (VRF_MAX_VERIFICATION_GAS_ESTIMATE
                + uint256(routerCallbackGasLimit)
                + uint256(gasAfterPaymentCalculation));
        uint256 requiredCoverage =
            (maximumGasCost * (100 + uint256(nativePremiumPercentage)) + 99) / 100 + uint256(flatFeeNativePPM) * 1e12;
        if (service.maxFulfillmentCostWei() < requiredCoverage) revert MigrationNotReady();
    }

    function _requireInfrastructure() internal view {
        if (implementation == address(0) || vrfService == address(0)) revert InfrastructureNotSet();
    }
}
