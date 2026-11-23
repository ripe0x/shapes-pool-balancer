// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {KeeperPolicyV1} from "../src/KeeperPolicyV1.sol";
import {IKeeperPolicy} from "../src/interfaces/IKeeperPolicy.sol";
import {KeeperPolicyCalls} from "../src/KeeperPolicyCalls.sol";
import {BalancerFactory} from "../src/BalancerFactory.sol";

/// @notice Real alternative economic policy accepted by the stable core protocol.
contract KeeperPolicyV2 is IKeeperPolicy {
    function interfaceVersion() external pure returns (uint256) { return 1; }
    function version() external pure returns (uint256) { return 2; }
    function maxReward() external pure returns (uint256) { return 0.03 ether; }
    function quoteReward(Work calldata w) external pure returns (uint256) {
        uint256 price = w.baseFee + 0.02 gwei;
        if (price > w.gasPrice) price = w.gasPrice;
        if (price > 8 gwei) price = 8 gwei;
        return ((w.measuredGas > 3_200_000 ? 3_200_000 : w.measuredGas) + 70_000) * price
            + w.reconciledDraws * 0.00001 ether + w.listedPrizes * 0.00004 ether;
    }
    function quoteRestock(uint8 d, uint256 units, uint256 baseFee) external pure returns (uint256) {
        uint256 price = baseFee + 0.02 gwei;
        if (price > 8 gwei) price = 8 gwei;
        return (d < 9 ? 950_000 : 1_100_000) * price + units * 0.00025 ether;
    }
}

contract HostilePolicy is IKeeperPolicy {
    uint256 immutable mode;
    constructor(uint256 m) { mode = m; }
    function interfaceVersion() external pure returns (uint256) { return 1; }
    function version() external pure returns (uint256) { return 99; }
    function maxReward() external pure returns (uint256) { return 0.311 ether; }
    function quoteReward(Work calldata) external view returns (uint256) { return _hostile(); }
    function quoteRestock(uint8, uint256, uint256) external view returns (uint256) { return _hostile(); }
    function _hostile() internal view returns (uint256) {
        uint256 m = mode;
        if (m == 0) return type(uint256).max;
        if (m == 1) assembly ("memory-safe") { mstore(0, 1) return(0, 1) }
        if (m == 2) revert("policy unavailable");
        if (m == 3) {
            // A policy's static context propagates through this call, so state-changing reentry cannot succeed.
            (bool ok,) = msg.sender.staticcall(abi.encodeWithSignature("performUpkeepUnpaid()"));
            require(!ok, "reentry succeeded");
            return 0.00001 ether;
        }
        if (m == 4) { while (gasleft() > 100) {} revert("gas exhausted"); }
        if (m == 5) assembly ("memory-safe") { return(0, 65536) }
        return 0;
    }
}

/// @dev Environment witness, not a protocol counterparty. Clearing an existing slot creates a known 4,800 refund.
contract GasAccountingWitness {
    uint256 public value = 1;
    event Cleared(uint256 grossStorageSpan);
    function clear() external returns (uint256 span) {
        uint256 g = gasleft();
        value = 0;
        span = g - gasleft();
        emit Cleared(span);
    }
}

