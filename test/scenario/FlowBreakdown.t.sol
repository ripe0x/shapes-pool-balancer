// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {ForkBase, IVRFService} from "../utils/ForkBase.sol";
import {FlowBreakdown, GasProbe} from "../utils/FlowBreakdown.sol";
import {ReceiptGas} from "../utils/ReceiptGas.sol";
import {KeeperPolicyCalls} from "../../src/KeeperPolicyCalls.sol";
import {PoolInventory} from "../../src/PoolInventory.sol";
import {PoolBalancer} from "../../src/PoolBalancer.sol";
import {IERC721Min} from "../../src/interfaces/External.sol";
import {ListOne} from "../utils/ListOne.sol";

using ListOne for PoolBalancer;

interface IPoolMore {
    function selectionTimeoutBlocks() external view returns (uint256);
    function accruedProtocolFees() external view returns (uint256);
    function deliveryEscrowTotal() external view returns (uint256);
    function acquisitionEscrowTotal() external view returns (uint256);
    function acquisitionRefundCreditTotal() external view returns (uint256);
    function acquisitionRefundCredit(address purchaser) external view returns (uint256);
    function withdrawAcquisitionRefund() external returns (uint256 amount);
    function requestIdAtSequence(uint64 sequence) external view returns (uint256);
    function acquisitionMeta(uint256 requestId)
        external
        view
        returns (uint64 sequence, uint64 wordDeadlineBlock, uint64 rewardEpoch, uint16, uint16, uint256 randomWord);
}

interface IReservedListings {
    function reservedListingCount(uint64 sequence) external view returns (uint256);
}

interface IPackValue {
    function valueOf(uint256 packId) external view returns (uint256);
}

