// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {FreezableNFT} from "./utils/Mocks.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {BalancerFactory} from "../src/BalancerFactory.sol";
import {KeeperPolicyV1} from "../src/KeeperPolicyV1.sol";
import {IKeeperPolicy} from "../src/interfaces/IKeeperPolicy.sol";
import {IFWAPool} from "../src/interfaces/External.sol";

/// @notice Community configuration acceptance suite (spec A§9 cases 1-15, Part B §6 case 16).
///         Expectations are written from the owner's spec, not from the implementation's own tests: every amount is an
///         absolute wei value computed here from the effective economics, and every keeper payment, mint and collection
///         is reconciled against the Balancer's actual ETH balance. Real FWA, Shapes, Draw Packs and VRF on a mainnet
///         fork; the Chainlink coordinator and (fork only) the Shapes admin are impersonated. Map: docs/ACCEPTANCE-MAP.md.

interface IShapesFeeAdmin {
    function setMintFee(uint256) external;
}

interface IVRFServiceSub {
    function subscriptionId() external view returns (uint256);
}

/// @dev Chainlink VRF v2.5 coordinator used by FWA's VRF service; anyone may fund a subscription with native ETH.
interface IVRFCoordinatorFund {
    function fundSubscriptionWithNative(uint256 subId) external payable;
}

interface IFWARefundWindow {
    function DELIVERY_WINDOW() external view returns (uint256);
}

/// @dev Test-only alternative pricing algorithm (the policy interface lets a creator choose one). Mode 0 answers fixed
///      quotes, mode 1 reverts, mode 2 answers above every bound.
contract AcceptancePolicy is IKeeperPolicy {
    uint8 public mode;
    uint256 public rewardQuote;
    uint256 public restockPerShape;

    constructor(uint256 rewardQuote_, uint256 restockPerShape_) {
        rewardQuote = rewardQuote_;
        restockPerShape = restockPerShape_;
    }

    function setMode(uint8 m) external { mode = m; }
    function setRestockPerShape(uint256 v) external { restockPerShape = v; }
    function interfaceVersion() external pure returns (uint256) { return 2; }
    function version() external pure returns (uint256) { return 77; }

    function quoteReward(Work calldata, Economics calldata) external view returns (uint256) {
        if (mode == 1) revert("broken");
        if (mode == 2) return type(uint256).max;
        return rewardQuote;
    }

    function quoteRestock(uint8, uint256 units, uint256, Economics calldata) external view returns (uint256) {
        if (mode == 1) revert("broken");
        if (mode == 2) return type(uint256).max;
        return units * restockPerShape;
    }
}

abstract contract AcceptanceBase is ForkBase {
    bytes32 internal constant KEEPER_PAID = keccak256("KeeperPaid(address,uint256,uint256)");
    bytes32 internal constant SHAPE_LISTED = keccak256("ShapeListed(uint256,uint8,uint256,uint256)");
    bytes32 internal constant SHAPES_MINTED = keccak256("ShapesMinted(uint8,uint256,uint256,uint256)");
    bytes32 internal constant PROCEEDS_COLLECTED = keccak256("ProceedsCollected(uint256)");
    /// Live Shapes admin, the only caller `setMintFee` accepts; impersonated on the fork only.
    address internal constant SHAPES_ADMIN = 0xCB43078C32423F5348Cab5885911C3B5faE217F9;
    address internal constant VRF_COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;

    // Prize targets: sixteen 16-bit counts, size 0 (0.01 ETH Shape) in the low bits, size 1 (0.05 ETH) next.
    uint256 internal constant SIZE1 = 1 << 16;

    struct Run {
        bool ok;
        bytes4 err;
        uint256 paid;
        uint256 measured;
        uint256 listed;
        uint256 mintCost;
        uint256 mintSizes;
        uint256 collected;
        uint256 reconciled;
        uint256 processed;
        uint256 lastLid;
        uint256 lastPrice;
    }

    function _h(IKeeperPolicy.Economics memory e) internal pure returns (bytes32) { return keccak256(abi.encode(e)); }

    function _use(PoolBalancer b) internal {
        balancer = b;
        pool = b.pool();
    }

    function _create(address who, uint256 salt, uint256 t, uint256 deposit, bool curatedReq, uint16 revenueBps)
        internal returns (PoolBalancer b)
    {
        bytes32 h = factory.creationSettingsHash();
        uint256 fee = shapes.mintFee();
        PoolBalancer.CuratedInput[] memory none;
        vm.deal(who, who.balance + deposit);
        vm.prank(who);
        b = PoolBalancer(payable(factory.createBalancer{value: deposit}(bytes32(salt),
            PoolBalancer.CreationConfig(MARKUP, revenueBps, t, fee, curatedReq, h), none)));
        assertEq(address(b).balance, deposit, "creation deposit held by the Balancer");
    }

    /// One upkeep call by the keeper. Every successful call is reconciled against the Balancer's balance:
    /// after + mints + keeper payment == before + collected proceeds, and the keeper received exactly the payment.
    function _run(PoolBalancer b, bool paid) internal returns (Run memory r) {
        IFWAPool p = b.pool();
        uint64 rs0 = b.reconciledSequence();
        uint64 n0 = p.nextSequenceToProcess();
        bytes32 h = b.settingsHash();
        uint256 k0 = keeper.balance;
        uint256 bal0 = address(b).balance;
        vm.recordLogs();
        vm.prank(keeper, keeper);
        if (paid) {
            try b.performUpkeep(h, 0, 0) { r.ok = true; } catch (bytes memory err) { if (err.length >= 4) r.err = bytes4(err); }
        } else {
            try b.performUpkeepUnpaid() { r.ok = true; } catch (bytes memory err) { if (err.length >= 4) r.err = bytes4(err); }
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(b)) continue;
            bytes32 t0 = logs[i].topics[0];
            if (t0 == KEEPER_PAID) {
                (r.paid, r.measured) = abi.decode(logs[i].data, (uint256, uint256));
            } else if (t0 == SHAPE_LISTED) {
                ++r.listed;
                r.lastLid = uint256(logs[i].topics[1]);
                (, r.lastPrice) = abi.decode(logs[i].data, (uint256, uint256));
            } else if (t0 == SHAPES_MINTED) {
                (,, uint256 cost) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                r.mintCost += cost;
                ++r.mintSizes;
            } else if (t0 == PROCEEDS_COLLECTED) {
                r.collected += abi.decode(logs[i].data, (uint256));
            }
        }
        r.reconciled = b.reconciledSequence() - rs0;
        r.processed = p.nextSequenceToProcess() - n0;
        assertEq(keeper.balance - k0, r.paid, "keeper received exactly the emitted payment");
        if (r.ok) {
            assertEq(address(b).balance + r.mintCost + r.paid, bal0 + r.collected, "upkeep ETH flow balances");
        } else {
            assertEq(address(b).balance, bal0, "failed upkeep moved no ETH");
        }
    }

    function _fillAll(PoolBalancer b) internal returns (uint256 calls, uint256 paid, uint256 mint) {
        for (uint256 i; i < 60; ++i) {
            Run memory r = _run(b, true);
            if (!r.ok) {
                assertEq(r.err, PoolBalancer.NoUpkeepNeeded.selector, "fill ends only when nothing is left");
                return (calls, paid, mint);
            }
            ++calls;
            paid += r.paid;
            mint += r.mintCost;
        }
        revert("fill never settled");
    }

    /// One purchase on FWA, randomness delivered through the real VRF service, then FWA's queue processed.
    function _draw(PoolBalancer b) internal returns (uint256 requestId) {
        _use(b);
        uint256[] memory ids = buy(buyer, 1);
        requestId = ids[0];
        fulfill(requestId, 0);
        settle();
    }

    /// Draw the first tracked 0.01 ETH Shape prize specifically (the board may also hold curated NFTs).
    function _drawShape(PoolBalancer b) internal {
        _use(b);
        uint256[] memory ids = b.getActiveIds();
        uint256 slot;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 d,,,) = b.items(ids[i]);
            if (kind == 2 && d == 0) {
                (,,,,,, slot,) = pool.listings(ids[i]);
                break;
            }
        }
        require(slot != 0, "no 0.01 Shape listed");
        uint256 word = wordForSlot(slot);
        uint256[] memory req = buy(buyer, 1);
        fulfill(req[0], word);
        settle();
    }

    function _buyReverts() internal {
        (,, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 v = pool.inventoryVersion();
        vm.expectRevert();
        vm.prank(buyer, buyer);
        pool.acquireBatch{value: total}(buyer, 1, 0, 0, 10_000, v, block.timestamp + 1);
    }

    function _setFee(uint256 fee) internal {
        vm.prank(SHAPES_ADMIN);
        IShapesFeeAdmin(SHAPES).setMintFee(fee);
        assertEq(shapes.mintFee(), fee);
    }

    // ---- independent arithmetic of the owner's V1 schedule over one effective configuration ----

    /// Reference gas price: basefee plus the priority allowance, capped at the ceiling.
    function _ref(IKeeperPolicy.Economics memory e) internal view returns (uint256 p) {
        p = block.basefee + e.priorityAllowance;
        if (p > e.gasPriceCeiling) p = e.gasPriceCeiling;
    }

    /// Restocking surcharge on one prize holding `units` Shapes, at the current basefee.
    function _surcharge(IKeeperPolicy.Economics memory e, uint256 units) internal view returns (uint256) {
        return units * (uint256(e.restockGas) * _ref(e) + e.restockFlat);
    }

    function _work(uint256 measured, uint256 processed, uint256 draws, uint256 units, uint256 prizes)
        internal view returns (IKeeperPolicy.Work memory)
    {
        return IKeeperPolicy.Work(measured, tx.gasprice, block.basefee, draws, units, prizes, processed);
    }

    /// Payment for verified work: gas = min(measured, sum of the operation bounds, maxGas), at
    /// min(reference price, transaction gas price), plus overhead, plus the work fee per reconciled draw and listed Shape.
    function _pay(IKeeperPolicy.Economics memory e, IKeeperPolicy.Work memory w) internal pure returns (uint256) {
        uint256 bound = uint256(e.baseGas) + w.processedDraws * e.processGas + w.reconciledDraws * e.reconcileGas
            + w.listedShapeUnits * e.shapeGas + w.listedPrizes * e.prizeGas;
        if (bound > e.maxGas) bound = e.maxGas;
        uint256 gas = w.measuredGas < bound ? w.measuredGas : bound;
        uint256 price = w.baseFee + e.priorityAllowance;
        if (price > e.gasPriceCeiling) price = e.gasPriceCeiling;
        if (price > w.gasPrice) price = w.gasPrice;
        return (gas + e.overheadGas) * price + (w.reconciledDraws + w.listedShapeUnits) * e.workFee;
    }

    /// Payment bound for one call at the reference price (reserve and maintenance budgets).
    function _bound(IKeeperPolicy.Economics memory e, uint256 processed, uint256 draws, uint256 units, uint256 prizes)
        internal view returns (uint256)
    {
        uint256 gas = uint256(e.baseGas) + processed * e.processGas + draws * e.reconcileGas + units * e.shapeGas
            + prizes * e.prizeGas;
        if (gas > e.maxGas) gas = e.maxGas;
        return (gas + e.overheadGas) * _ref(e) + (draws + units) * e.workFee;
    }

    /// One bounded operating call while open with nothing owed: the larger of five reconciles plus five Shape units,
    /// or two processed draws plus five reconciles.
    function _maintenance(IKeeperPolicy.Economics memory e) internal view returns (uint256) {
        uint256 a = _bound(e, 0, 5, 5, 5);
        uint256 b = _bound(e, 2, 5, 0, 0);
        return a > b ? a : b;
    }

    function _maxPayment(IKeeperPolicy.Economics memory e) internal pure returns (uint256) {
        return (uint256(e.maxGas) + e.overheadGas) * e.gasPriceCeiling + 10 * uint256(e.workFee);
    }

    /// Price of a new single-Shape prize of `amount` backing.
    function _listPrice(IKeeperPolicy.Economics memory e, uint256 amount, uint256 fee, uint256 markup)
        internal view returns (uint256)
    {
        return amount + fee + amount * markup / 10_000 + _surcharge(e, 1);
    }

    function _surchargeOf(PoolBalancer b, uint256 lid) internal view returns (uint256) {
        (,,, uint112 base, uint112 price) = b.items(lid);
        return price - base;
    }

    function _prices(PoolBalancer b) internal view returns (uint256[] memory ids, uint256[] memory prices) {
        ids = b.getActiveIds();
        prices = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) (,,,, prices[i]) = b.items(ids[i]);
    }

    function _assertPricesKept(PoolBalancer b, uint256[] memory ids, uint256[] memory prices) internal view {
        IFWAPool p = b.pool();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,, uint112 price) = b.items(ids[i]);
            if (kind == 0) continue; // drawn since
            assertEq(price, prices[i], "an existing listing keeps its price");
            (,,,,, uint256 fwaPrice,,) = p.listings(ids[i]);
            assertEq(fwaPrice, prices[i], "FWA holds the same price");
        }
    }
}