contract SettingsTest is ForkBase {
    function setUp() public { setUpFork(); }

    function _open(uint256 deposit) internal {
        createBalancer(deposit);
        configure(plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        listCurated(1, 0.2 ether);
        vm.prank(creator); balancer.open();
        fillUp();
        assertEq(balancer.getActiveShapes()[0], 20);
    }

    function _switch(address policy) internal {
        vm.prank(creator); balancer.setKeeperPolicy(policy);
    }

    function test_policyV1FormulaAbsoluteAndFixture() public {
        KeeperPolicyV1 policy = new KeeperPolicyV1();
        IKeeperPolicy.Work memory w = IKeeperPolicy.Work(800_000, 0.55 gwei, 0.5 gwei, 1, 1, 1, 0);
        assertEq(policy.quoteReward(w), 0.0005075 ether);
        assertEq(policy.quoteRestock(0, 1, 0.5 gwei), 0.000695 ether);
        assertEq(policy.maxReward(), 0.01645 ether);
        string memory key = "keeperPolicyV1";
        vm.serializeString(key, "maxGasPrice", "5000000000");
        vm.serializeString(key, "priorityCap", "50000000");
        vm.serializeString(key, "drawFee", vm.toString(policy.WORK_FEE()));
        vm.serializeString(key, "shapeFee", vm.toString(policy.WORK_FEE()));
        vm.serializeString(key, "restockFlat", vm.toString(policy.RESTOCK_FLAT()));
        vm.serializeString(key, "maxGas", vm.toString(policy.MAX_GAS()));
        vm.serializeString(key, "overheadGas", vm.toString(policy.OVERHEAD_GAS()));
        vm.serializeString(key, "restockGas", vm.toString(policy.RESTOCK_GAS()));
        vm.serializeString(key, "maxPrizes", "1000");
        string memory json = vm.serializeString(key, "maxReward", vm.toString(policy.maxReward()));
        vm.writeJson(json, "./test/fixtures/keeper-policy-v1.json");
    }

    /// Spec §3: the factory default and a pool's policy change in the authorized transaction, with no delay, and a
    /// default change never moves an existing pool. Replaces the former two-day timelock test.
    function test_defaultAndPoolPolicyChangesAreImmediateAndSeparate() public {
        _open(5 ether);
        address initial = balancer.keeperPolicy();
        KeeperPolicyV2 v2 = new KeeperPolicyV2();
        vm.prank(keeperAdmin); vm.expectRevert(BalancerFactory.Unauthorized.selector); factory.setDefaultKeeperPolicy(address(v2));
        vm.prank(stranger); vm.expectRevert(BalancerFactory.Unauthorized.selector); factory.setDefaultKeeperPolicy(address(v2));
        vm.expectRevert(KeeperPolicyCalls.InvalidPolicy.selector); factory.setDefaultKeeperPolicy(stranger);
        uint256 t = vm.getBlockTimestamp();
        factory.setDefaultKeeperPolicy(address(v2));
        assertEq(factory.defaultKeeperPolicy(), address(v2), "default changes in the same transaction");
        assertEq(balancer.keeperPolicy(), initial, "an existing pool keeps its own policy");
        vm.prank(stranger); vm.expectRevert(PoolBalancer.Unauthorized.selector); balancer.setKeeperPolicy(address(v2));
        vm.prank(keeperAdmin); vm.expectRevert(PoolBalancer.Unauthorized.selector); balancer.setKeeperPolicy(address(v2));
        vm.prank(creator); vm.expectRevert(KeeperPolicyCalls.InvalidPolicy.selector); balancer.setKeeperPolicy(stranger);
        vm.prank(creator); balancer.setKeeperPolicy(address(v2));
        assertEq(balancer.keeperPolicy(), address(v2), "pool policy changes in the same transaction");
        assertEq(balancer.policyMaxReward(), 0.03 ether);
        assertEq(vm.getBlockTimestamp(), t, "no time passed");
    }

    /// A policy with a larger maintenance exposure needs that exposure funded at the moment of the change; a pending
    /// withdrawal cannot slip between a check and a later activation because there is none.
    function test_policyChangeRequiresMaintenanceFunding() public {
        _open(5 ether);
        KeeperPolicyV2 v2 = new KeeperPolicyV2();
        // At normal gas both declarations exceed the immutable current-work bound; a higher declaration alone costs nothing.
        (uint256 sameRequired, uint256 noShortfall) = balancer.policyFunding(address(v2));
        assertEq(sameRequired,balancer.requiredReserve());
        assertEq(noShortfall,0);
        vm.fee(5 gwei); vm.txGasPrice(5.05 gwei);
        uint256 claimable = balancer.withdrawableSurplus();
        vm.prank(creator); balancer.claimSurplus(claimable, creator);
        (uint256 required, uint256 shortfall) = balancer.policyFunding(address(v2));
        assertGt(shortfall, 0);
        assertGt(required, address(balancer).balance - balancer.creatorCredit());
        vm.prank(creator); vm.expectRevert(PoolBalancer.ReserveNotFunded.selector); balancer.setKeeperPolicy(address(v2));
        vm.prank(creator); balancer.depositETH{value: shortfall}();
        vm.prank(creator); balancer.setKeeperPolicy(address(v2));
        assertEq(balancer.keeperPolicy(), address(v2));
    }

    /// Spec §2/§3: the creator's emergency stop survives factory changes; only the creator re-enables, immediately, and
    /// the cycle changes the settings hash and keeps spending history. Replaces the former "re-enable needs the delay".
    function test_emergencyDisableSurvivesFactoryAndReenablesImmediately() public {
        _open(5 ether);
        bytes32 old = balancer.settingsHash();
        uint64 generation = balancer.policyGeneration();
        uint256 allowance = balancer.keeperAllowance();
        uint64 allowanceTime = balancer.keeperAllowanceTime();
        vm.prank(stranger); vm.expectRevert(PoolBalancer.Unauthorized.selector); balancer.setPaidUpkeepEnabled(false);
        vm.prank(creator); balancer.setPaidUpkeepEnabled(false);
        bytes32 disabled = balancer.settingsHash();
        assertFalse(balancer.paidUpkeepEnabled());
        assertTrue(old != disabled);
        assertEq(balancer.policyGeneration(), generation + 1);
        factory.setDefaultKeeperPolicy(address(new KeeperPolicyV2()));
        factory.setProductLimits(500, 2_000, 5_000);
        assertFalse(balancer.paidUpkeepEnabled(), "factory changes never re-enable a stopped pool");
        vm.prank(stranger); vm.expectRevert(PoolBalancer.Unauthorized.selector); balancer.setPaidUpkeepEnabled(true);
        vm.prank(keeper); vm.expectRevert(PoolBalancer.PaymentUnavailable.selector); balancer.performUpkeep(disabled, 0, 0);
        vm.prank(creator); balancer.setPaidUpkeepEnabled(true);
        assertTrue(balancer.paidUpkeepEnabled());
        assertTrue(old != balancer.settingsHash(), "same-address re-enable invalidates the original terms");
        assertTrue(disabled != balancer.settingsHash(), "re-enabled terms also differ from disabled terms");
        assertEq(balancer.policyGeneration(), generation + 2);
        assertEq(balancer.keeperAllowance(), allowance, "same-address cycle preserves spending history");
        assertEq(balancer.keeperAllowanceTime(), allowanceTime);
        vm.prank(keeper); vm.expectRevert(PoolBalancer.StaleSettings.selector);
        balancer.performUpkeep(old, 0, 0);
    }

    function test_minimumPaymentRevertsWorkAtomically() public {
        _open(5 ether);
        uint256 id = balancer.getActiveIds()[1];
        uint256[] memory ids = new uint256[](1); ids[0] = id;
        vm.prank(creator); balancer.unlistShapes(ids);
        uint256 beforeIds = lastListingId();
        bytes32 expected = balancer.settingsHash();
        vm.prank(keeper); vm.expectRevert(PoolBalancer.MinimumPaymentNotMet.selector);
        balancer.performUpkeep(expected, 1 ether, 0);
        assertEq(lastListingId(), beforeIds);
        vm.prank(keeper); assertGt(balancer.performUpkeep(expected, 1, 0), 0);
    }

    function test_policyFailureUnpaidWholePathAndRestrictedKeeper() public {
        for (uint256 mode = 1; mode <= 5; ++mode) {
            if (mode == 3) continue;
            uint256 snap = vm.snapshotState();
            _open(100 ether);
            _switch(address(new HostilePolicy(mode)));
            uint256 id = balancer.getActiveIds()[1];
            uint256[] memory ids = new uint256[](1); ids[0] = id;
            vm.prank(creator); balancer.unlistShapes(ids);
            vm.prank(keeperAdmin); factory.setKeepersRestricted(true);
            uint256 count = balancer.listedShapePrizes();
            uint256 received = stranger.balance;
            vm.prank(stranger); balancer.performUpkeepUnpaid();
            assertEq(balancer.listedShapePrizes(), count + 1);
            assertEq(stranger.balance, received);
            vm.prank(creator); balancer.close();
            uint256[] memory all = balancer.getActiveIds();
            uint256[] memory shapeIds = new uint256[](20);
            uint256 n;
            for (uint256 k; k < all.length; ++k) {
                (uint8 kind,,,,) = balancer.items(all[k]);
                if (kind == 2) shapeIds[n++] = all[k];
                else { vm.prank(creator); balancer.withdrawCurated(all[k], creator); }
            }
            assertEq(n, 20);
            vm.prank(creator); balancer.unlistShapes(shapeIds);
            vm.prank(creator); balancer.retire();
            uint256 surplus = balancer.withdrawableSurplus();
            vm.prank(creator); balancer.claimSurplus(surplus, creator);
            assertEq(address(balancer).balance, 0);
            assertEq(_listedFees(balancer), 0);
            vm.revertToState(snap);
        }
    }

    /// Spec §5: a creator transfer keeps the selected policy, the disabled state and spending history; only the new
    /// creator can re-enable. Replaces the former "transfer cancels a pending proposal" (no proposals remain).
    function test_creatorTransferKeepsPolicyDisabledStateAndAllowance() public {
        _open(5 ether);
        KeeperPolicyV2 v2 = new KeeperPolicyV2();
        vm.prank(creator); balancer.setKeeperPolicy(address(v2));
        vm.prank(creator); balancer.setPaidUpkeepEnabled(false);
        uint256 allowance = balancer.keeperAllowance();
        uint64 allowanceTime = balancer.keeperAllowanceTime();
        bytes32 hash = balancer.settingsHash();
        vm.prank(creator); balancer.transferCreator(stranger);
        vm.prank(stranger); balancer.acceptCreator();
        assertEq(balancer.keeperPolicy(), address(v2));
        assertFalse(balancer.paidUpkeepEnabled());
        assertEq(balancer.settingsHash(), hash);
        assertEq(balancer.keeperAllowance(), allowance);
        assertEq(balancer.keeperAllowanceTime(), allowanceTime);
        vm.prank(creator); vm.expectRevert(PoolBalancer.Unauthorized.selector); balancer.setPaidUpkeepEnabled(true);
        vm.prank(stranger); balancer.setPaidUpkeepEnabled(true);
        assertTrue(balancer.paidUpkeepEnabled());
    }
    function test_maximumPolicyRewardRemainsBoundedAndAllowanceNeverResets() public {
        _open(100 ether);
        _switch(address(new HostilePolicy(0)));
        buy(buyer, 1);
        vm.roll(vm.getBlockNumber() + 40);
        uint256 before = balancer.availableKeeperAllowance();
        bytes32 expected = balancer.settingsHash();
        vm.prank(keeper); uint256 reward = balancer.performUpkeep(expected, 1, 0);
        assertGt(reward, 0);
        assertLe(reward, balancer.hardMaxKeeperReward());
        assertEq(balancer.keeperAllowance(), before - reward);
        uint256 stored = balancer.keeperAllowance();
        uint256 stamp = balancer.keeperAllowanceTime();
        vm.prank(creator); balancer.close();
        vm.prank(creator); balancer.open();
        assertEq(balancer.keeperAllowance(), stored, "reopening never resets spend history");
        assertEq(balancer.keeperAllowanceTime(), stamp);
        _switch(balancer.keeperPolicy());
        assertEq(balancer.keeperAllowance(), stored, "a policy change never resets spend history");
        assertEq(balancer.keeperAllowanceTime(), stamp);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        assertEq(balancer.availableKeeperAllowance(), balancer.keeperBucketCapacity(), "idle refill saturates");
        uint256 dayBound = balancer.keeperBucketCapacity() + 1 days * balancer.keeperBucketRefill();
        uint256 yearBound = balancer.keeperBucketCapacity() + 365 days * balancer.keeperBucketRefill();
        assertEq(dayBound, 360.6219999999999424 ether);
        assertEq(yearBound, 131400.621999999978976 ether);
    }

    function test_staticReentryPolicyCannotChangeAnythingOutsideValidatedWork() public {
        _open(100 ether);
        _switch(address(new HostilePolicy(3)));
        buy(buyer, 1);
        vm.roll(vm.getBlockNumber() + 40);
        bytes32 expected = balancer.settingsHash();
        uint256 before = keeper.balance;
        vm.prank(keeper); uint256 reward = balancer.performUpkeep(expected, 1, 0);
        assertEq(reward, 0.00001 ether);
        assertEq(keeper.balance - before, 0.00001 ether);
        assertEq(balancer.reconciledSequence(), 1);
        assertEq(balancer.listedShapePrizes(), 20);
        assertEq(balancer.creator(), creator);
        vm.prank(keeper); vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector); balancer.performUpkeep(expected, 0, 0);
    }

    function test_writePolicyQuoteFixture() public {
        IKeeperPolicy[2] memory policies = [IKeeperPolicy(address(new KeeperPolicyV1())), IKeeperPolicy(address(new KeeperPolicyV2()))];
        uint256[5] memory bases = [uint256(0.15 gwei), 0.5 gwei, 5 gwei, 80 gwei, 0.5 gwei];
        string memory root;
        for (uint256 v; v < 2; ++v) {
            for (uint256 k; k < 5; ++k) {
                uint256 units = k == 4 ? 3 : 1;
                uint256 draws = k == 3 ? 5 : 1;
                IKeeperPolicy.Work memory w = IKeeperPolicy.Work(k == 3 ? 6_000_000 : 864_000,
                    bases[k] + 0.05 gwei, bases[k], draws, k == 3 ? 5 : units, 1, 0);
                string memory o = string.concat("quote", vm.toString(v * 5 + k));
                vm.serializeUint(o, "version", v + 1);
                vm.serializeString(o, "measuredGas", vm.toString(w.measuredGas));
                vm.serializeString(o, "gasPrice", vm.toString(w.gasPrice));
                vm.serializeString(o, "baseFee", vm.toString(w.baseFee));
                vm.serializeString(o, "reconciledDraws", vm.toString(w.reconciledDraws));
                vm.serializeString(o, "listedShapeUnits", vm.toString(w.listedShapeUnits));
                vm.serializeString(o, "listedPrizes", vm.toString(w.listedPrizes));
                vm.serializeString(o, "processedDraws", vm.toString(w.processedDraws));
                vm.serializeString(o, "reward", vm.toString(policies[v].quoteReward(w)));
                vm.serializeUint(o, "denomination", k == 4 ? 10 : 0);
                vm.serializeString(o, "shapeUnits", vm.toString(units));
                string memory row = vm.serializeString(o, "surcharge", vm.toString(policies[v].quoteRestock(k == 4 ? 10 : 0, units, bases[k])));
                root = vm.serializeString("policyQuotes", vm.toString(v * 5 + k), row);
            }
        }
        vm.writeJson(root, "./test/fixtures/keeper-policy-quotes.json");
    }

    function test_boundedPolicyQuoteGasOverhead() public {
        KeeperPolicyV1 first = new KeeperPolicyV1();
        KeeperPolicyV1 second = new KeeperPolicyV1();
        IKeeperPolicy.Work memory w = IKeeperPolicy.Work(864_000, 0.55 gwei, 0.5 gwei, 1, 1, 1, 0);
        vm.cool(address(first)); vm.cool(address(second));
        uint256 g = gasleft();
        uint256 direct = first.quoteReward(w);
        uint256 directGas = g - gasleft();
        g = gasleft();
        uint256 bounded = KeeperPolicyCalls.reward(address(second), 0.01645 ether, w);
        uint256 boundedGas = g - gasleft();
        assertEq(direct, bounded);
        assertLt(boundedGas, 25_000, "read-only boundary overhead is bounded independently of work");
        emit log_named_uint("direct cold reward quote gas", directGas);
        emit log_named_uint("bounded cold reward quote plus immutable envelope gas", boundedGas);
    }

    function test_priceScaledMinimumSurvivesFallingBasefee() public {
        _open(5 ether);
        uint256[] memory one = new uint256[](1);
        one[0] = balancer.getActiveIds()[1];
        vm.prank(creator); balancer.unlistShapes(one);
        bytes32 expected = balancer.settingsHash();
        uint256 quotedMinimum = 700_000 * 0.55 gwei;
        vm.fee(0.15 gwei); vm.txGasPrice(0.2 gwei);
        vm.prank(keeper); vm.expectRevert(PoolBalancer.MinimumPaymentNotMet.selector);
        balancer.performUpkeep(expected, quotedMinimum, 0);
        assertEq(balancer.listedShapePrizes(), 19, "the fixed old quote reverted atomically despite falling expense");
        vm.prank(keeper);
        (bool ok, bytes memory out) = address(balancer).call(abi.encodeWithSignature(
            "performUpkeep(bytes32,uint256,uint256)", expected, uint256(0), uint256(700_000)));
        assertTrue(ok, "price-scaled minimum accepts the lower-cost upkeep");
        assertGe(abi.decode(out, (uint256)), 700_000 * 0.2 gwei);
        assertEq(balancer.listedShapePrizes(), 20);
    }

    function test_pinnedFoundryGasCounterIsAlreadyBilled() public {
        GasAccountingWitness witness = new GasAccountingWitness();
        uint256 span = witness.clear();
        (bool ok, bytes memory data) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok);
        (, uint64 used,, int64 refunded,) = abi.decode(data, (uint64, uint64, uint64, int64, uint64));
        assertGt(refunded, 0, "real CALL cleared a previously nonzero slot");
        assertGe(uint256(used) + uint256(uint64(refunded)), span + 21_000,
            "billed plus refund covers the executed storage span and intrinsic");
        assertLt(used, span + 21_000, "used already contains the refund; subtracting it again is wrong");
        emit log_named_uint("storage span before refund", span);
        emit log_named_uint("five-field raw used (billed)", used);
        emit log_named_int("five-field refund counter", refunded);
    }

}
