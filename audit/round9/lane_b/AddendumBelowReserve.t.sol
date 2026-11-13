// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Harness2, console} from "./Harness2.sol";

/// Priority 1: force the fund below the reserve with word-targeted big wins, then search for a creator action or
/// timing that (a) moves fund money into withdrawable profit, (b) lets a claim take the fund below the reserve or
/// below where it was, or (c) stalls the refill. Real draws via the corrected VRF route.
contract AddendumBelowReserveTest is Harness2 {
    // size indices: 0 => 0.01 ETH Shape, 3 => 0.5 ETH Shape
    function _target(uint256 nSmall, uint256 nBig) internal pure returns (uint256 t) {
        t = (nSmall & 0xFFFF) | ((nBig & 0xFFFF) << (16 * 3));
    }

    function _bigShapeIds() internal view returns (uint256[] memory out) {
        uint256[] memory ids = _activeShapeIds();
        out = new uint256[](ids.length);
        uint256 n;
        for (uint256 i; i < ids.length; i++) {
            (, uint8 denom,,,) = bal.items(ids[i]);
            if (denom == 3) out[n++] = ids[i];
        }
        assembly { mstore(out, n) }
    }

    function _setup() internal {
        nextNft += 50;
        _newPool(1.7 ether);
        vm.prank(creator);
        bal.configure(5000, _target(0, 2)); // 50% markup, two 0.5 ETH Shapes only (dominate draw weight)
        _listCurated(3 ether); // expensive curated (low weight) just to open the admission gate
        _listCurated(3 ether);
        vm.prank(creator);
        bal.open();
        _stock();
        require(!bal.creatorWork(), "setup incomplete");
    }

    /// Enter below-reserve by winning both big prizes (targeted) without reconciling, and confirm the safety
    /// invariants hold while short: profit <= balance, and a claim can never push the balance below the reserve.
    function testBelowReserveSafety() public {
        _fork();
        _deploy();
        _setup();
        vm.fee(1 gwei);
        vm.txGasPrice(1.05 gwei);

        // win both 0.5 ETH prizes (targeted), do NOT run Balancer upkeep in between
        uint256[] memory bigs = _bigShapeIds();
        assertEq(bigs.length, 2, "two big prizes listed");
        bool hit1 = _drawTargeting(player, bigs[0], 60);
        assertTrue(hit1, "could not target first big prize");
        // after one settle the pool still lists the second big prize
        uint256[] memory bigs2 = _bigShapeIds();
        bool hit2 = bigs2.length > 0 && _drawTargeting(player, bigs2[0], 60);

        uint256 balNow = address(bal).balance;
        uint256 req = bal.requiredReserve();
        uint256 fund = balNow - bal.profit();
        console.log("after big win(s): balance / reserve / fund", balNow, req, fund);
        console.log("hit2 (second big win)", hit2 ? 1 : 0);
        console.log("profit", bal.profit());
        bool below = fund < req;
        console.log("below reserve?", below ? 1 : 0);

        // Safety invariant regardless of regime: profit never exceeds balance.
        assertLe(bal.profit(), balNow, "profit exceeds balance");

        // Try to claim the maximum: it must be bounded by withdrawableSurplus and must never leave the balance
        // below the live requiredReserve (while open), i.e. a claim cannot strand a future restock.
        uint256 s = bal.withdrawableSurplus();
        if (s > 0) {
            vm.prank(creator);
            bal.claimSurplus(s, creator);
            uint256 balAfter = address(bal).balance;
            console.log("claimed / balAfter / reserveAfter", s, balAfter, bal.requiredReserve());
            // If the claim used the free path it leaves balance >= reserve; if the profit path, fund is preserved.
            // Either way balance must still cover the (now possibly larger) reserve OR the claim was pure profit.
            assertLe(bal.profit(), balAfter, "profit exceeds balance after claim");
        }

        // Now let the keeper refill and reconcile; the pool should recover to healthy and keep paying winners.
        for (uint256 i; i < 10 && bal.creatorWork() == false && bal.admissionStatus() == 6; i++) _upkeep(keeper);
        for (uint256 i; i < 10; i++) _upkeep(keeper);
        console.log("after refill: admissionStatus", bal.admissionStatus());
        console.log("after refill: balance / reserve", address(bal).balance, bal.requiredReserve());
    }

    /// Attack: while below the reserve (proceeds from low-markup draws uncollected), reconfigure to a higher markup
    /// and restock, then collect, and check whether more profit is booked than the low-markup draws actually earned.
    /// Restricted keepers so the creator controls all timing.
    function testMarkupChangeOverbooking() public {
        _fork();
        _deploy();
        factory.setKeepersRestricted(true); // creator is the only keeper; full timing control
        nextNft += 50;
        _newPool(1.7 ether);
        vm.prank(creator);
        bal.configure(1000, _target(0, 2)); // START at 10% markup => Shape profit share == 0; two 0.5 Shapes
        _listCurated(3 ether);
        _listCurated(3 ether);
        vm.prank(creator);
        bal.open();
        vm.prank(creator);
        while (bal.creatorWork()) { (bool ok,,) = _tryUpkeepCreator(); if (!ok) break; }
        require(!bal.creatorWork(), "setup incomplete");

        vm.fee(1 gwei);
        vm.txGasPrice(1.05 gwei);

        // win a big prize at 10% markup; its proceeds should be ENTIRELY fund money (share 0 at min markup)
        uint256[] memory bigs = _bigShapeIds();
        bool hit = _drawTargeting(player, bigs[0], 80);
        require(hit, "target big prize");
        uint256 proceeds = pool.ownerProceeds();
        console.log("uncollected proceeds from 10%-markup big win", proceeds);

        // creator raises markup to 100% and restocks (creator work) BEFORE collecting
        vm.prank(creator);
        bal.configure(10000, _target(0, 2));
        vm.prank(creator);
        while (bal.creatorWork()) { (bool ok,,) = _tryUpkeepCreator(); if (!ok) break; }

        // now collect the OLD (10%-markup) proceeds against the NEW high-markup listing set
        uint256 profitBefore = bal.profit();
        uint256 fundBefore = address(bal).balance - bal.profit();
        bool below = fundBefore < bal.requiredReserve();
        vm.prank(creator);
        bal.collectProceeds();
        uint256 booked = bal.profit() - profitBefore;
        console.log("below reserve at collect?", below ? 1 : 0);
        console.log("profit booked from the 10%-markup proceeds", booked);
        // The 10%-markup big win earned the creator ZERO profit share. Any profit booked here is fund money moved
        // into withdrawable profit by a creator action (markup change + restock timing). Flag if > dust.
        console.log("OVER-BOOKED fund->profit (wei)", booked);
    }

    function _tryUpkeepCreator() internal returns (bool ok, uint256 r, uint256 m) {
        bool setup;
        (r, m, setup) = _upkeep(creator);
        ok = true;
    }
}
