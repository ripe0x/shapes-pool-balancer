// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {D16WorstUpkeepTest} from "./WorstUpkeep.t.sol";

/// @notice D16 re-attack F1 (O13): draws settle with only players, randomness and keepers acting, even when a keeper
///         sends only calls whose reward covers its billed gas, with the heaviest processing FWA allows (two draws that
///         each reserved six gas-hog listings). On af1075c that upkeep passed the 3.2M pay cap, the keeper skipped it
///         and sales stopped at BUSY.
///         Launch gas: basefee 0.1 gwei, bid 0.15 gwei. Run with --isolate (billed gas is a real transaction's).
contract D16StallTest is D16WorstUpkeepTest {
    function _rationalKeeper(uint256 price) internal returns (bool sent) {
        uint256 snap = vm.snapshotState();
        (uint256 reward, uint256 billed,) = _measureOrZero();
        if (reward != 0 && reward >= billed * price) {
            vm.deleteStateSnapshot(snap);
            return true;
        }
        vm.revertToState(snap);
    }

    function _measureOrZero() internal returns (uint256 reward, uint256 billed, uint256 measured) {
        bytes32 uh1 = balancer.settingsHash();
        vm.prank(keeper, keeper);
        try balancer.performUpkeep(uh1, 0, 0) returns (uint256 r) {
            reward = r;
            (bool ok, bytes memory rr) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
            require(ok);
            (, uint64 used,,,) = abi.decode(rr, (uint64, uint64, uint64, int64, uint64));
            billed = uint256(used);
        } catch {}
        measured = 0;
    }

    function test_stall_hogsReservedPacks_launchGas() public {
        packs3 = true;
        _build(12, true);
        _setGas(0.1 gwei, 0.15 gwei);
        uint256 sold;
        uint256 refused;
        uint256 skipped;
        for (uint256 i; i < 20; ++i) {
            if (balancer.canPurchase(buyer)) {
                uint256 id = buy(buyer, 1)[0];
                ++sold;
                fulfill(id, uint256(keccak256(abi.encode("s", i)))); // its word arrives; not the head, so it waits
            } else {
                ++refused;
            }
            if (!_rationalKeeper(0.15 gwei)) ++skipped;
            vm.roll(vm.getBlockNumber() + 5);
        }
        emit log_named_uint("draws sold", sold);
        emit log_named_uint("purchases refused", refused);
        emit log_named_uint("keeper passes skipped as unprofitable", skipped);
        emit log_named_uint("unsettled draws at the end", pool.unsettledAcquisitionCount());
        emit log_named_uint("admission status (4 = BUSY)", balancer.admissionStatus());
        // Requirement (O13; D16 re-attack F1): a keeper that only sends covered calls settles everything alone.
        for (uint256 k; k < 10 && pool.unsettledAcquisitionCount() != 0; ++k) {
            _rationalKeeper(0.15 gwei);
            vm.roll(vm.getBlockNumber() + 1);
        }
        assertEq(pool.unsettledAcquisitionCount(), 0, "covered upkeep alone settled every draw");
        assertTrue(balancer.admissionStatus() != 4, "sales not stopped at BUSY");
        assertLt(refused, 5, "purchases kept selling");
    }
}
