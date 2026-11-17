// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {BalancerFactory} from "../src/BalancerFactory.sol";
import {Settings, SettingsLib} from "../src/Settings.sol";

/// @notice Adjustable settings (decision 88): the factory admin's defaults, a creator's overrides, the fixed limits, and
///         what each setting reaches. Numbers below are written out, not read from the contracts' own defaults.
contract SettingsTest is ForkBase {
    bytes32 internal constant KEEPER_PAID = keccak256("KeeperPaid(address,uint256,uint256)");

    function setUp() public {
        setUpFork();
        createBalancer(20 ether);
        configure(plan([uint256(10), 2, 1, 0, 0, 0, 0, 0, 0]));
        listCurated(1, 0.3 ether);
        vm.prank(creator);
        balancer.open();
    }

    function _defaults() internal pure returns (Settings memory) {
        return Settings(5 gwei, 0.05 gwei, 0.0001 ether, 0.0001 ether, 3_200_000, 50_000, 900_000, 1_000);
    }

    function _setDefaults(Settings memory s) internal {
        vm.prank(keeperAdmin);
        factory.setSettings(s);
    }

    function _eq(Settings memory a, Settings memory b) internal pure {
        assertEq(abi.encode(a), abi.encode(b), "settings");
    }

    // ------------------------------------------------------------------ defaults and the admin

    function test_defaults() public view {
        _eq(factory.settings(), _defaults());
        _eq(balancer.settings(), _defaults());
        assertEq(balancer.maxKeeperReward(), 0.01635 ether, "(3.2M + 50k) x 5 gwei + 0.0001");
    }

    function test_onlyTheAdminSetsDefaults() public {
        vm.prank(stranger);
        vm.expectRevert(BalancerFactory.Unauthorized.selector);
        factory.setSettings(_defaults());
        vm.prank(creator);
        vm.expectRevert(BalancerFactory.Unauthorized.selector);
        factory.setSettings(_defaults());
    }

    /// Every field is refused one step outside its limits and accepted at them.
    function test_adminDefaultsStayWithinLimits() public {
        Settings memory lo = Settings(1 gwei, 0, 0, 0, 3_200_000, 50_000, 900_000, 1);
        Settings memory hi = Settings(50 gwei, 2 gwei, 0.001 ether, 0.002 ether, 6_000_000, 200_000, 2_000_000, 1_000);
        _setDefaults(lo);
        _eq(factory.settings(), lo);
        _setDefaults(hi);
        _eq(factory.settings(), hi);

        Settings[14] memory bad;
        for (uint256 i; i < 14; ++i) bad[i] = _defaults();
        bad[0].maxGasPrice = 1 gwei - 1;
        bad[1].maxGasPrice = 50 gwei + 1;
        bad[2].priorityCap = 2 gwei + 1;
        bad[3].incentive = 0.001 ether + 1;
        bad[4].restockFlat = 0.002 ether + 1;
        bad[5].maxGas = 3_200_000 - 1;
        bad[6].maxGas = 6_000_000 + 1;
        bad[7].overheadGas = 50_000 - 1;
        bad[8].overheadGas = 200_000 + 1;
        bad[9].restockGas = 900_000 - 1; // overheadGas 50k + 850k
        bad[10].restockGas = 2_000_000 + 1;
        bad[11].maxPrizes = 0;
        bad[12].maxPrizes = 1_001;
        bad[13].overheadGas = 50_001; // more overhead paid than the restocking fee's 900k gas covers
        for (uint256 i; i < 14; ++i) {
            vm.prank(keeperAdmin);
            vm.expectRevert(SettingsLib.SettingOutOfRange.selector);
            factory.setSettings(bad[i]);
        }
    }

    // ------------------------------------------------------------------ the creator's overrides

    function test_onlyTheCreatorOverrides() public {
        vm.prank(stranger);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.setOverrides(1, 10 gwei, 0, 0, 0);
        vm.prank(keeperAdmin);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.setOverrides(1, 10 gwei, 0, 0, 0);
    }

    function test_overridesStayWithinLimits() public {
        vm.startPrank(creator);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        balancer.setOverrides(16, 0, 0, 0, 0);
        vm.expectRevert(SettingsLib.SettingOutOfRange.selector);
        balancer.setOverrides(1, 50 gwei + 1, 0, 0, 0);
        vm.expectRevert(SettingsLib.SettingOutOfRange.selector);
        balancer.setOverrides(1, 1 gwei - 1, 0, 0, 0);
        vm.expectRevert(SettingsLib.SettingOutOfRange.selector);
        balancer.setOverrides(2, 0, 2 gwei + 1, 0, 0);
        vm.expectRevert(SettingsLib.SettingOutOfRange.selector);
        balancer.setOverrides(4, 0, 0, 0.001 ether + 1, 0);
        vm.expectRevert(SettingsLib.SettingOutOfRange.selector);
        balancer.setOverrides(8, 0, 0, 0, 0.002 ether + 1);
        balancer.setOverrides(15, 50 gwei, 2 gwei, 0.001 ether, 0.002 ether);
        vm.stopPrank();
        Settings memory s = balancer.settings();
        assertEq(s.maxGasPrice, 50 gwei);
        assertEq(s.priorityCap, 2 gwei);
        assertEq(s.incentive, 0.001 ether);
        assertEq(s.restockFlat, 0.002 ether);
    }

    /// An override wins over the factory; a clear bit follows the factory, including later admin changes.
    function test_overridesAndDefaultsCombine() public {
        vm.prank(creator);
        balancer.setOverrides(4, 0, 0, 0.0005 ether, 0); // incentive only
        Settings memory d = _defaults();
        d.priorityCap = 1 gwei;
        d.incentive = 0.0003 ether;
        _setDefaults(d);
        Settings memory s = balancer.settings();
        assertEq(s.incentive, 0.0005 ether, "the creator's incentive");
        assertEq(s.priorityCap, 1 gwei, "the admin's new priority cap reaches the pool");
        vm.prank(creator);
        balancer.setOverrides(0, 0, 0, 0, 0);
        assertEq(balancer.settings().incentive, 0.0003 ether, "cleared: back to the factory");
        // Other pools of the factory follow the admin and not this creator.
        vm.prank(stranger);
        PoolBalancer other = PoolBalancer(payable(factory.createBalancer{value: 1 ether}(bytes32(uint256(7)))));
        assertEq(other.settings().incentive, 0.0003 ether);
    }

    // ------------------------------------------------------------------ what each setting reaches

    /// Reward = (measured gas + overheadGas) x min(bid, basefee + priorityCap, maxGasPrice) + incentive.
    function test_upkeepPaysUnderTheSettingsInForce() public {
        vm.prank(creator);
        balancer.setOverrides(2 | 4, 0, 1 gwei, 0.0005 ether, 0);
        Settings memory d = _defaults();
        d.overheadGas = 120_000;
        d.restockGas = 970_000; // the restocking fee's gas stays at least overheadGas + 850k
        _setDefaults(d);
        vm.fee(0.5 gwei);
        vm.txGasPrice(2 gwei); // bid above basefee + priority cap: reimbursed at 1.5 gwei
        bytes32 uh1 = balancer.settingsHash();
        vm.recordLogs();
        vm.prank(keeper, keeper);
        uint256 reward = balancer.performUpkeep(uh1);
        (uint256 paid, uint256 measured) = _paid();
        assertEq(paid, reward);
        assertGt(measured, 0);
        assertEq(paid, (measured + 120_000) * 1.5 gwei + 0.0005 ether, "pay follows overhead, priority cap and incentive");
        assertLe(paid, balancer.maxKeeperReward());
    }

    function test_maxGasCapsMeasuredGas() public {
        // A first stocking upkeep measures more than 1M gas; with the lowest cap it is paid in full under 3.2M.
        vm.recordLogs();
        upkeep();
        (, uint256 measured) = _paid();
        assertLe(measured, 3_200_000);
        assertEq(balancer.maxKeeperReward(), (3_200_000 + 50_000) * 5 gwei + 0.0001 ether);
        Settings memory d = _defaults();
        d.maxGas = 6_000_000;
        _setDefaults(d);
        assertEq(balancer.maxKeeperReward(), (6_000_000 + 50_000) * 5 gwei + 0.0001 ether, "the cap raises the bound");
    }

    /// Restocking fee per Shape = restockGas x min(basefee + priorityCap, maxGasPrice) + incentive + restockFlat, at
    /// listing.
    function test_restockFeeFollowsTheSettings() public {
        vm.fee(20 gwei);
        assertEq(balancer.restockFee(), 900_000 * 5 gwei + 0.0002 ether, "default: capped at 5 gwei, unchanged");
        vm.prank(creator);
        balancer.setOverrides(1 | 8, 30 gwei, 0, 0, 0.001 ether);
        assertEq(balancer.restockFee(), 900_000 * 20.05 gwei + 0.0001 ether + 0.001 ether, "creator's cap and flat fee");
        Settings memory d = _defaults();
        d.restockGas = 1_200_000;
        _setDefaults(d);
        uint256 fee = 1_200_000 * 20.05 gwei + 0.0001 ether + 0.001 ether;
        assertEq(balancer.restockFee(), fee, "admin's gas with the creator's overrides");
        // The next prize listed carries exactly that fee per Shape on top of its base.
        vm.txGasPrice(20.05 gwei);
        upkeep();
        uint256[] memory ids = balancer.getActiveIds();
        (uint8 kind,,, uint112 base, uint112 price) = balancer.items(ids[ids.length - 1]);
        assertEq(kind, 2);
        assertEq(uint256(price) - base, fee, "listed at base plus this fee");
    }

    /// The reserve holds one maximum reward per upkeep its work needs (plus one), at the settings in force.
    function test_reserveFollowsTheMaxReward() public {
        uint256 before = balancer.requiredReserve();
        uint256 r0 = (3_200_000 + 50_000) * 5 gwei + 0.0001 ether;
        Settings memory d = _defaults();
        d.maxGasPrice = 10 gwei;
        _setDefaults(d);
        uint256 r1 = (3_200_000 + 50_000) * 10 gwei + 0.0001 ether;
        uint256 rewards = (balancer.requiredReserve() - before) / (r1 - r0);
        assertEq(balancer.requiredReserve() - before, rewards * (r1 - r0), "only the reward part moved");
        assertGt(rewards, 0);
    }

    /// The prize limit applies when a design is saved; a saved design above a lowered limit stays as it is.
    function test_maxPrizesAppliesAtConfigure() public {
        uint256 t = balancer.target();
        Settings memory d = _defaults();
        d.maxPrizes = 10;
        _setDefaults(d);
        assertEq(balancer.target(), t, "saved design untouched");
        vm.startPrank(creator);
        vm.expectRevert(PoolBalancer.InvalidPlan.selector);
        balancer.configure(MARKUP, plan([uint256(11), 0, 0, 0, 0, 0, 0, 0, 0]));
        balancer.configure(MARKUP, plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        vm.stopPrank();
        d.maxPrizes = 1_000;
        _setDefaults(d);
        vm.prank(creator);
        balancer.configure(MARKUP, plan([uint256(1_000), 0, 0, 0, 0, 0, 0, 0, 0]));
    }

    /// With every setting at its maximum, prizes keep their exact backing: settings reach keeper pay and restocking
    /// fees only. Unlisting redeems each Shape for its face value, and every reward stays within the bound.
    function test_backingUntouchedAtTheLimits() public {
        _setDefaults(Settings(50 gwei, 2 gwei, 0.001 ether, 0.002 ether, 6_000_000, 200_000, 2_000_000, 1_000));
        vm.prank(creator);
        balancer.setOverrides(15, 50 gwei, 2 gwei, 0.001 ether, 0.002 ether);
        vm.deal(creator, 100 ether);
        vm.prank(creator);
        balancer.depositETH{value: 50 ether}();
        vm.fee(40 gwei);
        vm.txGasPrice(42 gwei);
        uint256 maxReward = balancer.maxKeeperReward();
        assertEq(maxReward, (6_000_000 + 200_000) * 50 gwei + 0.001 ether, "0.311 ETH");
        for (uint256 i; i < 10; ++i) {
            bytes32 uh2 = balancer.settingsHash();
            vm.recordLogs();
            vm.prank(keeper, keeper);
            try balancer.performUpkeep(uh2) returns (uint256 reward) {
                assertLe(reward, maxReward);
            } catch {
                break;
            }
        }
        // Unlist every listed Shape: the balance rises by exactly their face values.
        uint256[] memory ids = balancer.getActiveIds();
        uint256[] memory shapeIds = new uint256[](ids.length);
        uint256 n;
        uint256 face;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 d,,,) = balancer.items(ids[i]);
            if (kind != 2) continue;
            shapeIds[n++] = ids[i];
            face += balancer.denominationAmount(d);
        }
        assembly ("memory-safe") {
            mstore(shapeIds, n)
        }
        assertGt(n, 0);
        uint256 before = address(balancer).balance;
        vm.prank(creator);
        balancer.unlistShapes(shapeIds);
        assertEq(address(balancer).balance - before, face, "each Shape redeemed for its exact backing");
    }

    // ------------------------------------------------------------------ audit rc-f5c81d6 F1 and F2

    /// F1: a keeper's upkeep priced on one set of settings does not run under another. Lowering the cap between the
    /// keeper's read and its call reverts the call at its start instead of paying below its gas.
    function test_upkeepRefusesSettingsChangedSinceTheKeeperRead() public {
        bytes32 priced = balancer.settingsHash();
        assertEq(priced, keccak256(abi.encode(balancer.settings())));
        vm.prank(creator);
        balancer.setOverrides(1, 1 gwei, 0, 0, 0);
        vm.fee(4 gwei);
        vm.txGasPrice(4 gwei);
        vm.prank(keeper, keeper);
        vm.expectRevert(PoolBalancer.StaleSettings.selector);
        balancer.performUpkeep(priced);
        // A change by the admin is caught the same way.
        priced = balancer.settingsHash();
        Settings memory d = _defaults();
        d.incentive = 0;
        _setDefaults(d);
        vm.prank(keeper, keeper);
        vm.expectRevert(PoolBalancer.StaleSettings.selector);
        balancer.performUpkeep(priced);
        // Read again, the call runs.
        bytes32 uh3 = balancer.settingsHash();
        vm.prank(keeper, keeper);
        balancer.performUpkeep(uh3);
    }

    /// F2: at the lowest restocking fee the limits allow (restockGas = overheadGas + 850k, no flat fee) and the
    /// highest incentive, the fee carried by a won Shape still covers the upkeep that reconciles that draw and
    /// restocks it, paid at the same gas price.
    function test_lowestRestockFeeCoversItsRestock() public {
        Settings memory d = _defaults();
        d.overheadGas = 50_000;
        d.restockGas = 900_000;
        d.restockFlat = 0;
        d.incentive = 0.001 ether;
        _setDefaults(d);
        vm.fee(5 gwei);
        vm.txGasPrice(5 gwei);
        vm.startPrank(creator);
        balancer.configure(MARKUP, plan([uint256(30), 0, 0, 0, 0, 0, 0, 0, 0]));
        vm.stopPrank();
        fillUp();
        // Draw one 0.01 Shape listed under these settings.
        uint256 lid = lastListingId();
        (, , , uint112 base, uint112 price) = balancer.items(lid);
        uint256 fee = 900_000 * 5 gwei + 0.001 ether;
        assertGe(uint256(price) - base, fee, "listed with the floor fee");
        (,,,,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        bytes32 uh4 = balancer.settingsHash();
        vm.recordLogs();
        vm.prank(keeper, keeper);
        balancer.performUpkeep(uh4);
        (uint256 paid, uint256 measured) = _paid();
        emit log_named_uint("reconcile + restock one Shape, measured gas", measured);
        emit log_named_uint("keeper paid (wei)", paid);
        emit log_named_uint("restocking fee in the won Shape (wei)", fee);
        assertGe(fee, paid, "the won Shape's fee covers its restock");
    }

    function _paid() internal returns (uint256 amount, uint256 measured) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == KEEPER_PAID) (amount, measured) = abi.decode(logs[i].data, (uint256, uint256));
        }
    }
}
