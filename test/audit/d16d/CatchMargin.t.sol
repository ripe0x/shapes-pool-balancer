// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {D16bWorstUpkeepTest} from "../d16b/WorstUpkeepB.t.sol";

interface IProcess {
    function processAcquisitions(uint256 maxCount) external returns (uint256);
    function unsettledAcquisitionCount() external view returns (uint256);
}

/// @notice Replays the Balancer's step-0 catch against FWA directly and reports what a failed processing hands back
///         beyond the caller's 1/64 (`h`). The repair judges h < 400,000 as starved.
contract CatchProbe {
    function run(address pool) external returns (bool ok, uint256 h, uint256 g) {
        g = gasleft();
        try IProcess(pool).processAcquisitions(2) returns (uint256) {
            ok = true;
        } catch {
            uint256 left = gasleft();
            h = left > g / 64 ? left - g / 64 : 0;
        }
    }
}

/// @notice D16 re-attack 4. Hostile build of d16b (5 draws to reconcile, 2 ready draws that each reserved six listings
///         of a collection burning the notifier's probes and callback), at pool sizes whose reserved activations land
///         on fresh 1024- and 2048-slot tree boundaries.
contract D16dCatchMarginTest is D16bWorstUpkeepTest {
    CatchProbe probe;

    /// @dev Every failure in [lo, hi] at `step`: largest h, and failures judged "not gas" (h >= 400k).
    function _probeSweep(uint256 lo, uint256 hi, uint256 step) internal returns (uint256 maxH, uint256 notGas, uint256 leastOk) {
        leastOk = type(uint256).max;
        for (uint256 G = lo; G <= hi; G += step) {
            uint256 snap = vm.snapshotState();
            (bool ok, uint256 h,) = probe.run{gas: G}(address(pool));
            bool done = IProcess(address(pool)).unsettledAcquisitionCount() == 0;
            vm.revertToState(snap);
            if (ok) {
                assertTrue(done, "a returning processAcquisitions(2) settled both draws");
                if (G < leastOk) leastOk = G;
            } else {
                if (h > maxH) maxH = h;
                if (h >= 400_000) ++notGas;
            }
        }
    }

    function _leastUpkeep() internal returns (uint256 hi) {
        uint256 lo = 21_000;
        hi = 30_000_000;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            vm.prank(keeper, keeper);
            (bool ok,) = address(balancer).call{gas: mid}(abi.encodeWithSignature("performUpkeep()"));
            vm.revertToState(snap);
            if (ok) hi = mid;
            else lo = mid;
        }
    }

    function _run(uint256 pad, uint256 basefee, uint256 bid) internal {
        _build(pad);
        _setGas(basefee, bid);
        probe = new CatchProbe();

        (uint256 maxH, uint256 notGas, uint256 leastOk) = _probeSweep(200_000, 4_500_000, 1_000);
        emit log_named_uint("coarse: largest h on a failure", maxH);
        emit log_named_uint("coarse: least returning probe gas", leastOk);
        assertEq(notGas, 0, "no starved failure hands back 400k");
        assertLt(leastOk, type(uint256).max, "reached: processing returns at some limit");
        (uint256 maxH2, uint256 notGas2,) = _probeSweep(leastOk - 3_000, leastOk + 200, 10);
        emit log_named_uint("fine: largest h on a failure", maxH2);
        assertEq(notGas2, 0, "no starved failure hands back 400k (fine)");

        // Whole upkeep: least succeeding limit vs the keeper's 4M floor, then the keeper's pay at the floor.
        uint256 L = _leastUpkeep();
        emit log_named_uint("least succeeding performUpkeep limit", L);
        assertLe(L, 4_000_000, "the keeper's 4M floor covers the worst upkeep");

        uint256 before = keeper.balance;
        vm.prank(keeper, keeper);
        (bool ok,) = address(balancer).call{gas: 4_000_000}(abi.encodeWithSignature("performUpkeep()"));
        (, bytes memory r) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        (, uint64 used,, int64 refunded,) = abi.decode(r, (uint64, uint64, uint64, int64, uint64));
        assertTrue(ok, "4M succeeds");
        assertEq(IProcess(address(pool)).unsettledAcquisitionCount(), 0, "processed both");
        uint256 paid = keeper.balance - before;
        // Billed: execution gas after refunds + intrinsic 21,000 + 4 calldata bytes (64).
        uint256 billed = uint256(used) + 21_064;
        uint256 cost = billed * bid;
        emit log_named_int("refunded", refunded);
        emit log_named_uint("billed gas", billed);
        emit log_named_uint("paid wei", paid);
        emit log_named_uint("cost wei", cost);
        emit log_named_int("keeper net wei", int256(paid) - int256(cost));
        assertGe(paid, cost, "the keeper's billed gas is covered");
    }

    function test_margin_pad0_5gwei() public {
        _run(0, 4.95 gwei, 5 gwei);
    }

    function test_margin_pad976_5gwei() public {
        _run(976, 4.95 gwei, 5 gwei);
    }

    function test_margin_pad976_055gwei() public {
        _run(976, 0.5 gwei, 0.55 gwei);
    }

    /// @dev Reserved activations on the fresh 2048-slot boundary: one more zero-to-nonzero tree level per draw.
    function test_margin_pad2000_5gwei() public {
        _run(2000, 4.95 gwei, 5 gwei);
    }
}

