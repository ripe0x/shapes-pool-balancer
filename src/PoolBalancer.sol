// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IFWAPoolFactory, IFWAPool, IShapes, IERC721Min, IENS, IReverseRegistrar} from "./interfaces/External.sol";

/// @title PoolBalancer
/// @notice Permanently owns one FWA standard pool. The creator curates NFTs and approves a Shapes
///         inventory policy; anyone may call `performUpkeep` to restore that inventory from the
///         Balancer's own ETH. Players buy on FWA directly; this contract is FWA's purchase operator.
/// @dev Invariants:
///      - Only this contract lists into the pool, and only while the pool has no unresolved
///        acquisition, so nothing is ever staged and FWA's active totals equal our tracked set.
///      - A purchase is admitted only while the last checkpoint matches FWA's issued sequence and
///        inventory version. Any FWA batch (<= MAX_BATCH draws) advances the sequence and closes
///        admission until upkeep reconciles, restores inventory and re-checkpoints.
///      - A checkpoint requires the Shapes inventory to equal an approved plan exactly (verified
///        against FWA totals), the plan to satisfy the creator's price/odds/capital limits, and liquid
///        ETH to cover the worst MAX_BATCH Shape replacements plus one maximum keeper reward.
///      - No function sends ETH or NFTs to an address chosen by anyone but the creator, except the
///        bounded keeper reward to `msg.sender` of `performUpkeep`.
contract PoolBalancer is ReentrancyGuard {
    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 internal constant BPS = 10_000;
    /// @dev FWA `maxAcquisitionsPerTx`; verified against the FWA factory at pool creation.
    uint256 public constant MAX_BATCH = 5;
    uint256 internal constant DENOMS = 9;
    uint256 internal constant MAX_PLANS = 4;
    uint256 internal constant MAX_SHAPES_PER_PLAN = 40;
    /// @dev Bounds every loop over listings (repricing, plan withdrawal, unwind).
    uint256 internal constant MAX_LISTINGS = 100;
    /// @dev Inventory operations (mint+list, withdraw, reprice) per upkeep; FWA batch limit is 20.
    uint256 internal constant MAX_OPS = 6;
    uint256 internal constant MAX_MARKUP_BPS = 10_000;
    uint256 internal constant INVERSE_WEIGHT_NUMERATOR = 1e36; // FWA StandardPool constant

    // Keeper compensation bounds, chosen from mainnet-fork gas measurements (see docs/GAS.md).
    uint256 internal constant KEEPER_GAS_OVERHEAD = 45_000; // intrinsic, calldata, guard and payout outside the measured span
    uint256 internal constant KEEPER_MAX_GAS = 3_200_000;
    uint256 internal constant KEEPER_PRIORITY_CAP = 2 gwei;
    uint256 internal constant KEEPER_MAX_GAS_PRICE = 10 gwei;
    uint256 internal constant KEEPER_INCENTIVE = 0.0005 ether;
    uint256 public constant MAX_KEEPER_REWARD = KEEPER_MAX_GAS * KEEPER_MAX_GAS_PRICE + KEEPER_INCENTIVE;

    uint256 internal constant ACQUISITIONS_ENABLED_KEY = 41; // FWAConfigKeys.ACQUISITIONS_ENABLED
    bytes32 internal constant ADDR_REVERSE_NODE = 0x91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2;

    // FWA ListingStatus / AcquisitionStatus values.
    uint8 internal constant L_SETTLED = 4;
    uint8 internal constant L_DELIVERY_REFUNDED = 7;
    uint8 internal constant A_FULFILLED = 2;

    // Item kinds and states.
    uint8 internal constant CURATED = 1;
    uint8 internal constant SHAPE = 2;
    uint8 internal constant ACTIVE = 1;
    uint8 internal constant PENDING = 2; // drawn, FWA delivery not yet completed

    // Admission status codes returned by `admissionStatus`. Zero means purchases are admitted.
    uint8 internal constant OK = 0;
    uint8 internal constant CLOSED = 1;
    uint8 internal constant NEEDS_UPKEEP = 2;
    uint8 internal constant UNSETTLED = 3;
    uint8 internal constant NO_CURATED = 4;
    uint8 internal constant INFEASIBLE = 5;
    uint8 internal constant INSUFFICIENT_RESERVE = 6;
    uint8 internal constant MINT_FEE_ROSE = 7;
    uint8 internal constant PRICE_ABOVE_MAX = 8;
    uint8 internal constant TOKEN_OFFER_ACTIVE = 9;
    uint8 internal constant REPRICING = 10;
    uint8 internal constant FWA_UNAVAILABLE = 11;
    uint8 internal constant INVENTORY_MISMATCH = 12;
    uint8 internal constant NOT_CONFIGURED = 13;

    /*//////////////////////////////////////////////////////////////
                               IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    IFWAPoolFactory public immutable FWA_FACTORY;
    address public immutable FWA_IMPLEMENTATION;
    bytes32 public immutable FWA_IMPLEMENTATION_CODEHASH;
    IShapes public immutable SHAPES;
    IENS public immutable ENS;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    struct Config {
        uint128 maxDrawPrice; // FWA acquisitionFee ceiling (includes FWA edge, excludes VRF fee)
        uint128 maxShapeCapital; // max Shapes backing in any approved plan
        uint16 minCuratedOddsBps; // min combined curated probability
        uint16 markupBps; // fixed operating markup applied to every listing price
    }

    struct Item {
        uint8 kind;
        uint8 denom;
        uint8 state;
        uint112 base; // creator value (curated) or Shape backing
        uint112 price; // price currently listed on FWA
    }

    struct Checkpoint {
        bool valid;
        uint64 sequence;
        uint128 mintFee;
        uint256 inventoryVersion;
        uint256 reserve;
    }

    address public creator;
    address public pendingCreator;
    IFWAPool public pool;

    Config public config;
    /// @dev Each plan packs nine 16-bit Shape counts, denomination index 0 in the low bits.
    uint256[] internal plans;
    uint8 public activePlan;
    bool public enabled;
    bool public repricing;
    uint8 public lastStatus = NOT_CONFIGURED;
    uint256 internal repriceCursor;

    Checkpoint public checkpoint;
    uint64 public reconciledSequence;

    mapping(uint256 listingId => Item) public items;
    uint256[] internal activeIds;
    mapping(uint256 listingId => uint256) internal activeIndexPlusOne;
    uint256[] internal pendingIds;
    uint16[9] internal activeShapes;
    uint256[][9] internal spareIds;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event Initialized(address indexed creator, address indexed pool);
    event CreatorTransferStarted(address indexed creator, address indexed pendingCreator);
    event CreatorTransferred(address indexed oldCreator, address indexed newCreator);
    event Configured(Config config, uint256[] plans);
    event PurchasesOpened();
    event PurchasesClosed();
    event CuratedListed(uint256 indexed listingId, address indexed collection, uint256 tokenId, uint256 base, uint256 price);
    event CuratedRepriced(uint256 indexed listingId, uint256 base, uint256 price);
    event CuratedWithdrawn(uint256 indexed listingId, address indexed to);
    event CuratedRecovered(uint256 indexed listingId, address indexed to);
    event ItemDrawn(uint256 indexed listingId, uint8 kind, uint8 denom, bool delivered);
    event DeliveryResolved(uint256 indexed listingId, bool delivered);
    event ShapesMinted(uint8 indexed denom, uint256 firstTokenId, uint256 quantity, uint256 cost);
    event ShapeListed(uint256 indexed listingId, uint8 indexed denom, uint256 tokenId, uint256 price);
    event ShapeUnlisted(uint256 indexed listingId, uint8 indexed denom, uint256 tokenId);
    event ListingRepriced(uint256 indexed listingId, uint256 price);
    event PlanActivated(uint8 indexed index);
    event Checkpointed(uint64 sequence, uint256 inventoryVersion, uint256 mintFee, uint256 reserve);
    event StatusChanged(uint8 status);
    event KeeperPaid(address indexed keeper, uint256 amount, uint256 gasUsed);
    event Deposited(address indexed from, uint256 amount);
    event ProceedsCollected(uint256 amount);
    event SurplusClaimed(address indexed to, uint256 amount);
    event Unwound(uint256 shapesWithdrawn, uint256 shapesRedeemed, uint256 ethRedeemed);
    event PoolRetired();
    event ENSNameSet(string name);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error Unauthorized();
    error AlreadyInitialized();
    error UnreviewedImplementation();
    error UnsupportedFWAConfig();
    error InvalidConfig();
    error InvalidPlan();
    error InvalidItem();
    error InvalidRecipient();
    error PoolBusy();
    error TooManyListings();
    error ValueTooHigh();
    error ShapesNotCurated();
    error NotClosed();
    error InsufficientSurplus();
    error NoUpkeepNeeded();
    error InvalidBatch();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(address fwaFactory, address fwaImplementation, bytes32 fwaCodehash, address shapes, address ens) {
        FWA_FACTORY = IFWAPoolFactory(fwaFactory);
        FWA_IMPLEMENTATION = fwaImplementation;
        FWA_IMPLEMENTATION_CODEHASH = fwaCodehash;
        SHAPES = IShapes(shapes);
        ENS = IENS(ens);
        // The denomination table below is hardcoded; refuse a Shapes deployment that disagrees.
        for (uint256 d; d < DENOMS; ++d) {
            if (IShapes(shapes).denominationAt(uint8(d)) != _amount(d)) revert UnsupportedFWAConfig();
        }
        creator = address(1); // lock the implementation
    }

    /// @notice Called once by BalancerFactory in the clone's deployment transaction. Creates the FWA
    ///         pool owned by this contract and installs this contract as its purchase operator.
    function initialize(address creator_) external payable {
        if (creator != address(0)) revert AlreadyInitialized();
        if (creator_ == address(0)) revert InvalidRecipient();
        creator = creator_;

        IFWAPoolFactory factory = FWA_FACTORY;
        if (FWA_IMPLEMENTATION.codehash != FWA_IMPLEMENTATION_CODEHASH) revert UnreviewedImplementation();
        if (factory.maxAcquisitionsPerTx() != MAX_BATCH) revert UnsupportedFWAConfig();
        // Reverts inside FWA if the factory's implementation is not the reviewed one.
        address p = factory.createPool(bytes32(0), FWA_IMPLEMENTATION);
        if (factory.poolImplementation(p) != FWA_IMPLEMENTATION || IFWAPool(p).owner() != address(this)) {
            revert UnreviewedImplementation();
        }
        pool = IFWAPool(p);
        IFWAPool(p).setPurchaseOperator(address(this));
        SHAPES.setApprovalForAll(p, true);

        emit Initialized(creator_, p);
        if (msg.value != 0) emit Deposited(msg.sender, msg.value);
    }

    modifier onlyCreator() {
        if (msg.sender != creator) revert Unauthorized();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                            CREATOR AUTHORITY
    //////////////////////////////////////////////////////////////*/

    function transferCreator(address newCreator) external onlyCreator {
        pendingCreator = newCreator;
        emit CreatorTransferStarted(msg.sender, newCreator);
    }

    function acceptCreator() external {
        if (msg.sender != pendingCreator || msg.sender == address(0)) revert Unauthorized();
        emit CreatorTransferred(creator, msg.sender);
        creator = msg.sender;
        pendingCreator = address(0);
    }

    /// @notice Set the creator's limits, markup and approved Shapes plans (first plan preferred).
    /// @dev Upkeep keeps the active plan while it satisfies the limits, else switches to the first
    ///      approved plan that does. A markup change reprices every listing before reopening.
    function configure(Config calldata cfg, uint256[] calldata newPlans) external onlyCreator {
        if (cfg.markupBps > MAX_MARKUP_BPS || cfg.minCuratedOddsBps > BPS || cfg.maxDrawPrice == 0) {
            revert InvalidConfig();
        }
        uint256 n = newPlans.length;
        if (n == 0 || n > MAX_PLANS) revert InvalidPlan();
        for (uint256 i; i < n; ++i) {
            (uint256 shapes, uint256 capital) = _planTotals(newPlans[i]);
            if (shapes == 0 || shapes > MAX_SHAPES_PER_PLAN || capital > cfg.maxShapeCapital) revert InvalidPlan();
        }
        if (cfg.markupBps != config.markupBps && activeIds.length != 0) {
            repricing = true;
            repriceCursor = 0;
        }
        config = cfg;
        plans = newPlans;
        activePlan = 0;
        _invalidate();
        emit Configured(cfg, newPlans);
    }

    /// @notice Allow purchases once upkeep establishes a funded checkpoint.
    function open() external onlyCreator {
        if (plans.length == 0) revert InvalidConfig();
        enabled = true;
        pool.setBool(ACQUISITIONS_ENABLED_KEY, true);
        emit PurchasesOpened();
    }

    /// @notice Stop new purchases immediately. Outstanding FWA draws, refunds and claims are unaffected.
    function close() external onlyCreator {
        enabled = false;
        _invalidate();
        if (!pool.retired()) pool.setBool(ACQUISITIONS_ENABLED_KEY, false);
        emit PurchasesClosed();
    }

    /*//////////////////////////////////////////////////////////////
                             CURATED NFTS
    //////////////////////////////////////////////////////////////*/

    struct CuratedInput {
        address collection;
        uint256 tokenId;
        uint256 base;
    }

    /// @notice Pull an NFT from the creator (approve this contract first) and list it on FWA.
    function listCurated(address collection, uint256 tokenId, uint256 base)
        external
        onlyCreator
        nonReentrant
        returns (uint256 listingId)
    {
        _requireIdle();
        _invalidate(); // before any external call: a collection hook must not see an admitting checkpoint
        uint256 price = _pullCurated(collection, tokenId, base);
        listingId = pool.listNFT(collection, tokenId, price);
        _recordCurated(listingId, collection, tokenId, base, price);
    }

    function listCuratedBatch(CuratedInput[] calldata inputs)
        external
        onlyCreator
        nonReentrant
        returns (uint256[] memory listingIds)
    {
        _requireIdle();
        _invalidate();
        uint256 n = inputs.length;
        if (n == 0 || n > 20) revert InvalidBatch();
        IFWAPool.ListingInput[] memory batch = new IFWAPool.ListingInput[](n);
        for (uint256 i; i < n; ++i) {
            CuratedInput calldata c = inputs[i];
            batch[i] = IFWAPool.ListingInput(c.collection, c.tokenId, _pullCurated(c.collection, c.tokenId, c.base));
        }
        listingIds = pool.listNFTs(batch);
        for (uint256 i; i < n; ++i) {
            _recordCurated(listingIds[i], batch[i].collection, batch[i].tokenId, inputs[i].base, batch[i].price);
        }
    }

    function updateCuratedPrice(uint256 listingId, uint256 newBase) external onlyCreator nonReentrant {
        _requireIdle();
        _invalidate();
        Item storage it = items[listingId];
        if (it.kind != CURATED || it.state != ACTIVE) revert InvalidItem();
        uint256 price = _priced(newBase);
        it.base = uint112(newBase);
        if (price != it.price) {
            pool.updatePrice(listingId, price);
            it.price = uint112(price);
        }
        emit CuratedRepriced(listingId, newBase, price);
    }

    /// @notice Withdraw an active curated listing from FWA directly to `to`.
    function withdrawCurated(uint256 listingId, address to) external onlyCreator nonReentrant {
        _requireIdle();
        Item storage it = items[listingId];
        if (it.kind != CURATED || it.state != ACTIVE) revert InvalidItem();
        if (to == address(0)) revert InvalidRecipient();
        _removeActive(listingId);
        delete items[listingId];
        _invalidate();
        pool.withdrawListingTo(listingId, to);
        emit CuratedWithdrawn(listingId, to);
    }

    /// @notice Recover a curated NFT whose FWA delivery was refunded. Upkeep never touches curated
    ///         collections for this, so a hostile collection cannot burn keeper gas or block upkeep.
    function recoverCuratedNFT(uint256 listingId, address to) external onlyCreator nonReentrant {
        Item storage it = items[listingId];
        if (it.kind != CURATED || to == address(0)) revert InvalidItem();
        (address collection,,, uint256 tokenId,,,, uint8 status) = pool.listings(listingId);
        if (it.state != PENDING || status != L_DELIVERY_REFUNDED) revert InvalidItem();
        _removePending(listingId);
        delete items[listingId];
        pool.recoverRefundedNFT(listingId);
        IERC721Min(collection).safeTransferFrom(address(this), to, tokenId);
        emit CuratedRecovered(listingId, to);
    }

    /*//////////////////////////////////////////////////////////////
                                  FUNDS
    //////////////////////////////////////////////////////////////*/

    receive() external payable {}

    function depositETH() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Pull settled FWA owner proceeds into this contract. Permissionless.
    function collectProceeds() external nonReentrant returns (uint256 amount) {
        amount = _collect();
    }

    /// @notice Withdraw ETH above the funded reserve. While purchases are enabled the reserve covers
    ///         restoring the current plan plus a worst-case batch and one keeper reward.
    function claimSurplus(uint256 amount, address to) external onlyCreator nonReentrant {
        if (to == address(0)) revert InvalidRecipient();
        // While open, reserve math uses reconciled inventory: draws settled on FWA must be reconciled first.
        if (enabled) _requireIdle();
        _collect();
        if (amount > withdrawableSurplus()) revert InsufficientSurplus();
        SafeTransferLib.safeTransferETH(to, amount);
        emit SurplusClaimed(to, amount);
    }

    /// @notice After closing, withdraw up to `maxCount` (<= 20) listed Shapes and redeem up to 20 held
    ///         Shapes for their exact backing. Repeat until nothing remains. Curated NFTs are withdrawn
    ///         separately.
    function unwind(uint256 maxCount) external onlyCreator nonReentrant {
        if (enabled) revert NotClosed();
        _requireIdle();
        if (maxCount > 20) maxCount = 20;
        IFWAPool p = pool;
        uint256[] memory ids = new uint256[](maxCount);
        uint256 n;
        for (uint256 i = activeIds.length; i != 0 && n < maxCount;) {
            uint256 lid = activeIds[--i];
            if (items[lid].kind == SHAPE) ids[n++] = lid;
        }
        assembly ("memory-safe") {
            mstore(ids, n)
        }
        if (n != 0) {
            for (uint256 i; i < n; ++i) {
                (,,, uint256 tokenId,,,,) = p.listings(ids[i]);
                uint8 d = items[ids[i]].denom;
                _removeActive(ids[i]);
                --activeShapes[d];
                delete items[ids[i]];
                spareIds[d].push(tokenId);
            }
            p.withdrawListingsTo(ids, address(this));
        }
        uint256[] memory burn = new uint256[](20);
        uint256 total;
        for (uint256 d; d < DENOMS && total < 20; ++d) {
            uint256[] storage s = spareIds[d];
            while (s.length != 0 && total < 20) {
                burn[total++] = s[s.length - 1];
                s.pop();
            }
        }
        assembly ("memory-safe") {
            mstore(burn, total)
        }
        uint256 eth;
        if (total != 0) eth = SHAPES.redeemBatch(burn);
        _invalidate();
        emit Unwound(n, total, eth);
    }

    /// @notice Irreversibly retire the FWA pool. Withdrawals, unwind and recovery remain available.
    function retire() external onlyCreator {
        if (enabled) revert NotClosed();
        pool.retirePool();
        emit PoolRetired();
    }

    /*//////////////////////////////////////////////////////////////
                                   ENS
    //////////////////////////////////////////////////////////////*/

    /// @notice Set this contract's ENS reverse record via the current `addr.reverse` registrar.
    function setENSName(string calldata name) external onlyCreator {
        IReverseRegistrar(ENS.owner(ADDR_REVERSE_NODE)).setName(name);
        emit ENSNameSet(name);
    }

    function clearENSName() external onlyCreator {
        IReverseRegistrar(ENS.owner(ADDR_REVERSE_NODE)).setName("");
        emit ENSNameSet("");
    }

    /*//////////////////////////////////////////////////////////////
                              ADMISSION GATE
    //////////////////////////////////////////////////////////////*/

    /// @notice FWA purchase-operator hook. Must stay read-only and under FWA's 100k gas stipend.
    function canPurchase(address) external view returns (bool) {
        return admissionStatus() == OK;
    }

    /// @notice Why purchases are or are not admitted right now (see status constants).
    function admissionStatus() public view returns (uint8) {
        if (!enabled) return CLOSED;
        Checkpoint memory cp = checkpoint;
        if (!cp.valid) return lastStatus == OK ? NEEDS_UPKEEP : lastStatus;
        IFWAPool p = pool;
        if (p.lastIssuedSequence() != cp.sequence) {
            return p.unsettledAcquisitionCount() != 0 ? UNSETTLED : NEEDS_UPKEEP;
        }
        if (p.inventoryVersion() != cp.inventoryVersion) return NEEDS_UPKEEP;
        if (p.tokenOfferEnabled()) return TOKEN_OFFER_ACTIVE;
        if (SHAPES.mintFee() > cp.mintFee) return MINT_FEE_ROSE;
        if (address(this).balance < cp.reserve) return INSUFFICIENT_RESERVE;
        if (p.acquisitionFee() > config.maxDrawPrice) return PRICE_ABOVE_MAX;
        return OK;
    }

    /*//////////////////////////////////////////////////////////////
                                 UPKEEP
    //////////////////////////////////////////////////////////////*/

    /// @notice Permissionless maintenance: reconcile settled draws, recover refunded deliveries,
    ///         collect proceeds, reprice, restore the approved Shapes plan and re-checkpoint.
    ///         Pays `msg.sender` a bounded reward only when real maintenance work was done.
    function performUpkeep() external nonReentrant {
        uint256 gasStart = gasleft();
        Checkpoint memory before = checkpoint;
        uint8 statusBefore = lastStatus;
        uint256 pendingBefore = pendingIds.length;
        (uint256 ops, bool batchReconciled) = _sync();
        Checkpoint memory afterCp = checkpoint;
        bool changed = ops != 0 || batchReconciled || pendingIds.length != pendingBefore || lastStatus != statusBefore || afterCp.valid != before.valid
            || afterCp.inventoryVersion != before.inventoryVersion || afterCp.reserve != before.reserve
            || afterCp.mintFee != before.mintFee;
        if (!changed) revert NoUpkeepNeeded();
        if (ops != 0 || batchReconciled) _payKeeper(gasStart, ops != 0);
    }

    /// @notice Cheap hint for keepers; simulate `performUpkeep` before sending.
    function needsUpkeep() external view returns (bool) {
        IFWAPool p = pool;
        if (address(p) == address(0) || p.unsettledAcquisitionCount() != 0) return false;
        if (p.lastIssuedSequence() != reconciledSequence || repricing) return true;
        if (enabled && !checkpoint.valid) return true;
        for (uint256 i; i < pendingIds.length; ++i) {
            (,,,,,,, uint8 s) = p.listings(pendingIds[i]);
            if (s == L_SETTLED || (s == L_DELIVERY_REFUNDED && items[pendingIds[i]].kind == SHAPE)) return true;
        }
        return false;
    }

    function _sync() internal returns (uint256 ops, bool batchReconciled) {
        IFWAPool p = pool;
        if (p.unsettledAcquisitionCount() != 0) revert PoolBusy();
        checkpoint.valid = false;

        // 1. Reconcile every FWA sequence issued since the last reconciliation (<= MAX_BATCH).
        uint64 last = p.lastIssuedSequence();
        for (uint64 s = reconciledSequence + 1; s <= last; ++s) {
            (,,, uint256 lid, uint8 aStatus,) = p.acquisitions(p.requestIdAtSequence(s));
            if (lid != 0) {
                _onDrawn(lid, aStatus == A_FULFILLED);
                ++ops;
            }
        }
        if (last != reconciledSequence) {
            reconciledSequence = last;
            batchReconciled = true;
        }

        // 2. Resolve drawn items awaiting FWA delivery.
        for (uint256 i = pendingIds.length; i != 0;) {
            uint256 lid = pendingIds[--i];
            (,,, uint256 tokenId,,,, uint8 lStatus) = p.listings(lid);
            if (lStatus == L_SETTLED) {
                _removePending(lid);
                delete items[lid];
                emit DeliveryResolved(lid, true);
            } else if (lStatus == L_DELIVERY_REFUNDED && items[lid].kind == SHAPE) {
                // Only Shapes are recovered here: their transfer is trusted and hook-free. A refunded curated
                // NFT calls an untrusted collection, which could revert or burn the keeper's gas forever, so
                // it stays pending for the creator's `recoverCuratedNFT`.
                uint8 d = items[lid].denom;
                _removePending(lid);
                p.recoverRefundedNFT(lid);
                spareIds[d].push(tokenId);
                delete items[lid];
                ++ops;
                emit DeliveryResolved(lid, false);
            }
        }

        // 3. Settled proceeds fund maintenance.
        _collect();

        // 4. Maintain inventory only while open.
        if (enabled) {
            (uint256 more, uint8 status) = _maintain(p);
            ops += more;
            if (lastStatus != status) {
                lastStatus = status;
                emit StatusChanged(status);
            }
        }
    }

    /// @dev Reprice, select a feasible approved plan, restore it and checkpoint. Returns the status.
    function _maintain(IFWAPool p) internal returns (uint256 ops, uint8) {
        if (p.retired() || FWA_FACTORY.globalWithdrawOnly()) return (0, FWA_UNAVAILABLE);
        if (repricing) {
            ops = _reprice(p);
            if (repricing) return (ops, REPRICING);
        }

        uint256 markup = config.markupBps;
        (uint256 cW, uint256 cWP, bool ok) = _curatedTotals(p, markup);
        if (!ok) return (ops, INVENTORY_MISMATCH);
        if (cW == 0) return (ops, NO_CURATED);

        uint256 plan = _selectPlan(cW, cWP, markup);
        if (plan == 0) return (ops, INFEASIBLE);

        // Restore the plan: unlist surplus Shapes, then fill deficits from spares or new mints.
        uint256 fee = SHAPES.mintFee();
        (uint256 used, bool complete, bool funded) = _rebalance(p, plan, markup, fee, MAX_OPS);
        ops += used;
        if (!funded) return (ops, INSUFFICIENT_RESERVE);
        if (!complete) return (ops, NEEDS_UPKEEP);

        return (ops, _checkpoint(p, plan, cW, cWP, markup, fee));
    }

    /// @dev FWA's canonical totals must equal curated + plan exactly, and liquid ETH must cover the
    ///      worst batch, before purchases are admitted.
    function _checkpoint(IFWAPool p, uint256 plan, uint256 cW, uint256 cWP, uint256 markup, uint256 fee)
        internal
        returns (uint8)
    {
        (uint256 sW, uint256 sWP) = _shapeTotals(plan, markup);
        // Independent of the weight sums (which derive curated totals from FWA's): FWA's active listing
        // count must equal the tracked active set.
        if (p.activeListingCount() != activeIds.length) return INVENTORY_MISMATCH;
        if (p.totalWeight() != cW + sW || p.weightedBackingTotal() != cWP + sWP) return INVENTORY_MISMATCH;
        if (p.acquisitionFee() > config.maxDrawPrice) return PRICE_ABOVE_MAX;
        uint256 reserve = _batchReserve(plan, fee) + MAX_KEEPER_REWARD;
        if (address(this).balance < reserve) return INSUFFICIENT_RESERVE;
        uint64 seq = reconciledSequence;
        uint256 version = p.inventoryVersion();
        checkpoint = Checkpoint({valid: true, sequence: seq, mintFee: uint128(fee), inventoryVersion: version, reserve: reserve});
        emit Checkpointed(seq, version, fee, reserve);
        return OK;
    }

    /// @dev Keep the active plan while feasible, else switch to the first feasible approved plan.
    ///      Returns 0 when none is feasible (an empty plan is rejected by `configure`).
    function _selectPlan(uint256 cW, uint256 cWP, uint256 markup) internal returns (uint256) {
        uint256 edge = FWA_FACTORY.edgeBps();
        uint8 current = activePlan;
        if (_feasible(plans[current], cW, cWP, markup, edge)) return plans[current];
        uint256 n = plans.length;
        for (uint8 i; i < n; ++i) {
            if (_feasible(plans[i], cW, cWP, markup, edge)) {
                activePlan = i;
                emit PlanActivated(i);
                return plans[i];
            }
        }
        return 0;
    }

    function _onDrawn(uint256 lid, bool delivered) internal {
        Item storage it = items[lid];
        // Every pool listing is ours and active until drawn. Never revert here: reconciliation must not be
        // bricked; any desync is caught by the checkpoint's listing-count check and fails closed.
        if (it.state != ACTIVE) return;
        uint8 kind = it.kind;
        uint8 d = it.denom;
        _removeActive(lid);
        if (kind == SHAPE) --activeShapes[d];
        if (delivered) {
            delete items[lid];
        } else {
            it.state = PENDING;
            pendingIds.push(lid);
        }
        emit ItemDrawn(lid, kind, d, delivered);
    }

    function _reprice(IFWAPool p) internal returns (uint256 ops) {
        uint256 i = repriceCursor;
        uint256 n = activeIds.length;
        for (; i < n && ops < MAX_OPS; ++i) {
            uint256 lid = activeIds[i];
            Item storage it = items[lid];
            uint256 price = _priced(it.base);
            if (price != it.price) {
                p.updatePrice(lid, price);
                it.price = uint112(price);
                ++ops;
                emit ListingRepriced(lid, price);
            }
        }
        repriceCursor = i;
        if (i == n) repricing = false;
    }

    function _rebalance(IFWAPool p, uint256 plan, uint256 markup, uint256 fee, uint256 budget)
        internal
        returns (uint256 used, bool complete, bool funded)
    {
        used = _unlistSurplus(p, plan, budget);
        uint256 filled;
        (filled, funded) = _fillDeficit(p, plan, markup, fee, budget - used);
        used += filled;
        if (!funded) return (used, false, false);
        for (uint256 d; d < DENOMS; ++d) {
            if (activeShapes[d] != _count(plan, d)) return (used, false, true);
        }
        complete = true;
    }

    /// @dev Only after a plan change: withdraw Shapes above target back into spares.
    function _unlistSurplus(IFWAPool p, uint256 plan, uint256 budget) internal returns (uint256 used) {
        uint256[] memory out = new uint256[](budget);
        for (uint256 d; d < DENOMS; ++d) {
            uint256 target = _count(plan, d);
            for (uint256 i = activeIds.length; i != 0 && activeShapes[d] > target && used < budget;) {
                uint256 lid = activeIds[--i];
                Item storage it = items[lid];
                if (it.kind != SHAPE || it.denom != d) continue;
                (,,, uint256 tokenId,,,,) = p.listings(lid);
                _removeActive(lid);
                --activeShapes[d];
                delete items[lid];
                spareIds[d].push(tokenId);
                out[used++] = lid;
                emit ShapeUnlisted(lid, uint8(d), tokenId);
            }
        }
        if (used != 0) {
            assembly ("memory-safe") {
                mstore(out, used)
            }
            p.withdrawListingsTo(out, address(this));
        }
    }

    /// @dev List spares first, then mint like-for-like with available ETH, in one FWA batch.
    function _fillDeficit(IFWAPool p, uint256 plan, uint256 markup, uint256 fee, uint256 budget)
        internal
        returns (uint256 used, bool funded)
    {
        funded = true;
        IFWAPool.ListingInput[] memory batch = new IFWAPool.ListingInput[](budget);
        for (uint256 d; d < DENOMS && used < budget; ++d) {
            uint256 have = activeShapes[d];
            uint256 target = _count(plan, d);
            if (have >= target) continue;
            uint256 need = target - have;
            if (need > budget - used) need = budget - used;
            uint256 price = _amount(d) * (BPS + markup) / BPS;
            uint256[] storage spares = spareIds[d];
            for (; need != 0 && spares.length != 0; --need) {
                batch[used++] = IFWAPool.ListingInput(address(SHAPES), spares[spares.length - 1], price);
                spares.pop();
            }
            if (need != 0) {
                uint256 cost = need * (_amount(d) + fee);
                if (address(this).balance < cost) {
                    funded = false;
                    break;
                }
                uint256 first = SHAPES.mintBatch{value: cost}(_amount(d), need);
                emit ShapesMinted(uint8(d), first, need, cost);
                for (uint256 j; j < need; ++j) {
                    batch[used++] = IFWAPool.ListingInput(address(SHAPES), first + j, price);
                }
            }
        }
        if (used == 0) return (0, funded);
        assembly ("memory-safe") {
            mstore(batch, used)
        }
        uint256[] memory lids = p.listNFTs(batch);
        for (uint256 i; i < used; ++i) {
            // Denomination is recovered from the listed price, which is unique per denomination.
            uint8 d = _denomOfPrice(batch[i].price, markup);
            items[lids[i]] = Item(SHAPE, d, ACTIVE, uint112(_amount(d)), uint112(batch[i].price));
            _addActive(lids[i]);
            ++activeShapes[d];
            emit ShapeListed(lids[i], d, batch[i].tokenId, batch[i].price);
        }
    }

    function _denomOfPrice(uint256 price, uint256 markup) internal pure returns (uint8 d) {
        while (_amount(d) * (BPS + markup) / BPS != price) {
            if (++d == DENOMS) revert InvalidItem();
        }
    }

    function _payKeeper(uint256 gasStart, bool incentive) internal {
        uint256 gasUsed = gasStart - gasleft() + KEEPER_GAS_OVERHEAD;
        if (gasUsed > KEEPER_MAX_GAS) gasUsed = KEEPER_MAX_GAS;
        uint256 price = tx.gasprice;
        uint256 cap = block.basefee + KEEPER_PRIORITY_CAP;
        if (price > cap) price = cap;
        if (price > KEEPER_MAX_GAS_PRICE) price = KEEPER_MAX_GAS_PRICE;
        uint256 reward = gasUsed * price + (incentive ? KEEPER_INCENTIVE : 0);
        if (reward > address(this).balance) reward = address(this).balance;
        if (reward == 0) return;
        SafeTransferLib.forceSafeTransferETH(msg.sender, reward);
        emit KeeperPaid(msg.sender, reward, gasUsed);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice ETH the creator may claim now.
    function withdrawableSurplus() public view returns (uint256) {
        uint256 bal = address(this).balance;
        uint256 req = requiredReserve();
        return bal > req ? bal - req : 0;
    }

    /// @notice ETH that must stay liquid: zero while closed; otherwise the cost of restoring the active
    ///         plan from current inventory, plus a worst-case batch and one maximum keeper reward.
    function requiredReserve() public view returns (uint256 r) {
        if (!enabled || plans.length == 0) return 0;
        uint256 plan = plans[activePlan];
        uint256 fee = SHAPES.mintFee();
        for (uint256 d; d < DENOMS; ++d) {
            uint256 have = activeShapes[d] + spareIds[d].length;
            uint256 target = _count(plan, d);
            if (target > have) r += (target - have) * (_amount(d) + fee);
        }
        r += _batchReserve(plan, fee) + MAX_KEEPER_REWARD;
    }

    function getPlans() external view returns (uint256[] memory) {
        return plans;
    }

    function getActiveIds() external view returns (uint256[] memory) {
        return activeIds;
    }

    function getPendingIds() external view returns (uint256[] memory) {
        return pendingIds;
    }

    function getSpares(uint256 d) external view returns (uint256[] memory) {
        return spareIds[d];
    }

    function getActiveShapes() external view returns (uint16[9] memory) {
        return activeShapes;
    }

    function denominationAmount(uint256 d) external pure returns (uint256) {
        return _amount(d);
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNALS
    //////////////////////////////////////////////////////////////*/

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// @dev No unresolved FWA acquisition and every issued draw reconciled into `items`.
    function _requireIdle() internal view {
        IFWAPool p = pool;
        if (p.unsettledAcquisitionCount() != 0 || p.lastIssuedSequence() != reconciledSequence) revert PoolBusy();
    }

    function _invalidate() internal {
        checkpoint.valid = false;
    }

    function _collect() internal returns (uint256 amount) {
        IFWAPool p = pool;
        if (p.ownerProceeds() != 0) {
            amount = p.withdrawOwnerProceeds();
            emit ProceedsCollected(amount);
        }
    }

    function _priced(uint256 base) internal view returns (uint256 price) {
        price = base * (BPS + config.markupBps) / BPS;
        if (base == 0 || price > type(uint112).max) revert ValueTooHigh();
    }

    function _pullCurated(address collection, uint256 tokenId, uint256 base) internal returns (uint256 price) {
        if (collection == address(SHAPES)) revert ShapesNotCurated();
        price = _priced(base);
        IERC721Min(collection).transferFrom(msg.sender, address(this), tokenId);
        if (IERC721Min(collection).ownerOf(tokenId) != address(this)) revert InvalidItem();
        IERC721Min(collection).approve(address(pool), tokenId);
    }

    function _recordCurated(uint256 lid, address collection, uint256 tokenId, uint256 base, uint256 price) internal {
        items[lid] = Item(CURATED, 0, ACTIVE, uint112(base), uint112(price));
        _addActive(lid);
        emit CuratedListed(lid, collection, tokenId, base, price);
    }

    function _addActive(uint256 lid) internal {
        activeIds.push(lid);
        activeIndexPlusOne[lid] = activeIds.length;
        if (activeIds.length > MAX_LISTINGS) revert TooManyListings();
    }

    function _removeActive(uint256 lid) internal {
        uint256 idx = activeIndexPlusOne[lid];
        if (idx == 0) revert InvalidItem();
        uint256 lastId = activeIds[activeIds.length - 1];
        activeIds[idx - 1] = lastId;
        activeIndexPlusOne[lastId] = idx;
        activeIds.pop();
        delete activeIndexPlusOne[lid];
        if (repricing) repriceCursor = 0; // swap-pop may move an unvisited listing behind the cursor
    }

    function _removePending(uint256 lid) internal {
        uint256 n = pendingIds.length;
        for (uint256 i; i < n; ++i) {
            if (pendingIds[i] == lid) {
                pendingIds[i] = pendingIds[n - 1];
                pendingIds.pop();
                return;
            }
        }
    }

    /// @dev Curated weight sums = FWA totals minus our active Shapes. Valid only when every active
    ///      Shape is priced at `markup` (true outside repricing).
    function _curatedTotals(IFWAPool p, uint256 markup) internal view returns (uint256 cW, uint256 cWP, bool ok) {
        uint256 sW;
        uint256 sWP;
        for (uint256 d; d < DENOMS; ++d) {
            uint256 n = activeShapes[d];
            if (n == 0) continue;
            uint256 price = _amount(d) * (BPS + markup) / BPS;
            uint256 w = INVERSE_WEIGHT_NUMERATOR / price;
            sW += n * w;
            sWP += n * w * price;
        }
        uint256 tW = p.totalWeight();
        uint256 tWP = p.weightedBackingTotal();
        if (tW < sW || tWP < sWP) return (0, 0, false);
        return (tW - sW, tWP - sWP, true);
    }

    function _shapeTotals(uint256 plan, uint256 markup) internal pure returns (uint256 sW, uint256 sWP) {
        for (uint256 d; d < DENOMS; ++d) {
            uint256 n = _count(plan, d);
            if (n == 0) continue;
            uint256 price = _amount(d) * (BPS + markup) / BPS;
            uint256 w = INVERSE_WEIGHT_NUMERATOR / price;
            sW += n * w;
            sWP += n * w * price;
        }
    }

    /// @dev Exact FWA pricing: fee = (Σw·p / Σw) · (1 + edge), w = 1e36 / p.
    function _feasible(uint256 plan, uint256 cW, uint256 cWP, uint256 markup, uint256 edge)
        internal
        view
        returns (bool)
    {
        Config memory c = config;
        (, uint256 capital) = _planTotals(plan);
        if (capital > c.maxShapeCapital) return false;
        (uint256 sW, uint256 sWP) = _shapeTotals(plan, markup);
        uint256 tW = cW + sW;
        if ((cWP + sWP) / tW * (BPS + edge) / BPS > c.maxDrawPrice) return false;
        return cW * BPS >= uint256(c.minCuratedOddsBps) * tW;
    }

    /// @dev Cash for the worst MAX_BATCH Shape draws from a full plan. Each spare of a denomination
    ///      covers one draw of it without cash; spare backing is never counted as liquid ETH.
    function _batchReserve(uint256 plan, uint256 fee) internal view returns (uint256 r) {
        uint256 left = MAX_BATCH;
        for (uint256 d = DENOMS; d != 0 && left != 0;) {
            --d;
            uint256 n = _count(plan, d);
            // Spares already needed to fill a current deficit cannot also cover a future draw.
            uint256 have = activeShapes[d] + spareIds[d].length;
            uint256 spare = have > n ? have - n : 0;
            if (spare > spareIds[d].length) spare = spareIds[d].length;
            uint256 cash = n > spare ? n - spare : 0;
            if (cash > left) cash = left;
            r += cash * (_amount(d) + fee);
            left -= cash;
        }
    }

    function _planTotals(uint256 plan) internal pure returns (uint256 shapes, uint256 capital) {
        if (plan >> (16 * DENOMS) != 0) revert InvalidPlan();
        for (uint256 d; d < DENOMS; ++d) {
            uint256 n = _count(plan, d);
            shapes += n;
            capital += n * _amount(d);
        }
    }

    function _count(uint256 plan, uint256 d) internal pure returns (uint256) {
        return (plan >> (16 * d)) & 0xFFFF;
    }

    /// @dev Mainnet Shapes ladder; checked against `Shapes.denominationAt` in the constructor.
    function _amount(uint256 d) internal pure returns (uint256) {
        if (d == 0) return 0.01 ether;
        if (d == 1) return 0.05 ether;
        if (d == 2) return 0.1 ether;
        if (d == 3) return 0.5 ether;
        if (d == 4) return 1 ether;
        if (d == 5) return 5 ether;
        if (d == 6) return 10 ether;
        if (d == 7) return 50 ether;
        return 100 ether;
    }
}
