// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {PoolPage} from "./PoolPage.sol";
import {IFWAPoolFactory, IFWAPool, IShapes, IShapePacks, IERC721Min, IENS, IReverseRegistrar} from "./interfaces/External.sol";

/// @dev The keeper list on the BalancerFactory that deployed a Balancer.
interface IKeeperList {
    function canKeep(address keeper) external view returns (bool);
}

/// @title PoolBalancer
/// @notice Permanently owns one FWA standard pool. The creator lists NFTs and sets a target mix of Shape and Draw Pack
///         prizes; anyone (or, while its factory restricts upkeep, approved keepers and the creator) may call
///         `performUpkeep` to restock drawn prizes from this contract's ETH. Players buy on FWA directly; this contract is
///         FWA's purchase operator.
/// @dev Design (money flows in docs/SPEC.md):
///      - FWA prices every draw on its live inventory and refunds draws whose price moved past the player's
///        tolerance, so the gate does not need an exact inventory. It keeps the game close to its design:
///        no new draw while upkeep is finishing creator-started work, while no curated NFT is listed (the pool exists to
///        give NFTs away), while MAX_BATCH draws are unsettled, while the
///        Shapes mint fee is above what the creator accepted, while the prizes' weight, after assuming every
///        unreconciled draw took the heaviest possible prize, is below FILL_BPS of the target's weight. Purchases do not
///        wait for ETH: each prize's price covers replacing it, so after a big win uses the reserve's spare, sales
///        refill it from the first MIN_MARKUP_BPS of markup while the creator keeps the markup above it. `open` needs
///        the reserve in ETH.
///      - Prices are set when a listing is made, at the markup in force then. Nothing is repriced. A Shape prize is
///        listed at its backing, its Shapes mint fees and the markup on its backing, plus a restocking fee per Shape
///        from the basefee then. That fee pays the keeper who lists the prize, in the same call, so it matches the gas
///        actually spent; the pool's ETH fronts it and the player who later wins the prize repays it in the price.
///      - Upkeep reconciles settled FWA sequences in order (MAX_RECONCILE per call) and restocks while draws are still
///        unsettled; FWA stages those listings and activates them in order.
///      - While open, the creator cannot withdraw the cost of restoring the target, plus one largest prize for each
///        unreconciled draw and one spare, plus keeper rewards for that work. `open` needs it in ETH.
///      - Only this contract can list into the pool (FWA `OwnerOnlyInventory`).
///      - Prize tokens are held only inside a transaction: minted then listed, or withdrawn then redeemed. Any NFT this
///        contract owns between transactions is untracked and creator-recoverable.
///      - No function sends ETH or NFTs to an address chosen by anyone but the creator, except the bounded keeper
///        reward to `msg.sender` of `performUpkeep`.
contract PoolBalancer is ReentrancyGuard {
    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 internal constant BPS = 10_000;
    /// @dev FWA `maxAcquisitionsPerTx`; verified against the FWA factory at pool creation. Also the unsettled-draw cap.
    uint256 public constant MAX_BATCH = 5;
    /// @dev Prize sizes: indices 0-8 are the nine Shapes denominations (each prize one Shape); indices 9-15 are values
    ///      between them, each prize one Draw Pack holding the fewest Shapes that sum to it (see `_amount`, `_makeup`).
    ///      A target packs sixteen 16-bit counts into one uint256.
    uint256 internal constant DENOMS = 16;
    uint256 internal constant SHAPE_DENOMS = 9;
    /// @dev Size values in units of 0.01 ETH, 16 bits each, size 0 in the low bits:
    ///      0.01 0.05 0.1 0.5 1 5 10 50 100 | 0.02 0.03 0.2 0.25 2 2.5 25.
    uint256 internal constant AMOUNTS = 0x9c400fa00c800190014000300022710138803e801f400640032000a00050001;
    /// @dev Shapes inside one prize of each size, 4 bits each (1 for a Shape; 2 or 3 for a pack).
    uint256 internal constant SHAPES_IN = 0x3323232111111111;
    /// @dev Size indices in ascending value order, 4 bits each, smallest first.
    uint256 internal constant BY_VALUE = 0x87f65ed43cb21a90;
    /// @dev The most Shapes any one prize holds.
    uint256 internal constant MAX_SHAPES_IN = 3;
    uint256 internal constant MAX_SHAPES_PER_PLAN = 80;
    /// @dev Inventory work per upkeep, in Shape units: minting+listing or withdrawing+redeeming one Shape is 1; a pack
    ///      counts as the Shapes it holds (measured: ~425k gas per Shape with its listing, ~870k per three-Shape pack).
    ///      Six units with five reconciles measured 3.13M against KEEPER_MAX_GAS; five keeps a margin.
    uint256 internal constant MAX_OPS = 5;
    /// @dev Settled FWA sequences reconciled per upkeep call (~33k gas each), one FWA batch.
    uint256 internal constant MAX_RECONCILE = 5;
    /// @dev Prize sizes restocked per upkeep call: each size is its own mint call (~0.5M gas with its listing). Six sizes
    ///      in one call measured 3.19M against KEEPER_MAX_GAS.
    uint256 internal constant MAX_RESTOCK_SIZES = 4;
    uint256 internal constant MAX_MARKUP_BPS = 10_000;
    /// @dev The game's share of every markup: the only profit in a prize's price, so the part that refills the reserve
    ///      after a big win. The creator's profit is the markup above it.
    uint256 internal constant MIN_MARKUP_BPS = 1_000;
    /// @dev Purchases need the listed prizes' weight, less the unreconciled-draw allowance, at this share of the target's.
    uint256 internal constant FILL_BPS = 7_000;
    uint256 internal constant INVERSE_WEIGHT_NUMERATOR = 1e36; // FWA StandardPool constant
    /// @dev The heaviest prize listing: the smallest prize (0.01 ETH) at zero markup.
    uint256 internal constant MAX_PRIZE_WEIGHT = INVERSE_WEIGHT_NUMERATOR / 0.01 ether;

    // Keeper compensation (docs/GAS.md; collection-games#23 for the exploit the price bound prevents):
    // - price = min(tx.gasprice, basefee + KEEPER_PRIORITY_CAP, KEEPER_MAX_GAS_PRICE). Upkeep is permissionless, so
    //   competing keepers bid whatever priority is reimbursed; the cap is what the pool pays above basefee.
    // - reward = measured gas (capped) x price + KEEPER_INCENTIVE, which covers the keeper's gas outside the
    //   measured span.
    // - Work a creator action started (`creatorWork`: open, configure, unlisting) is paid in full from the creator's
    //   ETH; purchases are refused until it is done. All other rewards come out of `keeperCredit`, which grows by the
    //   restocking fees of the prizes each call lists, so lifetime keeper pay never exceeds the fees priced into the
    //   prizes keepers listed and never touches the creator's markup.
    // - Restocking fee per Shape = RESTOCK_FEE_GAS x min(basefee + KEEPER_PRIORITY_CAP, KEEPER_MAX_GAS_PRICE) +
    //   RESTOCK_FEE_FLAT, at the listing block. Fee and work share a block, so the fee tracks the gas the listing call
    //   pays at any basefee up to the cap (above it keepers wait); basefee is not the caller's to choose. The pool's
    //   ETH fronts the fee until a player wins that prize; fees of prizes unlisted or never drawn are the creator's
    //   cost, at most the target's Shapes x restockFee(). Unspent credit pays reconcile-only calls until `close`
    //   returns it to the creator.
    // - A deficit to restock needs a paid draw (or a creator action, which earns no credit), so buying one's own draws
    //   pays the price, FWA's edge and the VRF fee for at most KEEPER_INCENTIVE of profit per call.
    uint256 internal constant KEEPER_MAX_GAS = 3_200_000;
    uint256 internal constant KEEPER_PRIORITY_CAP = 0.05 gwei;
    uint256 internal constant KEEPER_MAX_GAS_PRICE = 5 gwei;
    uint256 internal constant KEEPER_INCENTIVE = 0.0005 ether;
    uint256 public constant MAX_KEEPER_REWARD = KEEPER_MAX_GAS * KEEPER_MAX_GAS_PRICE + KEEPER_INCENTIVE;
    /// @dev With RESTOCK_FEE_FLAT, covers an upkeep that reconciles one draw and restocks one Shape (measured 763k-864k
    ///      gas across pools and blocks; Shapes mint gas varies with the block) at any basefee up to the cap.
    uint256 internal constant RESTOCK_FEE_GAS = 900_000;
    uint256 internal constant RESTOCK_FEE_FLAT = 0.0002 ether;

    uint256 internal constant ACQUISITIONS_ENABLED_KEY = 41; // FWAConfigKeys.ACQUISITIONS_ENABLED
    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;
    bytes32 internal constant ADDR_REVERSE_NODE = 0x91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2;

    // FWA ListingStatus / AcquisitionStatus values.
    uint8 internal constant L_DELIVERY_REFUNDED = 7;
    uint8 internal constant A_FULFILLED = 2;

    // Item kinds and states.
    uint8 internal constant CURATED = 1;
    uint8 internal constant SHAPE = 2; // a Shape or Draw Pack prize
    uint8 internal constant ACTIVE = 1;
    uint8 internal constant PENDING = 2; // drawn, FWA delivery failed; resolved per item, never scanned

    // `admissionStatus` codes. Zero means purchases are admitted.
    uint8 internal constant OK = 0;
    uint8 internal constant CLOSED = 1;
    uint8 internal constant SETTING_UP = 2;
    uint8 internal constant NO_CURATED = 3;
    uint8 internal constant BUSY = 4;
    uint8 internal constant MINT_FEE_ROSE = 5;
    uint8 internal constant LOW_INVENTORY = 6;

    /*//////////////////////////////////////////////////////////////
                               IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    IFWAPoolFactory public immutable FWA_FACTORY;
    address public immutable FWA_IMPLEMENTATION;
    bytes32 public immutable FWA_IMPLEMENTATION_CODEHASH;
    IShapes public immutable SHAPES;
    IShapePacks public immutable PACKS;
    IENS public immutable ENS;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    struct Item {
        uint8 kind;
        uint8 denom;
        uint8 state;
        uint16 markupBps; // markup when listed: the creator's part of a Shape prize's price is its backing x this
        uint104 base; // creator value (curated) or the price less its restocking fees: backing, mint fees, markup (Shape)
        uint104 price; // price listed on FWA
    }

    address public creator;
    address public pendingCreator;
    IFWAPool public pool;

    /// @dev Prize counts per size, sixteen 16-bit counts, size 0 in the low bits.
    uint256 public target;
    uint16 public markupBps;
    bool public enabled;
    /// @dev True from a creator action until upkeep has restored the target (see keeper compensation above).
    bool public creatorWork;
    uint64 public reconciledSequence;
    /// @dev Restocking fees of prizes keepers listed (price less `base`, outside creator work), not yet paid out.
    uint128 public keeperCredit;
    /// @dev The creator's part of payments collected while the fund was below `requiredReserve`, not yet claimed:
    ///      the markup above MIN_MARKUP_BPS. The fund keeps the rest of each payment, MIN_MARKUP_BPS of markup included.
    uint128 public profit;
    /// @dev The Shapes mint fee when the creator last configured; purchases and restocking stop above it.
    uint256 public mintFeeCap;
    /// @dev Weight (1e36 / `base`) of the listed prizes (staged or active, not yet reconciled as drawn) and of the
    ///      target. `base` leaves out the basefee-indexed restocking fee, so fill does not move with gas.
    uint256 public prizeWeight;
    uint256 public targetWeight;

    mapping(uint256 listingId => Item) internal _items;
    /// @dev Sum over active Shape prizes of (markup above MIN_MARKUP_BPS, on its backing) x 1e18 / price: the creator's
    ///      share of FWA's expected-value payment is this / (active listings x 1e18), since FWA weights each listing by
    ///      1 / price. Curated NFTs count zero: proceeds are split at collection, against the listings then, so
    ///      counting them would let a creator list NFTs just before a collection to move fund money into profit. NFT
    ///      sale money stays in the fund while it is short and is claimable once it is full. A Shape's share is below
    ///      markup / (1 + markup) <= 1/2, so the fund always keeps at least half of each payment.
    uint256 public profitShareSum;
    uint256[] internal activeIds;
    mapping(uint256 listingId => uint256) internal activeIndexPlusOne;
    uint16[16] internal activeShapes;
    /// @dev Pool-page approvals are valid only in the epoch they were made; `revokePoolPages` and every creator
    ///      change start a new epoch, so a former creator's approvals cannot be replayed.
    uint256 public pageEpoch;
    mapping(bytes32 digest => uint256) internal pageApprovedEpoch; // epoch + 1
    /// @dev The factory that deployed this Balancer: its keeper list decides who besides the creator may run upkeep.
    IKeeperList public factory;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event Initialized(address indexed creator, address indexed pool);
    event CreatorTransferStarted(address indexed creator, address indexed pendingCreator);
    event CreatorTransferred(address indexed oldCreator, address indexed newCreator);
    event Configured(uint16 markupBps, uint256 target, uint256 mintFeeCap);
    event PurchasesOpened();
    event PurchasesClosed();
    event CuratedListed(uint256 indexed listingId, address indexed collection, uint256 tokenId, uint256 base, uint256 price);
    event CuratedRepriced(uint256 indexed listingId, uint256 base, uint256 price);
    event CuratedWithdrawn(uint256 indexed listingId, address indexed to);
    event RefundedRecovered(uint256 indexed listingId, address indexed to, uint256 eth);
    event UntrackedNFTRecovered(address indexed collection, uint256 tokenId, address indexed to);
    event ItemDrawn(uint256 indexed listingId, uint8 kind, uint8 denom, bool delivered);
    event ShapesMinted(uint8 indexed denom, uint256 firstTokenId, uint256 quantity, uint256 cost);
    event ShapeListed(uint256 indexed listingId, uint8 indexed denom, uint256 tokenId, uint256 price);
    event ShapesUnlisted(uint256 count, uint256 ethRedeemed);
    event KeeperPaid(address indexed keeper, uint256 amount, uint256 gasUsed);
    event Deposited(address indexed from, uint256 amount);
    event ProceedsCollected(uint256 amount);
    event SurplusClaimed(address indexed to, uint256 amount);
    event PoolRetired();
    event ENSNameSet(string name);
    event PoolPageApproved(bytes32 indexed digest, string issuedAt, bytes32 metadataHash);
    event PoolPagesRevoked(uint256 epoch);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error Unauthorized();
    error KeeperNotApproved();
    error AlreadyInitialized();
    error UnreviewedImplementation();
    error UnsupportedFWAConfig();
    error InvalidConfig();
    error InvalidPlan();
    error InvalidItem();
    error InvalidRecipient();
    error ValueTooHigh();
    error ShapesNotCurated();
    error NotClosed();
    error InsufficientSurplus();
    error ReserveNotFunded();
    error NoUpkeepNeeded();
    error InvalidBatch();
    error ProtectedAsset();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(address fwaFactory, address fwaImplementation, bytes32 fwaCodehash, address shapes, address packs, address ens) {
        FWA_FACTORY = IFWAPoolFactory(fwaFactory);
        FWA_IMPLEMENTATION = fwaImplementation;
        FWA_IMPLEMENTATION_CODEHASH = fwaCodehash;
        SHAPES = IShapes(shapes);
        PACKS = IShapePacks(packs);
        ENS = IENS(ens);
        // The size table below is hardcoded; refuse a Shapes deployment that disagrees, and a Packs instance that
        // wraps other Shapes or cannot make the smallest pack size.
        // Draw Packs takes one mint count per Shapes size (`_makeup` has nine).
        if (IShapes(shapes).denominationCount() != SHAPE_DENOMS) revert UnsupportedFWAConfig();
        for (uint256 d; d < SHAPE_DENOMS; ++d) {
            if (IShapes(shapes).denominationAt(uint8(d)) != _amount(d)) revert UnsupportedFWAConfig();
        }
        if (IShapePacks(packs).shapes() != shapes || IShapePacks(packs).MIN_PACK_VALUE() > _amount(9)) {
            revert UnsupportedFWAConfig();
        }
        creator = address(1); // lock the implementation
    }

    /// @notice Called once by BalancerFactory in the clone's deployment transaction. Creates the FWA
    ///         pool owned by this contract and installs this contract as its purchase operator.
    function initialize(address creator_) external payable {
        if (creator != address(0)) revert AlreadyInitialized();
        if (creator_ == address(0)) revert InvalidRecipient();
        creator = creator_;
        factory = IKeeperList(msg.sender); // the BalancerFactory, in the same transaction as the clone

        IFWAPoolFactory fwa = FWA_FACTORY;
        if (FWA_IMPLEMENTATION.codehash != FWA_IMPLEMENTATION_CODEHASH) revert UnreviewedImplementation();
        // A staging cap would make restocking while draws are unsettled revert (FWA StagingQueueFull), and with it upkeep.
        if (fwa.maxAcquisitionsPerTx() != MAX_BATCH || fwa.maxStagedListings() != 0) revert UnsupportedFWAConfig();
        // Reverts inside FWA if the factory's implementation is not the reviewed one.
        address p = fwa.createPool(bytes32(0), FWA_IMPLEMENTATION);
        if (fwa.poolImplementation(p) != FWA_IMPLEMENTATION || IFWAPool(p).owner() != address(this)) {
            revert UnreviewedImplementation();
        }
        pool = IFWAPool(p);
        IFWAPool(p).setPurchaseOperator(address(this));
        SHAPES.setApprovalForAll(p, true);
        PACKS.setApprovalForAll(p, true);

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

    /// @notice Set the markup for new listings and the target prize mix, and accept the current Shapes mint fee.
    /// @dev Existing listings keep their prices. A smaller target leaves extra prizes listed until `unlistShapes`.
    function configure(uint16 newMarkupBps, uint256 newTarget) external onlyCreator {
        if (newMarkupBps < MIN_MARKUP_BPS || newMarkupBps > MAX_MARKUP_BPS) revert InvalidConfig();
        if (newTarget >> (16 * DENOMS) != 0) revert InvalidPlan();
        uint256 fee = SHAPES.mintFee();
        uint256 prizes;
        uint256 w;
        for (uint256 d; d < DENOMS; ++d) {
            uint256 n = _count(newTarget, d);
            if (n == 0) continue;
            prizes += n;
            w += n * (INVERSE_WEIGHT_NUMERATOR / _prizeBase(d, fee, newMarkupBps));
        }
        if (prizes == 0 || prizes > MAX_SHAPES_PER_PLAN) revert InvalidPlan();
        markupBps = newMarkupBps;
        target = newTarget;
        targetWeight = w;
        mintFeeCap = fee;
        _creatorChanged();
        emit Configured(newMarkupBps, newTarget, fee);
    }

    /// @notice Allow purchases; they start once upkeep has restored the target. Needs `requiredReserve` in ETH, so a
    ///         pool never opens without the ETH to stock its target and restock a big win.
    function open() external onlyCreator {
        if (target == 0) revert InvalidConfig();
        enabled = true;
        _creatorChanged();
        if (address(this).balance + pool.ownerProceeds() < requiredReserve()) revert ReserveNotFunded();
        pool.setBool(ACQUISITIONS_ENABLED_KEY, true);
        emit PurchasesOpened();
    }

    /// @notice Stop new purchases immediately. Outstanding FWA draws, refunds and claims are unaffected. Unspent keeper
    ///         credit returns to the creator: closing frees the whole balance, so credit left standing would later be
    ///         paid from fresh deposits. Upkeep after closing earns keepers nothing.
    function close() external onlyCreator {
        enabled = false;
        creatorWork = false;
        keeperCredit = 0;
        profit = 0; // the whole balance is claimable while closed
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

    /// @notice Pull an NFT from the creator (approve this contract first) and list it on FWA at `base` plus the markup.
    function listCurated(address collection, uint256 tokenId, uint256 base)
        external
        onlyCreator
        nonReentrant
        returns (uint256 listingId)
    {
        _collect();
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
        uint256 n = inputs.length;
        if (n == 0 || n > 20) revert InvalidBatch();
        _collect();
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

    /// @notice Set a curated NFT's value; it is listed at that value plus the current markup.
    ///         FWA allows this only while no draw is unsettled.
    function updateCuratedPrice(uint256 listingId, uint256 newBase) external onlyCreator nonReentrant {
        Item storage it = _items[listingId];
        if (it.kind != CURATED || it.state != ACTIVE) revert InvalidItem();
        uint256 price = _priced(newBase);
        it.base = uint104(newBase);
        if (price != it.price) {
            pool.updatePrice(listingId, price);
            it.price = uint104(price);
        }
        emit CuratedRepriced(listingId, newBase, price);
    }

    /// @notice Withdraw an active curated listing from FWA directly to `to`. FWA allows this only while no draw is
    ///         unsettled.
    function withdrawCurated(uint256 listingId, address to) external onlyCreator nonReentrant {
        Item storage it = _items[listingId];
        if (it.kind != CURATED || it.state != ACTIVE) revert InvalidItem();
        if (to == address(0)) revert InvalidRecipient();
        _collect();
        _removeActive(listingId);
        delete _items[listingId];
        pool.withdrawListingTo(listingId, to);
        emit CuratedWithdrawn(listingId, to);
    }

    /// @notice Recover an item whose FWA delivery was refunded to its winner: a curated NFT goes to `to`; a Shape or
    ///         pack is redeemed here for its backing. FWA allows the refund 7 days after the failed delivery.
    ///         Upkeep never touches curated collections, so a hostile collection cannot burn keeper gas or block upkeep.
    function recoverRefunded(uint256 listingId, address to) external onlyCreator nonReentrant returns (uint256 eth) {
        Item storage it = _items[listingId];
        if (it.state != PENDING || to == address(0)) revert InvalidItem();
        (address collection,,, uint256 tokenId,,,, uint8 status) = pool.listings(listingId);
        if (status != L_DELIVERY_REFUNDED) revert InvalidItem();
        uint8 kind = it.kind;
        uint8 d = it.denom;
        delete _items[listingId];
        pool.recoverRefundedNFT(listingId);
        if (kind == CURATED) IERC721Min(collection).safeTransferFrom(address(this), to, tokenId);
        else eth = _redeem(d, tokenId);
        emit RefundedRecovered(listingId, to, eth);
    }

    /// @notice Return an NFT this contract holds outside FWA, e.g. one sent to it directly.
    /// @dev Tracked inventory is never held here between transactions: listings and pending deliveries
    ///      are owned by the FWA pool, prizes are minted-and-listed or withdrawn-and-redeemed within one
    ///      call, and refunded NFTs are pulled from FWA only inside `recoverRefunded`. So
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

    /// @notice Withdraw up to `withdrawableSurplus`. Claims spend unclaimed `profit` first, so the fund never pays them.
    function claimSurplus(uint256 amount, address to) external onlyCreator nonReentrant {
        if (to == address(0)) revert InvalidRecipient();
        _collect();
        if (amount > withdrawableSurplus()) revert InsufficientSurplus();
        uint256 mine = profit;
        profit = amount < mine ? uint128(mine - amount) : 0;
        SafeTransferLib.safeTransferETH(to, amount);
        emit SurplusClaimed(to, amount);
    }

    /// @notice Withdraw up to 20 listed Shape or pack prizes from FWA and redeem them here for their backing: extra
    ///         prizes after a smaller target, or everything after closing. FWA allows this only while no draw is
    ///         unsettled. Prizes withdrawn below the target while open are restocked by upkeep.
    function unlistShapes(uint256[] calldata listingIds) external onlyCreator nonReentrant {
        uint256 n = listingIds.length;
        if (n == 0 || n > 20) revert InvalidBatch();
        uint256[] memory ids = listingIds;
        for (uint256 i; i < n; ++i) {
            Item storage it = _items[ids[i]];
            if (it.kind != SHAPE || it.state != ACTIVE) revert InvalidItem();
        }
        _collect();
        emit ShapesUnlisted(n, _withdrawAndRedeem(pool, ids));
        _creatorChanged();
    }

    /// @notice Irreversibly retire the FWA pool. Withdrawals, unlisting and recovery remain available.
    function retire() external onlyCreator {
        if (enabled) revert NotClosed();
        pool.retirePool();
        emit PoolRetired();
    }

    /*//////////////////////////////////////////////////////////////
                                   ENS
    //////////////////////////////////////////////////////////////*/

    /// @notice Set this contract's ENS reverse record via the current `addr.reverse` registrar ("" clears it).
    function setENSName(string calldata name) external onlyCreator {
        IReverseRegistrar(ENS.owner(ADDR_REVERSE_NODE)).setName(name);
        emit ENSNameSet(name);
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
        digest = PoolPage.digest(address(FWA_FACTORY), address(pool), issuedAt, metadataHash);
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
    ///      be refunded, and a delivered NFT would be untracked), the Shapes and Draw Packs contracts (each rejects
    ///      self-custody, so a drawn prize could never be delivered or refunded) and the FWA pool itself.
    function canPurchase(address purchaser) external view returns (bool) {
        if (
            purchaser == address(this) || purchaser == address(SHAPES) || purchaser == address(PACKS)
                || purchaser == address(pool)
        ) return false;
        return admissionStatus() == OK;
    }

    /// @notice Why purchases are or are not admitted right now (see status codes).
    /// @dev FWA calls the hook before it activates staged listings, so the fill check uses tracked prize weight
    ///      (including staged restocks) and assumes each unreconciled draw removed the heaviest possible prize.
    function admissionStatus() public view returns (uint8) {
        if (!enabled) return CLOSED;
        if (creatorWork) return SETTING_UP;
        if (activeIds.length == _listedShapes()) return NO_CURATED;
        IFWAPool p = pool;
        if (p.unsettledAcquisitionCount() >= MAX_BATCH) return BUSY;
        if (SHAPES.mintFee() > mintFeeCap) return MINT_FEE_ROSE;
        uint256 lost = (p.lastIssuedSequence() - reconciledSequence) * MAX_PRIZE_WEIGHT;
        uint256 w = prizeWeight;
        if (w < lost || (w - lost) * BPS < FILL_BPS * targetWeight) return LOW_INVENTORY;
        return OK;
    }

    /*//////////////////////////////////////////////////////////////
                                 UPKEEP
    //////////////////////////////////////////////////////////////*/

    /// @notice Permissionless maintenance: reconcile settled draws, collect proceeds and restock toward the target.
    ///         Reverts `NoUpkeepNeeded` when it would change nothing; simulate it to learn whether work exists and
    ///         what it pays. Pays `msg.sender` only for reconciling draws or inventory work.
    function performUpkeep() external nonReentrant returns (uint256 reward) {
        if (msg.sender != creator && !factory.canKeep(msg.sender)) revert KeeperNotApproved();
        uint256 gasStart = gasleft();
        IFWAPool p = pool;

        // 1. Collect settled proceeds before reconciling: each draw was priced on the listings still tracked, so the
        //    split must see them (reconciling first would drop the won listing and skew the share).
        bool collected = _collect() != 0;

        // 2. Reconcile settled FWA sequences in order. Processed sequences are final: their listing is fixed.
        uint64 s = reconciledSequence;
        uint64 end = p.nextSequenceToProcess() - 1;
        if (end > s + MAX_RECONCILE) end = s + uint64(MAX_RECONCILE);
        while (s < end) {
            (,,, uint256 lid, uint8 aStatus,) = p.acquisitions(p.requestIdAtSequence(++s));
            if (lid != 0) _onDrawn(lid, aStatus == A_FULFILLED);
        }
        bool reconciled = s != reconciledSequence;
        if (reconciled) reconciledSequence = s;

        // 3. Restock while open.
        uint256 ops;
        bool wasSetup = creatorWork;
        if (enabled && !p.retired() && !FWA_FACTORY.globalWithdrawOnly()) {
            uint256 fee = SHAPES.mintFee();
            if (fee <= mintFeeCap) {
                ops = _fillDeficit(p, fee);
                // This call's listings carry `ops` restocking fees at this block's basefee: they pay for this call.
                if (!wasSetup) keeperCredit += uint128(ops * restockFee());
                if (wasSetup && _missingUnits() == 0) creatorWork = false;
            }
        }

        if (!reconciled && ops == 0 && !collected && creatorWork == wasSetup) revert NoUpkeepNeeded();
        if (ops != 0 || reconciled) reward = _payKeeper(gasStart, wasSetup);
        // Game first: restocking may spend unclaimed profit once the fund is empty.
        if (profit > address(this).balance) profit = uint128(address(this).balance);
    }

    function _onDrawn(uint256 lid, bool delivered) internal {
        Item storage it = _items[lid];
        // Every pool listing is ours and tracked until drawn. Never revert here: reconciliation must not be bricked.
        if (it.state != ACTIVE) return;
        uint8 kind = it.kind;
        uint8 d = it.denom;
        _removeActive(lid);
        if (kind == SHAPE) {
            --activeShapes[d];
            prizeWeight -= INVERSE_WEIGHT_NUMERATOR / it.base;
        }
        if (delivered) {
            delete _items[lid];
        } else {
            it.state = PENDING;
        }
        emit ItemDrawn(lid, kind, d, delivered);
    }

    /// @dev Stop tracking the given prize listings, withdraw them from FWA and redeem each here.
    function _withdrawAndRedeem(IFWAPool p, uint256[] memory lids) internal returns (uint256 eth) {
        uint256 n = lids.length;
        uint256[] memory tokenIds = new uint256[](n);
        uint8[] memory sizes = new uint8[](n);
        for (uint256 i; i < n; ++i) {
            uint256 lid = lids[i];
            (,,, tokenIds[i],,,,) = p.listings(lid);
            Item storage it = _items[lid];
            uint8 d = it.denom;
            sizes[i] = d;
            --activeShapes[d];
            prizeWeight -= INVERSE_WEIGHT_NUMERATOR / it.base;
            _removeActive(lid);
            delete _items[lid];
        }
        p.withdrawListingsTo(lids, address(this));
        for (uint256 i; i < n; ++i) {
            eth += _redeem(sizes[i], tokenIds[i]);
        }
    }

    /// @dev Redeem one prize token this contract holds for its exact backing. Shapes and Draw Packs share
    ///      `redeem(uint256)`, which pays the owner (this contract) and burns the token.
    function _redeem(uint8 d, uint256 tokenId) internal returns (uint256 eth) {
        uint256 before = address(this).balance;
        IShapePacks(d < SHAPE_DENOMS ? address(SHAPES) : address(PACKS)).redeem(tokenId);
        eth = address(this).balance - before;
    }

    /// @dev Mint missing prizes, smallest value first, within MAX_OPS Shape units, MAX_RESTOCK_SIZES sizes and the ETH
    ///      left after this call's keeper reward, and list them at `_prizeBase` plus the restocking fees in one FWA
    ///      batch. FWA stages the batch while draws are unsettled. Returns Shape units used.
    function _fillDeficit(IFWAPool p, uint256 fee) internal returns (uint256 used) {
        uint256 plan = target;
        uint256 markup = markupBps;
        uint256 keep = _rewardBound(_rewardPrice(tx.gasprice));
        uint256 restock = restockFee();
        IFWAPool.ListingInput[] memory batch = new IFWAPool.ListingInput[](MAX_OPS);
        uint8[] memory sizes = new uint8[](MAX_OPS);
        uint256 n;
        uint256 restocked; // sizes
        for (uint256 k; k < DENOMS; ++k) {
            uint256 d = (BY_VALUE >> (4 * k)) & 0xF;
            uint256 have = activeShapes[d];
            uint256 want = _count(plan, d);
            if (have >= want) continue;
            uint256 w = _shapesIn(d);
            uint256 need = want - have;
            if (need > (MAX_OPS - used) / w) need = (MAX_OPS - used) / w;
            uint256 each = _cost(d, fee);
            uint256 bal = address(this).balance;
            uint256 affordable = bal > keep ? (bal - keep) / each : 0;
            if (need > affordable) need = affordable;
            if (need == 0) break; // stop at the first size not fully restocked, so restocking stays in value order
            uint256 price = _prizeBase(d, fee, markup) + w * restock;
            if (d < SHAPE_DENOMS) {
                uint256 first = SHAPES.mintBatch{value: need * each}(_amount(d), need);
                emit ShapesMinted(uint8(d), first, need, need * each);
                for (uint256 j; j < need; ++j) {
                    sizes[n] = uint8(d);
                    batch[n++] = IFWAPool.ListingInput(address(SHAPES), first + j, price);
                }
            } else {
                // One pack per prize, each minting its Shapes inside; the pack token comes to this contract.
                uint32[] memory makeup = _makeup(d);
                for (uint256 j; j < need; ++j) {
                    uint256 id = PACKS.createPackTo{value: each}(new uint256[](0), makeup, address(this));
                    if (j == 0) emit ShapesMinted(uint8(d), id, need, need * each);
                    sizes[n] = uint8(d);
                    batch[n++] = IFWAPool.ListingInput(address(PACKS), id, price);
                }
            }
            used += need * w;
            if (need < want - have || ++restocked == MAX_RESTOCK_SIZES) break;
        }
        if (n == 0) return 0;
        assembly ("memory-safe") {
            mstore(batch, n)
        }
        uint256[] memory lids = p.listNFTs(batch);
        uint256 added;
        for (uint256 i; i < n; ++i) {
            uint8 d = sizes[i];
            uint256 base = _prizeBase(d, fee, markup);
            _items[lids[i]] = Item(SHAPE, d, ACTIVE, uint16(markup), uint104(base), uint104(batch[i].price));
            _addActive(lids[i]);
            ++activeShapes[d];
            added += INVERSE_WEIGHT_NUMERATOR / base;
            emit ShapeListed(lids[i], d, batch[i].tokenId, batch[i].price);
        }
        prizeWeight += added;
    }

    function _payKeeper(uint256 gasStart, bool setup) internal returns (uint256 reward) {
        uint256 measured = gasStart - gasleft();
        if (measured > KEEPER_MAX_GAS) measured = KEEPER_MAX_GAS;
        reward = measured * _rewardPrice(tx.gasprice) + KEEPER_INCENTIVE;
        uint256 credit = keeperCredit;
        if (!setup && reward > credit) reward = credit;
        if (reward > address(this).balance) reward = address(this).balance;
        if (reward == 0) return 0;
        if (!setup) keeperCredit = uint128(credit - reward);
        SafeTransferLib.forceSafeTransferETH(msg.sender, reward);
        emit KeeperPaid(msg.sender, reward, measured);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice ETH the creator may claim now: everything above `requiredReserve`, or the unclaimed `profit` while the
    ///         fund is below it. Everything while closed.
    function withdrawableSurplus() public view returns (uint256) {
        uint256 bal = address(this).balance;
        uint256 req = requiredReserve();
        uint256 free = bal > req ? bal - req : 0;
        uint256 mine = profit;
        return mine > free ? mine : free;
    }

    /// @notice ETH that must stay here while open: restoring the target from tracked inventory, one largest prize for
    ///         each unreconciled draw and one spare (so a big win is restocked), and a maximum keeper reward for each
    ///         upkeep call that work takes plus one. Zero while closed.
    function requiredReserve() public view returns (uint256 r) {
        if (!enabled) return 0;
        uint256 plan = target;
        // Restocking runs at any fee up to the accepted cap; above it, the live fee is the higher of the two.
        uint256 fee = SHAPES.mintFee();
        if (fee < mintFeeCap) fee = mintFeeCap;
        uint256 units;
        uint256 largest;
        for (uint256 d; d < DENOMS; ++d) {
            uint256 want = _count(plan, d);
            if (want == 0) continue;
            uint256 c = _cost(d, fee);
            if (c > largest) largest = c;
            uint256 have = activeShapes[d];
            if (want > have) {
                r += (want - have) * c;
                units += (want - have) * _shapesIn(d);
            }
        }
        uint256 draws = pool.lastIssuedSequence() - reconciledSequence + 1;
        r += draws * largest;
        units += draws * MAX_SHAPES_IN;
        r += ((units + MAX_OPS - 1) / MAX_OPS + 1) * MAX_KEEPER_REWARD;
    }

    /// @notice A tracked listing: kind (1 curated, 2 Shape or pack), size, state, `base` and FWA price.
    function items(uint256 listingId) external view returns (uint8 kind, uint8 denom, uint8 state, uint112 base, uint112 price) {
        Item storage it = _items[listingId];
        return (it.kind, it.denom, it.state, it.base, it.price);
    }

    function getActiveIds() external view returns (uint256[] memory) {
        return activeIds;
    }

    function getActiveShapes() external view returns (uint16[16] memory) {
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

    /// @dev After a creator action changes inventory or the target: purchases wait for upkeep to restore the target
    ///      (paid in full), unless it already holds.
    function _creatorChanged() internal {
        creatorWork = enabled && _missingUnits() != 0;
    }

    /// @dev Collect FWA proceeds and split them by the listed prices. Callers collect before changing the tracked
    ///      listings, so the split uses the set the collected draws were priced on. While the fund (this balance less unclaimed
    ///      `profit`) is below `requiredReserve`, the Shapes' markup above MIN_MARKUP_BPS becomes claimable `profit`
    ///      and the fund keeps the rest; at or above it, everything over the reserve is claimable anyway.
    function _collect() internal returns (uint256 amount) {
        IFWAPool p = pool;
        if (p.ownerProceeds() == 0) return 0;
        amount = p.withdrawOwnerProceeds();
        emit ProceedsCollected(amount);
        uint256 n = activeIds.length;
        if (!enabled || n == 0) return amount;
        uint256 mine = amount * profitShareSum / (n * 1e18);
        if (mine > amount) mine = amount;
        // profit <= the balance before this payment, so this cannot underflow.
        uint256 fund = address(this).balance - mine - profit;
        if (fund < requiredReserve()) profit += uint128(mine);
    }

    function _priced(uint256 base) internal view returns (uint256 price) {
        price = base * (BPS + markupBps) / BPS;
        if (base == 0 || price > type(uint104).max) revert ValueTooHigh();
    }

    function _pullCurated(address collection, uint256 tokenId, uint256 base) internal returns (uint256 price) {
        if (collection == address(SHAPES) || collection == address(PACKS)) revert ShapesNotCurated();
        IERC721Min(collection).transferFrom(msg.sender, address(this), tokenId);
        if (IERC721Min(collection).ownerOf(tokenId) != address(this)) revert InvalidItem();
        IERC721Min(collection).approve(address(pool), tokenId);
        // Priced after the collection's calls: a creator-controlled collection may reconfigure the markup inside them.
        price = _priced(base);
    }

    function _recordCurated(uint256 lid, address collection, uint256 tokenId, uint256 base, uint256 price) internal {
        _items[lid] = Item(CURATED, 0, ACTIVE, markupBps, uint104(base), uint104(price));
        _addActive(lid);
        emit CuratedListed(lid, collection, tokenId, base, price);
    }

    function _addActive(uint256 lid) internal {
        activeIds.push(lid);
        activeIndexPlusOne[lid] = activeIds.length;
        profitShareSum += _share(lid);
    }

    /// @dev A Shape prize's markup above MIN_MARKUP_BPS as a fraction of its price, scaled by 1e18; zero for a curated
    ///      NFT. Shapes are listed only after `configure`, so their markup is at least the minimum.
    function _share(uint256 lid) internal view returns (uint256) {
        Item storage it = _items[lid];
        if (it.kind == CURATED) return 0;
        return _amount(it.denom) * (it.markupBps - MIN_MARKUP_BPS) * 1e18 / (BPS * it.price);
    }

    function _removeActive(uint256 lid) internal {
        uint256 idx = activeIndexPlusOne[lid];
        if (idx == 0) revert InvalidItem();
        profitShareSum -= _share(lid);
        uint256 lastId = activeIds[activeIds.length - 1];
        activeIds[idx - 1] = lastId;
        activeIndexPlusOne[lastId] = idx;
        activeIds.pop();
        delete activeIndexPlusOne[lid];
    }

    function _listedShapes() internal view returns (uint256 n) {
        uint16[16] memory a = activeShapes;
        for (uint256 d; d < DENOMS; ++d) {
            n += a[d];
        }
    }

    /// @dev Shape units missing from the target.
    function _missingUnits() internal view returns (uint256 units) {
        uint256 plan = target;
        for (uint256 d; d < DENOMS; ++d) {
            uint256 want = _count(plan, d);
            uint256 have = activeShapes[d];
            if (want > have) units += (want - have) * _shapesIn(d);
        }
    }

    /// @dev Reimbursed price: min(bid, basefee + KEEPER_PRIORITY_CAP, KEEPER_MAX_GAS_PRICE).
    function _rewardPrice(uint256 bid) internal view returns (uint256 price) {
        price = block.basefee + KEEPER_PRIORITY_CAP;
        if (bid < price) price = bid;
        if (price > KEEPER_MAX_GAS_PRICE) price = KEEPER_MAX_GAS_PRICE;
    }

    /// @dev Upper bound of one call's reward at `price`: measured gas (<= KEEPER_MAX_GAS) x price + KEEPER_INCENTIVE.
    function _rewardBound(uint256 price) internal pure returns (uint256) {
        return KEEPER_MAX_GAS * price + KEEPER_INCENTIVE;
    }

    /// @notice Restocking fee per Shape for a prize listed now; keepers are paid only from these fees.
    function restockFee() public view returns (uint256) {
        return RESTOCK_FEE_GAS * _rewardPrice(type(uint256).max) + RESTOCK_FEE_FLAT;
    }

    /// @dev A Shape prize's price before restocking fees: what it costs to create plus the markup on its backing.
    function _prizeBase(uint256 d, uint256 fee, uint256 markup) internal pure returns (uint256) {
        return _cost(d, fee) + _amount(d) * markup / BPS;
    }

    /// @dev ETH to create one prize of size `d`: its backing plus the Shapes mint fee for each Shape inside.
    function _cost(uint256 d, uint256 fee) internal pure returns (uint256) {
        return _amount(d) + _shapesIn(d) * fee;
    }

    function _count(uint256 plan, uint256 d) internal pure returns (uint256) {
        return (plan >> (16 * d)) & 0xFFFF;
    }

    /// @dev Sizes 0-8: the mainnet Shapes ladder, checked against `Shapes.denominationAt` in the constructor.
    ///      Sizes 9-15: pack values (see AMOUNTS).
    function _amount(uint256 d) internal pure returns (uint256) {
        return ((AMOUNTS >> (16 * d)) & 0xFFFF) * 0.01 ether;
    }

    /// @dev Shapes per denomination index inside a pack of size `d`: the ladder taken largest first, which gives the
    ///      fewest Shapes for every pack value (0.02 = 2x0.01, 0.03 = 3x0.01, 0.2 = 2x0.1, 0.25 = 2x0.1+0.05,
    ///      2 = 2x1, 2.5 = 2x1+0.5, 25 = 2x10+5); the count matches SHAPES_IN.
    function _makeup(uint256 d) internal pure returns (uint32[] memory m) {
        m = new uint32[](SHAPE_DENOMS);
        uint256 rest = _amount(d);
        for (uint256 i = SHAPE_DENOMS; i != 0;) {
            uint256 a = _amount(--i);
            m[i] = uint32(rest / a);
            rest %= a;
        }
    }

    /// @dev Shapes inside one prize of size `d`, each paying the Shapes mint fee.
    function _shapesIn(uint256 d) internal pure returns (uint256) {
        return (SHAPES_IN >> (4 * d)) & 0xF;
    }
}
