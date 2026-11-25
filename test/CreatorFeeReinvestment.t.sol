// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuthenticEconomicFlowsBase} from "./AuthenticEconomicFlows.t.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {PoolInventory} from "../src/PoolInventory.sol";
import {KeeperPolicyCalls} from "../src/KeeperPolicyCalls.sol";
import {IERC721Min} from "../src/interfaces/External.sol";

interface IReinvestPackValue { function valueOf(uint256 tokenId) external view returns (uint256); }

/// @dev The historical proofs are cryptographically checked by the real coordinator. Deposits never stand in for sales.
contract CreatorFeeReinvestmentTest is AuthenticEconomicFlowsBase {
    function _publicProofs() internal pure override returns (bool) { return true; }

    function _expectedAutomaticRate() internal view returns (uint256) {
        KeeperPolicyCalls.Economics memory e = balancer.effectiveEconomics();
        uint256 gasPrice = block.basefee + e.priorityAllowance;
        if (gasPrice > e.gasPriceCeiling) gasPrice = e.gasPriceCeiling;
        uint256 markup = balancer.markupBps();
        uint256 excess = markup > 1_000 ? markup - 1_000 : 0;
        uint256 target = balancer.target();
        uint256 weightedPrice;
        uint256 totalWeight;
        uint256 allocation;
        for (uint256 d; d < 16; ++d) {
            uint256 n = (target >> (16 * d)) & 0xffff;
            if (n == 0) continue;
            uint256 value = _backing(uint8(d));
            uint256 units = d == 9 ? 2 : 1;
            uint256 price = value + units * balancer.mintFeeCap() + value * markup / 10_000
                + units * (uint256(e.restockGas) * gasPrice + e.restockFlat);
            uint256 weight = n * (1e36 / price);
            totalWeight += weight;
            weightedPrice += weight * price;
            allocation += weight * (value * excess / 10_000);
        }
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = balancer.items(ids[i]);
            if (kind != 1) continue;
            (,,,,, uint256 price,,) = pool.listings(ids[i]);
            uint256 weight = 1e36 / price;
            totalWeight += weight;
            weightedPrice += weight * price;
        }
        uint256 ownerEV = weightedPrice / totalWeight;
        return allocation * 10_000 / (totalWeight * ownerEV);
    }

    function _accrueActualFees() internal returns (uint256 credit) {
        uint256 rate = _expectedAutomaticRate();
        assertEq(balancer.profitAccountingVersion(), 2);
        assertEq(balancer.creatorRevenueBps(), rate, "independent target, curated weight and fee-price formula");
        assertGt(rate, 0);
        _submitAuthenticProofs();
        uint256 receipts = pool.ownerProceeds();
        assertEq(receipts, 3 * expectedBase);
        balancer.collectProceeds();
        credit = receipts * rate / 10_000;
        assertGt(credit, 0);
        assertEq(balancer.creatorCredit(), credit, "actual receipts allocate the automatic creator fee once");
        balancer.collectProceeds();
        assertEq(balancer.creatorCredit(), credit, "no double booking");
        balancer.performUpkeepUnpaid();
        assertEq(balancer.creatorCredit(), credit, "maintenance never spends reserved fees");
        uint256 operatingAssets = address(balancer).balance + _actualBacking() - credit;
        assertLt(operatingAssets, balancer.operatingCapital(), "real launch costs and prizes leave a bankroll loss");
        assertEq(balancer.bankrollProfit(), 0);
        emit log_named_uint("actual_owner_receipts_wei", receipts);
        emit log_named_uint("automatic_creator_rate_bps", rate);
        emit log_named_uint("reserved_creator_fee_wei", credit);
        emit log_named_uint("bankroll_loss_wei", balancer.operatingCapital() - operatingAssets);
    }

    function _makeExactShortfall() internal returns (uint256 credit, uint256 gap) {
        credit = _accrueActualFees();
        uint256 mintFee = shapes.mintFee();
        vm.startPrank(creator);
        balancer.setPaidUpkeepEnabled(false);
        balancer.configure(2500, uint256(4) << 64, mintFee);
        vm.stopPrank();
        uint256 reserve = balancer.requiredReserve();
        uint256 operating = address(balancer).balance - credit;
        gap = credit / 2;
        assertGt(gap, 0);
        assertGt(reserve, operating + gap, "actual target increase needs more operating capital");
        uint256 contribution = reserve - operating - gap;
        uint256 capital = balancer.operatingCapital();
        vm.prank(creator); balancer.depositETH{value: contribution}();
        assertEq(balancer.operatingCapital(), capital + contribution, "explicit contribution raises capital rather than fee income");
        assertEq(balancer.creatorCredit(), credit);
        assertEq(balancer.creatorFeeTopUpAvailable(), gap);
        assertEq(balancer.withdrawableSurplus(), 0, "fees cannot leave while operating reserve is short");
    }

    function test_reservedFeeAccruesDespiteBankrollLossAndPaysSeparately() public {
        uint256 credit = _accrueActualFees();
        uint256 cash = address(balancer).balance;
        uint256 capital = balancer.operatingCapital();
        assertEq(balancer.withdrawableSurplus(), credit, "funded pool may pay its fee even when bankroll profit is zero");
        uint256 wallet = creator.balance;
        vm.prank(creator); balancer.claimSurplus(credit, creator);
        assertEq(creator.balance - wallet, credit);
        assertEq(address(balancer).balance, cash - credit);
        assertEq(balancer.creatorCredit(), 0);
        assertEq(balancer.operatingCapital(), capital);
        assertEq(balancer.bankrollProfit(), 0);
    }

    function test_pendingDrawsCollectAtOldRateBeforeConfigEpochAdvances() public {
        uint256 oldRate = _expectedAutomaticRate();
        assertEq(balancer.creatorRevenueBps(), oldRate);
        assertEq(pool.unsettledAcquisitionCount(), 3);
        uint256 newTarget = balancer.target() + 1; // One additional 0.01 ETH prize.
        uint256 mintCap = shapes.mintFee();
        vm.prank(creator); balancer.configure(3500, newTarget, mintCap);
        assertTrue(balancer.creatorFeeUpdatePending());
        assertEq(balancer.creatorRevenueBps(), oldRate, "outstanding draws retain the previously effective collection rate");
        uint256 capital = balancer.operatingCapital();
        vm.prank(creator); balancer.depositETH{value: 0.02 ether}();
        assertEq(balancer.operatingCapital(), capital + 0.02 ether);
        assertEq(balancer.creatorCredit(), 0, "deposit does not generate a creator fee");

        _submitAuthenticProofs();
        uint256 receipts = pool.ownerProceeds();
        assertEq(receipts, 3 * expectedBase, "configuration did not rewrite the already purchased board");
        balancer.collectProceeds();
        uint256 credit = receipts * oldRate / 10_000;
        assertEq(balancer.creatorCredit(), credit, "all existing receipts are booked at the old epoch rate");
        assertTrue(balancer.creatorFeeUpdatePending(), "unreconciled prizes still prevent a rate refresh");
        assertEq(balancer.creatorRevenueBps(), oldRate);
        balancer.performUpkeepUnpaid();
        assertEq(balancer.reconciledSequence(), 3);
        assertFalse(balancer.creatorFeeUpdatePending());
        uint256 newRate = _expectedAutomaticRate();
        assertEq(balancer.creatorRevenueBps(), newRate, "the new rate follows reconciliation and active inventory proof");
        assertTrue(newRate != oldRate);
        assertEq(balancer.creatorCredit(), credit, "refresh never retroactively reallocates receipts");

        vm.prank(creator); balancer.configure(1000, newTarget, mintCap);
        assertFalse(balancer.creatorFeeUpdatePending());
        assertEq(balancer.creatorRevenueBps(), 0, "markup with no excess above ten percent allocates no new creator fee");
        assertEq(balancer.creatorCredit(), credit, "existing fee credit survives a zero-rate epoch");
        capital = balancer.operatingCapital();
        vm.prank(creator); balancer.depositETH{value: 0.01 ether}();
        assertEq(balancer.operatingCapital(), capital + 0.01 ether);
        assertEq(balancer.creatorCredit(), credit);
    }

    function test_partialThenExactGapReinvestmentLeavesUnusedFeesReserved() public {
        (uint256 credit, uint256 gap) = _makeExactShortfall();
        uint256 cash = address(balancer).balance;
        uint256 capital = balancer.operatingCapital();
        vm.prank(stranger);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.reinvestCreatorFees(gap);
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InsufficientSurplus.selector);
        balancer.reinvestCreatorFees(0);
        uint256 partialAmount = gap / 2;
        vm.prank(creator);
        vm.expectEmit(false, false, false, true, address(balancer));
        emit PoolInventory.CreatorFeesReinvested(partialAmount);
        uint256 used = balancer.reinvestCreatorFees(partialAmount);
        assertEq(used, partialAmount);
        assertEq(address(balancer).balance, cash, "reinvestment moves no ETH");
        assertEq(balancer.creatorCredit(), credit - partialAmount);
        assertEq(balancer.operatingCapital(), capital + partialAmount);
        assertEq(balancer.creatorFeeTopUpAvailable(), gap - partialAmount);
        vm.prank(creator); used = balancer.reinvestCreatorFees(type(uint256).max);
        assertEq(used, gap - partialAmount, "only the remaining reserve gap is used");
        assertEq(address(balancer).balance, cash);
        assertEq(balancer.creatorCredit(), credit - gap, "unused creator fees stay protected");
        assertEq(balancer.operatingCapital(), capital + gap);
        assertEq(balancer.creatorFeeTopUpAvailable(), 0);
        assertEq(balancer.bankrollProfit(), 0);
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InsufficientSurplus.selector);
        balancer.reinvestCreatorFees(type(uint256).max);
    }

    function test_staleMaximumCannotReinvestMoreThanCurrentGap() public {
        (uint256 credit, uint256 gap) = _makeExactShortfall();
        uint256 newContribution = gap / 3;
        vm.prank(creator); balancer.depositETH{value: newContribution}();
        uint256 currentGap = gap - newContribution;
        assertEq(balancer.creatorFeeTopUpAvailable(), currentGap);
        uint256 cash = address(balancer).balance;
        uint256 capital = balancer.operatingCapital();
        vm.prank(creator); uint256 used = balancer.reinvestCreatorFees(gap);
        assertEq(used, currentGap, "old approved maximum is a cap, never a requested dump of all fees");
        assertEq(address(balancer).balance, cash);
        assertEq(balancer.creatorCredit(), credit - currentGap);
        assertEq(balancer.operatingCapital(), capital + currentGap);
        assertEq(balancer.creatorFeeTopUpAvailable(), 0);
        vm.prank(creator); balancer.close();
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InsufficientSurplus.selector);
        balancer.reinvestCreatorFees(type(uint256).max);
        assertEq(balancer.creatorCredit(), credit - currentGap, "closing does not donate remaining creator fees");
    }

    function test_maintenanceUsesOperatingCashAndCannotAutomaticallyReinvestFees() public {
        (uint256 credit, uint256 gap) = _makeExactShortfall();
        uint256 cash = address(balancer).balance;
        uint256 capital = balancer.operatingCapital();
        uint256 backing = _actualBacking();
        balancer.performUpkeepUnpaid();
        assertEq(address(balancer).balance, cash - 3 ether - 3 * shapes.mintFee(), "real path can afford three of four requested 1 ETH prizes");
        assertEq(balancer.creatorCredit(), credit);
        assertEq(balancer.operatingCapital(), capital);
        assertGe(address(balancer).balance, credit, "reserved fee cash never funds minting");
        uint256[] memory active = balancer.getActiveIds();
        uint256 actualBacking;
        for (uint256 i; i < active.length; ++i) {
            (uint8 kind,,,,) = balancer.items(active[i]);
            if (kind != 2) continue;
            (address collection,,, uint256 tokenId,,,,) = pool.listings(active[i]);
            assertEq(IERC721Min(collection).ownerOf(tokenId), address(pool));
            actualBacking += collection == SHAPES ? shapes.backingOf(tokenId) : IReinvestPackValue(collection).valueOf(tokenId);
        }
        assertEq(actualBacking, backing + 3 ether);
        assertEq(balancer.creatorFeeTopUpAvailable(), gap, "minting doesn't silently consume the fee bucket");
        assertEq(balancer.withdrawableSurplus(), 0);
    }

    function test_feeCreditCapsTopUpAndLeavesUnfundedRemainder() public {
        uint256 credit = _accrueActualFees();
        vm.startPrank(creator);
        balancer.setPaidUpkeepEnabled(false);
        balancer.configure(2500, uint256(4) << 64, shapes.mintFee());
        vm.stopPrank();
        uint256 cash = address(balancer).balance;
        uint256 capital = balancer.operatingCapital();
        uint256 gap = balancer.requiredReserve() - (cash - credit);
        assertGt(gap, credit, "actual replacement need exceeds all accrued fees");
        assertEq(balancer.creatorFeeTopUpAvailable(), credit);
        vm.prank(creator); uint256 used = balancer.reinvestCreatorFees(type(uint256).max);
        assertEq(used, credit);
        assertEq(balancer.creatorCredit(), 0);
        assertEq(address(balancer).balance, cash);
        assertEq(balancer.operatingCapital(), capital + credit);
        assertEq(balancer.requiredReserve() - address(balancer).balance, gap - credit);
        assertEq(balancer.creatorFeeTopUpAvailable(), 0);
        assertEq(balancer.withdrawableSurplus(), 0);
        assertEq(balancer.bankrollProfit(), 0);
    }

    function test_closedPoolCanReinvestExactOpeningGapButRetiredPoolCannot() public {
        (uint256 credit, uint256 gap) = _makeExactShortfall();
        uint256 openingReserve = balancer.requiredReserve();
        uint256 cash = address(balancer).balance;
        uint256 capital = balancer.operatingCapital();
        vm.prank(creator); balancer.close();
        assertEq(balancer.requiredReserve(), 0, "closed withdrawals do not reserve a future board");
        assertEq(balancer.creatorFeeTopUpAvailable(), gap, "reinvestment still measures the actual reopening deficit");
        vm.prank(creator); uint256 used = balancer.reinvestCreatorFees(type(uint256).max);
        assertEq(used, gap);
        assertEq(address(balancer).balance, cash);
        assertEq(balancer.creatorCredit(), credit - gap);
        assertEq(balancer.operatingCapital(), capital + gap);
        assertEq(address(balancer).balance - balancer.creatorCredit(), openingReserve);
        vm.startPrank(creator);
        balancer.open();
        balancer.close();
        balancer.retire();
        vm.stopPrank();
        assertEq(balancer.creatorFeeTopUpAvailable(), 0, "retirement cannot invent a future refill obligation");
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InsufficientSurplus.selector);
        balancer.reinvestCreatorFees(type(uint256).max);
        assertEq(balancer.creatorCredit(), credit - gap);
    }
}
