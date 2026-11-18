// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {PoolPage} from "./PoolPage.sol";
import {Settings, SettingsLib} from "./Settings.sol";
import {IKeeperPolicy} from "./interfaces/IKeeperPolicy.sol";
import {PoolInventory} from "./PoolInventory.sol";
import {KeeperPolicyCalls} from "./KeeperPolicyCalls.sol";
import {IFWAPoolFactory, IFWAPool, IShapes, IShapePacks, IERC721Min, IENS, IReverseRegistrar} from "./interfaces/External.sol";

/// @dev The deploying factory supplies initial policy selection and ongoing keeper eligibility.
interface IBalancerFactory {
    function canKeep(address keeper) external view returns (bool);
    function defaultKeeperPolicy() external view returns (address);
}

/// @title PoolBalancer
/// @notice Permanently owns one FWA standard pool. The creator lists NFTs and sets a target mix of Shape and Draw Pack
///         prizes; anyone (or, while its factory restricts upkeep, approved keepers and the creator) may call
///         `performUpkeep` to restock drawn prizes from this contract's ETH. Players buy on FWA directly; this contract is
///         FWA's purchase operator.
/// @dev Design:
///      - FWA prices every draw on its live inventory and refunds draws whose price moved past the player's
///        tolerance, so the gate does not need an exact inventory. It keeps the game close to its design:
///        no new request while initial setup is unfinished, while no curated NFT is listed (the pool exists to
///        give NFTs away), while at least MAX_BATCH draws are already unsettled, while the
///        Shapes mint fee is above what the creator accepted, while the prizes' weight, after assuming every
///        unreconciled draw took the heaviest possible prize, is below FILL_BPS of the target's weight. Purchases do not
///        wait for a fully funded target: expensive deficits may remain while sales replenish operating capital.
///        The first MIN_MARKUP_BPS of markup funds operations; the share above it is booked for the creator.
///        `open` funds current inventory/setup work and a maintenance buffer, without duplicate prize backing.
///      - A curated NFT is listed at the creator's value, with no markup. Shape prizes carry the markup.
///      - Prices are set when a listing is made, at the markup in force then. Nothing is repriced. A Shape prize is
///        listed at its backing, its Shapes mint fees and the markup on its backing, plus a restocking fee per Shape
///        from the basefee then. The fee is the creator's income for keeper pay: the pool's ETH pays the keeper who
///        lists the prize; the fee is in the prize's price, which FWA's single draw price spreads over all buyers.
///      - Upkeep reconciles settled FWA sequences in order (MAX_RECONCILE per call) and restocks while draws are still
///        unsettled; FWA stages those listings and activates them in order.
///      - Withdrawals retain current missing inventory/setup, actual outstanding draw budgets and a working buffer.
///        Paid work may consume the buffer; low inventory can pause until proceeds or creator action restore it.
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
    /// @dev Inventory work per upkeep, in Shape units: minting+listing or withdrawing+redeeming one Shape is 1; a pack
    ///      counts as the Shapes it holds (measured: ~425k gas per Shape with its listing, ~870k per three-Shape pack).
    ///      Six units with five reconciles measured 3.13M against the 3.2M pay cap (the lowest maxGas allowed); five keeps a margin.
    uint256 internal constant MAX_OPS = 5;
    /// @dev Settled FWA sequences reconciled per upkeep call (~33k gas each), one FWA batch.
    uint256 internal constant MAX_RECONCILE = 5;
    /// @dev FWA draws processed per upkeep: keeps the worst upkeep under the 3.2M pay cap (the lowest maxGas allowed).
    uint256 internal constant MAX_PROCESS = 2;
    /// @dev Gas a failed processing call can hand back and still have been starved: FWA reverts on purpose when its
    ///      notifier would start with under 290,000 gas, and the pool is a proxy that keeps 1/64 of what it forwards,
    ///      so a starved failure hands back at most about 343,000 (measured, 48 to 2,048 listings). A failure with more
    ///      than this left was not for want of gas. The proxy's share grows with the gas processing needs, so the bound
    ///      holds for MAX_PROCESS = 2 and FWA's six-listing reservations (at most about 3.3M).
    uint256 internal constant PROCESS_STARVED_GAS = 400_000;
    /// @dev Prize sizes restocked per upkeep call: each size is its own mint call (~0.5M gas with its listing). Six sizes
    ///      in one call measured 3.19M against the 3.2M pay cap.
    uint256 internal constant MAX_RESTOCK_SIZES = 4;
    uint256 internal constant MAX_MARKUP_BPS = 10_000;
    /// @dev The game's share of every markup: the only profit in a prize's price, so the part that refills the reserve
    ///      after a big win. The creator's profit is the markup above it.
    uint256 internal constant MIN_MARKUP_BPS = 1_000;
    /// @dev Purchases need the listed prizes' weight, less the unreconciled-draw allowance, at this share of the target's.
    uint256 internal constant FILL_BPS = 7_000;
    uint256 internal constant INVERSE_WEIGHT_NUMERATOR = 1e36; // FWA StandardPool constant
    /// @dev The heaviest prize in the fill gate: the smallest backing (0.01 ETH). See `_weight`.
    uint256 internal constant MAX_PRIZE_WEIGHT = INVERSE_WEIGHT_NUMERATOR / 0.01 ether;

    uint256 public constant POLICY_DELAY = 2 days;
    uint256 public constant HARD_MAX_KEEPER_REWARD = 0.311 ether;
    uint256 public constant KEEPER_BURST = 0.622 ether;
    uint256 public constant KEEPER_REFILL_PER_SECOND = uint256(0.05 ether) / 12;
    uint256 public constant MAX_RESTOCK_SURCHARGE_PER_SHAPE = 0.102 ether;

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
    IShapes public immutable SHAPES;
    IShapePacks public immutable PACKS;
    IENS public immutable ENS;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/


    address public creator;
    address public pendingCreator;
    IFWAPool public pool;

    /// @dev Prize counts per size, sixteen 16-bit counts, size 0 in the low bits.
    uint256 public target;
    uint16 public markupBps;
    bool public enabled;
    /// @dev Initial opening setup remains true until the target is stocked; later ordinary depletion does not reset it.
    bool public creatorWork;
    uint64 public reconciledSequence;
    /// @dev The creator's unclaimed share of payments collected while open:
    ///      the markup above MIN_MARKUP_BPS. The fund keeps the rest of each payment, MIN_MARKUP_BPS of markup included.
    uint128 public profit;
    /// @dev The Shapes mint fee when the creator last configured; purchases and restocking stop above it.
    uint256 public mintFeeCap;
    /// @dev Weight (1e36 / `base`) of the listed prizes (staged or active, not yet reconciled as drawn) and of the
    ///      target. `base` leaves out the basefee-indexed restocking fee, so fill does not move with gas.
    uint256 public prizeWeight;
    uint256 public targetWeight;

    PoolInventory.State internal _inventory;
    /// @dev Pool-page approvals are valid only in the epoch they were made; `revokePoolPages` and every creator
    ///      change start a new epoch, so a former creator's approvals cannot be replayed.
    uint256 public pageEpoch;
    mapping(bytes32 digest => uint256) internal pageApprovedEpoch; // epoch + 1
    /// @dev The factory that deployed this Balancer: its keeper list decides who besides the creator may run upkeep,
    ///      and its settings are this pool's defaults.
    IBalancerFactory public factory;

    KeeperPolicyCalls.State internal _keeper;
    /// @dev Expected fee income still inside listed prizes, never an ETH balance or spendable capital.


    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event Initialized(address indexed creator, address indexed pool);
    event CreatorTransferStarted(address indexed creator, address indexed pendingCreator);
    event CreatorTransferred(address indexed oldCreator, address indexed newCreator);
    event Configured(uint16 markupBps, uint256 target, uint256 mintFeeCap);
    event KeeperPolicyProposed(address indexed policy, uint256 activationTime);
    event KeeperPolicyCancelled(address indexed policy);
    event KeeperPolicyChanged(address indexed previousPolicy, address indexed newPolicy);
    event PaidUpkeepChanged(bool enabled);
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
    error StaleSettings();
    error PolicyNotReady();
    error PolicyUnavailable();
    error PaymentUnavailable();
    error MinimumPaymentNotMet();
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
    error InsufficientGas();
    error InvalidBatch();
    error ProtectedAsset();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(address fwaFactory, address fwaImplementation, bytes32 fwaCodehash, address shapes, address packs, address ens) {
        FWA_FACTORY = IFWAPoolFactory(fwaFactory);
        FWA_IMPLEMENTATION = fwaImplementation;
        // Deployed code cannot change (EIP-6780), so one check covers every clone.
        if (fwaImplementation.codehash != fwaCodehash) revert UnreviewedImplementation();
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
        factory = IBalancerFactory(msg.sender);
        KeeperPolicyCalls.initialize(_keeper, factory.defaultKeeperPolicy());

        IFWAPoolFactory fwa = FWA_FACTORY;
        // A staging cap would make restocking while draws are unsettled revert (FWA StagingQueueFull), and with it upkeep.
        if (fwa.maxAcquisitionsPerTx() != MAX_BATCH || fwa.maxStagedListings() != 0
            || fwa.maxActivationsPerAcquisition() != 6) revert UnsupportedFWAConfig();
        // FWA reverts unless its implementation is the reviewed one, clones exactly that, and initialises the pool
        // with this contract as owner.
        address p = fwa.createPool(bytes32(0), FWA_IMPLEMENTATION);
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

    function transferCreator(address newCreator) external onlyCreator nonReentrant {
        pendingCreator = newCreator;
        emit CreatorTransferStarted(msg.sender, newCreator);
    }

    function acceptCreator() external nonReentrant {
        if (msg.sender != pendingCreator || msg.sender == address(0)) revert Unauthorized();
        emit CreatorTransferred(creator, msg.sender);
        creator = msg.sender;
        ++pageEpoch;
        pendingCreator = address(0);
        _cancelKeeperPolicy();
    }

    /// @notice Set the markup for new listings and the target prize mix, and accept the current Shapes mint fee.
    /// @dev Existing listings keep their prices. A smaller target leaves extra prizes listed until `unlistShapes`.
    function configure(uint16 newMarkupBps, uint256 newTarget) external onlyCreator nonReentrant {
        uint256 w = PoolInventory.validateTarget(newTarget, newMarkupBps);
        uint256 fee = SHAPES.mintFee();
        markupBps = newMarkupBps;
        target = newTarget;
        targetWeight = w;
        mintFeeCap = fee;
        _creatorChanged();
        emit Configured(newMarkupBps, newTarget, fee);
    }

    function keeperPolicy() external view returns (address) { return _keeper.policy; }
    function pendingKeeperPolicy() external view returns (address) { return _keeper.pending; }
    function policyActivationTime() external view returns (uint64) { return _keeper.activationTime; }
    function policyGeneration() external view returns (uint64) { return _keeper.generation; }
    function paidUpkeepEnabled() external view returns (bool) { return _keeper.enabled; }
    function policyMaxReward() external view returns (uint256) { return _keeper.maxReward; }
    function keeperAllowance() external view returns (uint256) { return _keeper.allowance; }
    function keeperAllowanceTime() external view returns (uint64) { return _keeper.allowanceTime; }

    function proposeKeeperPolicy(address policy) external onlyCreator nonReentrant {
        KeeperPolicyCalls.propose(_keeper, policy);
    }
    function cancelKeeperPolicy() external onlyCreator nonReentrant { _cancelKeeperPolicy(); }
    function _cancelKeeperPolicy() internal { KeeperPolicyCalls.cancel(_keeper); }
    function activateKeeperPolicy() external nonReentrant {
        KeeperPolicyCalls.activate(_keeper, address(this).balance - profit, _reserveInput());
    }
    /// @notice Emergency stop. Re-enabling, including the same policy, always takes the full proposal delay.
    function setPaidUpkeepEnabled(bool value) external onlyCreator nonReentrant {
        KeeperPolicyCalls.disable(_keeper, value);
    }
    function policyFunding(address policy) external view returns (uint256 required, uint256 shortfall) {
        required = _requiredReserve(KeeperPolicyCalls.validate(policy));
        uint256 fund = address(this).balance - profit;
        if (required > fund) shortfall = required - fund;
    }

    /// @notice Fund initial inventory, its bounded setup work and short-term maintenance. Later large wins can
    ///         leave a partial target; admission depends on the actual remaining prize weight, not a spare board.
    function open() external onlyCreator nonReentrant {
        if (target == 0) revert InvalidConfig();
        _collect(); // while closed, all settled proceeds join the fund
        if (!enabled) creatorWork = _missingUnits() != 0;
        enabled = true;
        if (address(this).balance - profit < requiredReserve()) revert ReserveNotFunded();
        pool.setBool(ACQUISITIONS_ENABLED_KEY, true);
        emit PurchasesOpened();
    }

    /// @notice Stop new purchases immediately. Outstanding FWA draws, refunds and claims are unaffected. The whole
    ///         balance becomes claimable; upkeep that reconciles draws settled after closing is still paid from it.
    function close() external onlyCreator nonReentrant {
        enabled = false;
        creatorWork = false;
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

    /// @notice Pull up to 20 NFTs from the creator (approve this contract first) and list each on FWA at its `base`
    ///         (its price; curated NFTs carry no markup).
    function listCuratedBatch(CuratedInput[] calldata inputs)
        external
        onlyCreator
        nonReentrant
        returns (uint256[] memory listingIds)
    {
        if (markupBps == 0) revert InvalidConfig();
        _collect();
        return PoolInventory.listCurated(_inventory, pool, address(SHAPES), address(PACKS), inputs);
    }

    /// @notice Set a curated NFT's value, which is its FWA price.
    ///         FWA allows this only while no draw is unsettled.
    function updateCuratedPrice(uint256 listingId, uint256 newBase) external onlyCreator nonReentrant {
        PoolInventory.updateCurated(_inventory, pool, listingId, newBase);
    }

    /// @notice Withdraw an active curated listing from FWA directly to `to`. FWA allows this only while no draw is
    ///         unsettled.
    function withdrawCurated(uint256 listingId, address to) external onlyCreator nonReentrant {
        _collect();
        PoolInventory.withdrawCurated(_inventory, pool, listingId, to);
    }

    /// @notice Recover an item whose FWA delivery was refunded to its winner: a curated NFT goes to `to`; a Shape or
    ///         pack is redeemed here for its backing. FWA allows the refund 7 days after the failed delivery.
    ///         Upkeep never touches curated collections, so a hostile collection cannot burn keeper gas or block upkeep.
    function recoverRefunded(uint256 listingId, address to) external onlyCreator nonReentrant returns (uint256 eth) {
        return PoolInventory.recoverRefunded(_inventory, pool, address(SHAPES), address(PACKS), listingId, to);
    }

    /// @notice Return an NFT this contract holds outside FWA, e.g. one sent to it directly.
    /// @dev Tracked inventory is never held here between transactions: listings and pending deliveries
    ///      are owned by the FWA pool, prizes are minted-and-listed or withdrawn-and-redeemed within one
    ///      call, and refunded NFTs are pulled from FWA only inside `recoverRefunded`. So
    ///      `ownerOf == this` (checked under the reentrancy lock) proves the NFT is untracked. Only the
    ///      ERC721 transfer selector is called, and never on the FWA pool or factory.
    function recoverUntrackedNFT(address collection, uint256 tokenId, address to) external onlyCreator nonReentrant {
        PoolInventory.recoverUntracked(address(pool), address(FWA_FACTORY), collection, tokenId, to);
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
        _collect();
        prizeWeight -= PoolInventory.unlistShapes(_inventory, pool, address(SHAPES), address(PACKS), listingIds);
        _creatorChanged();
    }

    /// @notice Irreversibly retire the FWA pool. Withdrawals, unlisting and recovery remain available.
    function retire() external onlyCreator nonReentrant {
        if (enabled) revert NotClosed();
        pool.retirePool();
        emit PoolRetired();
    }

    /*//////////////////////////////////////////////////////////////
                                   ENS
    //////////////////////////////////////////////////////////////*/

    /// @notice Set this contract's ENS reverse record via the current `addr.reverse` registrar ("" clears it).
    function setENSName(string calldata name) external onlyCreator nonReentrant {
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
    ///      accepts such a message).
    function approvePoolPage(string calldata issuedAt, bytes32 metadataHash)
        external
        onlyCreator
        nonReentrant
        returns (bytes32 digest)
    {
        digest = PoolPage.digest(address(FWA_FACTORY), address(pool), issuedAt, metadataHash);
        pageApprovedEpoch[digest] = pageEpoch + 1;
        emit PoolPageApproved(digest, issuedAt, metadataHash);
    }

    /// @notice Invalidate every pool-page approval made so far.
    function revokePoolPages() external onlyCreator nonReentrant {
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
    /// @dev Preserve the pending-draw bound and bound selectable Shape weight at the first new selection,
    ///      including FWA's guaranteed activation. No metadata synchronization or single-batch barrier is required.
    function admissionStatus() public view returns (uint8) {
        if (!enabled) return CLOSED;
        if (creatorWork) return SETTING_UP;
        return PoolInventory.admission(_inventory, pool, address(SHAPES), mintFeeCap, targetWeight, prizeWeight, reconciledSequence);
    }

    /*//////////////////////////////////////////////////////////////
                                 UPKEEP
    //////////////////////////////////////////////////////////////*/

    /// @notice Paid maintenance; minimumReward is enforced atomically after real work and policy quotes.
    function performUpkeep(bytes32 expected, uint256 minimumReward) external nonReentrant returns (uint256) {
        return _performUpkeep(expected, minimumReward, true);
    }

    /// @notice Price-indexed expense protection: reward must cover minimumFixed plus minimumGas at the mined price.
    function performUpkeep(bytes32 expected, uint256 minimumFixed, uint256 minimumGas)
        external nonReentrant returns (uint256)
    {
        return _performUpkeep(expected, minimumFixed + minimumGas * tx.gasprice, true);
    }

    /// @notice Compatibility entry point for callers explicitly accepting any nonzero-or-zero offered reward.
    function performUpkeep(bytes32 expected) external nonReentrant returns (uint256) {
        return _performUpkeep(expected, 0, true);
    }

    /// @notice Anyone can maintain without compensation, even with a restricted keeper list. New listings use the
    ///         chosen policy's bounded quote, or the immutable V1 recovery surcharge if that quote fails.
    function performUpkeepUnpaid() external nonReentrant returns (uint256) {
        return _performUpkeep(bytes32(0), 0, false);
    }

    function _performUpkeep(bytes32 expected, uint256 minimumReward, bool paid) internal returns (uint256 reward) {
        uint256 gasStart = gasleft();
        if (paid) {
            if (msg.sender != creator && !factory.canKeep(msg.sender)) revert KeeperNotApproved();
            if (settingsHash() != expected) revert StaleSettings();
            if (!_keeper.enabled) revert PaymentUnavailable();
        }
        IFWAPool p = pool;

        // 0. Process FWA's queue. A draw whose request reserved a staged restock skips FWA's randomness fast path (which
        //    also only ever takes the queue's head), and a ready draw never expires, so it and every draw behind it wait
        //    for an explicit processAcquisitions that nobody else is bound to call. FWA stops at a draw still waiting
        //    for its randomness; a failure here never blocks the rest of upkeep. The draws it settles are reconciled
        //    below in the same call, so the work is paid like any reconcile.
        //    Gas spent on processing that reverted is not paid for (FWA reverts on purpose when its notifier is left too
        //    little gas, so a keeper could otherwise pick a gas limit that burns paid gas for nothing). Processing that
        //    failed for want of gas reverts the whole upkeep instead, at any pool size: a call never succeeds with
        //    processing starved, so a gas estimate is enough to process.
        uint256 processed;
        uint64 next = p.nextSequenceToProcess();
        if (next <= p.lastIssuedSequence()) {
            uint256 g = gasleft();
            try p.processAcquisitions(MAX_PROCESS) {
                processed = p.nextSequenceToProcess() - next;
            } catch {
                uint256 left = gasleft();
                if (left < g / 64 + PROCESS_STARVED_GAS) revert InsufficientGas();
                gasStart -= g - left;
            }
        }

        // 1. Collect settled proceeds before reconciling, so the split still counts the listings the draws won
        //    (reconciling first would drop them). Listings added since a draw was bought also count (see `_collect`).
        bool collected = _collect() != 0;

        // 2. Reconcile settled FWA sequences in order. Processed sequences are final: their listing is fixed.
        uint64 s = reconciledSequence;
        uint64 end = p.nextSequenceToProcess() - 1;
        if (end > s + MAX_RECONCILE) end = s + uint64(MAX_RECONCILE);
        while (s < end) {
            (,,, uint256 lid, uint8 aStatus,) = p.acquisitions(p.requestIdAtSequence(++s));
            if (lid != 0) _onDrawn(lid, aStatus == A_FULFILLED);
        }
        uint256 draws = s - reconciledSequence;
        bool reconciled = draws != 0;
        if (reconciled) reconciledSequence = s;

        // 3. Restock while open, in a call that settled no draw: a draw that reserved FWA's maximum six listings costs
        //    up to about 1.15M gas to process, so processing two and restocking in one call can pass the 3.2M pay cap and
        //    leave the keeper unpaid for the excess. The next call restocks.
        uint256 ops;
        uint256 listed;
        bool wasSetup = creatorWork;
        if (processed == 0 && enabled && !FWA_FACTORY.globalWithdrawOnly()) {
            uint256 fee = SHAPES.mintFee();
            if (fee <= mintFeeCap) {
                (ops, listed) = _fillDeficit(p, fee, paid, draws);
                if (wasSetup && _missingUnits() == 0) creatorWork = false;
            }
        }

        if (!reconciled && ops == 0 && !collected && creatorWork == wasSetup) revert NoUpkeepNeeded();
        if (paid && (ops != 0 || reconciled)) {
            reward = _payKeeper(gasStart, draws, ops, listed, processed);
        }
        if (reward < minimumReward) revert MinimumPaymentNotMet();
        // Unpaid game-first inventory recovery may consume unclaimed profit; paid work retains it.
        if (profit > address(this).balance) profit = uint128(address(this).balance);
    }

    function _onDrawn(uint256 lid, bool delivered) internal {
        PoolInventory.Item storage it = _inventory.items[lid];
        // Every pool listing is ours and tracked until drawn. Never revert here: reconciliation must not be bricked.
        if (it.state != ACTIVE) return;
        uint8 kind = it.kind;
        uint8 d = it.denom;
        _removeActive(lid);
        if (kind == SHAPE) {
            --_inventory.activeShapes[d];
            prizeWeight -= _weight(d);
        }
        if (delivered) {
            delete _inventory.items[lid];
        } else {
            it.state = PENDING;
        }
        emit ItemDrawn(lid, kind, d, delivered);
    }

    /// @dev Mint missing prizes, smallest value first, within MAX_OPS Shape units, MAX_RESTOCK_SIZES sizes and the ETH
    ///      left after this call's keeper reward, and list them at `_prizeBase` plus the restocking fees in one FWA
    ///      batch. FWA stages the batch while draws are unsettled. Returns Shape units used.
    function _fillDeficit(IFWAPool p, uint256 fee, bool paid, uint256 draws) internal returns (uint256 used, uint256 listed) {
        uint256 added;
        (used, listed, added) = PoolInventory.fill(_inventory, PoolInventory.Fill(
            target, markupBps, paid ? profit : 0, _keeper.maxReward, draws, fee, address(SHAPES), address(PACKS),
            address(p), _keeper.policy, paid
        ));
        prizeWeight += added;
    }

    function _payKeeper(uint256 gasStart, uint256 draws, uint256 units, uint256 listed, uint256 processed)
        internal returns (uint256 reward)
    {
        uint256 measured = gasStart - gasleft();
        IKeeperPolicy.Work memory w = IKeeperPolicy.Work(measured, tx.gasprice, block.basefee, draws, units, listed, processed);
        return KeeperPolicyCalls.pay(_keeper, w, address(this).balance - profit);
    }

    function availableKeeperAllowance() public view returns (uint256) { return KeeperPolicyCalls.available(_keeper); }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice ETH the creator may claim now: everything above `requiredReserve`, or the unclaimed `profit` while the
    ///         fund is below it. While closed, everything but the keeper pay held for unreconciled draws.
    function withdrawableSurplus() public view returns (uint256) {
        uint256 bal = address(this).balance;
        uint256 req = requiredReserve();
        uint256 free = bal > req ? bal - req : 0;
        uint256 mine = profit;
        return mine > free ? mine : free;
    }

    /// @notice Working capital for missing assets and their bounded listing work, actual unreconciled draws and
    ///         one maintenance call. It limits withdrawals, not legitimate maintenance spending. No policy is called.
    function requiredReserve() public view returns (uint256) { return _requiredReserve(_keeper.enabled ? _keeper.maxReward : 0); }

    function _requiredReserve(uint256 maxReward) internal view returns (uint256) {
        return KeeperPolicyCalls.reserve(maxReward, _reserveInput());
    }
    function _reserveInput() internal view returns (KeeperPolicyCalls.Reserve memory r) {
        uint256 fee = SHAPES.mintFee();
        if (fee < mintFeeCap) fee = mintFeeCap;
        r = KeeperPolicyCalls.Reserve(enabled, pool.lastIssuedSequence() - reconciledSequence, target,
            _inventory.activeShapes, fee, block.basefee);
    }

    /// @notice A tracked listing: kind (1 curated, 2 Shape or pack), size, state, `base` and FWA price.
    function items(uint256 listingId) external view returns (uint8 kind, uint8 denom, uint8 state, uint112 base, uint112 price) {
        PoolInventory.Item storage it = _inventory.items[listingId];
        return (it.kind, it.denom, it.state, it.base, it.price);
    }

    function getActiveIds() external view returns (uint256[] memory) {
        return _inventory.activeIds;
    }

    function getActiveShapes() external view returns (uint16[16] memory) {
        return _inventory.activeShapes;
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

    /// @dev Opening needs full initial setup. Later edits must not turn ordinary partial depletion into setup again.
    function _creatorChanged() internal {
        creatorWork = enabled && creatorWork && _missingUnits() != 0;
    }

    /// @dev Collect FWA proceeds and split them by the listings tracked now (`_inventory.activeIds`, `_inventory.profitShareSum`). Callers
    ///      collect before changing the tracked listings, so a draw is split by the set it was priced on unless listings
    ///      were added or removed while it was unsettled (upkeep restocking, at the markup in force when it lists); then
    ///      the current set's share applies. A markup change alone moves no listed share. The Shapes' markup above
    ///      MIN_MARKUP_BPS is always booked for the creator; the first ten percent and restocking income join the fund.
    function _collect() internal returns (uint256 amount) {
        IFWAPool p = pool;
        if (p.ownerProceeds() == 0) return 0;
        amount = p.withdrawOwnerProceeds();
        emit ProceedsCollected(amount);
        uint256 n = _inventory.activeIds.length;
        if (!enabled || n == 0) return amount;
        uint256 mine = amount * _inventory.profitShareSum / (n * 1e18);
        if (mine > amount) mine = amount;
        // The listed markup share belongs to the creator even if an unreconciled win has not revealed its deficit.
        profit += uint128(mine);
    }

    function _addActive(uint256 lid) internal { PoolInventory.addActive(_inventory, lid); }
    function _removeActive(uint256 lid) internal { PoolInventory.removeActive(_inventory, lid); }
    function profitShareSum() external view returns (uint256) { return _inventory.profitShareSum; }
    function listedRestockFees() external view returns (uint256) { return _inventory.listedFees; }
    function listedShapePrizes() external view returns (uint256) { return _inventory.listedPrizes; }

    function _listedShapes() internal view returns (uint256) { return _inventory.listedPrizes; }

    /// @dev Shape units missing from the target.
    function _missingUnits() internal view returns (uint256) { return PoolInventory.missingUnits(_inventory, target); }

    /// @notice Optional version-one linear-policy display metadata. Never used to authorize payments or reserves.
    function settings() public view returns (Settings memory s) {
        return KeeperPolicyCalls.metadata(_keeper.policy);
    }

    /// @notice Identifies the exact policy selection, including disable/re-enable cycles and same-address changes.
    function settingsHash() public view returns (bytes32) {
        return keccak256(abi.encode(_keeper.policy, _keeper.maxReward, _keeper.generation, _keeper.enabled));
    }

    function maxKeeperReward() public view returns (uint256) { return _keeper.maxReward; }

    function restockFee() public view returns (uint256) { return _restockFee(0, 1, true); }
    /// @notice Bounded active-policy estimate in this pool's caller context, not a promise of payable work.
    function quoteKeeperReward(IKeeperPolicy.Work calldata work) external view returns (uint256) {
        return _keeper.enabled ? KeeperPolicyCalls.reward(_keeper.policy, _keeper.maxReward, work) : 0;
    }
    function restockFeeFor(uint8 denomination) external view returns (uint256) {
        if (denomination >= DENOMS) revert InvalidPlan();
        return _restockFee(denomination, _shapesIn(denomination), true);
    }

    function _restockFee(uint8 d, uint256 units, bool paid) internal view returns (uint256 fee) {
        return KeeperPolicyCalls.restock(_keeper.policy, d, units, paid, block.basefee);
    }

    /// @dev A prize's weight in the fill gate: 1 / its backing. Listed prices keep the markup and fees of their listing
    ///      block, so weighing by price would let a lower markup or mint fee push a full board under the gate with
    ///      nothing for upkeep to restock. Backing is fixed per size, so the gate measures the mix, not prices.
    function _weight(uint256 d) internal pure returns (uint256) {
        return INVERSE_WEIGHT_NUMERATOR / _amount(d);
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
