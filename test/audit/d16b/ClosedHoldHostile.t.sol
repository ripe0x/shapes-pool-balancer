// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Hostile settlement coverage is funded at the gas regime being exercised before the creator claims.

import {Vm} from "forge-std/Vm.sol";
import {D16bWorstUpkeepTest, ProbeHog} from "./WorstUpkeepB.t.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";

interface IFwaR {
    function reservedListingCount(uint64 sequence) external view returns (uint256);
}

/// @notice F2 re-attack: closed pool, hostile curated collection at a near-zero base (so the won prize brings almost
///         no proceeds), four draws that each reserved six listings, ready one per block, so each upkeep processes one.
///         Is one maximum reward per two owed draws enough at 5 gwei?
contract D16bClosedHoldHostileTest is D16bWorstUpkeepTest {
    function _listTinyHogs(uint256 n, uint256 firstId, uint256 base) internal {
        PoolBalancer.CuratedInput[] memory in_ = new PoolBalancer.CuratedInput[](n);
        for (uint256 i; i < n; ++i) {
            hog.mint(creator, firstId + i);
            vm.prank(creator);
            hog.approve(address(balancer), firstId + i);
            in_[i] = PoolBalancer.CuratedInput(address(hog), firstId + i, base);
        }
        vm.prank(creator);
        balancer.listCuratedBatch(in_);
    }

    bool failing;
    bool reconcileFirst;

    function _closedOnePerCall(uint256 pad, uint256 base) internal {
        _setGas(0.5 gwei, 0.55 gwei);
        hog = new ProbeHog();
        createBalancer(10 ether);
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1);
        vm.prank(creator);
        balancer.configure(2500, plan16(c));
        listCurated(1, 0.2 ether);
        for (uint256 i; i < pad; ++i) listCurated(1000 + i, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256 r0 = buy(buyer, 1)[0];
        _listTinyHogs(20, 100, base);
        _listTinyHogs(4, 200, base);
        hog.arm(address(pool));
        if (failing) {
            hog.setFailDelivery();
            anyStatus = true;
        }
        uint256[4] memory r;
        for (uint256 i; i < 4; ++i) r[i] = buy(i % 2 == 0 ? buyer : stranger, 1)[0];
        for (uint64 s = pool.lastIssuedSequence() - 3; s <= pool.lastIssuedSequence(); ++s) {
            assertEq(IFwaR(address(pool)).reservedListingCount(s), 6);
        }
        fulfill(r0, 1);
        if (reconcileFirst) {
            bytes32 uh1 = balancer.settingsHash();
            vm.prank(keeper, keeper);
            balancer.performUpkeep(uh1); // reconciles r0 (fast path); a restock stages behind the reserved draws
            assertEq(balancer.reconciledSequence() + 4, pool.lastIssuedSequence());
        }
        _setGas(4.95 gwei,5 gwei); // fund actual cap-price work before claiming its current-price hold
        vm.prank(creator);
        balancer.close();
        uint256 hold = balancer.requiredReserve();
        emit log_named_uint("owed at close", pool.lastIssuedSequence() - balancer.reconciledSequence());
        emit log_named_uint("hold (wei)", hold);
        for (uint256 j; j < 3; ++j) {
            uint256 free = balancer.withdrawableSurplus();
            if (free == 0) break;
            vm.prank(creator);
            balancer.claimSurplus(free, creator);
        }
        assertEq(address(balancer).balance, hold, "creator took all above the hold");
        uint256 paid;
        uint256 owedCost;
        uint256 hogs;
        for (uint256 k; k < 4; ++k) {
            fulfill(r[k], _hogWord(r[k], 1, abi.encode("cl", k)));
            uint256 sequenceBefore = balancer.reconciledSequence();
            (uint256 reward,, uint256 measured) = _measure(4.95 gwei, 5 gwei);
            (address coll, uint8 st) = _winner(r[k]);
            if (coll == address(hog) && (st == 2 || (failing && st != 0))) ++hogs;
            emit log_named_uint("  draw status", st);
            uint256 full = ((measured > 3_200_000 ? 3_200_000 : measured) + 50_000) * 5 gwei
                + (balancer.reconciledSequence() - sequenceBefore) * 0.00002 ether;
            emit log_named_uint("  measured", measured);
            emit log_named_uint("  rule reward (wei)", full);
            emit log_named_uint("  paid (wei)", reward);
            paid += reward;
            owedCost += full;
        }
        assertEq(hogs, 4, "reached: every processed draw delivered a hog");
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence(), "all reconciled");
        emit log_named_uint("total paid", paid);
        emit log_named_uint("total under the rule", owedCost);
        emit log_named_uint("left in balancer", address(balancer).balance);
        assertEq(paid, owedCost, "every useful call paid in full");
    }

    function test_closedHostile_onePerCall_base1gwei() public {
        _closedOnePerCall(0, 1 gwei);
    }

    function test_closedHostile_onePerCall_pad464_base1gwei() public {
        _closedOnePerCall(464, 1 gwei);
    }

    function test_closedHostile_failedDelivery_owed4_pad464() public {
        failing = true;
        reconcileFirst = true;
        _closedOnePerCall(464, 1 gwei);
    }

    function test_closedHostile_failedDelivery_owed4() public {
        failing = true;
        reconcileFirst = true;
        _closedOnePerCall(0, 1 gwei);
    }
}
