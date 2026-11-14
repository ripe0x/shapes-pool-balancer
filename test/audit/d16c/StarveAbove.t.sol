// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {D16bWorstUpkeepTest} from "../d16b/WorstUpkeepB.t.sol";

/// @notice Hostile build where processAcquisitions(2) needs more than the 2,953,125 gas forwarded at g = 3,000,000
///         (d16b _build with 976 or 464 pad listings). Closed pool, so a failed processing leaves no restock to run out
///         of gas on. Requirement (D16 re-attack 3, finding 1): no limit, at any pool size, succeeds with processing
///         starved (on 1dcddf2, 133 to 163 limits from 3,081,000 did, and the estimate landed on them).
contract D16cStarveAboveTest is D16bWorstUpkeepTest {
    function _sweep(uint256 pad, uint256 basefee, uint256 bid) internal {
        _build(pad);
        vm.prank(creator);
        balancer.close();
        _setGas(basefee, bid);
        uint256 starved;
        uint256 lowestOk = type(uint256).max;
        for (uint256 G = 1_500_000; G <= 4_200_000; G += 2_000) {
            uint256 snap = vm.snapshotState();
            uint256 before = keeper.balance;
            uint256 u = pool.unsettledAcquisitionCount();
            vm.prank(keeper, keeper);
            (bool ok,) = address(balancer).call{gas: G}(abi.encodeWithSignature("performUpkeep()"));
            (, bytes memory r) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
            (, uint64 used,,,) = abi.decode(r, (uint64, uint64, uint64, int64, uint64));
            bool processed = pool.unsettledAcquisitionCount() < u;
            uint256 paid = keeper.balance - before;
            vm.revertToState(snap);
            if (ok && G < lowestOk) lowestOk = G;
            if (ok && !processed) {
                if (starved < 3 || G % 25_000 == 0) {
                    uint256 cost = (uint256(used) + 21_000) * bid;
                    emit log_string(string.concat(
                        "STARVED G=", vm.toString(G), " billedGas=", vm.toString(uint256(used) + 21_000),
                        " paidWei=", vm.toString(paid), " costWei=", vm.toString(cost),
                        " keeperNetWei=", vm.toString(int256(paid) - int256(cost))
                    ));
                }
                ++starved;
            }
        }
        emit log_named_uint("lowest succeeding limit (2k steps)", lowestOk);
        emit log_named_uint("succeeding limits with processing starved", starved);
        assertEq(starved, 0, "no limit succeeds with processing starved");
    }

    function test_starveAbove_pad976_5gwei() public {
        _sweep(976, 4.95 gwei, 5 gwei);
    }

    function test_starveAbove_pad0_5gwei() public {
        _sweep(0, 4.95 gwei, 5 gwei);
    }

    function test_starveAbove_pad464_5gwei() public {
        _sweep(464, 4.95 gwei, 5 gwei);
    }
}
