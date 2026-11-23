// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {ReconfiguringNFT} from "./utils/Mocks.sol";
import {ListOne} from "./utils/ListOne.sol";

using ListOne for PoolBalancer;

/// @notice Reserve rules on a mainnet fork with the real FWA pool, VRF service and Shapes: a pool opens only with its
///         reserve in ETH (E2), purchases continue while sales refill it after big wins (DECISIONS 66), closing
///         returns unspent keeper credit (E5), and curated NFTs are priced after the collection's own calls (S4).
contract ReserveTest is ForkBase {

    uint256 curated;

    function setUp() public {
        setUpFork();
        createBalancer(5 ether);
        // 4 x 0.01, 2 x 0.1, 1 x 0.5: the 0.5 Shape is listed last.
        configure(plan([uint256(4), 0, 2, 1, 0, 0, 0, 0, 0]));
        curated = listCurated(1, 0.3 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertEq(balancer.admissionStatus(), 0);
    }

    function _claimAll() internal {
        uint256 s = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(s, creator);
    }

    uint8 constant SHAPE_KIND = 2;

    /// @dev A word that draws a listed Shape of size `denom`.
    function _wordFor(uint8 denom) internal view returns (uint256) {
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 d,,,) = balancer.items(ids[i]);
            if (kind == SHAPE_KIND && d == denom) {
                (,,,,,, uint256 slot,) = pool.listings(ids[i]);
                return wordForSlot(slot);
            }
        }
        revert("size not listed");
    }

    /// @dev The fund: this Balancer's ETH less the creator's unclaimed profit.
    function _fund() internal view returns (uint256) {
        return address(balancer).balance - balancer.creatorCredit();
    }

    /// @dev Sell single draws that each win a 0.01 Shape, the creator claiming everything claimable after each, until
    ///      the fund holds its working target again. Every admitted draw replenishes operating capital; creator
    ///      claims never reduce an underfunded fund. Individual collections need not book a nonzero profit.
    function _sellUntilRefilled() internal returns (uint256 n, uint256 claimed) {
        while (_fund() < balancer.requiredReserve()) {
            assertEq(balancer.admissionStatus(), 0, "still selling while the reserve refills");
            uint256[] memory r = buy(buyer, 1);
            fulfill(r[0], _wordFor(0));
            settle();
            fillUp();
            uint256 f = _fund();
            uint256 need = balancer.requiredReserve();
            uint256 w = balancer.withdrawableSurplus();
            vm.prank(creator);
            balancer.claimSurplus(w, creator);
            claimed += w;
            assertGe(_fund(), f < need ? f : need, "a claim never takes the fund");
            require(++n < 400, "reserve never refilled");
        }
    }

    function _drawListing(uint256 requestId, uint256 lid) internal {
        (,,,,,, uint256 slot,) = pool.listings(lid);
        fulfill(requestId, wordForSlot(slot));
        settle();
    }

    /// E2: a pool cannot open without its reserve in ETH, so a closed, drained pool cannot reopen empty.
    function test_openNeedsTheReserve() public {
        uint256 need = balancer.requiredReserve();
        vm.prank(creator);
        balancer.close();
        _claimAll();
        assertEq(address(balancer).balance, 0, "closed pool fully drained");
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.ReserveNotFunded.selector);
        balancer.open();

        vm.prank(creator);
        balancer.depositETH{value: need - 1}();
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.ReserveNotFunded.selector);
        balancer.open();

        vm.prank(creator);
        balancer.depositETH{value: 1}();
        vm.prank(creator);
        balancer.open();
        assertEq(balancer.admissionStatus(), 0);
        buy(buyer, 1);
    }

    /// An expensive win can remain missing while smaller-prize sales replenish its replacement cost.
    /// There is no duplicate-backing spare, and operating withdrawals stay restricted meanwhile.
    function test_bigWinKeepsSellingWhileReserveRefills() public {
        _claimAll();
        uint256 need = balancer.requiredReserve();
        uint256[] memory r = buy(buyer, 1);
        fulfill(r[0], _wordFor(3));
        settle();
        fillUp();
        assertEq(balancer.getActiveShapes()[3], 0, "expensive replacement is deferred without a duplicate backing reserve");
        assertGt(balancer.requiredReserve(), need, "actual missing inventory raises the working target");
        assertEq(balancer.withdrawableSurplus(), balancer.creatorCredit(), "only profit is claimable while the fund is short");
        assertEq(balancer.admissionStatus(), 0, "purchases continue");

        (uint256 n, uint256 claimed) = _sellUntilRefilled();
        emit log_named_uint("draws to refill after the 0.5 win", n);
        emit log_named_decimal_uint("creator claimed meanwhile", claimed, 18);
        assertGe(_fund(), balancer.requiredReserve());
    }

    function test_creatorRateRemainsStoredAcrossInventoryChanges() public view {
        assertEq(balancer.creatorRevenueBps(), 400);
    }

    /// Changing listed inventory cannot change the explicitly stored collection percentage.
    function test_listingNFTsBeforeCollectionCannotMoveFundMoney() public {
        _claimAll();
        uint256[] memory r = buy(buyer, 1);
        fulfill(r[0], _wordFor(3));
        settle();
        fillUp();
        // One more draw, settled but not collected (more would trip the fill check before upkeep).
        uint256[] memory d = buy(buyer, 1);
        fulfill(d[0], _wordFor(0));
        settle();
        uint256 amount = pool.ownerProceeds();
        assertGt(amount, 0, "proceeds waiting");
        uint256 p0 = balancer.creatorCredit();
        uint256 snap = vm.snapshotState();
        balancer.collectProceeds();
        uint256 honest = balancer.creatorCredit() - p0;
        vm.revertToState(snap);
        for (uint256 i; i < 5; ++i) listCurated(100 + i, 50 ether);
        balancer.collectProceeds();
        uint256 padded = balancer.creatorCredit() - p0;
        assertGt(honest, 0, "profit flows while the fund is short");
        assertEq(padded, honest, "new curated listings do not alter the collection percentage");
        assertLt(honest, amount / 2, "the fund keeps at least half of a payment");

        vm.revertToState(snap);
        vm.prank(creator);
        balancer.withdrawCurated(curated, creator);
        balancer.collectProceeds();
        assertEq(balancer.creatorCredit() - p0, honest, "curated withdrawal does not alter the collection percentage");

        // Unlisting returns backing; collection remains a separate action.
        vm.revertToState(snap);
        uint256[] memory one = new uint256[](1);
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 denom,,,) = balancer.items(ids[i]);
            if (kind == SHAPE_KIND && denom == 0) one[0] = ids[i]; // an actually active small prize
        }
        vm.prank(creator);
        balancer.unlistShapes(one);
        assertEq(balancer.creatorCredit(), p0, "unlisting does not collect or change the stored credit");
        balancer.collectProceeds();
        assertEq(balancer.creatorCredit() - p0, honest, "listing changes do not change the chosen revenue share");
    }

    /// Paid maintenance and a separate collection apply the same stored revenue percentage.
    function test_upkeepAndSeparateCollectionUseTheSameStoredRate() public {
        _claimAll();
        uint256[] memory r = buy(buyer, 1);
        fulfill(r[0], _wordFor(3));
        settle();
        fillUp();
        uint256[] memory d = buy(buyer, 1);
        _drawListing(d[0], curated);
        assertLt(_fund(), balancer.requiredReserve(), "fund short after the big win");
        uint256 p0 = balancer.creatorCredit();
        uint256 snap = vm.snapshotState();
        balancer.collectProceeds();
        uint256 drawTime = balancer.creatorCredit() - p0;
        vm.revertToState(snap);
        upkeep();
        assertGt(drawTime, 0, "profit flows while the fund is short");
        assertEq(balancer.creatorCredit() - p0, drawTime, "upkeep applies the same stored percentage");
    }

    /// Both maintenance paths protect credit even when it is the only cash able to buy a missing prize.
    function test_unpaidRecoveryPreservesCreditWhenOperatingCashCannotRestock() public {
        _claimAll();
        vm.prank(creator); balancer.setCreatorRevenueBps(10_000);
        uint256[] memory big = buy(buyer, 1);
        fulfill(big[0], _wordFor(3));
        settle();
        fillUp();
        uint256[] memory small = buy(buyer, 1);
        fulfill(small[0], _wordFor(0));
        settle();
        balancer.collectProceeds();
        uint256 credit = balancer.creatorCredit();
        assertGt(credit, 0.011 ether);
        assertLt(_fund(), 0.011 ether);
        uint256 before = address(balancer).balance;
        vm.prank(creator); balancer.performUpkeepUnpaid();
        assertEq(balancer.getActiveShapes()[3], 0);
        assertEq(balancer.getActiveShapes()[0], 3);
        assertEq(balancer.creatorCredit(), credit);
        assertEq(address(balancer).balance, before);
    }

    /// The worst batch at the minimum reserve (the 0.5, both 0.1 and two 0.01 Shapes) costs more to restock than the
    /// pool holds. Every winner is still paid in full: each prize carries its own backing in the Shapes contract.
    /// Purchases continue; sales restock the rest and then refill the reserve.
    function test_worstBatchAtMinimumReservePaysEveryWinner() public {
        uint256 big = lastListingId();
        uint256[5] memory want = [big, big - 1, big - 2, big - 3, big - 4];
        uint256 owedValue;
        for (uint256 i; i < 5; ++i) {
            (,,,,, uint256 price,,) = pool.listings(want[i]);
            owedValue += price;
        }
        _claimAll();
        uint256 held = address(balancer).balance + pool.ownerProceeds();

        uint256[] memory ids = buy(buyer, 5);
        for (uint256 i; i < 5; ++i) {
            if (i > 0 && ids[i] == ids[i - 1]) continue;
            _drawListing(ids[i], want[i]);
        }
        fillUp();
        assertGt(owedValue, held, "the batch won more than the pool held");

        uint256 paid;
        for (uint256 i; i < 5; ++i) {
            (,, address winner, uint256 tokenId,,,,) = pool.listings(want[i]);
            assertEq(winner, buyer, "drawn as forced");
            assertEq(shapes.ownerOf(tokenId), buyer, "prize delivered");
            uint256[] memory one = new uint256[](1);
            one[0] = tokenId;
            uint256 backing = shapes.denominationAt(shapes.denomIndexOf(tokenId));
            uint256 before = buyer.balance;
            vm.prank(buyer);
            shapes.redeemBatch(one);
            paid += buyer.balance - before;
            assertEq(buyer.balance - before, backing, "full backing");
        }
        assertEq(paid, 0.72 ether, "winner redeemed 0.5 + 0.1 + 0.1 + 0.01 + 0.01");

        assertEq(balancer.admissionStatus(), 0, "purchases continue");
        (uint256 n,) = _sellUntilRefilled();
        emit log_named_decimal_uint("held at minimum reserve", held, 18);
        emit log_named_decimal_uint("listed price of the five prizes won", owedValue, 18);
        emit log_named_uint("draws to restock and refill", n);
        uint16[16] memory active = balancer.getActiveShapes();
        assertEq(active[0], 4);
        assertEq(active[2], 2);
        assertEq(active[3], 1);
    }

    /// The minimum markup: the markup is the only profit that refills the reserve.
    function test_markupBelowTenPercentRejected() public {
        uint256 t = balancer.target();
        uint256 fee = shapes.mintFee();
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        balancer.configure(999, t, fee);
        vm.startPrank(creator);
        balancer.configure(1000, t, shapes.mintFee());
        vm.stopPrank();
    }


    /// E5, with D3: closing keeps back only the keeper pay for draws not yet reconciled (one maximum reward per five),
    /// which pays the reconcile of a draw that settles later; everything else is claimable.
    function test_closeHoldsOnlyPayForUnreconciledDraws() public {
        uint256[] memory r = buy(buyer, 1);
        _drawListing(r[0], curated + 1);
        upkeep();

        uint256[] memory pending = buy(buyer, 1);
        vm.prank(creator);
        balancer.close();
        uint256 held = _reconciliationBudget();
        assertEq(balancer.requiredReserve(), held, "one unreconciled draw: its operation-sensitive cap held");
        assertEq(balancer.withdrawableSurplus(), address(balancer).balance - held, "everything else claimable");
        _claimAll();
        assertEq(address(balancer).balance, held, "only the held pay is left");

        _drawListing(pending[0], curated + 2);
        uint256 proceeds = pool.ownerProceeds();
        address donor = makeAddr("donor");
        vm.deal(donor, 0.001 ether);
        vm.prank(donor);
        balancer.depositETH{value: 0.001 ether}();

        uint256 keeperBefore = keeper.balance;
        upkeep(); // reconciles the last draw
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence());
        uint256 paid = keeper.balance - keeperBefore;
        assertGe(paid, 0.0001 ether, "reconciling the last draw is paid");
        assertLt(paid, 0.0003 ether, "one cheap call");
        assertEq(address(balancer).balance, held + 0.001 ether + proceeds - paid, "nothing else left");
        assertEq(balancer.requiredReserve(), 0, "nothing held once reconciled");
        assertEq(balancer.withdrawableSurplus(), address(balancer).balance, "and all of it claimable");
        bytes32 uh1 = balancer.settingsHash();
        vm.prank(keeper, keeper);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep(uh1, 0, 0);
    }

    /// S4: a collection that is also the creator cannot change the markup inside its own transfer: `configure` is
    ///     guarded, so the listing reverts and the markup stays as configured.
    function test_collectionCallbackCannotReconfigure() public {
        ReconfiguringNFT hostile = new ReconfiguringNFT();
        vm.prank(creator);
        balancer.transferCreator(address(hostile));
        hostile.becomeCreator(address(balancer));

        vm.expectRevert(ReentrancyGuard.Reentrancy.selector);
        hostile.listWithCallback(address(balancer), 7, 0.1 ether, 10_000);
        assertEq(balancer.markupBps(), MARKUP, "markup unchanged");
    }

    /// Independent audit E2: listed prizes keep their listing price, so lowering the markup used to push a full board
    /// under the fill gate with nothing for upkeep to restock. The gate weighs prizes by backing, so it stays open.
    function test_lowerMarkupKeepsAFullBoardOpen() public {
        uint256 t = balancer.target();
        vm.startPrank(creator);
        balancer.configure(10_000, t, shapes.mintFee());
        vm.stopPrank();
        // Relist every Shape at 100% markup.
        uint256[] memory ids = balancer.getActiveIds();
        uint256[] memory shapeIds = new uint256[](ids.length - 1);
        uint256 k;
        for (uint256 i; i < ids.length; ++i) if (ids[i] != curated) shapeIds[k++] = ids[i];
        vm.prank(creator);
        balancer.unlistShapes(shapeIds);
        fillUp();
        assertEq(balancer.admissionStatus(), 0, "full board at 100% markup");

        vm.startPrank(creator);
        balancer.configure(1_000, t, shapes.mintFee());
        vm.stopPrank();
        assertFalse(balancer.creatorWork(), "nothing to restock: every prize is listed");
        assertEq(balancer.admissionStatus(), 0, "a lower markup leaves a full board open");
        uint256[] memory d = buy(buyer, 1);
        assertEq(d.length, 1, "a purchase goes through");
    }

    /// Independent audit E3: NFTs are listed only once the pool has a design, at their value (no markup).
    function test_nftsListOnlyAfterTheFirstConfigure() public {
        vm.prank(creator);
        PoolBalancer fresh = _createFixture(creator, bytes32(uint256(1)), 1 ether);
        nft.mint(creator, 50);
        vm.startPrank(creator);
        nft.approve(address(fresh), 50);
        fresh.configure(MARKUP, plan([uint256(1), 0, 0, 0, 0, 0, 0, 0, 0]), shapes.mintFee());
        uint256 lid = fresh.listCurated(address(nft), 50, 0.3 ether);
        vm.stopPrank();
        (,,,, uint112 price) = fresh.items(lid);
        assertEq(price, 0.3 ether, "listed at its value");
    }

    /// Independent audit E5: `open` collects settled FWA proceeds into this contract before checking the reserve, so
    /// the reserve is checked against ETH actually held here.
    function test_openCollectsSettledProceedsFirst() public {
        uint256[] memory d = buy(buyer, 1);
        fulfill(d[0], _wordFor(0));
        settle();
        vm.prank(creator);
        balancer.close();
        uint256 proceeds = pool.ownerProceeds();
        assertGt(proceeds, 0, "settled proceeds waiting at FWA");
        uint256 before = address(balancer).balance;
        vm.prank(creator);
        balancer.open();
        assertEq(pool.ownerProceeds(), 0, "collected on open");
        assertEq(address(balancer).balance, before + proceeds, "proceeds now held here");
        assertGe(address(balancer).balance - balancer.creatorCredit(), balancer.requiredReserve(), "reserve held in ETH here");
    }

    /// Round 9 R9-S4: a creator contract running upkeep cannot re-enter creator functions from its keeper reward.
    function test_creatorKeeperCannotReenterFromReward() public {
        CreatorKeeper ck = new CreatorKeeper(balancer);
        vm.prank(creator);
        balancer.transferCreator(address(ck));
        ck.accept();
        uint256[] memory d = buy(buyer, 1);
        fulfill(d[0], _wordFor(0));
        settle();
        uint256 reward = ck.upkeep();
        assertGt(reward, 0, "creator work earns a reward");
        assertTrue(ck.tried(), "the reward reached the creator contract");
        assertFalse(ck.closedInside(), "close() inside the reward callback was refused");
        assertTrue(balancer.enabled(), "pool still open");
    }
}

/// A creator contract that runs upkeep itself and tries to close the pool when the keeper reward arrives.
contract CreatorKeeper {
    PoolBalancer internal b;
    bool public tried;
    bool public closedInside;

    constructor(PoolBalancer b_) {
        b = b_;
    }

    function accept() external {
        b.acceptCreator();
    }

    function upkeep() external returns (uint256) {
        return b.performUpkeep(b.settingsHash(), 0, 0);
    }

    receive() external payable {
        if (msg.sender != address(b) || tried) return;
        tried = true;
        try b.close() {
            closedInside = true;
        } catch {}
    }
}