contract CommunityConfigAcceptanceTest is AcceptanceBase {
    address internal creator2 = makeAddr("creator2");
    address internal creator3 = makeAddr("creator3");
    address internal heir = makeAddr("heir");

    function setUp() public {
        setUpFork();
        curatedRequired = false;
        vm.deal(creator2, 100 ether);
        vm.deal(creator3, 100 ether);
    }

    /*//////////////////////////////////////////////////////////////
          Initial values the spec fixes (A§4, A§5, B§2, B§3)
    //////////////////////////////////////////////////////////////*/

    function test_case00_initialValues() public {
        IKeeperPolicy.Economics memory e = factory.economics();
        assertEq(e.workFee, 0.00002 ether, "work fee");
        assertEq(e.maxGas, 3_200_000, "reimbursable gas limit");
        assertEq(e.gasPriceCeiling, 5 gwei, "gas price ceiling");
        assertEq(e.priorityAllowance, 0.05 gwei, "priority allowance");
        assertEq(e.restockFlat, 0.0002 ether, "restocking flat charge per Shape");
        // Documented recalibrations from fresh measurement (spec allows a justified adjustment; docs/GAS.md "Slice A3").
        assertEq(e.overheadGas, 60_000, "overhead (V1 50k, recalibrated)");
        assertEq(e.restockGas, 910_000, "restocking gas per Shape (V1 900k, recalibrated)");
        assertEq(factory.defaultBucketCapacity(), 0.622 ether, "bucket capacity");
        assertEq(factory.defaultBucketRefill(), uint256(0.05 ether) / 12, "bucket refill floor(0.05 ETH / 12)");
        (uint16 maxPrizes, uint16 minMarkup, uint16 maxMarkup) = factory.productLimits();
        assertEq(maxPrizes, 1_000);
        assertEq(minMarkup, 1_000);
        assertEq(maxMarkup, 10_000);
        PoolBalancer b = _create(creator, 1, 2, 1 ether, false, 0);
        assertEq(b.fillGateBps(), 7_000, "fill threshold default");
        assertEq(b.backlogThreshold(), 5, "backlog threshold default");
        assertEq(b.economicsSource(), 0, "new pools follow the factory");
        assertTrue(b.paidUpkeepEnabled());
        // Derived bounds come from the schedule, not a stored outer ceiling.
        assertEq(b.policyMaxReward(), _maxPayment(e), "max payment = (maxGas + overhead) * ceiling + 10 * work fee");
        assertEq(b.policyMaxReward(), 0.0165 ether);
        assertEq(b.maxRestockSurchargePerShape(), uint256(e.restockGas) * e.gasPriceCeiling + e.restockFlat);
        assertEq(b.maxRestockSurchargePerShape(), 0.00475 ether);
    }

    /*//////////////////////////////////////////////////////////////
                    1. two followers and one pinned pool
    //////////////////////////////////////////////////////////////*/

    function test_case01_followersAdoptFactoryUpdateImmediately_pinnedKeepsActualValues() public {
        PoolBalancer a = _create(creator, 11, 2, 1 ether, false, 0);
        PoolBalancer b = _create(creator2, 12, 2, 1 ether, false, 0);
        PoolBalancer c = _create(creator3, 13, 2, 1 ether, false, 0);
        IKeeperPolicy.Economics memory e0 = factory.economics();
        vm.prank(creator3);
        c.pinEconomics();
        assertEq(c.economicsSource(), 2);

        IKeeperPolicy.Economics memory e1 = factory.economics();
        e1.policy = address(new KeeperPolicyV1());
        e1.workFee = 0.0001 ether;
        e1.maxGas = 4_000_000;
        e1.overheadGas = 70_000;
        e1.gasPriceCeiling = 7 gwei;
        e1.priorityAllowance = 0.2 gwei;
        e1.restockGas = 1_200_000;
        e1.restockFlat = 0.0005 ether;
        e1.shapeGas = 750_000;
        factory.setEconomics(e1);

        // Followers: the new configuration, in the same block, without any per-pool transaction.
        assertEq(_h(a.effectiveEconomics()), _h(e1), "follower A adopted");
        assertEq(_h(b.effectiveEconomics()), _h(e1), "follower B adopted");
        assertEq(a.keeperPolicy(), e1.policy);
        assertEq(a.restockFee(), _surcharge(e1, 1));
        assertEq(a.policyMaxReward(), _maxPayment(e1));
        // Pinned: the complete earlier values: algorithm, payment envelope, restocking and fallback schedule.
        assertEq(_h(c.effectiveEconomics()), _h(e0), "pinned pool kept every value");
        assertEq(c.keeperPolicy(), e0.policy);
        assertEq(c.restockFee(), _surcharge(e0, 1));
        assertEq(c.policyMaxReward(), _maxPayment(e0));
        assertEq(c.maxRestockSurchargePerShape(), uint256(e0.restockGas) * e0.gasPriceCeiling + e0.restockFlat);

        // Actual money: a follower is paid and restocks under e1, the pinned pool under e0.
        Run memory ra = _run(a, true);
        assertTrue(ra.ok);
        assertEq(ra.listed, 2);
        assertEq(ra.paid, _pay(e1, _work(ra.measured, 0, 0, 2, 2)), "follower paid under the new economics");
        assertEq(_surchargeOf(a, ra.lastLid), _surcharge(e1, 1));
        assertEq(ra.lastPrice, _listPrice(e1, 0.01 ether, shapes.mintFee(), MARKUP));
        Run memory rb = _run(b, true);
        assertEq(rb.paid, _pay(e1, _work(rb.measured, 0, 0, 2, 2)));
        Run memory rc = _run(c, true);
        assertTrue(rc.ok);
        assertEq(rc.paid, _pay(e0, _work(rc.measured, 0, 0, 2, 2)), "pinned pool paid under its pinned economics");
        assertEq(_surchargeOf(c, rc.lastLid), _surcharge(e0, 1));

        // Constant work: a factory update costs the same with 3 pools as with 8.
        IKeeperPolicy.Economics memory e2 = factory.economics();
        e2.workFee = 0.00009 ether;
        uint256 snap = vm.snapshotState();
        factory.economics();
        uint256 gasFew = this.measureSetEconomics(e2);
        vm.revertToState(snap);
        for (uint256 i; i < 5; ++i) _create(creator, 100 + i, 2, 0.2 ether, false, 0);
        factory.economics();
        uint256 gasMany = this.measureSetEconomics(e2);
        assertEq(gasMany, gasFew, "factory update cost does not depend on the number of pools");
    }

    /// @dev Measured in its own call frame so the test's memory growth does not enter the comparison.
    function measureSetEconomics(IKeeperPolicy.Economics calldata e) external returns (uint256 used) {
        require(msg.sender == address(this));
        uint256 g = gasleft();
        factory.setEconomics(e);
        used = g - gasleft();
    }

    /// A pinned pool's fallback is its own pinned schedule, not the factory's later one.
    function test_case01b_pinnedFallbackUsesPinnedSchedule() public {
        AcceptancePolicy alt = new AcceptancePolicy(1e12, 1e12);
        IKeeperPolicy.Economics memory ep = factory.economics();
        ep.policy = address(alt);
        ep.restockGas = 1_000_000;
        ep.restockFlat = 0.0004 ether;
        factory.setEconomics(ep);
        PoolBalancer d = _create(creator, 14, 2, 1 ether, false, 0);
        vm.prank(creator);
        d.pinEconomics();
        IKeeperPolicy.Economics memory e1 = factory.economics();
        e1.policy = address(new KeeperPolicyV1());
        e1.restockGas = 500_000;
        e1.restockFlat = 0.0001 ether;
        factory.setEconomics(e1);
        alt.setMode(1); // the pinned algorithm now fails
        Run memory r = _run(d, false);
        assertTrue(r.ok, "unpaid restocking still works with a failed pinned algorithm");
        assertEq(r.listed, 2);
        assertEq(_surchargeOf(d, r.lastLid), _surcharge(ep, 1), "fallback from the pinned schedule");
    }

    /*//////////////////////////////////////////////////////////////
                    2. pinned, defaults change, resume
    //////////////////////////////////////////////////////////////*/

    function test_case02_resumeFollowingAdoptsLatestFactoryConfiguration() public {
        PoolBalancer c = _create(creator, 21, 2, 1 ether, false, 0);
        IKeeperPolicy.Economics memory e0 = factory.economics();
        vm.prank(creator);
        c.pinEconomics();

        IKeeperPolicy.Economics memory e1 = factory.economics();
        e1.workFee = 0.00003 ether;
        factory.setEconomics(e1);
        IKeeperPolicy.Economics memory e2 = factory.economics();
        e2.workFee = 0.00004 ether;
        e2.restockFlat = 0.0003 ether;
        e2.policy = address(new KeeperPolicyV1());
        factory.setEconomics(e2);
        assertEq(_h(c.effectiveEconomics()), _h(e0), "still pinned through two factory updates");

        vm.prank(creator);
        c.followFactoryEconomics();
        assertEq(c.economicsSource(), 0);
        assertEq(_h(c.effectiveEconomics()), _h(e2), "resumed with the latest factory configuration");
        assertEq(c.restockFee(), _surcharge(e2, 1));
        Run memory r = _run(c, true);
        assertTrue(r.ok);
        assertEq(r.paid, _pay(e2, _work(r.measured, 0, 0, 2, 2)));
        assertEq(_surchargeOf(c, r.lastLid), _surcharge(e2, 1));

        // Following again: the next factory update applies at once.
        IKeeperPolicy.Economics memory e3 = factory.economics();
        e3.workFee = 0.00005 ether;
        factory.setEconomics(e3);
        assertEq(_h(c.effectiveEconomics()), _h(e3));

        // Same for local economics: kept through factory updates, then resume picks up the latest.
        IKeeperPolicy.Economics memory el = factory.economics();
        el.workFee = 0.00001 ether;
        vm.prank(creator);
        c.setLocalEconomics(el);
        assertEq(c.economicsSource(), 1);
        IKeeperPolicy.Economics memory e4 = factory.economics();
        e4.workFee = 0.00006 ether;
        factory.setEconomics(e4);
        assertEq(_h(c.effectiveEconomics()), _h(el), "local economics kept through a factory update");
        vm.prank(creator);
        c.followFactoryEconomics();
        assertEq(_h(c.effectiveEconomics()), _h(e4));
    }

    /*//////////////////////////////////////////////////////////////
                3. fee change at the same policy address
    //////////////////////////////////////////////////////////////*/

    function test_case03_feeChangeSamePolicyAddress_hashPreviewsAndPaymentsUpdate() public {
        PoolBalancer f = _create(creator, 31, 2, 1 ether, false, 0);
        PoolBalancer pn = _create(creator2, 32, 2, 1 ether, false, 0);
        vm.prank(creator2);
        pn.pinEconomics();
        IKeeperPolicy.Economics memory e0 = factory.economics();
        bytes32 hf = f.settingsHash();
        bytes32 hp = pn.settingsHash();
        bytes32 hc = factory.creationSettingsHash();
        IKeeperPolicy.Work memory w = _work(900_000, 0, 1, 2, 2);
        uint256 q0 = f.quoteKeeperReward(w);
        assertEq(q0, _pay(e0, w));

        IKeeperPolicy.Economics memory e1 = factory.economics();
        e1.workFee = 0.0001 ether;
        e1.restockFlat = 0.0004 ether;
        factory.setEconomics(e1);
        assertEq(f.keeperPolicy(), e0.policy, "same policy address");

        assertTrue(f.settingsHash() != hf, "follower hash moved with the fee");
        assertTrue(factory.creationSettingsHash() != hc, "creation hash moved with the fee");
        assertEq(pn.settingsHash(), hp, "pinned hash unchanged by the factory update");
        assertEq(f.quoteKeeperReward(w), _pay(e1, w), "quote preview at the new fee");
        assertTrue(f.quoteKeeperReward(w) != q0);
        assertEq(f.restockFee(), _surcharge(e1, 1), "restocking preview at the new flat charge");
        assertEq(f.policyMaxReward(), _maxPayment(e1));
        assertEq(pn.restockFee(), _surcharge(e0, 1));
        assertEq(pn.quoteKeeperReward(w), _pay(e0, w));

        // A keeper still holding the old hash is refused; the refreshed hash is paid at the new fee.
        bytes32 h = hf;
        vm.prank(keeper, keeper);
        vm.expectRevert(PoolBalancer.StaleSettings.selector);
        f.performUpkeep(h, 0, 0);
        Run memory r = _run(f, true);
        assertTrue(r.ok);
        assertEq(r.paid, _pay(e1, _work(r.measured, 0, 0, 2, 2)));
        assertEq(r.paid, f.quoteKeeperReward(_work(r.measured, 0, 0, 2, 2)), "payment equals the preview for the same work");
        assertEq(_surchargeOf(f, r.lastLid), _surcharge(e1, 1));
        Run memory rp = _run(pn, true);
        assertEq(rp.paid, _pay(e0, _work(rp.measured, 0, 0, 2, 2)));

        // Unrelated factory updates leave a pinned pool's economic identity alone.
        hp = pn.settingsHash();
        factory.setDefaultBucket(1 ether, 1 gwei);
        factory.setProductLimits(500, 1_000, 9_000);
        IKeeperPolicy.Economics memory e2 = factory.economics();
        e2.workFee = 0.0002 ether;
        factory.setEconomics(e2);
        assertEq(pn.settingsHash(), hp, "pinned hash unchanged by unrelated factory updates");
    }

    /*//////////////////////////////////////////////////////////////
       4. disable survives factory changes; re-enable and local changes are immediate
    //////////////////////////////////////////////////////////////*/

    function test_case04_disableSurvivesFactory_reenableAndLocalChangesNeedNoTimeAdvance() public {
        PoolBalancer b = _create(creator, 41, 3, 1 ether, false, 0);
        _fillAll(b);
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(creator);
        b.setPaidUpkeepEnabled(false);

        IKeeperPolicy.Economics memory e1 = factory.economics();
        e1.workFee = 0.00003 ether;
        factory.setEconomics(e1);
        IKeeperPolicy.Economics memory e2 = factory.economics();
        e2.policy = address(new KeeperPolicyV1());
        e2.workFee = 0.00004 ether;
        factory.setEconomics(e2);
        assertFalse(b.paidUpkeepEnabled(), "disable survives factory updates");
        assertEq(_h(b.effectiveEconomics()), _h(e2));

        _draw(b);
        Run memory r = _run(b, true);
        assertFalse(r.ok);
        assertEq(r.err, PoolBalancer.PaymentUnavailable.selector, "no paid upkeep while disabled");

        vm.prank(creator);
        b.setPaidUpkeepEnabled(true);
        assertTrue(b.paidUpkeepEnabled());
        r = _run(b, true);
        assertTrue(r.ok, "paid upkeep works in the same block as the re-enable");
        assertEq(r.reconciled, 1);
        assertEq(r.listed, 1);
        assertEq(r.paid, _pay(e2, _work(r.measured, 0, 1, 1, 1)));

        // Local policy change: immediate, keeps the effective numbers and the paid state.
        AcceptancePolicy alt = new AcceptancePolicy(12_345, 777);
        vm.prank(creator);
        b.setKeeperPolicy(address(alt));
        assertEq(b.keeperPolicy(), address(alt));
        assertEq(b.economicsSource(), 1);
        assertTrue(b.paidUpkeepEnabled());
        assertEq(b.effectiveEconomics().workFee, e2.workFee);
        _draw(b);
        r = _run(b, true);
        assertTrue(r.ok);
        assertEq(r.paid, 12_345, "the new algorithm's quote is paid immediately");
        assertEq(_surchargeOf(b, r.lastLid), 777, "the new algorithm prices restocking immediately");

        // Local economics: immediate.
        IKeeperPolicy.Economics memory e3 = factory.economics();
        e3.workFee = 0.00005 ether;
        e3.restockFlat = 0.0007 ether;
        vm.prank(creator);
        b.setLocalEconomics(e3);
        assertEq(_h(b.effectiveEconomics()), _h(e3));
        _draw(b);
        r = _run(b, true);
        assertTrue(r.ok);
        assertEq(r.paid, _pay(e3, _work(r.measured, 0, 1, 1, 1)));
        assertEq(_surchargeOf(b, r.lastLid), _surcharge(e3, 1));
        assertEq(vm.getBlockTimestamp(), t0, "no time advanced for any of these changes");

        // Creator transfer keeps the selected economics and the disabled state; only the new creator re-enables.
        vm.prank(creator);
        b.setPaidUpkeepEnabled(false);
        vm.prank(creator);
        b.transferCreator(heir);
        vm.prank(heir);
        b.acceptCreator();
        assertFalse(b.paidUpkeepEnabled());
        assertEq(b.economicsSource(), 1);
        assertEq(_h(b.effectiveEconomics()), _h(e3));
        factory.setEconomics(e1);
        assertFalse(b.paidUpkeepEnabled(), "still disabled after another factory update");
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        b.setPaidUpkeepEnabled(true);
        vm.prank(heir);
        b.setPaidUpkeepEnabled(true);
        assertTrue(b.paidUpkeepEnabled());
    }

    /*//////////////////////////////////////////////////////////////
                    5. unauthorized settings changes fail
    //////////////////////////////////////////////////////////////*/

    function test_case05_unauthorizedSettingsChangesFail() public {
        PoolBalancer b = _create(creator, 51, 2, 1 ether, false, 0);
        IKeeperPolicy.Economics memory e = factory.economics();
        e.workFee = 1 ether;
        bytes32 fh = _h(factory.economics());

        address[4] memory notAdmin = [stranger, creator, keeperAdmin, keeper];
        for (uint256 i; i < notAdmin.length; ++i) {
            vm.startPrank(notAdmin[i]);
            vm.expectRevert(BalancerFactory.Unauthorized.selector);
            factory.setEconomics(e);
            vm.expectRevert(BalancerFactory.Unauthorized.selector);
            factory.setDefaultBucket(1, 1);
            vm.expectRevert(BalancerFactory.Unauthorized.selector);
            factory.setProductLimits(1, 1, 1);
            vm.expectRevert(BalancerFactory.Unauthorized.selector);
            factory.transferPolicyAdmin(notAdmin[i]);
            vm.stopPrank();
        }
        assertEq(_h(factory.economics()), fh);

        // The factory administrator (this test contract) has no authority over a pool's local settings either.
        address[4] memory notCreator = [stranger, address(this), keeperAdmin, keeper];
        for (uint256 i; i < notCreator.length; ++i) {
            vm.startPrank(notCreator[i]);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            b.setLocalEconomics(e);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            b.pinEconomics();
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            b.followFactoryEconomics();
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            b.setKeeperPolicy(address(1));
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            b.setPaidUpkeepEnabled(false);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            b.setKeeperBucket(1, 1);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            b.setFillGateBps(0);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            b.setBacklogThreshold(9);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            b.configure(MARKUP, 3, 0.001 ether);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            b.setCuratedRequired(true);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            b.setCreatorRevenueBps(1);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            b.close();
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            b.claimSurplus(1, notCreator[i]);
            vm.stopPrank();
        }
        assertEq(b.economicsSource(), 0);
        assertTrue(b.paidUpkeepEnabled());
        assertEq(b.keeperBucketCapacity(), 0.622 ether);
        assertEq(b.fillGateBps(), 7_000);
        assertEq(b.backlogThreshold(), 5);

        // Policy administration moves only through the two-step transfer.
        address next = makeAddr("nextPolicyAdmin");
        factory.transferPolicyAdmin(next);
        vm.prank(next);
        vm.expectRevert(BalancerFactory.Unauthorized.selector);
        factory.setEconomics(e);
        vm.prank(next);
        factory.acceptPolicyAdmin();
        vm.expectRevert(BalancerFactory.Unauthorized.selector);
        factory.setEconomics(e);
        vm.prank(next);
        factory.setEconomics(e);
        assertEq(factory.economics().workFee, 1 ether);
    }

    /*//////////////////////////////////////////////////////////////
                         6. underfunded follower
    //////////////////////////////////////////////////////////////*/

    function test_case06a_underfundedFollower_updateSucceeds_paidLimitedByCash_unpaidAndCreditUsable() public {
        PoolBalancer f = _create(creator, 61, 4, 0.3 ether, false, 5_000);
        _fillAll(f);
        _draw(f);
        assertTrue(_run(f, true).ok);
        // Drain every withdrawable wei: operating cash is now exactly the reserve.
        uint256 drain = f.withdrawableSurplus();
        vm.prank(creator);
        f.claimSurplus(drain, creator);
        assertEq(f.creatorCredit(), 0);
        assertEq(address(f).balance, f.requiredReserve());
        // New protected creator credit from a collected sale.
        _draw(f);
        uint256 got = f.collectProceeds();
        uint256 credit = got * 5_000 / 10_000;
        assertEq(f.creatorCredit(), credit, "credit is exactly half the collected proceeds");

        IKeeperPolicy.Economics memory e1 = factory.economics();
        e1.workFee = 0.05 ether;
        factory.setEconomics(e1); // no per-follower cash check
        assertEq(_h(f.effectiveEconomics()), _h(e1), "follower uses the new economics, not the old ones");

        uint256 fund = address(f).balance - f.creatorCredit();
        (uint256 req, uint256 shortfall) = f.maintenanceFunding(f.effectiveEconomics());
        assertGt(req, fund, "the update created a shortfall");
        assertEq(shortfall, req - fund, "shortfall exposed exactly");
        assertGt(f.requiredReserve(), fund);
        assertEq(f.withdrawableSurplus(), f.creatorCredit(), "only protected credit is withdrawable");

        // Paid spending is limited by actual cash: the reconcile would pay at least 0.05 ETH.
        Run memory r = _run(f, true);
        assertFalse(r.ok);
        assertEq(r.err, PoolBalancer.PaymentUnavailable.selector);
        assertEq(f.reconciledSequence(), 1, "nothing reconciled by the refused paid call");

        // Unpaid maintenance still works and touches no credit.
        uint256 s0 = stranger.balance;
        uint64 rs = f.reconciledSequence();
        vm.prank(stranger);
        f.performUpkeepUnpaid();
        assertEq(f.reconciledSequence(), rs + 1);
        assertEq(stranger.balance, s0, "unpaid caller received nothing");
        assertEq(f.creatorCredit(), credit);

        // Protected credit is claimable in full.
        uint256 c0 = creator.balance;
        vm.prank(creator);
        f.claimSurplus(credit, creator);
        assertEq(creator.balance - c0, credit);

        // Recovery and exit: close, unlist and redeem every prize for its exact backing, withdraw everything.
        vm.prank(creator);
        f.close();
        uint256[] memory ids = f.getActiveIds();
        uint256 backing;
        for (uint256 i; i < ids.length; ++i) {
            (, uint8 d,,,) = f.items(ids[i]);
            backing += f.denominationAmount(d);
        }
        uint256 b0 = address(f).balance;
        vm.prank(creator);
        f.unlistShapes(ids);
        assertEq(address(f).balance - b0, backing, "redeemed exactly the backing");
        assertEq(f.requiredReserve(), 0);
        uint256 all = address(f).balance;
        assertEq(f.withdrawableSurplus(), all);
        c0 = creator.balance;
        vm.prank(creator);
        f.claimSurplus(all, creator);
        assertEq(creator.balance - c0, all);
        assertEq(address(f).balance, 0);
    }

    function test_case06b_paidSpendingLimitedByBucket_unpaidUnaffected() public {
        PoolBalancer f = _create(creator, 62, 3, 1 ether, false, 0);
        _fillAll(f);
        vm.prank(creator);
        f.setKeeperBucket(1_000, 0);
        assertEq(f.availableKeeperAllowance(), 1_000);
        _draw(f);
        Run memory r = _run(f, true);
        assertFalse(r.ok);
        assertEq(r.err, PoolBalancer.PaymentUnavailable.selector, "payment above the bucket is refused");
        // Raising capacity does not refill; only time at the new rate does.
        vm.prank(creator);
        f.setKeeperBucket(1 ether, 1e15);
        assertEq(f.availableKeeperAllowance(), 1_000);
        r = _run(f, true);
        assertFalse(r.ok);
        vm.warp(block.timestamp + 10);
        uint256 avail = f.availableKeeperAllowance();
        assertEq(avail, 1_000 + 10 * 1e15);
        r = _run(f, true);
        assertTrue(r.ok);
        assertEq(f.availableKeeperAllowance(), avail - r.paid, "spent exactly the payment");
        // Unpaid work is never limited by the bucket.
        vm.prank(creator);
        f.setKeeperBucket(0, 0);
        _draw(f);
        r = _run(f, false);
        assertTrue(r.ok);
        assertEq(r.reconciled, 1);
        assertEq(r.paid, 0);
    }

    /*//////////////////////////////////////////////////////////////
                    7. product limits and creator gates
    //////////////////////////////////////////////////////////////*/

    function test_case07a_prizeMaximum_lowerKeepsExistingDesign() public {
        PoolBalancer b = _create(creator, 71, 5, 1 ether, false, 0);
        _fillAll(b);
        uint256 fee = shapes.mintFee();
        factory.setProductLimits(3, 1_000, 10_000);

        vm.startPrank(creator);
        b.configure(MARKUP, 5, fee); // re-save the existing larger design
        b.configure(MARKUP, 4 + SIZE1, fee); // another mix with no more prizes
        vm.expectRevert(PoolBalancer.InvalidPlan.selector);
        b.configure(MARKUP, 6, fee); // grow above max(current, maximum)
        b.configure(MARKUP, 4, fee); // shrink
        vm.expectRevert(PoolBalancer.InvalidPlan.selector);
        b.configure(MARKUP, 5, fee); // after shrinking, the larger design is no longer current
        vm.stopPrank();

        // Upkeep, purchases and withdrawals keep working above the new maximum (target 4 > 3).
        _draw(b);
        Run memory r = _run(b, true);
        assertTrue(r.ok);
        assertEq(r.reconciled, 1);
        assertEq(b.listedShapePrizes(), 4);
        _draw(b);
        r = _run(b, true);
        assertTrue(r.ok);
        assertEq(r.listed, 1, "restocking still runs on a pool above the lowered maximum");
        assertEq(b.listedShapePrizes(), 4);

        // New designs are checked against the current limits.
        bytes32 h = factory.creationSettingsHash();
        PoolBalancer.CuratedInput[] memory none;
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidPlan.selector);
        factory.createBalancer{value: 1 ether}(bytes32(uint256(711)),
            PoolBalancer.CreationConfig(MARKUP, 0, 4, fee, false, h), none);
        _create(creator, 712, 3, 1 ether, false, 0);

        vm.expectRevert(BalancerFactory.InvalidLimits.selector);
        factory.setProductLimits(0, 1_000, 10_000);
        vm.expectRevert(BalancerFactory.InvalidLimits.selector);
        factory.setProductLimits(10, 0, 10_000);
        vm.expectRevert(BalancerFactory.InvalidLimits.selector);
        factory.setProductLimits(10, 5_000, 4_000);

        factory.setProductLimits(1_000, 1_000, 10_000);
        vm.prank(creator);
        b.configure(MARKUP, 6, fee);
        assertEq(b.target(), 6, "raising the maximum allows growth again");

        // Withdrawal path under lowered limits.
        factory.setProductLimits(1, 1_000, 10_000);
        vm.prank(creator);
        b.close();
        uint256[] memory ids = b.getActiveIds();
        uint256 b0 = address(b).balance;
        vm.prank(creator);
        b.unlistShapes(ids);
        assertEq(address(b).balance - b0, ids.length * 0.01 ether);
        uint256 all = b.withdrawableSurplus();
        vm.prank(creator);
        b.claimSurplus(all, creator);
        assertEq(address(b).balance, 0);
    }

    function test_case07b_markupRange_noStrandingNoSilentReprice() public {
        PoolBalancer b = _create(creator, 72, 3, 1 ether, false, 0);
        _fillAll(b);
        (uint256[] memory ids, uint256[] memory prices) = _prices(b);
        uint256 fee = shapes.mintFee();
        factory.setProductLimits(1_000, 2_000, 3_000);

        vm.startPrank(creator);
        b.configure(MARKUP, 3, fee); // the current out-of-range markup may be kept
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        b.configure(1_800, 3, fee);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        b.configure(3_500, 3, fee);
        vm.stopPrank();
        _assertPricesKept(b, ids, prices);

        // Restocking at the kept markup is not repriced by the range change.
        IKeeperPolicy.Economics memory e = b.effectiveEconomics();
        _draw(b);
        Run memory r = _run(b, true);
        assertTrue(r.ok);
        assertEq(r.lastPrice, _listPrice(e, 0.01 ether, fee, MARKUP), "new listing at the creator's kept markup");

        vm.prank(creator);
        b.configure(2_500, 3, fee);
        assertEq(b.markupBps(), 2_500);
        _assertPricesKept(b, ids, prices);
        _draw(b);
        r = _run(b, true);
        assertEq(r.lastPrice, _listPrice(e, 0.01 ether, fee, 2_500), "new listing at the newly chosen markup");
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        b.configure(MARKUP, 3, fee); // once changed, the old out-of-range value is no longer current

        bytes32 h = factory.creationSettingsHash();
        PoolBalancer.CuratedInput[] memory none;
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        factory.createBalancer{value: 1 ether}(bytes32(uint256(721)),
            PoolBalancer.CreationConfig(MARKUP, 0, 3, fee, false, h), none);
        vm.prank(creator);
        factory.createBalancer{value: 1 ether}(bytes32(uint256(722)),
            PoolBalancer.CreationConfig(2_000, 0, 3, fee, false, h), none);
    }

    function test_case07c_fillThreshold_zeroKeepsUnavailableInventoryCheck() public {
        PoolBalancer b = _create(creator, 73, 2, 1 ether, false, 0);
        _use(b);
        _fillAll(b);
        listCurated(7_301, 0.01 ether);
        listCurated(7_302, 0.01 ether);
        assertEq(b.admissionStatus(), 0);

        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        b.setFillGateBps(10_001);

        // Two 0.01 Shape prizes; one unreconciled draw is assumed to have taken one: 50% of target weight left.
        _draw(b);
        assertEq(b.admissionStatus(), 6, "below the default 70%");
        _buyReverts();
        vm.prank(creator);
        b.setFillGateBps(5_000);
        assertEq(b.admissionStatus(), 0, "exactly at the threshold admits");
        vm.prank(creator);
        b.setFillGateBps(5_001);
        assertEq(b.admissionStatus(), 6, "one bps above refuses");
        vm.prank(creator);
        b.setFillGateBps(10_000);
        assertEq(b.admissionStatus(), 6);
        vm.prank(creator);
        b.setFillGateBps(0);
        assertEq(b.admissionStatus(), 0, "zero removes the target requirement");

        _draw(b);
        assertEq(b.admissionStatus(), 0, "two unavailable, two prizes: still covered");
        _draw(b);
        assertEq(b.admissionStatus(), 6, "three unavailable exceed the prizes: refused even at zero");
        _buyReverts();
    }

    function test_case07d_backlogThreshold_allowsTPlusFourOutstanding() public {
        _fundFwaVrfSubscription(50 ether);
        PoolBalancer b = _create(creator, 74, 30, 2 ether, false, 0);
        _use(b);
        _fillAll(b);
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        b.setBacklogThreshold(0);

        // T = 1: one admission check, then a batch of five.
        vm.prank(creator);
        b.setBacklogThreshold(1);
        uint256[] memory ids = buy(buyer, 5);
        assertEq(pool.unsettledAcquisitionCount(), 5, "T + 4 outstanding");
        assertEq(b.admissionStatus(), 4);
        _buyReverts();
        _settleAll(b, ids);

        // T = 3: two singles, then a batch of five.
        vm.prank(creator);
        b.setBacklogThreshold(3);
        uint256[] memory all = new uint256[](7);
        all[0] = buy(buyer, 1)[0];
        all[1] = buy(buyer, 1)[0];
        assertEq(b.admissionStatus(), 0);
        ids = buy(buyer, 5);
        for (uint256 i; i < 5; ++i) all[2 + i] = ids[i];
        assertEq(pool.unsettledAcquisitionCount(), 7, "T + 4 outstanding");
        assertEq(b.admissionStatus(), 4);
        _buyReverts();
        _settleAll(b, all);

        // Default T = 5: four singles, then a batch of five.
        vm.prank(creator);
        b.setBacklogThreshold(5);
        for (uint256 i; i < 4; ++i) buy(buyer, 1);
        assertEq(b.admissionStatus(), 0);
        buy(buyer, 5);
        assertEq(pool.unsettledAcquisitionCount(), 9, "T + 4 outstanding");
        assertEq(b.admissionStatus(), 4);
        _buyReverts();
    }

    /// @dev FWA's VRF service refuses requests its Chainlink subscription cannot cover (InsufficientVrfCoverage): at the
    ///      fork block 2.6 native ETH covered five outstanding draws but not seven. Fund it through the coordinator's
    ///      public native funding path so the Balancer's own admission boundary is what is measured.
    function _fundFwaVrfSubscription(uint256 amount) internal {
        address funder = makeAddr("vrfFunder");
        vm.deal(funder, amount);
        uint256 subId = IVRFServiceSub(VRF_SERVICE).subscriptionId();
        vm.prank(funder);
        IVRFCoordinatorFund(VRF_COORDINATOR).fundSubscriptionWithNative{value: amount}(subId);
    }

    function _settleAll(PoolBalancer b, uint256[] memory ids) internal {
        for (uint256 i; i < ids.length; ++i) fulfill(ids[i], 0);
        settle();
        _fillAll(b);
        assertEq(pool.unsettledAcquisitionCount(), 0);
    }

    /*//////////////////////////////////////////////////////////////
                 8. across the former hardcoded ceilings
    //////////////////////////////////////////////////////////////*/

    function test_case08a_paymentAndRestockAboveFormerCeilings_thenLower() public {
        PoolBalancer b = _create(creator, 81, 5, 3 ether, false, 0);
        IKeeperPolicy.Economics memory e = factory.economics();
        e.workFee = 0.07 ether;
        e.restockFlat = 0.15 ether;
        factory.setEconomics(e);
        assertEq(b.policyMaxReward(), _maxPayment(e));
        assertGt(b.policyMaxReward(), 0.311 ether, "maximum payment above the former 0.311 ETH ceiling");
        assertEq(b.maxRestockSurchargePerShape(), uint256(e.restockGas) * e.gasPriceCeiling + e.restockFlat);
        assertGt(b.maxRestockSurchargePerShape(), 0.102 ether, "restocking above the former 0.102 ETH per Shape");

        Run memory r = _run(b, true);
        assertTrue(r.ok);
        assertEq(r.listed, 5);
        assertEq(r.paid, _pay(e, _work(r.measured, 0, 0, 5, 5)));
        assertGt(r.paid, 0.311 ether, "an actual payment above the former ceiling, not clamped");
        assertEq(_surchargeOf(b, r.lastLid), _surcharge(e, 1));
        assertGt(_surchargeOf(b, r.lastLid), 0.102 ether);

        IKeeperPolicy.Economics memory lo = factory.economics();
        lo.workFee = 0.000001 ether;
        lo.restockFlat = 0.00001 ether;
        factory.setEconomics(lo);
        _draw(b);
        r = _run(b, true);
        assertTrue(r.ok);
        assertEq(r.paid, _pay(lo, _work(r.measured, 0, 1, 1, 1)));
        assertEq(_surchargeOf(b, r.lastLid), _surcharge(lo, 1));
    }

    function test_case08b_gasPriceAboveFormer50Gwei_largerEnvelope_thenLower() public {
        vm.fee(60 gwei);
        vm.txGasPrice(70 gwei);
        IKeeperPolicy.Economics memory e = factory.economics();
        e.gasPriceCeiling = 100 gwei;
        e.priorityAllowance = 2 gwei;
        e.maxGas = 8_000_000; // former envelope: 6M
        e.overheadGas = 150_000; // former envelope: 100k
        factory.setEconomics(e);
        PoolBalancer b = _create(creator, 82, 2, 3 ether, false, 0);
        assertEq(b.policyMaxReward(), (8_000_000 + 150_000) * 100 gwei + 10 * uint256(e.workFee));
        assertEq(_ref(e), 62 gwei, "basefee 60 + allowance 2, under the 100 gwei ceiling");

        Run memory r = _run(b, true);
        assertTrue(r.ok);
        assertEq(r.paid, _pay(e, _work(r.measured, 0, 0, 2, 2)));
        assertGt(_ref(e), 50 gwei, "reimbursed at a price above the former 50 gwei ceiling");
        assertEq(_surchargeOf(b, r.lastLid), 910_000 * 62 gwei + 0.0002 ether);

        vm.fee(0.5 gwei);
        vm.txGasPrice(1 gwei);
        IKeeperPolicy.Economics memory lo = factory.economics();
        lo.gasPriceCeiling = 0.3 gwei;
        lo.maxGas = 2_000_000;
        lo.overheadGas = 30_000;
        factory.setEconomics(lo);
        assertEq(b.policyMaxReward(), (2_000_000 + 30_000) * 0.3 gwei + 10 * uint256(lo.workFee));
        _draw(b);
        r = _run(b, true);
        assertTrue(r.ok);
        assertEq(r.paid, _pay(lo, _work(r.measured, 0, 1, 1, 1)));
        assertEq(_surchargeOf(b, r.lastLid), 910_000 * 0.3 gwei + 0.0002 ether);
    }

    /*//////////////////////////////////////////////////////////////
       9. quotes, payment, reserve, restocking price and fallback agree
    //////////////////////////////////////////////////////////////*/

    function test_case09_oneEffectiveConfiguration_quotePaymentReserveRestockFallbackAgree() public {
        IKeeperPolicy.Economics memory e = factory.economics();
        e.workFee = 0.00005 ether;
        e.restockGas = 950_000;
        e.restockFlat = 0.0003 ether;
        e.priorityAllowance = 0.1 gwei;
        e.gasPriceCeiling = 4 gwei;
        factory.setEconomics(e);
        PoolBalancer b = _create(creator, 91, 3, 1 ether, false, 0);

        assertEq(b.restockFeeFor(0), _surcharge(e, 1), "single-Shape restocking preview");
        assertEq(b.restockFeeFor(9), _surcharge(e, 2), "0.02 ETH pack (two Shapes) preview");
        IKeeperPolicy.Work memory w = _work(900_000, 0, 1, 2, 2);
        assertEq(b.quoteKeeperReward(w), _pay(e, w));

        Run memory r = _run(b, true);
        assertTrue(r.ok);
        assertEq(r.listed, 3);
        assertEq(r.paid, _pay(e, _work(r.measured, 0, 0, 3, 3)));
        assertEq(r.paid, b.quoteKeeperReward(_work(r.measured, 0, 0, 3, 3)), "paid = preview for the same work");
        assertEq(_surchargeOf(b, r.lastLid), b.restockFeeFor(0), "listed surcharge = preview");

        // Reserve: full stock, nothing owed: exactly one bounded operating call under the same economics.
        assertEq(b.requiredReserve(), _maintenance(e));
        (uint256 req,) = b.maintenanceFunding(b.effectiveEconomics());
        assertEq(req, _maintenance(e));
        // One missing prize adds its backing, its mint fees at the accepted cap and its bounded listing work.
        uint256 r0 = b.requiredReserve();
        uint256 liveFee = shapes.mintFee();
        vm.prank(creator);
        b.configure(MARKUP, 4, liveFee);
        assertEq(b.requiredReserve() - r0, 0.01 ether + b.mintFeeCap() + _bound(e, 0, 0, 1, 1));
        _fillAll(b);

        // Fallback: a failing algorithm with the same numbers. Paid work refuses; unpaid restocking uses the selected
        // economics' own schedule, which equals the healthy V1 price above.
        AcceptancePolicy alt = new AcceptancePolicy(1, 1);
        vm.prank(creator);
        b.setKeeperPolicy(address(alt));
        alt.setMode(1);
        _draw(b);
        r = _run(b, true);
        assertFalse(r.ok);
        assertEq(r.err, PoolBalancer.PolicyUnavailable.selector);
        r = _run(b, false);
        assertTrue(r.ok);
        assertEq(r.listed, 1);
        assertEq(_surchargeOf(b, r.lastLid), _surcharge(e, 1), "fallback = the selected schedule");

        // A malformed (oversized) answer is treated the same way.
        alt.setMode(2);
        _draw(b);
        r = _run(b, true);
        assertFalse(r.ok);
        r = _run(b, false);
        assertTrue(r.ok);
        assertEq(_surchargeOf(b, r.lastLid), _surcharge(e, 1));

        // A healthy policy pricing above the fallback: unpaid callers pay its price, not the cheaper fallback.
        uint256 maxPerShape = uint256(e.restockGas) * e.gasPriceCeiling + e.restockFlat;
        alt.setMode(0);
        alt.setRestockPerShape(maxPerShape);
        assertGt(maxPerShape, _surcharge(e, 1));
        _draw(b);
        r = _run(b, false);
        assertTrue(r.ok);
        assertEq(_surchargeOf(b, r.lastLid), maxPerShape, "unpaid upkeep used the healthy selected policy");
    }

    /*//////////////////////////////////////////////////////////////
              10. stale creation and upkeep expectations
    //////////////////////////////////////////////////////////////*/

    function test_case10a_staleCreationFailsBeforeSideEffects() public {
        bytes32 salt = bytes32(uint256(101));
        address predicted = factory.predictBalancer(creator, salt);
        nft.mint(creator, 1_010);
        vm.prank(creator);
        nft.approve(predicted, 1_010);
        PoolBalancer.CuratedInput[] memory one = new PoolBalancer.CuratedInput[](1);
        one[0] = PoolBalancer.CuratedInput(address(nft), 1_010, 0.2 ether);
        uint256 fee = shapes.mintFee();

        bytes32 reviewed = factory.creationSettingsHash();
        IKeeperPolicy.Economics memory e1 = factory.economics();
        e1.workFee = 0.00003 ether;
        factory.setEconomics(e1);
        uint256 c0 = creator.balance;
        vm.prank(creator);
        vm.expectRevert(BalancerFactory.StaleSettings.selector);
        factory.createBalancer{value: 1 ether}(salt, PoolBalancer.CreationConfig(MARKUP, 0, 2, fee, true, reviewed), one);
        assertEq(predicted.code.length, 0, "no clone deployed");
        assertFalse(factory.isBalancer(predicted));
        assertEq(nft.ownerOf(1_010), creator, "curated NFT not taken");
        assertEq(creator.balance, c0, "no ETH taken");

        // A mint fee change also makes a reviewed creation stale, and a cap below the live fee is refused.
        reviewed = factory.creationSettingsHash();
        _setFee(0.0005 ether);
        vm.prank(creator);
        vm.expectRevert(BalancerFactory.StaleSettings.selector);
        factory.createBalancer{value: 1 ether}(salt, PoolBalancer.CreationConfig(MARKUP, 0, 2, fee, true, reviewed), one);
        _setFee(0.001 ether);
        // A default bucket change also makes a reviewed creation stale: the new pool copies that bucket.
        reviewed = factory.creationSettingsHash();
        factory.setDefaultBucket(0.5 ether, uint96(uint256(0.05 ether) / 12));
        vm.prank(creator);
        vm.expectRevert(BalancerFactory.StaleSettings.selector);
        factory.createBalancer{value: 1 ether}(salt, PoolBalancer.CreationConfig(MARKUP, 0, 2, fee, true, reviewed), one);
        factory.setDefaultBucket(0.622 ether, 1);
        vm.prank(creator);
        vm.expectRevert(BalancerFactory.StaleSettings.selector);
        factory.createBalancer{value: 1 ether}(salt, PoolBalancer.CreationConfig(MARKUP, 0, 2, fee, true, reviewed), one);
        factory.setDefaultBucket(0.622 ether, uint96(uint256(0.05 ether) / 12));
        assertEq(factory.creationSettingsHash(), reviewed, "restoring the bucket restores the reviewed hash");
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        factory.createBalancer{value: 1 ether}(salt, PoolBalancer.CreationConfig(MARKUP, 0, 2, 0.0005 ether, true, reviewed), one);

        vm.prank(creator);
        address made = factory.createBalancer{value: 1 ether}(salt,
            PoolBalancer.CreationConfig(MARKUP, 0, 2, fee, true, reviewed), one);
        assertEq(made, predicted);
        assertEq(c0 - creator.balance, 1 ether);
        assertEq(nft.ownerOf(1_010), address(PoolBalancer(payable(made)).pool()));
    }

    function test_case10b_staleUpkeepFailsBeforeWork_minimumPaymentRespected() public {
        PoolBalancer b = _create(creator, 102, 3, 1 ether, false, 0);
        _fillAll(b);
        _use(b);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], 0); // randomness delivered; FWA processing left to upkeep

        bytes32 stale = b.settingsHash();
        IKeeperPolicy.Economics memory e1 = factory.economics();
        e1.workFee = 0.00003 ether;
        factory.setEconomics(e1);

        uint256 bal0 = address(b).balance;
        uint256 k0 = keeper.balance;
        uint256 allowance0 = b.availableKeeperAllowance();
        uint64 next0 = pool.nextSequenceToProcess();
        vm.prank(keeper, keeper);
        uint256 g = gasleft();
        (bool ok, bytes memory ret) = address(b).call(abi.encodeCall(PoolBalancer.performUpkeep, (stale, 0, 0)));
        uint256 used = g - gasleft();
        assertFalse(ok);
        assertEq(bytes4(ret), PoolBalancer.StaleSettings.selector);
        assertLt(used, 100_000, "refused before processing, reconciling, minting or paying");
        assertEq(address(b).balance, bal0);
        assertEq(keeper.balance, k0);
        assertEq(b.availableKeeperAllowance(), allowance0);
        assertEq(pool.nextSequenceToProcess(), next0);

        // A local change makes the old hash stale too.
        bytes32 h = b.settingsHash();
        vm.prank(creator);
        b.pinEconomics();
        vm.prank(keeper, keeper);
        vm.expectRevert(PoolBalancer.StaleSettings.selector);
        b.performUpkeep(h, 0, 0);

        // The keeper's minimum acceptable payment, fixed and gas-indexed.
        uint256 snap = vm.snapshotState();
        Run memory r = _run(b, true);
        assertTrue(r.ok);
        uint256 reward = r.paid;
        vm.revertToState(snap);
        h = b.settingsHash();
        vm.prank(keeper, keeper);
        vm.expectRevert(PoolBalancer.MinimumPaymentNotMet.selector);
        b.performUpkeep(h, 2 * reward, 0);
        vm.prank(keeper, keeper);
        vm.expectRevert(PoolBalancer.MinimumPaymentNotMet.selector);
        b.performUpkeep(h, 0, 2 * reward / tx.gasprice + 1);
        k0 = keeper.balance;
        vm.prank(keeper, keeper);
        uint256 got = b.performUpkeep(h, reward / 2, 0);
        assertGe(got, reward / 2);
        assertEq(keeper.balance - k0, got);
    }

    /*//////////////////////////////////////////////////////////////
                           11. spending bucket
    //////////////////////////////////////////////////////////////*/

    function test_case11_bucketAccrualClampNoRefillNoReset() public {
        PoolBalancer b = _create(creator, 111, 3, 1 ether, false, 0);
        uint256 R0 = 4_166_666_666_666_666; // floor(0.05 ether / 12)
        assertEq(b.keeperBucketCapacity(), 0.622 ether);
        assertEq(b.keeperBucketRefill(), R0);
        assertEq(b.availableKeeperAllowance(), 0.622 ether);
        (, uint256 spent,) = _fillAll(b);
        uint256 a = 0.622 ether - spent;
        assertEq(b.availableKeeperAllowance(), a, "spent allowance");

        vm.prank(creator);
        b.setKeeperBucket(0.622 ether, 1e9);
        assertEq(b.availableKeeperAllowance(), a, "re-setting does not refill");
        vm.warp(vm.getBlockTimestamp() + 100);
        assertEq(b.availableKeeperAllowance(), a + 100e9);
        vm.prank(creator);
        b.setKeeperBucket(0.622 ether, 5e9);
        assertEq(b.availableKeeperAllowance(), a + 100e9, "elapsed time accrued at the old rate");
        vm.warp(vm.getBlockTimestamp() + 100);
        assertEq(b.availableKeeperAllowance(), a + 100e9 + 500e9, "new rate only for later time");

        vm.prank(creator);
        b.setKeeperBucket(0.1 ether, 5e9);
        assertEq(b.availableKeeperAllowance(), 0.1 ether, "lower capacity clamps");
        vm.prank(creator);
        b.setKeeperBucket(1 ether, 5e9);
        assertEq(b.availableKeeperAllowance(), 0.1 ether, "higher capacity does not fill the headroom");
        vm.warp(vm.getBlockTimestamp() + 1);
        assertEq(b.availableKeeperAllowance(), 0.1 ether + 5e9);

        vm.prank(creator);
        b.setKeeperBucket(1 ether, 0);
        vm.warp(vm.getBlockTimestamp() + 365 days);
        assertEq(b.availableKeeperAllowance(), 0.1 ether + 5e9, "zero refill never refills");

        uint256 x = 0.1 ether + 5e9;
        vm.prank(creator);
        b.setKeeperBucket(uint128(x + 21), 7);
        vm.warp(vm.getBlockTimestamp() + 2);
        assertEq(b.availableKeeperAllowance(), x + 14);
        vm.warp(vm.getBlockTimestamp() + 1);
        assertEq(b.availableKeeperAllowance(), x + 21, "reaches capacity exactly");
        vm.warp(vm.getBlockTimestamp() + 1);
        assertEq(b.availableKeeperAllowance(), x + 21, "never past capacity");

        vm.prank(creator);
        b.setKeeperBucket(0, uint96(R0));
        assertEq(b.availableKeeperAllowance(), 0);
        vm.prank(creator);
        b.setKeeperBucket(1 ether, uint96(R0));
        assertEq(b.availableKeeperAllowance(), 0);
        vm.warp(vm.getBlockTimestamp() + 12);
        assertEq(b.availableKeeperAllowance(), 12 * R0);
        assertEq(b.availableKeeperAllowance(), 49_999_999_999_999_992, "integer wei per second, no rounding up");

        // Nothing but spending and time moves it: zero refill isolates every other change.
        vm.prank(creator);
        b.setKeeperBucket(1 ether, 0);
        uint256 y = b.availableKeeperAllowance();
        _draw(b);
        Run memory r = _run(b, true);
        assertTrue(r.ok);
        y -= r.paid;
        assertEq(b.availableKeeperAllowance(), y);

        vm.startPrank(creator);
        b.pinEconomics();
        assertEq(b.availableKeeperAllowance(), y, "pin");
        b.followFactoryEconomics();
        assertEq(b.availableKeeperAllowance(), y, "follow");
        b.setKeeperPolicy(address(new KeeperPolicyV1()));
        assertEq(b.availableKeeperAllowance(), y, "policy switch");
        b.setLocalEconomics(factory.economics());
        assertEq(b.availableKeeperAllowance(), y, "local economics");
        b.setPaidUpkeepEnabled(false);
        assertEq(b.availableKeeperAllowance(), y, "paid off");
        b.setPaidUpkeepEnabled(true);
        assertEq(b.availableKeeperAllowance(), y, "paid on");
        b.close();
        assertEq(b.availableKeeperAllowance(), y, "close");
        b.open();
        assertEq(b.availableKeeperAllowance(), y, "open");
        b.transferCreator(heir);
        vm.stopPrank();
        vm.prank(heir);
        b.acceptCreator();
        assertEq(b.availableKeeperAllowance(), y, "creator transfer");
        IKeeperPolicy.Economics memory e1 = factory.economics();
        e1.workFee = 0.0001 ether;
        factory.setEconomics(e1);
        factory.setDefaultBucket(5 ether, 1 ether);
        assertEq(b.availableKeeperAllowance(), y, "factory updates");
        assertEq(b.keeperBucketCapacity(), 1 ether, "factory default does not touch an existing pool");
        assertEq(b.keeperBucketRefill(), 0);

        // Factory defaults initialize a new pool's bucket.
        PoolBalancer n = _create(creator, 112, 2, 1 ether, false, 0);
        assertEq(n.keeperBucketCapacity(), 5 ether);
        assertEq(n.keeperBucketRefill(), 1 ether);
        assertEq(n.availableKeeperAllowance(), 5 ether);
    }

    /*//////////////////////////////////////////////////////////////
                12. Shapes mint fee 0.001 -> 0.0005 -> 0.001
    //////////////////////////////////////////////////////////////*/

    function test_case12_mintFeeDownAndUp_realShapesAdmin() public {
        PoolBalancer b = _create(creator, 121, 4, 1 ether, false, 0);
        _use(b);
        _fillAll(b);
        assertEq(shapes.mintFee(), 0.001 ether);
        assertEq(b.mintFeeCap(), 0.001 ether);
        (uint256[] memory ids, uint256[] memory prices) = _prices(b);
        IKeeperPolicy.Economics memory e = b.effectiveEconomics();

        // A draw pending across the decrease.
        uint256[] memory req = buy(buyer, 1);
        bytes32 h0 = b.settingsHash();
        bytes32 c0 = factory.creationSettingsHash();
        _setFee(0.0005 ether);
        assertTrue(b.settingsHash() != h0, "upkeep identity includes the live fee");
        assertTrue(factory.creationSettingsHash() != c0);
        fulfill(req[0], 0);
        settle();
        Run memory r = _run(b, true);
        assertTrue(r.ok);
        assertEq(r.mintCost, 0.01 ether + 0.0005 ether, "minted at the lower live fee without a new acceptance");
        assertEq(r.lastPrice, _listPrice(e, 0.01 ether, 0.0005 ether, MARKUP), "new listing priced at the live fee");
        _assertPricesKept(b, ids, prices);

        // Reserve prices missing prizes at the accepted cap; accept the lower cap with no design change.
        vm.startPrank(creator);
        b.configure(MARKUP, 8, 0.001 ether);
        uint256 rHi = b.requiredReserve();
        b.configure(MARKUP, 8, 0.0005 ether);
        uint256 rLo = b.requiredReserve();
        assertEq(rHi - rLo, 4 * 0.0005 ether, "four missing Shapes reserved at the accepted cap");
        b.configure(MARKUP, 4, 0.0005 ether);
        vm.stopPrank();
        assertEq(b.mintFeeCap(), 0.0005 ether, "lower cap accepted with the same design");

        // The fee rises above the cap: minting stops, purchases of listed prizes continue.
        _setFee(0.001 ether);
        assertEq(b.admissionStatus(), 0);
        _draw(b);
        r = _run(b, true);
        assertTrue(r.ok);
        assertEq(r.reconciled, 1);
        assertEq(r.listed, 0, "nothing minted above the accepted cap");
        assertEq(r.mintCost, 0);
        // A save that accepted the lower fee cannot silently accept the higher one.
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        b.configure(MARKUP, 4, 0.0005 ether);

        vm.prank(creator);
        b.configure(MARKUP, 4, 0.001 ether);
        r = _run(b, true);
        assertTrue(r.ok);
        assertEq(r.mintCost, 0.011 ether, "minted at the accepted higher fee");
        assertEq(r.lastPrice, _listPrice(e, 0.01 ether, 0.001 ether, MARKUP));
        _assertPricesKept(b, ids, prices);
    }

    /*//////////////////////////////////////////////////////////////
       13. Shapes only, curated inventory, creator credit, unpaid recovery
    //////////////////////////////////////////////////////////////*/

    function test_case13a_shapesOnly_unpaidRecoveryWithPaidOff() public {
        PoolBalancer b = _create(creator, 131, 3, 1 ether, false, 0);
        _use(b);
        _fillAll(b);
        assertFalse(b.curatedRequired());
        assertEq(b.admissionStatus(), 0, "Shapes-only pool admits purchases");
        uint256 req = _draw(b);
        (,,, uint256 lid,,) = pool.acquisitions(req);
        (,,, uint256 tokenId,,,,) = pool.listings(lid);
        assertEq(shapes.ownerOf(tokenId), buyer, "the winner holds the Shape");

        vm.prank(creator);
        b.setPaidUpkeepEnabled(false);
        IKeeperPolicy.Economics memory e = b.effectiveEconomics();
        uint256 s0 = stranger.balance;
        uint256 bal0 = address(b).balance;
        uint256 proceeds = pool.ownerProceeds();
        vm.recordLogs();
        vm.prank(stranger);
        b.performUpkeepUnpaid();
        assertEq(stranger.balance, s0, "unpaid caller received nothing");
        assertEq(address(b).balance, bal0 + proceeds - 0.011 ether, "only the restock mint left the pool");
        uint256[] memory ids = b.getActiveIds();
        assertEq(ids.length, 3);
        assertEq(_surchargeOf(b, ids[ids.length - 1]), _surcharge(e, 1), "unpaid restock at the selected schedule");
    }

    function test_case13b_curatedInventory_creatorCredit() public {
        PoolBalancer b = _create(creator, 132, 1, 1 ether, true, 2_500);
        _use(b);
        _fillAll(b);
        assertEq(b.admissionStatus(), 3, "curated required and none listed");
        uint256 lid = listCurated(1_320, 0.05 ether);
        assertEq(b.admissionStatus(), 0);
        (,,,,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory req = buy(buyer, 1);
        fulfill(req[0], wordForSlot(slot));
        settle();
        assertEq(nft.ownerOf(1_320), buyer, "curated NFT delivered");
        uint256 credit0 = b.creatorCredit();
        uint256 got = b.collectProceeds();
        assertGt(got, 0);
        assertEq(b.creatorCredit() - credit0, got * 2_500 / 10_000, "credit is exactly 25% of collected proceeds");
        uint256 credit = b.creatorCredit();
        uint256 c0 = creator.balance;
        vm.prank(creator);
        b.claimSurplus(credit, creator);
        assertEq(creator.balance - c0, credit);

        // Optional curated: switching the requirement off admits a Shapes-only board.
        Run memory r = _run(b, true);
        assertTrue(r.ok);
        vm.prank(creator);
        b.setCuratedRequired(false);
        assertEq(b.admissionStatus(), 0);
    }

    /*//////////////////////////////////////////////////////////////
          14. bounded work; no duplicate service rewards
    //////////////////////////////////////////////////////////////*/

    /// @dev Gas price ceiling 0 makes every payment exactly (draws + Shape units) * work fee.
    function _feeOnlyEconomics() internal returns (IKeeperPolicy.Economics memory e) {
        e = factory.economics();
        e.gasPriceCeiling = 0;
        e.workFee = 0.001 ether;
        factory.setEconomics(e);
    }

    function test_case14a_listingBoundedByUnitsAndSizes() public {
        IKeeperPolicy.Economics memory e = _feeOnlyEconomics();
        uint256 sixSizes = 1 | (1 << 16) | (1 << 32) | (1 << 48) | (1 << 64) | (1 << 80);
        PoolBalancer b = _create(creator, 141, sixSizes, 8 ether, false, 0);
        Run memory r = _run(b, true);
        assertEq(r.mintSizes, 4, "at most four sizes per call");
        assertEq(r.listed, 4);
        assertEq(r.paid, 4 * e.workFee);
        r = _run(b, true);
        assertEq(r.listed, 2);
        assertEq(r.paid, 2 * e.workFee);
        r = _run(b, true);
        assertFalse(r.ok);
        assertEq(r.err, PoolBalancer.NoUpkeepNeeded.selector);
        r = _run(b, false);
        assertEq(r.err, PoolBalancer.NoUpkeepNeeded.selector, "an empty unpaid call does nothing either");

        PoolBalancer c = _create(creator, 142, 12, 1 ether, false, 0);
        uint256 k0 = keeper.balance;
        r = _run(c, true);
        assertEq(r.listed, 5, "at most five Shape units per call");
        r = _run(c, true);
        assertEq(r.listed, 5);
        r = _run(c, true);
        assertEq(r.listed, 2);
        assertFalse(_run(c, true).ok);
        assertEq(keeper.balance - k0, 12 * e.workFee, "one work fee per Shape listed, none for the empty call");
    }

    function test_case14b_reconcileBounded_noDuplicateRewards() public {
        IKeeperPolicy.Economics memory e = _feeOnlyEconomics();
        PoolBalancer b = _create(creator, 143, 20, 1 ether, false, 0);
        _use(b);
        _fillAll(b);
        uint256[] memory ids = buy(buyer, 5);
        for (uint256 i; i < 5; ++i) fulfill(ids[i], 0);
        settle();
        ids = buy(buyer, 2);
        for (uint256 i; i < 2; ++i) fulfill(ids[i], 0);
        settle();
        uint256 k0 = keeper.balance;
        Run memory r = _run(b, true);
        assertEq(r.reconciled, 5, "at most five reconciliations per call");
        assertEq(r.listed, 5);
        assertEq(r.paid, 10 * e.workFee);
        r = _run(b, true);
        assertEq(r.reconciled, 2);
        assertEq(r.listed, 2);
        r = _run(b, true);
        assertFalse(r.ok, "repeating the call finds nothing");
        assertEq(keeper.balance - k0, 14 * e.workFee, "seven draws and seven Shapes paid once each");
    }

    function test_case14c_processingBounded() public {
        IKeeperPolicy.Economics memory e = _feeOnlyEconomics();
        PoolBalancer b = _create(creator, 144, 10, 1 ether, false, 0);
        _use(b);
        _fillAll(b);
        uint256 firstExpired = buyOnePerBlock(buyer, 3);
        vm.roll(firstExpired + 2);
        uint256 k0 = keeper.balance;
        Run memory r = _run(b, true);
        assertTrue(r.ok);
        assertEq(r.processed, 2, "at most two draws processed per call");
        assertEq(r.reconciled, 2);
        assertEq(r.listed, 0);
        r = _run(b, true);
        assertEq(r.processed, 1);
        assertEq(r.reconciled, 1);
        r = _run(b, true);
        assertFalse(r.ok);
        assertEq(keeper.balance - k0, 3 * e.workFee, "each draw paid once");
    }

    /*//////////////////////////////////////////////////////////////
                          15. complete lifecycle
    //////////////////////////////////////////////////////////////*/

    function test_case15_lifecycle_absoluteEthPerFlow() public {
        uint256 inflow;
        uint256 outflow;
        uint256 paidTotal;
        // Creation and funding.
        uint256 t = 2 + SIZE1; // two 0.01 ETH Shapes and one 0.05 ETH Shape
        PoolBalancer b = _create(creator, 151, t, 0.5 ether, false, 2_000);
        _use(b);
        inflow += 0.5 ether;
        vm.prank(creator);
        b.depositETH{value: 0.25 ether}();
        inflow += 0.25 ether;
        assertEq(address(b).balance, 0.75 ether);

        // Setup restocking.
        (, uint256 paid, uint256 mint) = _fillAll(b);
        assertEq(mint, 2 * 0.011 ether + 0.051 ether, "setup mints at backing plus the live fee");
        paidTotal += paid;
        outflow += mint;
        assertEq(address(b).balance, inflow - outflow - paidTotal);

        // Curated prize from a collection that will refuse delivery (recovery path).
        FreezableNFT fz = new FreezableNFT();
        fz.mint(creator, 1);
        vm.prank(creator);
        fz.approve(address(b), 1);
        PoolBalancer.CuratedInput[] memory one = new PoolBalancer.CuratedInput[](1);
        one[0] = PoolBalancer.CuratedInput(address(fz), 1, 0.02 ether);
        vm.prank(creator);
        uint256 cLid = b.listCuratedBatch(one)[0];

        // Purchases, processing, restocking.
        uint256 credit;
        for (uint256 i; i < 2; ++i) {
            _drawShape(b);
            if (i == 1) {
                IKeeperPolicy.Economics memory e1 = factory.economics();
                e1.workFee = 0.0001 ether;
                e1.restockFlat = 0.0005 ether;
                factory.setEconomics(e1); // economic update between purchases
            }
            IKeeperPolicy.Economics memory e = b.effectiveEconomics();
            Run memory r = _run(b, true);
            assertTrue(r.ok);
            assertEq(r.reconciled, 1);
            assertEq(r.mintCost, 0.011 ether, "the drawn 0.01 ETH Shape restocked at backing plus fee");
            assertGt(r.collected, 0);
            inflow += r.collected;
            credit += r.collected * 2_000 / 10_000;
            assertEq(b.creatorCredit(), credit, "credit is exactly 20% of collected proceeds");
            outflow += r.mintCost;
            paidTotal += r.paid;
            assertEq(r.paid, _pay(e, _work(r.measured, 0, 1, 1, 1)), "paid under the economics in force");
            assertEq(_surchargeOf(b, r.lastLid), _surcharge(e, 1));
            assertEq(address(b).balance, inflow - outflow - paidTotal);
        }

        // Recovery: the curated prize is drawn, delivery fails, the winner is refunded, the creator recovers it.
        fz.setFrozen(true);
        (,,,,,, uint256 slot,) = pool.listings(cLid);
        uint256[] memory req = buy(buyer, 1);
        fulfill(req[0], wordForSlot(slot));
        settle();
        (,,,,,,, uint8 status) = pool.listings(cLid);
        assertEq(status, 6, "FWA holds the undelivered NFT");
        Run memory rr = _run(b, true);
        assertTrue(rr.ok);
        inflow += rr.collected;
        credit += rr.collected * 2_000 / 10_000;
        paidTotal += rr.paid;
        outflow += rr.mintCost;
        vm.warp(block.timestamp + IFWARefundWindow(address(pool)).DELIVERY_WINDOW());
        vm.prank(buyer);
        pool.refundFailedDelivery(cLid);
        fz.setFrozen(false);
        vm.prank(creator);
        b.recoverRefunded(cLid, creator);
        assertEq(fz.ownerOf(1), creator, "creator recovered the curated NFT");

        // Close, unlist and redeem every prize for its exact backing.
        vm.prank(creator);
        b.close();
        assertEq(b.admissionStatus(), 1);
        uint256[] memory ids = b.getActiveIds();
        uint256 backing;
        for (uint256 i; i < ids.length; ++i) {
            (, uint8 d,,,) = b.items(ids[i]);
            backing += b.denominationAmount(d);
        }
        assertEq(backing, 0.07 ether, "two 0.01 and one 0.05 ETH Shapes listed at close");
        uint256 b0 = address(b).balance;
        vm.prank(creator);
        b.unlistShapes(ids);
        assertEq(address(b).balance - b0, backing);
        inflow += backing;
        inflow += b.collectProceeds();

        // Withdrawal: everything, credit included.
        assertEq(b.requiredReserve(), 0);
        uint256 all = b.withdrawableSurplus();
        assertEq(all, address(b).balance);
        uint256 c0 = creator.balance;
        vm.prank(creator);
        b.claimSurplus(all, creator);
        assertEq(creator.balance - c0, all);
        outflow += all;
        assertEq(address(b).balance, 0);
        assertEq(inflow, outflow + paidTotal, "every wei in left as mints, keeper pay or the creator's withdrawal");
    }
}

