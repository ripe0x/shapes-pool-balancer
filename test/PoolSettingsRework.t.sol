// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer, IBalancerFactory} from "../src/PoolBalancer.sol";
import {BalancerFactory} from "../src/BalancerFactory.sol";
import {KeeperPolicyCalls} from "../src/KeeperPolicyCalls.sol";
import {KeeperPolicyV1} from "../src/KeeperPolicyV1.sol";
import {IKeeperPolicy} from "../src/interfaces/IKeeperPolicy.sol";

/// @dev A policy that pays near the per-call ceiling for any reconcile, to show the allowance removal: repeated large
///      rewards are each paid, with no per-pool burst/refill budget to deplete.
contract MaxRewardPolicy is IKeeperPolicy {
    function interfaceVersion() external pure returns (uint256) { return 1; }
    function version() external pure returns (uint256) { return 9; }
    function maxReward() external pure returns (uint256) { return 0.311 ether; }
    function quoteReward(Work calldata) external pure returns (uint256) { return 0.311 ether; }
    function quoteRestock(uint8, uint256 units, uint256 baseFee) external pure returns (uint256) {
        return units * (900_000 * (baseFee + 0.05 gwei) + 0.0002 ether);
    }
}

/// @dev A restock quote of exactly `perUnit` wei per Shape unit, to probe the basefee-indexed cap boundary.
contract FlatRestockPolicy is IKeeperPolicy {
    uint256 public immutable perUnit;
    constructor(uint256 perUnit_) { perUnit = perUnit_; }
    function interfaceVersion() external pure returns (uint256) { return 1; }
    function version() external pure returns (uint256) { return 8; }
    function maxReward() external pure returns (uint256) { return 0.3 ether; }
    function quoteReward(Work calldata) external pure returns (uint256) { return 0; }
    function quoteRestock(uint8, uint256 units, uint256) external view returns (uint256) { return units * perUnit; }
}

