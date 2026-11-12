// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {ReconfiguringNFT} from "./utils/Mocks.sol";

/// @notice Round 8 fixes on a mainnet fork with the real FWA pool, VRF service and Shapes: purchases need the reserve
///         in ETH (E1, E2), closing returns unspent keeper credit (E5), and curated NFTs are priced after the
///         collection's own calls (S4).
contract ReserveTest is ForkBase {
    bytes4 constant PURCHASE_NOT_ALLOWED = bytes4(keccak256("PurchaseNotAllowed()"));
    uint8 constant LOW_FUNDS = 7;

    uint256 curated;

    function setUp() public {
        setUpFork();
        createBalancer(5 ether);
        curated = listCurated(1, 0.3 ether);
        // 4 x 0.01, 2 x 0.1, 1 x 0.5: the 0.5 Shape is listed last.
        configure(plan([uint256(4), 0, 2, 1, 0, 0, 0, 0, 0]));
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

    function _fundGap() internal {
        uint256 have = address(balancer).balance + pool.ownerProceeds();
        uint256 need = balancer.requiredReserve();
        vm.prank(creator);
        balancer.depositETH{value: need - have}();
    }

    function _strangerCannotBuy() internal {
        (,, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 v = pool.inventoryVersion();
        vm.deal(stranger, 1 ether);
        vm.prank(stranger, stranger);
        vm.expectRevert(PURCHASE_NOT_ALLOWED);
        pool.acquire{value: total}(stranger, 0, 0, 10_000, v, block.timestamp + 1);
    }

    function _drawListing(uint256 requestId, uint256 lid) internal {
        (,,,,,, uint256 slot,) = pool.listings(lid);
        fulfill(requestId, wordForSlot(slot));
        settle();
    }

    /// E2: close, claim everything, reopen. Purchases stay refused until the reserve is back in ETH.
    function test_drainedReopenRefusesPurchases() public {
        vm.prank(creator);
        balancer.close();
        _claimAll();
        assertEq(address(balancer).balance, 0, "closed pool fully drained");
        vm.prank(creator);
        balancer.open();
        assertFalse(balancer.creatorWork(), "fully stocked: no setup work");
        assertEq(balancer.admissionStatus(), LOW_FUNDS);
        assertFalse(balancer.canPurchase(buyer));
        _strangerCannotBuy();

        _fundGap();
        assertEq(balancer.admissionStatus(), 0, "funded reserve reopens purchases");
        buy(buyer, 1);
    }

    /// E1: at the minimum reserve each draw in flight needs one more largest prize in ETH, so two big wins are always
    ///     restocked. The spare they used must be funded again before purchases resume.
    function test_drawsInFlightNeedOneLargestPrizeEach() public {
        uint256 big = lastListingId(); // the 0.5 Shape
        uint256 mid = big - 1; // a 0.1 Shape
        _claimAll();
        assertEq(balancer.admissionStatus(), 0, "minimum reserve admits one draw");

        uint256[] memory first = buy(buyer, 1);
        assertEq(balancer.admissionStatus(), LOW_FUNDS, "second concurrent draw needs another largest prize");
        _strangerCannotBuy();

        _fundGap();
        uint256[] memory second = buy(buyer, 1);

        _drawListing(first[0], big);
        _drawListing(second[0], mid);
        fillUp();
        uint16[16] memory active = balancer.getActiveShapes();
        assertEq(active[3], 1, "0.5 Shape restocked");
        assertEq(active[2], 2, "0.1 Shape restocked");
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence(), "both draws reconciled");
        assertEq(balancer.admissionStatus(), LOW_FUNDS, "spare used: purchases wait for funding");

        _fundGap();
        assertEq(balancer.admissionStatus(), 0);
    }

    /// FWA asks the hook once per transaction, before it issues that transaction's draws, so one batch of five is
    /// admitted on one spare. Its draws then raise the reserve, so no further purchase is admitted until it is funded.
    function test_batchAtMinimumReservePausesUntilFunded() public {
        _claimAll();
        uint256 before = pool.lastIssuedSequence();
        uint256[] memory ids = buy(buyer, 5);
        assertEq(pool.lastIssuedSequence() - before, 5, "one admitted batch issues five draws");
        // BUSY (5 unsettled) reports first; the funding shortfall outlasts it.
        assertGt(balancer.requiredReserve(), address(balancer).balance + pool.ownerProceeds() + 4 * 0.5 ether, "reserve now counts five more largest prizes");
        assertFalse(balancer.canPurchase(buyer));
        for (uint256 i; i < ids.length; ++i) if (i == 0 || ids[i] != ids[i - 1]) fulfill(ids[i], 0);
        settle();
        assertEq(pool.unsettledAcquisitionCount(), 0);
        // Settled but unreconciled: the draws still count against the reserve until upkeep reconciles them.
        assertFalse(balancer.canPurchase(buyer));
        assertLt(address(balancer).balance + pool.ownerProceeds(), balancer.requiredReserve(), "still short after settling");
    }

    /// The worst batch at the minimum reserve (the 0.5, both 0.1 and two 0.01 Shapes) costs more to restock than the
    /// pool holds. Every winner is still paid in full: each prize carries its own backing in the Shapes contract,
    /// so a shortfall only leaves the board short and purchases paused until it is funded.
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

        // The pool restocked what its ETH covered and refuses purchases until the rest is funded.
        assertEq(balancer.admissionStatus(), LOW_FUNDS);
        _strangerCannotBuy();
        emit log_named_decimal_uint("held at minimum reserve", held, 18);
        emit log_named_decimal_uint("listed price of the five prizes won", owedValue, 18);
        emit log_named_decimal_uint("deposit to reopen", balancer.requiredReserve() - address(balancer).balance - pool.ownerProceeds(), 18);
        _fundGap();
        fillUp();
        uint16[16] memory active = balancer.getActiveShapes();
        assertEq(active[0], 4);
        assertEq(active[2], 2);
        assertEq(active[3], 1);
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence());
        if (balancer.admissionStatus() == LOW_FUNDS) _fundGap();
        assertEq(balancer.admissionStatus(), 0, "funded and restocked: open again");
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

    /// S4: a collection that is also the creator changes the markup inside its transfer; the listing uses the markup
    ///     in force once the token is held.
    function test_curatedPricedAfterCollectionCallback() public {
        ReconfiguringNFT hostile = new ReconfiguringNFT();
        vm.prank(creator);
        balancer.transferCreator(address(hostile));
        hostile.becomeCreator(address(balancer));

        uint256 lid = hostile.listWithCallback(address(balancer), 7, 0.1 ether, 10_000);
        assertEq(balancer.markupBps(), 10_000, "callback reconfigured");
        (,,,, uint112 price) = balancer.items(lid);
        (,,,,, uint256 fwaPrice,,) = pool.listings(lid);
        assertEq(price, 0.2 ether, "priced at the markup in force after the pull");
        assertEq(fwaPrice, 0.2 ether);
    }
}
