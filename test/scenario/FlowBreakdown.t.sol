// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, IVRFService} from "../utils/ForkBase.sol";
import {FlowBreakdown, GasProbe} from "../utils/FlowBreakdown.sol";
import {PoolBalancer} from "../../src/PoolBalancer.sol";
import {IERC721Min} from "../../src/interfaces/External.sol";

interface IPoolMore {
    function selectionTimeoutBlocks() external view returns (uint256);
    function accruedProtocolFees() external view returns (uint256);
    function deliveryEscrowTotal() external view returns (uint256);
    function acquisitionEscrowTotal() external view returns (uint256);
    function acquisitionRefundCreditTotal() external view returns (uint256);
    function acquisitionRefundCredit(address purchaser) external view returns (uint256);
    function withdrawAcquisitionRefund() external returns (uint256 amount);
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

    // cumulative money counters, each measured from a balance change or a real read at the moment it happens
    uint256 internal deposited;
    uint256 internal claimed;
    uint256 internal playersPaid;
    uint256 internal vrfPaid;
    uint256 internal refundsWithdrawn;
    uint256 internal proceedsCollected;
    uint256 internal profitCredited;
    uint256 internal backingMinted;
    uint256 internal backingRedeemed;
    uint256 internal backingWon;
    uint256 internal mintFees;
    uint256 internal keeperPaidSetup;
    uint256 internal keeperPaidPlay;
    uint256 internal keeperGasCost;
    uint256 internal paidBeyondGasAndReward;
    uint256 internal feesListed; // restocking fees inside the prices of every prize listed
    uint256 internal feesWon;
    uint256 internal feesUnlisted;
    uint256 internal markupWon; // full markup on the backing of Shape prizes won
    uint256 internal redeemGap;

    // run facts
    uint256 internal requested;
    uint256 internal delivered;
    uint256 internal deliverReverts;
    uint256 internal fulfilled;
    uint256 internal expired;
    uint256 internal refused;
    uint256[7] internal refusedBy;
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

    // split check (restock_in_flight): the creator's profit for each draw, computed independently from the FWA board
    // the draw was priced on, against what the Balancer books when it collects
    bool internal splitCheck;
    mapping(uint256 id => uint256) internal drawBase; // FWA owner proceeds for the draw: sum(w*p)/sum(w), active listings
    mapping(uint256 id => uint256) internal drawShare; // drawBase x sum(markup above 10% / price) over them / count
    uint256 internal uncollectedBase;
    uint256 internal uncollectedShare;
    uint256 internal splitChecks;
    uint256 internal splitSkippedAboveReserve;
    uint256 internal splitExpected;
    uint256 internal splitBooked;
    uint256 internal splitOver;
    uint256 internal splitUnder;
    uint256 internal splitMaxErrorBps;
    uint256 internal proceedsMismatch;
    uint256 internal maxInFlightAtRestock;

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
    // gas-level regimes and the player's price (O10)
    uint256 internal baseFeeRegime; // 0: BASEFEE
    bool internal trackPrice;
    uint256 internal maxPriceToBackingBps;
    uint256 internal minPriceToBackingBps = type(uint256).max;

    function setUp() public {
        setUpFork();
        keeperStart = keeper.balance;
    }

    // ------------------------------------------------------------------ regimes

