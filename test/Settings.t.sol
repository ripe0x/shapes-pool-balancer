// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {KeeperPolicyCalls} from "../src/KeeperPolicyCalls.sol";
import {BalancerFactory} from "../src/BalancerFactory.sol";

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

    /// @dev The effective economics with a different work fee: a real numeric change (R95: there is no algorithm to swap).
    function _econFee(uint64 workFee) internal view returns (KeeperPolicyCalls.Economics memory e) {
        e = factory.economics();
        e.workFee = workFee;
    }

    /// The factory's initial economics are the V1 schedule; the derived maxima are 0.01645 ETH per payment and
    /// 0.0047 ETH restocking per Shape at V1's 50k overhead and 900k restocking gas; the recalibrated defaults (60k,
    /// 910k) derive 0.0165 and 0.00475. Writes the default-economics fixture the TypeScript planner reads.
    function test_policyV1FormulaAbsoluteAndFixture() public {
        KeeperPolicyCalls.Economics memory e = factory.economics();
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
        KeeperPolicyCalls.Work memory w = KeeperPolicyCalls.Work(800_000, 0.55 gwei, 0.5 gwei, 1, 1, 1, 0);
        assertEq(KeeperPolicyCalls.reward(e, w), (800_000 + V1_OVERHEAD) * 0.55 gwei + 2 * 0.00002 ether);
        assertEq(KeeperPolicyCalls.restock(e, 1, 0.5 gwei), 0.0007005 ether);
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
    /// A following pool adopts a factory change at once; a pool with local economics does not. Replaces the
    /// former "a default change never moves an existing pool" (the brief makes following the default) and, per R95,
    /// the former algorithm replacement and its interface validation.
    function test_factoryAndPoolEconomicsChangesAreImmediate() public {
        _open(5 ether);
        KeeperPolicyCalls.Economics memory e = _econFee(0.00003 ether);
        vm.prank(keeperAdmin); vm.expectRevert(BalancerFactory.Unauthorized.selector); factory.setEconomics(e);
        vm.prank(stranger); vm.expectRevert(BalancerFactory.Unauthorized.selector); factory.setEconomics(e);
        KeeperPolicyCalls.Economics memory badGrace = _econFee(0.00003 ether); // paused grace longer than the normal one
        badGrace.pausedProcessGraceBlocks = badGrace.processGraceBlocks + 1;
        vm.expectRevert(KeeperPolicyCalls.InvalidGrace.selector); factory.setEconomics(badGrace);
        vm.prank(creator); vm.expectRevert(KeeperPolicyCalls.InvalidGrace.selector); balancer.setLocalEconomics(badGrace);
        uint256 t = vm.getBlockTimestamp();
        bytes32 before = balancer.settingsHash();
        factory.setEconomics(e);
        assertEq(factory.economics().workFee, 0.00003 ether, "default changes in the same transaction");
        assertEq(balancer.effectiveEconomics().workFee, 0.00003 ether, "a following pool adopts it in the same transaction");
        assertTrue(balancer.settingsHash() != before, "and its settings hash moves");
        KeeperPolicyCalls.Economics memory local = _econFee(0.00002 ether);
        vm.prank(stranger); vm.expectRevert(PoolBalancer.Unauthorized.selector); balancer.setLocalEconomics(local);
        vm.prank(keeperAdmin); vm.expectRevert(PoolBalancer.Unauthorized.selector); balancer.setLocalEconomics(local);
        vm.prank(creator); balancer.setLocalEconomics(local);
        assertEq(balancer.effectiveEconomics().workFee, 0.00002 ether, "pool economics change in the same transaction");
        assertEq(balancer.economicsSource(), 1, "a creator's own values are local economics");
        factory.setEconomics(_econFee(0.00004 ether));
        assertEq(balancer.effectiveEconomics().workFee, 0.00002 ether, "a local pool keeps its own");
        assertEq(balancer.policyMaxReward(), (3_200_000 + V1_OVERHEAD) * 5 gwei + 0.0002 ether);
        assertEq(vm.getBlockTimestamp(), t, "no time passed");
    }

    /// Economics with a larger maintenance exposure need that exposure funded at the moment of the change; a pending
    /// withdrawal cannot slip between a check and a later activation because there is none. Pinning the same numbers
    /// as local economics changes no exposure.
    function test_economicsChangeRequiresMaintenanceFunding() public {
        _open(5 ether);
        KeeperPolicyCalls.Economics memory higher = balancer.effectiveEconomics();
        KeeperPolicyCalls.Economics memory same = balancer.effectiveEconomics();
        higher.gasPriceCeiling = 50 gwei;
        higher.workFee = 0.00005 ether;
        vm.fee(5 gwei); vm.txGasPrice(5.05 gwei);
        uint256 claimable = balancer.withdrawableSurplus();
        vm.prank(creator); balancer.claimSurplus(claimable, creator);
        vm.prank(creator); balancer.setLocalEconomics(same); // same numbers: no new exposure, no funding needed
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
        factory.setEconomics(_econFee(0.00003 ether));
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

    /// R95 removed the external policy and with it every policy-failure mode this test once looped over; the unpaid
    /// whole path under a restricted keeper list remains.
    function test_unpaidWholePathAndRestrictedKeeper() public {
        _open(100 ether);
        uint256 id = balancer.getActiveIds()[1];
        uint256[] memory ids = new uint256[](1); ids[0] = id;
        vm.prank(creator); balancer.unlistShapes(ids);
        vm.prank(keeperAdmin); factory.setKeepersRestricted(true);
        uint256 count = balancer.listedShapePrizes();
        uint256 received = stranger.balance;
        uint256 fee = balancer.restockFeeFor(0);
        uint256 last = lastListingId();
        vm.prank(stranger); balancer.performUpkeepUnpaid();
        assertEq(balancer.listedShapePrizes(), count + 1);
        assertEq(stranger.balance, received);
        (,,, uint112 base, uint112 price) = balancer.items(last + 1);
        assertEq(uint256(price) - base, fee, "unpaid upkeep lists at the same surcharge paid upkeep would");
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
    }

    /// Spec §5: a creator transfer keeps the selected policy, the disabled state and spending history; only the new
    /// creator can re-enable. Replaces the former "transfer cancels a pending proposal" (no proposals remain).
    function test_creatorTransferKeepsPolicyDisabledStateAndAllowance() public {
        _open(5 ether);
        KeeperPolicyCalls.Economics memory local = _econFee(0.00003 ether);
        vm.prank(creator); balancer.setLocalEconomics(local);
        vm.prank(creator); balancer.setPaidUpkeepEnabled(false);
        uint256 allowance = balancer.keeperAllowance();
        uint64 allowanceTime = balancer.keeperAllowanceTime();
        bytes32 hash = balancer.settingsHash();
        vm.prank(creator); balancer.transferCreator(stranger);
        vm.prank(stranger); balancer.acceptCreator();
        assertEq(balancer.effectiveEconomics().workFee, 0.00003 ether);
        assertEq(balancer.economicsSource(), 1);
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
        KeeperPolicyCalls.Economics memory same = balancer.effectiveEconomics();
        vm.prank(creator); balancer.setLocalEconomics(same);
        assertEq(balancer.keeperAllowance(), stored, "an economics change never resets spend history");
        assertEq(balancer.keeperAllowanceTime(), stamp);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        assertEq(balancer.availableKeeperAllowance(), balancer.keeperBucketCapacity(), "idle refill saturates");
        uint256 dayBound = balancer.keeperBucketCapacity() + 1 days * balancer.keeperBucketRefill();
        uint256 yearBound = balancer.keeperBucketCapacity() + 365 days * balancer.keeperBucketRefill();
        assertEq(dayBound, 360.6219999999999424 ether);
        assertEq(yearBound, 131400.621999999978976 ether);
    }

    /// One payment formula since R95: the fixture rows are the in-library V1 formula only (the V2 rows are gone).
    function test_writePolicyQuoteFixture() public {
        uint256[5] memory bases = [uint256(0.15 gwei), 0.5 gwei, 5 gwei, 80 gwei, 0.5 gwei];
        KeeperPolicyCalls.Economics memory e = factory.economics();
        string memory root;
        for (uint256 k; k < 5; ++k) {
            uint256 units = k == 4 ? 3 : 1;
            uint256 draws = k == 3 ? 5 : 1;
            KeeperPolicyCalls.Work memory w = KeeperPolicyCalls.Work(k == 3 ? 6_000_000 : 864_000,
                bases[k] + 0.05 gwei, bases[k], draws, k == 3 ? 5 : units, 1, k == 3 ? 2 : 0);
            string memory o = string.concat("quote", vm.toString(k));
            vm.serializeUint(o, "version", 1);
            vm.serializeString(o, "measuredGas", vm.toString(w.measuredGas));
            vm.serializeString(o, "gasPrice", vm.toString(w.gasPrice));
            vm.serializeString(o, "baseFee", vm.toString(w.baseFee));
            vm.serializeString(o, "reconciledDraws", vm.toString(w.reconciledDraws));
            vm.serializeString(o, "listedShapeUnits", vm.toString(w.listedShapeUnits));
            vm.serializeString(o, "listedPrizes", vm.toString(w.listedPrizes));
            vm.serializeString(o, "processedDraws", vm.toString(w.processedDraws));
            vm.serializeString(o, "reward", vm.toString(KeeperPolicyCalls.reward(e, w)));
            vm.serializeUint(o, "denomination", k == 4 ? 10 : 0);
            vm.serializeString(o, "shapeUnits", vm.toString(units));
            string memory row = vm.serializeString(o, "surcharge", vm.toString(KeeperPolicyCalls.restock(e, units, bases[k])));
            root = vm.serializeString("policyQuotes", vm.toString(k), row);
        }
        vm.writeJson(root, "./test/fixtures/keeper-policy-quotes.json");
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
