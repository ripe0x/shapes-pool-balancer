// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {FreezableNFT, ReentrantNFT, LyingNFT, RejectingKeeper, AcquiringNFT, GasBurnNFT} from "./utils/Mocks.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {LibString} from "solady/utils/LibString.sol";

interface IShapesAdmin {
    function setMintFee(uint256) external;
    function admin() external view returns (address);
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
    uint256 curatedA;
    uint256 curatedB;
    uint256 planA = plan([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0]); // 0.4 ETH backing
    uint256 planB = plan([uint256(2), 1, 1, 0, 0, 0, 0, 0, 0]); // 0.17 ETH backing

    function setUp() public {
        setUpFork();
        createBalancer(5 ether);
        curatedA = listCurated(1, 0.3 ether);
        curatedB = listCurated(2, 0.5 ether);
        uint256[] memory plans = new uint256[](1);
        plans[0] = planA;
        configure(0.03 ether, 1 ether, 30, plans);
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
        // a creator may run several Balancers, each with its own FWA pool
        vm.prank(creator);
        PoolBalancer b3 = PoolBalancer(payable(factory.createBalancer(bytes32(uint256(1)))));
        assertEq(b3.pool().owner(), address(b3));
        // clones and the implementation cannot be re-initialized
        vm.expectRevert(PoolBalancer.AlreadyInitialized.selector);
        b2.initialize(stranger);
        PoolBalancer impl = PoolBalancer(payable(factory.implementation()));
        vm.expectRevert(PoolBalancer.AlreadyInitialized.selector);
        impl.initialize(stranger);
    }

    /*////////////////////////////// permissions //////////////////////////////*/

    function test_onlyCreator() public {
        PoolBalancer.Config memory cfg = PoolBalancer.Config(1 ether, 1 ether, 0, 0);
        uint256[] memory plans = new uint256[](1);
        plans[0] = planA;
        PoolBalancer.CuratedInput[] memory batch = new PoolBalancer.CuratedInput[](1);
        address[2] memory callers = [stranger, keeper];
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.configure(cfg, plans);
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
            balancer.recoverCuratedNFT(curatedA, callers[i]);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.claimSurplus(1, callers[i]);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.unwind(1);
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.retire();
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.setENSName("x");
            vm.expectRevert(PoolBalancer.Unauthorized.selector);
            balancer.clearENSName();
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
        assertEq(balancer.admissionStatus(), 2, "listing invalidates the checkpoint");
        (,,, uint112 base, uint112 price) = balancer.items(lids[0]);
        assertEq(base, 0.2 ether);
        assertEq(price, 0.23 ether, "effective FWA price = base * (1 + markup)");
        (,,,,, uint256 fwaPrice,,) = pool.listings(lids[0]);
        assertEq(fwaPrice, 0.23 ether);

        vm.prank(creator);
        balancer.updateCuratedPrice(lids[0], 0.4 ether);
        (,,,,, fwaPrice,,) = pool.listings(lids[0]);
        assertEq(fwaPrice, 0.46 ether);

        vm.prank(creator);
        balancer.withdrawCurated(lids[1], creator);
        assertEq(nft.ownerOf(101), creator);
        (uint8 kind,,,,) = balancer.items(lids[1]);
        assertEq(kind, 0);

        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidItem.selector);
        balancer.withdrawCurated(lids[1], creator);

        upkeep(); // re-checkpoint
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

    function test_creatorOpsBlockedUntilBatchReconciled() public {
        uint256[] memory ids = buy(buyer, 1);
        nft.mint(creator, 50);
        vm.startPrank(creator);
        nft.approve(address(balancer), 50);
        vm.expectRevert(PoolBalancer.PoolBusy.selector);
        balancer.listCurated(address(nft), 50, 1 ether);
        vm.expectRevert(PoolBalancer.PoolBusy.selector);
        balancer.updateCuratedPrice(curatedA, 1 ether);
        vm.expectRevert(PoolBalancer.PoolBusy.selector);
        balancer.withdrawCurated(curatedA, creator);
        vm.stopPrank();
        vm.prank(keeper);
        vm.expectRevert(PoolBalancer.PoolBusy.selector);
        balancer.performUpkeep();
        assertEq(balancer.admissionStatus(), 3, "UNSETTLED");

        fulfill(ids[0], 1); // target 1 selects slot 1: curated A
        settle();
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.PoolBusy.selector); // settled but not yet reconciled
        balancer.withdrawCurated(curatedB, creator);
        upkeep();
        vm.prank(creator);
        balancer.withdrawCurated(curatedB, creator);
        assertEq(nft.ownerOf(1), buyer);
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
        upkeep();
        frozen.setFrozen(true);