/// @dev Old mainnet factory ABI (BalancerFactory at 35f7b6d, deployed 0x91C31Ad6 at block 26475448).
interface ILegacyFactory {
    struct LegacyConfig {
        uint16 markupBps;
        uint16 creatorRevenueBps;
        uint256 target;
        uint256 mintFeeCap;
        bool curatedRequired;
    }
    function createBalancer(bytes32 salt, LegacyConfig calldata config, PoolBalancer.CuratedInput[] calldata curated)
        external payable returns (address);
    function isBalancer(address) external view returns (bool);
    function defaultKeeperPolicy() external view returns (address);
    function implementation() external view returns (address);
}

/// @dev Old PoolBalancer ABI (35f7b6d): two-argument configure, policy-only settings hash.
interface ILegacyBalancer {
    function pool() external view returns (address);
    function creator() external view returns (address);
    function configure(uint16 markupBps, uint256 target) external;
    function markupBps() external view returns (uint16);
    function target() external view returns (uint256);
    function settingsHash() external view returns (bytes32);
    function performUpkeep(bytes32 expected, uint256 minimumFixed, uint256 minimumGas) external returns (uint256);
    function performUpkeepUnpaid() external returns (uint256);
    function admissionStatus() external view returns (uint8);
    function getActiveIds() external view returns (uint256[] memory);
    function collectProceeds() external returns (uint256);
    function creatorCredit() external view returns (uint256);
    function reconciledSequence() external view returns (uint64);
    function close() external;
    function unlistShapes(uint256[] calldata ids) external;
    function withdrawableSurplus() external view returns (uint256);
    function requiredReserve() external view returns (uint256);
    function claimSurplus(uint256 amount, address to) external;
    function keeperPolicy() external view returns (address);
}

