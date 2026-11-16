// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {D16bGasLimitWindowTest} from "../d16b/GasLimitWindow.t.sol";

/// @notice 100-gas sweeps around the least succeeding limit and around g = MIN_PROCESS_GAS, on d16b's build (one
///         fast-pathed draw to reconcile, two ready draws that each reserved six curated listings; hostile or honest).
///         _loop asserts: no success with a draw left unprocessed, and every success covers the keeper's billed gas.
contract D16cFineSweepTest is D16bGasLimitWindowTest {
    function _least() internal returns (uint256 hi) {
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
        emit log_named_uint("least succeeding call gas", hi);
    }

    function test_fine_hostile() public {
        _buildOne(true);
        uint256 L = _least();
        _loop(L - 10_000, L + 10_000, 100);
        _loop(2_990_000, 3_010_000, 100);
    }

    function test_fine_honest() public {
        _buildOne(false);
        uint256 L = _least();
        _loop(L - 10_000, L + 10_000, 100);
        _loop(2_990_000, 3_010_000, 100);
    }
}

/// @dev Which error ends the calls just under the least succeeding limit in the hostile build?
contract D16cWindowReasonTest is D16cFineSweepTest {
    function test_reason_hostile() public {
        _buildOne(true);
        uint256 L = _least();
        bytes4 last;
        for (uint256 G = 2_900_000; G < L; G += 1_000) {
            uint256 snap = vm.snapshotState();
            vm.prank(keeper, keeper);
            (bool ok, bytes memory ret) = address(balancer).call{gas: G}(abi.encodeWithSignature("performUpkeep()"));
            vm.revertToState(snap);
            assertFalse(ok);
            bytes4 sel = ret.length >= 4 ? bytes4(ret) : bytes4(0);
            if (sel != last) {
                emit log_string(string.concat("from G=", vm.toString(G), " revert selector=", vm.toString(abi.encodePacked(sel)), " len=", vm.toString(ret.length)));
                last = sel;
            }
        }
        emit log_named_bytes32("InsufficientGas selector", bytes32(bytes4(keccak256("InsufficientGas()"))));
    }
}

import {D16bWorstUpkeepTest} from "../d16b/WorstUpkeepB.t.sol";

/// @dev Least gas FWA's processAcquisitions(2) needs, called directly, in the hostile builds; against 63/64 of
///      MIN_PROCESS_GAS (what processing is forwarded when upkeep has exactly 3,000,000 left).
contract D16cProcessNeedTest is D16bWorstUpkeepTest {
    function _need() internal returns (uint256 hi, uint256 usedAtHi) {
        uint256 lo = 21_000;
        hi = 30_000_000;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            (bool ok,) = address(pool).call{gas: mid}(abi.encodeWithSignature("processAcquisitions(uint256)", 2));
            bool done = ok && pool.unsettledAcquisitionCount() == 0;
            vm.revertToState(snap);
            if (done) hi = mid;
            else lo = mid;
        }
        uint256 s = vm.snapshotState();
        uint256 g0 = gasleft();
        pool.processAcquisitions{gas: hi}(2);
        usedAtHi = g0 - gasleft();
        vm.revertToState(s);
        emit log_named_uint("least gas for processAcquisitions(2)", hi);
        emit log_named_uint("gas used by it (caller frame)", usedAtHi);
        emit log_named_uint("forwarded at g = 3,000,000 (63/64, before call overhead)", 3_000_000 - 3_000_000 / 64);
    }

    function test_need_pad0() public {
        _build(0);
        _need();
    }

    function test_need_pad464() public {
        _build(464);
        _need();
    }

    function test_need_pad976() public {
        _build(976);
        _need();
    }
}