contract PoolSettingsReworkTest is ForkBase {
    event SettingChanged(bytes32 indexed key, uint256 value);
    event SettingsSynced(uint16 fillGateBps);

    function setUp() public { setUpFork(); }
    // The test contract is the factory's policyAdmin (see ForkBase.setUpFork).

    function _open(uint256 deposit, uint256 target) internal {
        createBalancer(deposit);
        configure(target);
        listCurated(1, 0.2 ether);
        vm.prank(creator); balancer.open();
        fillUp();
    }

    /// @dev `n` active Shape-prize listing ids (kind == 2).
    function _shapeIds(uint256 n) internal view returns (uint256[] memory out) {
        out = new uint256[](n);
        uint256[] memory all = balancer.getActiveIds();
        uint256 k;
        for (uint256 i; i < all.length && k < n; ++i) {
            (uint8 kind,,,,) = balancer.items(all[i]);
            if (kind == 2) out[k++] = all[i];
        }
        require(k == n, "not enough shapes");
    }

    /*//////////////////////// 1. setters: auth, bounds, event, immediate ////////////////////////*/

    function test_setters_authBoundsEventImmediate() public {
        // auth: only the policyAdmin
        vm.prank(stranger); vm.expectRevert(BalancerFactory.Unauthorized.selector); factory.setMaxPrizes(500);
        // bounds (fixed): below and above are rejected
        vm.expectRevert(BalancerFactory.OutOfRange.selector); factory.setMaxPrizes(0);
        vm.expectRevert(BalancerFactory.OutOfRange.selector); factory.setMaxPrizes(1001);
        vm.expectRevert(BalancerFactory.OutOfRange.selector); factory.setFillGateBps(10001);
        vm.expectRevert(BalancerFactory.OutOfRange.selector); factory.setMaxOps(0);
        vm.expectRevert(BalancerFactory.OutOfRange.selector); factory.setMaxOps(9);
        vm.expectRevert(BalancerFactory.OutOfRange.selector); factory.setMaxReconcile(11);
        vm.expectRevert(BalancerFactory.OutOfRange.selector); factory.setMaxProcess(3);
        vm.expectRevert(BalancerFactory.OutOfRange.selector); factory.setMaxRestockSizes(9);
        vm.expectRevert(BalancerFactory.OutOfRange.selector); factory.setCuratedBatch(51);
        // markup bounds are a nonempty pair: min may not exceed max, max may not fall below min
        vm.expectRevert(BalancerFactory.OutOfRange.selector); factory.setMinMarkupBps(10001);
        vm.expectRevert(BalancerFactory.OutOfRange.selector); factory.setMaxMarkupBps(999); // below current min 1000

        // event + immediate effect
        vm.expectEmit(true, false, false, true, address(factory));
        emit SettingChanged("maxPrizes", 500);
        factory.setMaxPrizes(500);
        assertEq(factory.getSettings().maxPrizes, 500);

        vm.expectEmit(true, false, false, true, address(factory));
        emit SettingChanged("fillGateBps", 8000);
        factory.setFillGateBps(8000);
        assertEq(factory.getSettings().fillGateBps, 8000);

        factory.setMaxOps(8); assertEq(factory.getSettings().maxOps, 8);
        factory.setMaxReconcile(10); assertEq(factory.getSettings().maxReconcile, 10);
        factory.setMaxProcess(1); assertEq(factory.getSettings().maxProcess, 1);
        factory.setMaxRestockSizes(8); assertEq(factory.getSettings().maxRestockSizes, 8);
        factory.setCuratedBatch(50); assertEq(factory.getSettings().curatedBatch, 50);
        factory.setMaxMarkupBps(5000); factory.setMinMarkupBps(2000);
        assertEq(factory.getSettings().minMarkupBps, 2000);
        assertEq(factory.getSettings().maxMarkupBps, 5000);
    }

    function test_defaults_matchFormerConstants() public view {
        IBalancerFactory.Settings memory s = factory.getSettings();
        assertEq(s.maxPrizes, 1000);
        assertEq(s.fillGateBps, 7000);
        assertEq(s.minMarkupBps, 1000);
        assertEq(s.maxMarkupBps, 10000);
        assertEq(s.maxOps, 5);
        assertEq(s.maxReconcile, 5);
        assertEq(s.maxProcess, 2);
        assertEq(s.maxRestockSizes, 4);
        assertEq(s.curatedBatch, 20);
    }

    /*//////////////////////// 2. settings propagate to a pool ////////////////////////*/

    function test_maxPrizesPropagatesAndDoesNotInvalidateExistingConfig() public {
        _open(5 ether, plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        // Lower the limit below the pool's current 20-prize target.
        factory.setMaxPrizes(5);
        // The already-configured pool keeps operating; validation only applies at the next configure.
        assertEq(balancer.target(), plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        assertTrue(balancer.canPurchase(buyer));
        // A new configure above the limit is rejected; at or below it is accepted.
        vm.prank(creator); vm.expectRevert(); balancer.configure(MARKUP, plan([uint256(6), 0, 0, 0, 0, 0, 0, 0, 0]));
        vm.prank(creator); balancer.configure(MARKUP, plan([uint256(5), 0, 0, 0, 0, 0, 0, 0, 0]));
        assertEq(balancer.target(), plan([uint256(5), 0, 0, 0, 0, 0, 0, 0, 0]));
    }

    function test_markupBoundsPropagate() public {
        _open(5 ether, plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        uint256 t = balancer.target();
        factory.setMaxMarkupBps(2000);
        vm.prank(creator); vm.expectRevert(); balancer.configure(3000, t); // above the new max
        vm.prank(creator); balancer.configure(2000, t);
        assertEq(balancer.markupBps(), 2000);
        factory.setMinMarkupBps(1800); // <= current max 2000
        vm.prank(creator); vm.expectRevert(); balancer.configure(1500, t); // below the new min
    }

    /*//////////////////////// 3. cached fill gate + syncSettings ////////////////////////*/

    function test_fillGateCachedAndRefreshPaths() public {
        _open(5 ether, plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        assertEq(balancer.fillGateBps(), 7000, "cached at creation");
        factory.setFillGateBps(9000);
        assertEq(balancer.fillGateBps(), 7000, "pool keeps its cached copy until refreshed");
        // permissionless sync refreshes it and emits
        vm.expectEmit(false, false, false, true, address(balancer));
        emit SettingsSynced(9000);
        vm.prank(stranger); balancer.syncSettings();
        assertEq(balancer.fillGateBps(), 9000);
        // configure also refreshes
        factory.setFillGateBps(6000);
        uint256 t = balancer.target();
        vm.prank(creator); balancer.configure(MARKUP, t);
        assertEq(balancer.fillGateBps(), 6000);
        // performUpkeep refreshes
        factory.setFillGateBps(5000);
        uint256[] memory ids = _shapeIds(1);
        vm.prank(creator); balancer.unlistShapes(ids); // create work so upkeep does something
        upkeep();
        assertEq(balancer.fillGateBps(), 5000);
    }

    function test_fillGateChangeShiftsAdmissionAfterSync() public {
        _open(5 ether, plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        assertEq(balancer.admissionStatus(), 0, "full board admitted at the 7000 default");
        // Create a 10% deficit while open: the board was already set up, so this is not SETTING_UP.
        uint256[] memory ids = _shapeIds(2);
        vm.prank(creator); balancer.unlistShapes(ids);
        assertEq(balancer.admissionStatus(), 0, "a 90% board still clears the 7000 gate");
        factory.setFillGateBps(9500); // require 95% of target weight
        assertEq(balancer.admissionStatus(), 0, "pool keeps its cached 7000 gate until synced");
        vm.prank(stranger); balancer.syncSettings();
        assertEq(balancer.admissionStatus(), 6, "the stricter cached gate now pauses the incomplete board");
    }

    /*//////////////////////// 4. hook gas stays under FWA's 100k stipend ////////////////////////*/

    function test_admissionHookUnderStipend() public {
        _open(5 ether, plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        vm.prank(address(pool));
        uint256 g = gasleft();
        balancer.canPurchase(buyer);
        uint256 used = g - gasleft();
        emit log_named_uint("canPurchase (admission hook) gas", used);
        assertLt(used, 100_000, "hook must fit FWA's 100k stipend");
        // The cache read is local storage; a factory settings change does not raise the hook cost.
        factory.setFillGateBps(9000);
        vm.prank(stranger); balancer.syncSettings();
        vm.prank(address(pool));
        g = gasleft();
        balancer.canPurchase(buyer);
        uint256 after_ = g - gasleft();
        emit log_named_uint("canPurchase gas after a settings change + sync", after_);
        assertLt(after_, 100_000);
    }

    /*//////////////////////// 5. immediate policy switch + re-enable with funding ////////////////////////*/

    function test_immediatePolicySwitchAndReenable() public {
        _open(5 ether, plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        address v1 = balancer.keeperPolicy();
        KeeperPolicyV1 same = new KeeperPolicyV1(); // equal exposure, no funding needed
        vm.prank(creator); balancer.setKeeperPolicy(address(same));
        assertEq(balancer.keeperPolicy(), address(same), "switch is immediate");
        assertTrue(balancer.paidUpkeepEnabled());
        // emergency stop then immediate re-enable (equal exposure funds with no top-up)
        vm.prank(creator); balancer.setPaidUpkeepEnabled(false);
        assertFalse(balancer.paidUpkeepEnabled());
        vm.prank(creator); balancer.setPaidUpkeepEnabled(true);
        assertTrue(balancer.paidUpkeepEnabled());
        // authorization: only the creator
        vm.prank(stranger); vm.expectRevert(PoolBalancer.Unauthorized.selector); balancer.setKeeperPolicy(v1);
    }

    function test_higherExposurePolicyNeedsFundingImmediately() public {
        _open(5 ether, plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        vm.fee(5 gwei); vm.txGasPrice(5.05 gwei);
        MaxRewardPolicy big = new MaxRewardPolicy();
        (uint256 required, uint256 shortfall) = balancer.policyFunding(address(big));
        // Drain operating cash so the higher exposure is underfunded.
        uint256 free = balancer.withdrawableSurplus();
        vm.prank(creator); balancer.claimSurplus(free, creator);
        (required, shortfall) = balancer.policyFunding(address(big));
        assertGt(shortfall, 0);
        vm.prank(creator); vm.expectRevert(PoolBalancer.ReserveNotFunded.selector); balancer.setKeeperPolicy(address(big));
        vm.prank(creator); balancer.depositETH{value: shortfall}();
        vm.prank(creator); balancer.setKeeperPolicy(address(big));
        assertEq(balancer.keeperPolicy(), address(big));
        required;
    }

    /*//////////////////////// 6. factory default change affects only new pools ////////////////////////*/

    function test_factoryDefaultChangeOnlyAffectsNewPools() public {
        PoolBalancer a = _createFixture(creator, bytes32(uint256(1)), 0.5 ether);
        address v1 = a.keeperPolicy();
        KeeperPolicyV1 v2 = new KeeperPolicyV1();
        // auth: keeperAdmin is not the policyAdmin
        vm.prank(keeperAdmin); vm.expectRevert(BalancerFactory.Unauthorized.selector); factory.setDefaultKeeperPolicy(address(v2));
        factory.setDefaultKeeperPolicy(address(v2)); // test contract is policyAdmin
        assertEq(factory.defaultKeeperPolicy(), address(v2));
        assertEq(a.keeperPolicy(), v1, "existing pool keeps its snapshotted policy");
        PoolBalancer b = _createFixture(creator, bytes32(uint256(2)), 0.5 ether);
        assertEq(b.keeperPolicy(), address(v2), "a new pool snapshots the new default");
    }

    /*//////////////////////// 7. restock cap at several basefees (V1 always passes) ////////////////////////*/

    function _refPrice(uint256 baseFee) internal pure returns (uint256 p) {
        p = baseFee + 0.1 gwei;
        if (p > 50 gwei) p = 50 gwei;
    }
    function _capPerUnit(uint256 baseFee) internal pure returns (uint256) {
        return 1_800_000 * _refPrice(baseFee) + 0.0004 ether;
    }

    function test_restockCapBoundaryAtSeveralBasefees() public {
        _open(50 ether, plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        uint256[3] memory fees = [uint256(0.5 gwei), 5 gwei, 50 gwei];
        for (uint256 i; i < fees.length; ++i) {
            vm.fee(fees[i]);
            // A policy quoting exactly the per-unit cap is accepted (paid path returns the quote).
            FlatRestockPolicy atCap = new FlatRestockPolicy(_capPerUnit(fees[i]));
            vm.prank(creator); balancer.setKeeperPolicy(address(atCap));
            assertEq(balancer.restockFeeFor(0), _capPerUnit(fees[i]), "quote at the cap passes");
            // A policy quoting one wei above the cap is refused on the paid path.
            FlatRestockPolicy overCap = new FlatRestockPolicy(_capPerUnit(fees[i]) + 1);
            vm.prank(creator); balancer.setKeeperPolicy(address(overCap));
            vm.expectRevert(PoolBalancer.PolicyUnavailable.selector); balancer.restockFeeFor(0);
        }
    }

    function test_v1RestockAlwaysWithinCap() public {
        _open(5 ether, plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        // V1 is the default policy; its per-Shape surcharge must never exceed the cap, at any basefee.
        uint256[4] memory fees = [uint256(0.08 gwei), 1 gwei, 10 gwei, 50 gwei];
        for (uint256 i; i < fees.length; ++i) {
            vm.fee(fees[i]);
            uint256 fee = balancer.restockFeeFor(0); // 1 Shape unit
            assertLe(fee, _capPerUnit(fees[i]), "V1 always passes the cap");
            assertGt(fee, 0);
        }
    }

    /*//////////////////////// 8. allowance removal: no per-pool burst/refill budget ////////////////////////*/

    function test_noAllowanceCapsCumulativePayInZeroElapsedTime() public {
        _open(200 ether, plan([uint256(30), 0, 0, 0, 0, 0, 0, 0, 0]));
        vm.fee(50 gwei); vm.txGasPrice(50 gwei);
        MaxRewardPolicy big = new MaxRewardPolicy();
        (, uint256 shortfall) = balancer.policyFunding(address(big));
        if (shortfall > 0) { vm.prank(creator); balancer.depositETH{value: shortfall}(); }
        vm.prank(creator); balancer.setKeeperPolicy(address(big));
        // Empty the board while open (30-unit deficit, no SETTING_UP). Resolve ids before the prank: the view
        // calls inside _shapeIds would otherwise consume it.
        uint256[] memory ids20 = _shapeIds(20);
        vm.prank(creator); balancer.unlistShapes(ids20);
        uint256[] memory ids10 = _shapeIds(10);
        vm.prank(creator); balancer.unlistShapes(ids10);
        assertEq(balancer.getActiveShapes()[0], 0);
        // Restock it with paid upkeeps, every call pinned to the SAME timestamp: under the removed burst/refill
        // allowance (0.622 ETH, refilled only by elapsed time) the cumulative pay would stall; now it does not.
        uint256 t = vm.getBlockTimestamp();
        uint256 total;
        bytes32 h = balancer.settingsHash();
        for (uint256 i; i < 12 && balancer.getActiveShapes()[0] < 30; ++i) {
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(t); // no time elapses, so an allowance would never refill
            vm.prank(keeper, keeper);
            total += balancer.performUpkeep(h, 1, 0);
        }
        assertEq(balancer.getActiveShapes()[0], 30, "board fully restocked");
        assertGt(total, 0.622 ether, "cumulative pay in zero elapsed time exceeds the removed 0.622 ETH burst cap");
        assertEq(balancer.HARD_MAX_KEEPER_REWARD(), KeeperPolicyCalls.HARD_MAX_REWARD);
    }
}
