// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {KeeperPolicyV1} from "../src/KeeperPolicyV1.sol";
import {IKeeperPolicy} from "../src/interfaces/IKeeperPolicy.sol";
import {IERC721Min} from "../src/interfaces/External.sol";

contract ReviewEconomicPolicy is IKeeperPolicy {
    function interfaceVersion() external pure returns (uint256) { return 3; }
    function version() external pure returns (uint256) { return 77; }
    function quoteReward(Work calldata, Economics calldata) external pure returns (uint256) { return 0.00003 ether; }
    function quoteRestock(uint8, uint256 units, uint256, Economics calldata) external pure returns (uint256) {
        return units * 0.000695 ether;
    }
}

contract ReviewSmallPolicy is IKeeperPolicy {
    function interfaceVersion() external pure returns (uint256) { return 3; }
    function version() external pure returns (uint256) { return 76; }
    function quoteReward(Work calldata, Economics calldata) external pure returns (uint256) { return 0.00003 ether; }
    function quoteRestock(uint8, uint256 units, uint256, Economics calldata) external pure returns (uint256) { return units * 0.000695 ether; }
}

contract ReviewMaximumPolicy is IKeeperPolicy {
    function interfaceVersion() external pure returns (uint256) { return 3; }
    function version() external pure returns (uint256) { return 78; }
    function quoteReward(Work calldata, Economics calldata) external pure returns (uint256) { return type(uint256).max; }
    function quoteRestock(uint8, uint256 units, uint256, Economics calldata) external pure returns (uint256) {
        return units * 0.000695 ether;
    }
}

interface ReviewRefund {
    function acquisitionRefundCredit(address account) external view returns (uint256);
    function withdrawAcquisitionRefund() external returns (uint256);
}

interface ReviewPack { function valueOf(uint256 id) external view returns (uint256); }

