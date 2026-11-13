// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {AddendumBase} from "../lane_a/addendum/AddendumBase.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {IFWAPool} from "../../../src/interfaces/External.sol";

/// Item 1: size of the M9 split leak at launch scale, on the packet's Balanced mix (20x0.01, 10x0.05, 2x0.1,
/// 1x0.5 Shape, 7x0.02 packs, one 0.3 ETH NFT, 15% markup), in a genuine shortfall.
///
/// `_collect` books `mine = amount * profitShareSum / (n * 1e18)` while the fund < reserve, n = activeIds.length.
/// Variant (b): `performUpkeep` reconciles the drawn listing first (drops it from the set and from profitShareSum),
/// then collects over n-1, S - s_d. Variant (a): the creator `withdrawCurated` (NFT share 0) before collecting,
/// collecting over n-1, S unchanged.
///   variant (b) per-event, drawn share s_d:  amount*(S - n*s_d)/(n*(n-1)*1e18)   (holding short)
///   variant (a) per-event, curated (s=0):    amount*S          /(n*(n-1)*1e18)
///
/// `amount` is the EV draw price the player paid (constant per draw, independent of which listing is won: observed
/// 0.0201 ETH while the drawn NFT was priced 0.345). Forcing a 0.5 or NFT draw at launch weighting is infeasible
/// (<1.5% each), so the NFT/0.01/0.5 outcomes are computed from the formula with the board's real listed prices and
/// the core split is validated against the fork on a real Shape draw.
contract M9LaunchScaleTest is AddendumBase {
    uint8 constant CURATED = 1;

    uint256 gAmount;
    uint256 gS;
    uint256 gN;

    function upkeepN(PoolBalancer b, uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            vm.prank(keeper);
            try b.performUpkeep() {} catch { break; }
            if (!b.creatorWork()) break;
        }
    }

    function _share(PoolBalancer b, uint256 lid) internal view returns (uint256) {
        (uint8 kind, uint8 denom,,, uint112 price) = b.items(lid);
        if (kind == CURATED) return 0;
        return b.denominationAmount(denom) * (1500 - 1000) * 1e18 / (10_000 * uint256(price));
    }

    function _stock(PoolBalancer b) internal {
        uint256 target = one(D_001, 20) | one(1, 10) | one(2, 2) | one(D_05, 1) | one(D_002, 7);
        vm.prank(creator);
        b.configure(1500, target);
        vm.deal(address(b), 8 ether);
        vm.prank(creator);
        b.open();
        upkeepN(b, 40);
        listNewCurated(b, 0.3 ether);
        upkeepN(b, 40);
        require(b.admissionStatus() == 0, "not fully stocked/admitting");
        uint256 bal = address(b).balance;
        uint256 res = b.requiredReserve();
        if (bal > res) {
            vm.prank(creator);
            b.claimSurplus(bal - res, creator);
        }
    }

    /// Settle one draw (not reconciled) that drew a Shape, leaving a genuine shortfall with the NFT still listed.
    function _drawShape(PoolBalancer b) internal {
        uint256 baseState = vm.snapshotState();
        for (uint256 w = 1; w <= 20; ++w) {
            vm.revertToState(baseState);
            uint256 req = acquireOnly(b);
            fulfillReq(req, uint256(keccak256(abi.encode("m9", w))));
            uint256 rid = b.pool().requestIdAtSequence(b.reconciledSequence() + 1);
            (,,, uint256 lid,,) = b.pool().acquisitions(rid);
            (uint8 k,,,,) = b.items(lid);
            if (k != CURATED) return;
        }
        revert("no shape draw found");
    }

    function _drawnListing(PoolBalancer b) internal view returns (uint256 lid) {
        uint256 rid = b.pool().requestIdAtSequence(b.reconciledSequence() + 1);
        (,,, lid,,) = b.pool().acquisitions(rid);
    }

    function testM9LaunchScaleSplitLeak() public {
        PoolBalancer b = newBalancer();
        _stock(b);
        _drawShape(b);
        assertEq(b.pool().unsettledAcquisitionCount(), 0, "settled on FWA");

        gN = b.getActiveIds().length;
        gS = b.profitShareSum();
        gAmount = b.pool().ownerProceeds();
        {
            uint256 fund = address(b).balance - b.profit();
            uint256 reserve = b.requiredReserve();
            require(fund < reserve, "not genuinely short");
            console.log("n / profitShareSum:", gN, gS);
            console.log("amount (EV draw proceeds, wei):", gAmount);
            console.log("fund / reserve (short):", fund, reserve);
        }

        _validateCoreSplit(b);
        _variantB(b);
        _variantA(b);

        (uint256 nftLid, uint256 shapeLid, uint256 bigLid) = _representatives(b);
        _reportOutcome(b, "NFT (0.3) drawn", nftLid);
        _reportOutcome(b, "0.01 Shape drawn", shapeLid);
        _reportOutcome(b, "0.5 Shape drawn", bigLid);
        _reportExpectation(b);
    }

    function _validateCoreSplit(PoolBalancer b) internal {
        uint256 p0 = b.profit();
        uint256 snap = vm.snapshotState();
        b.collectProceeds();
        uint256 booked = b.profit() - p0;
        uint256 predicted = gAmount * gS / (gN * 1e18);
        console.log("collect-first booked / predicted amount*S/(n*1e18):", booked, predicted);
        assertEq(booked, predicted, "core _collect split formula matches fork");
        vm.revertToState(snap);
    }

    /// Variant (b): performUpkeep reconciles the drawn Shape first. At launch scale a single draw's reconcile also
    /// drops that draw's reserve term, which can clear the shortfall; the per-event order effect (holding short) is
    /// the formula reported per outcome below. Here we log what upkeep actually books vs the collect-first baseline.
    function _variantB(PoolBalancer b) internal {
        uint256 p0 = b.profit();
        uint256 snap = vm.snapshotState();
        b.collectProceeds();
        uint256 baseline = b.profit() - p0;
        vm.revertToState(snap);
        snap = vm.snapshotState();
        vm.prank(keeper);
        b.performUpkeep();
        uint256 viaUpkeep = b.profit() - p0;
        console.log("variant(b) collect-first baseline / via performUpkeep:", baseline, viaUpkeep);
        console.log("  (upkeep reconciles the drawn draw, dropping its reserve term; here the single draw's");
        console.log("   reconcile clears the short, so upkeep books less -> fund-favourable at this depth)");
        vm.revertToState(snap);
    }

    /// Variant (a): creator withdrawCurated(NFT) before collecting. No reconcile -> stays short in both branches.
    function _variantA(PoolBalancer b) internal {
        uint256[] memory cur = _curatedIds(b);
        require(cur.length == 1, "expect one curated");
        uint256 p0 = b.profit();
        uint256 snap = vm.snapshotState();
        b.collectProceeds();
        uint256 honest = b.profit() - p0;
        vm.revertToState(snap);
        snap = vm.snapshotState();
        uint256 g = gasleft();
        vm.prank(creator);
        b.withdrawCurated(cur[0], creator);
        uint256 gasWithdraw = g - gasleft();
        b.collectProceeds();
        uint256 attack = b.profit() - p0;
        uint256 formula = gAmount * gS / (gN * (gN - 1) * 1e18);
        console.log("variant(a) honest / withdraw-then-collect:", honest, attack);
        console.log("  variant(a) leak measured / formula (wei):", attack - honest, formula);
        console.log("  variant(a) creator withdrawCurated gas:", gasWithdraw);
        vm.revertToState(snap);
    }

    function _reportOutcome(PoolBalancer b, string memory label, uint256 lid) internal view {
        uint256 s = _share(b, lid);
        int256 leak = int256(gAmount) * (int256(gS) - int256(gN * s)) / int256(gN * (gN - 1) * 1e18);
        (,,,, uint112 price) = b.items(lid);
        console.log(label);
        console.log("  listed price / share:", uint256(price), s);
        _emitSigned("  variant(b) per-event misbooking, holding short (wei)", leak);
    }

    function _reportExpectation(PoolBalancer b) internal view {
        uint256[] memory ids = b.getActiveIds();
        int256 num;
        uint256 den;
        for (uint256 i; i < ids.length; ++i) {
            (,,,, uint112 price) = b.items(ids[i]);
            if (price == 0) continue;
            uint256 w = 1e36 / uint256(price);
            uint256 s = _share(b, ids[i]);
            int256 leak = int256(gAmount) * (int256(gS) - int256(gN * s)) / int256(gN * (gN - 1) * 1e18);
            num += int256(w) * leak;
            den += w;
        }
        _emitSigned("E[variant(b) per-event misbooking] over draw outcomes (wei)", num / int256(den));
        console.log("  (+ = over-books fund money as profit on average; ~0 = unbiased)");
    }

    function _representatives(PoolBalancer b) internal view returns (uint256 nftLid, uint256 shapeLid, uint256 bigLid) {
        uint256[] memory ids = b.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 denom,,,) = b.items(ids[i]);
            if (kind == CURATED) nftLid = ids[i];
            else if (denom == D_001 && shapeLid == 0) shapeLid = ids[i];
            else if (denom == D_05) bigLid = ids[i];
        }
        require(nftLid != 0 && shapeLid != 0 && bigLid != 0, "missing representative");
    }

    function _curatedIds(PoolBalancer b) internal view returns (uint256[] memory out) {
        uint256[] memory a = b.getActiveIds();
        uint256 c;
        uint256[] memory tmp = new uint256[](a.length);
        for (uint256 i; i < a.length; ++i) {
            (uint8 k,, uint8 st,,) = b.items(a[i]);
            if (k == CURATED && st == 1) tmp[c++] = a[i];
        }
        out = new uint256[](c);
        for (uint256 i; i < c; ++i) out[i] = tmp[i];
    }

    function _emitSigned(string memory label, int256 v) internal pure {
        if (v < 0) console.log(string.concat(label, " = -"), uint256(-v));
        else console.log(string.concat(label, " = +"), uint256(v));
    }
}
