// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {BalancerFactory} from "../src/BalancerFactory.sol";
import {KeeperPolicyCalls} from "../src/KeeperPolicyCalls.sol";

/// @notice Factory product limits (spec §4.1/§4.3) on a mainnet fork: policyAdmin sets `maxPrizes` and the markup range
///         immediately; they bind newly submitted designs only. A pool already beyond a lowered limit may keep or
///         reduce its prize count (`max(current count, maxPrizes)`) and keep its markup; upkeep, recovery and
///         withdrawals never consult the limits, and no listing is repriced.
contract ProductLimitsTest is ForkBase {
    event ProductLimitsChanged(uint16 maxPrizes, uint16 minMarkupBps, uint16 maxMarkupBps);

    function setUp() public {
        setUpFork();
        curatedRequired = false;
    }

    function _limits() internal view returns (uint16 maxPrizes, uint16 minMarkup, uint16 maxMarkup) {
        return factory.productLimits();
    }

    function _configure(uint16 markup, uint256 t) internal {
        uint256 fee = shapes.mintFee();
        vm.prank(creator);
        balancer.configure(markup, t, fee);
    }

    function _configureReverts(uint16 markup, uint256 t, bytes4 err) internal {
        uint256 fee = shapes.mintFee();
        vm.prank(creator);
        vm.expectRevert(err);
        balancer.configure(markup, t, fee);
    }

    function _single(uint256 n) internal pure returns (uint256) {
        return n; // n prizes of the 0.01 ETH Shape (size 0, low 16 bits)
    }

    function test_defaultsAuthorityAndBounds() public {
        (uint16 maxPrizes, uint16 minMarkup, uint16 maxMarkup) = _limits();
        assertEq(maxPrizes, 1_000);
        assertEq(minMarkup, 1_000);
        assertEq(maxMarkup, 10_000);
        vm.prank(keeperAdmin); vm.expectRevert(BalancerFactory.Unauthorized.selector); factory.setProductLimits(1, 1, 1);
        vm.prank(stranger); vm.expectRevert(BalancerFactory.Unauthorized.selector); factory.setProductLimits(1, 1, 1);
        vm.expectRevert(BalancerFactory.InvalidLimits.selector); factory.setProductLimits(0, 1_000, 10_000);
        vm.expectRevert(BalancerFactory.InvalidLimits.selector); factory.setProductLimits(1_000, 0, 10_000);
        vm.expectRevert(BalancerFactory.InvalidLimits.selector); factory.setProductLimits(1_000, 5_001, 5_000);
        vm.expectEmit(address(factory));
        emit ProductLimitsChanged(7, 3_000, 3_000);
        factory.setProductLimits(7, 3_000, 3_000); // min == max is allowed
        (maxPrizes, minMarkup, maxMarkup) = _limits();
        assertEq(maxPrizes, 7);
        assertEq(minMarkup, 3_000);
        assertEq(maxMarkup, 3_000);
    }

    /// Raised limits take effect immediately for existing pools' next design and for creation.
    function test_raisedLimitsAdmitLargerDesignsImmediately() public {
        createBalancer(1 ether);
        _configureReverts(1_500, _single(1_001), PoolBalancer.InvalidPlan.selector);
        _configureReverts(20_000, _single(10), PoolBalancer.InvalidConfig.selector);
        _configureReverts(500, _single(10), PoolBalancer.InvalidConfig.selector);
        factory.setProductLimits(2_000, 500, 20_000);
        _configure(1_500, _single(2_000));
        assertEq(balancer.target(), 2_000);
        _configure(20_000, _single(10));
        _configure(500, _single(10));
        assertEq(balancer.markupBps(), 500);
        _configureReverts(499, _single(10), PoolBalancer.InvalidConfig.selector);
        _configureReverts(500, _single(2_001), PoolBalancer.InvalidPlan.selector);
    }

    /// The prize limit counts the target's Shape and Draw Pack prizes, never curated NFTs.
    function test_maxPrizesCountsShapesAndPacksNotCurated() public {
        createBalancer(1 ether);
        factory.setProductLimits(3, 1_000, 10_000);
        uint256[16] memory c;
        c[0] = 2;
        c[9] = 1; // one 0.02 ETH Draw Pack prize
        _configure(1_500, plan16(c));
        c[9] = 2;
        _configureReverts(1_500, plan16(c), PoolBalancer.InvalidPlan.selector);
        for (uint256 i; i < 5; ++i) listCurated(100 + i, 0.2 ether);
        assertEq(balancer.getActiveIds().length, 5, "five curated NFTs listed under a three-prize limit");
    }

    /// Lowering limits below an existing design: the design keeps working (upkeep, sales, recovery, withdrawals), its
    /// prices are untouched, and the creator may keep or reduce it. Growth beyond max(current, maxPrizes) and a new
    /// out-of-range markup are refused; creation follows the new limits.
    function test_loweredLimitsPreserveExistingDesign() public {
        createBalancer(5 ether);
        uint256 t = _single(30);
        _configure(1_500, t);
        vm.prank(creator); balancer.open();
        fillUp();
        assertEq(balancer.getActiveShapes()[0], 30);
        uint256[] memory ids = balancer.getActiveIds();
        uint256[] memory prices = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) (,,,, prices[i]) = balancer.items(ids[i]);

        factory.setProductLimits(10, 2_000, 5_000); // below both the count (30) and the markup (1500)

        // Ongoing operation: a sale, its reconciliation and restock at the pool's existing markup.
        assertEq(balancer.admissionStatus(), 0);
        uint256[] memory req = buy(buyer, 1);
        fulfill(req[0], 0);
        fillUp();
        assertEq(balancer.getActiveShapes()[0], 30, "upkeep restocks the existing 30-prize design");
        uint256[] memory now_ = balancer.getActiveIds();
        (,,, uint112 base,) = balancer.items(now_[now_.length - 1]);
        assertEq(base, 0.01 ether + shapes.mintFee() + 0.0015 ether, "restock keeps the existing 15% markup");
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,, uint112 price) = balancer.items(ids[i]);
            if (kind != 0) assertEq(price, prices[i], "no listing is repriced by a limit change");
        }

        // Keep the design (e.g. to accept a fee), then reduce it; growing back past max(current, 10) is refused.
        _configure(1_500, t);
        _configure(1_500, _single(25));
        _configureReverts(1_500, _single(26), PoolBalancer.InvalidPlan.selector);
        _configure(1_500, _single(25)); // same count again
        // A different markup must be in the new range; the old one is no longer "unchanged" once left.
        _configureReverts(1_800, _single(25), PoolBalancer.InvalidConfig.selector);
        _configure(2_500, _single(25));
        _configureReverts(1_500, _single(25), PoolBalancer.InvalidConfig.selector);
        _configure(2_500, _single(5));
        _configure(2_500, _single(10));
        _configureReverts(2_500, _single(11), PoolBalancer.InvalidPlan.selector);

        // Recovery and withdrawal: unlist extra prizes down to the reduced target and claim the surplus.
        uint256[] memory all = balancer.getActiveIds();
        uint256[] memory extra = new uint256[](20);
        for (uint256 i; i < 20; ++i) extra[i] = all[i];
        vm.prank(creator); balancer.unlistShapes(extra);
        assertEq(balancer.getActiveShapes()[0], 10);
        uint256 surplus = balancer.withdrawableSurplus();
        assertGt(surplus, 0);
        uint256 before = creator.balance;
        vm.prank(creator); balancer.claimSurplus(surplus, creator);
        assertEq(creator.balance - before, surplus);

        // New creations follow the new limits.
        PoolBalancer.CreationConfig memory cfg = PoolBalancer.CreationConfig(1_500, 400, _single(5), shapes.mintFee(), false,
            factory.creationSettingsHash());
        vm.prank(stranger); vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        factory.createBalancer{value: 1 ether}(bytes32(uint256(9)), cfg, new PoolBalancer.CuratedInput[](0));
        cfg.markupBps = 2_000;
        cfg.target = _single(11);
        vm.prank(stranger); vm.expectRevert(PoolBalancer.InvalidPlan.selector);
        factory.createBalancer{value: 1 ether}(bytes32(uint256(9)), cfg, new PoolBalancer.CuratedInput[](0));
        cfg.target = _single(10);
        vm.prank(stranger);
        factory.createBalancer{value: 1 ether}(bytes32(uint256(9)), cfg, new PoolBalancer.CuratedInput[](0));
    }

    /// Spec §4/§6: the former library mirrors are authoritative views of what the money path enforces: the pool's
    /// own bucket, and bounds derived from its effective economics. The 0.311 ETH outer ceiling no longer exists.
    function test_effectiveValueGetters() public {
        createBalancer(1 ether);
        assertEq(balancer.keeperBucketCapacity(), 0.622 ether);
        assertEq(balancer.keeperBucketRefill(), uint256(0.05 ether) / 12);
        assertEq(balancer.keeperBucketRefill(), 4_166_666_666_666_666);
        assertEq(balancer.maxRestockSurchargePerShape(), V1_RESTOCK_GAS * 5 gwei + 0.0002 ether);
        assertEq(balancer.policyMaxReward(), (3_200_000 + V1_OVERHEAD) * 5 gwei + 0.0002 ether);
        assertEq(balancer.availableKeeperAllowance(), 0.622 ether);
    }
}
