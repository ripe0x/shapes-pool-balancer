// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {D16bWorstUpkeepTest, ProbeHog} from "./WorstUpkeepB.t.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";

/// @notice F3 follow-on: emulate a gas estimator that takes the gas used at a high limit as its lower bound (geth's
///         eth_estimateGas: lo = used - 1, then tries used * 64/63). Closed pool, one fast-path draw unreconciled,
///         four draws that each reserved six honest curated listings, ready. Does a gas limit at or just above the
///         used gas starve processing while the call still succeeds (so an estimator would return it)?
contract D16bEstimateStarveTest is D16bWorstUpkeepTest {
    function _try(uint256 G) internal returns (bool ok, bool processed, uint256 paid, uint256 billed) {
        uint256 snap = vm.snapshotState();
        uint64 next = pool.nextSequenceToProcess();
        bytes32 uh1 = balancer.settingsHash();
        uint256 before = keeper.balance;
        vm.prank(keeper, keeper);
        (ok,) = address(balancer).call{gas: G}(abi.encodeWithSignature("performUpkeep(bytes32,uint256,uint256)", uh1, 0, 0));
        (, bytes memory r) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        (, uint64 used,,,) = abi.decode(r, (uint64, uint64, uint64, int64, uint64));
        billed = uint256(used);
        processed = pool.nextSequenceToProcess() != next;
        paid = keeper.balance - before;
        vm.revertToState(snap);
    }

    function test_estimateNeverLandsOnStarvedProcessing_closed_5gwei() public {
        _setGas(0.5 gwei, 0.55 gwei);
        hog = new ProbeHog();
        createBalancer(10 ether);
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1);
        vm.prank(creator);
        balancer.configure(2500, plan16(c));
        listCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256 r0 = buy(buyer, 1)[0];
        _listHogs(20, 100);
        _listHogs(4, 200);
        uint256[4] memory r;
        for (uint256 i; i < 4; ++i) r[i] = buy(i % 2 == 0 ? buyer : stranger, 1)[0];
        fulfill(r0, 1);
        for (uint256 i; i < 4; ++i) fulfill(r[i], uint256(keccak256(abi.encode("c", i))));
        assertEq(pool.unsettledAcquisitionCount(), 4);
        vm.prank(creator);
        balancer.close();
        for (uint256 j; j < 2; ++j) {
            uint256 free = balancer.withdrawableSurplus();
            if (free == 0) break;
            vm.prank(creator);
            balancer.claimSurplus(free, creator);
        }
        _setGas(4.95 gwei, 5 gwei);
        // step 1 of the estimator: run at a high limit
        uint256 snap = vm.snapshotState();
        bytes32 uh2 = balancer.settingsHash();
        vm.prank(keeper, keeper);
        (bool okHi,) = address(balancer).call{gas: 30_000_000}(abi.encodeWithSignature("performUpkeep(bytes32,uint256,uint256)", uh2, 0, 0));
        (, bytes memory rr) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        (, uint64 usedHi,, int64 refHi,) = abi.decode(rr, (uint64, uint64, uint64, int64, uint64));
        vm.revertToState(snap);
        assertTrue(okHi);
        uint256 peak = uint256(usedHi) + uint256(int256(refHi));
        emit log_named_uint("used at 30M (after refund)", usedHi);
        emit log_named_uint("receipt billed gas at 30M limit", peak);
        uint256[4] memory Gs = [uint256(usedHi), peak, peak * 64 / 63, (uint256(usedHi) * 13) / 10];
        for (uint256 k; k < 4; ++k) {
            (bool ok, bool processed, uint256 paid, uint256 billed) = _try(Gs[k]);
            emit log_string(string.concat(
                "G=", vm.toString(Gs[k]), " ok=", ok ? "1" : "0", " processed=", processed ? "1" : "0",
                " paidWei=", vm.toString(paid), " billedGas=", vm.toString(billed),
                " keeperNetWei=", vm.toString(int256(paid) - int256(billed * 5 gwei))
            ));
            // Requirement (D16 re-attack 2, finding 1): no gas limit succeeds with processing starved, so an estimate
            // that succeeds processes, and a successful call covers the keeper's billed gas.
            assertTrue(!ok || processed, "a call that succeeds has processed");
            if (ok) assertGe(paid, billed * 5 gwei, "and covers the keeper");
        }
    }
}