/*//////////////////////////////////////////////////////////////
   16. a pool on the old mainnet factory after the replacement becomes the creation target
//////////////////////////////////////////////////////////////*/

contract CommunityLegacyFactoryAcceptanceTest is ForkBase {
    uint256 internal constant LEGACY_BLOCK = 26_480_000;
    address internal constant OLD_FACTORY = 0x91C31Ad620555DE24e62290906aD1aA14C4CE281;
    address internal constant OLD_IMPL = 0x9714b1319f57a543549451d5402aBDbc0B02E40E;
    address internal constant COMMUNITY_PACKS = 0xfE11c0E794475fd86801fb3020d779bd7887cB2D;

    function setUp() public {
        vm.createSelectFork("mainnet", LEGACY_BLOCK);
        vm.txGasPrice(1 gwei);
        vm.fee(0.5 gwei);
        vm.deal(creator, 100 ether);
        vm.deal(buyer, 100 ether);
        vm.deal(keeper, 1 ether);
    }

    function _legacyUpkeep(ILegacyBalancer o) internal returns (bool ok, uint256 paid) {
        bytes32 h = o.settingsHash();
        uint256 k0 = keeper.balance;
        vm.prank(keeper, keeper);
        try o.performUpkeep(h, 0, 0) { ok = true; } catch {}
        paid = keeper.balance - k0;
    }

    function test_case16_oldFactoryPoolOperableAfterReplacementFactory() public {
        ILegacyFactory old = ILegacyFactory(OLD_FACTORY);
        assertEq(old.implementation(), OLD_IMPL, "the verified old factory");
        uint256 fee = shapes.mintFee();
        PoolBalancer.CuratedInput[] memory none;
        vm.prank(creator);
        ILegacyBalancer o = ILegacyBalancer(old.createBalancer{value: 1 ether}(bytes32(uint256(16)),
            ILegacyFactory.LegacyConfig(MARKUP, 2_000, 3, fee, false), none));
        assertTrue(old.isBalancer(address(o)));
        pool = IFWAPool(o.pool());
        assertEq(pool.owner(), address(o));

        // The replacement factory, reusing the community Draw Packs, becomes the creation target.
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, COMMUNITY_PACKS, ENS);
        factory = new BalancerFactory(address(impl), keeperAdmin, address(this), address(new KeeperPolicyV1()));
        bytes32 h = factory.creationSettingsHash();
        vm.prank(creator);
        address fresh = factory.createBalancer{value: 1 ether}(bytes32(uint256(16)),
            PoolBalancer.CreationConfig(MARKUP, 0, 2, fee, false, h), none);
        assertTrue(factory.isBalancer(fresh));
        assertFalse(factory.isBalancer(address(o)));
        assertFalse(old.isBalancer(fresh));
        IKeeperPolicy.Economics memory e = factory.economics();
        e.workFee = 0.001 ether;
        factory.setEconomics(e);
        assertEq(o.keeperPolicy(), old.defaultKeeperPolicy(), "the legacy pool keeps its own policy");

        // Upkeep through the old ABI.
        uint256 paidTotal;
        for (uint256 i; i < 10; ++i) {
            (bool ok, uint256 p) = _legacyUpkeep(o);
            if (!ok) break;
            paidTotal += p;
        }
        assertEq(o.getActiveIds().length, 3);
        assertGt(paidTotal, 0, "the keeper was paid");
        assertEq(o.admissionStatus(), 0);

        // Configure through the old ABI.
        vm.prank(creator);
        o.configure(1_600, 4);
        assertEq(o.markupBps(), 1_600);
        assertEq(o.target(), 4);
        (bool ok2,) = _legacyUpkeep(o);
        assertTrue(ok2);
        assertEq(o.getActiveIds().length, 4);

        // Purchase, processing, paid and unpaid reconciliation, creator credit.
        uint256[] memory req = buy(buyer, 1);
        fulfill(req[0], 0);
        settle();
        uint256 proceeds = pool.ownerProceeds();
        uint64 rs = o.reconciledSequence();
        (ok2,) = _legacyUpkeep(o);
        assertTrue(ok2);
        assertEq(o.reconciledSequence(), rs + 1);
        assertEq(o.creatorCredit(), proceeds * 2_000 / 10_000);
        req = buy(buyer, 1);
        fulfill(req[0], 0);
        settle();
        vm.prank(stranger);
        o.performUpkeepUnpaid();
        assertEq(o.reconciledSequence(), rs + 2);

        // Exit: close, unlist and redeem, withdraw.
        vm.prank(creator);
        o.close();
        uint256[] memory ids = o.getActiveIds();
        uint256 b0 = address(o).balance;
        vm.prank(creator);
        o.unlistShapes(ids);
        assertEq(address(o).balance - b0, ids.length * 0.01 ether, "redeemed exactly the backing");
        o.collectProceeds();
        uint256 all = o.withdrawableSurplus();
        uint256 c0 = creator.balance;
        vm.prank(creator);
        o.claimSurplus(all, creator);
        assertEq(creator.balance - c0, all);
        assertEq(address(o).balance, o.requiredReserve());
    }
}
