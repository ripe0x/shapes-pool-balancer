// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, ITimeout} from "../test/utils/ForkBase.sol";
import {GasProbe} from "../test/utils/FlowBreakdown.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {IShapePacks, IERC721Min} from "../src/interfaces/External.sol";
import {BalancerFactory} from "../src/BalancerFactory.sol";
import {KeeperPolicyV1} from "../src/KeeperPolicyV1.sol";
import {IKeeperPolicy} from "../src/interfaces/IKeeperPolicy.sol";
import {ERC721} from "solady/tokens/ERC721.sol";

/// @dev A creator-supplied third-party collection: FWA explicitly accepts its NFTs as prizes.
contract CreatorCollection is ERC721 {
    function name() public pure override returns (string memory) { return "Creator Collection"; }
    function symbol() public pure override returns (string memory) { return "CC"; }
    function tokenURI(uint256) public pure override returns (string memory) { return ""; }
    function mint(address to, uint256 id) external { _mint(to, id); }
}
contract RefusingCreatorCollection is CreatorCollection {
    bool public frozen;
    function setFrozen(bool value) external { frozen = value; }
    function _beforeTokenTransfer(address from, address, uint256) internal view override {
        if (frozen && from != address(0)) revert("creator collection refuses delivery");
    }
}

/// @dev A creator-selectable, hostile economic policy. It is not a replacement for a trusted dependency.
contract HostileQuotePolicy is IKeeperPolicy {
    bool public fail;
    function setFail(bool value) external { fail = value; }
    function interfaceVersion() external pure returns (uint256) { return 1; }
    function version() external pure returns (uint256) { return 1; }
    function maxReward() external pure returns (uint256) { return 0.03 ether; }
    function quoteReward(Work calldata) external view returns (uint256) {
        if (fail) revert("policy refuses quote");
        return type(uint256).max;
    }
    function quoteRestock(uint8, uint256, uint256) external view returns (uint256) {
        if (fail) revert("policy refuses surcharge");
        return type(uint256).max;
    }
}

interface IBuyerRefund {
    function acquisitionEscrowTotal() external view returns (uint256);
    function acquisitionRefundCredit(address) external view returns (uint256);
    function withdrawAcquisitionRefund() external returns (uint256);
}
interface IShapesLedger {
    function redeemableBacking() external view returns (uint256);
    function pendingFees() external view returns (uint256);
}
interface IFWAFeeLedger {
    function accruedProtocolFees() external view returns (uint256);
}
interface IFWAFailedDelivery {
    function deliveryEscrowTotal() external view returns (uint256);
    function refundFailedDelivery(uint256 listingId) external;
}

