// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {BalancerFactory} from "../src/BalancerFactory.sol";
import {KeeperPolicyCalls} from "../src/KeeperPolicyCalls.sol";

interface IShapesFeeAdmin {
    function setMintFee(uint256) external;
}

/// @dev R95/R96: the former cheaper test algorithm is now a cheaper restocking flat charge in the same formula.
function _cheaper(KeeperPolicyCalls.Economics memory e) pure returns (KeeperPolicyCalls.Economics memory) {
    e.restockGas = 0;
    e.restockFlat = 0.0001 ether;
    return e;
}

/// @notice Slice A3: one factory economic configuration, per-pool follow/local/pin, the per-pool spending bucket, one
///         effective configuration per operation, the settings hash and the funding rules. Mainnet fork with the real
///         FWA pool, VRF service (coordinator exception), Shapes and Draw Packs; gas context set and asserted.
contract KeeperEconomicsTest is ForkBase {
    bytes32 constant PAID = keccak256("KeeperPaid(address,uint256,uint256)");
    address internal constant SHAPES_ADMIN = 0xCB43078C32423F5348Cab5885911C3B5faE217F9;
    GasProbe probe;

    function setUp() public {
        setUpFork();
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        probe = new GasProbe();
        probe.record();
        assertEq(probe.baseFee(), 0.5 gwei, "basefee inside a transaction");
        assertEq(probe.gasPrice(), 0.55 gwei, "gas price inside a transaction");
        curatedRequired = false;
    }

    function _pool(address owner, uint256 salt) internal returns (PoolBalancer b) {
        vm.deal(owner, 100 ether);
        b = _createFixture(owner, bytes32(salt), 5 ether);
        balancer = b;
        pool = b.pool();
        vm.startPrank(owner);
        b.configure(MARKUP, plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]), shapes.mintFee());
        b.open();
        vm.stopPrank();
        fillUp();
    }

    function _use(PoolBalancer b) internal { balancer = b; pool = b.pool(); }

    function _eq(KeeperPolicyCalls.Economics memory a, KeeperPolicyCalls.Economics memory b) internal pure returns (bool) {
        return keccak256(abi.encode(a)) == keccak256(abi.encode(b));
    }

    /// Expire one draw and process it on FWA as a third party, so the next upkeep has paid work (reconcile it).
    function _owe(PoolBalancer b) internal {
        _use(b);
        buy(buyer, 1);
        vm.roll(vm.getBlockNumber() + 40);
        settle();
    }

    function _paid(PoolBalancer b) internal returns (uint256 reward, uint256 measured) {
        bytes32 h = b.settingsHash();
        vm.recordLogs();
        vm.prank(keeper, keeper);
        reward = b.performUpkeep(h, 0, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(b) && logs[i].topics[0] == PAID) (, measured) = abi.decode(logs[i].data, (uint256, uint256));
        }
    }

    /*////////////////////////////// item 1: factory configuration //////////////////////////////*/

    /// The initial factory economics are the V1 numbers with the measured 60k overhead and 910k restocking gas; the
    /// derived maxima follow (V1: 0.01645 ETH per payment and 0.0047 ETH per Shape; now 0.0165 and 0.00475), and a whole-struct update is immediate, policyAdmin-only and
    /// emits the full configuration.
    function test_factoryEconomicsInitialDerivedAndWholeStructSetter() public {
        KeeperPolicyCalls.Economics memory e = factory.economics();
        assertEq(e.workFee, 0.00002 ether);
        assertEq(e.maxGas, 3_200_000);
        assertEq(e.overheadGas, V1_OVERHEAD);
        assertEq(e.gasPriceCeiling, 5 gwei);
        assertEq(e.priorityAllowance, 0.05 gwei);
        assertEq(e.restockGas, V1_RESTOCK_GAS);
        assertEq(e.restockFlat, 0.0002 ether);
        assertEq(factory.defaultBucketCapacity(), 0.622 ether);
        assertEq(factory.defaultBucketRefill(), uint256(0.05 ether) / 12);
        // Derivations at the V1 numbers with the original 50k overhead.
        assertEq(uint256((3_200_000 + 50_000) * 5 gwei + 10 * 0.00002 ether), uint256(0.01645 ether));
        assertEq(uint256(900_000 * 5 gwei + 0.0002 ether), uint256(0.0047 ether));
        PoolBalancer b = _pool(creator, 1);
        assertEq(b.policyMaxReward(), (3_200_000 + V1_OVERHEAD) * 5 gwei + 0.0002 ether);
        assertEq(b.policyMaxReward(), 0.0165 ether, "recalibrated 60k overhead");
        assertEq(b.maxRestockSurchargePerShape(), V1_RESTOCK_GAS * 5 gwei + 0.0002 ether);
        assertEq(b.maxRestockSurchargePerShape(), 0.00475 ether, "recalibrated 910k restocking gas");

        e.workFee = 0.00003 ether;
        vm.prank(stranger); vm.expectRevert(BalancerFactory.Unauthorized.selector); factory.setEconomics(e);
        vm.prank(keeperAdmin); vm.expectRevert(BalancerFactory.Unauthorized.selector); factory.setEconomics(e);
        vm.prank(stranger); vm.expectRevert(BalancerFactory.Unauthorized.selector); factory.setDefaultBucket(1, 1);
        vm.expectEmit(address(factory));
        emit BalancerFactory.EconomicsChanged(e);
        factory.setEconomics(e);
        assertTrue(_eq(factory.economics(), e), "whole struct stored");
        assertEq(b.effectiveEconomics().workFee, 0.00003 ether, "follower adopts it in the same block");
    }

    /// Spec §4.6/4.7: valid values across the removed literals (0.311 ETH payment ceiling, 0.102 ETH restocking ceiling,
    /// 50 gwei price ceiling, 6M gas) take effect instead of being clamped.
    function test_formerHardcodedLimitsDoNotClamp() public {
        PoolBalancer b = _pool(creator, 2);
        vm.prank(creator); b.depositETH{value: 10 ether}();
        KeeperPolicyCalls.Economics memory e = factory.economics();
        e.gasPriceCeiling = 200 gwei;
        e.priorityAllowance = 1 gwei;
        e.workFee = 0.4 ether;
        e.restockFlat = 0.2 ether;
        e.maxGas = 7_000_000;
        factory.setEconomics(e);
        vm.prank(creator); b.setKeeperBucket(5 ether, 1 ether);
        vm.fee(80 gwei); vm.txGasPrice(81 gwei);
        assertEq(b.policyMaxReward(), (7_000_000 + uint256(V1_OVERHEAD)) * 200 gwei + 10 * 0.4 ether);
        assertGt(b.policyMaxReward(), 0.311 ether);
        assertEq(b.restockFee(), V1_RESTOCK_GAS * 81 gwei + 0.2 ether, "restocking above the former 0.102 ETH ceiling");
        assertEq(b.maxRestockSurchargePerShape(), V1_RESTOCK_GAS * 200 gwei + 0.2 ether);
        _owe(b);
        (uint256 reward, uint256 measured) = _paid(b);
        assertEq(reward, (measured + V1_OVERHEAD) * 81 gwei + 0.4 ether, "paid at 81 gwei, above the former 50 gwei ceiling");
        assertGt(reward, 0.311 ether, "above the former outer payment ceiling");
        // Lowering works the same way.
        e.workFee = 0;
        e.gasPriceCeiling = 1 gwei;
        factory.setEconomics(e);
        _owe(b);
        (reward, measured) = _paid(b);
        assertEq(reward, (measured + V1_OVERHEAD) * 1 gwei, "lowered ceiling and zero fee apply at once");
    }

    /*////////////////////////////// item 2: follow, local, pin //////////////////////////////*/

    /// Two followers and one pinned pool: a factory change moves both followers immediately and leaves the pinned pool's
    /// complete economics and settings hash unchanged; resuming adopts the latest factory economics, including changes
    /// made while pinned. Product limits are not pinned. R96: the pin is the app's save of the factory's current values
    /// as local economics (source 1); there is no contract pin mode.
    function test_followersUpdatePinnedFrozenResumeAdoptsLatest() public {
        address owner2 = makeAddr("owner2");
        address owner3 = makeAddr("owner3");
        PoolBalancer a = _pool(creator, 3);
        PoolBalancer b = _pool(owner2, 4);
        PoolBalancer c = _pool(owner3, 5);
        KeeperPolicyCalls.Economics memory original = factory.economics();
        vm.prank(stranger); vm.expectRevert(PoolBalancer.Unauthorized.selector); c.setLocalEconomics(original);
        vm.prank(owner3); c.setLocalEconomics(original);
        assertEq(c.economicsSource(), 1);
        bytes32 pinnedHash = c.settingsHash();
        bytes32 followerHash = a.settingsHash();

        KeeperPolicyCalls.Economics memory next = factory.economics();
        next.workFee = 0.0001 ether;
        next.restockFlat = 0.0003 ether;
        next.overheadGas = 70_000;
        factory.setEconomics(next);
        factory.setProductLimits(10, 1_000, 10_000);
        assertTrue(_eq(a.effectiveEconomics(), next) && _eq(b.effectiveEconomics(), next), "followers adopt at once");
        assertTrue(_eq(c.effectiveEconomics(), original), "pinned pool keeps the complete configuration");
        assertEq(c.settingsHash(), pinnedHash, "no spurious hash change for the pinned pool");
        assertTrue(a.settingsHash() != followerHash, "a follower's hash moves");
        assertEq(c.restockFee(), V1_RESTOCK_GAS * 0.55 gwei + 0.0002 ether, "pinned restocking schedule");
        assertEq(a.restockFee(), V1_RESTOCK_GAS * 0.55 gwei + 0.0003 ether, "follower prices with the new flat charge");
        // Product limits still bind the pinned pool's new designs.
        uint256 fee = shapes.mintFee();
        vm.prank(owner3); vm.expectRevert(PoolBalancer.InvalidPlan.selector);
        c.configure(MARKUP, plan([uint256(11), 0, 0, 0, 0, 0, 0, 0, 0]), fee);

        next.workFee = 0.0002 ether; // a second change while pinned
        factory.setEconomics(next);
        vm.prank(owner3); c.followFactoryEconomics();
        assertEq(c.economicsSource(), 0);
        assertTrue(_eq(c.effectiveEconomics(), next), "resuming adopts the latest factory economics");

        // Local economics: creator values, immediate, unaffected by the factory.
        // A fresh copy: `mine = original` aliases one memory struct, so the factory change would carry the local values.
        KeeperPolicyCalls.Economics memory mine = factory.economics();
        mine.workFee = 0.00001 ether;
        vm.prank(stranger); vm.expectRevert(PoolBalancer.Unauthorized.selector); b.setLocalEconomics(mine);
        vm.prank(owner2); b.setLocalEconomics(mine);
        assertEq(b.economicsSource(), 1);
        factory.setEconomics(original);
        assertEq(factory.economics().workFee, 0.00002 ether, "factory back on the V1 work fee");
        assertFalse(_eq(factory.economics(), mine), "factory and local values differ");
        assertTrue(_eq(b.effectiveEconomics(), mine), "local economics ignore the factory");
        assertEq(b.effectiveEconomics().workFee, 0.00001 ether, "local work fee kept");
    }

    /// Pin, local, follow, an economics switch and re-enable keep the creator's emergency stop and the bucket; a creator
    /// transfer keeps economics, stop and bucket.
    function test_transitionsPreserveStopAndBucket() public {
        PoolBalancer b = _pool(creator, 6);
        _owe(b);
        _paid(b);
        vm.prank(creator); b.setPaidUpkeepEnabled(false);
        uint256 allowance = b.keeperAllowance();
        uint64 stamp = b.keeperAllowanceTime();
        KeeperPolicyCalls.Economics memory e = b.effectiveEconomics();
        KeeperPolicyCalls.Economics memory cheap = _cheaper(b.effectiveEconomics());
        KeeperPolicyCalls.Economics memory pinned = factory.economics();
        vm.startPrank(creator);
        b.setLocalEconomics(cheap);
        assertFalse(b.paidUpkeepEnabled(), "an economics switch preserves the stop");
        b.setLocalEconomics(pinned);
        b.followFactoryEconomics();
        b.setLocalEconomics(e);
        b.close();
        b.open();
        vm.stopPrank();
        factory.setEconomics(cheap);
        assertFalse(b.paidUpkeepEnabled(), "no transition or factory update re-enables");
        assertEq(b.keeperAllowance(), allowance);
        assertEq(b.keeperAllowanceTime(), stamp);
        vm.prank(creator); b.transferCreator(stranger);
        vm.prank(stranger); b.acceptCreator();
        assertFalse(b.paidUpkeepEnabled());
        assertEq(b.economicsSource(), 1);
        assertTrue(_eq(b.effectiveEconomics(), e), "creator transfer keeps the economics");
        assertEq(b.keeperAllowance(), allowance);
        vm.prank(stranger); b.setPaidUpkeepEnabled(true);
        assertTrue(b.paidUpkeepEnabled());
    }

    /*////////////////////////////// item 3: spending bucket //////////////////////////////*/

    /// Spec §5 accrual rules with exact wei: elapsed time at the old rate first, spent allowance kept, clamp on a lower
    /// capacity, no fill on a higher one, new rate only for later time, zero refill, and the one-second boundary.
    function test_bucketAccrualRules() public {
        PoolBalancer b = _pool(creator, 7);
        vm.prank(stranger); vm.expectRevert(PoolBalancer.Unauthorized.selector); b.setKeeperBucket(1, 1);
        vm.prank(creator); b.setKeeperBucket(0.01 ether, 3); // drain to 0.01 and refill 3 wei/s
        uint256 refill0 = 3;
        assertEq(b.availableKeeperAllowance(), 0.01 ether, "a lower capacity clamps the remaining allowance");
        _owe(b);
        (uint256 r1,) = _paid(b);
        uint256 left = 0.01 ether - r1;
        assertEq(b.availableKeeperAllowance(), left, "spent allowance stays spent");
        uint256 t0 = vm.getBlockTimestamp();
        vm.warp(t0 + 100);
        assertEq(b.availableKeeperAllowance(), left + 100 * refill0);
        // Change the rate: the first 100 s accrue at 3 wei/s, later time at 7 wei/s; raising capacity fills nothing.
        vm.prank(creator); b.setKeeperBucket(1 ether, 7);
        assertEq(b.keeperAllowance(), left + 300, "accrued at the old rate first");
        assertEq(b.availableKeeperAllowance(), left + 300, "raising capacity does not fill the headroom");
        vm.warp(t0 + 101);
        assertEq(b.availableKeeperAllowance(), left + 307, "new rate from the change, to the wei");
        // Zero refill: nothing accrues, ever.
        vm.prank(creator); b.setKeeperBucket(1 ether, 0);
        vm.warp(t0 + 101 + 365 days);
        assertEq(b.availableKeeperAllowance(), left + 307);
        // Saturation at capacity, with the floor(0.05 ETH / 12) default rate.
        vm.prank(creator); b.setKeeperBucket(0.622 ether, uint96(uint256(0.05 ether) / 12));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(b.availableKeeperAllowance(), 0.622 ether);
        // A depleted bucket blocks paid work but not unpaid maintenance.
        vm.prank(creator); b.setKeeperBucket(0, 0);
        _owe(b);
        bytes32 h = b.settingsHash();
        vm.prank(keeper, keeper); vm.expectRevert(PoolBalancer.PaymentUnavailable.selector); b.performUpkeep(h, 0, 0);
        vm.prank(stranger); b.performUpkeepUnpaid();
        assertEq(b.reconciledSequence(), b.pool().lastIssuedSequence());
        // Factory default bucket changes never touch an existing pool.
        factory.setDefaultBucket(1 ether, 1 ether);
        assertEq(b.keeperBucketCapacity(), 0);
        assertEq(b.keeperBucketRefill(), 0);
    }

    /*////////////////////////////// items 4, 7: one configuration, fallback //////////////////////////////*/

    /// The pool-context quote, the paid amount, the listing surcharge, the reserve bound and the derived maximum all come
    /// from the same effective economics, and unpaid callers price restocking with the selected (here cheaper) schedule.
    /// R95 removed the external policy, so the former broken-policy refusal and fallback no longer exist.
    function test_oneConfigurationQuotePaymentRestockReserveFallback() public {
        PoolBalancer b = _pool(creator, 8);
        KeeperPolicyCalls.Economics memory e = b.effectiveEconomics();
        // Reserve: one operating call plus nothing owed, from the same schedule.
        assertEq(b.requiredReserve(), _workingBufferAt(0.55 gwei));
        uint256[] memory one = new uint256[](1);
        one[0] = b.getActiveIds()[0];
        vm.prank(creator); b.unlistShapes(one);
        uint256 surcharge = b.restockFee();
        assertEq(surcharge, uint256(e.restockGas) * 0.55 gwei + e.restockFlat);
        (uint256 reward, uint256 measured) = _paid(b);
        KeeperPolicyCalls.Work memory w = KeeperPolicyCalls.Work(measured, 0.55 gwei, 0.5 gwei, 0, 1, 1, 0);
        assertEq(reward, b.quoteKeeperReward(w), "payment equals the pool-context quote for the same work");
        assertEq(reward, (measured + e.overheadGas) * 0.55 gwei + e.workFee, "and the V1 arithmetic");
        uint256 last = lastListingId();
        (,,, uint112 base, uint112 price) = b.items(last);
        assertEq(price - base, surcharge, "listed surcharge equals the preview");

        // A cheaper selected schedule prices unpaid restocking too.
        KeeperPolicyCalls.Economics memory cheap = _cheaper(e);
        vm.prank(creator); b.setLocalEconomics(cheap);
        one[0] = last;
        vm.prank(creator); b.unlistShapes(one);
        vm.prank(stranger); b.performUpkeepUnpaid();
        (,,, base, price) = b.items(lastListingId());
        assertEq(price - base, 0.0001 ether, "unpaid caller uses the selected schedule");
        assertEq(b.requiredReserve(), _workingBufferAt(0.55 gwei), "the restocking schedule never enters the reserve");
        uint256 free = b.withdrawableSurplus();
        vm.prank(creator); b.claimSurplus(free, creator);
    }

    /*////////////////////////////// item 5: settings hash //////////////////////////////*/

    /// The hash covers the live Shapes mint fee: a fee change at the same policy address invalidates a reviewed upkeep
    /// and creation before any work. Stale upkeep reverts with no side effect.
    function test_settingsHashCoversMintFeeAndBindsUpkeepAndCreation() public {
        PoolBalancer b = _pool(creator, 9);
        assertEq(b.settingsHash(), KeeperPolicyCalls.settingsHash(factory.economics(), 0, 0, true, shapes.mintFee()));
        bytes32 creation = factory.creationSettingsHash();
        _owe(b);
        bytes32 h = b.settingsHash();
        vm.prank(SHAPES_ADMIN); IShapesFeeAdmin(SHAPES).setMintFee(0.0005 ether);
        assertTrue(b.settingsHash() != h, "a mint fee change moves the hash");
        assertTrue(factory.creationSettingsHash() != creation);
        uint256 seq = b.reconciledSequence();
        uint256 bal = address(b).balance;
        vm.prank(keeper, keeper); vm.expectRevert(PoolBalancer.StaleSettings.selector); b.performUpkeep(h, 0, 0);
        assertEq(b.reconciledSequence(), seq);
        assertEq(address(b).balance, bal);
        // Same fee at the same policy address, different work fee: hash moves for followers.
        h = b.settingsHash();
        KeeperPolicyCalls.Economics memory e = factory.economics();
        e.workFee = 0.00003 ether;
        factory.setEconomics(e);
        vm.prank(keeper, keeper); vm.expectRevert(PoolBalancer.StaleSettings.selector); b.performUpkeep(h, 0, 0);
        // Creation with a stale hash fails before the clone exists.
        PoolBalancer.CreationConfig memory cfg = PoolBalancer.CreationConfig(MARKUP, 400,
            plan([uint256(1), 0, 0, 0, 0, 0, 0, 0, 0]), shapes.mintFee(), false, creation);
        address predicted = factory.predictBalancer(stranger, bytes32(uint256(77)));
        vm.prank(stranger); vm.expectRevert(BalancerFactory.StaleSettings.selector);
        factory.createBalancer{value: 1 ether}(bytes32(uint256(77)), cfg, new PoolBalancer.CuratedInput[](0));
        assertEq(predicted.code.length, 0);
        cfg.settingsHash = factory.creationSettingsHash();
        vm.prank(stranger);
        PoolBalancer created = PoolBalancer(payable(factory.createBalancer{value: 1 ether}(bytes32(uint256(77)), cfg,
            new PoolBalancer.CuratedInput[](0))));
        // The reviewed creation hash is the new pool's own hash bound to the default bucket it copied.
        assertEq(keccak256(abi.encode(created.settingsHash(), created.keeperBucketCapacity(), created.keeperBucketRefill())),
            cfg.settingsHash, "a new pool starts at the reviewed hash and bucket");
    }

    /*////////////////////////////// item 6: funding //////////////////////////////*/

    /// A factory raise never inspects followers: an underfunded follower shows its shortfall, pays only within cash
    /// (otherwise paid work reverts), and unpaid maintenance, creator credit and recovery stay usable.
    function test_underfundedFollowerDoesNotBlockFactoryUpdate() public {
        PoolBalancer b = _pool(creator, 10);
        uint256 free = b.withdrawableSurplus();
        vm.prank(creator); b.claimSurplus(free, creator);
        uint256 cash = address(b).balance - b.creatorCredit();
        KeeperPolicyCalls.Economics memory e = factory.economics();
        e.workFee = 0.05 ether;
        factory.setEconomics(e);
        (uint256 required, uint256 shortfall) = b.maintenanceFunding(b.effectiveEconomics());
        assertEq(required, _workingBufferAt(0.55 gwei) - 0.0002 ether + 10 * 0.05 ether);
        assertEq(shortfall, required - cash, "the follower's new shortfall is exposed");
        _owe(b);
        bytes32 h = b.settingsHash();
        vm.prank(keeper, keeper); vm.expectRevert(PoolBalancer.PaymentUnavailable.selector); b.performUpkeep(h, 0, 0);
        vm.prank(stranger); b.performUpkeepUnpaid();
        assertEq(b.reconciledSequence(), b.pool().lastIssuedSequence(), "unpaid maintenance still works");
        assertEq(address(b).balance, cash, "nothing paid beyond cash");
        // Local transitions keep the maintenance-funding check. Pinning the raised economics is equal exposure, and
        // stopping never needs funding; re-enabling needs the maintenance budget only, never a missing prize.
        KeeperPolicyCalls.Economics memory raised = b.effectiveEconomics();
        vm.prank(creator); b.setLocalEconomics(raised);
        vm.prank(creator); b.setPaidUpkeepEnabled(false);
        uint256[] memory one = new uint256[](1);
        one[0] = b.getActiveIds()[0];
        vm.prank(creator); b.unlistShapes(one);
        (required, shortfall) = b.maintenanceFunding(b.effectiveEconomics());
        vm.prank(creator); vm.expectRevert(PoolBalancer.ReserveNotFunded.selector); b.setPaidUpkeepEnabled(true);
        vm.prank(creator); b.depositETH{value: shortfall}();
        vm.prank(creator); b.setPaidUpkeepEnabled(true);
        assertLt(address(b).balance - b.creatorCredit(), b.requiredReserve(), "missing inventory was not required");
    }
}
