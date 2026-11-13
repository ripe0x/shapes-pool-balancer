// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {ReconfiguringNFT} from "./utils/Mocks.sol";

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
        return address(balancer).balance - balancer.profit();
    }

    /// @dev Sell single draws that each win a 0.01 Shape, the creator claiming everything claimable after each, until
    ///      the fund holds the reserve again. Every draw is admitted, every draw pays the creator something, and no
    ///      claim takes the fund below the reserve or below where it was.
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
            assertGt(w, 0, "profit flows on every draw");
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

    /// The reserve's spare restocks a big win at once; purchases continue and their markup refills the reserve.
    /// The creator cannot withdraw until it is whole again.
    function test_bigWinKeepsSellingWhileReserveRefills() public {
        _claimAll();
        uint256 need = balancer.requiredReserve();
        uint256[] memory r = buy(buyer, 1);
        fulfill(r[0], _wordFor(3));
        settle();
        fillUp();
        assertEq(balancer.getActiveShapes()[3], 1, "0.5 Shape restocked from the spare");
        assertLt(_fund(), need, "spare spent");
        assertEq(balancer.withdrawableSurplus(), balancer.profit(), "only profit is claimable while the fund is short");
        assertEq(balancer.admissionStatus(), 0, "purchases continue");

        (uint256 n, uint256 claimed) = _sellUntilRefilled();
        emit log_named_uint("draws to refill after the 0.5 win", n);
        emit log_named_decimal_uint("creator claimed meanwhile", claimed, 18);
        assertGe(_fund(), balancer.requiredReserve());
    }

    /// The creator's share of each payment follows the listed prices: the markup on each Shape prize's backing,
    /// weighted by 1 / price as FWA weights its draws. Curated NFTs count zero.
    function test_creatorShareFollowsListedPrices() public view {
        uint256[] memory ids = balancer.getActiveIds();
        uint256 expected;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 denom,,, uint112 price) = balancer.items(ids[i]);
            if (kind != 1) expected += balancer.denominationAmount(denom) * (MARKUP - 1000) * 1e18 / (10_000 * uint256(price));
        }
        assertEq(balancer.profitShareSum(), expected);
    }

    /// Review finding: proceeds are split against the listings at collection, so a creator could list NFTs just before
    /// a collection to move fund money into profit. Curated NFTs count zero, so listing them only lowers the creator's
    /// share. Withdrawing NFTs raises it at most to the Shapes-only share, below half the payment, so the fund always
    /// keeps at least half of every payment.
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
        uint256 p0 = balancer.profit();
        uint256 snap = vm.snapshotState();
        balancer.collectProceeds();
        uint256 honest = balancer.profit() - p0;
        vm.revertToState(snap);
        for (uint256 i; i < 5; ++i) listCurated(100 + i, 50 ether);
        balancer.collectProceeds();
        uint256 padded = balancer.profit() - p0;
        assertGt(honest, 0, "profit flows while the fund is short");
        assertEq(padded, honest, "listing NFTs collects first: the split is the honest one");
        assertLt(honest, amount / 2, "the fund keeps at least half of a payment");

        vm.revertToState(snap);
        vm.prank(creator);
        balancer.withdrawCurated(curated, creator);
        balancer.collectProceeds();
        assertEq(balancer.profit() - p0, honest, "withdrawing NFTs collects first: the split is the honest one");

        // Unlisting Shapes also collects first.
        vm.revertToState(snap);
        uint256[] memory one = new uint256[](1);
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 denom,,,) = balancer.items(ids[i]);
            if (kind == SHAPE_KIND && denom == 3) one[0] = ids[i]; // the 0.5 Shape relisted after the win
        }
        vm.prank(creator);
        balancer.unlistShapes(one);
        assertEq(balancer.profit() - p0, honest, "unlisting Shapes collects first: the split is the honest one");
    }

    /// Round 9 R9-E1: upkeep collects before reconciling, so a draw's proceeds are split over the listings it was
    /// priced on. Reconciling first dropped the won NFT (share 0) and booked n / (n - 1) of the share from the fund.
    function test_upkeepSplitsOverTheListingsTheDrawWasPricedOn() public {
        _claimAll();
        uint256[] memory r = buy(buyer, 1);
        fulfill(r[0], _wordFor(3));
        settle();
        fillUp();
        uint256[] memory d = buy(buyer, 1);
        _drawListing(d[0], curated);
        assertLt(_fund(), balancer.requiredReserve(), "fund short after the big win");
        uint256 p0 = balancer.profit();
        uint256 snap = vm.snapshotState();
        balancer.collectProceeds();
        uint256 drawTime = balancer.profit() - p0;
        vm.revertToState(snap);
        upkeep();
        assertGt(drawTime, 0, "profit flows while the fund is short");
        assertEq(balancer.profit() - p0, drawTime, "upkeep books the draw-time split");
    }

    /// Game first: when the fund cannot pay a restock, unclaimed profit pays it.
    function test_unclaimedProfitRestocksWhenTheFundIsEmpty() public {
        // A 100% markup, so restocked prizes carry a large share above the 10% the fund keeps.
        uint256 t = balancer.target();
        vm.prank(creator);
        balancer.configure(10_000, t);
        _claimAll();
        uint256[] memory r = buy(buyer, 1);
        fulfill(r[0], _wordFor(3));
        settle();
        fillUp();
        // Let profit build unclaimed until the balance covers a second 0.5 Shape the fund alone cannot.
        uint256 i;
        while (address(balancer).balance < 0.51 ether) {
            uint256[] memory s = buy(buyer, 1);
            fulfill(s[0], _wordFor(0));
            settle();
            fillUp();
            require(++i < 400, "balance never reached 0.51");
        }
        uint256[] memory b = buy(buyer, 1);
        fulfill(b[0], _wordFor(3));
        settle();
        balancer.collectProceeds();
        assertLt(_fund(), 0.5011 ether, "the fund alone cannot restock the 0.5 Shape");
        assertGt(address(balancer).balance, 0.506 ether, "fund and profit together can");
        fillUp();
        assertEq(balancer.getActiveShapes()[3], 1, "0.5 Shape restocked");
        assertEq(balancer.profit(), address(balancer).balance, "paid partly from unclaimed profit: none of the fund is left");
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
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        balancer.configure(999, t);
        vm.prank(creator);
        balancer.configure(1000, t);
    }


    /// E5: credit left from keeper listings returns to the creator at close, so a later deposit never pays it.
    function test_closeReturnsKeeperCredit() public {
        // A 0.01 Shape (listed right after the curated NFT) drawn and restocked by a keeper bidding below the fee's
        // gas price: part of the restocking fee is left as credit.
        uint256[] memory r = buy(buyer, 1);
        _drawListing(r[0], curated + 1);
        vm.txGasPrice(0.01 gwei);
        upkeep();
        vm.txGasPrice(1 gwei);
        assertGt(balancer.keeperCredit(), 0, "unspent restocking fees");

        uint256[] memory pending = buy(buyer, 1);
        vm.prank(creator);
        balancer.close();
        assertEq(balancer.keeperCredit(), 0, "close returns credit");
        _claimAll();
        assertEq(address(balancer).balance, 0);

        _drawListing(pending[0], curated + 2);
        uint256 proceeds = pool.ownerProceeds();
        address donor = makeAddr("donor");
        vm.deal(donor, 0.001 ether);
        vm.prank(donor);
        balancer.depositETH{value: 0.001 ether}();

        uint256 keeperBefore = keeper.balance;
        upkeep(); // reconciles the last draw
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence());
        assertEq(keeper.balance, keeperBefore, "no reward after close");
        assertEq(address(balancer).balance, 0.001 ether + proceeds, "deposit untouched");
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
        vm.prank(creator);
        balancer.configure(10_000, t);
        // Relist every Shape at 100% markup.
        uint256[] memory ids = balancer.getActiveIds();
        uint256[] memory shapeIds = new uint256[](ids.length - 1);
        uint256 k;
        for (uint256 i; i < ids.length; ++i) if (ids[i] != curated) shapeIds[k++] = ids[i];
        vm.prank(creator);
        balancer.unlistShapes(shapeIds);
        fillUp();
        assertEq(balancer.admissionStatus(), 0, "full board at 100% markup");

        vm.prank(creator);
        balancer.configure(1_000, t);
        assertFalse(balancer.creatorWork(), "nothing to restock: every prize is listed");
        assertEq(balancer.admissionStatus(), 0, "a lower markup leaves a full board open");
        uint256[] memory d = buy(buyer, 1);
        assertEq(d.length, 1, "a purchase goes through");
    }

    /// Independent audit E3: a curated NFT listed before the first `configure` would carry no markup.
    function test_nftsListOnlyAfterTheFirstConfigure() public {
        vm.prank(creator);
        PoolBalancer fresh = PoolBalancer(payable(factory.createBalancer{value: 1 ether}(bytes32(uint256(1)))));
        nft.mint(creator, 50);
        vm.startPrank(creator);
        nft.approve(address(fresh), 50);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        fresh.listCurated(address(nft), 50, 0.3 ether);
        fresh.configure(MARKUP, plan([uint256(1), 0, 0, 0, 0, 0, 0, 0, 0]));
        uint256 lid = fresh.listCurated(address(nft), 50, 0.3 ether);
        vm.stopPrank();
        (,,,, uint112 price) = fresh.items(lid);
        assertEq(price, 0.3 ether * (10_000 + uint256(MARKUP)) / 10_000, "listed at the configured markup");
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
        assertGe(address(balancer).balance - balancer.profit(), balancer.requiredReserve(), "reserve held in ETH here");
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
        return b.performUpkeep();
    }

    receive() external payable {
        if (msg.sender != address(b) || tried) return;
        tried = true;
        try b.close() {
            closedInside = true;
        } catch {}
    }
}
