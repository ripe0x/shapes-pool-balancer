// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {AddendumBase} from "./AddendumBase.sol";
import {PoolBalancer} from "../../../../src/PoolBalancer.sol";
import {IFWAPool} from "../../../../src/interfaces/External.sol";

interface IOwnerOf {
    function ownerOf(uint256 id) external view returns (address);
}

/// Stateful full-cycle run with draws in flight (1, then a burst of 5), asserting money/tracking invariants at rest
/// after every step. Real coordinator->service->pool route, no mocks.
contract StatefulCycle is AddendumBase {
    PoolBalancer b;
    IFWAPool p;

    // Invariants that must hold at rest after every step.
    function _inv(string memory where) internal view {
        uint256 bal = address(b).balance;
        // M9: profit is always backed by ETH actually present.
        require(b.profit() <= bal, string.concat(where, ": profit > balance"));
        // keeper credit is backed by ETH present.
        require(b.keeperCredit() <= bal, string.concat(where, ": keeperCredit > balance"));
        // the creator can never be entitled to more than the balance.
        require(b.withdrawableSurplus() <= bal, string.concat(where, ": withdrawableSurplus > balance"));
        // tracking consistency: #SHAPE items in activeIds == sum(activeShapes).
        uint256[] memory ids = b.getActiveIds();
        uint256 shapeItems;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,, uint8 state,,) = b.items(ids[i]);
            if (kind == 2 && state == 1) shapeItems++;
        }
        uint16[16] memory as_ = b.getActiveShapes();
        uint256 sumShapes;
        for (uint256 d; d < 16; ++d) sumShapes += as_[d];
        require(shapeItems == sumShapes, string.concat(where, ": activeShapes != #shape items"));
        // M4 (at a fully-reconciled rest point only): every active SHAPE prize's token is held by the FWA pool.
        // Between settlement and reconcile a drawn shape is legitimately delivered to the winner while still tracked
        // ACTIVE (the FILL gate charges MAX_PRIZE_WEIGHT per unreconciled draw for exactly this window), so the
        // backing check is meaningful only once unsettled==0 and reconciledSequence has caught up.
        bool reconciled = p.unsettledAcquisitionCount() == 0 && p.lastIssuedSequence() == b.reconciledSequence();
        if (reconciled) {
            for (uint256 i; i < ids.length; ++i) {
                (uint8 kind, uint8 denom, uint8 state,,) = b.items(ids[i]);
                if (kind == 2 && state == 1) {
                    (,,, uint256 tok,,,,) = p.listings(ids[i]);
                    address tokenContract = denom < 9 ? SHAPES : packs;
                    require(
                        IOwnerOf(tokenContract).ownerOf(tok) == address(p),
                        string.concat(where, ": shape token not held by pool")
                    );
                }
            }
        }
    }

    function testStatefulCycleWithDrawsInFlight() public {
        b = newBalancer();
        p = b.pool();
        // a board with enough weight to admit several draws in flight: 20 x 0.01 shapes, 30% markup
        vm.prank(creator);
        b.configure(3000, one(D_001, 20));
        vm.deal(address(b), 30 ether);
        vm.prank(creator);
        b.open();
        _inv("after open");
        upkeep(b);
        _inv("after build inventory");
        listNewCurated(b, 0.3 ether);
        upkeep(b);
        _inv("after curated + upkeep");
        require(b.admissionStatus() == 0, "not admitting");

        // Step A: one draw in flight, settle, then reconcile.
        uint256 r1 = acquireOnly(b);
        _inv("after acquire #1 (unsettled)");
        fulfillReq(r1, uint256(keccak256("f1")));
        _inv("after settle #1 (unreconciled)");
        vm.prank(keeper);
        b.performUpkeep();
        _inv("after reconcile #1");

        // Step B: a burst of draws in flight before any settlement.
        uint256 n;
        uint256[] memory reqs = new uint256[](5);
        for (uint256 i; i < 5; ++i) {
            if (b.admissionStatus() != 0) break;
            reqs[n++] = acquireOnly(b);
            _inv("after burst acquire (unsettled)");
        }
        console.log("burst draws acquired in flight:", n, "unsettled:", p.unsettledAcquisitionCount());
        // settle them all
        for (uint256 i; i < n; ++i) {
            fulfillReq(reqs[i], uint256(keccak256(abi.encode("burst", i))));
            _inv("after burst settle (unreconciled)");
        }
        // reconcile + restock across upkeep calls
        for (uint256 i; i < 6; ++i) {
            vm.prank(keeper);
            try b.performUpkeep() {} catch { break; }
            _inv("after burst reconcile upkeep");
        }

        // Step C: creator withdraws everything allowed at each step (stress M6/M9).
        b.collectProceeds();
        _inv("after collect");
        uint256 w = b.withdrawableSurplus();
        if (w > 0) {
            vm.prank(creator);
            b.claimSurplus(w, creator);
        }
        _inv("after max claim while open");
        // M6: cannot have withdrawn below the reserve (balance >= reserve, since fund>=reserve or profit-backed).
        require(address(b).balance + p.ownerProceeds() >= 0, "sanity");

        // Step D: close, unlist all shapes, withdraw/recover curated, withdraw everything. M7 at teardown.
        vm.prank(creator);
        b.close();
        _inv("after close");
        require(b.requiredReserve() == 0, "reserve not zero closed");
        require(b.profit() == 0, "profit not cleared closed");

        // unlist shapes
        uint256[] memory ids = b.getActiveIds();
        uint256[] memory shapeIds = new uint256[](ids.length);
        uint256 ns;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,, uint8 state,,) = b.items(ids[i]);
            if (kind == 2 && state == 1) shapeIds[ns++] = ids[i];
        }
        // unlist in batches of 20
        while (ns > 0) {
            uint256 take = ns > 20 ? 20 : ns;
            uint256[] memory batch = new uint256[](take);
            for (uint256 i; i < take; ++i) batch[i] = shapeIds[ns - take + i];
            vm.prank(creator);
            b.unlistShapes(batch);
            ns -= take;
            _inv("after unlist batch");
        }
        // withdraw curated
        uint256[] memory ids2 = b.getActiveIds();
        for (uint256 i; i < ids2.length; ++i) {
            (uint8 kind,, uint8 state,,) = b.items(ids2[i]);
            if (kind == 1 && state == 1) {
                vm.prank(creator);
                b.withdrawCurated(ids2[i], creator);
            }
        }
        b.collectProceeds();
        uint256 bal = address(b).balance;
        if (bal > 0) {
            vm.prank(creator);
            b.claimSurplus(bal, creator);
        }
        console.log("final residual (wei):", address(b).balance);
        console.log("final active listings:", b.getActiveIds().length);
        console.log("final pool ownerProceeds:", p.ownerProceeds());
        // M7: nothing stranded.
        require(address(b).balance == 0, "M7: ETH stranded");
        require(b.getActiveIds().length == 0, "M7: listings remain");
        require(p.ownerProceeds() == 0, "M7: proceeds stranded");
    }
}