/// @notice Independently selected launch-B sequences on deployed FWA/Shapes. The sole
///         impersonation is the real FWA VRF service's Chainlink coordinator in ForkBase.
contract UninformedForkTest is ForkBase {
    GasProbe internal gasProbe;

    function setUp() public {
        uint256 recent = vm.envOr("AUDIT_B_RECENT_BLOCK", uint256(0));
        if (recent == 0) setUpFork();
        else {
            vm.createSelectFork("mainnet", recent);
            address renderer = deployCode("out/ShapePackRenderer.sol/ShapePackRenderer.json", abi.encode(SHAPES));
            packs = deployCode("out/ShapePacks.sol/ShapePacks.json", abi.encode(
                SHAPES, renderer, makeAddr("recentPacksAdmin"), "Pool Prize Packs", "PRIZEPACK", uint256(2)));
            PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS);
            factory = new BalancerFactory(address(impl), keeperAdmin, address(this), address(new KeeperPolicyV1()));
            vm.deal(creator, 1_000 ether);
            vm.deal(buyer, 1_000 ether);
            vm.deal(stranger, 1_000 ether);
            vm.deal(keeper, 1 ether);
        }
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        gasProbe = new GasProbe();
        gasProbe.record();
        assertEq(gasProbe.baseFee(), 0.5 gwei);
        assertEq(gasProbe.gasPrice(), 0.55 gwei);
        assertEq(FWA_IMPL.codehash, FWA_CODEHASH);
        assertEq(shapes.mintFee(), 0.001 ether);
    }

    function _createShapeOnly(uint256 funding, uint256 t, uint16 revenue) internal {
        PoolBalancer.CreationConfig memory c =
            PoolBalancer.CreationConfig(1500, revenue, t, shapes.mintFee(), false);
        vm.prank(creator);
        balancer = PoolBalancer(payable(factory.createBalancer{value: funding}(
            bytes32(uint256(123)), c, new PoolBalancer.CuratedInput[](0))));
        pool = balancer.pool();
        assertEq(balancer.listedShapePrizes(), 0);
        assertEq(balancer.admissionStatus(), 2);
    }

    function test_exactCapitalShapeOnlyThenBuyerRefundAfterCreatorExit() public {
        _createShapeOnly(0.2356 ether, 20, 1000);
        assertEq(balancer.requiredReserve(), 0.2356 ether);
        assertEq(address(balancer).balance, 0.2356 ether);
        uint256 backingBefore = IShapesLedger(SHAPES).redeemableBacking();
        uint256 feesBefore = IShapesLedger(SHAPES).pendingFees();
        uint256 keeperBefore = keeper.balance;
        fillUp();
        assertEq(IShapesLedger(SHAPES).redeemableBacking() - backingBefore, 0.2 ether);
        assertEq(IShapesLedger(SHAPES).pendingFees() - feesBefore, 0.02 ether);
        uint256 setupPay = keeper.balance - keeperBefore;
        assertEq(address(balancer).balance + 0.2 ether + 0.02 ether + setupPay, 0.2356 ether);
        emit log_named_decimal_uint("minimum-board setup keeper pay", setupPay, 18);
        emit log_named_decimal_uint("minimum-board operating cash after setup", address(balancer).balance, 18);
        assertEq(balancer.getActiveShapes()[0], 20);
        assertEq(balancer.admissionStatus(), 0);
        assertEq(IBuyerRefund(address(pool)).acquisitionEscrowTotal(), 0);

        (uint256 fee, uint256 vrf, uint256 total) = pool.quoteAcquisitionPrice(1);
        assertEq(vrf, 2_340_000 * 0.55 gwei);
        uint256[] memory ids = buy(buyer, 1);
        assertEq(ids.length, 1);
        assertEq(IBuyerRefund(address(pool)).acquisitionEscrowTotal(), fee);
        assertEq(total, fee + vrf);
        vm.prank(creator);
        balancer.close();
        uint256 creatorCash = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(creatorCash, creator);
        assertEq(balancer.creatorCredit(), 0);
        assertEq(IBuyerRefund(address(pool)).acquisitionEscrowTotal(), fee);

        vm.roll(block.number + ITimeout(address(pool)).selectionTimeoutBlocks() + 1);
        vm.prank(stranger);
        balancer.performUpkeepUnpaid();
        (,,,, uint8 status,) = pool.acquisitions(ids[0]);
        assertEq(status, 3, "real FWA expired the purchase");
        assertEq(IBuyerRefund(address(pool)).acquisitionRefundCredit(buyer), fee);
        uint256 before = buyer.balance;
        vm.prank(buyer);
        uint256 returned = IBuyerRefund(address(pool)).withdrawAcquisitionRefund();
        assertEq(returned, fee);
        assertEq(buyer.balance - before, fee);
        assertEq(IBuyerRefund(address(pool)).acquisitionRefundCredit(buyer), 0);
        assertEq(IBuyerRefund(address(pool)).acquisitionEscrowTotal(), 0);
        emit log_named_decimal_uint("buyer nonrefundable VRF", vrf, 18);
    }

    function test_rateChangeAndCuratedModeDuringConcurrentShapePurchases() public {
        _createShapeOnly(0.5 ether, 20, 0);
        fillUp();
        uint256[] memory a = buy(buyer, 1);
        uint256[] memory b = buy(stranger, 1);
        assertEq(pool.unsettledAcquisitionCount(), 2);
        vm.prank(creator);
        balancer.setCuratedRequired(true);
        assertEq(balancer.admissionStatus(), 3);
        vm.prank(creator);
        balancer.setCreatorRevenueBps(10_000);
        fulfill(a[0], 0);
        fulfill(b[0], 0);
        pool.processAcquisitions(2);
        assertEq(pool.unsettledAcquisitionCount(), 0);
        uint256 proceeds = pool.ownerProceeds();
        assertGt(proceeds, 0.01 ether);
        uint256 got = balancer.collectProceeds();
        assertEq(got, proceeds);
        assertEq(balancer.creatorCredit(), proceeds);
        emit log_named_decimal_uint("two successful Shapes-only owner proceeds", proceeds, 18);
        assertEq(balancer.collectProceeds(), 0);
        vm.prank(stranger);
        balancer.performUpkeepUnpaid();
        assertEq(balancer.creatorCredit(), proceeds);
        vm.prank(creator);
        balancer.setCuratedRequired(false);
        assertEq(balancer.admissionStatus(), 0);
        assertTrue(balancer.canPurchase(buyer));
        uint256 balance = address(balancer).balance;
        vm.prank(creator);
        balancer.claimSurplus(proceeds, creator);
        assertEq(address(balancer).balance, balance - proceeds);
        assertEq(balancer.creatorCredit(), 0);
    }

    function test_noSmallestShapePackCanBeWonRedeemedAndRestocked() public {
        // One 0.02 ETH pack, with no 0.01 ETH Shape and no curated NFT.
        _createShapeOnly(1 ether, uint256(1) << (16 * 9), 2500);
        fillUp();
        assertEq(balancer.getActiveShapes()[0], 0);
        assertEq(balancer.getActiveShapes()[9], 1);
        assertEq(balancer.admissionStatus(), 0);
        uint256 lid = balancer.getActiveIds()[0];
        (address collection,,, uint256 tokenId,,,,) = pool.listings(lid);
        assertEq(collection, packs);
        assertEq(IERC721Min(packs).ownerOf(tokenId), address(pool));

        uint256[] memory draws = buy(buyer, 1);
        fulfill(draws[0], wordForSlot(1));
        pool.processAcquisitions(1);
        (,,, uint256 won, uint8 status,) = pool.acquisitions(draws[0]);
        assertEq(status, 2);
        assertEq(won, lid);
        assertEq(IERC721Min(packs).ownerOf(tokenId), buyer);
        uint256 before = buyer.balance;
        vm.prank(buyer);
        IShapePacks(packs).redeem(tokenId);
        assertEq(buyer.balance - before, 0.02 ether, "pack backing paid to real winner");

        uint256 proceeds = pool.ownerProceeds();
        assertGt(proceeds, 0.02 ether);
        assertEq(balancer.collectProceeds(), proceeds);
        assertEq(balancer.creatorCredit(), proceeds / 4);
        upkeep();
        assertEq(balancer.getActiveShapes()[9], 1);
        assertEq(balancer.admissionStatus(), 0);
        vm.prank(creator);
        balancer.close();
        uint256[] memory restocked = balancer.getActiveIds();
        assertEq(restocked.length, 1);
        uint256 cash = address(balancer).balance;
        vm.prank(creator);
        balancer.unlistShapes(restocked);
        assertEq(address(balancer).balance - cash, 0.02 ether);
        uint256 exit = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(exit, creator);
        assertEq(address(balancer).balance, 0);
        assertEq(pool.ownerProceeds(), 0);
    }

    function test_restrictedKeeperThenOpenAccessCannotTakeCredit() public {
        _createShapeOnly(1 ether, 20, 10_000);
        fillUp();
        uint256[] memory draws = buy(buyer, 1);
        fulfill(draws[0], 0);
        pool.processAcquisitions(1);
        uint256 proceeds = balancer.collectProceeds();
        assertGt(proceeds, 0.01 ether);
        assertEq(balancer.creatorCredit(), proceeds);
        vm.prank(keeperAdmin);
        factory.setKeepersRestricted(true);
        bytes32 restrictedSettings = balancer.settingsHash();
        vm.prank(stranger);
        vm.expectRevert(PoolBalancer.KeeperNotApproved.selector);
        balancer.performUpkeep(restrictedSettings, 0, 0);
        vm.prank(keeperAdmin);
        factory.setKeeperApproved(keeper, true);
        uint256 credit = balancer.creatorCredit();
        uint256 keeperBefore = keeper.balance;
        upkeep();
        assertGt(keeper.balance, keeperBefore, "approved keeper earned for real draw");
        assertEq(balancer.creatorCredit(), credit);
        vm.prank(keeperAdmin);
        factory.setKeepersRestricted(false);
        draws = buy(buyer, 1);
        fulfill(draws[0], 0);
        pool.processAcquisitions(1);
        credit += balancer.collectProceeds();
        uint256 strangerBefore = stranger.balance;
        bytes32 expected = balancer.settingsHash();
        vm.prank(stranger, stranger);
        balancer.performUpkeep(expected, 0, 0);
        assertGt(stranger.balance, strangerBefore, "open keeper earned for real draw");
        assertEq(balancer.creatorCredit(), credit);
    }

    function test_deliveredHundredEthPrizeCapitalClaimableBeforeReconciliation() public {
        uint256 t = 20 | (uint256(1) << (16 * 8));
        _createShapeOnly(201 ether, t, 10_000);
        fillUp();
        assertEq(balancer.getActiveShapes()[8], 1);
        uint256 largeId;
        uint256 largeSlot;
        uint256[] memory listed = balancer.getActiveIds();
        for (uint256 i; i < listed.length; ++i) {
            (uint8 kind, uint8 d,,,) = balancer.items(listed[i]);
            if (kind == 2 && d == 8) {
                largeId = listed[i];
                (,,,,,, largeSlot,) = pool.listings(largeId);
                break;
            }
        }
        assertGt(largeSlot, 0);
        uint256[] memory draws = buy(buyer, 1);
        fulfill(draws[0], wordForSlot(largeSlot));
        pool.processAcquisitions(1);
        (,,, uint256 selected, uint8 status,) = pool.acquisitions(draws[0]);
        assertEq(status, 2, "100 ETH Shape was delivered by the real FWA pool");
        assertEq(selected, largeId);
        (,,, uint256 tokenId,,,,) = pool.listings(largeId);
        assertEq(shapes.ownerOf(tokenId), buyer);
        assertEq(shapes.backingOf(tokenId), 100 ether);

        assertEq(balancer.getActiveShapes()[8], 1, "unreconciled counter still counts delivered asset");
        assertEq(balancer.reconciledSequence(), 0);
        uint256 reserveBefore = balancer.requiredReserve();
        assertGt(balancer.withdrawableSurplus(), 100 ether);
        uint256 creatorBefore = creator.balance;
        vm.prank(creator);
        balancer.claimSurplus(100 ether, creator);
        assertEq(creator.balance - creatorBefore, 100 ether, "replacement cash released after the win");
        upkeep();
        assertEq(balancer.getActiveShapes()[8], 0, "upkeep observes the actual missing prize");
        assertLt(address(balancer).balance - balancer.creatorCredit(), 100 ether);
        assertGt(balancer.requiredReserve(), address(balancer).balance - balancer.creatorCredit());
        emit log_named_decimal_uint("capital withdrawn after confirmed 100 ETH win", 100 ether, 18);
        emit log_named_decimal_uint("reserve before reconciliation", reserveBefore, 18);
        emit log_named_decimal_uint("reserve after reconciliation", balancer.requiredReserve(), 18);
        emit log_named_decimal_uint("operating cash after reconciliation", address(balancer).balance - balancer.creatorCredit(), 18);
    }

    function test_hostilePolicyFailureCannotConsumeCreditOrStopUnpaidRecovery() public {
        _createShapeOnly(1 ether, 20, 10_000);
        fillUp();
        uint256[] memory draws = buy(buyer, 1);
        fulfill(draws[0], 0);
        pool.processAcquisitions(1);
        uint256 proceeds = balancer.collectProceeds();
        assertGt(proceeds, 0.01 ether);
        assertEq(balancer.creatorCredit(), proceeds);

        HostileQuotePolicy hostile = new HostileQuotePolicy();
        uint256 survivingId = balancer.getActiveIds()[1];
        (,,,, uint112 survivingPrice) = balancer.items(survivingId);
        vm.prank(creator);
        balancer.proposeKeeperPolicy(address(hostile));
        vm.warp(block.timestamp + 2 days);
        (uint256 required, uint256 shortfall) = balancer.policyFunding(address(hostile));
        assertGt(required, 0);
        assertEq(shortfall, 0);
        balancer.activateKeeperPolicy();
        assertEq(balancer.keeperPolicy(), address(hostile));
        (,,,, uint112 priceAfter) = balancer.items(survivingId);
        assertEq(priceAfter, survivingPrice, "policy activation did not reprice existing listings");
        hostile.setFail(true);
        bytes32 expected = balancer.settingsHash();
        vm.prank(keeper, keeper);
        vm.expectRevert();
        balancer.performUpkeep(expected, 0, 0);
        assertEq(balancer.reconciledSequence(), 0);
        assertEq(balancer.creatorCredit(), proceeds);
        vm.prank(stranger);
        balancer.performUpkeepUnpaid();
        assertEq(balancer.reconciledSequence(), 1);
        assertEq(balancer.creatorCredit(), proceeds);

        vm.prank(creator);
        balancer.setPaidUpkeepEnabled(false);
        assertFalse(balancer.paidUpkeepEnabled());
        assertEq(balancer.pendingKeeperPolicy(), address(0));
        uint256 claimable = balancer.creatorCredit();
        vm.prank(creator);
        balancer.claimSurplus(claimable, creator);
        assertEq(balancer.creatorCredit(), 0);
        emit log_named_decimal_uint("credit preserved across failed paid quote and unpaid recovery", claimable, 18);
    }

    function test_fiveTimedOutDrawsPublicUpkeepReturnsFeesWithoutProcessor() public {
        _createShapeOnly(1 ether, 20, 1000);
        fillUp();
        (uint256 fee, uint256 vrf,) = pool.quoteAcquisitionPrice(1);
        uint256 firstExpired = buyOnePerBlock(buyer, 5);
        assertEq(pool.unsettledAcquisitionCount(), 5);
        assertEq(balancer.admissionStatus(), 4);
        assertEq(IBuyerRefund(address(pool)).acquisitionEscrowTotal(), 5 * fee);
        vm.roll(firstExpired + 4);
        for (uint256 i; i < 3; ++i) {
            vm.prank(stranger);
            balancer.performUpkeepUnpaid();
        }
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(balancer.reconciledSequence(), 5);
        assertEq(IBuyerRefund(address(pool)).acquisitionRefundCredit(buyer), 5 * fee);
        uint256 before = buyer.balance;
        vm.prank(buyer);
        IBuyerRefund(address(pool)).withdrawAcquisitionRefund();
        assertEq(buyer.balance - before, 5 * fee);
        assertEq(IBuyerRefund(address(pool)).acquisitionEscrowTotal(), 0);
        assertEq(balancer.admissionStatus(), 0);
        emit log_named_decimal_uint("five buyers' nonrefundable randomness charges", 5 * vrf, 18);
    }

    function test_donorCapitalEntersCreatorSurplusWithoutCreditOrDonorClaim() public {
        _createShapeOnly(0.5 ether, 20, 1000);
        fillUp();
        uint256 reserve = balancer.requiredReserve();
        uint256 prior = balancer.withdrawableSurplus();
        uint256 donorBefore = stranger.balance;
        vm.prank(stranger);
        balancer.depositETH{value: 10 ether}();
        assertEq(stranger.balance, donorBefore - 10 ether);
        assertEq(balancer.creatorCredit(), 0);
        assertEq(balancer.withdrawableSurplus(), prior + 10 ether);
        vm.prank(stranger);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.claimSurplus(10 ether, stranger);
        uint256 creatorBefore = creator.balance;
        vm.prank(creator);
        balancer.claimSurplus(10 ether, creator);
        assertEq(creator.balance - creatorBefore, 10 ether);
        assertEq(balancer.requiredReserve(), reserve);
        emit log_named_decimal_uint("irrevocable donor capital claimed by creator", 10 ether, 18);
    }

    function test_shapesOnlyToMixedAndBackAcrossBothAdmissionModes() public {
        _createShapeOnly(1 ether, 20, 1000);
        fillUp();
        assertEq(balancer.admissionStatus(), 0);
        CreatorCollection collection = new CreatorCollection();
        collection.mint(creator, 17);
        vm.prank(creator);
        collection.approve(address(balancer), 17);
        PoolBalancer.CuratedInput[] memory one = new PoolBalancer.CuratedInput[](1);
        one[0] = PoolBalancer.CuratedInput(address(collection), 17, 0.2 ether);
        vm.prank(creator);
        uint256 lid = balancer.listCuratedBatch(one)[0];
        assertEq(collection.ownerOf(17), address(pool));
        assertEq(balancer.admissionStatus(), 0);
        vm.prank(creator);
        balancer.setCuratedRequired(true);
        assertEq(balancer.admissionStatus(), 0);
        vm.prank(creator);
        balancer.withdrawCurated(lid, creator);
        assertEq(collection.ownerOf(17), creator);
        assertEq(balancer.admissionStatus(), 3);
        vm.prank(creator);
        balancer.setCuratedRequired(false);
        assertEq(balancer.admissionStatus(), 0);
        uint256[] memory draws = buy(buyer, 1);
        assertEq(draws.length, 1, "standard mode sells after last curated NFT is removed");
    }

    function test_fiveGweiSpikeRestocksAtCurrentFeeWithoutSpendingCredit() public {
        _createShapeOnly(1 ether, 20, 5000);
        fillUp();
        uint256 oldId = balancer.getActiveIds()[0];
        (,,,, uint112 oldPrice) = balancer.items(oldId);
        vm.fee(5 gwei);
        vm.txGasPrice(5 gwei);
        gasProbe.record();
        assertEq(gasProbe.baseFee(), 5 gwei);
        assertEq(gasProbe.gasPrice(), 5 gwei);
        (, uint256 vrf,) = pool.quoteAcquisitionPrice(1);
        assertEq(vrf, 0.0117 ether);
        uint256[] memory draws = buy(buyer, 1);
        fulfill(draws[0], 0);
        pool.processAcquisitions(1);
        uint256 proceeds = balancer.collectProceeds();
        assertGt(proceeds, 0.01 ether);
        assertEq(balancer.creatorCredit(), proceeds / 2);
        upkeep();
        fillUp();
        assertEq(balancer.getActiveShapes()[0], 20);
        uint256[] memory ids = balancer.getActiveIds();
        uint256 latest;
        for (uint256 i; i < ids.length; ++i) if (ids[i] > latest) latest = ids[i];
        (,,,, uint112 newPrice) = balancer.items(latest);
        assertGt(newPrice, oldPrice);
        assertEq(balancer.creatorCredit(), proceeds / 2);
        emit log_named_decimal_uint("high-gas buyer VRF fee", vrf, 18);
        emit log_named_decimal_uint("old listing price", oldPrice, 18);
        emit log_named_decimal_uint("new listing price", newPrice, 18);
    }

    function test_fiveStandardShapesOnlySalesAgainstModelZeroSales() public {
        _createShapeOnly(1 ether, 20, 1000);
        fillUp();
        uint256 ownerTotal;
        uint256 playerTotal;
        uint256 protocolFeesBefore = IFWAFeeLedger(address(pool)).accruedProtocolFees();
        (, uint256 vrfPerDraw,) = pool.quoteAcquisitionPrice(1);
        for (uint256 i; i < 5; ++i) {
            (,, uint256 paid) = pool.quoteAcquisitionPrice(1);
            uint256[] memory draws = buy(buyer, 1);
            playerTotal += paid;
            fulfill(draws[0], 0);
            pool.processAcquisitions(1);
            (,,,, uint8 status,) = pool.acquisitions(draws[0]);
            assertEq(status, 2);
            ownerTotal += balancer.collectProceeds();
            upkeep();
            fillUp();
            assertEq(balancer.admissionStatus(), 0);
        }
        assertGt(ownerTotal, 0.05 ether);
        assertGt(playerTotal, 0.05 ether);
        assertEq(balancer.creatorCredit(), ownerTotal / 10);
        uint256 protocolFees = IFWAFeeLedger(address(pool)).accruedProtocolFees() - protocolFeesBefore;
        assertEq(ownerTotal + protocolFees + 5 * vrfPerDraw, playerTotal);
        assertEq(protocolFees, 0.00329875 ether);
        emit log_named_decimal_uint("real five-sale owner proceeds", ownerTotal, 18);
        emit log_named_decimal_uint("real five-sale player ETH paid excluding gas", playerTotal, 18);
        emit log_named_decimal_uint("real five-sale FWA edge", protocolFees, 18);
    }

    function test_maximumThousandPrizeBoardStartsStockingInBoundedBatch() public {
        _createShapeOnly(20 ether, 1000, 1000);
        assertEq(balancer.target(), 1000);
        assertEq(balancer.admissionStatus(), 2);
        uint256 openingReserve = balancer.requiredReserve();
        assertGt(openingReserve, 11 ether);
        assertLt(openingReserve, 20 ether);
        upkeep();
        assertEq(balancer.getActiveShapes()[0], 5);
        assertEq(balancer.admissionStatus(), 2);
        emit log_named_decimal_uint("1000-prize opening reserve", openingReserve, 18);
        emit log_named_decimal_uint("1000-prize reserve after first batch", balancer.requiredReserve(), 18);
    }

    function test_largeWinTopUpOrDropTopBothReopenWithoutFutureSales() public {
        uint256 topTarget = 20 | (uint256(1) << (16 * 8));
        _createShapeOnly(101 ether, topTarget, 1000);
        fillUp();
        uint256 largeSlot;
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 d,,,) = balancer.items(ids[i]);
            if (kind == 2 && d == 8) {
                (,,,,,, largeSlot,) = pool.listings(ids[i]);
                break;
            }
        }
        assertGt(largeSlot, 0);
        uint256[] memory draws = buy(buyer, 1);
        fulfill(draws[0], wordForSlot(largeSlot));
        pool.processAcquisitions(1);
        upkeep();
        assertEq(balancer.getActiveShapes()[8], 0);
        assertGt(balancer.requiredReserve(), address(balancer).balance - balancer.creatorCredit());
        uint256 snapshot = vm.snapshotState();

        vm.prank(creator);
        balancer.depositETH{value: 100 ether}();
        fillUp();
        assertEq(balancer.getActiveShapes()[8], 1);
        assertEq(balancer.admissionStatus(), 0);
        assertTrue(vm.revertToState(snapshot));

        vm.prank(creator);
        balancer.configure(1500, 20);
        assertEq(balancer.target(), 20);
        assertEq(balancer.getActiveShapes()[8], 0);
        assertEq(balancer.admissionStatus(), 0);
        assertGt(balancer.withdrawableSurplus(), 0);
        emit log_named_decimal_uint("creator response top-up", 100 ether, 18);
    }

    function test_stagedRestockWithoutIndependentFwaProcessor() public {
        _createShapeOnly(1 ether, 20, 1000);
        fillUp();
        uint256[] memory draws = buy(buyer, 1);
        vm.prank(creator);
        balancer.configure(1500, 25);
        upkeep();
        assertEq(balancer.getActiveShapes()[0], 25);
        assertEq(pool.unsettledAcquisitionCount(), 1);
        uint256[] memory reservedDraw = buy(stranger, 1);
        assertGt(pool.reservedStagedCount(), 0);
        fulfill(draws[0], 0);
        assertEq(pool.unsettledAcquisitionCount(), 1);
        fulfill(reservedDraw[0], 0);
        assertEq(pool.unsettledAcquisitionCount(), 1, "staged restock skipped FWA fast processing");
        vm.prank(stranger);
        balancer.performUpkeepUnpaid();
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(balancer.reconciledSequence(), 2);
        (,,, uint256 won, uint8 status,) = pool.acquisitions(draws[0]);
        assertEq(status, 2);
        assertGt(won, 0);
        (,,, won, status,) = pool.acquisitions(reservedDraw[0]);
        assertEq(status, 2);
        assertGt(won, 0);
        assertEq(balancer.admissionStatus(), 0);
    }

    function test_normalPointOneGweiQuoteBeforeSale() public {
        vm.fee(0.1 gwei);
        vm.txGasPrice(0.15 gwei);
        gasProbe.record();
        assertEq(gasProbe.baseFee(), 0.1 gwei);
        assertEq(gasProbe.gasPrice(), 0.15 gwei);
        _createShapeOnly(1 ether, 20, 1000);
        fillUp();
        (uint256 fee, uint256 vrf, uint256 total) = pool.quoteAcquisitionPrice(1);
        assertEq(vrf, 0.000351 ether);
        assertLe(total, 0.015 ether, "one 0.01 ETH Shape draw within 1.5x backing at steady normal gas");
        uint256[] memory draws = buy(buyer, 1);
        fulfill(draws[0], 0);
        pool.processAcquisitions(1);
        assertGt(balancer.collectProceeds(), 0.01 ether);
        assertEq(fee + vrf, total);
        emit log_named_decimal_uint("normal-gas all-in quote", total, 18);
    }

    function test_twoGweiSaleStillSettlesAndRestocks() public {
        vm.fee(2 gwei);
        vm.txGasPrice(2.05 gwei);
        gasProbe.record();
        assertEq(gasProbe.baseFee(), 2 gwei);
        assertEq(gasProbe.gasPrice(), 2.05 gwei);
        _createShapeOnly(1 ether, 20, 1000);
        fillUp();
        (, uint256 vrf,) = pool.quoteAcquisitionPrice(1);
        assertEq(vrf, 0.004797 ether);
        uint256[] memory draws = buy(buyer, 1);
        fulfill(draws[0], 0);
        pool.processAcquisitions(1);
        assertGt(balancer.collectProceeds(), 0.01 ether);
        upkeep();
        fillUp();
        assertEq(balancer.getActiveShapes()[0], 20);
        assertEq(balancer.admissionStatus(), 0);
        emit log_named_decimal_uint("2-gwei buyer VRF fee", vrf, 18);
    }

    function test_noProcessorFiveGweiTimeoutAndRefund() public {
        vm.fee(5 gwei);
        vm.txGasPrice(5 gwei);
        gasProbe.record();
        assertEq(gasProbe.baseFee(), 5 gwei);
        assertEq(gasProbe.gasPrice(), 5 gwei);
        _createShapeOnly(1 ether, 20, 1000);
        fillUp();
        (uint256 fee, uint256 vrf,) = pool.quoteAcquisitionPrice(1);
        assertEq(vrf, 0.0117 ether);
        uint256 firstExpired = buyOnePerBlock(buyer, 5);
        vm.roll(firstExpired + 4);
        for (uint256 i; i < 3; ++i) {
            vm.prank(stranger);
            balancer.performUpkeepUnpaid();
        }
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(IBuyerRefund(address(pool)).acquisitionRefundCredit(buyer), 5 * fee);
        assertEq(balancer.admissionStatus(), 0);
        emit log_named_decimal_uint("5-gwei five-buyer nonrefundable VRF", 5 * vrf, 18);
    }

    function test_zeroDemandCloseoutReturnsBackingButNotMintOrKeeperCosts() public {
        uint256 creatorBefore = creator.balance;
        uint256 keeperBefore = keeper.balance;
        uint256 shapeBackingBefore = IShapesLedger(SHAPES).redeemableBacking();
        uint256 shapeFeesBefore = IShapesLedger(SHAPES).pendingFees();
        _createShapeOnly(0.2356 ether, 20, 1000);
        fillUp();
        vm.prank(creator);
        balancer.close();
        uint256[] memory all = balancer.getActiveIds();
        assertEq(all.length, 20);
        vm.prank(creator);
        balancer.unlistShapes(all);
        assertEq(IShapesLedger(SHAPES).redeemableBacking(), shapeBackingBefore);
        assertEq(IShapesLedger(SHAPES).pendingFees() - shapeFeesBefore, 0.02 ether);
        uint256 exit = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(exit, creator);
        assertEq(address(balancer).balance, 0);
        assertEq(creatorBefore - creator.balance, 0.02 ether + keeper.balance - keeperBefore);
        emit log_named_decimal_uint("zero-demand mint and keeper loss excluding actor gas", creatorBefore - creator.balance, 18);
    }

    function test_thousandPrizeBoardFullSetupAndIdleCloseout() public {
        uint256 creatorBefore = creator.balance;
        uint256 keeperBefore = keeper.balance;
        uint256 backingBefore = IShapesLedger(SHAPES).redeemableBacking();
        uint256 feeBefore = IShapesLedger(SHAPES).pendingFees();
        _createShapeOnly(20 ether, 1000, 1000);
        uint256 calls = fillUp();
        assertEq(calls, 200);
        assertEq(balancer.getActiveShapes()[0], 1000);
        assertEq(balancer.admissionStatus(), 0);
        assertEq(IShapesLedger(SHAPES).redeemableBacking() - backingBefore, 10 ether);
        assertEq(IShapesLedger(SHAPES).pendingFees() - feeBefore, 1 ether);
        vm.prank(creator);
        balancer.close();
        for (uint256 batch; batch < 50; ++batch) {
            uint256[] memory active = balancer.getActiveIds();
            uint256[] memory twenty = new uint256[](20);
            for (uint256 j; j < 20; ++j) twenty[j] = active[j];
            vm.prank(creator);
            balancer.unlistShapes(twenty);
        }
        assertEq(IShapesLedger(SHAPES).redeemableBacking(), backingBefore);
        uint256 free = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(free, creator);
        assertEq(address(balancer).balance, 0);
        assertEq(pool.ownerProceeds(), 0);
        uint256 keeperPay = keeper.balance - keeperBefore;
        assertEq(creatorBefore - creator.balance, 1 ether + keeperPay);
        emit log_named_uint("1000-prize setup keeper calls", calls);
        emit log_named_decimal_uint("1000-prize setup keeper pay", keeperPay, 18);
        emit log_named_decimal_uint("1000-prize zero-demand creator loss excluding actor gas", creatorBefore - creator.balance, 18);
    }

    function test_outsiderBuyerKeeperCannotProfitFromFiveExpiredDrawsAtNormalGas() public {
        vm.fee(0.1 gwei);
        vm.txGasPrice(0.15 gwei);
        gasProbe.record();
        assertEq(gasProbe.baseFee(), 0.1 gwei);
        assertEq(gasProbe.gasPrice(), 0.15 gwei);
        _createShapeOnly(1 ether, 20, 0);
        fillUp();
        HostileQuotePolicy hostile = new HostileQuotePolicy();
        vm.prank(creator);
        balancer.proposeKeeperPolicy(address(hostile));
        vm.warp(block.timestamp + 2 days);
        balancer.activateKeeperPolicy();
        (uint256 fee, uint256 vrf,) = pool.quoteAcquisitionPrice(1);
        uint256 before = stranger.balance;
        uint256 firstExpired = buyOnePerBlock(stranger, 5);
        vm.roll(firstExpired + 4);
        for (uint256 i; i < 3; ++i) {
            bytes32 expected = balancer.settingsHash();
            vm.prank(stranger, stranger);
            balancer.performUpkeep(expected, 0, 0);
        }
        uint256 reward = stranger.balance - (before - 5 * (fee + vrf));
        vm.prank(stranger);
        IBuyerRefund(address(pool)).withdrawAcquisitionRefund();
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(stranger.balance, before + reward - 5 * vrf);
        assertLt(reward, 5 * vrf, "outside VRF expense exceeds the most aggressive bounded quote");
        emit log_named_decimal_uint("manufactured-work keeper reward", reward, 18);
        emit log_named_decimal_uint("manufactured-work VRF cost", 5 * vrf, 18);
    }

    function test_creatorBuyerKeeperCoalitionFullCyclePaysExternalFees() public {
        vm.fee(0.1 gwei);
        vm.txGasPrice(0.15 gwei);
        gasProbe.record();
        assertEq(gasProbe.baseFee(), 0.1 gwei);
        assertEq(gasProbe.gasPrice(), 0.15 gwei);
        keeper = creator; // the same economic actor takes every keeper transfer
        uint256 before = creator.balance;
        uint256 feeBefore = IShapesLedger(SHAPES).pendingFees();
        _createShapeOnly(1 ether, 20, 10_000);
        fillUp();
        (,, uint256 total) = pool.quoteAcquisitionPrice(1);
        (, uint256 vrf,) = pool.quoteAcquisitionPrice(1);
        uint256[] memory draws = buy(creator, 1);
        fulfill(draws[0], 0);
        pool.processAcquisitions(1);
        (,,, uint256 won, uint8 status,) = pool.acquisitions(draws[0]);
        assertEq(status, 2);
        (,,, uint256 tokenId,,,,) = pool.listings(won);
        assertEq(shapes.ownerOf(tokenId), creator);
        uint256[] memory one = new uint256[](1);
        one[0] = tokenId;
        vm.prank(creator);
        assertEq(shapes.redeemBatch(one), 0.01 ether);
        uint256 proceeds = balancer.collectProceeds();
        uint256 edge = IFWAFeeLedger(address(pool)).accruedProtocolFees();
        assertEq(total, proceeds + edge + vrf);
        upkeep();
        fillUp();
        assertEq(balancer.getActiveShapes()[0], 20);
        vm.prank(creator);
        balancer.close();
        uint256[] memory active = balancer.getActiveIds();
        vm.prank(creator);
        balancer.unlistShapes(active);
        uint256 free = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(free, creator);
        assertEq(address(balancer).balance, 0);
        uint256 mintFees = IShapesLedger(SHAPES).pendingFees() - feeBefore;
        assertEq(mintFees, 0.021 ether);
        assertEq(before - creator.balance, mintFees + edge + vrf);
        emit log_named_decimal_uint("creator-buyer-keeper coalition cost excluding gas", before - creator.balance, 18);
        emit log_named_decimal_uint("creator-buyer-keeper external FWA edge", edge, 18);
    }

    function test_refusingCreatorCollectionLeavesBuyerRefundAndCreatorRecovery() public {
        _createShapeOnly(1 ether, 20, 1000);
        fillUp();
        RefusingCreatorCollection hostile = new RefusingCreatorCollection();
        hostile.mint(creator, 42);
        vm.prank(creator);
        hostile.approve(address(balancer), 42);
        PoolBalancer.CuratedInput[] memory one = new PoolBalancer.CuratedInput[](1);
        one[0] = PoolBalancer.CuratedInput(address(hostile), 42, 0.2 ether);
        vm.prank(creator);
        uint256 lid = balancer.listCuratedBatch(one)[0];
        (,,,,,, uint256 slot,) = pool.listings(lid);
        (uint256 fee, uint256 vrf,) = pool.quoteAcquisitionPrice(1);
        uint256[] memory draws = buy(buyer, 1);
        hostile.setFrozen(true);
        fulfill(draws[0], wordForSlot(slot));
        pool.processAcquisitions(1);
        (,,, uint256 selected, uint8 status,) = pool.acquisitions(draws[0]);
        assertEq(selected, lid);
        assertEq(status, 7, "FWA quarantined the failed delivery");
        assertEq(IFWAFailedDelivery(address(pool)).deliveryEscrowTotal(), fee);
        assertEq(pool.ownerProceeds(), 0);
        vm.prank(stranger);
        balancer.performUpkeepUnpaid();
        assertEq(balancer.reconciledSequence(), 1);
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(buyer);
        IFWAFailedDelivery(address(pool)).refundFailedDelivery(lid);
        assertEq(IFWAFailedDelivery(address(pool)).deliveryEscrowTotal(), 0);
        assertEq(IBuyerRefund(address(pool)).acquisitionRefundCredit(buyer), fee);
        uint256 buyerBefore = buyer.balance;
        vm.prank(buyer);
        IBuyerRefund(address(pool)).withdrawAcquisitionRefund();
        assertEq(buyer.balance - buyerBefore, fee);
        hostile.setFrozen(false);
        vm.prank(creator);
        assertEq(balancer.recoverRefunded(lid, creator), 0);
        assertEq(hostile.ownerOf(42), creator);
        emit log_named_decimal_uint("failed-delivery buyer VRF loss", vrf, 18);
    }

    function test_atomicCuratedCreationNeedsPredictedApprovalAndRollsBackFailure() public {
        CreatorCollection collection = new CreatorCollection();
        collection.mint(creator, 1);
        collection.mint(creator, 2);
        bytes32 salt = bytes32(uint256(707));
        address predicted = factory.predictBalancer(creator, salt);
        vm.prank(creator);
        collection.approve(predicted, 1);
        PoolBalancer.CreationConfig memory cfg =
            PoolBalancer.CreationConfig(1500, 1000, 20, shapes.mintFee(), true);
        PoolBalancer.CuratedInput[] memory curated = new PoolBalancer.CuratedInput[](1);
        curated[0] = PoolBalancer.CuratedInput(address(collection), 1, 0.2 ether);
        vm.prank(creator);
        balancer = PoolBalancer(payable(factory.createBalancer{value: 1 ether}(salt, cfg, curated)));
        pool = balancer.pool();
        assertEq(address(balancer), predicted);
        assertTrue(factory.isBalancer(predicted));
        assertEq(collection.ownerOf(1), address(pool));
        assertEq(balancer.admissionStatus(), 2);
        fillUp();
        assertEq(balancer.admissionStatus(), 0);

        bytes32 badSalt = bytes32(uint256(708));
        address badPredicted = factory.predictBalancer(creator, badSalt);
        curated[0] = PoolBalancer.CuratedInput(address(collection), 2, 0.2 ether);
        uint256 before = creator.balance;
        vm.prank(creator);
        vm.expectRevert();
        factory.createBalancer{value: 1 ether}(badSalt, cfg, curated);
        assertFalse(factory.isBalancer(badPredicted));
        assertEq(badPredicted.code.length, 0);
        assertEq(collection.ownerOf(2), creator);
        assertEq(creator.balance, before);
    }

    function test_publicCuratedWitnessRefreshAfterSelectedProofWithdrawn() public {
        _createShapeOnly(1 ether, 20, 1000);
        fillUp();
        CreatorCollection collection = new CreatorCollection();
        collection.mint(creator, 1);
        collection.mint(creator, 2);
        vm.startPrank(creator);
        collection.setApprovalForAll(address(balancer), true);
        PoolBalancer.CuratedInput[] memory curated = new PoolBalancer.CuratedInput[](2);
        curated[0] = PoolBalancer.CuratedInput(address(collection), 1, 0.2 ether);
        curated[1] = PoolBalancer.CuratedInput(address(collection), 2, 0.3 ether);
        uint256[] memory lids = balancer.listCuratedBatch(curated);
        balancer.setCuratedRequired(true);
        vm.stopPrank();
        assertEq(balancer.admissionStatus(), 0);
        uint256[] memory draws = buy(buyer, 1);
        fulfill(draws[0], 0); // select one Shape; leave Balancer's accounting unreconciled
        pool.processAcquisitions(1);
        assertEq(pool.unsettledAcquisitionCount(), 0);
        vm.prank(creator);
        balancer.withdrawCurated(lids[0], creator);
        assertEq(collection.ownerOf(1), creator);
        assertEq(collection.ownerOf(2), address(pool));
        assertEq(balancer.admissionStatus(), 7);
        assertFalse(balancer.canPurchase(buyer));
        vm.prank(stranger);
        assertTrue(balancer.refreshCuratedWitness(lids[1]));
        assertEq(balancer.admissionStatus(), 0);
        assertTrue(balancer.canPurchase(buyer));
    }

    function test_predictedAddressPrefundingBecomesPoolCapitalAndCreatorSurplus() public {
        bytes32 salt = bytes32(uint256(909));
        address predicted = factory.predictBalancer(creator, salt);
        uint256 donorBefore = stranger.balance;
        vm.prank(stranger);
        payable(predicted).transfer(10 ether);
        assertEq(predicted.balance, 10 ether);
        assertEq(stranger.balance, donorBefore - 10 ether);
        PoolBalancer.CreationConfig memory cfg =
            PoolBalancer.CreationConfig(1500, 1000, 20, shapes.mintFee(), false);
        vm.prank(creator);
        balancer = PoolBalancer(payable(factory.createBalancer{value: 0}(salt, cfg, new PoolBalancer.CuratedInput[](0))));
        pool = balancer.pool();
        assertEq(address(balancer), predicted);
        assertEq(address(balancer).balance, 10 ether);
        assertEq(balancer.creatorCredit(), 0);
        fillUp();
        uint256 free = balancer.withdrawableSurplus();
        assertGt(free, 9 ether);
        vm.prank(stranger);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.claimSurplus(free, stranger);
        uint256 creatorBefore = creator.balance;
        vm.prank(creator);
        balancer.claimSurplus(free, creator);
        assertEq(creator.balance - creatorBefore, free);
        assertEq(balancer.creatorCredit(), 0);
        emit log_named_decimal_uint("prefunded donor capital creator surplus", free, 18);
    }
}