        (,,,,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        (,,,,,,, uint8 status) = pool.listings(lid);
        assertEq(status, 6, "FWA DeliveryPending");

        upkeep(); // reconciles the draw; NFT is out of the active set
        (, , uint8 state,,) = balancer.items(lid);
        assertEq(state, 2, "PENDING");
        assertEq(balancer.getPendingIds().length, 1);
        assertTrue(balancer.canPurchase(buyer), "pool continues with remaining curated");

        // creator cannot recover before the purchaser's refund
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidItem.selector);
        balancer.recoverCuratedNFT(lid, creator);

        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(buyer);
        pool.refundFailedDelivery(lid);
        frozen.setFrozen(false);

        // upkeep never calls the curated collection; the creator recovers it directly
        assertFalse(balancer.needsUpkeep(), "refunded curated item is not keeper work");
        vm.prank(creator);
        balancer.recoverCuratedNFT(lid, creator);
        assertEq(frozen.ownerOf(9), creator);
        assertEq(balancer.getPendingIds().length, 0);
    }

    function test_creatorRecoversRefundedDirectly() public {
        FreezableNFT frozen = new FreezableNFT();
        frozen.mint(creator, 9);
        vm.startPrank(creator);
        frozen.approve(address(balancer), 9);
        uint256 lid = balancer.listCurated(address(frozen), 9, 0.3 ether);
        vm.stopPrank();
        upkeep();
        frozen.setFrozen(true);
        (,,,,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        upkeep();
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(buyer);
        pool.refundFailedDelivery(lid);
        frozen.setFrozen(false);
        vm.prank(creator);
        balancer.recoverCuratedNFT(lid, creator);
        assertEq(frozen.ownerOf(9), creator);
        assertEq(balancer.getPendingIds().length, 0);
    }

    /*////////////////////////////// keeper //////////////////////////////*/

    function _drawOneShape() internal {
        uint256[] memory active = balancer.getActiveIds();
        uint256 last;
        for (uint256 i; i < active.length; ++i) {
            (uint8 kind,,,,) = balancer.items(active[i]);
            if (kind == 2) last = active[i];
        }
        (,,,,,, uint256 slot, uint8 st) = pool.listings(last);
        require(st == 1, "not active");
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
    }

    function test_keeperRewardBoundedUnderGasPriceManipulation() public {
        _drawOneShape();
        vm.fee(1 gwei);
        vm.txGasPrice(5_000 gwei); // keeper bids an absurd priority fee
        uint256 before = keeper.balance;
        vm.prank(keeper, keeper);
        balancer.performUpkeep();
        uint256 paid = keeper.balance - before;
        // price is capped at basefee + 2 gwei
        assertLe(paid, 3_200_000 * 3 gwei + 0.0005 ether);
        assertGt(paid, 0.0005 ether);

        _drawOneShape();
        vm.fee(80 gwei); // basefee spike: capped at 10 gwei
        vm.txGasPrice(80 gwei);
        before = keeper.balance;
        vm.prank(keeper, keeper);
        balancer.performUpkeep();
        paid = keeper.balance - before;
        assertLe(paid, balancer.MAX_KEEPER_REWARD());
        assertLe(paid, 3_200_000 * 10 gwei + 0.0005 ether);
    }

    function test_noRewardForUnnecessaryWork() public {
        // repeated call: nothing to do
        vm.prank(keeper);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep();

        // a creator config change only needs a re-checkpoint: unpaid
        uint256[] memory plans = new uint256[](1);
        plans[0] = planA;
        configure(0.031 ether, 1 ether, 30, plans);
        uint256 before = keeper.balance;
        upkeep();
        assertEq(keeper.balance, before, "no payment without work");
        assertTrue(balancer.canPurchase(buyer));

        // a second keeper racing the same work finds nothing left
        _drawOneShape();
        upkeep();
        vm.prank(stranger);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep();
    }

    function test_refundOnlyBatchReimbursesGasOnly() public {
        buy(buyer, 1);
        vm.roll(block.number + 40); // word deadline passes
        pool.processAcquisitions(1);
        uint256 before = keeper.balance;
        upkeep();
        uint256 paid = keeper.balance - before;
        assertGt(paid, 0, "reconciliation gas reimbursed");
        assertLt(paid, 0.0005 ether, "no fixed incentive without inventory work");
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

    /*////////////////////////////// reentrancy / malicious ERC721 //////////////////////////////*/

    function test_reentrantCollectionCannotReenter() public {
        ReentrantNFT evil = new ReentrantNFT();
        evil.setTarget(address(balancer));
        evil.mint(creator, 1);
        vm.startPrank(creator);
        evil.approve(address(balancer), 1);
        uint256 lid = balancer.listCurated(address(evil), 1, 0.3 ether);
        vm.stopPrank();
        assertFalse(evil.reentered(), "listing transfer could not re-enter");
        upkeep();
        // drawing it delivers through FWA; the hook's re-entry attempt is harmless
        (,,,,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        assertEq(evil.ownerOf(1), buyer);
        upkeep();
        assertTrue(balancer.canPurchase(buyer));
    }

    /*////////////////////////////// fees / reserve //////////////////////////////*/

    function test_realMintFeeChange() public {
        address admin = IShapesAdmin(SHAPES).admin();
        vm.prank(admin);
        IShapesAdmin(SHAPES).setMintFee(0.005 ether);
        assertEq(balancer.admissionStatus(), 7, "MINT_FEE_ROSE");
        uint256 reserveBefore = _cpReserve();
        upkeep();
        assertTrue(balancer.canPurchase(buyer));
        assertGt(_cpReserve(), reserveBefore, "reserve tracks the higher fee");
        _drawOneShape();
        upkeep(); // mints at the new fee
        assertTrue(balancer.canPurchase(buyer));
        // fee decrease keeps admission open
        vm.prank(admin);
        IShapesAdmin(SHAPES).setMintFee(0);
        assertTrue(balancer.canPurchase(buyer));
    }

    function _cpReserve() internal view returns (uint256 r) {
        (,,,, r) = balancer.checkpoint();
    }

    function test_reserveMath() public view {
        // planA: 5x0.01, 3x0.05, 2x0.1; worst 5 draws = 2x0.1 + 3x0.05, each + mint fee
        uint256 fee = shapes.mintFee();
        uint256 expected = 2 * (0.1 ether + fee) + 3 * (0.05 ether + fee) + balancer.MAX_KEEPER_REWARD();
        assertEq(_cpReserve(), expected);
        assertEq(balancer.requiredReserve(), expected, "no deficit while full");
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
        // after a draw, the unreplaced Shape is a liability until upkeep restores it
        _drawOneShape();
        assertEq(balancer.withdrawableSurplus(), 0);
    }

    /*////////////////////////////// markup / plans //////////////////////////////*/

    function test_markupChangeRepricesAllListings() public {
        uint256 oddsBefore = _curatedOddsPpm();
        uint256[] memory plans = new uint256[](1);
        plans[0] = planA;
        vm.prank(creator);
        balancer.configure(PoolBalancer.Config(0.04 ether, 1 ether, 30, 3000), plans);
        assertTrue(balancer.repricing());
        upkeep();
        assertEq(balancer.admissionStatus(), 10, "REPRICING while incomplete");
        assertFalse(balancer.canPurchase(buyer));
        fillUp();
        assertFalse(balancer.repricing());
        assertTrue(balancer.canPurchase(buyer));
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (,,, uint112 base, uint112 price) = balancer.items(ids[i]);
            assertEq(price, uint256(base) * 13_000 / 10_000);
            (,,,,, uint256 fwaPrice,,) = pool.listings(ids[i]);
            assertEq(fwaPrice, price);
        }
        // uniform markup preserves relative odds up to integer rounding
        uint256 oddsAfter = _curatedOddsPpm();
        assertApproxEqAbs(oddsAfter, oddsBefore, 1);
    }

    function _curatedOddsPpm() internal view returns (uint256) {
        uint256 cW;
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = balancer.items(ids[i]);
            (,,,, uint256 w,,,) = pool.listings(ids[i]);
            if (kind == 1) cW += w;
        }
        return cW * 1e6 / pool.totalWeight();
    }

    function test_switchesToFallbackPlanWhenInfeasible() public {
        uint256[] memory plans = new uint256[](2);
        plans[0] = planA;
        plans[1] = planB;
        configure(0.05 ether, 1 ether, 50, plans); // 0.50% floor
        upkeep();
        assertEq(balancer.activePlan(), 0);
        assertTrue(balancer.canPurchase(buyer));

        // draw curated A: planA odds fall to ~0.34%, planB gives ~0.86%
        (,,,,,, uint256 slot,) = pool.listings(curatedA);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        fillUp();
        assertEq(balancer.activePlan(), 1, "fallback plan activated");
        uint16[9] memory active = balancer.getActiveShapes();
        assertEq(active[0], 2);
        assertEq(active[1], 1);
        assertEq(active[2], 1);
        assertEq(balancer.getSpares(0).length, 3, "surplus Shapes kept as spares");
        assertEq(balancer.getSpares(1).length, 2);
        assertEq(balancer.getSpares(2).length, 1);
        assertTrue(balancer.canPurchase(buyer));
        // spares cover future draws of their denomination, so the batch reserve falls to fees only
        uint256 fee = shapes.mintFee();
        assertEq(_cpReserve(), 0 + balancer.MAX_KEEPER_REWARD() + 0 * fee);
    }

    function test_configureRejectsBadPlans() public {
        uint256[] memory plans = new uint256[](1);
        plans[0] = plan([uint256(0), 0, 0, 0, 0, 0, 0, 0, 1]); // 100 ETH backing > 1 ETH limit
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidPlan.selector);
        balancer.configure(PoolBalancer.Config(1 ether, 1 ether, 0, 1500), plans);
        plans[0] = plan([uint256(41), 0, 0, 0, 0, 0, 0, 0, 0]); // > MAX_SHAPES_PER_PLAN
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidPlan.selector);
        balancer.configure(PoolBalancer.Config(1 ether, 10 ether, 0, 1500), plans);
        plans[0] = planA | (uint256(1) << 200); // stray high bits
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidPlan.selector);
        balancer.configure(PoolBalancer.Config(1 ether, 10 ether, 0, 1500), plans);
        plans[0] = planA;
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        balancer.configure(PoolBalancer.Config(1 ether, 10 ether, 0, 10_001), plans);
    }

    function test_drawPriceCeilingEnforced() public {
        uint256[] memory plans = new uint256[](1);
        plans[0] = planA;
        uint256 fee = pool.acquisitionFee();
        configure(fee - 1, 1 ether, 30, plans);
        upkeep();
        assertEq(balancer.admissionStatus(), 5, "INFEASIBLE: price above ceiling");
        assertFalse(balancer.canPurchase(buyer));
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

        vm.prank(creator);
        balancer.clearENSName();
        assertEq(IResolver(rr).name(reverseNode), "");
    }

    /*////////////////////////////// retirement //////////////////////////////*/

    function test_retireIsIrreversibleAndKeepsExits() public {
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.NotClosed.selector);
        balancer.retire();
        vm.startPrank(creator);
        balancer.close();
        balancer.retire();
        vm.expectRevert(); // FWA: PoolAlreadyRetired
        balancer.open();
        balancer.unwind(20);
        balancer.withdrawCurated(curatedA, creator);
        vm.stopPrank();
        assertEq(nft.ownerOf(1), creator);
    }

    /*////////////////////////////// review regressions //////////////////////////////*/

    function _listFrozenAndFailDelivery() internal returns (FreezableNFT frozen, uint256 lid) {
        frozen = new FreezableNFT();
        frozen.mint(creator, 9);
        vm.startPrank(creator);
        frozen.approve(address(balancer), 9);
        lid = balancer.listCurated(address(frozen), 9, 0.3 ether);
        vm.stopPrank();
        upkeep();
        frozen.setFrozen(true);
        (,,,,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        upkeep();
        assertEq(balancer.getPendingIds().length, 1);
    }

    /// Review finding (High): a refunded curated NFT whose collection blocks transfers bricked upkeep.
    function test_blockedRefundRecoveryDoesNotBrickUpkeep() public {
        (FreezableNFT frozen, uint256 lid) = _listFrozenAndFailDelivery();
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(buyer);
        pool.refundFailedDelivery(lid);
        // collection still blocks transfers: later draws must still reconcile and replenish
        _drawOneShape();
        upkeep();
        assertTrue(balancer.canPurchase(buyer), "pool keeps operating");
        assertEq(balancer.getPendingIds().length, 1, "blocked item stays pending");
        vm.prank(creator);
        vm.expectRevert();
        balancer.recoverCuratedNFT(lid, creator);
        // once transferable, the creator recovers it
        frozen.setFrozen(false);
        vm.prank(creator);
        balancer.recoverCuratedNFT(lid, creator);
        assertEq(frozen.ownerOf(9), creator);
        // exits remain available throughout
        vm.startPrank(creator);
        balancer.close();
        balancer.unwind(20);
        vm.stopPrank();
    }

    /// Review finding (Low): a delivery retried to success was cleaned up only to be rolled back.
    function test_settledAfterRetryIsCleanedUp() public {
        (FreezableNFT frozen, uint256 lid) = _listFrozenAndFailDelivery();
        frozen.setFrozen(false);
        pool.retryNFTDelivery(lid);
        assertEq(frozen.ownerOf(9), buyer);
        assertTrue(balancer.needsUpkeep());
        upkeep();
        assertEq(balancer.getPendingIds().length, 0);
        assertFalse(balancer.needsUpkeep());
        (uint8 kind,,,,) = balancer.items(lid);
        assertEq(kind, 0);
    }

    /// A collection's transfer hook cannot buy while listCurated is mid-call.
    function test_collectionHookCannotBuyDuringListing() public {
        AcquiringNFT hook = new AcquiringNFT();
        vm.deal(address(this), 1 ether);
        hook.arm{value: 1 ether}(address(pool));
        vm.deal(address(hook), 1 ether);
        hook.mint(creator, 1);
        vm.startPrank(creator);
        hook.approve(address(balancer), 1);
        balancer.listCurated(address(hook), 1, 0.3 ether);
        vm.stopPrank();
        assertFalse(hook.acquired(), "admission was closed during the call");
        assertEq(pool.unsettledAcquisitionCount(), 0);
        upkeep();
        assertTrue(balancer.canPurchase(buyer));
    }

    /// While open, surplus claims wait until settled draws are reconciled.
    function test_claimWaitsForReconciliationWhileOpen() public {
        _drawOneShape();
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.PoolBusy.selector);
        balancer.claimSurplus(1, creator);
        upkeep();
        vm.prank(creator);
        balancer.claimSurplus(1, creator);
    }

    function test_unwindRedeemsInBoundedSteps() public {
        uint256[] memory plans = new uint256[](1);
        plans[0] = plan([uint256(30), 0, 0, 0, 0, 0, 0, 0, 0]);
        configure(1 ether, 1 ether, 0, plans);
        fillUp();
        vm.startPrank(creator);
        balancer.close();
        uint256 before = address(balancer).balance;
        for (uint256 i; i < 4; ++i) {
            balancer.unwind(20);
        }
        vm.stopPrank();
        uint16[9] memory active = balancer.getActiveShapes();
        for (uint256 d; d < 9; ++d) {
            assertEq(active[d], 0);
            assertEq(balancer.getSpares(d).length, 0);
        }
        // 30 listed 0.01 Shapes plus the spares left by the plan change (3 x 0.05, 2 x 0.1)
        assertEq(address(balancer).balance, before + 30 * 0.01 ether + 0.35 ether, "all backing redeemed");
    }

    /// Repair review (Medium): a gas-burning refunded collection must not make upkeep expensive.
    function test_gasGriefingCollectionCannotTaxUpkeep() public {
        GasBurnNFT evil = new GasBurnNFT();
        evil.mint(creator, 1);
        vm.startPrank(creator);
        evil.approve(address(balancer), 1);
        uint256 lid = balancer.listCurated(address(evil), 1, 0.3 ether);
        vm.stopPrank();
        upkeep();
        evil.setBurn(true);
        (,,,,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        upkeep();
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(buyer);
        pool.refundFailedDelivery(lid);
        assertFalse(balancer.needsUpkeep(), "hint matches: nothing for keepers");
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
