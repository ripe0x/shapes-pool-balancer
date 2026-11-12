// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {
    MockNFT, FreezableNFT, ReentrantNFT, LyingNFT, RejectingKeeper, GasBurnNFT
} from "./utils/Mocks.sol";
import {Vm} from "forge-std/Test.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {LibString} from "solady/utils/LibString.sol";

interface IShapesAdmin {
    function setMintFee(uint256) external;
}

interface IENSRegistry {
    function setSubnodeOwner(bytes32 node, bytes32 label, address owner) external returns (bytes32);
    function setResolver(bytes32 node, address resolver) external;
    function resolver(bytes32 node) external view returns (address);
    function owner(bytes32 node) external view returns (address);
}

interface IResolver {
    function setAddr(bytes32 node, address a) external;
    function addr(bytes32 node) external view returns (address);
    function name(bytes32 node) external view returns (string memory);
}

/// @notice Behavior, permission and adversarial tests on a mainnet fork (real FWA + Shapes).
contract BalancerTest is ForkBase {
    // The live Shapes admin that may change the mint fee (one unit, 0.01 ETH max).
    address internal constant SHAPES_ADMIN = 0xCB43078C32423F5348Cab5885911C3B5faE217F9;

    uint256 curatedA;
    uint256 curatedB;
    uint256 planA = plan([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0]); // 0.4 ETH backing

    function setUp() public {
        setUpFork();
        createBalancer(5 ether);
        configure(planA); // MARKUP; curated listed afterwards share it
        curatedA = listCurated(1, 0.3 ether);
        curatedB = listCurated(2, 0.5 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertTrue(balancer.canPurchase(buyer));
    }

    /*////////////////////////////// factory //////////////////////////////*/

    function test_factory_isolatedBalancersAndPools() public {
        address other = makeAddr("other");
        vm.prank(other);
        PoolBalancer b2 = PoolBalancer(payable(factory.createBalancer(bytes32(uint256(7)))));
        assertEq(address(b2), factory.predictBalancer(other, bytes32(uint256(7))));
        assertTrue(address(b2.pool()) != address(pool));
        assertEq(b2.pool().owner(), address(b2));
        assertEq(b2.creator(), other);
        assertEq(factory.balancerCount(), 2);
        vm.prank(creator);
        PoolBalancer b3 = PoolBalancer(payable(factory.createBalancer(bytes32(uint256(1)))));
        assertEq(b3.pool().owner(), address(b3));
        vm.expectRevert(PoolBalancer.AlreadyInitialized.selector);
        b2.initialize(stranger);
        PoolBalancer impl = PoolBalancer(payable(factory.implementation()));
        vm.expectRevert(PoolBalancer.AlreadyInitialized.selector);
        impl.initialize(stranger);
    }

    /*////////////////////////////// permissions //////////////////////////////*/

    function test_onlyCreator() public {
        PoolBalancer.CuratedInput[] memory batch = new PoolBalancer.CuratedInput[](1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = curatedA;
        address[2] memory callers = [stranger, keeper];
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.configure(1500, planA);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.open();
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.close();
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.listCurated(address(nft), 1, 1);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.listCuratedBatch(batch);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.updateCuratedPrice(curatedA, 1);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.withdrawCurated(curatedA, callers[i]);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.recoverRefunded(curatedA, callers[i]);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.recoverUntrackedNFT(address(nft), 1, callers[i]);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.claimSurplus(1, callers[i]);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.unlistShapes(ids);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.retire();
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.setENSName("x");
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.transferCreator(callers[i]);
            vm.stopPrank();
        }
    }

    function test_creatorTransferTwoStep() public {
        address next = makeAddr("next");
        vm.prank(creator);
        balancer.transferCreator(next);
        assertEq(balancer.creator(), creator);
        vm.prank(stranger);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.acceptCreator();
        vm.prank(next);
        balancer.acceptCreator();
        assertEq(balancer.creator(), next);
        assertEq(balancer.pendingCreator(), address(0));
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.close();
        vm.prank(next);
        balancer.close();
    }

    /*////////////////////////////// curated //////////////////////////////*/

    function test_curatedBatchRepriceWithdraw() public {
        PoolBalancer.CuratedInput[] memory batch = new PoolBalancer.CuratedInput[](2);
        for (uint256 i; i < 2; ++i) {
            nft.mint(creator, 100 + i);
            batch[i] = PoolBalancer.CuratedInput(address(nft), 100 + i, 0.2 ether);
        }
        vm.startPrank(creator);
        nft.setApprovalForAll(address(balancer), true);
        uint256[] memory lids = balancer.listCuratedBatch(batch);
        vm.stopPrank();
        assertTrue(balancer.canPurchase(buyer), "listing a curated NFT does not close the pool");
        (,,, uint112 base, uint112 price) = balancer.items(lids[0]);
        assertEq(base, 0.2 ether);
        assertEq(price, 0.23 ether, "listed at base * (1 + markup)");
        (,,,,, uint256 fwaPrice,,) = pool.listings(lids[0]);
        assertEq(fwaPrice, 0.23 ether);

        vm.prank(creator);
        balancer.updateCuratedPrice(lids[0], 0.4 ether);
        (,,,,, fwaPrice,,) = pool.listings(lids[0]);
        assertEq(fwaPrice, 0.46 ether, "repriced at the current markup");

        vm.prank(creator);
        balancer.withdrawCurated(lids[1], creator);
        assertEq(nft.ownerOf(101), creator);
        (uint8 kind,,,,) = balancer.items(lids[1]);
        assertEq(kind, 0);
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidItem.selector);
        balancer.withdrawCurated(lids[1], creator);
        assertTrue(balancer.canPurchase(buyer));
    }

    function test_rejectsShapesAndLyingCollections() public {
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.ShapesNotCurated.selector);
        balancer.listCurated(SHAPES, 1, 1 ether);

        LyingNFT liar = new LyingNFT();
        liar.mint(creator, 1);
        vm.startPrank(creator);
        liar.approve(address(balancer), 1);
        vm.expectRevert(PoolBalancer.InvalidItem.selector);
        balancer.listCurated(address(liar), 1, 1 ether);
        vm.stopPrank();
    }

    /// Listing stages while a draw is unsettled; FWA locks withdraw/updatePrice until settlement; upkeep never
    /// reverts PoolBusy (that pre-check is gone), and overlapping purchases are allowed.
    function test_curatedOpsAndUnsettledDraws() public {
        uint256 last = _lastShape();
        (,,,,,, uint256 slot,) = pool.listings(last);
        uint256[] memory ids = buy(buyer, 1);

        // listing stages while a draw is unsettled
        nft.mint(creator, 50);
        vm.startPrank(creator);
        nft.approve(address(balancer), 50);
        uint256 staged = balancer.listCurated(address(nft), 50, 1 ether);
        // withdraw / updatePrice are locked by FWA while a draw is unsettled
        vm.expectRevert();
        balancer.withdrawCurated(curatedA, creator);
        vm.expectRevert();
        balancer.updateCuratedPrice(curatedA, 1 ether);
        vm.stopPrank();
        assertTrue(staged != 0);
        // upkeep does not revert PoolBusy: nothing settled yet
        vm.prank(keeper);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep();

        fulfill(ids[0], wordForSlot(slot));
        settle();
        // after settlement FWA releases the lock, even before our reconciliation
        vm.prank(creator);
        balancer.withdrawCurated(curatedB, creator);
        assertEq(nft.ownerOf(2), creator);
    }

    /*////////////////////////////// delivery failure //////////////////////////////*/

    function test_failedCuratedDeliveryRefundAndRecovery() public {
        FreezableNFT frozen = new FreezableNFT();
        frozen.mint(creator, 9);
        vm.startPrank(creator);
        frozen.approve(address(balancer), 9);
        uint256 lid = balancer.listCurated(address(frozen), 9, 0.3 ether);
        vm.stopPrank();
        frozen.setFrozen(true);

        (,,,,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        (,,,,,,, uint8 status) = pool.listings(lid);
        assertEq(status, 6, "FWA DeliveryPending");

        upkeep(); // reconciles the draw; NFT is out of the active set
        (,, uint8 state,,) = balancer.items(lid);
        assertEq(state, 2, "PENDING");
        assertTrue(balancer.canPurchase(buyer), "pool continues with remaining curated");

        // creator cannot recover before the purchaser's refund
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidItem.selector);
        balancer.recoverRefunded(lid, creator);

        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(buyer);
        pool.refundFailedDelivery(lid);
        frozen.setFrozen(false);

        vm.prank(keeper);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep();
        vm.prank(creator);
        balancer.recoverRefunded(lid, creator);
        assertEq(frozen.ownerOf(9), creator);
        (uint8 kind,,,,) = balancer.items(lid);
        assertEq(kind, 0, "forgotten after recovery");
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidItem.selector);
        balancer.recoverRefunded(lid, creator);
    }

    /// A Shape whose delivery failed and was refunded is recovered by the creator and redeemed for its backing.
    function test_refundedShapeRecoveredAndRedeemed() public {
        uint256 lid = _lastShape();
        (,,, uint256 tokenId,,,,) = pool.listings(lid);
        (,,,,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        vm.mockCallRevert(SHAPES, abi.encodeWithSignature("transferFrom(address,address,uint256)", address(pool), buyer, tokenId), "blocked");
        fulfill(ids[0], wordForSlot(slot));
        settle();
        vm.clearMockedCalls();
        (,,,,,,, uint8 status) = pool.listings(lid);
        assertEq(status, 6, "FWA DeliveryPending");
        upkeep(); // reconciles and replaces the drawn Shape
        assertTrue(balancer.canPurchase(buyer));

        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidItem.selector); // not refunded yet
        balancer.recoverRefunded(lid, creator);

        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(buyer);
        pool.refundFailedDelivery(lid);
        uint256 balBefore = address(balancer).balance;
        vm.prank(creator);
        uint256 eth = balancer.recoverRefunded(lid, creator);
        assertEq(eth, 0.1 ether, "redeemed at exact backing");
        assertEq(address(balancer).balance - balBefore, 0.1 ether, "redeemed into the balancer");
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidItem.selector); // single use
        balancer.recoverRefunded(lid, creator);
        assertTrue(balancer.canPurchase(buyer), "admission unaffected");
    }

    /*////////////////////////////// keeper //////////////////////////////*/

    function _lastShape() internal view returns (uint256 last) {
        uint256[] memory active = balancer.getActiveIds();
        for (uint256 i; i < active.length; ++i) {
            (uint8 kind,,,,) = balancer.items(active[i]);
            if (kind == 2 && active[i] > last) last = active[i];
        }
    }

    function _drawOneShape() internal {
        uint256 last = _lastShape();
        (,,,,,, uint256 slot, uint8 st) = pool.listings(last);
        require(st == 1, "not active");
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
    }

    function _paidUpkeep(address who) internal returns (uint256 reward, uint256 gasPaid) {
        vm.recordLogs();
        vm.prank(who, who);
        balancer.performUpkeep();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("KeeperPaid(address,uint256,uint256)")) {
                (reward, gasPaid) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
    }

    /// ApeBall (collection-games#23): the reimbursed price is basefee + 0.05 gwei whatever the bid.
    function test_priorityOverbidIsNotReimbursed() public {
        _drawOneShape();
        vm.fee(0.15 gwei);
        vm.txGasPrice(3 gwei);
        (uint256 reward, uint256 gasPaid) = _paidUpkeep(stranger);
        // gas part reimbursed at basefee + 0.05 gwei; incentive capped by the draw's edge credit
        assertGe(reward, gasPaid * 0.2 gwei, "gas reimbursed at basefee + 0.05 gwei");
        assertLe(reward, (gasPaid + gasPaid / 4) * 0.2 gwei + 0.0005 ether + 2 * 0.2 gwei);

        _drawOneShape();
        vm.txGasPrice(0.17 gwei);
        (reward, gasPaid) = _paidUpkeep(keeper);
        assertGe(reward, gasPaid * 0.17 gwei);
        assertLe(reward, (gasPaid + gasPaid / 4) * 0.17 gwei + 0.0005 ether + 2 * 0.17 gwei);

        _drawOneShape();
        vm.txGasPrice(5_000 gwei);
        (reward, gasPaid) = _paidUpkeep(stranger);
        assertLe(reward, (gasPaid + gasPaid / 4) * 0.2 gwei + 0.0005 ether + 2 * 0.2 gwei, "absurd bid capped");
    }

    function test_basefeeSpikeCappedAtMaxGasPrice() public {
        // Creator work (one more 0.01 Shape in the target) is paid in full, so the price cap is what bounds it.
        configure(planA + 1);
        vm.fee(80 gwei);
        vm.txGasPrice(80 gwei);
        (uint256 reward, uint256 gasPaid) = _paidUpkeep(keeper);
        assertGe(reward, gasPaid * 5 gwei, "refund-safe gas at the capped price");
        assertLe(reward, (gasPaid + gasPaid / 4 + 1) * 5 gwei + 0.0005 ether, "never above measured gas x cap + incentive");
        assertLe(reward, balancer.MAX_KEEPER_REWARD());
    }

    function test_gateRefusesUnrefundablePurchasers() public {
        assertTrue(balancer.canPurchase(buyer));
        assertFalse(balancer.canPurchase(address(balancer)), "Balancer");
        assertFalse(balancer.canPurchase(SHAPES), "Shapes rejects self-custody");
        assertFalse(balancer.canPurchase(packs), "Packs rejects self-custody");
        assertFalse(balancer.canPurchase(address(pool)), "pool");
        (,, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 v = pool.inventoryVersion();
        address[3] memory bad = [address(balancer), SHAPES, address(pool)];
        for (uint256 i; i < 3; ++i) {
            vm.prank(buyer, buyer);
            vm.expectRevert();
            pool.acquireBatch{value: total}(bad[i], 1, 0, 0, 10_000, v, block.timestamp + 1);
        }
        assertTrue(balancer.canPurchase(buyer), "admission unaffected");
    }

    function test_noRewardForUnnecessaryWork() public {
        vm.prank(keeper);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep();

        // re-configuring the same target leaves no work
        configure(planA);
        vm.prank(keeper);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep();
        assertTrue(balancer.canPurchase(buyer));

        // a second keeper racing the same work finds nothing left
        _drawOneShape();
        upkeep();
        vm.prank(stranger);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep();
    }

    /// A refunded draw earns no markup, so reconciling it pays nothing from an empty credit.
    /// The keeper list: open by default; when restricted only the creator and approved keepers may run upkeep, under
    /// the same reward rules; the creator can always restock their own pool, and a new creator takes that role.
    function test_keeperListIsCreatorControlledAndOpenByDefault() public {
        assertFalse(balancer.keepersRestricted(), "open by default");
        vm.startPrank(stranger);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.setKeepersRestricted(true);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.setKeeperApproved(stranger, true);
        vm.stopPrank();

        _drawOneShape();
        vm.prank(creator);
        balancer.setKeepersRestricted(true);
        vm.prank(stranger, stranger);
        vm.expectRevert(PoolBalancer.KeeperNotApproved.selector);
        balancer.performUpkeep();
        vm.prank(creator);
        balancer.setKeeperApproved(keeper, true);
        (uint256 reward,) = _paidUpkeep(keeper);
        assertGt(reward, 0, "an approved keeper is paid as usual");

        _drawOneShape();
        vm.prank(creator);
        balancer.setKeeperApproved(keeper, false);
        vm.prank(keeper, keeper);
        vm.expectRevert(PoolBalancer.KeeperNotApproved.selector);
        balancer.performUpkeep();
        vm.prank(creator, creator);
        balancer.performUpkeep(); // the creator always can

        _drawOneShape();
        vm.prank(creator);
        balancer.transferCreator(stranger);
        vm.prank(stranger);
        balancer.acceptCreator();
        vm.prank(creator, creator);
        vm.expectRevert(PoolBalancer.KeeperNotApproved.selector);
        balancer.performUpkeep(); // the former creator is just another caller
        vm.prank(stranger, stranger);
        balancer.performUpkeep();

        _drawOneShape();
        vm.prank(stranger);
        balancer.setKeepersRestricted(false);
        vm.prank(keeper, keeper);
        balancer.performUpkeep(); // open again: anyone
    }

    function test_refundOnlyBatchEarnsNothing() public {
        assertEq(balancer.keeperCredit(), 0);
        buy(buyer, 1);
        vm.roll(block.number + 40); // word deadline passes
        pool.processAcquisitions(1);
        uint256 before = keeper.balance;
        upkeep();
        assertEq(keeper.balance - before, 0, "nothing earned, nothing paid");
        assertTrue(balancer.canPurchase(buyer));
    }

    function test_rejectingKeeperIsStillPaidAndCannotBlock() public {
        _drawOneShape();
        RejectingKeeper rk = new RejectingKeeper();
        rk.upkeep(address(balancer));
        assertGt(address(rk).balance, 0, "reward force-sent");
        assertTrue(balancer.canPurchase(buyer));
    }

    function test_claimToRejectingRecipientReverts() public {
        RejectingKeeper rk = new RejectingKeeper();
        uint256 s = balancer.withdrawableSurplus();
        vm.prank(creator);
        vm.expectRevert();
        balancer.claimSurplus(s, address(rk));
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidRecipient.selector);
        balancer.claimSurplus(s, address(0));
    }

    /*////////////////////////////// reentrancy //////////////////////////////*/

    function test_reentrantCollectionCannotReenter() public {
        ReentrantNFT evil = new ReentrantNFT();
        evil.setTarget(address(balancer));
        evil.mint(creator, 1);
        vm.startPrank(creator);
        evil.approve(address(balancer), 1);
        uint256 lid = balancer.listCurated(address(evil), 1, 0.3 ether);
        vm.stopPrank();
        assertFalse(evil.reentered(), "listing transfer could not re-enter");
        (,,,,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        assertEq(evil.ownerOf(1), buyer);
        upkeep();
        assertTrue(balancer.canPurchase(buyer));
    }

    /*////////////////////////////// mint fee //////////////////////////////*/

    /// Raising the fee closes the gate and stops restocking; re-configure accepts it; a fee drop keeps it open.
    function test_realMintFeeChange() public {
        _drawOneShape(); // create a deficit so restocking would run if the fee allowed it
        vm.prank(SHAPES_ADMIN);
        IShapesAdmin(SHAPES).setMintFee(0.005 ether);
        assertEq(balancer.admissionStatus(), 5, "MINT_FEE_ROSE");
        // upkeep reconciles the draw but does not restock above the accepted fee
        upkeep();
        assertEq(balancer.admissionStatus(), 5, "still closed, not restocked");
        uint16[16] memory have = balancer.getActiveShapes();
        assertEq(have[2], 1, "the drawn 0.1 Shape was not replaced");

        // Re-configuring accepts the new fee; prices pass it through to players, so any markup works
        vm.prank(creator);
        balancer.configure(MARKUP, planA);
        fillUp();
        assertTrue(balancer.canPurchase(buyer));
        uint256[] memory ids = balancer.getActiveIds();
        (,,, uint112 base, uint112 price) = balancer.items(ids[ids.length - 1]);
        assertEq(base, 0.1 ether + 0.005 ether + 0.1 ether * uint256(MARKUP) / 10_000, "the new fee is in the price");
        assertEq(price, base + balancer.restockFee(), "plus one restocking fee");

        // a fee drop keeps the gate open even after the creator claims all surplus (old liveness bug)
        uint256 s = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(s, creator);
        vm.prank(SHAPES_ADMIN);
        IShapesAdmin(SHAPES).setMintFee(0);
        assertTrue(balancer.canPurchase(buyer), "a fee drop never closes the pool");
    }

    /*////////////////////////////// reserve //////////////////////////////*/

    /// Exact reserve while open and fully reconciled: the largest prize (0.1 Shape) for the implied draw plus a
    /// spare, and the keeper rewards for 3 Shape units (ceil(3/6)+1 = 2 calls).
    function test_reserveMath() public view {
        uint256 fee = shapes.mintFee();
        uint256 largest = 0.1 ether + fee;
        uint256 expected = largest + 2 * balancer.MAX_KEEPER_REWARD();
        assertEq(balancer.requiredReserve(), expected);
        assertEq(balancer.withdrawableSurplus(), address(balancer).balance - expected);
    }

    function test_claimSurplusRespectsReserveWhileOpen() public {
        uint256 s = balancer.withdrawableSurplus();
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InsufficientSurplus.selector);
        balancer.claimSurplus(s + 1, creator);
        vm.prank(creator);
        balancer.claimSurplus(s, creator);
        assertTrue(balancer.canPurchase(buyer));
        // after a draw the reserve rises (an unreconciled draw assumed to take a largest prize), so surplus is 0
        _drawOneShape();
        assertEq(balancer.withdrawableSurplus(), 0);
        // and a creator claiming everything beforehand still leaves enough to restock the drawn prize
        upkeep();
        uint16[16] memory have = balancer.getActiveShapes();
        assertEq(have[0], 5);
        assertEq(have[1], 3);
        assertEq(have[2], 2, "drawn prize restocked from the held reserve");
    }

    /// claimSurplus no longer requires the pool to be idle, but cannot drop below the (raised) reserve.
    function test_claimDuringUnsettledDraw() public {
        _drawOneShape();
        balancer.collectProceeds(); // pull the draw's proceeds first so the claim is exact
        uint256 s = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(s, creator); // allowed while a draw is pending
        assertEq(balancer.withdrawableSurplus(), 0);
        assertGe(address(balancer).balance, balancer.requiredReserve());
    }

    /*////////////////////////////// markup / target //////////////////////////////*/

    /// Markup applies at listing time: existing listings keep their price, restocked prizes use the new markup.
    function test_markupAppliesAtListingOnly() public {
        // curatedA was listed at MARKUP (1500)
        (,,, uint112 baseA, uint112 priceA) = balancer.items(curatedA);
        assertEq(priceA, uint256(baseA) * (10_000 + uint256(MARKUP)) / 10_000);
        // a listed 0.05 Shape is priced at its backing, mint fee and MARKUP, plus one restocking fee
        uint256 fee = shapes.mintFee();
        uint256 shape = _shapeOfDenom(1);
        (,,, uint112 shapeBase, uint112 shapePrice) = balancer.items(shape);
        assertEq(shapeBase, 0.05 ether + fee + 0.05 ether * uint256(MARKUP) / 10_000);
        assertEq(shapePrice, shapeBase + balancer.restockFee());

        // change the markup; existing listings are untouched
        vm.prank(creator);
        balancer.configure(3000, planA);
        (,,,, uint112 priceAfter) = balancer.items(curatedA);
        assertEq(priceAfter, priceA, "existing curated price unchanged by a markup change");
        (,,,, uint112 shapeAfter) = balancer.items(shape);
        assertEq(shapeAfter, shapePrice, "existing Shape price unchanged");

        // draw that 0.05 Shape; the replacement is listed at the new 3000 markup
        (,,,,,, uint256 slot,) = pool.listings(shape);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        fillUp();
        uint256 fresh = _freshShapeOfDenom(1); // the restocked one has the newest listing id
        (,,,, uint112 freshPrice) = balancer.items(fresh);
        assertEq(freshPrice, 0.05 ether + fee + 0.05 ether * 3000 / 10_000 + balancer.restockFee(), "restocked prize at the new markup");
    }

    function _shapeOfDenom(uint8 d) internal view returns (uint256) {
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 dd,,,) = balancer.items(ids[i]);
            if (kind == 2 && dd == d) return ids[i];
        }
        revert("no shape of that denom");
    }

    function _freshShapeOfDenom(uint8 d) internal view returns (uint256 best) {
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 dd,,,) = balancer.items(ids[i]);
            if (kind == 2 && dd == d && ids[i] > best) best = ids[i];
        }
        require(best != 0, "no shape of that denom");
    }

    /// LOW_INVENTORY: delayed reconciliation closes the gate before the NFT odds can move far. Asserts the gate
    /// math (listed weight, less the heaviest-prize allowance per unreconciled draw, below FILL_BPS of target).
    function test_lowInventoryGate() public {
        // a 0.01 target sized so LOW_INVENTORY trips at the 4th unsettled draw, before BUSY at 5
        configure(plan([uint256(12), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        uint256 target = balancer.targetWeight();
        uint256 MAX_PRIZE_WEIGHT = 1e36 / 0.01 ether;
        uint256 k;
        while (balancer.canPurchase(buyer)) {
            buy(buyer, 1);
            ++k;
            require(k < 6, "should close before BUSY");
        }
        // the gate closed for LOW_INVENTORY, not BUSY, and the math holds
        assertEq(balancer.admissionStatus(), 6, "LOW_INVENTORY");
        uint256 lost = (pool.lastIssuedSequence() - balancer.reconciledSequence()) * MAX_PRIZE_WEIGHT;
        uint256 w = balancer.prizeWeight();
        assertTrue(w < lost || (w - lost) * 10_000 < 7_000 * target, "gate condition true");
        // one fewer unsettled draw would still have admitted
        uint256 lostPrev = (pool.lastIssuedSequence() - 1 - balancer.reconciledSequence()) * MAX_PRIZE_WEIGHT;
        assertTrue(w >= lostPrev && (w - lostPrev) * 10_000 >= 7_000 * target, "one draw earlier was admitted");
    }

    function test_configureRejectsBadTargets() public {
        vm.startPrank(creator);
        vm.expectRevert(PoolBalancer.InvalidPlan.selector);
        balancer.configure(1500, 0); // empty
        vm.expectRevert(PoolBalancer.InvalidPlan.selector);
        balancer.configure(1500, plan([uint256(81), 0, 0, 0, 0, 0, 0, 0, 0])); // > 80 Shapes
        vm.expectRevert(PoolBalancer.InvalidPlan.selector);
        balancer.configure(1500, planA | (uint256(1) << 256 - 1)); // stray high bits above 16 counts
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        balancer.configure(10_001, planA); // markup too high
        vm.stopPrank();
    }

    /*////////////////////////////// ENS //////////////////////////////*/

    function test_ensReverseAndForward() public {
        address ensRoot = IENSRegistry(ENS).owner(bytes32(0));
        address publicResolver = 0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63;
        bytes32 label = keccak256("balancertest");
        bytes32 node = keccak256(abi.encodePacked(bytes32(0), label));
        vm.prank(ensRoot);
        IENSRegistry(ENS).setSubnodeOwner(bytes32(0), label, creator);
        vm.startPrank(creator);
        IENSRegistry(ENS).setResolver(node, publicResolver);
        IResolver(publicResolver).setAddr(node, address(balancer));
        balancer.setENSName("balancertest");
        vm.stopPrank();

        bytes32 reverseNode = keccak256(
            abi.encodePacked(
                bytes32(0x91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2),
                keccak256(bytes(LibString.toHexStringNoPrefix(address(balancer))))
            )
        );
        address rr = IENSRegistry(ENS).resolver(reverseNode);
        assertEq(IResolver(rr).name(reverseNode), "balancertest", "reverse record");
        assertEq(IResolver(publicResolver).addr(node), address(balancer), "forward record");

        // "" clears the name (clearENSName was removed)
        vm.prank(creator);
        balancer.setENSName("");
        assertEq(IResolver(rr).name(reverseNode), "");
    }

    /*////////////////////////////// retirement //////////////////////////////*/

    function test_retireIsIrreversibleAndKeepsExits() public {
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.NotClosed.selector);
        balancer.retire();
        uint256[] memory sids = _allShapeIds();
        vm.startPrank(creator);
        balancer.close();
        balancer.retire();
        vm.expectRevert(); // FWA: PoolAlreadyRetired
        balancer.open();
        balancer.unlistShapes(sids);
        balancer.withdrawCurated(curatedA, creator);
        vm.stopPrank();
        assertEq(nft.ownerOf(1), creator);
    }

    function _allShapeIds() internal view returns (uint256[] memory out) {
        uint256[] memory ids = balancer.getActiveIds();
        uint256[] memory tmp = new uint256[](ids.length);
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = balancer.items(ids[i]);
            if (kind == 2) tmp[n++] = ids[i];
        }
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) out[i] = tmp[i];
    }

    /*////////////////////////////// unlist / many listings //////////////////////////////*/

    function test_unlistShapesInBoundedSteps() public {
        // grow to a 30x0.01 target; the planA 0.05/0.1 Shapes remain listed as surplus (35 prizes total)
        configure(plan([uint256(30), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        vm.prank(creator);
        balancer.close();
        uint256 before = address(balancer).balance;
        uint256[] memory all = _allShapeIds();
        uint256 backing;
        for (uint256 i; i < all.length; ++i) {
            (, uint8 d,,,) = balancer.items(all[i]);
            backing += balancer.denominationAmount(d);
        }
        // unlistShapes is bounded to 20 per call
        uint256[] memory tooMany = new uint256[](21);
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidBatch.selector);
        balancer.unlistShapes(tooMany);
        // redeem everything in bounded chunks of 20
        for (uint256 off; off < all.length;) {
            uint256 size = all.length - off > 20 ? 20 : all.length - off;
            uint256[] memory chunk = new uint256[](size);
            for (uint256 i; i < size; ++i) chunk[i] = all[off + i];
            vm.prank(creator);
            balancer.unlistShapes(chunk);
            off += size;
        }
        uint16[16] memory active = balancer.getActiveShapes();
        for (uint256 d; d < 16; ++d) assertEq(active[d], 0);
        assertEq(address(balancer).balance, before + backing, "all backing redeemed");
    }

    /// No listing cap: >100 curated listings work and canPurchase stays under FWA's 100k stipend.
    function test_manyCuratedListingsUnderStipend() public {
        vm.startPrank(creator);
        nft.setApprovalForAll(address(balancer), true);
        for (uint256 r; r < 6; ++r) {
            PoolBalancer.CuratedInput[] memory batch = new PoolBalancer.CuratedInput[](20);
            for (uint256 i; i < 20; ++i) {
                uint256 id = 1000 + r * 20 + i;
                nft.mint(creator, id);
                batch[i] = PoolBalancer.CuratedInput(address(nft), id, 0.3 ether);
            }
            balancer.listCuratedBatch(batch);
        }
        vm.stopPrank();
        assertGt(balancer.getActiveIds().length, 120, "no listing cap");
        assertTrue(balancer.canPurchase(buyer));
        uint256 g = gasleft();
        vm.prank(address(pool));
        balancer.canPurchase(buyer);
        uint256 used = g - gasleft();
        assertLt(used, 100_000, "canPurchase independent of listing count, under stipend");
        emit log_named_uint("canPurchase gas with 120+ listings", used);
    }

    /*////////////////////////////// review regressions //////////////////////////////*/

    function _listFrozenAndFailDelivery() internal returns (FreezableNFT frozen, uint256 lid) {
        frozen = new FreezableNFT();
        frozen.mint(creator, 9);
        vm.startPrank(creator);
        frozen.approve(address(balancer), 9);
        lid = balancer.listCurated(address(frozen), 9, 0.3 ether);
        vm.stopPrank();
        frozen.setFrozen(true);
        (,,,,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        upkeep();
        (,, uint8 state,,) = balancer.items(lid);
        assertEq(state, 2, "PENDING");
    }

    function test_blockedRefundRecoveryDoesNotBrickUpkeep() public {
        (FreezableNFT frozen, uint256 lid) = _listFrozenAndFailDelivery();
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(buyer);
        pool.refundFailedDelivery(lid);
        _drawOneShape();
        upkeep();
        assertTrue(balancer.canPurchase(buyer), "pool keeps operating");
        vm.prank(creator);
        vm.expectRevert();
        balancer.recoverRefunded(lid, creator);
        frozen.setFrozen(false);
        vm.prank(creator);
        balancer.recoverRefunded(lid, creator);
        assertEq(frozen.ownerOf(9), creator);
        uint256[] memory sids = _allShapeIds();
        vm.startPrank(creator);
        balancer.close();
        balancer.unlistShapes(sids);
        vm.stopPrank();
    }

    function test_settledAfterRetryNeedsNoUpkeep() public {
        (FreezableNFT frozen, uint256 lid) = _listFrozenAndFailDelivery();
        frozen.setFrozen(false);
        pool.retryNFTDelivery(lid);
        assertEq(frozen.ownerOf(9), buyer);
        // the item was delivered on retry, not refunded: it cannot be "recovered"
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidItem.selector);
        balancer.recoverRefunded(lid, creator);
    }

    function test_gasGriefingCollectionCannotTaxUpkeep() public {
        GasBurnNFT evil = new GasBurnNFT();
        evil.mint(creator, 1);
        vm.startPrank(creator);
        evil.approve(address(balancer), 1);
        uint256 lid = balancer.listCurated(address(evil), 1, 0.3 ether);
        vm.stopPrank();
        evil.setBurn(true);
        (,,,,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        upkeep();
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(buyer);
        pool.refundFailedDelivery(lid);
        vm.prank(keeper);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep();
        _drawOneShape();
        uint256 g = gasleft();
        upkeep();
        assertLt(g - gasleft(), 1_500_000, "upkeep never forwards gas to the curated collection");
        assertTrue(balancer.canPurchase(buyer));
    }
}
