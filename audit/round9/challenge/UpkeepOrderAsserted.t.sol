// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {AddendumBase} from "../lane_a/addendum/AddendumBase.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";

interface IOwnerOf {
    function ownerOf(uint256) external view returns (address);
}

/// Second-pass decision on C12 + the controller's variant. The controller's UpkeepOrder.t.sol only asserts
/// `assertGt(profit,0)` and leaves the actual over-booking in the logs. This file ASSERTS it, and separates the two
/// claims:
///  (A) collect-before-reconcile on a curated draw books the DESIGNED EV split (NOT a leak) — equals a shape draw's
///      baseline; my original C12 "leak" framing is wrong as a net leak.
///  (B) in a GENUINE shortfall, performUpkeep (reconcile-before-collect) books MORE than the draw-time-set split and
///      lets the creator withdraw strictly more while the fund is below the reserve — the real automatic M9 instance.
/// Real coordinator -> VRF service route; no mocks.
contract UpkeepOrderAsserted is AddendumBase {
    // Genuine shortfall: a 0.5 win spends the spare, then the curated NFT is drawn. Assert the upkeep-order over-book.
    function testUpkeepOrderOverBooksInGenuineShortfall() public {
        PoolBalancer b = newBalancer();
        uint256 cid = openPool(b, one(D_001, 5) | one(D_05, 1), 3000, 10 ether, 0.02 ether);
        (,,, uint256 tok,,,,) = b.pool().listings(cid);
        uint256 bal = address(b).balance;
        uint256 reserve = b.requiredReserve();
        if (bal > reserve) {
            vm.prank(creator);
            b.claimSurplus(bal - reserve, creator);
        }
        uint256 postClaimBal = address(b).balance; // pulled down to the reserve
        // draw the 0.5 shape (spends the spare -> genuine shortfall); controller's exact heuristic
        bool big;
        for (uint256 w = 1; w <= 200 && !big; ++w) {
            uint256 s = vm.snapshotState();
            drawReal(b, uint256(keccak256(abi.encode("big", w))));
            upkeep(b);
            if (b.getActiveShapes()[D_05] == 1 && address(b).balance + 0.4 ether < postClaimBal) big = true;
            else vm.revertToState(s);
        }
        require(big, "0.5 not drawn");
        uint256 fundShort = address(b).balance - b.profit();
        uint256 reqShort = b.requiredReserve();
        require(fundShort < reqShort, "not genuinely short");
        require(address(b).balance < reqShort, "balance not below reserve (not a real shortfall)");

        // draw the curated NFT, leave settled-unreconciled
        bool hit;
        for (uint256 w = 1; w <= 120 && !hit; ++w) {
            uint256 s = vm.snapshotState();
            drawReal(b, uint256(keccak256(abi.encode("cur2", w))));
            if (IOwnerOf(address(nft)).ownerOf(tok) == player) hit = true;
            else vm.revertToState(s);
        }
        require(hit, "curated not drawn");

        uint256 p0 = b.profit();
        uint256 snap = vm.snapshotState();

        // (A) collect first on the draw-time set (includes the curated, share 0) = designed EV split
        b.collectProceeds();
        uint256 bookedCollectFirst = b.profit() - p0;
        uint256 claimCollectFirst = b.withdrawableSurplus();
        vm.revertToState(snap);

        // (B) performUpkeep: reconcile removes the curated, THEN collect over n-1 -> larger split
        vm.prank(keeper);
        b.performUpkeep();
        uint256 bookedUpkeep = b.profit() - p0;
        uint256 claimUpkeep = b.withdrawableSurplus();

        console.log("booked collect-first (EV split) / upkeep (reconcile-first):", bookedCollectFirst, bookedUpkeep);
        console.log("claimable collect-first / upkeep                          :", claimCollectFirst, claimUpkeep);
        console.log("extra fund money made withdrawable by the keeper order (wei):", bookedUpkeep - bookedCollectFirst);

        // Decision (A): collect-first books the EV split, > 0, NFT money in the expectation (not a standalone leak).
        assertGt(bookedCollectFirst, 0, "A: EV split books positive on the drawn payment");
        // Decision (B): the keeper's normal reconcile-first order over-books vs the draw-time set — automatic M9 leak.
        assertGt(bookedUpkeep, bookedCollectFirst, "B: performUpkeep over-books vs the draw-time-set split");
        // ...and that extra profit is withdrawable while the fund is genuinely below the reserve (net fund loss).
        assertGt(claimUpkeep, claimCollectFirst, "B: upkeep order lets the creator withdraw strictly more while short");
    }
}
