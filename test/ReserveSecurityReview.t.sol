// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, ITimeout} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {IKeeperPolicy} from "../src/interfaces/IKeeperPolicy.sol";
import {IERC721Min} from "../src/interfaces/External.sol";
import {FreezableNFT} from "./utils/Mocks.sol";
import {ReceiptGas} from "./utils/ReceiptGas.sol";

interface IReviewRefund {
    function acquisitionRefundCredit(address) external view returns (uint256);
    function withdrawAcquisitionRefund() external returns (uint256);
    function acquisitionEscrowTotal() external view returns (uint256);
    function deliveryEscrowTotal() external view returns (uint256);
}

/// An untrusted, creator-selected policy, not a replacement for an integrated protocol.
contract ReviewHostilePolicy is IKeeperPolicy {
    uint256 public mode;
    address public target;
    function setMode(uint256 m) external { mode = m; }
    function setTarget(address b) external { target = b; }
    function interfaceVersion() external pure returns (uint256) { return 1; }
    function version() external pure returns (uint256) { return 1; }
    function maxReward() external pure returns (uint256) { return 0.311 ether; }
    function quoteReward(Work calldata w) external view returns (uint256) {
        require(w.baseFee == block.basefee && w.gasPrice == tx.gasprice, "work fee context");
        _attack();
        return type(uint256).max;
    }
    function quoteRestock(uint8, uint256, uint256 baseFee) external view returns (uint256) {
        require(baseFee == block.basefee, "listing fee context");
        _attack();
        return 0;
    }
    function _attack() internal view {
        uint256 m = mode;
        if (m == 1) revert("policy failure");
        if (m == 2) { assembly ("memory-safe") { return(0, 31) } }
        if (m == 3) { while (true) {} }
        if (m == 5) { assembly ("memory-safe") { return(0, 65536) } }
        if (m == 4) {
            (bool ok,) = target.staticcall(abi.encodeCall(PoolBalancer.performUpkeepUnpaid, ()));
            require(!ok, "reentered upkeep");
            (ok,) = target.staticcall(abi.encodeCall(PoolBalancer.close, ()));
            require(!ok, "reentered close");
            (ok,) = target.staticcall(abi.encodeCall(PoolBalancer.claimSurplus, (1, target)));
            require(!ok, "reentered claim");
        }
    }
}

contract ReviewFeeWitness {
    uint256 public basefee;
    uint256 public gasprice;
    function record() external { basefee = block.basefee; gasprice = tx.gasprice; }
}

contract ReviewCreatorKeeper {
    PoolBalancer public immutable balancer;
    bool public callbackReached;
    bool public mutationSucceeded;
    uint256 public basefee;
    uint256 public gasprice;
    constructor(PoolBalancer b) { balancer = b; }
    function accept() external { balancer.acceptCreator(); }
    function configure(uint256 target) external { balancer.configure(1500, target, balancer.SHAPES().mintFee()); }
    function upkeep(bytes32 expected) external returns (uint256) { return balancer.performUpkeep(expected, 1, 0); }
    receive() external payable {
        callbackReached = true;
        basefee = block.basefee;
        gasprice = tx.gasprice;
        (bool a,) = address(balancer).call(abi.encodeCall(PoolBalancer.close, ()));
        (bool b,) = address(balancer).call(abi.encodeCall(PoolBalancer.claimSurplus, (1, address(this))));
        (bool c,) = address(balancer).call(abi.encodeCall(PoolBalancer.performUpkeepUnpaid, ()));
        mutationSucceeded = a || b || c;
    }
}

contract ReviewNoNFTReceiverPurchaser {
    function buy(address p, uint256 value, uint256 version) external payable returns (uint256 request) {
        (bool ok, bytes memory out) = p.call{value: value}(abi.encodeWithSignature(
            "acquireBatch(address,uint256,uint256,uint256,uint256,uint256,uint256)",
            address(this), 1, 0, 0, 10_000, version, block.timestamp + 1
        ));
        require(ok, "purchase failed");
        request = abi.decode(out, (uint256[]))[0];
    }
    function redeem(address p, uint256 id) external {
        (bool ok,) = p.call(abi.encodeWithSignature("redeem(uint256)", id));
        require(ok, "redeem failed");
    }
    receive() external payable {}
}

