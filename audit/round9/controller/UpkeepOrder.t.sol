// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {AddendumBase} from "../lane_a/addendum/AddendumBase.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {IFWAPool} from "../../../src/interfaces/External.sol";

interface IOwnerOf {
    function ownerOf(uint256) external view returns (address);
}

/// Controller check (informed). The split is meant to be an expected value per draw: owner proceeds per draw are
/// FWA's EV price n / sum(1/p), and amount * profitShareSum / n equals the expected markup above 10% when the split set
/// is the set the draw was priced on. `collectProceeds` before reconciliation uses that set. `performUpkeep`
/// reconciles first, removing the drawn listing, then collects: the same proceeds are split over n - 1 listings.
/// This measures both orders on the same settled draw, through the real coordinator -> VRF service route.
contract UpkeepOrderTest is AddendumBase {
    function _setup() internal returns (PoolBalancer b, uint256 curTokenId) {
        b = newBalancer();
        uint256 cid = openPool(b, one(D_001, 5), 3000, 10 ether, 0.3 ether);
        uint256 bal = address(b).balance;
        uint256 reserve = b.requiredReserve();
        if (bal > reserve) {
            vm.prank(creator);
            b.claimSurplus(bal - reserve, creator);
        }
        (,,, curTokenId,,,,) = b.pool().listings(cid);
    }

    function _compare(PoolBalancer b, string memory label) internal {
        uint256 n = b.getActiveIds().length;
        uint256 fundV = address(b).balance - b.profit();
        uint256 req = b.requiredReserve();
        require(b.pool().ownerProceeds() > 0, "no proceeds");
        require(fundV < req, "fund not short");
        uint256 p0 = b.profit();
        uint256 snap = vm.snapshotState();
        b.collectProceeds();
        uint256 expected = b.profit() - p0;
        uint256 claimA = b.withdrawableSurplus();
        // Same state, then reconcile: what can the creator claim once the draw is recorded?
        vm.prank(keeper);
        try b.performUpkeep() {} catch {}
        uint256 claimA2 = b.withdrawableSurplus();
        uint256 fundA2 = address(b).balance - b.profit();
        uint256 reqA2 = b.requiredReserve();
        vm.revertToState(snap);
        vm.prank(keeper);
        b.performUpkeep();
        uint256 viaUpkeep = b.profit() - p0;
        uint256 claimB = b.withdrawableSurplus();
        uint256 fundB = address(b).balance - b.profit();
        uint256 reqB = b.requiredReserve();
        console.log(label);
        console.log("  listings in split set before reconcile:", n);
        console.log("  profit booked, collect first (draw-time set):", expected);
        console.log("  profit booked, upkeep (reconcile then collect):", viaUpkeep);
        console.log("  claimable after collect first:", claimA);
        console.log("  claimable after collect first, then upkeep:", claimA2);
        console.log("  fund / reserve after collect first + upkeep:", fundA2, reqA2);
        console.log("  claimable after upkeep only:", claimB);
        console.log("  fund / reserve after upkeep only:", fundB, reqB);
        assertGt(expected, 0, "profit flows while short");
    }

    /// The NFT is drawn: removing it (share 0) first raises the average share, so upkeep books more than expected.
    function testCuratedDrawUpkeepBooksMoreThanExpected() public {
        (PoolBalancer b, uint256 tok) = _setup();
        bool hit;
        for (uint256 w = 1; w <= 120 && !hit; ++w) {
            uint256 s = vm.snapshotState();
            drawReal(b, uint256(keccak256(abi.encode("cur", w))));
            if (IOwnerOf(address(nft)).ownerOf(tok) == player) hit = true;
            else vm.revertToState(s);
        }
        require(hit, "curated not drawn within 120 words");
        _compare(b, "curated NFT drawn");
    }

    /// A Shape is drawn: removing it first changes the average the other way or not at all.
    function testShapeDrawUpkeepOrder() public {
        (PoolBalancer b, uint256 tok) = _setup();
        bool hit;
        for (uint256 w = 1; w <= 120 && !hit; ++w) {
            uint256 s = vm.snapshotState();
            drawReal(b, uint256(keccak256(abi.encode("shape", w))));
            if (IOwnerOf(address(nft)).ownerOf(tok) != player) hit = true;
            else vm.revertToState(s);
        }
        require(hit, "shape not drawn within 120 words");
        _compare(b, "0.01 Shape drawn");
    }

    /// A real shortfall: a 0.5 Shape win spends the spare, then the NFT is drawn. Compare the profit the same NFT draw
    /// books when collected on the draw-time set with what upkeep books after reconciling first.
    function testCuratedDrawAfterBigWinUpkeepOrder() public {
        PoolBalancer b = newBalancer();
        uint256 cid = openPool(b, one(D_001, 5) | one(D_05, 1), 3000, 10 ether, 0.02 ether);
        (,,, uint256 tok,,,,) = b.pool().listings(cid);
        uint256 bal = address(b).balance;
        uint256 reserve = b.requiredReserve();
        if (bal > reserve) {
            vm.prank(creator);
            b.claimSurplus(bal - reserve, creator);
        }
        bool big;
        for (uint256 w = 1; w <= 200 && !big; ++w) {
            uint256 s = vm.snapshotState();
            drawReal(b, uint256(keccak256(abi.encode("big", w))));
            upkeep(b);
            if (b.getActiveShapes()[D_05] == 1 && address(b).balance + 0.4 ether < bal - (bal > reserve ? bal - reserve : 0)) big = true;
            else vm.revertToState(s);
        }
        require(big, "0.5 not drawn within 200 words");
        console.log("after big win: fund / reserve", address(b).balance - b.profit(), b.requiredReserve());
        bool hit;
        for (uint256 w = 1; w <= 120 && !hit; ++w) {
            uint256 s = vm.snapshotState();
            drawReal(b, uint256(keccak256(abi.encode("cur2", w))));
            if (IOwnerOf(address(nft)).ownerOf(tok) == player) hit = true;
            else vm.revertToState(s);
        }
        require(hit, "curated not drawn within 120 words");
        uint256 n = b.getActiveIds().length;
        uint256 p0 = b.profit();
        uint256 snap = vm.snapshotState();
        b.collectProceeds();
        uint256 a = b.profit() - p0;
        vm.prank(keeper);
        try b.performUpkeep() {} catch {}
        uint256 claimA = b.withdrawableSurplus();
        uint256 fundA = address(b).balance - b.profit();
        vm.revertToState(snap);
        vm.prank(keeper);
        b.performUpkeep();
        uint256 u = b.profit() - p0;
        uint256 claimU = b.withdrawableSurplus();
        uint256 fundU = address(b).balance - b.profit();
        console.log("NFT drawn while genuinely short; listings before reconcile:", n);
        console.log("  profit, collect first then upkeep:", a);
        console.log("  profit, upkeep only (reconcile then collect):", u);
        console.log("  claimable / fund, collect first then upkeep:", claimA, fundA);
        console.log("  claimable / fund, upkeep only:", claimU, fundU);
        console.log("  reserve after:", b.requiredReserve());
        assertGt(a, 0, "profit flows while short");
    }
}
