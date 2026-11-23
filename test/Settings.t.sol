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
    function interfaceVersion() external pure returns (uint256) { return 3; }
    function version() external pure returns (uint256) { return 2; }
    function quoteReward(Work calldata w, Economics calldata) external pure returns (uint256) {
        uint256 price = w.baseFee + 0.02 gwei;
        if (price > w.gasPrice) price = w.gasPrice;
        if (price > 8 gwei) price = 8 gwei;
        return ((w.measuredGas > 3_200_000 ? 3_200_000 : w.measuredGas) + 70_000) * price
            + w.reconciledDraws * 0.00001 ether + w.listedPrizes * 0.00004 ether;
    }
    function quoteRestock(uint8 d, uint256 units, uint256 baseFee, Economics calldata) external pure returns (uint256) {
        uint256 price = baseFee + 0.02 gwei;
        if (price > 8 gwei) price = 8 gwei;
        return (d < 9 ? 950_000 : 1_100_000) * price + units * 0.00025 ether;
    }
}

contract HostilePolicy is IKeeperPolicy {
    uint256 immutable mode;
    constructor(uint256 m) { mode = m; }
    function interfaceVersion() external pure returns (uint256) { return 3; }
    function version() external pure returns (uint256) { return 99; }
    function quoteReward(Work calldata, Economics calldata) external view returns (uint256) { return _hostile(); }
    function quoteRestock(uint8, uint256, uint256, Economics calldata) external view returns (uint256) { return _hostile(); }
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

    /// The factory's initial economics are the V1 schedule; the derived maxima are 0.01645 ETH per payment and
    /// 0.0047 ETH restocking per Shape at V1's 50k overhead and 900k restocking gas; the recalibrated defaults (60k,
    /// 910k) derive 0.0165 and 0.00475. Writes the default-economics fixture the TypeScript planner reads.
    function test_policyV1FormulaAbsoluteAndFixture() public {
        IKeeperPolicy.Economics memory e = factory.economics();
        KeeperPolicyV1 policy = KeeperPolicyV1(e.policy);
        assertEq(e.workFee, 0.00002 ether);
        assertEq(e.maxGas, 3_200_000);
        assertEq(e.overheadGas, V1_OVERHEAD);
        assertEq(e.gasPriceCeiling, 5 gwei);
        assertEq(e.priorityAllowance, 0.05 gwei);
        assertEq(e.restockGas, V1_RESTOCK_GAS);
        assertEq(e.restockFlat, 0.0002 ether);
        assertEq(e.baseGas, 200_000);
        assertEq(e.processGas, 1_800_000);
        assertEq(e.reconcileGas, 150_000);
        assertEq(e.shapeGas, 700_000);
        assertEq(e.prizeGas, 150_000);
        IKeeperPolicy.Work memory w = IKeeperPolicy.Work(800_000, 0.55 gwei, 0.5 gwei, 1, 1, 1, 0);
        assertEq(policy.quoteReward(w, e), (800_000 + V1_OVERHEAD) * 0.55 gwei + 2 * 0.00002 ether);
        assertEq(policy.quoteRestock(0, 1, 0.5 gwei, e), 0.0007005 ether);
        createBalancer(1 ether);
        uint256 maxReward = (3_200_000 + V1_OVERHEAD) * 5 gwei + 10 * 0.00002 ether;
        assertEq(balancer.policyMaxReward(), maxReward, "derived: (maxGas + overhead) * ceiling + 10 work fees");
        assertEq(balancer.maxRestockSurchargePerShape(), 0.00475 ether, "derived: 910k * 5 gwei + 0.0002 ETH");
        string memory key = "keeperPolicyV1";
        vm.serializeString(key, "maxGasPrice", vm.toString(e.gasPriceCeiling));
        vm.serializeString(key, "priorityCap", vm.toString(e.priorityAllowance));
        vm.serializeString(key, "drawFee", vm.toString(e.workFee));
        vm.serializeString(key, "shapeFee", vm.toString(e.workFee));
        vm.serializeString(key, "restockFlat", vm.toString(e.restockFlat));
        vm.serializeString(key, "maxGas", vm.toString(e.maxGas));
        vm.serializeString(key, "overheadGas", vm.toString(e.overheadGas));
        vm.serializeString(key, "restockGas", vm.toString(e.restockGas));
        vm.serializeString(key, "maxPrizes", "1000");
        string memory json = vm.serializeString(key, "maxReward", vm.toString(maxReward));
        vm.writeJson(json, "./test/fixtures/keeper-policy-v1.json");
    }

    /// Spec §2/§3: factory economics and a pool's local choice change in the authorized transaction, with no delay.
    /// A following pool adopts a factory change at once; a pool that chose its own policy does not. Replaces the
    /// former "a default change never moves an existing pool" (the brief makes following the default).
    function test_factoryAndPoolEconomicsChangesAreImmediate() public {
        _open(5 ether);
        KeeperPolicyV2 v2 = new KeeperPolicyV2();
        IKeeperPolicy.Economics memory e = _econWith(address(v2));
        vm.prank(keeperAdmin); vm.expectRevert(BalancerFactory.Unauthorized.selector); factory.setEconomics(e);
        vm.prank(stranger); vm.expectRevert(BalancerFactory.Unauthorized.selector); factory.setEconomics(e);
        IKeeperPolicy.Economics memory invalid = _econWith(stranger); // read before expectRevert
        vm.expectRevert(KeeperPolicyCalls.InvalidPolicy.selector); factory.setEconomics(invalid);
        IKeeperPolicy.Economics memory badGrace = _econWith(address(v2)); // paused grace longer than the normal one
        badGrace.pausedProcessGraceBlocks = badGrace.processGraceBlocks + 1;
        vm.expectRevert(KeeperPolicyCalls.InvalidGrace.selector); factory.setEconomics(badGrace);
        vm.prank(creator); vm.expectRevert(KeeperPolicyCalls.InvalidGrace.selector); balancer.setLocalEconomics(badGrace);
        uint256 t = vm.getBlockTimestamp();
        bytes32 before = balancer.settingsHash();
        factory.setEconomics(e);
        assertEq(factory.defaultKeeperPolicy(), address(v2), "default changes in the same transaction");
        assertEq(balancer.keeperPolicy(), address(v2), "a following pool adopts it in the same transaction");
        assertTrue(balancer.settingsHash() != before, "and its settings hash moves");
        address v1 = address(new KeeperPolicyV1());
        vm.prank(stranger); vm.expectRevert(PoolBalancer.Unauthorized.selector); balancer.setKeeperPolicy(v1);
        vm.prank(keeperAdmin); vm.expectRevert(PoolBalancer.Unauthorized.selector); balancer.setKeeperPolicy(v1);
        vm.prank(creator); vm.expectRevert(KeeperPolicyCalls.InvalidPolicy.selector); balancer.setKeeperPolicy(stranger);
        vm.prank(creator); balancer.setKeeperPolicy(v1);
        assertEq(balancer.keeperPolicy(), v1, "pool policy changes in the same transaction");
        assertEq(balancer.economicsSource(), 1, "a creator's own policy is local economics");
        factory.setEconomics(_econWith(address(v2)));
        assertEq(balancer.keeperPolicy(), v1, "a local pool keeps its own");
        assertEq(balancer.policyMaxReward(), (3_200_000 + V1_OVERHEAD) * 5 gwei + 0.0002 ether);
        assertEq(vm.getBlockTimestamp(), t, "no time passed");
    }

    /// Economics with a larger maintenance exposure need that exposure funded at the moment of the change; a pending
    /// withdrawal cannot slip between a check and a later activation because there is none. A different algorithm on
    /// the same numbers changes no exposure.
    function test_economicsChangeRequiresMaintenanceFunding() public {
        _open(5 ether);
        KeeperPolicyV2 v2 = new KeeperPolicyV2();
        IKeeperPolicy.Economics memory higher = balancer.effectiveEconomics();
        higher.gasPriceCeiling = 50 gwei;
        higher.workFee = 0.00005 ether;
        vm.fee(5 gwei); vm.txGasPrice(5.05 gwei);
        uint256 claimable = balancer.withdrawableSurplus();
        vm.prank(creator); balancer.claimSurplus(claimable, creator);
        vm.prank(creator); balancer.setKeeperPolicy(address(v2)); // same numbers: no new exposure, no funding needed
        (uint256 required, uint256 shortfall) = balancer.maintenanceFunding(higher);
        assertGt(shortfall, 0);
        assertEq(required, shortfall + address(balancer).balance - balancer.creatorCredit());
        vm.prank(creator); vm.expectRevert(PoolBalancer.ReserveNotFunded.selector); balancer.setLocalEconomics(higher);
        vm.prank(creator); balancer.depositETH{value: shortfall}();
        vm.prank(creator); balancer.setLocalEconomics(higher);
        assertEq(balancer.effectiveEconomics().gasPriceCeiling, 50 gwei);
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
        factory.setEconomics(_econWith(address(new KeeperPolicyV2())));
        factory.setProductLimits(500, 2_000, 5_000);
        assertFalse(balancer.paidUpkeepEnabled(), "factory changes never re-enable a stopped pool");
        disabled = balancer.settingsHash(); // the follower's hash moved with the factory change
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
        settle(); // an expired draw is processed on FWA by anyone, not by upkeep
        uint256 before = balancer.availableKeeperAllowance();
        bytes32 expected = balancer.settingsHash();
        vm.prank(keeper); uint256 reward = balancer.performUpkeep(expected, 1, 0);
        assertGt(reward, 0);
        assertLe(reward, balancer.policyMaxReward());
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
        settle();
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
                    bases[k] + 0.05 gwei, bases[k], draws, k == 3 ? 5 : units, 1, k == 3 ? 2 : 0);
                string memory o = string.concat("quote", vm.toString(v * 5 + k));
                vm.serializeUint(o, "version", v + 1);
                vm.serializeString(o, "measuredGas", vm.toString(w.measuredGas));
                vm.serializeString(o, "gasPrice", vm.toString(w.gasPrice));
                vm.serializeString(o, "baseFee", vm.toString(w.baseFee));
                vm.serializeString(o, "reconciledDraws", vm.toString(w.reconciledDraws));
                vm.serializeString(o, "listedShapeUnits", vm.toString(w.listedShapeUnits));
                vm.serializeString(o, "listedPrizes", vm.toString(w.listedPrizes));
                vm.serializeString(o, "processedDraws", vm.toString(w.processedDraws));
                vm.serializeString(o, "reward", vm.toString(policies[v].quoteReward(w, factory.economics())));
                vm.serializeUint(o, "denomination", k == 4 ? 10 : 0);
                vm.serializeString(o, "shapeUnits", vm.toString(units));
                string memory row = vm.serializeString(o, "surcharge", vm.toString(policies[v].quoteRestock(k == 4 ? 10 : 0, units, bases[k], factory.economics())));
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
        uint256 direct = first.quoteReward(w, _econWith(address(first)));
        uint256 directGas = g - gasleft();
        IKeeperPolicy.Economics memory e = _econWith(address(second));
        g = gasleft();
        uint256 bounded = KeeperPolicyCalls.reward(e, w);
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