/// @notice Flow breakdown (docs/SYSTEM-MAP.md): one pool under eight operating regimes on the pinned mainnet fork, with
///         the real FWA pool and randomness service (words delivered as its Chainlink coordinator), real Shapes, this
///         system's Draw Packs and real BAYC tokens as the creator's NFTs. Each regime prints where every wei that
///         entered (creator deposits and player payments) ended up and writes docs/receipts/flow/<regime>.json for
///         asset_gate.py. It measures and prints; it asserts only the environment, a few absolute amounts and that
///         each regime reached the state it claims.
///
///         Inputs shared by every regime: ape-Ball's opening board (24 x 0.01, 8 x 0.02 pack, 12 x 0.05, 2 x 0.1,
///         1 x 0.5 ETH: 47 prizes, 55 Shapes, 1.7 ETH of backing), 25% markup, one 0.2 ETH NFT relisted when won, a
///         5 ETH deposit, 180 draw attempts over 30 days of 6 with the same random words, basefee 0.5 gwei and a
///         0.05 gwei tip. The creator claims everything claimable right after setup and at the end of every day, so
///         the pool runs at exactly its reserve.
///
///         Keeper model: an outside keeper calls `performUpkeep` only when the reward covers its gas (measured around
///         the call with the touched contracts cold, plus 21,000) at the current gas price; otherwise it waits. The
///         creator never runs upkeep except in the closeout. A player who finds purchases refused leaves.
contract FlowBreakdownTest is ForkBase, FlowBreakdown {
    uint256 internal constant DRAWS = 180;
    uint256 internal constant PER_DAY = 6;
    uint256 internal constant SEED = 7;
    uint256 internal constant MARKUP_BPS = 2500;
    uint256 internal constant DEPOSIT = 5 ether;
    uint256 internal constant NFT_VALUE = 0.2 ether;
    uint256 internal constant BASEFEE = 0.5 gwei;
    uint256 internal constant TIP = 0.05 gwei;
    uint256 internal constant CAP_FEE = 4.95 gwei; // gas price 5 gwei: the most the Balancer reimburses
    uint256 internal constant SPIKE_FEE = 20 gwei;
    uint256 internal constant VRF_GAS = 2_340_000; // FWA's per-draw randomness charge, in gas
    uint256 internal constant BOARD_UNITS = 55;
    uint256 internal constant TOP = 3; // size index of the 0.5 ETH Shape
    address internal constant BAYC = 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;
    uint8 internal constant CURATED_KIND = 1;
    uint8 internal constant SHAPE_KIND = 2;
    uint8 internal constant RAN = 0;
    uint8 internal constant NOTHING = 1;
    uint8 internal constant SKIPPED = 2;

    GasProbe internal probe;
    uint256 internal gasNow;
    uint256 internal feeNow;
    uint256 internal maxGasSeen;
    uint256 internal maxFeeSeen;
    uint256 internal keeperStart;
    uint256 internal nextLid = 1;
    uint256 internal nextNft = 100;
    mapping(uint256 id => bool) internal done;
    // each listing as listed, kept by the harness: upkeep that processes FWA's queue (D16) reconciles a draw in the
    // same call, after which the Balancer no longer holds the item
    mapping(uint256 lid => uint8) internal lidKind;
    mapping(uint256 lid => uint8) internal lidDenom;
    mapping(uint256 lid => uint256) internal lidFee;

    // cumulative money counters, each measured from a balance change or a real read at the moment it happens
    uint256 internal deposited;
    uint256 internal claimed;
    uint256 internal playersPaid;
    uint256 internal vrfPaid;
    uint256 internal refundsWithdrawn;
    uint256 internal proceedsCollected;
    uint256 internal creatorCreditAccrued;
    uint256 internal backingMinted;
    uint256 internal backingRedeemed;
    uint256 internal backingWon;
    uint256 internal mintFees;
    uint256 internal keeperPaidSetup;
    uint256 internal keeperPaidPlay;
    uint256 internal keeperGasCost;
    uint256 internal paidBeyondGasAndReward;
    uint256 internal paidBeyondGas; // the same, in gas at the reimbursed price
    uint256 internal paidBeyondGasWorstCall;
    uint256 internal feesListed; // restocking fees inside the prices of every prize listed
    uint256 internal selectedFeesWon; // surcharge removed with the selected listing, not cash received
    uint256 internal feesReceived; // request-board surcharge component of fulfilled FWA owner proceeds
    uint256 internal ownerProceedsRealized;
    uint256 internal feesUnlisted;
    uint256 internal redeemGap;

    // run facts
    uint256 internal requested;
    uint256 internal delivered;
    uint256 internal deliverReverts;
    uint256 internal fulfilled;
    uint256 internal expired;
    uint256 internal refused;
    uint256[8] internal refusedBy;
    uint256 internal buyReverts;
    uint256 internal firstBuyRevert;
    uint256 internal maxUnsettled;
    uint256 internal busySeen;
    uint256 internal maxReconciled;
    uint256 internal maxUnits;
    uint256 internal unitsListed;
    uint256 internal prizesUnlisted;
    uint256 internal upkeepsRun;
    uint256 internal upkeepsSkipped;
    uint256 internal upkeepsNothing;
    uint256 internal upkeepReverts;
    uint256 internal upkeepsWhileUnsettled;
    uint256 internal fwaQueueReadyMax;
    uint256 internal upkeepsWithQueueReady;
    uint256 internal upkeepsWithQueueReadyOver2;
    uint256 internal restocksStaged;
    uint256 internal incompleteAfterFullPass;
    uint256 internal lowInventoryAfterFullPass;
    uint256 internal maxReserveShortfall;
    uint256 internal passesWithReserveShort;
    uint256 internal maxShortfallReconciled;
    uint256 internal nftsListed;
    uint256 internal nftsWon;
    uint256 internal nftsToRelist;
    uint256 internal topWon;
    uint256 internal topNotListedWhenForced;
    uint256 internal unknownWins;
    uint256 internal daysRun;

    // regime switches
    uint256 internal forceTopA = type(uint256).max;
    uint256 internal forceTopB = type(uint256).max;
    bool internal spikeRegime;
    uint256 internal phase;
    uint256[4] internal phaseSold;
    uint256[4] internal phaseRefused;
    uint256[4] internal phaseSkipped;
    uint256[4] internal phaseQuote;

    // Collection checks compare actual cash received with the explicitly stored creator percentage.
    bool internal creditCheck = true;
    mapping(uint256 id => uint256) internal drawBase; // FWA owner proceeds for the draw: sum(w*p)/sum(w), active listings
    mapping(uint256 id => uint256) internal drawFee;
    mapping(uint256 id => uint256) internal actualDrawProceeds;
    uint256[] internal allIds;
    uint256 internal uncollectedBase;
    uint256 internal creditChecks;
    uint256 internal creditZeroBooked;
    uint256 internal creditExpected;
    uint256 internal creditBooked;
    uint256 internal creditOver;
    uint256 internal creditUnder;
    uint256 internal proceedsMismatch;
    uint256 internal maxInFlightAtRestock;
    struct BoardAmounts { uint256 weight; uint256 price; uint256 withoutSurcharge; }

    // E9 what-ifs on large_win: the creator acts once, right after the second top prize is won
    uint256 internal daysTopMissing;
    uint256 internal actAt = type(uint256).max;
    bool internal actTopUp;
    uint256 internal toppedUp;
    uint256 internal claimedAtSetup;
    uint256 internal daysPrizeMissing; // days ending with any prize of the design missing from the board (O5)
    // top_heavy (D8): a second buyer arrives while the first buyer's draw is unsettled
    uint256 internal secondArrivals;
    uint256 internal secondRefusedWhilePending;
    uint256 internal secondSold;
    // no_processor (D16): FWA's queue is processed only by what production runs
    uint256 internal reservedDraws;
    uint256 internal maxUnsettledAtDayEnd;
    uint256[] internal openIds;
    // gas-level regimes and the player's price (O10)
    bool internal alternativePolicy;
    uint256 internal baseFeeRegime; // 0: BASEFEE
    bool internal trackPrice;
    uint256 internal maxPriceToBackingBps;
    uint256 internal minPriceToBackingBps = type(uint256).max;
    // optional-curated (standard mode) regimes: no launch NFT, and curated add/withdraw mid-run
    bool internal noNft;
    uint256 internal withdrawCuratedAt = type(uint256).max;
    uint256 internal listCuratedAt = type(uint256).max;

    function setUp() public {
        setUpFork();
        keeperStart = keeper.balance;
    }

    // ------------------------------------------------------------------ regimes

    function test_breakdown_policySwitch() public {
        Snap memory a = _launch();
        creditCheck = true;
        for (uint256 i; i < 6; ++i) _single(i);
        uint256[] memory listed = balancer.getActiveIds();
        uint256[] memory prices = new uint256[](listed.length);
        // FWA listing tuple is collection, depositor, winner, tokenId, weight, price, slot, status.
        for (uint256 i; i < listed.length; ++i) (,,,,, prices[i],,) = pool.listings(listed[i]);
        // R95: no algorithm to switch; the regime switches to local economics with half the work fee.
        KeeperPolicyCalls.Economics memory local = factory.economics();
        local.workFee = 0.00001 ether;
        uint256[] memory pending = _buy(1);
        assertEq(pending.length, 1);
        assertEq(pool.unsettledAcquisitionCount(), 1);
        (uint256 required, uint256 shortfall) = balancer.maintenanceFunding(local);
        assertEq(required, (3_200_000 + V1_OVERHEAD) * 0.55 gwei + 10 * 0.00001 ether
            + (2_150_000 + V1_OVERHEAD) * 0.55 gwei + 2 * 0.00001 ether,
            "one outstanding request and one operating call at 0.5 gwei");
        assertEq(shortfall, 0, "a smaller maintenance exposure needs no top-up");
        vm.prank(creator); balancer.setLocalEconomics(local);
        assertEq(balancer.economicsSource(), 1);
        alternativePolicy = true;
        // The smaller work fee lowers the exposure, so the switch needs no top-up (shortfall 0).
        assertGe(address(balancer).balance - balancer.creatorCredit(), required, "funded at the unchanged exposure");
        uint256 repriced;
        for (uint256 i; i < listed.length; ++i) {
            (,,,,, uint256 price,,) = pool.listings(listed[i]);
            if (price != prices[i]) ++repriced;
        }
        assertEq(repriced, 0, "an economics switch cannot alter an existing FWA price");
        _deliver(pending[0], _word(50));
        _service();
        _account(pending);
        for (uint256 i = 6; i < 18; ++i) _single(i);
        Fact[] memory x = new Fact[](5);
        x[0] = Fact("policy_switches", 1);
        x[1] = Fact("policy_repriced_listings", repriced);
        x[2] = Fact("policy_transition_deposit_wei", shortfall);
        x[3] = Fact("policy_transition_required_wei", required);
        x[4] = Fact("policy_switch_outstanding_draws", 1);
        _done("policy_switch", a, x);
    }

    function test_breakdown_quiet() public {
        Snap memory a = _launch();
        for (uint256 i; i < DRAWS; ++i) _single(i);
        assertEq(vrfPaid, requested * VRF_GAS * gasNow, "each draw paid FWA's randomness fee at the stated gas price");
        _done("quiet", a, new Fact[](0));
    }

    /// @dev Standard mode (curatedRequired=false): the launch Shape/Pack board with no curated NFT at all, played like
    ///      quiet, then closed out. Purchases are admitted throughout on Shapes alone.
    function test_breakdown_shapesOnly() public {
        curatedRequired = false;
        noNft = true;
        Snap memory a = _launch();
        assertEq(_ids(CURATED_KIND).length, 0, "no curated NFT listed");
        for (uint256 i; i < DRAWS; ++i) _single(i);
        assertEq(nftsWon, 0, "a shapes-only pool delivers no curated NFT");
        _closeout();
        _done("shapes_only", a, new Fact[](0));
    }

    /// @dev Standard mode: a mixed pool whose single (last) curated NFT the creator withdraws mid-run; Shape purchases
    ///      continue with no curated NFT listed, then closeout.
    function test_breakdown_mixedToShapesOnly() public {
        curatedRequired = false;
        withdrawCuratedAt = 60;
        Snap memory a = _launch();
        assertEq(_ids(CURATED_KIND).length, 1, "starts mixed: one curated NFT listed");
        for (uint256 i; i < DRAWS; ++i) _single(i);
        assertEq(_ids(CURATED_KIND).length, 0, "ran shapes-only after the last curated NFT was withdrawn");
        _closeout();
        _done("mixed_to_shapes_only", a, new Fact[](0));
    }

    /// @dev Standard mode: starts shapes-only, the creator adds a curated NFT with listCuratedBatch mid-run, play
    ///      continues (the NFT is relisted when won, as the standard regimes do), then closeout.
    function test_breakdown_shapesOnlyToMixed() public {
        curatedRequired = false;
        noNft = true;
        listCuratedAt = 60;
        Snap memory a = _launch();
        assertEq(_ids(CURATED_KIND).length, 0, "starts shapes-only");
        for (uint256 i; i < DRAWS; ++i) _single(i);
        assertGe(nftsListed, 1, "a curated NFT was added with listCuratedBatch mid-run (and relisted if won)");
        _closeout();
        _done("shapes_only_to_mixed", a, new Fact[](0));
    }

    /// @dev Same inputs bought five at a time: five draws unsettled, upkeep working while three are still unsettled
    ///      (FWA stages its listings) on even batches, five reconciled in one call on odd ones.
    function test_breakdown_limitsAtMax() public {
        Snap memory a = _launch();
        _runBatches(0, DRAWS);
        _assertLimits();
        _done("limits_at_max", a, new Fact[](0));
    }

    function test_breakdown_maxThenIdle() public {
        Snap memory a = _launch();
        _runBatches(0, DRAWS);
        _assertLimits();
        _idle(7);
        Fact[] memory x = new Fact[](1);
        x[0] = Fact("idle_days_after_play", 7);
        _done("max_then_idle", a, x);
    }

    function test_breakdown_zeroDemand() public {
        Snap memory a = _launch();
        _idle(30);
        assertEq(requested, 0, "no draw was bought");
        Fact[] memory x = new Fact[](1);
        x[0] = Fact("idle_days", 30);
        _done("zero_demand", a, x);
    }

    /// @dev A real 0.5 ETH win can leave the target depleted; no hypothetical second copy is assumed.
    function test_breakdown_largeWin() public {
        Snap memory a = _launch();
        forceTopA = 60;
        for (uint256 i; i < DRAWS; ++i) _single(i);
        assertGe(topWon, 1, "the actual large prize was delivered before deferred recovery or creator action");
        _done("large_win", a, _largeWinFacts());
    }

    /// @dev After the actual large win, the creator explicitly funds the missing target and current work.
    function test_whatIf_largeWinTopUp() public {
        Snap memory a = _launch();
        (forceTopA, actAt, actTopUp) = (60, 61, true);
        for (uint256 i; i < DRAWS; ++i) _single(i);
        assertGe(topWon, 1, "the actual large prize was delivered before deferred recovery or creator action");
        assertGt(toppedUp, 0, "the creator topped up");
        _done("whatif_large_win_top_up", a, _largeWinFacts());
    }

    /// @dev After the actual large win, the creator saves the design without that missing prize.
    function test_whatIf_largeWinDropTop() public {
        Snap memory a = _launch();
        (forceTopA, actAt) = (60, 61);
        for (uint256 i; i < DRAWS; ++i) _single(i);
        assertGe(topWon, 1, "the actual large prize was delivered before deferred recovery or creator action");
        assertEq((balancer.target() >> (16 * TOP)) & 0xFFFF, 0, "the design no longer has the top prize");
        _done("whatif_large_win_drop_top", a, _largeWinFacts());
    }

    /// @dev D8: Codex rc-122de71 E2's board, one 0.01 ETH Shape and one 25 ETH Pack plus the NFT, 100 ETH deposit. Each
    ///      step one buyer draws and a second buyer arrives before that draw settles. The fill gate counts the pending
    ///      draw as the loss of a 0.01 ETH prize, so this board refuses the second buyer until the draw settles; with
    ///      every draw reconciled, no buyer is refused (O7).
    function test_breakdown_topHeavy() public {
        uint256[16] memory c;
        (c[0], c[15]) = (1, 1);
        Snap memory a = _launchWith(c, 100 ether, 4);
        uint256 admitted = 3_000 * balancer.targetWeight() / (10_000 * (1e36 / 0.01 ether));
        assertEq(admitted, 0, "reached: this board admits no purchase with a draw unsettled");
        for (uint256 i; i < DRAWS; ++i) {
            if (!balancer.canPurchase(buyer)) {
                _refused(1);
            } else {
                uint256[] memory ids = _buy(1);
                if (ids.length == 1) {
                    ++secondArrivals;
                    uint256[] memory more = _buy(1); // a real FWA purchase attempt while the first draw is unsettled
                    if (more.length == 1) {
                        ++secondSold;
                        _deliver(more[0], _word(i + DRAWS));
                    } else {
                        ++secondRefusedWhilePending;
                    }
                    _deliver(ids[0], _word(i));
                    _keeperPass(); // nobody else processes FWA's queue: keepers do it inside upkeep (D16)
                    _account(ids);
                    if (more.length == 1) _account(more);
                }
            }
            _service();
            if ((i + 1) % PER_DAY == 0) _endOfDay();
        }
        assertGt(secondRefusedWhilePending, 0, "reached: second buyers were refused while a draw was pending");
        assertEq(firstBuyRevert, uint32(0x24e6a72a), "refused by FWA's PurchaseNotAllowed(): the Balancer's fill gate");
        Fact[] memory x = new Fact[](5);
        x[0] = Fact("pending_draws_admitted_by_board", admitted);
        x[1] = Fact("second_buyer_arrivals_while_pending", secondArrivals);
        x[2] = Fact("second_buyer_refused_while_pending", secondRefusedWhilePending);
        x[3] = Fact("second_buyer_sold_while_pending", secondSold);
        // R16: longest a pause lasts if the randomness never arrives: FWA's selection timeout, then anyone processes the
        // expired draw and upkeep reconciles it (the keeper's next poll)
        x[4] = Fact("pause_worst_case_blocks_before_processing", IPoolMore(address(pool)).selectionTimeoutBlocks() + 1);
        _done("top_heavy", a, x);
    }

    // Extremes of what `configure` allows (prizes 1 to 80, sizes 0.01 to 100 ETH), each with the NFT and quiet play: one
    // buyer at a time, keepers after every draw. The pause with draws unsettled is covered by top_heavy.

    /// @dev Most top-heavy: the single largest Shape, one 100 ETH prize.
    function test_breakdown_extremeTopHeavy() public {
        uint256[16] memory c;
        c[8] = 1;
        vm.deal(creator, 2_000 ether);
        _quietBoard("extreme_top_heavy", c, 400 ether, 1);
    }

    /// @dev Most bottom-heavy and the most prizes: 80 x 0.01 ETH Shapes.
    function test_breakdown_extremeBottomHeavy() public {
        uint256[16] memory c;
        c[0] = 80;
        _quietBoard("extreme_bottom_heavy", c, 5 ether, 80);
    }

    /// @dev Smallest board: one 0.01 ETH Shape.
    function test_breakdown_smallestBoard() public {
        uint256[16] memory c;
        c[0] = 1;
        _quietBoard("smallest_board", c, 1 ether, 1);
    }

    /// @dev Largest board: 80 x 100 ETH Shapes (8,000 ETH of backing). Funding the creator's and buyer's wallets is setup.
    function test_breakdown_largestBoard() public {
        uint256[16] memory c;
        c[8] = 80;
        vm.deal(creator, 20_000 ether);
        vm.deal(buyer, 1_000_000 ether);
        _quietBoard("largest_board", c, 9_000 ether, 80);
    }

    function test_breakdown_minimumCapital() public {
        uint256[16] memory c;
        c[0] = 20;
        Snap memory a = _launchWith(c, 0.229565 ether, 20);
        assertEq(balancer.requiredReserve(), 0.001993 ether, "minimum default-paid funding actually stocked the board");
        for (uint256 i; i < DRAWS; ++i) _single(i);
        assertEq(deposited, 0.229565 ether, "no operating top-ups hidden in this regime");
        Fact[] memory x = new Fact[](3);
        x[0] = Fact("initial_opening_requirement_wei", 0.229565 ether);
        x[1] = Fact("operating_topups_wei", 0);
        x[2] = Fact("stocked_working_buffer_wei", 0.001993 ether);
        _done("minimum_capital", a, x);
    }

    function test_breakdown_minimumLargeWin() public {
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[TOP]) = (24, 8, 12, 2, 1);
        forceTopA = 0;
        Snap memory a = _launchWith(c, 1.79092 ether, 55);
        for (uint256 i; i < DRAWS; ++i) _single(i);
        assertGt(topWon, 0, "the expensive-prize event was actually reached");
        assertEq(deposited, 1.79092 ether, "no creator ETH added after opening");
        Fact[] memory x = new Fact[](2);
        x[0] = Fact("initial_opening_requirement_wei", 1.79092 ether);
        x[1] = Fact("operating_topups_wei", 0);
        _done("minimum_large_win", a, x);
    }

    function _quietBoard(string memory regime, uint256[16] memory c, uint256 deposit, uint256 units) internal {
        Snap memory a = _launchWith(c, deposit, units);
        for (uint256 i; i < DRAWS; ++i) _single(i);
        Fact[] memory x = new Fact[](2);
        x[0] = Fact("board_shape_units", units);
        x[1] = Fact("pending_draws_admitted_by_board", 3_000 * balancer.targetWeight() / (10_000 * (1e36 / 0.01 ether)));
        _done(regime, a, x);
    }

    /// @dev R19 / O10: the launch board at normal gas (basefee 0.1 gwei), quiet play; before every draw, FWA's all-in
    ///      quote (draw price and randomness fee) against the expected Shape backing of a draw, computed from FWA's
    ///      active listings (weight x backing / total weight; an NFT counts as 0).
    function test_breakdown_normalGas() public {
        baseFeeRegime = 0.1 gwei;
        Snap memory a = _launch();
        trackPrice = true;
        for (uint256 i; i < DRAWS; ++i) _single(i);
        Fact[] memory x = new Fact[](3);
        x[0] = Fact("player_price_to_backing_bps_max", maxPriceToBackingBps);
        x[1] = Fact("player_price_to_backing_bps_min", minPriceToBackingBps);
        x[2] = Fact("base_fee_wei", feeNow);
        _done("normal_gas", a, x);
    }

    /// @dev R4: quiet play with gas held at 2 gwei (basefee 1.95) and at the 5 gwei cap (basefee 4.95).
    function test_breakdown_gas2() public {
        baseFeeRegime = 1.95 gwei;
        Snap memory a = _launch();
        for (uint256 i; i < DRAWS; ++i) _single(i);
        _done("gas_2_gwei", a, new Fact[](0));
    }

    function test_breakdown_gas5() public {
        baseFeeRegime = CAP_FEE;
        Snap memory a = _launch();
        for (uint256 i; i < DRAWS; ++i) _single(i);
        _done("gas_5_gwei", a, new Fact[](0));
    }

    function _trackPrice() internal {
        (,, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 w;
        uint256 wb;
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 k; k < ids.length; ++k) {
            (,,,, uint256 weight,,, uint8 st) = pool.listings(ids[k]);
            if (st != 1) continue;
            w += weight;
            (uint8 kind, uint8 d,,,) = balancer.items(ids[k]);
            if (kind == SHAPE_KIND) wb += weight * balancer.denominationAmount(d);
        }
        if (wb == 0) return;
        uint256 r = total * 10_000 * w / wb;
        if (r > maxPriceToBackingBps) maxPriceToBackingBps = r;
        if (r < minPriceToBackingBps) minPriceToBackingBps = r;
    }

    /// @dev D16 (launch audit B, S1; since 2026-11-23 upkeep processes only Ready draws past the processing grace): only
    ///      players, the randomness service and keepers act; the harness never calls FWA's processAcquisitions. Keepers act between every two events, as a keeper polling every 12 seconds does. Each
    ///      step three players overlap: A and B buy, A's word arrives, the keeper reconciles A and restocks its prize
    ///      (staged, since B is in flight), C buys and reserves that staged restock, which costs C FWA's randomness fast
    ///      path; then B's and C's words arrive and keepers run.
    function test_breakdown_noProcessor() public {
        _noProcessor("no_processor");
    }

    /// @dev The same at the 5 gwei reimbursement cap (basefee 4.95 gwei): measures the refunds keepers keep there.
    function test_breakdown_noProcessor5() public {
        baseFeeRegime = CAP_FEE;
        _noProcessor("no_processor_5_gwei");
    }

    /// @dev ape-Ball's opening days on mainnet (43, 44, 54 and 18 draws; its own upkeep processed up to 6 waiting draws
    ///      in one call). Each round of seven: A buys and settles, B buys, keepers reconcile A and restock its prize
    ///      (staged, since B is in flight), C buys and reserves that restock (losing FWA's randomness fast path), B's
    ///      word arrives, then four more players buy before any keeper acts. The five words arrive last to first, so when
    ///      keepers next act C and the four behind it wait in FWA's queue: the most the Balancer admits (MAX_BATCH).
    ///      Keepers process them two per call.
    function test_breakdown_burst() public {
        Snap memory a = _launch();
        uint8[4] memory roundsPerDay = [6, 6, 8, 3];
        uint256 w;
        for (uint256 d; d < 4; ++d) {
            for (uint256 r; r < roundsPerDay[d]; ++r) {
                uint256[] memory pa = _tryBuy();
                if (pa.length == 1) _deliver(pa[0], _word(w++));
                uint256[] memory pb = _tryBuy();
                _keeperPass();
                uint256[5] memory c;
                uint256 nc;
                for (uint256 k; k < 5; ++k) {
                    uint256[] memory p = _tryBuy();
                    if (p.length == 1) {
                        c[nc++] = p[0];
                        if (k == 0 && IReservedListings(address(pool)).reservedListingCount(pool.lastIssuedSequence()) != 0) {
                            ++reservedDraws;
                        }
                    }
                    if (k == 0 && pb.length == 1) _deliver(pb[0], _word(w++));
                }
                for (uint256 k = nc; k > 0; --k) _deliver(c[k - 1], _word(w++));
                _keeperPass();
                _account(openIds);
                while (nftsToRelist != 0) {
                    --nftsToRelist;
                    _listNft();
                    _keeperPass();
                }
            }
            _pastProcessingGrace();
            _service();
            _account(openIds);
            uint256 u = pool.unsettledAcquisitionCount();
            if (u > maxUnsettledAtDayEnd) maxUnsettledAtDayEnd = u;
            _endOfDay();
        }
        assertGt(reservedDraws, 0, "reached: draws reserved a staged restock and lost FWA's fast path");
        assertEq(fwaQueueReadyMax, 5, "reached: five draws waiting in FWA's queue at one keeper call (MAX_BATCH)");
        Fact[] memory x = new Fact[](3);
        x[0] = Fact("draws_that_reserved_a_staged_restock", reservedDraws);
        x[1] = Fact("unsettled_draws_at_day_end_max", maxUnsettledAtDayEnd);
        x[2] = Fact("unsettled_draws_at_end", pool.unsettledAcquisitionCount());
        _done("burst", a, x);
    }

    function _noProcessor(string memory regime) internal {
        Snap memory a = _launch();
        for (uint256 i; i < DRAWS; ++i) {
            uint256[] memory pa = _tryBuy();
            uint256[] memory pb = _tryBuy();
            if (pa.length == 1) _deliver(pa[0], _word(i));
            _keeperPass();
            uint256[] memory pc = _tryBuy();
            if (pc.length == 1 && IReservedListings(address(pool)).reservedListingCount(pool.lastIssuedSequence()) != 0) {
                ++reservedDraws;
            }
            if (pb.length == 1) _deliver(pb[0], _word(i + DRAWS));
            if (pc.length == 1) _deliver(pc[0], _word(i + 2 * DRAWS));
            _keeperPass();
            _account(openIds);
            while (nftsToRelist != 0) {
                --nftsToRelist;
                _listNft();
                _keeperPass();
            }
            if ((i + 1) % PER_DAY == 0) {
                _pastProcessingGrace();
                _service();
                _account(openIds);
                uint256 u = pool.unsettledAcquisitionCount();
                if (u > maxUnsettledAtDayEnd) maxUnsettledAtDayEnd = u;
                _endOfDay();
            }
        }
        assertGt(reservedDraws, 0, "reached: draws reserved a staged restock and lost FWA's fast path");
        Fact[] memory x = new Fact[](3);
        x[0] = Fact("draws_that_reserved_a_staged_restock", reservedDraws);
        x[1] = Fact("unsettled_draws_at_day_end_max", maxUnsettledAtDayEnd);
        x[2] = Fact("unsettled_draws_at_end", pool.unsettledAcquisitionCount());
        _done(regime, a, x);
    }

    /// @dev Upkeep processes a stuck Ready draw only once it was requested `processGraceBlocks` ago (owner decision D3,
    ///      50 blocks), so a day-end measurement taken in the request block saw draws legitimately inside the grace. The
    ///      day now ends after the grace has run. Timing only: no outcome target changes.
    function _pastProcessingGrace() internal {
        vm.roll(vm.getBlockNumber() + balancer.effectiveEconomics().processGraceBlocks);
    }

    function _tryBuy() internal returns (uint256[] memory ids) {
        if (!balancer.canPurchase(buyer)) {
            _refused(1);
            return ids;
        }
        ids = _buy(1);
        if (ids.length == 1) openIds.push(ids[0]);
    }

    function _collectedIn(Vm.Log[] memory logs) internal view returns (uint256 amount) {
        bytes32 topic = keccak256("ProceedsCollected(uint256)");
        for (uint256 k; k < logs.length; ++k) {
            if (logs[k].emitter == address(balancer) && logs[k].topics[0] == topic) amount += abi.decode(logs[k].data, (uint256));
        }
    }

    function _largeWinFacts() internal view returns (Fact[] memory x) {
        x = new Fact[](12);
        x[0] = Fact("forced_top_prize_draw_a", forceTopA);
        x[1] = Fact("forced_top_prize_draw_b", forceTopB);
        x[2] = Fact("days_top_prize_missing_from_design", daysTopMissing);
        x[3] = Fact("creator_topped_up_wei", toppedUp);
        // what the creator holds at the end: claimed, plus everything still in the Balancer, its listed backing and
        // uncollected proceeds (all claimable after closing and unlisting)
        x[4] = Fact(
            "creator_position_at_end_wei",
            claimed + address(balancer).balance + _backingListed() + pool.ownerProceeds()
        );
        x[5] = Fact("top_prizes_listed_at_end", balancer.getActiveShapes()[TOP]);
        x[6] = Fact("claimed_right_after_setup_wei", claimedAtSetup);
        x[7] = Fact("creator_credit_claimed_wei", creatorCreditAccrued - balancer.creatorCredit());
        // at day 30, after the creator's last daily claim
        x[8] = Fact("end_backing_listed_wei", _backingListed());
        x[9] = Fact("end_held_in_balancer_wei", address(balancer).balance);
        x[10] = Fact("end_required_reserve_wei", balancer.requiredReserve());
        x[11] = Fact("end_withdrawable_now_wei", balancer.withdrawableSurplus());
    }

    /// @dev As quiet, with gas moving by draw index: 0-44 at 0.55 gwei, 45-89 at 5 gwei (the reimbursement cap),
    ///      90-134 at 20.05 gwei (beyond it), 135-179 back at 0.55 gwei.
    function test_breakdown_gasSpike() public {
        Snap memory a = _launch();
        spikeRegime = true;
        for (uint256 i; i < DRAWS; ++i) _single(i);
        assertEq(maxGasSeen, SPIKE_FEE + TIP, "20.05 gwei gas price seen inside a transaction");
        assertEq(maxFeeSeen, SPIKE_FEE, "20 gwei basefee seen inside a transaction");
        assertEq(feeNow, BASEFEE, "the spike ended");
        Fact[] memory x = new Fact[](18);
        string[4] memory n = ["base", "at_cap", "beyond_cap", "after_spike"];
        for (uint256 p; p < 4; ++p) {
            x[4 * p] = Fact(string.concat("draws_sold_", n[p]), phaseSold[p]);
            x[4 * p + 1] = Fact(string.concat("draws_refused_", n[p]), phaseRefused[p]);
            x[4 * p + 2] = Fact(string.concat("upkeeps_skipped_", n[p]), phaseSkipped[p]);
            x[4 * p + 3] = Fact(string.concat("one_draw_quote_wei_", n[p]), phaseQuote[p]);
        }
        x[16] = Fact("max_gas_price_seen_in_tx", maxGasSeen);
        x[17] = Fact("max_base_fee_seen_in_tx", maxFeeSeen);
        _done("gas_spike", a, x);
    }

    /// @dev As quiet until draw 60. For attempts 60-119 (ten days) no randomness is delivered: players buy until
    ///      refused, FWA times each draw out and credits the player. At 120 the service recovers, delivers the words
    ///      it owed, the player withdraws the credit and play continues.
    function test_breakdown_randomnessNotDelivered() public {
        Snap memory a = _launch();
        uint256 i;
        for (; i < 60; ++i) _single(i);
        uint256 timeout = IPoolMore(address(pool)).selectionTimeoutBlocks();
        uint256 paidBefore = playersPaid;
        uint256[] memory late = new uint256[](60);
        uint256 nLate;
        uint256 refusalStatus;
        uint256 revertsBefore = buyReverts;
        for (; i < 120; ++i) {
            if (balancer.canPurchase(buyer)) {
                uint256[] memory ids = _buy(1);
                if (ids.length == 1) late[nLate++] = ids[0];
            } else {
                refusalStatus = balancer.admissionStatus();
                _refused(1);
            }
            if ((i + 1) % PER_DAY != 0) continue;
            vm.roll(vm.getBlockNumber() + timeout + 1);
            _processOnFwa(); // expired draws: upkeep processes only Ready stuck draws (owner decision 2026-11-23)
            for (uint256 k; k < 3 && pool.unsettledAcquisitionCount() != 0; ++k) _keeperPass();
            assembly ("memory-safe") {
                mstore(late, nLate)
            }
            _account(late);
            _service();
            _endOfDay();
        }
        uint256 outstanding = _vrfOutstanding();
        uint256 credit = IPoolMore(address(pool)).acquisitionRefundCredit(buyer);
        uint256 paidInOutage = playersPaid - paidBefore;
        assertGt(expired, 0, "FWA expired draws through its timeout");
        assertGt(credit, 0, "the player holds refund credit");
        for (uint256 k; k < nLate; ++k) _deliver(late[k], uint256(keccak256(abi.encode(SEED, "late", k))));
        _keeperPass();
        vm.prank(buyer, buyer);
        refundsWithdrawn += IPoolMore(address(pool)).withdrawAcquisitionRefund();
        _service();
        for (; i < DRAWS; ++i) _single(i);
        Fact[] memory x = new Fact[](10);
        x[0] = Fact("selection_timeout_blocks", timeout);
        x[1] = Fact("draws_bought_in_outage", nLate);
        x[2] = Fact("player_paid_in_outage_wei", paidInOutage);
        x[3] = Fact("player_refund_credit_wei", credit);
        x[4] = Fact("player_not_refunded_wei", paidInOutage - credit);
        x[5] = Fact("admission_status_when_refused_in_outage", refusalStatus);
        x[6] = Fact("buy_reverts_in_outage", buyReverts - revertsBefore);
        x[7] = Fact("vrf_outstanding_after_expiry", outstanding);
        x[8] = Fact("vrf_outstanding_after_resume", _vrfOutstanding());
        x[9] = Fact("late_words_rejected", deliverReverts);
        _done("randomness_not_delivered", a, x);
    }

    /// @dev As limits_at_max for 90 draws, then five draws are bought and the creator closes before any word
    ///      arrives. Two of the five are delivered, three never are and time out. The creator then reconciles, unlists
    ///      every prize, takes the NFT back, claims everything and retires the pool.
    function test_breakdown_closeoutPending() public {
        Snap memory a = _launch();
        _runBatches(0, 90);
        assertTrue(balancer.canPurchase(buyer), "open before the last batch");
        uint256[] memory ids = _buy(5);
        assertEq(pool.unsettledAcquisitionCount(), 5, "five draws pending at close");
        Fact[] memory x = new Fact[](23);
        x[0] = Fact("draws_pending_at_close", 5);
        _collectNow();
        vm.prank(creator);
        balancer.close();
        uint256 heldAtClose = balancer.requiredReserve();
        assertEq(heldAtClose, 5 * _reconciliationBudget(), "closed hold tracks the five actual draws at current gas");
        // D3: while closed, keeper pay for the unreconciled draws is held; nothing else may be withheld
        uint256 unclaimable = address(balancer).balance - balancer.withdrawableSurplus();
        x[1] = Fact("unclaimable_after_close_beyond_held_pay_wei", unclaimable > heldAtClose ? unclaimable - heldAtClose : 0);
        x[22] = Fact("closed_reconciliation_target_shortfall_wei", heldAtClose > unclaimable ? heldAtClose - unclaimable : 0);
        // what the creator can take while the draws are still pending
        uint256[] memory first = _chunk(_ids(SHAPE_KIND), 0);
        x[2] = Fact("unlist_blocked_while_pending", _unlist(first) ? 0 : 1);
        x[3] = Fact("nft_withdraw_blocked_while_pending", _withdrawNfts() == 0 ? 1 : 0);
        x[4] = Fact("claimed_at_close_wei", _claim());
        uint256 startBlock = vm.getBlockNumber();
        _deliver(ids[0], _word(90));
        _deliver(ids[1], _word(91));
        _keeperPass();
        _account(ids);
        vm.roll(vm.getBlockNumber() + IPoolMore(address(pool)).selectionTimeoutBlocks() + 1);
        _processOnFwa(); // expired draws: upkeep processes only Ready stuck draws (owner decision 2026-11-23)
        for (uint256 k; k < 3 && pool.unsettledAcquisitionCount() != 0; ++k) _keeperPass();
        _account(ids);
        assertEq(pool.unsettledAcquisitionCount(), 0, "every pending draw settled or timed out");
        x[5] = Fact("blocks_until_closeout_possible", vm.getBlockNumber() - startBlock);
        x[6] = Fact("draws_expired_after_close", expired);
        // the creator claimed everything at close, so the keeper's pay for reconciling comes from the proceeds of the
        // draws that settled afterwards
        uint256 paidBefore = keeper.balance;
        _keeperPass();
        uint256 creatorUpkeeps;
        while (_upkeep(creator, false) == RAN) ++creatorUpkeeps;
        x[7] = Fact("creator_upkeeps_to_reconcile", creatorUpkeeps);
        x[10] = Fact("keeper_paid_after_close_wei", keeper.balance - paidBefore);
        uint256[] memory prizes = _ids(SHAPE_KIND);
        for (uint256 from; from < prizes.length; from += 20) assertTrue(_unlist(_chunk(prizes, from)), "unlist");
        x[8] = Fact("nfts_returned_to_creator", _withdrawNfts());
        _claim();
        vm.prank(creator);
        balancer.retire();
        vm.prank(buyer, buyer);
        refundsWithdrawn += IPoolMore(address(pool)).withdrawAcquisitionRefund();
        x[9] = Fact("pool_retired", pool.retired() ? 1 : 0);
        x[11] = Fact("creator_assets_left_wei", address(balancer).balance + _backingListed() + pool.ownerProceeds());
        x[12] = Fact("prizes_still_listed", balancer.getActiveIds().length);
        x[13] = Fact("creator_net_gain_wei", claimed > deposited ? claimed - deposited : 0);
        x[14] = Fact("creator_net_loss_wei", deposited > claimed ? deposited - claimed : 0);
        x[15] = Fact("redeem_gap_wei", redeemGap);
        // what FWA still holds after the closeout, by whose it is (FWA's own public totals)
        IPoolMore m = IPoolMore(address(pool));
        uint256 fwaHeld = address(pool).balance;
        uint256 named = m.accruedProtocolFees() + m.deliveryEscrowTotal() + m.acquisitionEscrowTotal()
            + m.acquisitionRefundCreditTotal() + pool.ownerProceeds();
        x[16] = Fact("fwa_held_after_closeout_wei", fwaHeld);
        x[17] = Fact("fwa_protocol_fees_accrued_wei", m.accruedProtocolFees());
        x[18] = Fact("fwa_player_escrow_and_refund_credit_wei", m.deliveryEscrowTotal() + m.acquisitionEscrowTotal() + m.acquisitionRefundCreditTotal());
        x[19] = Fact("fwa_owner_proceeds_wei", pool.ownerProceeds());
        x[20] = Fact("fwa_held_not_named_wei", fwaHeld > named ? fwaHeld - named : 0);
        x[21] = Fact("keeper_pay_held_at_close_wei", heldAtClose);
        assertEq(fwaHeld, named, "every wei FWA holds is in one of its named totals");
        _done("closeout_pending", a, x);
    }

    /// @dev Same inputs bought five at a time, with keepers running after every single settlement, so each restock
    ///      lists while one to four draws are still unsettled and FWA stages it. Every collection uses the stored rate.
    function test_breakdown_restockInFlight() public {
        Snap memory a = _launch();
        creditCheck = true;
        _runInFlight(0, DRAWS);
        // The last delivered draw was left unreconciled because reconciling it was unprofitable for the rational
        // keeper, so the Balancer's prize counters (lowered at reconciliation) still counted the won 0.01 ETH prize: the
        // gate's counter-vs-holding check read a 0.01 ETH gap. The creator runs upkeep at the end, as in the other
        // creator-response regimes, so the run ends reconciled. Scenario end only.
        while (_upkeep(creator, false) == RAN) {}
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence(), "ends with every draw reconciled");
        // reached: restocks were made and staged while draws were unsettled, and collections were checked
        assertGt(upkeepsWhileUnsettled, 0, "upkeep ran while draws were unsettled");
        assertGt(restocksStaged, 0, "restocks listed while draws were unsettled");
        assertGe(maxInFlightAtRestock, 3, "a restock listed with at least three draws unsettled");
        assertGt(creditChecks, 0, "all collections were checked, including zero bookings");
        assertGt(creditExpected, 0, "the reached purchase boards owe positive creator profit");
        Fact[] memory x = new Fact[](10);
        x[0] = Fact("credit_collections_checked", creditChecks);
        x[1] = Fact("credit_collections_zero_booked", creditZeroBooked);
        x[2] = Fact("credit_expected_wei", creditExpected);
        x[3] = Fact("credit_booked_wei", creditBooked);
        x[4] = Fact("credit_overbooked_wei", creditOver);
        x[5] = Fact("credit_underbooked_wei", creditUnder);
        x[6] = Fact("owner_proceeds_vs_board_price_mismatch_wei", proceedsMismatch);
        x[7] = Fact("max_draws_unsettled_at_a_staged_restock", maxInFlightAtRestock);
        x[8] = Fact("restocks_staged_while_unsettled_checked", restocksStaged);
        x[9] = Fact("creator_credit_error_wei", creditOver + creditUnder);
        _done("restock_in_flight", a, x);
    }

    /// @dev Reach a real proof pause through FWA expiry and staging, then exercise the scenario recorder and the
    ///      caller-paid recovery path. Ordinary economic regimes do not perform this recovery automatically.
    function test_evidence_recordsCuratedProofRefusalsAndPublicRecovery() public {
        vm.fee(BASEFEE);
        vm.txGasPrice(BASEFEE + TIP);
        createBalancer(2 ether);
        configure(plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        uint256 originalCurated = listCurated(1, NFT_VALUE);
        vm.prank(creator);
        balancer.open();
        fillUp();
        buy(buyer, 1);

        configure(plan([uint256(32), 0, 0, 0, 0, 0, 0, 0, 0]));
        upkeep(); upkeep(); upkeep();
        uint256 stagedCurated = listCurated(2, NFT_VALUE);
        vm.roll(block.number + IPoolMore(address(pool)).selectionTimeoutBlocks() + 1);
        settle(); // the expired draw is processed on FWA by anyone
        upkeep();
        vm.prank(creator);
        balancer.withdrawCurated(originalCurated, creator);
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(pool.activeListingCount(), 20);
        assertEq(balancer.listedShapePrizes(), 32);
        (,,,,,, uint256 slot, uint8 status) = pool.listings(stagedCurated);
        assertEq(slot, 0);
        assertEq(status, 5, "sole curated NFT is staged behind twelve Shapes");
        assertEq(balancer.admissionStatus(), 7);
        assertFalse(balancer.canPurchase(buyer));
        _refused(1);
        _refused(5);
        assertEq(refused, 6);
        assertEq(refusedBy[7], 6, "single and batch refusals retain the proof-required reason");
        assertEq(refusedBy[6], 0);
        assertEq(phaseRefused[0], 6);
        vm.prank(stranger);
        vm.expectRevert(PoolInventory.InvalidItem.selector);
        balancer.refreshCuratedWitness(stagedCurated);

        uint256 fund = address(balancer).balance;
        uint256 credit = balancer.creatorCredit();
        uint256 allowance = balancer.keeperAllowance();
        uint256 keeperCash = keeper.balance;
        vm.prank(stranger);
        pool.activateListings(13);
        vm.prank(stranger);
        assertTrue(balancer.refreshCuratedWitness(stagedCurated));
        assertEq(address(balancer).balance, fund, "proof recovery needs no new pool capital");
        assertEq(balancer.creatorCredit(), credit);
        assertEq(balancer.keeperAllowance(), allowance);
        assertEq(keeper.balance, keeperCash, "proof recovery creates no keeper compensation");
        assertEq(balancer.admissionStatus(), 0);
        buy(buyer, 1);
        assertEq(pool.unsettledAcquisitionCount(), 1, "the buyer resumes after public proof recovery");
    }

    function test_evidence_selectedListingFeeIsNotRealizedIncome() public {
        baseFeeRegime = CAP_FEE;
        uint256[16] memory c;
        (c[0], c[10]) = (20, 1);
        _launchWith(c, 2 ether, 23);
        // This reproducer includes full Pack replacement, rather than the permitted low-capital deferral.
        vm.prank(creator);
        balancer.depositETH{value: 0.1 ether}();
        deposited += 0.1 ether;
        uint256 selectedFee;
        uint256 packSlot;
        uint256 weightedWithoutFee;
        uint256 weightTotal;
        for (uint256 lid = 1; lid < nextLid; ++lid) {
            (,,,, uint256 weight, uint256 price, uint256 slot, uint8 status) = pool.listings(lid);
            if (status != 1) continue;
            (uint8 kind, uint8 d,, uint112 base,) = balancer.items(lid);
            weightTotal += weight;
            weightedWithoutFee += weight * (kind == SHAPE_KIND ? base : price);
            if (kind == SHAPE_KIND && d == 10) {
                selectedFee = price - base;
                packSlot = slot;
            }
        }
        assertEq(selectedFee, 0.01425 ether, "three Shape units each list with the 5 gwei 0.00475 ETH surcharge");
        (uint256[] memory ids,,) = this.extBuy(1);
        assertEq(ids.length, 1);
        assertGt(drawFee[ids[0]], 0, "the pending draw has an expected surcharge contribution");
        assertEq(feesReceived, 0, "pending purchase escrow is not realized owner income");
        _deliver(ids[0], wordForSlot(packSlot));
        _account(ids);
        assertEq(fulfilled, 1, "the selected Pack was actually delivered");
        uint256 actualOwnerCash = pool.ownerProceeds();
        assertEq(actualOwnerCash, drawBase[ids[0]], "real FWA owner cash equals its request-time base");
        assertEq(feesReceived, actualOwnerCash - weightedWithoutFee / weightTotal);
        assertEq(selectedFeesWon, selectedFee, "selected fee remains a separate listing statistic");
        assertGt(selectedFee, 2 * feesReceived, "the selected prize fee cannot stand in for realized surcharge cash");
        _service();
        assertEq(ownerProceedsRealized, proceedsCollected + pool.ownerProceeds());
        assertEq(backingWon, 0.03 ether, "the actual winning Pack carried three small Shapes");
        assertEq(balancer.getActiveShapes()[10], 1, "the funded Pack was really replaced");
        assertGt(keeperPaidPlay, feesReceived, "this Pack win has a real surcharge versus keeper-payment shortfall");
        assertLt(keeperPaidPlay, selectedFee, "selected-fee accounting would falsely report coverage");
        emit log_named_decimal_uint("selected listing fee", selectedFee, 18);
        emit log_named_decimal_uint("actual request-board surcharge receipts", feesReceived, 18);
        emit log_named_decimal_uint("actual keeper play reward", keeperPaidPlay, 18);
    }

    // ------------------------------------------------------------------ driver

    /// @dev Sets and proves the gas context, then the creator's whole setup, inside the measured window.
    function _launch() internal returns (Snap memory a) {
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[TOP]) = (24, 8, 12, 2, 1);
        a = _launchWith(c, DEPOSIT, BOARD_UNITS);
    }

    function _launchWith(uint256[16] memory c, uint256 deposit, uint256 boardUnits) internal returns (Snap memory a) {
        uint256 bf = baseFeeRegime == 0 ? BASEFEE : baseFeeRegime;
        (gasNow, feeNow) = (bf + TIP, bf);
        a = flowBegin(gasNow, feeNow, FORK_BLOCK);
        probe = new GasProbe();
        createBalancer(deposit);
        deposited += deposit;
        vm.startPrank(creator);
        balancer.configure(uint16(MARKUP_BPS), plan16(c), shapes.mintFee());
        vm.stopPrank();
        if (!noNft) _listNft();
        vm.prank(creator);
        balancer.open();
        assertTrue(_keeperPass(), "keepers finished the setup");
        assertEq(_implementation(address(pool)), 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7, "FWA pool clones StandardPool: its code is cooled too");
        assertTrue(_implementation(address(balancer)) != address(0), "the Balancer is a clone: its code is cooled too");
        assertEq(balancer.admissionStatus(), 0, "purchases admitted after setup");
        assertEq(unitsListed, boardUnits, "the whole board is listed");
        claimedAtSetup = _claim();
    }

    function _done(string memory regime, Snap memory a, Fact[] memory extra) internal {
        _account(allIds);
        assertEq(ownerProceedsRealized, proceedsCollected + pool.ownerProceeds(), "fulfilled request bases equal actual FWA owner proceeds");
        assertLe(feesReceived, ownerProceedsRealized, "surcharge is a component of realized proceeds, not extra cash");
        if (creditCheck) {
            assertEq(creditBooked, creatorCreditAccrued, "all actual creator credit is included in collection checks");
            assertEq(creditOver + creditUnder, 0, "every collection allocates the exact stored rate");
        }
        // absolute amounts, computed here rather than read back from the Balancer
        assertEq(mintFees, unitsListed * 0.001 ether, "Shapes mint fee: 0.001 ETH per Shape minted");
        assertEq(backingMinted, backingRedeemed + backingWon + _backingListed(), "every minted wei of backing is listed, won or redeemed");
        uint256 n = 67;
        Fact[] memory f = new Fact[](n + extra.length);
        f[65] = Fact("creator_credit_error_wei", creditOver + creditUnder);
        f[66] = Fact("refused_curated_proof_required", refusedBy[7]);
        f[0] = Fact("draws_requested", requested);
        f[1] = Fact("draws_fulfilled", fulfilled);
        f[2] = Fact("draws_expired", expired);
        f[3] = Fact("draws_refused", refused);
        f[4] = Fact("refused_setting_up", refusedBy[2]);
        f[5] = Fact("refused_no_curated", refusedBy[3]);
        f[6] = Fact("refused_busy", refusedBy[4]);
        f[7] = Fact("refused_low_inventory", refusedBy[6]);
        f[8] = Fact("buy_reverts", buyReverts);
        f[9] = Fact("max_unsettled", maxUnsettled);
        f[10] = Fact("busy_status_seen", busySeen);
        f[11] = Fact("max_reconciled_in_one_upkeep", maxReconciled);
        f[12] = Fact("max_shape_units_in_one_upkeep", maxUnits);
        f[13] = Fact("shape_units_listed", unitsListed);
        f[14] = Fact("upkeeps_run", upkeepsRun);
        f[15] = Fact("upkeeps_skipped_unprofitable", upkeepsSkipped);
        f[16] = Fact("upkeeps_with_nothing_to_do", upkeepsNothing);
        f[17] = Fact("upkeeps_while_draws_unsettled", upkeepsWhileUnsettled);
        f[18] = Fact("restocks_staged_while_unsettled", restocksStaged);
        f[19] = Fact("restock_incomplete_after_full_pass", incompleteAfterFullPass);
        f[20] = Fact("low_inventory_after_full_upkeep", lowInventoryAfterFullPass);
        f[21] = Fact("max_reserve_shortfall_wei", maxReserveShortfall);
        f[22] = Fact("keeper_passes_with_reserve_short", passesWithReserveShort);
        f[23] = Fact("nfts_won", nftsWon);
        f[24] = Fact("top_prizes_won", topWon);
        f[25] = Fact("top_prize_not_listed_when_forced", topNotListedWhenForced);
        f[26] = Fact("days_run", daysRun);
        f[27] = Fact("keeper_paid_outside_creator_work_wei", keeperPaidPlay);
        f[28] = Fact("keeper_paid_for_creator_work_wei", keeperPaidSetup);
        f[29] = Fact("keeper_gas_cost_wei", keeperGasCost);
        uint256 paid = keeperPaidPlay + keeperPaidSetup;
        f[30] = Fact("keeper_profit_wei", paid > keeperGasCost ? paid - keeperGasCost : 0);
        f[31] = Fact("keeper_loss_wei", keeperGasCost > paid ? keeperGasCost - paid : 0);
        f[32] = Fact("keeper_paid_beyond_gas_and_reward_wei", paidBeyondGasAndReward);
        f[33] = Fact("restock_fees_listed_wei", feesListed);
        f[34] = Fact("selected_listing_restock_fees_won_wei", selectedFeesWon);
        f[35] = Fact("restock_fees_outstanding_wei", feesListed - selectedFeesWon - feesUnlisted);
        f[36] = Fact("creator_credit_accrued_wei", creatorCreditAccrued);
        f[37] = Fact("creator_credit_share_of_proceeds_bps", proceedsCollected == 0 ? 0 : creatorCreditAccrued * 10_000 / proceedsCollected);
        f[38] = Fact("creator_revenue_bps", balancer.creatorRevenueBps());
        f[39] = Fact("creator_deposited_wei", deposited);
        f[40] = Fact("creator_claimed_wei", claimed);
        f[41] = Fact("admission_status_at_end", balancer.admissionStatus());
        f[42] = Fact("unknown_wins", unknownWins);
        f[43] = Fact("upkeep_reverts", upkeepReverts);
        f[44] = Fact("max_reserve_shortfall_all_reconciled_wei", maxShortfallReconciled);
        f[45] = Fact("refused_low_inventory_within_gas_cap", refusedBy[6] - phaseRefused[2]);
        f[46] = Fact("first_buy_revert_selector", firstBuyRevert);
        f[47] = Fact("unreconciled_draws_at_end", pool.lastIssuedSequence() - balancer.reconciledSequence());
        (f[48].value, f[49].value, f[50].value) = _whatIfUnpaidUpkeep();
        (f[48].key, f[49].key, f[50].key) =
            ("unpaid_upkeeps_needed_at_end", "max_unpaid_upkeep_cost_wei", "admission_status_after_unpaid_upkeep");
        f[51] = Fact("days_ending_with_a_prize_missing", daysPrizeMissing);
        // R4: only the request-board surcharge actually realized in owner proceeds repays keeper cash.
        uint256 keeperAll = keeperPaidPlay + keeperPaidSetup;
        f[52] = Fact("creator_keeper_net_gain_wei", feesReceived > keeperAll ? feesReceived - keeperAll : 0);
        f[53] = Fact("creator_keeper_net_loss_wei", keeperAll > feesReceived ? keeperAll - feesReceived : 0);
        // the same for play only, leaving out the creator's own setup work (opening, configuring, unlisting)
        f[56] = Fact("creator_keeper_play_net_loss_wei", keeperPaidPlay > feesReceived ? keeperPaidPlay - feesReceived : 0);
        // R8: the creator's net, everything claimed or still theirs (Balancer ETH, listed backing, uncollected
        // proceeds) less everything deposited and the NFTs given away at their stated value (the harness hands the
        // creator a fresh NFT after each win, so that value is a cost here)
        uint256 held = claimed + address(balancer).balance + _backingListed() + pool.ownerProceeds();
        uint256 cost = deposited + nftsWon * NFT_VALUE;
        f[54] = Fact("creator_net_gain_wei", held > cost ? held - cost : 0);
        f[55] = Fact("creator_net_loss_wei", cost > held ? cost - held : 0);
        // O1: storage refunds a keeper keeps beyond the pay rule (the Balancer measures gas before refunds), averaged
        // per draw requested and for the worst single call, and as a share of the creator's net (information)
        f[57] = Fact("keeper_refund_gas_kept_per_draw", requested == 0 ? 0 : paidBeyondGas / requested);
        f[58] = Fact("keeper_refund_gas_kept_worst_call", paidBeyondGasWorstCall);
        f[59] = Fact("keeper_refund_share_of_creator_net_bps", held > cost ? paidBeyondGasAndReward * 10_000 / (held - cost) : 0);
        // how many draws FWA's queue held ready to process when a call ran, against the 2 a call processes (information)
        f[60] = Fact("fwa_queue_ready_max", fwaQueueReadyMax);
        f[61] = Fact("upkeeps_with_fwa_queue_ready", upkeepsWithQueueReady);
        f[62] = Fact("upkeeps_with_fwa_queue_ready_over_2", upkeepsWithQueueReadyOver2);
        f[63] = Fact("restock_fee_receipts_wei", feesReceived);
        f[64] = Fact("owner_proceeds_realized_wei", ownerProceedsRealized);
        for (uint256 j; j < extra.length; ++j) f[n + j] = extra[j];
        flowReport(regime, a, f);
    }

    /// @dev What it would take if someone ran the upkeep the paid keeper declined (the creator may always run it; the
    ///      shipped keeper accepts a loss of MAX_LOSS_WEI, 0.0002 ETH by default, per call). State is restored.
    function _whatIfUnpaidUpkeep() internal returns (uint256 calls, uint256 maxCost, uint256 statusAfter) {
        if (!balancer.enabled()) return (0, 0, balancer.admissionStatus());
        uint256 snap = vm.snapshotState();
        for (; calls < 40; ++calls) {
            _coolKeeperTx();
            vm.prank(creator, creator);
            try balancer.performUpkeepUnpaid() returns (uint256 reward) {
                uint256 cost = ReceiptGas.lastBilled() * gasNow;
                cost = cost > reward ? cost - reward : 0;
                if (cost > maxCost) maxCost = cost;
            } catch {
                break;
            }
        }
        statusAfter = balancer.admissionStatus();
        vm.revertToStateAndDelete(snap);
    }

    function _assertLimits() internal view {
        assertEq(maxUnsettled, 5, "five draws unsettled at once (FWA batch limit, MAX_BATCH)");
        assertGt(busySeen, 0, "the gate reported BUSY");
        assertEq(maxReconciled, 5, "five draws reconciled in one upkeep (MAX_RECONCILE)");
        assertEq(maxUnits, 5, "five Shape units restocked in one upkeep (MAX_OPS)");
        assertGt(restocksStaged, 0, "upkeep restocked while draws were unsettled");
    }

    function _single(uint256 i) internal {
        _gasPhase(i);
        if (trackPrice) _trackPrice();
        if (i == actAt) _act();
        if (i == withdrawCuratedAt) assertEq(_withdrawNfts(), 1, "the last curated NFT was withdrawn mid-run");
        if (i == listCuratedAt) _listNftBatch();
        if (!balancer.canPurchase(buyer)) {
            _refused(1);
        } else {
            uint256[] memory ids = _buy(1);
            if (ids.length == 1) {
                _deliver(ids[0], _word(i));
                _keeperPass(); // nobody else processes FWA's queue: keepers do it inside upkeep (D16)
                _account(ids);
            }
        }
        _service();
        if ((i + 1) % PER_DAY == 0) _endOfDay();
    }

    function _runBatches(uint256 from, uint256 to) internal {
        uint256 batch;
        for (uint256 i = from; i < to; ++batch) {
            uint256 n = to - i < 5 ? to - i : 5;
            if (!balancer.canPurchase(buyer)) {
                _refused(n);
            } else {
                uint256[] memory ids = _buy(n);
                if (ids.length == 5 && balancer.admissionStatus() == 4) ++busySeen;
                for (uint256 k; k < ids.length; ++k) {
                    if (k == 2 && batch % 2 == 0) {
                        _keeperPass(); // nobody else processes FWA's queue: keepers do it inside upkeep (D16)
                        _account(ids);
                        _keeperPass();
                    }
                    _deliver(ids[k], _word(i + k));
                }
                _keeperPass(); // nobody else processes FWA's queue: keepers do it inside upkeep (D16)
                _account(ids);
            }
            _service();
            for (uint256 k = i; k < i + n; ++k) {
                if ((k + 1) % PER_DAY == 0) _endOfDay();
            }
            i += n;
        }
    }

    function _runInFlight(uint256 from, uint256 to) internal {
        for (uint256 i = from; i < to;) {
            uint256 n = to - i < 5 ? to - i : 5;
            if (!balancer.canPurchase(buyer)) {
                _refused(n);
            } else {
                uint256[] memory ids = _buy(n);
                for (uint256 k; k < ids.length; ++k) {
                    _deliver(ids[k], _word(i + k));
                    _keeperPass(); // nobody else processes FWA's queue: keepers do it inside upkeep (D16)
                    _account(ids);
                    _keeperPass(); // the remaining draws of the batch are still unsettled
                }
            }
            _service();
            for (uint256 k = i; k < i + n; ++k) {
                if ((k + 1) % PER_DAY == 0) _endOfDay();
            }
            i += n;
        }
    }

    /// @dev Independently reconstruct actual FWA owner proceeds and the request-board fee component.
    ///      Neither amount assigns creator credit: only actual collection at the stored rate does that.
    function _boardQuote() internal view returns (uint256 base, uint256 surcharge) {
        BoardAmounts memory b;
        for (uint256 lid = 1;; ++lid) {
            (,,,, uint256 weight, uint256 price,, uint8 status) = pool.listings(lid);
            if (status == 0) break;
            if (status != 1) continue;
            b.weight += weight;
            b.price += weight * price;
            (uint8 kind,,,, uint112 itemPrice) = balancer.items(lid);
            if (kind == SHAPE_KIND) assertEq(itemPrice, price, "the Balancer's price is FWA's");
            b.withoutSurcharge += weight * (kind == SHAPE_KIND ? price - lidFee[lid] : price);
        }
        base = b.price / b.weight;
        surcharge = base - b.withoutSurcharge / b.weight;
    }

    function _idle(uint256 days_) internal {
        for (uint256 d; d < days_; ++d) {
            _service();
            _endOfDay();
        }
    }

    function _word(uint256 i) internal returns (uint256) {
        if (i == forceTopA || i == forceTopB) {
            uint256[] memory ids = balancer.getActiveIds();
            for (uint256 k; k < ids.length; ++k) {
                (uint8 kind, uint8 d,,,) = balancer.items(ids[k]);
                (,,,,,, uint256 slot, uint8 status) = pool.listings(ids[k]);
                if (kind == SHAPE_KIND && d == TOP && status == 1) return wordForSlot(slot);
            }
            ++topNotListedWhenForced;
        }
        return uint256(keccak256(abi.encode(SEED, i)));
    }

    function _gasPhase(uint256 i) internal {
        if (!spikeRegime) return;
        uint256 p = i * 4 / DRAWS;
        uint256 want = p == 1 ? CAP_FEE : p == 2 ? SPIKE_FEE : BASEFEE;
        if (p != phase || phaseQuote[p] == 0) {
            phase = p;
            (gasNow, feeNow) = (want + TIP, want);
            vm.txGasPrice(gasNow);
            vm.fee(feeNow);
            probe.record();
            assertEq(probe.gasPrice(), gasNow, "tx.gasprice inside a state-changing call");
            assertEq(probe.baseFee(), feeNow, "block.basefee inside a state-changing call");
            if (gasNow > maxGasSeen) maxGasSeen = gasNow;
            if (feeNow > maxFeeSeen) maxFeeSeen = feeNow;
            _keeperPass(); // keepers act on the new gas price before the next player arrives
            (,, phaseQuote[p]) = pool.quoteAcquisitionPrice(1);
        }
    }

    function _refused(uint256 n) internal {
        refused += n;
        refusedBy[balancer.admissionStatus()] += n;
        phaseRefused[phase] += n;
    }

    function extBuy(uint256 n) external returns (uint256[] memory ids, uint256 total, uint256 vrf) {
        require(msg.sender == address(this));
        (,, total) = pool.quoteAcquisitionPrice(n);
        uint256 version = pool.inventoryVersion();
        uint256 before = buyer.balance;
        uint256 poolBefore = address(pool).balance;
        vm.prank(buyer, buyer);
        ids = pool.acquireBatch{value: total}(buyer, n, 0, 0, 10_000, version, vm.getBlockTimestamp() + 1);
        assertEq(before - buyer.balance, total, "the player paid the quote");
        // acquireBatch can activate staging before opening its requests. Snapshot that actual board;
        // its gross owner base is checked against FWA's actual per-request accrual on fulfillment.
        (uint256 qBase, uint256 qFee) = _boardQuote();
        for (uint256 k; k < ids.length; ++k) {
            drawBase[ids[k]] = qBase;
            drawFee[ids[k]] = qFee;
            allIds.push(ids[k]);
        }
        vrf = total - (address(pool).balance - poolBefore); // what FWA passed on to its randomness service
    }

    function _buy(uint256 n) internal returns (uint256[] memory ids) {
        try this.extBuy(n) returns (uint256[] memory ids_, uint256 total, uint256 vrf) {
            ids = ids_;
            playersPaid += total;
            vrfPaid += vrf;
            requested += n;
            phaseSold[phase] += n;
            uint256 u = pool.unsettledAcquisitionCount();
            if (u > maxUnsettled) maxUnsettled = u;
        } catch (bytes memory err) {
            if (buyReverts++ == 0) firstBuyRevert = uint32(bytes4(err));
        }
    }

    /// @dev One word through the real FWA randomness service, as its coordinator, three blocks later.
    function _deliver(uint256 id, uint256 word) internal {
        vm.roll(vm.getBlockNumber() + 3);
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        address coordinator = IVRFService(VRF_SERVICE).coordinator();
        vm.recordLogs();
        vm.prank(coordinator);
        try IVRFService(VRF_SERVICE).rawFulfillRandomWords{gas: 5_000_000}(id, words) {
            ++delivered;
            _recordOwnerAccruals(vm.getRecordedLogs());
        } catch {
            ++deliverReverts;
        }
    }


    /// @dev Books each newly final draw, from the harness's own listing records and FWA's state (the Balancer forgets
    ///      an item once reconciled).
    function _account(uint256[] memory ids) internal {
        for (uint256 i; i < ids.length; ++i) {
            if (done[ids[i]]) continue;
            (address purchaser,,, uint256 lid, uint8 status,) = pool.acquisitions(ids[i]);
            if (status == 2) {
                assertEq(actualDrawProceeds[ids[i]], drawBase[ids[i]], "actual per-request FWA proceeds match the purchase board");
                assertGt(actualDrawProceeds[ids[i]], 0, "a fulfilled draw generated real owner proceeds");
                done[ids[i]] = true;
                ++fulfilled;
                uncollectedBase += drawBase[ids[i]];
                ownerProceedsRealized += drawBase[ids[i]];
                feesReceived += drawFee[ids[i]];
                (uint8 kind, uint8 d) = (lidKind[lid], lidDenom[lid]);
                if (kind == SHAPE_KIND) {
                    (address col,,, uint256 tokenId,,,,) = pool.listings(lid);
                    assertEq(IERC721Min(col).ownerOf(tokenId), purchaser, "the winner holds the prize");
                    backingWon += _backingOf(col, tokenId);
                    selectedFeesWon += lidFee[lid];
                    if (d == TOP) ++topWon;
                } else if (kind == CURATED_KIND) {
                    ++nftsWon;
                    ++nftsToRelist;
                } else {
                    ++unknownWins;
                }
            } else if (status == 3 || status == 4 || status == 6) {
                done[ids[i]] = true;
                ++expired;
            }
        }
    }

    /// @dev Keepers work, the creator relists a won NFT, and the fund is measured against the reserve.
    function _service() internal {
        _keeperPass();
        while (nftsToRelist != 0) {
            --nftsToRelist;
            _listNft();
            _keeperPass();
        }
        uint256 fund = address(balancer).balance - balancer.creatorCredit();
        uint256 need = balancer.requiredReserve();
        if (need > fund) {
            ++passesWithReserveShort;
            if (need - fund > maxReserveShortfall) maxReserveShortfall = need - fund;
            // with every draw reconciled the reserve holds no per-draw allowance: this is the real gap
            if (pool.lastIssuedSequence() == balancer.reconciledSequence() && need - fund > maxShortfallReconciled) {
                maxShortfallReconciled = need - fund;
            }
        }
    }

    function _act() internal {
        if (actTopUp) {
            uint256 fund = address(balancer).balance - balancer.creatorCredit();
            uint256 need = balancer.requiredReserve();
            if (need > fund) {
                toppedUp = need - fund;
                vm.prank(creator);
                balancer.depositETH{value: toppedUp}();
                deposited += toppedUp;
            }
        } else {
            uint256[16] memory c;
            (c[0], c[9], c[1], c[2]) = (24, 8, 12, 2); // the launch design without the 0.5 ETH Shape
            vm.startPrank(creator);
            balancer.configure(uint16(MARKUP_BPS), plan16(c), shapes.mintFee());
            vm.stopPrank();
        }
        _keeperPass();
    }

    function _endOfDay() internal {
        if (balancer.enabled() && _missingUnits() != 0) ++daysPrizeMissing;
        if (balancer.enabled() && ((balancer.target() >> (16 * TOP)) & 0xFFFF) > balancer.getActiveShapes()[TOP]) {
            ++daysTopMissing;
        }
        _claim();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.roll(vm.getBlockNumber() + 7200);
        ++daysRun;
    }

    /// @dev A third party (a player, the FWA app or an operator) processes expired draws on FWA, paying its own gas.
    function _processOnFwa() internal {
        vm.prank(address(0xBEEF), address(0xBEEF));
        pool.processAcquisitions(5);
    }

    /// @dev True when keepers ran until nothing was left; false when the next call would not have paid for its gas.
    function _keeperPass() internal returns (bool) {
        for (uint256 i; i < 40; ++i) {
            uint8 r = _upkeep(keeper, true);
            if (r == SKIPPED) return false;
            if (r == NOTHING) {
                if (balancer.enabled()) {
                    if (_missingUnits() != 0) ++incompleteAfterFullPass;
                    if (balancer.admissionStatus() == 6) ++lowInventoryAfterFullPass;
                }
                return true;
            }
        }
        revert("upkeep never settled");
    }

    function _upkeep(address who, bool rational) internal returns (uint8) {
        // The production keeper performs its own collection; the driver adds no service call here.
        uint256 ready = this.fwaQueueReady(); // own frame: its memory does not grow this one's
        if (ready > fwaQueueReadyMax) fwaQueueReadyMax = ready;
        uint256 snap = vm.snapshotState();
        uint256 bal0 = address(balancer).balance;
        uint256 op0 = pool.ownerProceeds();
        uint256 p0 = balancer.creatorCredit();
        uint64 seq0 = balancer.reconciledSequence();
        bool setupWork = balancer.creatorWork();
        uint256 who0 = who.balance;
        // a keeper transaction starts with every account and slot cold
        bytes32 uh2 = balancer.settingsHash();
        uint64 next0 = pool.nextSequenceToProcess();
        _coolKeeperTx();
        vm.prank(who, who);
        vm.recordLogs();
        try balancer.performUpkeep(uh2, 0, 0) returns (uint256 reward) {
            uint256 cost = ReceiptGas.lastBilled() * gasNow;
            // proceeds this call collected, from the Balancer's own event (read after the gas is measured): upkeep may
            // settle draws first (D16), so more than was waiting before the call can arrive
            Vm.Log[] memory logs = vm.getRecordedLogs();
            op0 = _collectedIn(logs);
            if (rational && reward < cost) {
                vm.revertToStateAndDelete(snap);
                ++upkeepsSkipped;
                ++phaseSkipped[phase];
                return SKIPPED;
            }
            vm.deleteStateSnapshot(snap);
            _recordOwnerAccruals(logs);
            assertEq(who.balance - who0, reward, "the caller received the reward");
            ++upkeepsRun;
            if (ready != 0) ++upkeepsWithQueueReady;
            if (ready > 2) ++upkeepsWithQueueReadyOver2; // the Balancer processes at most 2 stuck draws per call
            if (who == keeper) {
                if (setupWork) keeperPaidSetup += reward;
                else keeperPaidPlay += reward;
                keeperGasCost += cost;

            } else {
                claimed += reward;
            }
            proceedsCollected += op0;
            uint256 p1 = balancer.creatorCredit();
            if (p1 > p0) creatorCreditAccrued += p1 - p0;
            if (creditCheck && op0 != 0) _checkCredit(op0, p1 > p0 ? p1 - p0 : 0); // upkeep settled draws itself (D16)
            uint256 rec = balancer.reconciledSequence() - seq0;
            if (rec > maxReconciled) maxReconciled = rec;
            uint256 minted0 = backingMinted;
            uint256 units = _scanListings();
            if (units > maxUnits) maxUnits = units;
            if (who == keeper) {
                uint256 price = gasNow < 5 gwei ? gasNow : 5 gwei;
                uint256 service = (pool.nextSequenceToProcess() - next0 + rec + units) * 0.00002 ether;
                uint256 overhead = V1_OVERHEAD;
                if (alternativePolicy) service /= 2; // the switched local economics' 0.00001 ETH work fee
                uint256 most = (cost / gasNow + overhead) * price + service;
                if (reward > most) {
                    paidBeyondGasAndReward += reward - most;
                    paidBeyondGas += (reward - most) / price;
                    if ((reward - most) / price > paidBeyondGasWorstCall) paidBeyondGasWorstCall = (reward - most) / price;
                }
            }
            // what left the Balancer other than the reward went to Shapes and Draw Packs
            mintFees += bal0 + op0 - reward - address(balancer).balance - (backingMinted - minted0);
            if (pool.unsettledAcquisitionCount() != 0) {
                ++upkeepsWhileUnsettled;
                if (units != 0) {
                    ++restocksStaged;
                    if (pool.unsettledAcquisitionCount() > maxInFlightAtRestock) {
                        maxInFlightAtRestock = pool.unsettledAcquisitionCount();
                    }
                }
            }
            return RAN;
        } catch (bytes memory err) {
            vm.deleteStateSnapshot(snap);
            if (bytes4(err) == PoolBalancer.NoUpkeepNeeded.selector) ++upkeepsNothing;
            else ++upkeepReverts;
            return NOTHING;
        }
    }

    /// @dev A keeper transaction starts with every account and slot cold, including the code a clone or proxy runs:
    ///      the harness's own reads (bookkeeping, the FWA queue count) would otherwise leave it warm.
    function _coolKeeperTx() internal {
        address[7] memory xs = [address(balancer), address(pool), SHAPES, packs, address(factory),
            address(KeeperPolicyCalls), address(PoolInventory)];
        for (uint256 i; i < xs.length; ++i) {
            address impl = _implementation(xs[i]);
            vm.cool(xs[i]);
            if (impl != address(0)) vm.cool(impl);
        }
    }

    /// @dev Solady minimal clone target (44 bytes, `3d3d3d3d363d3d37363d73` + address; the Balancer and FWA's pool),
    ///      else the EIP-1967 implementation slot (zero when neither).
    function _implementation(address a) internal view returns (address impl) {
        bytes memory c = a.code;
        if (c.length == 44 && uint8(c[0]) == 0x3d && uint8(c[10]) == 0x73) {
            assembly ("memory-safe") {
                impl := shr(96, mload(add(c, 43)))
            }
        } else {
            impl = address(uint160(uint256(vm.load(a, 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc))));
        }
    }

    /// @dev Draws FWA's processAcquisitions would settle or expire now: the prefix of its queue that is Ready, TimedOut,
    ///      or Pending past its word deadline (StandardPool.processAcquisitions). Reads FWA's storage only, so it warms
    ///      nothing the measured upkeep would find cold (the pool is cooled before the call).
    function fwaQueueReady() external view returns (uint256 n) {
        IPoolMore m = IPoolMore(address(pool));
        for (uint64 s = pool.nextSequenceToProcess(); s <= pool.lastIssuedSequence(); ++s) {
            uint256 id = m.requestIdAtSequence(s);
            (,,,, uint8 st,) = pool.acquisitions(id);
            if (st == 1) {
                (, uint64 deadline,,,,) = m.acquisitionMeta(id);
                if (vm.getBlockNumber() <= deadline) break;
            } else if (st != 5 && st != 6) {
                break;
            }
            ++n;
        }
    }

    /// @dev Books every FWA listing made since the last scan; returns the Shape units among them.
    function _scanListings() internal returns (uint256 units) {
        while (true) {
            (address col,,, uint256 tokenId,,,, uint8 status) = pool.listings(nextLid);
            if (status == 0) break;
            (uint8 kind, uint8 d,, uint112 base, uint112 price) = balancer.items(nextLid);
            (lidKind[nextLid], lidDenom[nextLid]) = (kind, d);
            if (kind == SHAPE_KIND) lidFee[nextLid] = price - base;
            if (kind == SHAPE_KIND) {
                backingMinted += _backingOf(col, tokenId);
                units += _shapesIn(d);
                feesListed += price - base;
            }
            ++nextLid;
        }
        unitsListed += units;
    }

    /// @dev A real BAYC token from its current holder (an ordinary account) to the creator, then listed.
    function _listNft() internal {
        uint256 id;
        address holder;
        do {
            id = nextNft++;
            holder = IERC721Min(BAYC).ownerOf(id);
        } while (holder.code.length != 0);
        vm.prank(holder);
        IERC721Min(BAYC).transferFrom(holder, creator, id);
        _collectNow();
        vm.startPrank(creator);
        IERC721Min(BAYC).approve(address(balancer), id);
        balancer.listCurated(BAYC, id, NFT_VALUE);
        vm.stopPrank();
        _scanListings();
        ++nftsListed;
    }

    /// @dev Add one curated NFT to an open shapes-only pool through listCuratedBatch (shapes_only_to_mixed).
    function _listNftBatch() internal {
        uint256 id;
        address holder;
        do {
            id = nextNft++;
            holder = IERC721Min(BAYC).ownerOf(id);
        } while (holder.code.length != 0);
        vm.prank(holder);
        IERC721Min(BAYC).transferFrom(holder, creator, id);
        _collectNow();
        PoolBalancer.CuratedInput[] memory batch = new PoolBalancer.CuratedInput[](1);
        batch[0] = PoolBalancer.CuratedInput(BAYC, id, NFT_VALUE);
        vm.startPrank(creator);
        IERC721Min(BAYC).approve(address(balancer), id);
        balancer.listCuratedBatch(batch);
        vm.stopPrank();
        _scanListings();
        ++nftsListed;
    }

    /// @dev Close, reconcile anything outstanding, unlist every Shape, return the NFTs, claim and retire. After a quiet
    ///      run no draw is unsettled, so unlisting and withdrawal are never blocked (FWA rule).
    function _closeout() internal {
        _collectNow();
        vm.prank(creator);
        balancer.close();
        _keeperPass();
        while (_upkeep(creator, false) == RAN) {}
        uint256[] memory prizes = _ids(SHAPE_KIND);
        for (uint256 from; from < prizes.length; from += 20) assertTrue(_unlist(_chunk(prizes, from)), "unlist");
        _withdrawNfts();
        _claim();
        vm.prank(creator);
        balancer.retire();
    }

    /// @dev Collects FWA proceeds on their own, so the amount and the profit credited are measured apart from the
    ///      creator action that follows (each of those collects first anyway).
    function _collectNow() internal {
        uint256 op = pool.ownerProceeds();
        if (op == 0) return;
        uint256 p0 = balancer.creatorCredit();
        uint256 b0 = address(balancer).balance;
        balancer.collectProceeds();
        assertEq(address(balancer).balance - b0, op, "proceeds arrived in full");
        proceedsCollected += op;
        uint256 p1 = balancer.creatorCredit();
        if (p1 > p0) creatorCreditAccrued += p1 - p0;
        if (creditCheck) _checkCredit(op, p1 > p0 ? p1 - p0 : 0);
    }

    /// @dev This is a cash allocation assertion, independent of the board and historical listing prices.
    function _checkCredit(uint256 op, uint256 booked) internal {
        _account(allIds);
        proceedsMismatch += op > uncollectedBase ? op - uncollectedBase : uncollectedBase - op;
        assertEq(op, uncollectedBase, "exactly the actual collected FWA proceeds");
        uint256 expected = op * balancer.creatorRevenueBps() / 10_000;
        ++creditChecks;
        if (booked == 0) ++creditZeroBooked;
        creditExpected += expected;
        creditBooked += booked;
        if (booked > expected) creditOver += booked - expected;
        else creditUnder += expected - booked;
        assertEq(booked, expected, "stored percentage applied once, floor residual stays in operating cash");
        uncollectedBase = 0;
    }

    function _recordOwnerAccruals(Vm.Log[] memory logs) internal {
        bytes32 topic = keccak256("OwnerProceedsAccrued(uint256,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(pool) || logs[i].topics[0] != topic) continue;
            uint256 id = uint256(logs[i].topics[1]);
            (uint256 amount,) = abi.decode(logs[i].data, (uint256, uint256));
            assertEq(actualDrawProceeds[id], 0, "a request contributes owner proceeds once");
            assertEq(amount, drawBase[id], "FWA's actual per-request accrual proves the captured purchase board");
            actualDrawProceeds[id] = amount;
        }
    }

    function _claim() internal returns (uint256 s) {
        _collectNow();
        s = balancer.withdrawableSurplus();
        if (s == 0) return 0;
        uint256 before = creator.balance;
        vm.prank(creator);
        balancer.claimSurplus(s, creator);
        assertEq(creator.balance - before, s, "the creator received the claim");
        claimed += s;
    }

    function _ids(uint8 wanted) internal view returns (uint256[] memory out) {
        uint256[] memory ids = balancer.getActiveIds();
        out = new uint256[](ids.length);
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = balancer.items(ids[i]);
            if (kind == wanted) out[n++] = ids[i];
        }
        assembly ("memory-safe") {
            mstore(out, n)
        }
    }

    function _chunk(uint256[] memory ids, uint256 from) internal pure returns (uint256[] memory out) {
        uint256 n = ids.length - from < 20 ? ids.length - from : 20;
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) out[i] = ids[from + i];
    }

    /// @dev False when FWA or the Balancer refuses. Redeemed ETH is the Balancer's balance change.
    function _unlist(uint256[] memory ids) internal returns (bool) {
        uint256 expected;
        uint256 fees;
        for (uint256 i; i < ids.length; ++i) {
            (address col,,, uint256 tokenId,,,,) = pool.listings(ids[i]);
            expected += _backingOf(col, tokenId);
            (,,, uint112 base, uint112 price) = balancer.items(ids[i]);
            fees += price - base;
        }
        _collectNow();
        uint256 b0 = address(balancer).balance;
        vm.prank(creator);
        try balancer.unlistShapes(ids) {
            uint256 got = address(balancer).balance - b0;
            backingRedeemed += got;
            redeemGap += got > expected ? got - expected : expected - got;
            feesUnlisted += fees;
            prizesUnlisted += ids.length;
            return true;
        } catch {
            return false;
        }
    }

    function _withdrawNfts() internal returns (uint256 n) {
        uint256[] memory ids = _ids(CURATED_KIND);
        for (uint256 i; i < ids.length; ++i) {
            (,,, uint256 tokenId,,,,) = pool.listings(ids[i]);
            vm.prank(creator);
            try balancer.withdrawCurated(ids[i], creator) {
                assertEq(IERC721Min(BAYC).ownerOf(tokenId), creator, "the creator holds the NFT again");
                ++n;
            } catch {}
        }
    }

    function _vrfOutstanding() internal view returns (uint256 n) {
        (bool ok, bytes memory r) = address(pool).staticcall(abi.encodeWithSignature("unfulfilledVrfCount()"));
        require(ok, "unfulfilledVrfCount");
        n = abi.decode(r, (uint256));
    }

    function _backingOf(address col, uint256 tokenId) internal view returns (uint256) {
        return col == SHAPES ? shapes.backingOf(tokenId) : IPackValue(col).valueOf(tokenId);
    }

    function _shapesIn(uint256 d) internal pure returns (uint256) {
        return (0x3323232111111111 >> (4 * d)) & 0xF; // PoolBalancer.SHAPES_IN
    }

    function _missingUnits() internal view returns (uint256 units) {
        uint256 t = balancer.target();
        uint16[16] memory have = balancer.getActiveShapes();
        for (uint256 d; d < 16; ++d) {
            uint256 want = (t >> (16 * d)) & 0xFFFF;
            if (want > have[d]) units += (want - have[d]) * _shapesIn(d);
        }
    }

    /// @dev Backing of every Shape and pack FWA still holds, found from FWA's own listings rather than the Balancer's
    ///      list, so a prize the Balancer lost track of would still be counted.
    function _backingListed() internal view returns (uint256 held) {
        if (address(balancer) == address(0)) return 0;
        uint256 last = lastListingId();
        for (uint256 lid = 1; lid <= last; ++lid) {
            (address col,,, uint256 tokenId,,,,) = pool.listings(lid);
            if (col != SHAPES && col != packs) continue;
            try IERC721Min(col).ownerOf(tokenId) returns (address holder) {
                if (holder == address(pool)) held += _backingOf(col, tokenId);
            } catch {} // redeemed and burned
        }
    }

    // ------------------------------------------------------------------ kit data

    function flowDir() internal pure override returns (string memory) {
        return "docs/receipts/flow";
    }

    function flowInflows() internal view override returns (Item[] memory i) {
        i = new Item[](2);
        i[0] = Item("creator deposits", deposited);
        i[1] = Item("player payments for draws (price and randomness fee)", playersPaid);
    }

    function flowOutflows() internal view override returns (Item[] memory o) {
        o = new Item[](6);
        o[0] = Item("claimed by the creator", claimed);
        o[1] = Item("prize backing delivered to winners (Shapes and Packs)", backingWon);
        o[2] = Item("paid to keepers", keeper.balance - keeperStart);
        o[3] = Item("randomness fees paid to FWA's service", vrfPaid);
        o[4] = Item("Shapes mint fees", mintFees);
        o[5] = Item("refunds withdrawn by players", refundsWithdrawn);
    }

    /// @dev The Balancer's ETH is split in this order: unclaimed creator profit, the reserve (up to
    ///      `requiredReserve`), then whatever is above it. FWA's edge stays inside the FWA pool, so it shows in the
    ///      last bucket.
    function flowBuckets() internal view override returns (Bucket[] memory k) {
        k = new Bucket[](6);
        uint256 bal;
        uint256 profit;
        uint256 need;
        uint256 implied;
        uint256 proceeds;
        uint256 fwaOther;
        uint256 fwaNeed;
        if (address(balancer) != address(0)) {
            bal = address(balancer).balance;
            profit = balancer.creatorCredit();
            assertGe(bal, profit, "credit must remain backed");
            need = balancer.requiredReserve();
            uint16[16] memory have = balancer.getActiveShapes();
            for (uint256 d; d < 16; ++d) implied += uint256(have[d]) * balancer.denominationAmount(d);
            proceeds = pool.ownerProceeds();
            fwaOther = address(pool).balance - proceeds;
            IPoolMore m = IPoolMore(address(pool));
            fwaNeed = m.acquisitionEscrowTotal() + m.deliveryEscrowTotal()
                + m.acquisitionRefundCreditTotal() + m.accruedProtocolFees();
        }
        uint256 rest = bal - profit;
        uint256 reserve = rest < need ? rest : need;
        k[0] = Bucket("creator credit (unclaimed)", profit, false, 0, true, profit);
        k[1] = Bucket("creator reserve", reserve, false, 0, true, need);
        k[2] = Bucket("fund above the reserve", rest - reserve, false, 0, true, 0);
        uint256 backing = _backingListed();
        k[3] = Bucket("Shape and Pack backing listed on FWA", backing, true, implied, true, backing);
        k[4] = Bucket("held by FWA: owner proceeds not yet collected", proceeds, false, 0, true, proceeds);
        k[5] = Bucket("held by FWA: pending draws, player refund credit and FWA's edge", fwaOther, false, 0, true, fwaNeed);
    }

    function flowFlows() internal view override returns (Flow[] memory f) {
        f = new Flow[](7);
        f[0] = Flow("creator -> Balancer: deposits | claimed back", deposited, true, claimed);
        f[1] = Flow("players -> FWA: draw payments | refunds withdrawn", playersPaid, true, refundsWithdrawn);
        f[2] = Flow("FWA -> Balancer: owner proceeds collected", proceedsCollected, false, 0);
        f[3] = Flow("Balancer -> Shapes and Packs: prize backing | redeemed", backingMinted, true, backingRedeemed);
        f[4] = Flow("Balancer -> keepers: reconcile and restock | request-board surcharge received", keeperPaidPlay, true, feesReceived);
        f[5] = Flow("Balancer -> keepers: creator-started work (creator's ETH)", keeperPaidSetup, false, 0);
        f[6] = Flow("proceeds -> creator credit: stored collection percentage", creatorCreditAccrued, false, 0);
    }
}
