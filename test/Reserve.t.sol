// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {ReconfiguringNFT} from "./utils/Mocks.sol";

/// @notice Reserve rules on a mainnet fork with the real FWA pool, VRF service and Shapes: a pool opens only with its
///         reserve in ETH (E2), purchases continue while sales refill it after big wins (DECISIONS 66), closing
///         returns unspent keeper credit (E5), and curated NFTs are priced after the collection's own calls (S4).
contract ReserveTest is ForkBase {

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

    /// @dev Sell single draws that each win a 0.01 Shape until the creator can withdraw again; returns the draws sold.
    ///      Every draw is admitted on the way: purchases never wait for ETH.
    function _sellUntilRefilled() internal returns (uint256 n) {
        while (balancer.withdrawableSurplus() == 0) {
            assertEq(balancer.admissionStatus(), 0, "still selling while the reserve refills");
            uint256[] memory r = buy(buyer, 1);
            fulfill(r[0], _wordFor(0));
            settle();
            fillUp();
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
        assertLt(address(balancer).balance, need, "spare spent");
        assertEq(balancer.withdrawableSurplus(), 0, "withdrawals wait");
        assertEq(balancer.admissionStatus(), 0, "purchases continue");
        // A second draw is admitted too.
        uint256[] memory r2 = buy(buyer, 1);
        fulfill(r2[0], _wordFor(0));
        settle();
        fillUp();

        uint256 n = _sellUntilRefilled();
        emit log_named_uint("draws to refill after the 0.5 win", n);
        assertGe(address(balancer).balance, balancer.requiredReserve());
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
        uint256 n = _sellUntilRefilled();
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