    function test_breakdown_quiet() public {
        Snap memory a = _launch();
        for (uint256 i; i < DRAWS; ++i) _single(i);
        assertEq(vrfPaid, requested * VRF_GAS * gasNow, "each draw paid FWA's randomness fee at the stated gas price");
        _done("quiet", a, new Fact[](0));
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

    /// @dev As quiet, with the 0.5 ETH Shape forced on draws 60 and 61 (it must be restocked in between).
    function test_breakdown_largeWin() public {
        Snap memory a = _launch();
        (forceTopA, forceTopB) = (60, 61);
        for (uint256 i; i < DRAWS; ++i) _single(i);
        assertGe(topWon, 2, "two top prizes were won");
        _done("large_win", a, _largeWinFacts());
    }

    /// @dev E9 option "add ETH": large_win, and right after the second top prize is won the creator deposits what
    ///      the reserve is short by.
    function test_whatIf_largeWinTopUp() public {
        Snap memory a = _launch();
        (forceTopA, forceTopB, actAt, actTopUp) = (60, 61, 62, true);
        for (uint256 i; i < DRAWS; ++i) _single(i);
        assertGe(topWon, 2, "two top prizes were won");
        assertGt(toppedUp, 0, "the creator topped up");
        _done("whatif_large_win_top_up", a, _largeWinFacts());
    }

    /// @dev E9 option "continue without the 0.5 ETH prize": large_win, and right after the second top prize is won
    ///      the creator saves the same design without it.
    function test_whatIf_largeWinDropTop() public {
        Snap memory a = _launch();
        (forceTopA, forceTopB, actAt) = (60, 61, 62);
        for (uint256 i; i < DRAWS; ++i) _single(i);
        assertGe(topWon, 2, "two top prizes were won");
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
                    _process();
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
        x[7] = Fact("profit_claimed_wei", profitCredited - balancer.profit());
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
            for (uint256 k; k < 3 && pool.unsettledAcquisitionCount() != 0; ++k) _process();
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
        _process();
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
        Fact[] memory x = new Fact[](22);
        x[0] = Fact("draws_pending_at_close", 5);
        _collectNow();
        vm.prank(creator);
        balancer.close();
        uint256 heldAtClose = balancer.requiredReserve();
        // D3: while closed, keeper pay for the unreconciled draws is held; nothing else may be withheld
        x[1] = Fact(
            "unclaimable_after_close_beyond_held_pay_wei",
            address(balancer).balance - balancer.withdrawableSurplus() - balancer.requiredReserve()
        );
        // what the creator can take while the draws are still pending
        uint256[] memory first = _chunk(_ids(SHAPE_KIND), 0);
        x[2] = Fact("unlist_blocked_while_pending", _unlist(first) ? 0 : 1);
        x[3] = Fact("nft_withdraw_blocked_while_pending", _withdrawNfts() == 0 ? 1 : 0);
        x[4] = Fact("claimed_at_close_wei", _claim());
        uint256 startBlock = vm.getBlockNumber();
        _deliver(ids[0], _word(90));
        _deliver(ids[1], _word(91));
        _process();
        _account(ids);
        vm.roll(vm.getBlockNumber() + IPoolMore(address(pool)).selectionTimeoutBlocks() + 1);
        for (uint256 k; k < 3 && pool.unsettledAcquisitionCount() != 0; ++k) _process();
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
    ///      lists while one to four draws are still unsettled and FWA stages it. Every collection is checked against
    ///      the split computed from the board each draw was priced on (see `_boardQuote`).
    function test_breakdown_restockInFlight() public {
        Snap memory a = _launch();
        splitCheck = true;
        _runInFlight(0, DRAWS);
        // reached: restocks were made and staged while draws were unsettled, and collections were checked
        assertGt(upkeepsWhileUnsettled, 0, "upkeep ran while draws were unsettled");
        assertGt(restocksStaged, 0, "restocks listed while draws were unsettled");
        assertGe(maxInFlightAtRestock, 3, "a restock listed with at least three draws unsettled");
        assertGt(splitChecks, 0, "collections booked profit and were checked");
        Fact[] memory x = new Fact[](10);
        x[0] = Fact("split_collections_checked", splitChecks);
        x[1] = Fact("split_collections_fund_at_or_above_reserve", splitSkippedAboveReserve);
        x[2] = Fact("split_expected_wei", splitExpected);
        x[3] = Fact("split_booked_wei", splitBooked);
        x[4] = Fact("split_overbooked_wei", splitOver);
        x[5] = Fact("split_underbooked_wei", splitUnder);
        x[6] = Fact("split_max_error_bps", splitMaxErrorBps);
        x[7] = Fact("owner_proceeds_vs_board_price_mismatch_wei", proceedsMismatch);
        x[8] = Fact("max_draws_unsettled_at_a_staged_restock", maxInFlightAtRestock);
        x[9] = Fact("restocks_staged_while_unsettled_checked", restocksStaged);
        _done("restock_in_flight", a, x);
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
        vm.prank(creator);
        balancer.configure(uint16(MARKUP_BPS), plan16(c));
        _listNft();
        vm.prank(creator);
        balancer.open();
        assertTrue(_keeperPass(), "keepers finished the setup");
        assertEq(balancer.admissionStatus(), 0, "purchases admitted after setup");
        assertEq(unitsListed, boardUnits, "the whole board is listed");
        claimedAtSetup = _claim();
    }

    function _done(string memory regime, Snap memory a, Fact[] memory extra) internal {
        // absolute amounts, computed here rather than read back from the Balancer
        assertEq(mintFees, unitsListed * 0.001 ether, "Shapes mint fee: 0.001 ETH per Shape minted");
        assertEq(backingMinted, backingRedeemed + backingWon + _backingListed(), "every minted wei of backing is listed, won or redeemed");
        uint256 n = 57;
        Fact[] memory f = new Fact[](n + extra.length);
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
        f[34] = Fact("restock_fees_won_wei", feesWon);
        f[35] = Fact("restock_fees_outstanding_wei", feesListed - feesWon - feesUnlisted);
        f[36] = Fact("profit_credited_wei", profitCredited);
        f[37] = Fact("profit_share_of_proceeds_bps", proceedsCollected == 0 ? 0 : profitCredited * 10_000 / proceedsCollected);
        f[38] = Fact("creator_markup_ceiling_on_prizes_won_wei", markupWon * (MARKUP_BPS - 1000) / MARKUP_BPS);
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
        // R4: the creator's keeper net, restocking fees repaid inside won prizes less all keeper pay
        uint256 keeperAll = keeperPaidPlay + keeperPaidSetup;
        f[52] = Fact("creator_keeper_net_gain_wei", feesWon > keeperAll ? feesWon - keeperAll : 0);
        f[53] = Fact("creator_keeper_net_loss_wei", keeperAll > feesWon ? keeperAll - feesWon : 0);
        // the same for play only, leaving out the creator's own setup work (opening, configuring, unlisting)
        f[56] = Fact("creator_keeper_play_net_loss_wei", keeperPaidPlay > feesWon ? keeperPaidPlay - feesWon : 0);
        // R8: the creator's net, everything claimed or still theirs (Balancer ETH, listed backing, uncollected
        // proceeds) less everything deposited and the NFTs given away at their stated value (the harness hands the
        // creator a fresh NFT after each win, so that value is a cost here)
        uint256 held = claimed + address(balancer).balance + _backingListed() + pool.ownerProceeds();
        uint256 cost = deposited + nftsWon * NFT_VALUE;
        f[54] = Fact("creator_net_gain_wei", held > cost ? held - cost : 0);
        f[55] = Fact("creator_net_loss_wei", cost > held ? cost - held : 0);
        for (uint256 j; j < extra.length; ++j) f[n + j] = extra[j];
        flowReport(regime, a, f);
    }

    /// @dev What it would take if someone ran the upkeep the paid keeper declined (the creator may always run it; the
    ///      shipped keeper accepts a loss of MAX_LOSS_WEI, 0.0002 ETH by default, per call). State is restored.
    function _whatIfUnpaidUpkeep() internal returns (uint256 calls, uint256 maxCost, uint256 statusAfter) {
        if (!balancer.enabled()) return (0, 0, balancer.admissionStatus());
        uint256 snap = vm.snapshotState();
        for (; calls < 40; ++calls) {
            vm.cool(address(balancer));
            vm.cool(address(pool));
            vm.cool(SHAPES);
            vm.cool(packs);
            uint256 g = gasleft();
            vm.prank(creator, creator);
            try balancer.performUpkeep() returns (uint256 reward) {
                uint256 cost = (g - gasleft() + 21_000) * gasNow;
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
        if (!balancer.canPurchase(buyer)) {
            _refused(1);
        } else {
            uint256[] memory ids = _buy(1);
            if (ids.length == 1) {
                _deliver(ids[0], _word(i));
                _process();
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
                        _process();
                        _account(ids);
                        _keeperPass();
                    }
                    _deliver(ids[k], _word(i + k));
                }
                _process();
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
                    _process();
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

    /// @dev Independent of the Balancer's counters: FWA's owner proceeds per draw are sum(weight x price) / sum(weight)
    ///      over its active listings (StandardPool, `weightedBackingTotal / totalWeight`), and the creator's part is
    ///      that times the average, over the same listings, of each Shape prize's markup above 10% as a fraction of its
    ///      price (zero for an NFT). This regime never changes the markup, so every Shape prize carries MARKUP_BPS.
    function _boardQuote() internal view returns (uint256 base, uint256 share) {
        uint256 w;
        uint256 wp;
        uint256 n;
        uint256 s;
        for (uint256 lid = 1;; ++lid) {
            (,,,, uint256 weight, uint256 price,, uint8 status) = pool.listings(lid);
            if (status == 0) break;
            if (status != 1) continue;
            w += weight;
            wp += weight * price;
            ++n;
            (uint8 kind, uint8 d,,, uint112 itemPrice) = balancer.items(lid);
            if (kind == SHAPE_KIND) {
                assertEq(itemPrice, price, "the Balancer's price is FWA's");
                s += balancer.denominationAmount(d) * (MARKUP_BPS - 1000) * 1e18 / (10_000 * price);
            }
        }
        base = wp / w;
        share = base * s / (n * 1e18);
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
        (uint256 qBase, uint256 qShare) = splitCheck ? _boardQuote() : (0, 0);
        uint256 before = buyer.balance;
        uint256 poolBefore = address(pool).balance;
        vm.prank(buyer, buyer);
        ids = pool.acquireBatch{value: total}(buyer, n, 0, 0, 10_000, version, vm.getBlockTimestamp() + 1);
        assertEq(before - buyer.balance, total, "the player paid the quote");
        for (uint256 k; k < ids.length; ++k) (drawBase[ids[k]], drawShare[ids[k]]) = (qBase, qShare);
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
        vm.prank(coordinator);
        try IVRFService(VRF_SERVICE).rawFulfillRandomWords{gas: 5_000_000}(id, words) {
            ++delivered;
        } catch {
            ++deliverReverts;
        }
    }

    function _process() internal {
        try pool.processAcquisitions(5) {} catch {}
    }

    /// @dev Books each newly final draw. Must run before upkeep reconciles it (the Balancer then forgets the item).
    function _account(uint256[] memory ids) internal {
        for (uint256 i; i < ids.length; ++i) {
            if (done[ids[i]]) continue;
            (,,, uint256 lid, uint8 status,) = pool.acquisitions(ids[i]);
            if (status == 2) {
                done[ids[i]] = true;
                ++fulfilled;
                uncollectedBase += drawBase[ids[i]];
                uncollectedShare += drawShare[ids[i]];
                (uint8 kind, uint8 d,, uint112 base, uint112 price) = balancer.items(lid);
                if (kind == SHAPE_KIND) {
                    (address col,,, uint256 tokenId,,,,) = pool.listings(lid);
                    assertEq(IERC721Min(col).ownerOf(tokenId), buyer, "the winner holds the prize");
                    backingWon += _backingOf(col, tokenId);
                    feesWon += price - base;
                    markupWon += balancer.denominationAmount(d) * MARKUP_BPS / 10_000;
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
        uint256 fund = address(balancer).balance - balancer.profit();
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
            uint256 fund = address(balancer).balance - balancer.profit();
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
            vm.prank(creator);
            balancer.configure(uint16(MARKUP_BPS), plan16(c));
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
        // measured on its own; performUpkeep collects first anyway, at the same state
        if (splitCheck) _collectNow();
        uint256 snap = vm.snapshotState();
        uint256 bal0 = address(balancer).balance;
        uint256 op0 = pool.ownerProceeds();
        uint256 p0 = balancer.profit();
        uint64 seq0 = balancer.reconciledSequence();
        bool setupWork = balancer.creatorWork();
        uint256 who0 = who.balance;
        // a keeper transaction starts with every account and slot cold
        vm.cool(address(balancer));
        vm.cool(address(pool));
        vm.cool(SHAPES);
        vm.cool(packs);
        uint256 g = gasleft();
        vm.prank(who, who);
        try balancer.performUpkeep() returns (uint256 reward) {
            uint256 cost = (g - gasleft() + 21_000) * gasNow;
            if (rational && reward < cost) {
                vm.revertToStateAndDelete(snap);
                ++upkeepsSkipped;
                ++phaseSkipped[phase];
                return SKIPPED;
            }
            vm.deleteStateSnapshot(snap);
            assertEq(who.balance - who0, reward, "the caller received the reward");
            ++upkeepsRun;
            if (who == keeper) {
                if (setupWork) keeperPaidSetup += reward;
                else keeperPaidPlay += reward;
                keeperGasCost += cost;
                // the rule: this transaction's gas (here measured from outside, plus intrinsic gas and the Balancer's
                // 50,000 overhead allowance) at min(bid, basefee + 0.05 gwei, 5 gwei), plus one flat 0.0001 ETH.
                // The Balancer measures gas before storage refunds, so calls that clear storage come out above it.
                uint256 price = gasNow < 5 gwei ? gasNow : 5 gwei;
                uint256 most = (cost / gasNow + 50_000) * price + 0.0001 ether;
                if (reward > most) paidBeyondGasAndReward += reward - most;
            } else {
                claimed += reward;
            }
            proceedsCollected += op0;
            uint256 p1 = balancer.profit();
            if (p1 > p0) profitCredited += p1 - p0;
            uint256 rec = balancer.reconciledSequence() - seq0;
            if (rec > maxReconciled) maxReconciled = rec;
            uint256 minted0 = backingMinted;
            uint256 units = _scanListings();
            if (units > maxUnits) maxUnits = units;
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

    /// @dev Books every FWA listing made since the last scan; returns the Shape units among them.
    function _scanListings() internal returns (uint256 units) {
        while (true) {
            (address col,,, uint256 tokenId,,,, uint8 status) = pool.listings(nextLid);
            if (status == 0) break;
            (uint8 kind, uint8 d,, uint112 base, uint112 price) = balancer.items(nextLid);
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

    /// @dev Collects FWA proceeds on their own, so the amount and the profit credited are measured apart from the
    ///      creator action that follows (each of those collects first anyway).
    function _collectNow() internal {
        uint256 op = pool.ownerProceeds();
        if (op == 0) return;
        uint256 p0 = balancer.profit();
        uint256 b0 = address(balancer).balance;
        balancer.collectProceeds();
        assertEq(address(balancer).balance - b0, op, "proceeds arrived in full");
        proceedsCollected += op;
        uint256 p1 = balancer.profit();
        if (p1 > p0) profitCredited += p1 - p0;
        if (splitCheck) {
            proceedsMismatch += op > uncollectedBase ? op - uncollectedBase : uncollectedBase - op;
            if (p1 > p0) {
                uint256 booked = p1 - p0;
                ++splitChecks;
                splitExpected += uncollectedShare;
                splitBooked += booked;
                uint256 err;
                if (booked > uncollectedShare) {
                    err = booked - uncollectedShare;
                    splitOver += err;
                } else {
                    err = uncollectedShare - booked;
                    splitUnder += err;
                }
                if (uncollectedShare != 0 && err * 10_000 / uncollectedShare > splitMaxErrorBps) {
                    splitMaxErrorBps = err * 10_000 / uncollectedShare;
                }
            } else {
                ++splitSkippedAboveReserve;
            }
            (uncollectedBase, uncollectedShare) = (0, 0);
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

    /// @dev Backing of the tracked prizes the FWA pool really holds, read from Shapes and Draw Packs.
    function _backingListed() internal view returns (uint256 held) {
        if (address(balancer) == address(0)) return 0;
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = balancer.items(ids[i]);
            if (kind != SHAPE_KIND) continue;
            (address col,,, uint256 tokenId,,,,) = pool.listings(ids[i]);
            if (IERC721Min(col).ownerOf(tokenId) == address(pool)) held += _backingOf(col, tokenId);
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
        if (address(balancer) != address(0)) {
            bal = address(balancer).balance;
            profit = balancer.profit();
            if (profit > bal) profit = bal;
            need = balancer.requiredReserve();
            uint16[16] memory have = balancer.getActiveShapes();
            for (uint256 d; d < 16; ++d) implied += uint256(have[d]) * balancer.denominationAmount(d);
            proceeds = pool.ownerProceeds();
            fwaOther = address(pool).balance - proceeds;
        }
        uint256 rest = bal - profit;
        uint256 reserve = rest < need ? rest : need;
        k[0] = Bucket("creator profit (unclaimed)", profit, false, 0, false, 0);
        k[1] = Bucket("creator reserve", reserve, false, 0, true, need);
        k[2] = Bucket("fund above the reserve", rest - reserve, false, 0, false, 0);
        k[3] = Bucket("Shape and Pack backing listed on FWA", _backingListed(), true, implied, false, 0);
        k[4] = Bucket("held by FWA: owner proceeds not yet collected", proceeds, false, 0, false, 0);
        k[5] = Bucket("held by FWA: pending draws, player refund credit and FWA's edge", fwaOther, false, 0, false, 0);
    }

    function flowFlows() internal view override returns (Flow[] memory f) {
        f = new Flow[](7);
        f[0] = Flow("creator -> Balancer: deposits | claimed back", deposited, true, claimed);
        f[1] = Flow("players -> FWA: draw payments | refunds withdrawn", playersPaid, true, refundsWithdrawn);
        f[2] = Flow("FWA -> Balancer: owner proceeds collected", proceedsCollected, false, 0);
        f[3] = Flow("Balancer -> Shapes and Packs: prize backing | redeemed", backingMinted, true, backingRedeemed);
        f[4] = Flow("Balancer -> keepers: reconcile and restock | restocking fees in prizes won", keeperPaidPlay, true, feesWon);
        f[5] = Flow("Balancer -> keepers: creator-started work (creator's ETH)", keeperPaidSetup, false, 0);
        f[6] = Flow("proceeds -> creator profit: markup above the game's 10%", profitCredited, false, 0);
    }
}
