// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {AddendumBase} from "../lane_a/addendum/AddendumBase.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";

/// Independent reproduction of lane B's AddendumBelowReserve claim (its own file could not be re-run: its harness
/// hardcodes deployCode("out/ShapePacks.sol/..."), a transient root-out artifact absent now; copying it into root out/
/// was denied by the sandbox). Here on lane A's real-coordinator harness: list shapes at the 10% MINIMUM markup
/// (per-listing share = 0), accrue proceeds while below reserve, then configure to 100% markup and collect. Because
/// each Item stores its own markupBps and _share reads it (configure never rewrites existing listings), the booked
/// profit must stay 0 -> no creator action moved fund money into profit via a markup change.
contract MarkupChangeBelowReserve is AddendumBase {
    function testMarkupChangeDoesNotOverbook() public {
        PoolBalancer b = newBalancer();
        // 5x0.01 shapes at the 10% minimum markup + one curated (needed for admission); fund, then pull to reserve.
        openPool(b, one(D_001, 5), 1000, 10 ether, 0.3 ether);
        uint256 bal = address(b).balance;
        uint256 reserve = b.requiredReserve();
        if (bal > reserve) {
            vm.prank(creator);
            b.claimSurplus(bal - reserve, creator);
        }
        // one unreconciled draw hitting a shape -> reserve inflated -> short regime, proceeds uncollected
        bool ok;
        for (uint256 w = 1; w <= 60 && !ok; ++w) {
            uint256 s = vm.snapshotState();
            drawReal(b, uint256(keccak256(abi.encode("mk", w))));
            if (b.pool().ownerProceeds() > 0 && fundVal(b) < b.requiredReserve()) ok = true;
            else vm.revertToState(s);
        }
        require(ok, "not short with proceeds");

        // Honest baseline: collect now (all listings at 10% -> share 0 -> profit 0).
        uint256 snap = vm.snapshotState();
        b.collectProceeds();
        uint256 honest = b.profit();
        vm.revertToState(snap);

        // Attack: raise markup to 100%, then collect the SAME pre-existing proceeds.
        uint256 tgt = b.target();
        vm.prank(creator);
        b.configure(10000, tgt);
        b.collectProceeds();
        uint256 acted = b.profit();

        console.log("honest profit (10%)           :", honest);
        console.log("acted  profit (configure 100%):", acted);
        assertEq(honest, 0, "baseline: min-markup proceeds book no profit");
        assertEq(acted, 0, "CHALLENGE: markup change must not book pre-existing proceeds as profit");
    }
}
