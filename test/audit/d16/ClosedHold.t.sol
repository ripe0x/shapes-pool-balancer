// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Closed holds fund current-price work; a later fee jump may require unpaid recovery.

import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {D16WorstUpkeepTest, IFwaExtra, GasHogCollection} from "./WorstUpkeep.t.sol";

/// @notice D16 re-attack F2 (D3): after closing, the creator may claim everything except the keeper pay held for
///         unreconciled draws (`requiredReserve` while closed). Upkeep processes at most two draws per call, so the
///         hold is one maximum keeper reward per two draws (on af1075c, per five: 0.0054 ETH short at 5 gwei). Every
///         useful post-close call must be paid in full from it. Honest curated NFTs, no hostile party.
contract D16ClosedHoldTest is D16WorstUpkeepTest {
    function test_closedHold_reservedDraws_5gwei() public {
        _setGas(0.5 gwei, 0.55 gwei);
        _launchBoard();
        hog = new GasHogCollection();
        uint256 r0 = buy(buyer, 1)[0];
        _listHogs(20, 100);
        _listHogs(4, 200);
        uint256[4] memory r;
        for (uint256 i; i < 4; ++i) r[i] = buy(i % 2 == 0 ? buyer : stranger, 1)[0];
        for (uint64 s = pool.lastIssuedSequence() - 3; s <= pool.lastIssuedSequence(); ++s) {
            assertEq(IFwaExtra(address(pool)).reservedListingCount(s), 6, "each later draw reserved six listings");
        }
        fulfill(r0, 1);
        for (uint256 i; i < 4; ++i) fulfill(r[i], uint256(keccak256(abi.encode("c", i))));
        assertEq(pool.unsettledAcquisitionCount(), 4, "four ready draws wait for processing");

        _setGas(4.95 gwei,5 gwei); // funding target is priced at close, not insurance against a later fee jump
        vm.prank(creator);
        balancer.close();
        uint256 owed = pool.lastIssuedSequence() - balancer.reconciledSequence();
        uint256 hold = balancer.requiredReserve();
        emit log_named_uint("owed draws at close", owed);
        emit log_named_uint("hold while closed (wei)", hold);
        for (uint256 j; j < 2; ++j) {
            uint256 free = balancer.withdrawableSurplus();
            if (free == 0) break;
            vm.prank(creator);
            balancer.claimSurplus(free, creator); // the first claim collects FWA proceeds, so claim again
        }
        assertEq(address(balancer).balance, hold, "creator took everything above the hold");

        uint256 paid;
        uint256 owedCost;
        for (uint256 k; k < 6 && balancer.reconciledSequence() < pool.lastIssuedSequence(); ++k) {
            uint256 sequenceBefore = balancer.reconciledSequence();
            (uint256 reward, uint256 billed, uint256 measured) = _measure(4.95 gwei, 5 gwei);
            uint256 full = ((measured > 3_200_000 ? 3_200_000 : measured) + 50_000) * 5 gwei
                + (balancer.reconciledSequence() - sequenceBefore) * 0.00002 ether;
            emit log_named_uint("call", k + 1);
            emit log_named_uint("  measured", measured);
            emit log_named_uint("  billed gas", billed);
            emit log_named_uint("  reward under the rule (wei)", full);
            emit log_named_uint("  reward paid (wei)", reward);
            paid += reward;
            owedCost += full;
        }
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence(), "reached: all draws reconciled");
        emit log_named_uint("total paid (wei)", paid);
        emit log_named_uint("total owed under the rule (wei)", owedCost);
        emit log_named_uint("keeper shortfall (wei)", owedCost - paid);
        assertEq(paid, owedCost, "the hold paid every useful call in full (D3; D16 re-attack F2)");
    }

    /// Same, but the randomness never arrives (an outage): the draws expire, so processing brings no proceeds.
    function test_closedHold_expiredReservedDraws_5gwei() public {
        _setGas(0.5 gwei, 0.55 gwei);
        _launchBoard();
        hog = new GasHogCollection();
        buy(buyer, 1);
        _listHogs(20, 100);
        _listHogs(4, 200);
        for (uint256 i; i < 4; ++i) buy(i % 2 == 0 ? buyer : stranger, 1);
        for (uint64 s = pool.lastIssuedSequence() - 3; s <= pool.lastIssuedSequence(); ++s) {
            assertEq(IFwaExtra(address(pool)).reservedListingCount(s), 6, "each later draw reserved six listings");
        }
        vm.roll(block.number + ITimeoutX(address(pool)).selectionTimeoutBlocks() + 2);
        _setGas(4.95 gwei,5 gwei); // funding target is priced at close, not insurance against a later fee jump
        vm.prank(creator);
        balancer.close();
        uint256 hold = balancer.requiredReserve();
        emit log_named_uint("owed draws at close", pool.lastIssuedSequence() - balancer.reconciledSequence());
        emit log_named_uint("hold while closed (wei)", hold);
        for (uint256 j; j < 2; ++j) {
            uint256 free = balancer.withdrawableSurplus();
            if (free == 0) break;
            vm.prank(creator);
            balancer.claimSurplus(free, creator);
        }
        assertEq(address(balancer).balance, hold, "creator took everything above the hold");
        uint256 paid;
        uint256 owedCost;
        for (uint256 k; k < 6 && balancer.reconciledSequence() < pool.lastIssuedSequence(); ++k) {
            uint256 sequenceBefore = balancer.reconciledSequence();
            (uint256 reward, uint256 billed, uint256 measured) = _measure(4.95 gwei, 5 gwei);
            uint256 full = ((measured > 3_200_000 ? 3_200_000 : measured) + 50_000) * 5 gwei
                + (balancer.reconciledSequence() - sequenceBefore) * 0.00002 ether;
            emit log_named_uint("call", k + 1);
            emit log_named_uint("  measured", measured);
            emit log_named_uint("  billed gas", billed);
            emit log_named_uint("  reward under the rule (wei)", full);
            emit log_named_uint("  reward paid (wei)", reward);
            paid += reward;
            owedCost += full;
        }
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence(), "reached: all draws reconciled");
        emit log_named_uint("total paid (wei)", paid);
        emit log_named_uint("total owed under the rule (wei)", owedCost);
        emit log_named_uint("keeper shortfall (wei)", owedCost - paid);
        assertEq(paid, owedCost, "the hold paid every useful call in full (D3; D16 re-attack F2)");
    }

    /// The most calls: five draws bought in successive blocks (four reserved six listings each) expire one block apart,
    /// so each upkeep processes and reconciles exactly one.
    function test_closedHold_expiredOnePerBlock_5gwei() public {
        _setGas(0.5 gwei, 0.55 gwei);
        _launchBoard();
        hog = new GasHogCollection();
        uint256 first = vm.getBlockNumber() + ITimeoutX(address(pool)).selectionTimeoutBlocks() + 1;
        buy(buyer, 1);
        _listHogs(20, 100);
        _listHogs(4, 200);
        for (uint256 i; i < 4; ++i) {
            vm.roll(vm.getBlockNumber() + 1);
            buy(i % 2 == 0 ? buyer : stranger, 1);
        }
        for (uint64 s = pool.lastIssuedSequence() - 3; s <= pool.lastIssuedSequence(); ++s) {
            assertEq(IFwaExtra(address(pool)).reservedListingCount(s), 6, "each later draw reserved six listings");
        }
        _setGas(4.95 gwei,5 gwei); // funding target is priced at close, not insurance against a later fee jump
        vm.prank(creator);
        balancer.close();
        uint256 hold = balancer.requiredReserve();
        emit log_named_uint("hold while closed (wei)", hold);
        for (uint256 j; j < 2; ++j) {
            uint256 free = balancer.withdrawableSurplus();
            if (free == 0) break;
            vm.prank(creator);
            balancer.claimSurplus(free, creator);
        }
        assertEq(address(balancer).balance, hold, "creator took everything above the hold");
        uint256 paid;
        uint256 owedCost;
        for (uint256 k; k < 5; ++k) {
            vm.roll(first + k);
            uint64 before = balancer.reconciledSequence();
            uint256 sequenceBefore = balancer.reconciledSequence();
            (uint256 reward,, uint256 measured) = _measure(4.95 gwei, 5 gwei);
            assertEq(balancer.reconciledSequence(), before + 1, "one draw processed and reconciled per call");
            uint256 full = ((measured > 3_200_000 ? 3_200_000 : measured) + 50_000) * 5 gwei
                + (balancer.reconciledSequence() - sequenceBefore) * 0.00002 ether;
            emit log_named_uint("  measured", measured);
            emit log_named_uint("  reward paid (wei)", reward);
            paid += reward;
            owedCost += full;
        }
        emit log_named_uint("total paid (wei)", paid);
        emit log_named_uint("hold left (wei)", address(balancer).balance);
        assertEq(paid, owedCost, "the hold paid every useful call in full");
    }
    function test_lowGasClaimThenGasJumpNeedsUnpaidRefundRecovery() public {
        _setGas(0.5 gwei,0.55 gwei);
        _launchBoard();
        hog=new GasHogCollection();
        buy(buyer,1);
        _listHogs(20,100);
        _listHogs(4,200);
        for(uint256 i;i<4;++i)buy(buyer,1);
        uint256 expectedRefund;
        for(uint64 seq=1;seq<=pool.lastIssuedSequence();++seq) {
            (,,uint256 escrow,,,)=pool.acquisitions(pool.requestIdAtSequence(seq));
            expectedRefund+=escrow;
        }
        vm.roll(vm.getBlockNumber()+ITimeoutX(address(pool)).selectionTimeoutBlocks()+2);
        _setGas(0.001 gwei,0.001 gwei);
        vm.prank(creator);balancer.close();
        uint256 available=balancer.withdrawableSurplus();
        vm.prank(creator);balancer.claimSurplus(available,creator);
        uint256 held=address(balancer).balance;
        uint64 cursor=balancer.reconciledSequence();
        bytes32 generation=balancer.settingsHash();
        _setGas(4.95 gwei,5 gwei);
        vm.prank(keeper,keeper);vm.expectRevert(PoolBalancer.PaymentUnavailable.selector);
        balancer.performUpkeep(generation,1, 0);
        assertEq(balancer.reconciledSequence(),cursor,"unfunded paid work reverted atomically");
        assertEq(address(balancer).balance,held);
        assertEq(IClosedRefund(address(pool)).acquisitionRefundCredit(buyer),0);
        uint256 received=stranger.balance;
        while(balancer.reconciledSequence()<pool.lastIssuedSequence()) {
            vm.prank(stranger);balancer.performUpkeepUnpaid();
        }
        assertEq(stranger.balance,received,"recovery pays no compensation");
        assertEq(IClosedRefund(address(pool)).acquisitionRefundCredit(buyer),expectedRefund);
        uint256 before=buyer.balance;
        vm.prank(buyer);IClosedRefund(address(pool)).withdrawAcquisitionRefund();
        assertEq(buyer.balance-before,expectedRefund,"all real purchaser escrow is recoverable despite operating illiquidity");
        assertEq(address(pool).balance,0);
        assertEq(balancer.requiredReserve(),0);
    }

}

interface ITimeoutX {
    function selectionTimeoutBlocks() external view returns (uint256);
}

interface IClosedRefund {
    function acquisitionRefundCredit(address) external view returns(uint256);
    function withdrawAcquisitionRefund() external returns(uint256);
}
