// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {KeeperPolicyCalls} from "../src/KeeperPolicyCalls.sol";
import {IKeeperPolicy} from "../src/interfaces/IKeeperPolicy.sol";
import {KeeperPolicyV2, HostilePolicy} from "./Settings.t.sol";
import {ReentrantNFT, FreezableNFT, MockNFT} from "./utils/Mocks.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";

/// @dev Immutable arithmetic policy for the literal cash/credit/reserve regression, not a production recommendation.
contract ExactCashPolicy is IKeeperPolicy {
    function interfaceVersion() external pure returns (uint256) { return 3; }
    function version() external pure returns (uint256) { return 101; }
    function quoteReward(Work calldata, Economics calldata) external pure returns (uint256) { return 0; }
    function quoteRestock(uint8, uint256 units, uint256, Economics calldata) external pure returns (uint256) {
        return units * 0.008 ether;
    }
}

interface IAtomicFwaFactory {
    function predictPoolAddress(address owner, bytes32 salt) external view returns (address);
    function poolCount() external view returns (uint256);
    function poolCountOf(address owner) external view returns (uint256);
}

/// @dev An accepted hostile collection allows initial custody but rejects the subsequent real FWA listing pull.
contract ListingTransferRefusalNFT is MockNFT {
    address immutable balancer;
    constructor(address b) { balancer = b; }
    function _beforeTokenTransfer(address from, address, uint256) internal view override {
        require(from != balancer, "collection refuses FWA listing");
    }
}

/// @dev Actual creator contract exercising a hostile ETH receipt callback, never a protocol substitute.
contract ReentrantCreditRecipient {
    PoolBalancer immutable balancer;
    bool public reenteredCollection;
    bool public reenteredClaim;
    constructor(PoolBalancer b) { balancer = b; }
    function accept() external { balancer.acceptCreator(); }
    function claim(uint256 amount) external { balancer.claimSurplus(amount, address(this)); }
    receive() external payable {
        try balancer.collectProceeds() { reenteredCollection = true; } catch {}
        try balancer.claimSurplus(1, address(this)) { reenteredClaim = true; } catch {}
    }
}

