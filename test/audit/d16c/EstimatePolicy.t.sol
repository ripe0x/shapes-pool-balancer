// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {D16NaturalReservedTest} from "../d16/NaturalReserved.t.sol";
import {IFwaExtra} from "../d16/WorstUpkeep.t.sol";

/// @notice D16 re-attack 3, finding 3: for upkeeps that process FWA's queue, eth_estimateGas (the least limit that
///         succeeds) is 0.37M-0.48M above the gas billed, so pricing the call at the estimate made keeper.ts skip
///         profitable work from about 1.45 gwei. keeper.ts `decide` now prices it at the gas the simulated reward pays
///         for when that reward is cut neither by KEEPER_MAX_GAS nor by the Balancer's balance (billed gas never
///         exceeds it). Requirement: the policy sends every call whose reward covers its billed gas, and none that
///         does not. Ordinary play (the launch board, the Balancer's own staged restocks reserved by in-flight draws).
contract D16cEstimatePolicyTest is D16NaturalReservedTest {
    uint256 constant MAX_LOSS = 2e14;
    uint256 constant PRIO = 0.05 gwei;

    function _call(uint256 G) internal returns (bool ok, uint256 reward, uint256 billed, bool processed) {
        uint256 snap = vm.snapshotState();
        uint256 u = pool.unsettledAcquisitionCount();
        vm.prank(keeper, keeper);
        bytes memory ret;
        (ok, ret) = address(balancer).call{gas: G}(abi.encodeWithSignature("performUpkeep()"));
        if (ok) reward = abi.decode(ret, (uint256));
        (, bytes memory r) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        (, uint64 used,,,) = abi.decode(r, (uint64, uint64, uint64, int64, uint64));
        billed = uint256(used) + 21_064;
        processed = pool.unsettledAcquisitionCount() < u;
        vm.revertToState(snap);
    }

    function _least(uint256 hi) internal returns (uint256) {
        uint256 lo = 21_000;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            (bool ok,,,) = _call(mid);
            if (ok) hi = mid;
            else lo = mid;
        }
        return hi;
    }

    function _policy(string memory label) internal {
        uint256[4] memory fees = [uint256(0.3 gwei), 1 gwei, 2 gwei, 4.95 gwei];
        for (uint256 i; i < 4; ++i) {
            _setGas(fees[i], fees[i] + PRIO);
            (bool okHi, uint256 reward, uint256 billed, bool pHi) = _call(30_000_000);
            assertTrue(okHi && pHi, "processes at a high limit");
            uint256 G = _least(30_000_000);
            (, , , bool pLeast) = _call(G);
            uint256 estimate = G + 21_064; // calldata: 4 nonzero bytes
            // keeper.ts decide()
            uint256 price = fees[i] + PRIO;
            uint256 reimbursed = price < 5 gwei ? price : 5 gwei;
            uint256 gas = estimate;
            if (reward < address(balancer).balance && reward > 0.0001 ether) {
                uint256 paidGas = (reward - 0.0001 ether) / reimbursed;
                if (paidGas < 3_250_000 && paidGas < gas) gas = paidGas;
            }
            uint256 cost = gas * price;
            bool send = reward + MAX_LOSS >= cost;
            int256 margin = int256(reward) - int256(billed * price);
            if (margin >= 0) assertTrue(send, "the keeper sends a call whose reward covers its billed gas");
            if (send) assertGe(int256(reward + MAX_LOSS), int256(billed * price), "and never one it would lose on");
            emit log_string(string.concat(
                label, " basefee=", vm.toString(fees[i]), " estimate=", vm.toString(estimate), " billed=",
                vm.toString(billed), " reward=", vm.toString(reward), " policyCost=", vm.toString(cost),
                " realMargin=", vm.toString(int256(reward) - int256(billed * (fees[i] + PRIO))),
                " leastProcesses=", pLeast ? "1" : "0", " keeperSends=", send ? "1" : "0"
            ));
        }
    }

    function _toTwoReady(bool both) internal {
        _setGas(0.5 gwei, 0.55 gwei);
        _launchBoard();
        uint256[4] memory r;
        for (uint256 i; i < 4; ++i) r[i] = buy(i % 2 == 0 ? buyer : stranger, 1)[0];
        for (uint256 i; i < 3; ++i) fulfill(r[i], _wordWinningPack(r[i], 1, abi.encode("n", i)));
        _keeperUntilIdle();
        uint256 e = buy(buyer, 1)[0];
        fulfill(r[3], _wordWinningPack(r[3], 1, "n3"));
        _keeperUntilIdle();
        uint256 f = buy(stranger, 1)[0];
        assertGt(IFwaExtra(address(pool)).reservedListingCount(pool.lastIssuedSequence()), 0, "f reserved restocks");
        fulfill(e, _wordWinningPack(e, 1, "e"));
        if (both) fulfill(f, _wordWinningPack(f, 2, "f"));
    }

    function test_policy_naturalTwoReady() public {
        _toTwoReady(true);
        assertEq(pool.unsettledAcquisitionCount(), 2);
        _policy("two ready:");
    }

    function test_policy_naturalOneReady() public {
        _toTwoReady(false);
        assertEq(pool.unsettledAcquisitionCount(), 2);
        _policy("one ready, one pending:");
    }
}