/// @notice Independent economic counterexamples and exact zero-demand capital round trip on real dependencies.
contract PolicyEconomicReviewTest is ForkBase {
    GasProbe probe;

    function setUp() public {
        setUpFork();
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        probe = new GasProbe();
        _context();
    }

    function _context() internal {
        probe.record();
        assertEq(probe.baseFee(), 0.5 gwei, "basefee in an executed call");
        assertEq(probe.gasPrice(), 0.55 gwei, "gas price in an executed call");
    }

    function _open() internal {
        createBalancer(5 ether);
        configure(plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        listCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertEq(balancer.getActiveShapes()[0], 20, "all intended inventory actually listed");
        _context();
    }

    /// Spec §2: no public path re-enables a creator's emergency stop. Replaces the former matured-proposal case; with
    /// no proposals, a stranger's only routes are the creator-only setters.
    function test_emergencyDisableHasNoPublicReenablePath() public {
        _open();
        KeeperPolicyV1 replacement = new KeeperPolicyV1();
        vm.prank(creator);
        balancer.setPaidUpkeepEnabled(false);
        assertFalse(balancer.paidUpkeepEnabled(), "creator's emergency stop took effect");
        vm.startPrank(stranger);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.setKeeperPolicy(address(replacement));
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.setPaidUpkeepEnabled(true);
        vm.stopPrank();
        assertFalse(balancer.paidUpkeepEnabled(), "public execution cannot undo emergency stop");
    }

    function test_zeroDemandPolicyFundingAndCloseoutExactCapitalRoundTrip() public {
        uint256 creatorStart = creator.balance;
        uint256 keeperStart = keeper.balance;
        uint256 shapesStart = address(shapes).balance;
        createBalancer(5 ether);
        configure(plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        listCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        assertEq(balancer.requiredReserve(), 0.229565 ether, "actual initial inventory, four listing bounds and one call buffer");
        fillUp();
        assertEq(balancer.getActiveShapes()[0], 20);
        uint256 keeperPaid = keeper.balance - keeperStart;
        assertGt(keeperPaid, 0, "actual paid setup was reached");
        assertEq(address(balancer).balance, 5 ether - 0.22 ether - keeperPaid);
        assertEq(_listedFees(balancer), 0.01401 ether, "20 future fees at 0.0007005 each");
        assertEq(balancer.requiredReserve(), 0.001993 ether, "stocked current-work buffer; unsold fees are never cash");
        assertEq(pool.ownerProceeds(), 0, "zero demand: no proceeds exist");
        assertEq(balancer.creatorCredit(), 0, "zero demand: no earned profit exists");
        uint256[] memory all = balancer.getActiveIds();
        uint256[] memory shapeIds = new uint256[](20);
        uint256[] memory oldPrices = new uint256[](20);
        uint256 nftId;
        uint256 n;
        for (uint256 i; i < all.length; ++i) {
            (uint8 kind,,,,uint256 price) = balancer.items(all[i]);
            if (kind == 2) { shapeIds[n] = all[i]; oldPrices[n++] = price; }
            else nftId = all[i];
        }
        assertEq(n, 20);
        // Cheaper local economics: a 0.3 gwei ceiling and a 0.0000025 ETH work fee.
        IKeeperPolicy.Economics memory inexpensive = _econWith(address(new ReviewSmallPolicy()));
        inexpensive.gasPriceCeiling = 0.3 gwei;
        inexpensive.workFee = 0.0000025 ether;
        vm.prank(creator); balancer.setLocalEconomics(inexpensive);
        uint256 small = (3_200_000 + V1_OVERHEAD) * 0.3 gwei + 10 * 0.0000025 ether;
        assertEq(balancer.requiredReserve(), small, "smaller selected economics fund a smaller working buffer");
        uint256 claim = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(claim, creator);
        assertEq(address(balancer).balance, small, "withdrawal retains precisely the selected working buffer");
        IKeeperPolicy.Economics memory replacement = _econWith(address(new ReviewEconomicPolicy()));
        (uint256 required, uint256 topUp) = balancer.maintenanceFunding(replacement);
        assertEq(required, 0.001993 ether, "new bounded current-work buffer independently recomputed");
        assertEq(topUp, required - small, "the change requires the actual working-capital difference");
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.ReserveNotFunded.selector);
        balancer.setLocalEconomics(replacement);
        vm.prank(creator);
        balancer.depositETH{value: topUp}();
        vm.prank(creator);
        balancer.setLocalEconomics(replacement);
        assertEq(address(balancer).balance, required);
        for (uint256 i; i < shapeIds.length; ++i) {
            (,,,,uint256 price) = balancer.items(shapeIds[i]);
            assertEq(price, oldPrices[i], "a policy change cannot retroactively reprice inventory");
        }
        assertEq(_listedFees(balancer), 0.01401 ether);
        vm.prank(creator); balancer.close();
        assertEq(balancer.requiredReserve(), 0, "remove demand and close: no draw claim remains");
        vm.prank(creator); balancer.unlistShapes(shapeIds);
        assertEq(address(balancer).balance, required + 0.2 ether, "20 Shapes redeem for exactly backing");
        assertEq(address(shapes).balance - shapesStart, 0.02 ether, "only real Shapes mint fees remain one-way");
        vm.prank(creator); balancer.withdrawCurated(nftId, creator);
        uint256 finalClaim = balancer.withdrawableSurplus();
        vm.prank(creator); balancer.claimSurplus(finalClaim, creator);
        vm.prank(creator); balancer.retire();
        assertEq(creatorStart - creator.balance, 0.02 ether + keeperPaid, "creator loses only mint fees and actual setup pay");
        assertEq(address(balancer).balance, 0);
        assertEq(_listedFees(balancer), 0);
        assertEq(pool.ownerProceeds(), 0);
        assertEq(nft.ownerOf(1), creator);
        emit log_named_decimal_uint("independent setup keeper pay", keeperPaid, 18);
        emit log_named_decimal_uint("independent retained board reserve", 0.001993 ether, 18);
        emit log_named_decimal_uint("independent policy activation top-up", topUp, 18);
        _context();
    }

    function test_maximumPolicyCannotConsumePlayerRefundAcrossCloseout() public {
        _open();
        uint256 price = pool.acquisitionFee();
        buy(buyer, 2);
        assertEq(pool.lastIssuedSequence(), 2);
        ReviewMaximumPolicy replacement = new ReviewMaximumPolicy();
        (,uint256 topUp) = balancer.maintenanceFunding(_econWith(address(replacement)));
        assertEq(topUp, 0, "an oversized quote adds no hypothetical lifetime liability");
        vm.prank(creator); balancer.setKeeperPolicy(address(replacement));
        vm.roll(vm.getBlockNumber() + 50); // past FWA's word deadline and the 50-block processing grace
        assertEq(pool.unsettledAcquisitionCount(), 2, "two real unpaid draws await processing");
        uint256 fund = address(balancer).balance;
        uint256 poolCash = address(pool).balance;
        bytes32 expected = balancer.settingsHash();
        vm.prank(keeper, keeper);
        uint256 reward = balancer.performUpkeep(expected, 1, 0);
        assertEq(balancer.reconciledSequence(), 2);
        assertGt(reward, 0.0001 ether, "actual execution plus two bounded service units paid");
        assertLe(reward, 0.0028 ether, "actual gas/work envelope stays within two current single-draw budgets");
        assertEq(fund - address(balancer).balance, reward, "only creator's actual ETH paid the keeper");
        assertEq(pool.ownerProceeds(), 0, "expired draws create no creator proceeds");
        uint256 credit = ReviewRefund(address(pool)).acquisitionRefundCredit(buyer);
        assertEq(credit, 2 * price, "both request-time prices remain player entitlements");
        assertEq(address(pool).balance, poolCash, "reconciliation and max payout move no refund ETH");
        assertEq(address(pool).balance, credit, "refund is fully backed by separate real FWA cash");
        vm.prank(creator); balancer.close();
        uint256[] memory all = balancer.getActiveIds();
        uint256[] memory ids = new uint256[](20);
        uint256 n;
        for (uint256 i; i < all.length; ++i) {
            (uint8 kind,,,,) = balancer.items(all[i]);
            if (kind == 2) ids[n++] = all[i];
            else { vm.prank(creator); balancer.withdrawCurated(all[i], creator); }
        }
        assertEq(n, 20);
        vm.prank(creator); balancer.unlistShapes(ids);
        uint256 claim = balancer.withdrawableSurplus();
        vm.prank(creator); balancer.claimSurplus(claim, creator);
        vm.prank(creator); balancer.retire();
        assertEq(address(balancer).balance, 0);
        assertEq(address(pool).balance, credit, "creator's complete exit cannot take the refund");
        uint256 buyerBefore = buyer.balance;
        vm.prank(buyer); uint256 paidBack = ReviewRefund(address(pool)).withdrawAcquisitionRefund();
        assertEq(paidBack, credit);
        assertEq(buyer.balance - buyerBefore, credit, "player actually recovers the exact claim");
        assertEq(address(pool).balance, 0);
        emit log_named_decimal_uint("independent protected buyer refund", credit, 18);
        emit log_named_decimal_uint("independent maximum policy actual reward", reward, 18);
        emit log_named_decimal_uint("independent maximum policy creator top-up", topUp, 18);
        _context();
    }

    function test_packFeesAndFundingFollowActualShapeWorkAndRedemption() public {
        uint256 shapesBefore = address(shapes).balance;
        createBalancer(5 ether);
        uint256[16] memory counts;
        counts[0] = 20;
        counts[10] = 1;
        configure(plan16(counts));
        listCurated(1, 0.2 ether);
        vm.prank(creator); balancer.open();
        assertEq(balancer.requiredReserve(), 0.2640055 ether, "actual 23-Shape inventory and five canonical listing calls");
        fillUp();
        assertEq(balancer.getActiveShapes()[0], 20);
        assertEq(balancer.getActiveShapes()[10], 1);
        assertEq(balancer.listedShapePrizes(), 21);
        assertEq(_listedFees(balancer), 0.0161115 ether, "23 underlying Shapes each carry 0.0007005");
        assertEq(balancer.requiredReserve(), 0.001993 ether, "fully stocked mixed board retains one working buffer");
        uint256[] memory all = balancer.getActiveIds();
        uint256[] memory ids = new uint256[](21);
        uint256 nftId;
        uint256 n;
        uint256 packId;
        uint256 packListing;
        for (uint256 i; i < all.length; ++i) {
            (uint8 kind,uint8 denomination,,uint256 base,uint256 price) = balancer.items(all[i]);
            if (kind == 1) nftId = all[i];
            else {
                ids[n++] = all[i];
                if (denomination == 10) {
                    packListing = all[i];
                    assertEq(base, 0.0375 ether, "pack backing+three mint fees+15percent backing markup");
                    assertEq(price, 0.0396015 ether, "pack adds exactly three default policy fees");
                    (address collection,,,uint256 id,,,,) = pool.listings(all[i]);
                    assertEq(collection, packs);
                    packId = id;
                }
            }
        }
        assertGt(packListing, 0, "real Draw Pack was listed");
        assertEq(ReviewPack(packs).valueOf(packId), 0.03 ether);
        assertEq(IERC721Min(packs).ownerOf(packId), address(pool));
        vm.prank(creator); balancer.close();
        uint256 beforePack = address(balancer).balance;
        uint256[] memory packOnly = new uint256[](1); packOnly[0] = packListing;
        vm.prank(creator); balancer.unlistShapes(packOnly);
        assertEq(address(balancer).balance - beforePack, 0.03 ether, "one pack redeems its own exact backing");
        uint256[] memory shapesOnly = new uint256[](20);
        uint256 cursor;
        for (uint256 i; i < n; ++i) if (ids[i] != packListing) shapesOnly[cursor++] = ids[i];
        assertEq(cursor, 20);
        vm.prank(creator); balancer.unlistShapes(shapesOnly);
        assertEq(address(shapes).balance - shapesBefore, 0.023 ether, "all backing reversed, exactly23 mint fees remain");
        vm.prank(creator); balancer.withdrawCurated(nftId, creator);
        uint256 claim = balancer.withdrawableSurplus();
        vm.prank(creator); balancer.claimSurplus(claim, creator);
        vm.prank(creator); balancer.retire();
        assertEq(address(balancer).balance, 0);
        assertEq(_listedFees(balancer), 0);
        assertEq(pool.ownerProceeds(), 0);
        _context();
    }

}