/// @notice Real FWA and Shapes money paths. Controlled coordinator delivery is inherited from ForkBase;
///         these cases establish accounting and custody, not Chainlink timing or a production readiness approval.
contract ProtectedRevenueAtomicTest is ForkBase {
    uint256 internal nonce;

    function setUp() public {
        setUpFork();
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        GasProbe probe = new GasProbe();
        probe.record();
        assertEq(probe.baseFee(), 0.5 gwei);
        assertEq(probe.gasPrice(), 0.55 gwei);
    }

    function _creation(uint256 t, uint16 rate)
        internal view returns (PoolBalancer.CreationConfig memory c, uint256 funding)
    {
        c = PoolBalancer.CreationConfig(1500, rate, t, shapes.mintFee(), true, factory.creationSettingsHash());
        KeeperPolicyCalls.Reserve memory r;
        r.enabled = true;
        r.target = t;
        r.mintFee = c.mintFeeCap;
        r.baseFee = block.basefee;
        funding = KeeperPolicyCalls.reserve(factory.economics(), r);
    }

    function _atomic(uint256 t, uint16 rate) internal {
        bytes32 salt = bytes32(++nonce);
        (PoolBalancer.CreationConfig memory c, uint256 funding) = _creation(t, rate);
        address predicted = factory.predictBalancer(creator, salt);
        nft.mint(creator, nonce);
        PoolBalancer.CuratedInput[] memory initial = new PoolBalancer.CuratedInput[](1);
        initial[0] = PoolBalancer.CuratedInput(address(nft), nonce, 0.2 ether);
        vm.startPrank(creator);
        nft.approve(predicted, nonce);
        balancer = PoolBalancer(payable(factory.createBalancer{value: funding}(salt, c, initial)));
        vm.stopPrank();
        pool = balancer.pool();
        assertEq(address(balancer), predicted);
        assertEq(balancer.creator(), creator);
        assertEq(nft.ownerOf(nonce), address(pool));
        assertEq(balancer.target(), t);
        assertEq(balancer.markupBps(), 1500);
        assertEq(balancer.creatorRevenueBps(), rate);
        assertEq(balancer.creatorCredit(), 0);
        assertTrue(balancer.enabled());
        assertTrue(balancer.creatorWork());
        assertEq(balancer.listedShapePrizes(), 0, "creation mints no target inventory");
        assertFalse(balancer.canPurchase(buyer));
        fillUp();
        uint16[16] memory have = balancer.getActiveShapes();
        for (uint256 d; d < 16; ++d) assertEq(have[d], (t >> (16 * d)) & 0xffff);
        assertTrue(balancer.canPurchase(buyer));
    }

    function _pruneSurplus() internal {
        uint256 amount = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(amount, creator);
    }

    function _drawDenom(uint8 denomination) internal returns (uint256 proceeds) {
        uint256[] memory all = balancer.getActiveIds();
        uint256 slot;
        for (uint256 i; i < all.length; ++i) {
            (uint8 kind, uint8 d,,,) = balancer.items(all[i]);
            if (kind == 2 && d == denomination) {
                (,,,,,, slot,) = pool.listings(all[i]);
                break;
            }
        }
        assertGt(slot, 0, "the required real prize exists");
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        (,,, uint256 lid, uint8 status,) = pool.acquisitions(ids[0]);
        assertEq(status, 2, "the real prize was fulfilled, not expired or refunded");
        (address collection,,, uint256 token,,,,) = pool.listings(lid);
        assertEq(shapes.ownerOf(token), buyer);
        assertEq(shapes.backingOf(token), balancer.denominationAmount(denomination));
        assertEq(collection, SHAPES);
        proceeds = pool.ownerProceeds();
        assertGt(proceeds, 0.01 ether, "absolute owner revenue from the reached board");
    }

    function _largeDeficit(uint8 d) internal {
        uint256 t = 20 | (uint256(1) << (16 * d));
        _atomic(t, 1000);
        _pruneSurplus();
        uint256 proceeds = _drawDenom(d);
        uint256 actual = balancer.collectProceeds();
        assertEq(actual, proceeds);
        assertEq(balancer.creatorCredit(), proceeds / 10, "10% of actual FWA cash exactly once");
        assertEq(balancer.collectProceeds(), 0);
        uint256 credit = balancer.creatorCredit();
        upkeep();
        assertEq(balancer.getActiveShapes()[d], 0, "expensive replacement remains genuinely missing");
        assertEq(balancer.target(), t, "no target reduction");
        assertEq(balancer.creatorCredit(), credit, "paid reconciliation protects existing credit");
        assertLt(address(balancer).balance - credit, balancer.denominationAmount(d));
        assertTrue(balancer.canPurchase(buyer), "permitted small-prize sales continue");
        _drawDenom(0);
        uint256 before = balancer.creatorCredit();
        uint256 got = balancer.collectProceeds();
        assertEq(balancer.creatorCredit(), before + got / 10);
        uint256 operating = address(balancer).balance - balancer.creatorCredit();
        uint256 amount = balancer.creatorCredit();
        uint256 creatorBefore = creator.balance;
        vm.prank(creator);
        balancer.claimSurplus(amount, creator);
        assertEq(creator.balance - creatorBefore, amount);
        assertEq(address(balancer).balance, operating, "credit claim leaves operating cash exactly unchanged");
        assertEq(balancer.creatorCredit(), 0);
        assertEq(balancer.getActiveShapes()[d], 0);
        assertEq(balancer.target(), t);
        assertGt(balancer.requiredReserve(), operating, "inventory deficit remains visible");
        emit log_named_decimal_uint("missing expensive prize", balancer.denominationAmount(d), 18);
        emit log_named_decimal_uint("creator claimed during deficit", amount, 18);
        emit log_named_decimal_uint("remaining operating cash", operating, 18);
    }

    function test_creditClaimDuringRealOneEthDeficit() public { _largeDeficit(4); }
    function test_creditClaimDuringRealHundredEthDeficit() public { _largeDeficit(8); }

    function test_fullRateCreditOnlyCashSurvivesUnpaidAndFailingPolicy() public {
        _atomic(20, 10_000);
        HostilePolicy broken = new HostilePolicy(2);
        vm.prank(creator); balancer.setKeeperPolicy(address(broken));
        vm.prank(creator); balancer.setPaidUpkeepEnabled(false);
        _pruneSurplus();
        assertEq(address(balancer).balance, 0, "no new operating capital remains");
        uint256 proceeds = _drawDenom(0);
        assertEq(balancer.collectProceeds(), proceeds);
        assertEq(address(balancer).balance, balancer.creatorCredit());
        uint256 credit = balancer.creatorCredit();
        vm.prank(stranger); balancer.performUpkeepUnpaid();
        assertEq(balancer.creatorCredit(), credit);
        assertEq(address(balancer).balance, credit, "unpaid recovery cannot buy a replacement using credit");
        assertEq(balancer.getActiveShapes()[0], 19);
        address policy = balancer.keeperPolicy();
        vm.record();
        vm.prank(creator); balancer.claimSurplus(credit, creator);
        (bytes32[] memory shapeReads,) = vm.accesses(SHAPES);
        (bytes32[] memory poolReads,) = vm.accesses(address(pool));
        (bytes32[] memory policyReads,) = vm.accesses(policy);
        assertEq(shapeReads.length, 0, "claim reads no mint-fee state");
        assertEq(poolReads.length, 0, "claim reads no FWA/reserve/collection state");
        assertEq(policyReads.length, 0, "claim reads no policy state");
        assertEq(address(balancer).balance, 0);
        assertEq(balancer.creatorCredit(), 0);
    }

    function test_capitalMovementsNeverCreateCreditAndClosePreservesIt() public {
        _atomic(20, 1000);
        vm.prank(creator); balancer.depositETH{value: 0.01 ether}();
        vm.prank(creator); (bool sent,) = address(balancer).call{value: 0.01 ether}("");
        assertTrue(sent);
        assertEq(balancer.creatorCredit(), 0);
        _drawDenom(0);
        uint256 proceeds = balancer.collectProceeds();
        uint256 credit = proceeds / 10;
        vm.prank(creator); balancer.close();
        assertEq(balancer.creatorCredit(), credit);
        vm.prank(stranger); balancer.performUpkeepUnpaid();
        uint256[] memory all = balancer.getActiveIds();
        uint256[] memory one = new uint256[](1);
        for (uint256 i; i < all.length; ++i) {
            (uint8 kind,,,,) = balancer.items(all[i]);
            if (kind == 2) { one[0] = all[i]; break; }
        }
        uint256 before = address(balancer).balance;
        vm.prank(creator); balancer.unlistShapes(one);
        assertEq(address(balancer).balance, before + 0.01 ether);
        assertEq(balancer.creatorCredit(), credit, "redemption is returned backing");
    }

    function test_rateChangesUseCollectionBoundaryAndKeepConcurrentRequests() public {
        _atomic(20, 1000);
        _drawDenom(0);
        uint256 oldProceeds = pool.ownerProceeds();
        uint256[] memory pending = buy(buyer, 1);
        uint256[] memory overlapping = buy(stranger, 1);
        assertEq(pool.unsettledAcquisitionCount(), 2);
        vm.prank(creator); balancer.setCreatorRevenueBps(2000);
        assertEq(balancer.creatorCredit(), oldProceeds / 10);
        assertEq(balancer.creatorRevenueBps(), 2000);
        fulfill(pending[0], 0);
        fulfill(overlapping[0], 0);
        settle();
        uint256 lateProceeds = pool.ownerProceeds();
        assertGt(lateProceeds, 0);
        vm.prank(creator); balancer.close();
        uint256 before = balancer.creatorCredit();
        assertEq(balancer.collectProceeds(), lateProceeds);
        assertEq(balancer.creatorCredit(), before + lateProceeds * 2000 / 10_000,
            "earlier purchases collected later use the explicitly chosen new rate, even after closing");
        vm.startPrank(creator); balancer.configure(3000, 20, shapes.mintFee()); vm.stopPrank();
        assertEq(balancer.creatorRevenueBps(), 2000);
    }

    function test_policyActivationIgnoresMissingHundredEthBackingAtEqualExposure() public {
        _atomic(20 | (uint256(1) << 128), 1000);
        _pruneSurplus();
        _drawDenom(8);
        balancer.collectProceeds();
        upkeep();
        uint256 credit = balancer.creatorCredit();
        KeeperPolicyV2 v2 = new KeeperPolicyV2();
        (uint256 required, uint256 shortfall) = balancer.maintenanceFunding(_econWith(address(v2)));
        assertEq(required, _workingBuffer(), "one operating call at 0.5 gwei, no missing backing");
        assertEq(shortfall, 0);
        assertGt(balancer.requiredReserve(), 100 ether);
        uint256 allowance = balancer.keeperAllowance();
        vm.prank(creator); balancer.setKeeperPolicy(address(v2));
        assertEq(balancer.keeperPolicy(), address(v2));
        assertEq(balancer.keeperAllowance(), allowance);
        assertEq(balancer.creatorCredit(), credit);
        assertEq(balancer.getActiveShapes()[8], 0);
        assertGt(balancer.requiredReserve(), 100 ether);
        vm.fee(5 gwei); vm.txGasPrice(5.05 gwei);
        vm.prank(creator); balancer.setPaidUpkeepEnabled(false);
        // A policy change while stopped adds no paid exposure and leaves paid upkeep stopped.
        address same = balancer.keeperPolicy();
        vm.prank(creator); balancer.setKeeperPolicy(same);
        assertFalse(balancer.paidUpkeepEnabled(), "a policy change never re-enables paid upkeep");
        (required, shortfall) = balancer.maintenanceFunding(balancer.effectiveEconomics());
        assertEq(required, (3_200_000 + V1_OVERHEAD) * 5 gwei + 0.0002 ether, "one operating call at the 5 gwei ceiling");
        assertGt(shortfall, 0, "re-enable compares with zero effective paid exposure");
        vm.prank(creator); vm.expectRevert(PoolBalancer.ReserveNotFunded.selector); balancer.setPaidUpkeepEnabled(true);
        vm.prank(creator); balancer.depositETH{value: shortfall}();
        vm.prank(creator); balancer.setPaidUpkeepEnabled(true);
        assertEq(address(balancer).balance - credit, required);
        assertGt(balancer.requiredReserve(), required, "funding maintenance does not restore inventory");
    }

    function test_literalCashCreditReserveExampleDoesNotDoubleCountCredit() public {
        bytes32 salt = bytes32(uint256(101));
        (PoolBalancer.CreationConfig memory config,) = _creation(20, 10_000);
        config.markupBps = 1000;
        address predicted = factory.predictBalancer(creator, salt);
        nft.mint(creator, 101);
        PoolBalancer.CuratedInput[] memory initial = new PoolBalancer.CuratedInput[](1);
        initial[0] = PoolBalancer.CuratedInput(address(nft), 101, 0.02 ether);
        vm.startPrank(creator);
        nft.approve(predicted, 101);
        // Explicit diagnostic capital, separate from the minimum-capital large-deficit demonstrations.
        balancer = PoolBalancer(payable(factory.createBalancer{value: 1 ether}(salt, config, initial)));
        vm.stopPrank();
        pool = balancer.pool();
        // The 0.008 ETH surcharge needs economics whose per-Shape maximum allows it: raise the flat part locally.
        IKeeperPolicy.Economics memory e = _econWith(address(new ExactCashPolicy()));
        e.restockFlat = 0.008 ether;
        vm.prank(creator); balancer.setLocalEconomics(e);
        for (uint256 i; i < 4; ++i) {
            vm.prank(stranger); balancer.performUpkeepUnpaid();
        }
        assertEq(balancer.getActiveShapes()[0], 20);
        assertEq(pool.weightedBackingTotal() / pool.totalWeight(), 0.02 ether,
            "all real FWA prizes cost exactly 0.02 ETH, excluding the protocol edge and VRF fee");
        uint256 capitalClaim = address(balancer).balance - 0.191 ether;
        vm.prank(creator); balancer.claimSurplus(capitalClaim, creator);
        assertEq(address(balancer).balance, 0.191 ether);
        assertEq(balancer.creatorCredit(), 0);
        assertEq(_drawDenom(0), 0.02 ether, "actual settled FWA owner proceeds");
        vm.prank(stranger); balancer.performUpkeepUnpaid();
        assertEq(pool.ownerProceeds(), 0);
        assertEq(balancer.getActiveShapes()[0], 20, "the 0.011 ETH replacement really was minted");
        assertEq(address(balancer).balance, 0.20 ether);
        assertEq(balancer.creatorCredit(), 0.02 ether);
        assertEq(address(balancer).balance - balancer.creatorCredit(), 0.18 ether);
        vm.fee(20 gwei);
        vm.txGasPrice(20.05 gwei);
        GasProbe witness = new GasProbe(); witness.record();
        assertEq(witness.baseFee(), 20 gwei);
        assertEq(witness.gasPrice(), 20.05 gwei);
        // One operating call at the 5 gwei ceiling of these economics: (3.2M + 60k) * 5 gwei + ten work fees.
        assertEq(balancer.requiredReserve(), 0.0165 ether);
        assertEq(balancer.withdrawableSurplus(), 0.1835 ether, "credit 0.02 counted exactly once, plus 0.18 - 0.0165");
        uint256 creatorBefore = creator.balance;
        vm.prank(creator); balancer.claimSurplus(0.1835 ether, creator);
        assertEq(creator.balance - creatorBefore, 0.1835 ether);
        assertEq(address(balancer).balance, 0.0165 ether);
        assertEq(balancer.creatorCredit(), 0);
        assertEq(balancer.withdrawableSurplus(), 0);
    }

    function test_zeroFullAndOneBasisPointRoundingRemainBacked() public {
        _atomic(20, 0);
        uint256 zeroProceeds = _drawDenom(0);
        assertEq(balancer.collectProceeds(), zeroProceeds);
        assertEq(balancer.creatorCredit(), 0);
        upkeep();
        vm.prank(creator); balancer.setCreatorRevenueBps(1);
        uint256 before = address(balancer).balance;
        uint256 proceeds = _drawDenom(0);
        balancer.collectProceeds();
        assertEq(balancer.creatorCredit(), proceeds / 10_000);
        assertEq(address(balancer).balance - balancer.creatorCredit(), before + proceeds - proceeds / 10_000,
            "integer residual is operating cash, without fractional carry");
        upkeep();
        uint256 credit = balancer.creatorCredit();
        vm.prank(creator); balancer.setCreatorRevenueBps(10_000);
        proceeds = _drawDenom(0);
        balancer.collectProceeds();
        assertEq(balancer.creatorCredit(), credit + proceeds);
        assertGe(address(balancer).balance, balancer.creatorCredit());
        vm.prank(creator); vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        balancer.setCreatorRevenueBps(10_001);
        assertEq(balancer.creatorRevenueBps(), 10_000);
    }

    function test_creditClaimCallbackCannotDuplicateCollectionOrClaims() public {
        _atomic(20, 1000);
        _drawDenom(0);
        uint256 proceeds = balancer.collectProceeds();
        uint256 credit = balancer.creatorCredit();
        assertEq(credit, proceeds / 10);
        ReentrantCreditRecipient recipient = new ReentrantCreditRecipient(balancer);
        vm.prank(creator); balancer.transferCreator(address(recipient));
        recipient.accept();
        uint256 operating = address(balancer).balance - credit;
        recipient.claim(credit);
        assertEq(address(recipient).balance, credit);
        assertEq(balancer.creatorCredit(), 0);
        assertEq(address(balancer).balance, operating);
        assertFalse(recipient.reenteredCollection());
        assertFalse(recipient.reenteredClaim());
        assertEq(pool.ownerProceeds(), 0);
    }

    function test_atomicMissingApprovalAndInsufficientFundingLeaveNothing() public {
        bytes32 salt = bytes32(uint256(91));
        (PoolBalancer.CreationConfig memory c, uint256 funding) = _creation(20, 1000);
        address predicted = factory.predictBalancer(creator, salt);
        nft.mint(creator, 91);
        PoolBalancer.CuratedInput[] memory initial = new PoolBalancer.CuratedInput[](1);
        initial[0] = PoolBalancer.CuratedInput(address(nft), 91, 0.2 ether);
        uint256 before = creator.balance;
        vm.prank(creator); vm.expectRevert();
        factory.createBalancer{value: funding}(salt, c, initial);
        assertEq(predicted.code.length, 0);
        assertFalse(factory.isBalancer(predicted));
        assertEq(nft.ownerOf(91), creator);
        assertEq(creator.balance, before);
        vm.prank(creator); nft.approve(predicted, 91);
        vm.prank(creator); vm.expectRevert(PoolBalancer.ReserveNotFunded.selector);
        factory.createBalancer{value: funding - 1}(salt, c, initial);
        assertEq(predicted.code.length, 0);
        assertFalse(factory.isBalancer(predicted));
        assertEq(nft.ownerOf(91), creator);
        assertEq(creator.balance, before);
        vm.prank(stranger); vm.expectRevert();
        factory.createBalancer{value: funding}(salt, c, initial);
        assertEq(nft.ownerOf(91), creator, "creator-scoped predicted approval cannot be stolen");
    }

    /// The funding check uses the pending requests and basefee at the moment of the (now immediate) change.
    function test_policyChangeChecksPendingRequestsAndBasefeeAtExecution() public {
        _atomic(20, 1000);
        _pruneSurplus();
        IKeeperPolicy.Economics memory higher = balancer.effectiveEconomics();
        higher.gasPriceCeiling = 10 gwei;
        (uint256 beforeRequired, uint256 beforeShortfall) = balancer.maintenanceFunding(higher);
        assertEq(beforeRequired, _workingBuffer(), "below the old ceiling a higher ceiling changes nothing");
        assertEq(beforeShortfall, 0);
        vm.fee(5 gwei);
        vm.txGasPrice(5.05 gwei);
        GasProbe witness = new GasProbe();
        witness.record();
        assertEq(witness.baseFee(), 5 gwei);
        assertEq(witness.gasPrice(), 5.05 gwei);
        buy(buyer, 1);
        buy(stranger, 1);
        assertEq(pool.lastIssuedSequence() - balancer.reconciledSequence(), 2);
        (uint256 required, uint256 shortfall) = balancer.maintenanceFunding(higher);
        assertEq(required, 2 * ((2_150_000 + V1_OVERHEAD) * 5.05 gwei + 0.00004 ether) // process and reconcile fees
            + (3_200_000 + V1_OVERHEAD) * 5.05 gwei + 0.0002 ether,
            "two actual processing bounds plus one bounded operating call at 5.05 gwei");
        assertEq(shortfall, required - (address(balancer).balance - balancer.creatorCredit()));
        vm.prank(creator); vm.expectRevert(PoolBalancer.ReserveNotFunded.selector); balancer.setLocalEconomics(higher);
        vm.prank(creator); balancer.depositETH{value: shortfall}();
        vm.prank(creator); balancer.setLocalEconomics(higher);
        assertEq(balancer.effectiveEconomics().gasPriceCeiling, 10 gwei);
        assertEq(pool.unsettledAcquisitionCount(), 2, "an economics change does not manufacture queue work");
    }

    function test_atomicThousandPrizeCreationMintsNoneAndFirstUpkeepStaysBounded() public {
        bytes32 salt = bytes32(uint256(95));
        (PoolBalancer.CreationConfig memory c, uint256 funding) = _creation(1000, 1000);
        address predicted = factory.predictBalancer(creator, salt);
        nft.mint(creator, 95);
        PoolBalancer.CuratedInput[] memory initial = new PoolBalancer.CuratedInput[](1);
        initial[0] = PoolBalancer.CuratedInput(address(nft), 95, 0.2 ether);
        vm.startPrank(creator);
        nft.approve(predicted, 95);
        balancer = PoolBalancer(payable(factory.createBalancer{value: funding}(salt, c, initial)));
        vm.stopPrank();
        pool = balancer.pool();
        assertEq(balancer.target(), 1000);
        assertEq(balancer.listedShapePrizes(), 0);
        assertEq(balancer.admissionStatus(), 2);
        upkeep();
        assertEq(balancer.getActiveShapes()[0], 5, "one ordinary maintenance call, five Shape units");
        assertTrue(balancer.creatorWork());
        assertFalse(balancer.canPurchase(buyer));
        assertEq(balancer.target(), 1000);
    }

    function test_atomicHostileSecondFwaTransferRollsBackPoolAndBothNfts() public {
        bytes32 salt = bytes32(uint256(96));
        (PoolBalancer.CreationConfig memory c, uint256 funding) = _creation(20, 1000);
        address predicted = factory.predictBalancer(creator, salt);
        IAtomicFwaFactory fwa = IAtomicFwaFactory(FWA_FACTORY);
        address predictedPool = fwa.predictPoolAddress(predicted, bytes32(0));
        uint256 beforePools = fwa.poolCount();
        assertEq(fwa.poolCountOf(predicted), 0);
        ListingTransferRefusalNFT hostile = new ListingTransferRefusalNFT(predicted);
        nft.mint(creator, 96);
        hostile.mint(creator, 97);
        PoolBalancer.CuratedInput[] memory initial = new PoolBalancer.CuratedInput[](2);
        initial[0] = PoolBalancer.CuratedInput(address(nft), 96, 0.2 ether);
        initial[1] = PoolBalancer.CuratedInput(address(hostile), 97, 0.2 ether);
        vm.startPrank(creator);
        nft.approve(predicted, 96);
        hostile.approve(predicted, 97);
        uint256 before = creator.balance;
        vm.expectRevert();
        factory.createBalancer{value: funding}(salt, c, initial);
        vm.stopPrank();
        assertEq(predicted.code.length, 0);
        assertEq(predictedPool.code.length, 0);
        assertFalse(factory.isBalancer(predicted));
        assertEq(fwa.poolCount(), beforePools);
        assertEq(fwa.poolCountOf(predicted), 0);
        assertEq(nft.ownerOf(96), creator);
        assertEq(hostile.ownerOf(97), creator);
        assertEq(creator.balance, before);
    }

    function test_atomicCannotPullApprovedAssetFromWrongOwner() public {
        bytes32 salt = bytes32(uint256(98));
        (PoolBalancer.CreationConfig memory c, uint256 funding) = _creation(20, 1000);
        address predicted = factory.predictBalancer(creator, salt);
        nft.mint(stranger, 98);
        vm.prank(stranger); nft.approve(predicted, 98);
        PoolBalancer.CuratedInput[] memory initial = new PoolBalancer.CuratedInput[](1);
        initial[0] = PoolBalancer.CuratedInput(address(nft), 98, 0.2 ether);
        uint256 before = creator.balance;
        vm.prank(creator); vm.expectRevert();
        factory.createBalancer{value: funding}(salt, c, initial);
        assertEq(nft.ownerOf(98), stranger);
        assertEq(predicted.code.length, 0);
        assertFalse(factory.isBalancer(predicted));
        assertEq(creator.balance, before);
    }

    function test_atomicLaterListingFailureRollsBackEarlierTransfersAndFunding() public {
        bytes32 salt = bytes32(uint256(93));
        (PoolBalancer.CreationConfig memory c, uint256 funding) = _creation(20, 1000);
        address predicted = factory.predictBalancer(creator, salt);
        nft.mint(creator, 93);
        nft.mint(creator, 94);
        PoolBalancer.CuratedInput[] memory initial = new PoolBalancer.CuratedInput[](2);
        initial[0] = PoolBalancer.CuratedInput(address(nft), 93, 0.2 ether);
        initial[1] = PoolBalancer.CuratedInput(address(nft), 94, 0);
        vm.startPrank(creator);
        nft.approve(predicted, 93);
        nft.approve(predicted, 94);
        uint256 before = creator.balance;
        vm.expectRevert(PoolBalancer.ValueTooHigh.selector);
        factory.createBalancer{value: funding}(salt, c, initial);
        vm.stopPrank();
        assertEq(predicted.code.length, 0);
        assertFalse(factory.isBalancer(predicted));
        assertEq(nft.ownerOf(93), creator, "the earlier successful NFT transfer rolled back");
        assertEq(nft.ownerOf(94), creator);
        assertEq(creator.balance, before);
    }

    function test_atomicHostileTransferCannotReenterAndInvalidRateReverts() public {
        bytes32 salt = bytes32(uint256(92));
        (PoolBalancer.CreationConfig memory c, uint256 funding) = _creation(20, 10_001);
        address predicted = factory.predictBalancer(creator, salt);
        ReentrantNFT evil = new ReentrantNFT();
        evil.setTarget(predicted);
        evil.mint(creator, 92);
        PoolBalancer.CuratedInput[] memory initial = new PoolBalancer.CuratedInput[](1);
        initial[0] = PoolBalancer.CuratedInput(address(evil), 92, 0.2 ether);
        vm.prank(creator); evil.approve(predicted, 92);
        vm.prank(creator); vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        factory.createBalancer{value: funding}(salt, c, initial);
        assertEq(predicted.code.length, 0);
        c.creatorRevenueBps = 0;
        vm.prank(creator);
        PoolBalancer b = PoolBalancer(payable(factory.createBalancer{value: funding}(salt, c, initial)));
        assertGt(evil.attempts(), 0, "the initialization transfer really attempted upkeep reentry");
        assertGt(evil.initializationAttempts(), 0, "the initialization transfer really attempted initialization reentry");
        assertFalse(evil.reentered());
        assertEq(b.creator(), creator);
        assertEq(b.creatorCredit(), 0);
        assertEq(b.creatorRevenueBps(), 0);
        assertEq(evil.ownerOf(92), address(b.pool()));
    }
}
