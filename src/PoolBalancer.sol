// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {LibString} from "solady/utils/LibString.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";
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
///        against FWA totals), the plan to satisfy the creator's price and odds limits, and liquid
///        ETH to cover the worst MAX_BATCH Shape replacements plus one maximum keeper reward.
///      - Managed Shapes are held only inside a transaction: minted then listed, or withdrawn then redeemed.
///        Any NFT this contract owns between transactions is untracked and creator-recoverable (e.g. one
///        sent directly, or a draw delivered to this contract because a buyer named it as purchaser).
///      - No upkeep loop depends on history: drawn items awaiting FWA delivery are never scanned.
///      - No function sends ETH or NFTs to an address chosen by anyone but the creator, except the
///        bounded keeper reward to `msg.sender` of `performUpkeep` / `recoverRefundedShape`.
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
    /// @dev Bounds every loop over listings (repricing scan, plan withdrawal, unwind).
    uint256 internal constant MAX_LISTINGS = 100;
    /// @dev Inventory operations (mint+list, withdraw+redeem, reprice) per upkeep; FWA batch limit is 20.
    uint256 internal constant MAX_OPS = 6;
    uint256 internal constant MAX_MARKUP_BPS = 10_000;
    uint256 internal constant INVERSE_WEIGHT_NUMERATOR = 1e36; // FWA StandardPool constant

    // Keeper compensation (see docs/GAS.md; collection-games#23 for the exploit these bounds prevent):
    // - price = min(tx.gasprice, basefee + KEEPER_PRIORITY_CAP, KEEPER_MAX_GAS_PRICE): an overbid is the
    //   keeper's own cost;
    // - gas = 4/5 of the measured span, capped: EIP-3529 refunds cut the billed gas by at most 1/5 of the gas
    //   used and in-transaction measurement cannot see them, so 4/5 of any part of the transaction is always
    //   billed. No intrinsic-gas credit: a contract making several paid calls in one transaction pays it once.
    // - incentive (KEEPER_INCENTIVE per call with inventory work) is paid from one of two sources. Work a creator
    //   action started (configure, open, curated edits, unwind) pays it in full until the next checkpoint; these
    //   actions all close admission first, so no purchase happens while it applies. Work purchases caused is paid from `incentiveCredit`: FWA's edge on the draws of the last
    //   reconciled batch, reset by each batch and spent by every call that follows it. Buying one's own draws
    //   therefore earns at most the edge those draws paid to FWA.
    uint256 internal constant KEEPER_MAX_GAS = 3_200_000;
    uint256 internal constant KEEPER_PRIORITY_CAP = 0.05 gwei;
    uint256 internal constant KEEPER_MAX_GAS_PRICE = 5 gwei;
    uint256 internal constant KEEPER_INCENTIVE = 0.0005 ether;
    // Liveness: the 4/5 rule leaves a keeper short by at most measured/5 + intrinsic gas. When that shortfall at the
    // reimbursed price plus KEEPER_MARGIN exceeds KEEPER_INCENTIVE (above ~0.6 gwei for a 3M-gas call), the incentive
    // becomes that amount, so paid work stays profitable up to KEEPER_MAX_GAS_PRICE. Gas-only paid calls get the
    // shortfall without margin. Incentives for purchase-caused work stay within the edge credit.
    uint256 internal constant KEEPER_MARGIN = 0.0001 ether;
    uint256 internal constant INTRINSIC_GAS = 21_000;
    uint256 public constant MAX_KEEPER_REWARD =
        (KEEPER_MAX_GAS + INTRINSIC_GAS) * KEEPER_MAX_GAS_PRICE + KEEPER_MARGIN;

    uint256 internal constant ACQUISITIONS_ENABLED_KEY = 41; // FWAConfigKeys.ACQUISITIONS_ENABLED
    /// @dev FWA Pools V1 factory, named in FWA's pool-page message next to the V2 PoolFactory.
    string internal constant FWA_V1_FACTORY = "0xf5a3a153164791ab579c3d9ba5dbecf7cdfd300c";
    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;
    bytes32 internal constant ADDR_REVERSE_NODE = 0x91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2;

    // FWA ListingStatus / AcquisitionStatus values.
    uint8 internal constant L_SETTLED = 4;
    uint8 internal constant L_DELIVERY_REFUNDED = 7;
    uint8 internal constant A_FULFILLED = 2;

    // Item kinds and states.
    uint8 internal constant CURATED = 1;
    uint8 internal constant SHAPE = 2;
    uint8 internal constant ACTIVE = 1;
    uint8 internal constant PENDING = 2; // drawn, FWA delivery failed; resolved per item, never scanned

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
    /// @dev True from a creator action until the next checkpoint (see keeper compensation above).
    bool public creatorWork;
    /// @dev FWA edge paid by the draws of the last reconciled batch, not yet spent on incentives.
    uint128 public incentiveCredit;
    /// @dev Intrinsic gas is paid once per transaction; credit it to the first paid call only.
    bool transient intrinsicCredited;

    Checkpoint public checkpoint;
    uint64 public reconciledSequence;

    mapping(uint256 listingId => Item) public items;
    uint256[] internal activeIds;
    mapping(uint256 listingId => uint256) internal activeIndexPlusOne;
    uint16[9] internal activeShapes;
    /// @dev Pool-page approvals are valid only in the epoch they were made; `revokePoolPages` and every creator
    ///      change start a new epoch, so a former creator's approvals cannot be replayed.
    uint256 public pageEpoch;
    mapping(bytes32 digest => uint256) internal pageApprovedEpoch; // epoch + 1

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
    event UntrackedNFTRecovered(address indexed collection, uint256 tokenId, address indexed to);
    event ItemDrawn(uint256 indexed listingId, uint8 kind, uint8 denom, bool delivered);
    event ShapeRecovered(uint256 indexed listingId, uint256 eth);
    event ShapesMinted(uint8 indexed denom, uint256 firstTokenId, uint256 quantity, uint256 cost);
    event ShapeListed(uint256 indexed listingId, uint8 indexed denom, uint256 tokenId, uint256 price);
    event ShapesUnlisted(uint256 count, uint256 ethRedeemed);
    event ListingRepriced(uint256 indexed listingId, uint256 price);
    event PlanActivated(uint8 indexed index);
    event Checkpointed(uint64 sequence, uint256 inventoryVersion, uint256 mintFee, uint256 reserve);
    event StatusChanged(uint8 status);
    event KeeperPaid(address indexed keeper, uint256 amount, uint256 gasUsed);
    event Deposited(address indexed from, uint256 amount);
    event ProceedsCollected(uint256 amount);
    event SurplusClaimed(address indexed to, uint256 amount);
    event Unwound(uint256 shapesRedeemed, uint256 ethRedeemed);
    event PoolRetired();
    event ENSNameSet(string name);
    event PoolPageApproved(bytes32 indexed digest, string issuedAt, bytes32 metadataHash);
    event PoolPagesRevoked(uint256 epoch);

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
    error ProtectedAsset();

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
        ++pageEpoch;
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
            uint256 shapes = _planShapes(newPlans[i]);
            if (shapes == 0 || shapes > MAX_SHAPES_PER_PLAN) revert InvalidPlan();
        }
        if (cfg.markupBps != config.markupBps && activeIds.length != 0) repricing = true;
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
        // Only while admission is closed: creatorWork must never be set while purchases can happen.
        if (!checkpoint.valid) creatorWork = true;
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
    ///         collections, so a hostile collection cannot burn keeper gas or block upkeep.
    function recoverCuratedNFT(uint256 listingId, address to) external onlyCreator nonReentrant {
        Item storage it = items[listingId];
        if (it.kind != CURATED || it.state != PENDING || to == address(0)) revert InvalidItem();
        (address collection,,, uint256 tokenId,,,, uint8 status) = pool.listings(listingId);
        if (status != L_DELIVERY_REFUNDED) revert InvalidItem();
        delete items[listingId];
        pool.recoverRefundedNFT(listingId);
        IERC721Min(collection).safeTransferFrom(address(this), to, tokenId);
        emit CuratedRecovered(listingId, to);
    }

    /// @notice Return an NFT this contract holds outside FWA, e.g. one sent to it directly.
    /// @dev Tracked inventory is never held here between transactions: listings and pending deliveries
    ///      are owned by the FWA pool, Shapes are minted-and-listed or withdrawn-and-redeemed within one
    ///      call, and refunded curated NFTs are pulled from FWA only inside `recoverCuratedNFT`. So
    ///      `ownerOf == this` (checked under the reentrancy lock) proves the NFT is untracked. Only the
    ///      ERC721 transfer selector is called, and never on the FWA pool or factory.
    function recoverUntrackedNFT(address collection, uint256 tokenId, address to) external onlyCreator nonReentrant {
        if (to == address(0)) revert InvalidRecipient();
        if (collection == address(pool) || collection == address(FWA_FACTORY)) revert ProtectedAsset();
        if (IERC721Min(collection).ownerOf(tokenId) != address(this)) revert ProtectedAsset();
        IERC721Min(collection).safeTransferFrom(address(this), to, tokenId);
        emit UntrackedNFTRecovered(collection, tokenId, to);
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

    /// @notice After closing, withdraw up to `maxCount` (<= 20) listed Shapes from FWA and redeem them
    ///         for their exact backing. Repeat until none remain. Curated NFTs are withdrawn separately.
    function unwind(uint256 maxCount) external onlyCreator nonReentrant {
        if (enabled) revert NotClosed();
        _requireIdle();
        if (maxCount > 20) maxCount = 20;
        uint256[] memory ids = new uint256[](maxCount);
        uint256 n;
        for (uint256 i = activeIds.length; i != 0 && n < maxCount;) {
            uint256 lid = activeIds[--i];
            if (items[lid].kind == SHAPE) ids[n++] = lid;
        }
        assembly ("memory-safe") {
            mstore(ids, n)
        }
        uint256 eth = _withdrawAndRedeem(pool, ids);
        _invalidate();
        emit Unwound(n, eth);
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
                           FWA POOL PAGE (ERC-1271)
    //////////////////////////////////////////////////////////////*/

    /// @notice Approve one FWA pool-page publication. FWA's site asks the pool owner to personal_sign a
    ///         fixed plain-text message; this contract rebuilds that exact message for its own pool and
    ///         approves only its digest. `issuedAt` is the ISO-8601 time the site will submit
    ///         (24 chars, e.g. 2026-11-10T12:34:56.789Z); `metadataHash` is keccak256 of the page JSON.
    /// @dev Approved digests are always "Publish FWA Pools page" messages naming this pool, so
    ///      `isValidSignature` cannot authorize anything else (no FWA, Shapes or ERC721 function
    ///      accepts such a message). Format verified against pools.fwa.fun's client code 2026-11-10.
    function approvePoolPage(string calldata issuedAt, bytes32 metadataHash) external onlyCreator returns (bytes32 digest) {
        bytes calldata t = bytes(issuedAt);
        if (t.length != 24) revert InvalidConfig();
        for (uint256 i; i < 24; ++i) {
            bytes1 c = t[i];
            if ((c < "0" || c > "9") && c != "-" && c != ":" && c != "." && c != "T" && c != "Z") revert InvalidConfig();
        }
        bytes memory message = abi.encodePacked(
            "Publish FWA Pools page\nSite: pools.fwa.fun\nChain: 1\nFactories: ",
            LibString.toHexString(address(FWA_FACTORY)),
            ", ",
            FWA_V1_FACTORY,
            "\nPool: ",
            LibString.toHexString(address(pool)),
            "\nIssued at: ",
            issuedAt,
            "\nMetadata hash: ",
            LibString.toHexString(uint256(metadataHash), 32)
        );
        digest = SignatureCheckerLib.toEthSignedMessageHash(message);
        pageApprovedEpoch[digest] = pageEpoch + 1;
        emit PoolPageApproved(digest, issuedAt, metadataHash);
    }

    /// @notice Invalidate every pool-page approval made so far.
    function revokePoolPages() external onlyCreator {
        emit PoolPagesRevoked(++pageEpoch);
    }

    /// @notice ERC-1271: valid only for digests approved by `approvePoolPage`; the signature bytes are ignored.
    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4) {
        return pageApprovedEpoch[hash] == pageEpoch + 1 ? ERC1271_MAGIC : bytes4(0xffffffff);
    }

    /*//////////////////////////////////////////////////////////////
                              ADMISSION GATE
    //////////////////////////////////////////////////////////////*/

    /// @notice FWA purchase-operator hook. Must stay read-only and under FWA's 100k gas stipend.
    /// @dev FWA passes the purchaser it will deliver to. Refused: this contract (a failed delivery to it could never
    ///      be refunded, and a delivered NFT would be untracked), the Shapes contract (Shapes rejects self-custody, so
    ///      a drawn Shape could never be delivered or refunded) and the FWA pool itself.
    function canPurchase(address purchaser) external view returns (bool) {
        if (purchaser == address(this) || purchaser == address(SHAPES) || purchaser == address(pool)) return false;
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

    /// @notice Permissionless maintenance: reconcile settled draws, collect proceeds, reprice, restore
    ///         the approved Shapes plan and re-checkpoint. Reverts `NoUpkeepNeeded` when it would change
    ///         nothing and `PoolBusy` while an FWA batch is unresolved; simulate it to learn whether work
    ///         exists and what it pays. Pays `msg.sender` only for reconciling draws or inventory work.
    function performUpkeep() external nonReentrant returns (uint256 reward) {
        uint256 gasStart = gasleft();
        Checkpoint memory before = checkpoint;
        uint8 statusBefore = lastStatus;
        (uint256 ops, bool batchReconciled) = _sync();
        Checkpoint memory afterCp = checkpoint;
        bool changed = ops != 0 || batchReconciled || lastStatus != statusBefore || afterCp.valid != before.valid
            || afterCp.inventoryVersion != before.inventoryVersion || afterCp.reserve != before.reserve
            || afterCp.mintFee != before.mintFee;
        if (!changed) revert NoUpkeepNeeded();
        if (ops != 0 || batchReconciled) reward = _payKeeper(gasStart, ops != 0);
        if (checkpoint.valid) creatorWork = false;
    }

    /// @notice Permissionless: recover a drawn Shape whose FWA delivery was refunded and redeem it for its
    ///         backing. Pays gas only. FWA allows the refund 7 days after the failed delivery, by which
    ///         time upkeep has already replaced the drawn Shape, so the recovered one is surplus.
    ///         (FWA delivers with `transferFrom`; a Shape transfer fails only to the Shapes contract itself.)
    function recoverRefundedShape(uint256 listingId) external nonReentrant returns (uint256 reward) {
        uint256 gasStart = gasleft();
        Item storage it = items[listingId];
        if (it.kind != SHAPE || it.state != PENDING) revert InvalidItem();
        IFWAPool p = pool;
        (,,, uint256 tokenId,,,, uint8 status) = p.listings(listingId);
        if (status != L_DELIVERY_REFUNDED) revert InvalidItem();
        delete items[listingId];
        p.recoverRefundedNFT(listingId);
        uint256[] memory ids = new uint256[](1);
        ids[0] = tokenId;
        uint256 eth = SHAPES.redeemBatch(ids);
        emit ShapeRecovered(listingId, eth);
        reward = _payKeeper(gasStart, false);
    }

    function _sync() internal returns (uint256 ops, bool batchReconciled) {
        IFWAPool p = pool;
        if (p.unsettledAcquisitionCount() != 0) revert PoolBusy();
        checkpoint.valid = false;

        // 1. Reconcile every FWA sequence issued since the last reconciliation (<= MAX_BATCH).
        uint64 last = p.lastIssuedSequence();
        uint256 edgePaid;
        for (uint64 s = reconciledSequence + 1; s <= last; ++s) {
            (,, uint256 escrowed, uint256 lid, uint8 aStatus,) = p.acquisitions(p.requestIdAtSequence(s));
            if (lid != 0) {
                edgePaid += escrowed; // fee incl. edge; converted below
                _onDrawn(lid, aStatus == A_FULFILLED);
                ++ops;
            }
        }
        if (last != reconciledSequence) {
            reconciledSequence = last;
            batchReconciled = true;
            uint256 edge = FWA_FACTORY.edgeBps();
            incentiveCredit = uint128(edgePaid * edge / (BPS + edge)); // a new batch replaces any unspent credit
        }

        // 2. Settled proceeds fund maintenance.
        _collect();

        // 3. Maintain inventory only while open.
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

        // Restore the plan: withdraw and redeem surplus Shapes, then mint deficits.
        uint256 fee = SHAPES.mintFee();
        // One MAX_OPS budget per call, shared with the repricing step that may have just finished.
        (uint256 used, bool complete, bool funded) = _rebalance(p, plan, markup, fee, MAX_OPS - ops);
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
        // Also cover this call's own keeper reward, paid after the checkpoint, so admission holds afterwards.
        if (address(this).balance < reserve + MAX_KEEPER_REWARD) return INSUFFICIENT_RESERVE;
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
        if (delivered) delete items[lid];
        else it.state = PENDING;
        emit ItemDrawn(lid, kind, d, delivered);
    }

    /// @dev Bring up to MAX_OPS listings to the current markup. Every call rescans all active listings
    ///      (<= MAX_LISTINGS), so a removal can never cause a listing to be skipped and an interrupted
    ///      run resumes where the last one stopped. Only `it.price` changes; `it.base` is creator-set.
    function _reprice(IFWAPool p) internal returns (uint256 ops) {
        uint256 n = activeIds.length;
        for (uint256 i; i < n; ++i) {
            uint256 lid = activeIds[i];
            Item storage it = items[lid];
            uint256 price = _priced(it.base);
            if (price == it.price) continue;
            if (ops == MAX_OPS) return ops; // more remain
            p.updatePrice(lid, price);
            it.price = uint112(price);
            ++ops;
            emit ListingRepriced(lid, price);
        }
        repricing = false;
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

    /// @dev Only after a plan change: withdraw Shapes above target from FWA and redeem them.
    function _unlistSurplus(IFWAPool p, uint256 plan, uint256 budget) internal returns (uint256 used) {
        uint256[] memory out = new uint256[](budget);
        for (uint256 d; d < DENOMS && used < budget; ++d) {
            uint256 have = activeShapes[d];
            uint256 target = _count(plan, d);
            uint256 surplus = have > target ? have - target : 0;
            for (uint256 i = activeIds.length; i != 0 && surplus != 0 && used < budget;) {
                Item storage it = items[activeIds[--i]];
                if (it.kind == SHAPE && it.denom == d) {
                    out[used++] = activeIds[i];
                    --surplus;
                }
            }
        }
        if (used == 0) return 0;
        assembly ("memory-safe") {
            mstore(out, used)
        }
        emit ShapesUnlisted(used, _withdrawAndRedeem(p, out));
    }

    /// @dev Stop tracking the given Shape listings, withdraw them from FWA and redeem them here.
    function _withdrawAndRedeem(IFWAPool p, uint256[] memory lids) internal returns (uint256 eth) {
        uint256 n = lids.length;
        if (n == 0) return 0;
        uint256[] memory tokenIds = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 lid = lids[i];
            (,,, tokenIds[i],,,,) = p.listings(lid);
            --activeShapes[items[lid].denom];
            _removeActive(lid);
            delete items[lid];
        }
        p.withdrawListingsTo(lids, address(this));
        eth = SHAPES.redeemBatch(tokenIds);
    }

    /// @dev Mint like-for-like with available ETH and list the new Shapes in one FWA batch.
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
            uint256 cost = need * (_amount(d) + fee);
            if (address(this).balance < cost) {
                funded = false;
                break;
            }
            uint256 first = SHAPES.mintBatch{value: cost}(_amount(d), need);
            emit ShapesMinted(uint8(d), first, need, cost);
            uint256 price = _amount(d) * (BPS + markup) / BPS;
            for (uint256 j; j < need; ++j) {
                batch[used++] = IFWAPool.ListingInput(address(SHAPES), first + j, price);
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

    function _payKeeper(uint256 gasStart, bool incentive) internal returns (uint256 reward) {
        uint256 measured = gasStart - gasleft();
        if (measured > KEEPER_MAX_GAS) measured = KEEPER_MAX_GAS;
        uint256 gasUsed = measured * 4 / 5; // reimbursed gas: never above the billed gas (EIP-3529)
        uint256 price = tx.gasprice;
        uint256 cap = block.basefee + KEEPER_PRIORITY_CAP;
        if (price > cap) price = cap;
        if (price > KEEPER_MAX_GAS_PRICE) price = KEEPER_MAX_GAS_PRICE;
        reward = gasUsed * price;
        uint256 intrinsic = intrinsicCredited ? 0 : INTRINSIC_GAS;
        intrinsicCredited = true;
        uint256 shortfall = (measured - gasUsed + intrinsic) * price;
        if (incentive) {
            uint256 inc = shortfall + KEEPER_MARGIN;
            if (inc < KEEPER_INCENTIVE) inc = KEEPER_INCENTIVE;
            if (!creatorWork) {
                uint256 credit = incentiveCredit;
                if (credit < inc) inc = credit;
                incentiveCredit = uint128(credit - inc);
            }
            reward += inc;
        } else {
            reward += shortfall;
        }
        if (reward > address(this).balance) reward = address(this).balance;
        if (reward == 0) return 0;
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
    ///         plan from current inventory, plus a worst-case batch and two maximum keeper rewards.
    function requiredReserve() public view returns (uint256 r) {
        if (!enabled || plans.length == 0) return 0;
        uint256 plan = plans[activePlan];
        uint256 fee = SHAPES.mintFee();
        uint256 missing;
        for (uint256 d; d < DENOMS; ++d) {
            uint256 have = activeShapes[d];
            uint256 target = _count(plan, d);
            if (target > have) {
                r += (target - have) * (_amount(d) + fee);
                missing += target - have;
            }
        }
        // Keeper rewards: one per refill step still needed, one held in the checkpoint reserve, and one for the
        // call that re-checkpoints (_checkpoint).
        r += (missing + MAX_OPS - 1) / MAX_OPS * MAX_KEEPER_REWARD;
        r += _batchReserve(plan, fee) + 2 * MAX_KEEPER_REWARD;
    }

    function getPlans() external view returns (uint256[] memory) {
        return plans;
    }

    function getActiveIds() external view returns (uint256[] memory) {
        return activeIds;
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

    /// @dev Called only from creator actions.
    function _invalidate() internal {
        checkpoint.valid = false;
        creatorWork = true;
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
        // The whole plan must fit beside the curated listings, or filling it would revert TooManyListings.
        uint256 shapesListed;
        for (uint256 d; d < DENOMS; ++d) {
            shapesListed += activeShapes[d];
        }
        if (activeIds.length - shapesListed + _planShapes(plan) > MAX_LISTINGS) return false;
        Config memory c = config;
        (uint256 sW, uint256 sWP) = _shapeTotals(plan, markup);
        uint256 tW = cW + sW;
        if ((cWP + sWP) / tW * (BPS + edge) / BPS > c.maxDrawPrice) return false;
        return cW * BPS >= uint256(c.minCuratedOddsBps) * tW;
    }

    /// @dev Cash to replace the worst MAX_BATCH Shape draws from a full plan: the largest denominations
    ///      first, each at backing plus the current mint fee.
    function _batchReserve(uint256 plan, uint256 fee) internal pure returns (uint256 r) {
        uint256 left = MAX_BATCH;
        for (uint256 d = DENOMS; d != 0 && left != 0;) {
            --d;
            uint256 n = _count(plan, d);
            if (n > left) n = left;
            r += n * (_amount(d) + fee);
            left -= n;
        }
    }

    function _planShapes(uint256 plan) internal pure returns (uint256 shapes) {
        if (plan >> (16 * DENOMS) != 0) revert InvalidPlan();
        for (uint256 d; d < DENOMS; ++d) {
            shapes += _count(plan, d);
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