/// @dev Which failure hands back the largest h? Finds its limit, then replays it alone (run with -vvvv on test_trace).
contract D16dCatchWhichTest is D16dCatchMarginTest {
    function _argmax(uint256 lo, uint256 hi, uint256 step) internal returns (uint256 at, uint256 maxH) {
        for (uint256 G = lo; G <= hi; G += step) {
            uint256 snap = vm.snapshotState();
            (bool ok, uint256 h,) = probe.run{gas: G}(address(pool));
            vm.revertToState(snap);
            if (!ok && h > maxH) (maxH, at) = (h, G);
        }
    }

    function test_which_pad0() public {
        _build(0);
        _setGas(4.95 gwei, 5 gwei);
        probe = new CatchProbe();
        (uint256 at, uint256 maxH) = _argmax(200_000, 3_000_000, 1_000);
        (at, maxH) = _argmax(at - 1_000, at + 1_000, 1);
        emit log_named_uint("argmax G", at);
        emit log_named_uint("max h", maxH);
        // h by limit across the window below the least returning limit, every 2k
        for (uint256 G = 2_900_000; G < 2_962_000; G += 2_000) {
            uint256 snap = vm.snapshotState();
            (bool ok, uint256 h,) = probe.run{gas: G}(address(pool));
            vm.revertToState(snap);
            emit log_string(string.concat("G=", vm.toString(G), " ok=", ok ? "1" : "0", " h=", vm.toString(h)));
        }
    }
}

contract D16dCatchTraceTest is D16dCatchMarginTest {
    function test_trace_pad0() public {
        _build(0);
        _setGas(4.95 gwei, 5 gwei);
        probe = new CatchProbe();
        probe.run{gas: 2_958_000}(address(pool));
    }
}

/// @dev Through the Balancer, pool left open (a catch that continued would restock): no limit succeeds with processing
///      starved, at the 2048-slot boundary, coarse and around the least succeeding limit.
contract D16dOpenSweepTest is D16dCatchMarginTest {
    function _upkeepSweep(uint256 lo, uint256 hi, uint256 step) internal returns (uint256 oks) {
        for (uint256 G = lo; G <= hi; G += step) {
            uint256 snap = vm.snapshotState();
            vm.prank(keeper, keeper);
            (bool ok,) = address(balancer).call{gas: G}(abi.encodeWithSignature("performUpkeep()"));
            bool done = IProcess(address(pool)).unsettledAcquisitionCount() == 0;
            vm.revertToState(snap);
            if (ok) ++oks;
            assertTrue(!ok || done, "no limit succeeds with processing starved");
        }
    }

    function test_open_pad2000() public {
        _build(2000);
        _setGas(0.5 gwei, 0.55 gwei);
        uint256 L = _leastUpkeep();
        emit log_named_uint("least succeeding limit", L);
        emit log_named_uint("coarse oks", _upkeepSweep(1_000_000, 4_500_000, 2_000));
        emit log_named_uint("fine oks", _upkeepSweep(L - 20_000, L + 5_000, 50));
    }
}