contract ReserveSecurityReviewTest is ForkBase {
    event ReviewAmount(string label, uint256 amount);
    function setUp() public {
        setUpFork();
        _context(0.5 gwei, 1 gwei);
        assertEq(FWA_IMPL.codehash, FWA_CODEHASH, "reviewed deployed FWA implementation");
        assertEq(shapes.mintFee(), 0.001 ether, "pinned live mint fee");
    }

    function _context(uint256 base, uint256 bid) internal {
        vm.fee(base);
        vm.txGasPrice(bid);
        ReviewFeeWitness w = new ReviewFeeWitness();
        w.record();
        assertEq(w.basefee(), base, "executed basefee");
        assertEq(w.gasprice(), bid, "executed bid");
    }
    function _setup(uint256 small, uint256 large) internal {
        createBalancer(3 ether);
        uint256[9] memory c;
        c[0] = small;
        c[3] = large;
        configure(plan(c));
        listCurated(1, 0.1 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertFalse(balancer.creatorWork());
    }
    function _hostile() internal returns (ReviewHostilePolicy h) {
        h = new ReviewHostilePolicy();
        h.setTarget(address(balancer));
        vm.prank(creator);
        balancer.setKeeperPolicy(address(h));
    }
    function _claimAvailable() internal {
        uint256 n = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(n, creator);
    }

    function test_pendingExpiryRefundSurvivesDisableCloseWithdrawalRetirement() public {
        _context(0.01 gwei, 0.02 gwei);
        _setup(20, 0);
        (uint256 fee, uint256 vrf,) = pool.quoteAcquisitionPrice(1);
        assertEq(vrf, 2_340_000 * 0.02 gwei, "absolute VRF amount");
        uint256[] memory requests = buy(buyer, 1);
        assertEq(IReviewRefund(address(pool)).acquisitionEscrowTotal(), fee);
        uint256 allowance = balancer.availableKeeperAllowance();
        vm.startPrank(creator);
        balancer.close();
        balancer.setPaidUpkeepEnabled(false);
        vm.stopPrank();
        _claimAvailable();
        assertEq(address(balancer).balance, 0, "no unowed creator capital held after disable");
        vm.prank(creator);
        balancer.retire();
        assertEq(IReviewRefund(address(pool)).acquisitionEscrowTotal(), fee, "creator cannot take purchaser escrow");
        vm.roll(vm.getBlockNumber() + ITimeout(address(pool)).selectionTimeoutBlocks() + 1);
        balancer.performUpkeepUnpaid();
        (,,uint256 historicalPrice,, uint8 status,) = pool.acquisitions(requests[0]);
        assertEq(historicalPrice, fee, "FWA retains request-price history");
        assertEq(IReviewRefund(address(pool)).acquisitionEscrowTotal(), 0);
        assertEq(status, 3, "actual expiry reached");
        assertEq(IReviewRefund(address(pool)).acquisitionRefundCredit(buyer), fee);
        uint256 before = buyer.balance;
        vm.prank(buyer);
        IReviewRefund(address(pool)).withdrawAcquisitionRefund();
        assertEq(buyer.balance - before, fee, "full acquisition principal returned");
        assertEq(balancer.availableKeeperAllowance(), allowance, "unpaid path consumes no allowance");
        uint256[] memory all = balancer.getActiveIds();
        uint256[] memory shapesOnly = new uint256[](20);
        for (uint256 i; i < 20; ++i) shapesOnly[i] = all[i + 1];
        vm.prank(creator);
        balancer.unlistShapes(shapesOnly);
        assertEq(address(balancer).balance, 0.2 ether, "exact backing returned after retirement");
        _claimAvailable();
        uint256 curatedId = balancer.getActiveIds()[0];
        vm.prank(creator);
        balancer.withdrawCurated(curatedId, creator);
        assertEq(nft.ownerOf(1), creator);
        assertEq(address(pool).balance, 0, "expiry and recovery leave no FWA value");
        assertEq(address(balancer).balance, 0);
        emit ReviewAmount("expiry refunded principal", fee);
        emit ReviewAmount("expiry one-way VRF fee", vrf);
    }

    function test_failedDeliveryRefundAndNFTRecoverAfterRetirement() public {
        _setup(20, 0);
        FreezableNFT hostile = new FreezableNFT();
        hostile.mint(creator, 2);
        PoolBalancer.CuratedInput[] memory one = new PoolBalancer.CuratedInput[](1);
        one[0] = PoolBalancer.CuratedInput(address(hostile), 2, 0.1 ether);
        vm.startPrank(creator);
        hostile.approve(address(balancer), 2);
        uint256 lid = balancer.listCuratedBatch(one)[0];
        vm.stopPrank();
        hostile.setFrozen(true);
        (uint256 fee,,) = pool.quoteAcquisitionPrice(1);
        uint256 word = wordForSlot(22);
        uint256 request = buy(buyer, 1)[0];
        fulfill(request, word);
        settle();
        upkeep();
        (,,,,,,,uint8 listingStatus) = pool.listings(lid);
        assertEq(listingStatus, 6, "delivery is pending");
        assertEq(IReviewRefund(address(pool)).deliveryEscrowTotal(), fee);
        vm.startPrank(creator);
        balancer.close();
        balancer.setPaidUpkeepEnabled(false);
        balancer.retire();
        vm.stopPrank();
        _claimAvailable();
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidItem.selector);
        balancer.recoverRefunded(lid, creator);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vm.prank(buyer);
        pool.refundFailedDelivery(lid);
        uint256 before = buyer.balance;
        vm.prank(buyer);
        IReviewRefund(address(pool)).withdrawAcquisitionRefund();
        assertEq(buyer.balance - before, fee, "failed delivery principal returned");
        hostile.setFrozen(false);
        vm.prank(creator);
        balancer.recoverRefunded(lid, creator);
        assertEq(hostile.ownerOf(2), creator);
        assertEq(IReviewRefund(address(pool)).deliveryEscrowTotal(), 0);
        emit ReviewAmount("failed delivery returned principal", fee);
    }

    function test_largeWinDepletesOnlyOperatingCapitalAndRecoveryUsesActualBacking() public {
        _setup(20, 1);
        _claimAvailable();
        uint256 beforeFund = address(balancer).balance;
        uint256 word = wordForSlot(22);
        uint256 request = buy(buyer, 1)[0];
        fulfill(request, word);
        settle();
        upkeep();
        uint16[16] memory active = balancer.getActiveShapes();
        assertEq(active[3], 0, "large prize really drawn and not replaced");
        assertEq(active[0], 20);
        assertTrue(balancer.canPurchase(buyer), "safe remaining weight admits purchases");
        assertGt(balancer.requiredReserve(), 0.501 ether, "actual half-ETH replacement shortfall exposed");
        assertLe(balancer.creatorCredit(), address(balancer).balance);
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = balancer.items(ids[i]);
            if (kind != 2) continue;
            (,,, uint256 tokenId,,,,) = pool.listings(ids[i]);
            assertEq(shapes.ownerOf(tokenId), address(pool));
            assertEq(shapes.backingOf(tokenId), 0.01 ether);
        }
        vm.prank(creator);
        balancer.depositETH{value: 0.6 ether}();
        upkeep();
        active = balancer.getActiveShapes();
        assertEq(active[3], 1, "add ETH restores exact large denomination");
        emit ReviewAmount("liquid operating fund after full-board withdrawal", beforeFund);
    }

    function test_malformedBurningAndReenteringPolicyPreserveUnpaidRecovery() public {
        _setup(1, 0);
        ReviewHostilePolicy h = _hostile();
        uint256[9] memory c;
        c[0] = 2;
        configure(plan(c));
        uint256 bal = address(balancer).balance;
        uint256 allowance = balancer.availableKeeperAllowance();
        for (uint256 mode = 1; mode <= 3; ++mode) {
            h.setMode(mode);
            bytes32 expected = balancer.settingsHash();
            vm.prank(keeper);
            vm.expectRevert();
            balancer.performUpkeep{gas: 5_000_000}(expected, 0, 0);
            assertEq(address(balancer).balance, bal, "bad policy rolls back minted backing and pay");
            assertEq(balancer.listedShapePrizes(), 1);
            assertEq(balancer.availableKeeperAllowance(), allowance);
        }
        h.setMode(5);
        bytes32 bombExpected = balancer.settingsHash();
        vm.prank(keeper);
        vm.expectRevert();
        balancer.performUpkeep{gas: 5_000_000}(bombExpected, 0, 0);
        assertEq(address(balancer).balance, bal);
        assertEq(balancer.listedShapePrizes(), 1);
        h.setMode(3);
        balancer.performUpkeepUnpaid{gas: 5_000_000}();
        assertEq(balancer.listedShapePrizes(), 2, "gas-burning policy cannot block public unpaid mint/list");
        assertEq(balancer.availableKeeperAllowance(), allowance);
        assertEq(bal - address(balancer).balance, 0.011 ether, "unpaid path spends exact backing plus live mint fee");
        uint256[] memory ids = balancer.getActiveIds();
        (,,,,uint112 price) = balancer.items(ids[2]);
        assertEq(price, 0.0125 ether + 0.000695 ether, "immutable recovery surcharge used");
        h.setMode(4);
        c[0] = 3;
        configure(plan(c));
        upkeep();
        assertEq(balancer.listedShapePrizes(), 3, "static policy callbacks cannot mutate guarded state");
        assertTrue(balancer.enabled());
    }

    function test_atomicKeeperFloorRollsBackRealMintListingBalancesAndAllowance() public {
        _setup(1, 0);
        _hostile();
        uint256[9] memory c;
        c[0] = 2;
        configure(plan(c));
        bytes32 expected = balancer.settingsHash();
        uint256 bal = address(balancer).balance;
        uint256 allowance = balancer.availableKeeperAllowance();
        uint256 poolCount = pool.activeListingCount();
        vm.prank(keeper);
        vm.expectRevert(PoolBalancer.MinimumPaymentNotMet.selector);
        balancer.performUpkeep(expected, 0.311 ether, 0);
        assertEq(address(balancer).balance, bal);
        assertEq(pool.activeListingCount(), poolCount);
        assertEq(balancer.listedShapePrizes(), 1);
        assertEq(balancer.availableKeeperAllowance(), allowance);
        vm.prank(keeper);
        uint256 reward = balancer.performUpkeep(expected, 1, 0);
        uint256 receipt = ReceiptGas.lastBilled();
        assertGt(reward, 0);
        assertLe(reward, 1_150_000 * 0.6 gwei + 0.00005 ether, "one-shape immutable work envelope");
        assertEq(bal - address(balancer).balance, 0.011 ether + reward);
        emit ReviewAmount("one shape max policy actual payout", reward);
        emit ReviewAmount("one shape billed gas", receipt);
    }

    /// Spec §5: closing, reconfiguring, switching policy and toggling paid upkeep never refill a spent allowance; only
    /// elapsed time does. Replaces the former matured-proposal/emergency-cancel case (proposals no longer exist).
    function test_noAllowanceResetByCloseConfigurePolicyOrPaidToggle() public {
        _setup(1, 0);
        ReviewHostilePolicy h = _hostile();
        uint256[9] memory c;
        c[0] = 2;
        configure(plan(c));
        upkeep();
        uint256 used = balancer.availableKeeperAllowance();
        assertLt(used, balancer.keeperBucketCapacity());
        vm.startPrank(creator);
        balancer.close();
        balancer.configure(2000, plan(c), shapes.mintFee());
        balancer.open();
        vm.stopPrank();
        assertEq(balancer.availableKeeperAllowance(), used);
        c[0] = 3;
        configure(plan(c));
        upkeep();
        uint256 beforeSwitch = balancer.availableKeeperAllowance();
        assertLt(beforeSwitch, balancer.keeperBucketCapacity());
        vm.prank(creator);
        balancer.setKeeperPolicy(address(h));
        assertEq(balancer.availableKeeperAllowance(), beforeSwitch, "a switch cannot refill recently spent allowance");
        c[0] = 4;
        configure(plan(c));
        upkeep();
        uint256 spent = balancer.availableKeeperAllowance();
        vm.prank(creator);
        balancer.setPaidUpkeepEnabled(false);
        assertFalse(balancer.paidUpkeepEnabled());
        assertEq(balancer.availableKeeperAllowance(), spent);
        vm.prank(creator);
        balancer.setPaidUpkeepEnabled(true);
        assertTrue(balancer.paidUpkeepEnabled());
        assertEq(balancer.availableKeeperAllowance(), spent, "re-enabling cannot refill");
        vm.warp(vm.getBlockTimestamp() + 2 days);
        assertEq(balancer.availableKeeperAllowance(), balancer.keeperBucketCapacity(), "only elapsed time replenishes");
    }

    function test_keeperPayoutCallbackCannotCloseClaimOrRunUnpaidEvenAsCreator() public {
        _setup(1, 0);
        _hostile();
        ReviewCreatorKeeper receiver = new ReviewCreatorKeeper(balancer);
        vm.prank(creator);
        balancer.transferCreator(address(receiver));
        receiver.accept();
        uint256[9] memory c;
        c[0] = 2;
        receiver.configure(plan(c));
        uint256 before = address(receiver).balance;
        uint256 paid = receiver.upkeep(balancer.settingsHash());
        assertTrue(receiver.callbackReached(), "real payout callback ran");
        assertFalse(receiver.mutationSucceeded());
        assertTrue(balancer.enabled());
        assertEq(address(receiver).balance - before, paid);
        assertEq(receiver.basefee(), 0.5 gwei);
        assertEq(receiver.gasprice(), 1 gwei);
        assertEq(balancer.listedShapePrizes(), 2);
    }

    function test_policyFundingExcludesRealCreditAndSwitchKeepsOldPrices() public {
        _context(0.5 gwei, 0.55 gwei);
        _setup(20, 0);
        vm.prank(creator); balancer.setCreatorRevenueBps(10_000);
        vm.prank(creator); balancer.setPaidUpkeepEnabled(false);
        uint256 free = balancer.withdrawableSurplus();
        vm.prank(creator); balancer.claimSurplus(free, creator);
        assertEq(address(balancer).balance, 0);
        uint256 request = buy(buyer, 1)[0];
        fulfill(request, wordForSlot(2));
        settle();
        balancer.collectProceeds();
        uint256 credit = balancer.creatorCredit();
        assertEq(address(balancer).balance, credit);
        ReviewHostilePolicy h = new ReviewHostilePolicy();
        (uint256 required, uint256 shortfall) = balancer.policyFunding(address(h));
        assertEq(shortfall, required);
        assertGe(credit, required, "total cash covers maintenance, but none of it is operating cash");
        uint256[] memory beforeIds = balancer.getActiveIds();
        uint112[] memory oldPrices = new uint112[](beforeIds.length);
        for (uint256 i; i < beforeIds.length; ++i) (,,,,oldPrices[i]) = balancer.items(beforeIds[i]);
        vm.prank(creator); vm.expectRevert(PoolBalancer.ReserveNotFunded.selector); balancer.setKeeperPolicy(address(h));
        assertEq(balancer.creatorCredit(), credit);
        vm.prank(creator); balancer.depositETH{value: shortfall}();
        vm.prank(creator); balancer.setKeeperPolicy(address(h));
        assertEq(balancer.creatorCredit(), credit);
        for (uint256 i; i < beforeIds.length; ++i) {
            (,,,,uint112 nowPrice) = balancer.items(beforeIds[i]);
            assertEq(nowPrice, oldPrices[i], "old listing prices fixed across policy adoption");
        }
    }

    function test_expiredDrawCheapWorkCapProtectsRefundPrincipalAndPaysAtLowGas() public {
        _context(0.01 gwei, 0.02 gwei);
        _setup(20, 0);
        _hostile();
        uint256 request = buy(buyer, 1)[0];
        (, ,uint256 principal,,,) = pool.acquisitions(request);
        vm.roll(vm.getBlockNumber() + 31);
        uint256 before = address(balancer).balance;
        bytes32 expected = balancer.settingsHash();
        vm.prank(keeper);
        uint256 reward = balancer.performUpkeep(expected, 1, 0);
        uint256 billed = ReceiptGas.lastBilled();
        assertLe(reward, 2_250_000 * 0.02 gwei + 0.00005 ether, "cheap expiry cap uses one actual process and reconcile");
        assertLt(reward, 0.0001 ether, "max-declared policy cannot draw theoretical heavy-call maximum");
        assertGt(reward, 0.00005 ether, "nonzero low-gas attack surface reached");
        assertEq(before - address(balancer).balance, reward);
        assertEq(IReviewRefund(address(pool)).acquisitionRefundCredit(buyer), principal);
        assertEq(pool.ownerProceeds(), 0, "expired draw generated no owner income");
        emit ReviewAmount("low-gas expiry maximum policy payout", reward);
        emit ReviewAmount("low-gas expiry keeper billed gas", billed);
    }

    function test_contractPurchaserCannotRejectFwaPackTransferAndRetainsExactBacking() public {
        _setup(20, 0);
        uint256[16] memory c;
        c[0] = 20;
        c[9] = 1;
        configure(plan16(c));
        upkeep();
        uint256 lid = lastListingId();
        (address collection,,,uint256 tokenId,,,,) = pool.listings(lid);
        assertEq(collection, packs);
        assertEq(IERC721Min(packs).ownerOf(tokenId), address(pool));
        ReviewNoNFTReceiverPurchaser actor = new ReviewNoNFTReceiverPurchaser();
        (,, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 version = pool.inventoryVersion();
        uint256 word = wordForSlot(22);
        vm.prank(buyer, buyer);
        uint256 request = actor.buy{value: total}(address(pool), total, version);
        fulfill(request, word);
        settle();
        upkeep();
        (,,,,,,,uint8 status) = pool.listings(lid);
        assertEq(status, 4, "FWA uses transferFrom, so missing receiver callback cannot reject");
        assertEq(IReviewRefund(address(pool)).deliveryEscrowTotal(), 0);
        assertEq(IERC721Min(packs).ownerOf(tokenId), address(actor), "actual purchaser owns pack");
        vm.startPrank(creator);
        balancer.close();
        balancer.setPaidUpkeepEnabled(false);
        balancer.retire();
        vm.stopPrank();
        _claimAvailable();
        assertEq(address(balancer).balance, 0);
        actor.redeem(packs, tokenId);
        assertEq(address(actor).balance, 0.02 ether, "purchaser redeems exact backing after retirement");
        assertEq(address(balancer).balance, 0);
        assertEq(IReviewRefund(address(pool)).deliveryEscrowTotal(), 0);
        emit ReviewAmount("won pack backing redeemed by purchaser", address(actor).balance);
    }

    function test_paidAndUnpaidCannotSpendBookedCredit() public {
        _setup(20, 0);
        uint256[9] memory c;
        c[0] = 20;
        // Reprice one real relisting with high markup, then collect that board's actual sale.
        vm.startPrank(creator);
        balancer.configure(10_000, plan(c), shapes.mintFee());
        vm.stopPrank();
        uint256[] memory one = new uint256[](1);
        one[0] = balancer.getActiveIds()[1];
        vm.prank(creator);
        balancer.unlistShapes(one);
        upkeep();
        uint256 request = buy(buyer, 1)[0];
        fulfill(request, wordForSlot(2));
        settle();
        upkeep();
        uint256 booked = balancer.creatorCredit();
        assertGt(booked, 0);
        // Consume operating cash only through real one-ETH prize minting.
        c[4] = 2;
        configure(plan(c));
        upkeep();
        c[4] = 3;
        configure(plan(c));
        uint256 desired = 1.001 ether + booked / 2;
        assertGt(desired, address(balancer).balance);
        vm.prank(creator);
        balancer.depositETH{value: desired - address(balancer).balance}();
        bytes32 expected = balancer.settingsHash();
        vm.prank(keeper);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep(expected, 0, 0);
        assertEq(balancer.creatorCredit(), booked, "paid mint cannot invade booked profit");
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeepUnpaid();
        assertEq(balancer.getActiveShapes()[4], 2);
        assertEq(address(balancer).balance, desired);
        assertEq(balancer.creatorCredit(), booked, "public unpaid path preserves the same protected credit");
    }
}
