// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {D16WorstUpkeepTest, IFwaExtra, GasHogCollection} from "./WorstUpkeep.t.sol";

/// @notice D16 re-attack F3: a keeper chooses its transaction's gas limit so that the try/catch'd `processAcquisitions`
///         fails (FWA's notifier refuses to start below 290k gas and FWA propagates that revert) while the rest of
///         upkeep still succeeds. The gas burned by the failed processing must not be paid for (on af1075c it was:
///         1.42M gas, 0.0075 ETH at 5 gwei, for one reconcile). Closed pool (no restock after closing), honest NFTs.
contract D16StarveTest is D16WorstUpkeepTest {
    function test_noGasLimitStarvesProcessing_closed_5gwei() public {
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
            bytes32 uh1 = balancer.settingsHash();
            vm.prank(keeper, keeper);
            try balancer.performUpkeep{gas: g}(uh1) returns (uint256 paid) {
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
        // Requirement (D16 re-attack F3, then re-attack 2 finding 1): no gas limit lets the call succeed with processing
        // starved. On af1075c the creator paid 1.42M gas for one reconcile at a 1.48M limit; at 4a83c47 that call was
        // unpaid for the failed processing but still succeeded, so a raw gas estimate lost the keeper 0.011 ETH.
        assertEq(found, 0, "no gas limit succeeds with processing starved");
        emit log_named_uint("hold kept for the five waiting draws (wei)", address(balancer).balance);
    }

    function _measureWithGas(uint256 g) internal returns (uint256 reward, uint256 billed, uint256 measured) {
        bytes32 uh2 = balancer.settingsHash();
        uint256 before = keeper.balance;
        vm.recordLogs();
        vm.prank(keeper, keeper);
        reward = balancer.performUpkeep{gas: g}(uh2);
        measured = _lastMeasured();
        (bool ok, bytes memory rr) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok);
        (, uint64 used,,,) = abi.decode(rr, (uint64, uint64, uint64, int64, uint64));
        billed = uint256(used) + 21_000;
        assertEq(keeper.balance - before, reward);
    }
}
