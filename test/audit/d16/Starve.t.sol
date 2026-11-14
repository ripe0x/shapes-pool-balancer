// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {D16WorstUpkeepTest, IFwaExtra, GasHogCollection} from "./WorstUpkeep.t.sol";

/// @notice D16 re-attack F3: a keeper chooses its transaction's gas limit so that the try/catch'd `processAcquisitions`
///         fails (FWA's notifier refuses to start below 290k gas and FWA propagates that revert) while the rest of
///         upkeep still succeeds. The gas burned by the failed processing must not be paid for (on af1075c it was:
///         1.42M gas, 0.0075 ETH at 5 gwei, for one reconcile). Closed pool (no restock after closing), honest NFTs.
contract D16StarveTest is D16WorstUpkeepTest {
    function test_starvedProcessingIsNotPaid_closed_5gwei() public {
        _setGas(0.5 gwei, 0.55 gwei);
        _launchBoard();
        hog = new GasHogCollection();
        uint256 r0 = buy(buyer, 1)[0];
        _listHogs(20, 100);
        _listHogs(4, 200);
        uint256[4] memory r;
        for (uint256 i; i < 4; ++i) r[i] = buy(i % 2 == 0 ? buyer : stranger, 1)[0];
        fulfill(r0, 1); // fast path settles draw 0 (it reserved nothing); the keeper has not reconciled it yet
        for (uint256 i; i < 4; ++i) fulfill(r[i], uint256(keccak256(abi.encode("c", i))));
        vm.prank(creator);
        balancer.close();
        for (uint256 j; j < 2; ++j) {
            uint256 free = balancer.withdrawableSurplus();
            if (free == 0) break;
            vm.prank(creator);
            balancer.claimSurplus(free, creator);
        }
        uint256 hold = address(balancer).balance;
        emit log_named_uint("hold after the creator's claims (wei)", hold);

        _setGas(4.95 gwei, 5 gwei);
        uint64 next = pool.nextSequenceToProcess();
        uint64 rec = balancer.reconciledSequence();
        uint256 found;
        for (uint256 g = 150_000; g < 3_000_000; g += 10_000) {
            uint256 snap = vm.snapshotState();
            vm.prank(keeper, keeper);
            try balancer.performUpkeep{gas: g}() returns (uint256 paid) {
                bool starved = pool.nextSequenceToProcess() == next && balancer.reconciledSequence() > rec && paid != 0;
                vm.revertToState(snap);
                if (starved) {
                    found = g;
                    break;
                }
            } catch {
                vm.revertToState(snap);
            }
        }
        assertGt(found, 0, "a gas limit exists where processing fails, reconciling succeeds and the keeper is paid");
        emit log_named_uint("call gas limit that starves processing", found);
        (uint256 reward, uint256 billed, uint256 measured) = _measureWithGas(found);
        assertEq(pool.nextSequenceToProcess(), next, "nothing processed");
        emit log_named_uint("  measured (paid for)", measured);
        emit log_named_uint("  billed gas", billed);
        emit log_named_uint("  reward (wei)", reward);
        emit log_named_uint("  reconciled draws", balancer.reconciledSequence() - rec);
        emit log_named_uint("hold left for the four draws still waiting (wei)", address(balancer).balance);
        // Requirement (D16 re-attack F3): the gas burned by the failed processing is not paid for. Reconciling the one
        // fast-path draw alone measures about 145k gas.
        assertLt(measured, 250_000, "failed processing is not paid for");
    }

    function _measureWithGas(uint256 g) internal returns (uint256 reward, uint256 billed, uint256 measured) {
        uint256 before = keeper.balance;
        vm.recordLogs();
        vm.prank(keeper, keeper);
        reward = balancer.performUpkeep{gas: g}();
        measured = _lastMeasured();
        (bool ok, bytes memory rr) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok);
        (, uint64 used,,,) = abi.decode(rr, (uint64, uint64, uint64, int64, uint64));
        billed = uint256(used) + 21_000;
        assertEq(keeper.balance - before, reward);
    }
}
