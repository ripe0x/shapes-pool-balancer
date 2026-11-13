// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {MockNFT, FreezableNFT, LyingNFT, ContractBlockingNFT, NonRefundingBuyer} from "./utils/Mocks.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";

interface IShapesMint {
    function mintBatch(uint256 amountWei, uint256 quantity) external payable returns (uint256 firstTokenId);
    function mintFee() external view returns (uint256);
    function transferFrom(address, address, uint256) external;
}

/// @notice Hardening pass: untracked NFT recovery, bounded upkeep with many historical refunds, pool-page
///         signatures, the reserve formula, incentive accounting and the restricted-collection griefing bound.
contract HardeningTest is ForkBase {
    uint256 curatedA;
    uint256 planA = plan([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0]);

    function setUp() public {
        setUpFork();
        createBalancer(10 ether);
        configure(planA);
        curatedA = listCurated(1, 0.3 ether);
        listCurated(2, 0.5 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertTrue(balancer.canPurchase(buyer));
    }

    function _lastShape() internal view returns (uint256 last) {
        uint256[] memory active = balancer.getActiveIds();
        for (uint256 i; i < active.length; ++i) {
            (uint8 kind,,,,) = balancer.items(active[i]);
            if (kind == 2 && active[i] > last) last = active[i];
        }
    }

    function _drawListing(uint256 lid) internal {
        (,,,,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
    }

    function _paid() internal returns (uint256 reward, uint256 gasPaid) {
        vm.recordLogs();
        upkeep();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("KeeperPaid(address,uint256,uint256)")) {
                (reward, gasPaid) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
    }

    /*////////////////////////////// untracked NFT recovery //////////////////////////////*/

    function test_recoverUntrackedNFTs() public {
        MockNFT other = new MockNFT();
        other.mint(stranger, 1);
        other.mint(stranger, 2);
        vm.startPrank(stranger);
        other.transferFrom(stranger, address(balancer), 1);
        other.safeTransferFrom(stranger, address(balancer), 2);
        vm.stopPrank();
        vm.startPrank(creator);
        balancer.recoverUntrackedNFT(address(other), 1, creator);
        balancer.recoverUntrackedNFT(address(other), 2, creator);
        vm.stopPrank();
        assertEq(other.ownerOf(1), creator);
        assertEq(other.ownerOf(2), creator);

        // a stray Shape sent directly is untracked too
        IShapesMint s = IShapesMint(SHAPES);
        vm.deal(stranger, 1 ether);
        vm.startPrank(stranger);
        uint256 tid = s.mintBatch{value: 0.01 ether + s.mintFee()}(0.01 ether, 1);
        s.transferFrom(stranger, address(balancer), tid);
        vm.stopPrank();
        vm.prank(creator);
        balancer.recoverUntrackedNFT(SHAPES, tid, creator);
        assertEq(shapes.ownerOf(tid), creator);
        assertTrue(balancer.canPurchase(buyer), "inventory untouched");
    }

    function test_cannotRecoverProtectedAssets() public {
        vm.startPrank(creator);
        vm.expectRevert(PoolBalancer.ProtectedAsset.selector);
        balancer.recoverUntrackedNFT(address(nft), 1, creator); // active curated listing
        (,,, uint256 tokenId,,,,) = pool.listings(_lastShape());
        vm.expectRevert(PoolBalancer.ProtectedAsset.selector);
        balancer.recoverUntrackedNFT(SHAPES, tokenId, creator); // active Shape listing
        vm.expectRevert(PoolBalancer.ProtectedAsset.selector);
        balancer.recoverUntrackedNFT(address(pool), 1, creator);
        vm.expectRevert(PoolBalancer.ProtectedAsset.selector);
        balancer.recoverUntrackedNFT(FWA_FACTORY, 1, creator);
        LyingNFT liar = new LyingNFT();
        vm.expectRevert(PoolBalancer.ProtectedAsset.selector);
        balancer.recoverUntrackedNFT(address(liar), 1, creator);
        vm.expectRevert(PoolBalancer.InvalidRecipient.selector);
        balancer.recoverUntrackedNFT(address(nft), 1, address(0));
        vm.stopPrank();

        // a curated NFT awaiting FWA delivery (and after refund, before recovery) stays in FWA custody
        FreezableNFT frozen = new FreezableNFT();
        frozen.mint(creator, 9);
        vm.startPrank(creator);
        frozen.approve(address(balancer), 9);
        uint256 lid = balancer.listCurated(address(frozen), 9, 0.3 ether);
        vm.stopPrank();
        frozen.setFrozen(true);
        _drawListing(lid);
        upkeep();
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.ProtectedAsset.selector);
        balancer.recoverUntrackedNFT(address(frozen), 9, creator);
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(buyer);
        pool.refundFailedDelivery(lid);
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.ProtectedAsset.selector);
        balancer.recoverUntrackedNFT(address(frozen), 9, creator);
        // the only exit for it is recoverRefunded
        frozen.setFrozen(false);
        vm.prank(creator);
        balancer.recoverRefunded(lid, creator);
        assertEq(frozen.ownerOf(9), creator);
    }

    /*////////////////////////////// historical refunds //////////////////////////////*/

    function _shapeUpkeepGas() internal returns (uint256 used) {
        _drawListing(_lastShape());
        uint256 g = gasleft();
        upkeep();
        used = g - gasleft();
    }

    /// 200 curated deliveries fail on a frozen collection and are refunded; routine upkeep never reads them.
    function test_historicalRefundsDoNotGrowUpkeepGas() public {
        uint256 baseline = _shapeUpkeepGas();
        FreezableNFT frozen = new FreezableNFT();
        vm.prank(creator);
        frozen.setApprovalForAll(address(balancer), true);
        uint256[] memory failed = new uint256[](200);
        uint256 n;
        for (uint256 round; round < 10; ++round) {
            PoolBalancer.CuratedInput[] memory batch = new PoolBalancer.CuratedInput[](20);
            for (uint256 i; i < 20; ++i) {
                uint256 id = round * 20 + i + 1;
                frozen.mint(creator, id);
                batch[i] = PoolBalancer.CuratedInput(address(frozen), id, 0.3 ether);
            }
            frozen.setFrozen(false);
            vm.prank(creator);
            uint256[] memory lids = balancer.listCuratedBatch(batch);
            frozen.setFrozen(true);
            for (uint256 j; j < 20; j += 5) {
                uint256[] memory ids = buy(buyer, 5);
                for (uint256 k; k < 5; ++k) {
                    (,,,,,, uint256 slot,) = pool.listings(lids[j + k]);
                    fulfill(ids[k], wordForSlot(slot));
                    failed[n++] = lids[j + k];
                }
                settle();
                upkeep();
            }
        }
        for (uint256 i; i < n; ++i) {
            (,,,,,,, uint8 st) = pool.listings(failed[i]);
            assertEq(st, 6, "DeliveryPending");
        }
        vm.warp(block.timestamp + 7 days + 1);
        for (uint256 i; i < n; ++i) {
            vm.prank(buyer);
            pool.refundFailedDelivery(failed[i]);
        }
        vm.prank(keeper);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep();
        uint256 after_ = _shapeUpkeepGas();
        emit log_named_uint("shape upkeep gas before", baseline);
        emit log_named_uint("shape upkeep gas after 200 refunds", after_);
        assertLt(after_, baseline + 20_000, "upkeep gas independent of refund history");
        assertTrue(balancer.canPurchase(buyer));
        frozen.setFrozen(false);
        vm.prank(creator);
        balancer.recoverRefunded(failed[123], creator);
        assertEq(frozen.ownerOf(124), creator);
    }

    /*////////////////////////////// reserve formula //////////////////////////////*/

    /// The exact requiredReserve() formula with a full deficit (empty, open) and once fully reconciled.
    function test_reserveExactFormula() public {
        address c = makeAddr("reserveCreator");
        vm.deal(c, 100 ether);
        vm.prank(c);
        PoolBalancer b = PoolBalancer(payable(factory.createBalancer{value: 10 ether}(bytes32(0))));
        vm.startPrank(c);
        b.configure(MARKUP, planA);
        nft.mint(c, 9001);
        nft.approve(address(b), 9001);
        b.listCurated(address(nft), 9001, 0.3 ether);
        b.open();
        vm.stopPrank();
        uint256 fee = shapes.mintFee();
        uint256 largest = 0.1 ether + fee;
        // empty: restore the whole target + 1 largest prize + (ceil((10+3)/6)+1)=4 keeper rewards
        uint256 deficit = 5 * (0.01 ether + fee) + 3 * (0.05 ether + fee) + 2 * (0.1 ether + fee);
        assertEq(b.requiredReserve(), deficit + largest + 4 * b.MAX_KEEPER_REWARD(), "empty-pool reserve");
        // fully reconciled: deficit 0, 1 largest prize + 2 keeper rewards (ceil(3/6)+1)
        for (uint256 i; i < 10; ++i) {
            vm.prank(keeper, keeper);
            try b.performUpkeep() {} catch { break; }
        }
        assertEq(b.requiredReserve(), largest + 2 * b.MAX_KEEPER_REWARD(), "reconciled-open reserve");
    }

    /*////////////////////////////// incentive accounting //////////////////////////////*/

    /// Creator-started work (SETTING_UP) refuses purchases; upkeep is paid measured gas plus the flat reward.
    function test_creatorWorkPaysFullAndRefusesPurchases() public {
        address c = makeAddr("setupCreator");
        vm.deal(c, 100 ether);
        vm.prank(c);
        PoolBalancer b = PoolBalancer(payable(factory.createBalancer{value: 5 ether}(bytes32(0))));
        vm.startPrank(c);
        b.configure(1000, plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        nft.mint(c, 9101);
        nft.approve(address(b), 9101);
        b.listCurated(address(nft), 9101, 0.3 ether);
        b.open();
        vm.stopPrank();
        assertTrue(b.creatorWork(), "creator work set");
        assertEq(b.admissionStatus(), 2, "SETTING_UP");
        assertFalse(b.canPurchase(buyer), "purchases refused while creator work is pending");

        vm.recordLogs();
        vm.prank(keeper, keeper);
        b.performUpkeep();
        (uint256 reward, uint256 gasPaid) = _fromLogs();
        // from the creator's ETH: measured gas plus the 50,000 overhead at the reimbursed price, plus the flat 0.0001
        assertEq(reward, (gasPaid + 50_000) * 0.55 gwei + 0.0001 ether, "full reward");
    }

    function _fromLogs() internal returns (uint256 reward, uint256 gasPaid) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("KeeperPaid(address,uint256,uint256)")) {
                (reward, gasPaid) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
    }

    /// At the minimum markup a Shape is listed at what it cost, 10% of its backing and its restocking fee. The keeper
    /// who restocks it is paid less than the replacement's own fee, so the markup is not touched.
    function test_minimumMarkupStillFundsKeepers() public {
        address c = makeAddr("cheapCreator");
        vm.deal(c, 100 ether);
        vm.prank(c);
        PoolBalancer b = PoolBalancer(payable(factory.createBalancer{value: 2 ether}(bytes32(0))));
        vm.startPrank(c);
        b.configure(1000, plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        nft.mint(c, 9200);
        nft.approve(address(b), 9200);
        b.listCurated(address(nft), 9200, 0.3 ether);
        b.open();
        vm.stopPrank();
        balancer = b;
        pool = b.pool();
        fillUp();
        assertTrue(b.canPurchase(buyer));

        uint256 lid = _lastShape();
        (,,, uint112 base, uint112 price) = b.items(lid);
        assertEq(base, 0.01 ether + shapes.mintFee() + 0.001 ether, "backing, mint fee and 10% markup");
        assertEq(price - base, b.restockFee(), "one restocking fee");
        _drawListing(lid);
        vm.recordLogs();
        upkeep();
        (uint256 reward,) = _fromLogs();
        (,,, uint112 nb, uint112 np) = b.items(_lastShape());
        assertGt(_lastShape(), lid, "a replacement was listed");
        assertEq(np - nb, b.restockFee(), "the replacement carries this block's fee");
        assertLe(reward, np - nb, "the replacement's fee covers the pay");
        assertEq(b.getActiveShapes()[0], 10, "restocked");
    }

    /// Gas jumps after the pool was stocked: each restock lists its replacement at the new (capped) basefee, and that
    /// fee covers the keeper's pay for that call.
    function test_gasJumpRestockPaidByTheNewListingsFee() public {
        uint256 capFee = 900_000 * 5 gwei + 0.0002 ether;
        vm.fee(80 gwei);
        vm.txGasPrice(5 gwei);
        assertEq(balancer.restockFee(), capFee, "fee capped at 5 gwei");
        uint256 earned;
        uint256 paid;
        for (uint256 i; i < 4; ++i) {
            assertTrue(balancer.canPurchase(buyer));
            uint256 before = _lastShape();
            _drawListing(_activeOfSize(0));
            vm.recordLogs();
            upkeep();
            (uint256 reward, uint256 gasUsed) = _fromLogs();
            uint256 fresh = _lastShape();
            assertGt(fresh, before, "a replacement was listed");
            (,,, uint112 base, uint112 price) = balancer.items(fresh);
            assertEq(price - base, capFee, "listed at the capped fee");
            earned += price - base;
            assertGe(reward, gasUsed * 5 gwei, "the keeper is covered at the cap");
            paid += reward;
            assertLe(paid, earned, "the fees listed cover the pay");
        }
    }

    /// A curated NFT carries no restocking fee: its whole markup is the creator's, and the creator's ETH pays the keeper
    /// who reconciles its draw.
    function test_curatedDrawReconcileIsPaid() public {
        (,,, uint112 base, uint112 price) = balancer.items(curatedA);
        assertEq(price - base, 0.045 ether, "0.3 ETH at 15%, all markup");
        _drawListing(curatedA);
        vm.recordLogs();
        upkeep();
        (uint256 reward, uint256 gasPaid) = _fromLogs();
        assertEq(reward, (gasPaid + 50_000) * 0.55 gwei + 0.0001 ether, "measured gas, overhead and the flat reward");
        assertLt(reward, 0.0003 ether, "a reconcile-only call is cheap");
    }

    function _activeOfSize(uint8 size) internal view returns (uint256) {
        uint256[] memory active = balancer.getActiveIds();
        for (uint256 i; i < active.length; ++i) {
            (uint8 kind, uint8 d,,,) = balancer.items(active[i]);
            if (kind == 2 && d == size) return active[i];
        }
        revert("none listed");
    }

    /// A creator deposit while open keeps the pool admitting and does not set creator work.
    function test_creatorTopUpWhileOpenSetsNoCreatorWork() public {
        assertFalse(balancer.creatorWork());
        vm.prank(creator);
        balancer.depositETH{value: 0.01 ether}();
        vm.prank(creator);
        balancer.open(); // already open
        assertFalse(balancer.creatorWork(), "no creator-work flag while purchases are admitted");
        assertTrue(balancer.canPurchase(buyer));
    }

    /*////////////////////////////// reconcile bound //////////////////////////////*/

    /// Upkeep reconciles at most MAX_RECONCILE (5) settled sequences per call.
    function test_reconcileBoundPerCall() public {
        // a high-weight target so many unreconciled draws do not trip LOW_INVENTORY before we reconcile
        vm.prank(creator);
        balancer.depositETH{value: 10 ether}();
        configure(plan([uint256(80), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        // settle 15 draws across three batches of five, never reconciling in between
        for (uint256 r; r < 3; ++r) {
            uint256[] memory ids = buy(buyer, 5);
            for (uint256 k; k < 5; ++k) {
                fulfill(ids[k], uint256(keccak256(abi.encode(r, k))));
            }
            settle();
        }
        assertGe(pool.nextSequenceToProcess() - 1, 15, "15 sequences processed by FWA");
        assertEq(balancer.reconciledSequence(), 0, "none reconciled yet");
        upkeep();
        assertEq(balancer.reconciledSequence(), 5, "reconciles exactly MAX_RECONCILE per call");
        upkeep();
        upkeep();
        assertEq(balancer.reconciledSequence(), 15, "five more per call");
    }

    /*////////////////////////////// pool page (ERC-1271) //////////////////////////////*/

    function test_poolPageApprovalIsNarrow() public {
        string memory issuedAt = "2026-11-10T12:34:56.789Z";
        bytes32 metadataHash = keccak256(
            bytes('{"name":"Test","profile":{"avatarUrl":"","bannerUrl":"","description":"","websiteUrl":"","xUrl":"","discordUrl":""}}')
        );
        string memory message = string.concat(
            "Publish FWA Pools page\nSite: pools.fwa.fun\nChain: 1\nFactories: ",
            "0x8919814d825a5af238cc04de06b1c18c9eaa477c, 0xf5a3a153164791ab579c3d9ba5dbecf7cdfd300c\nPool: ",
            vm.toLowercase(vm.toString(address(pool))),
            "\nIssued at: ",
            issuedAt,
            "\nMetadata hash: ",
            vm.toString(metadataHash)
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n", vm.toString(bytes(message).length), message)
        );
        assertEq(balancer.isValidSignature(digest, ""), bytes4(0xffffffff), "not yet approved");

        vm.prank(stranger);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.approvePoolPage(issuedAt, metadataHash);

        vm.prank(creator);
        bytes32 got = balancer.approvePoolPage(issuedAt, metadataHash);
        assertEq(got, digest, "matches FWA's personal_sign digest");
        assertEq(balancer.isValidSignature(digest, hex"00"), bytes4(0x1626ba7e));
        assertEq(balancer.isValidSignature(keccak256(bytes(message)), ""), bytes4(0xffffffff));
        assertEq(balancer.isValidSignature(bytes32(uint256(digest) ^ 1), ""), bytes4(0xffffffff));

        vm.startPrank(creator);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        balancer.approvePoolPage("2026-11-10T12:34:56.78Z", metadataHash);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        balancer.approvePoolPage("2026-11-10\nPool: 0x0000Z", metadataHash);
        vm.stopPrank();

        // approvals are revocable and die with a creator change
        vm.prank(stranger);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.revokePoolPages();
        vm.prank(creator);
        balancer.revokePoolPages();
        assertEq(balancer.isValidSignature(digest, ""), bytes4(0xffffffff), "revoked");
        vm.prank(creator);
        balancer.approvePoolPage(issuedAt, metadataHash);
        assertEq(balancer.isValidSignature(digest, ""), bytes4(0x1626ba7e), "re-approved");
        address next = makeAddr("nextCreator");
        vm.prank(creator);
        balancer.transferCreator(next);
        assertEq(balancer.isValidSignature(digest, ""), bytes4(0x1626ba7e), "valid until accepted");
        vm.prank(next);
        balancer.acceptCreator();
        assertEq(balancer.isValidSignature(digest, ""), bytes4(0xffffffff), "former creator's approval void");
    }

    /*////////////////////////////// griefing bound //////////////////////////////*/

    /// A purchaser that never refunds, drawing a curated NFT from a collection that refuses transfers to contracts:
    /// the NFT stays in FWA escrow. Expected cost to lock it is attempt cost / odds, asserted against its value.
    function test_griefingBoundForRestrictedCurated() public {
        ContractBlockingNFT r = new ContractBlockingNFT();
        r.allow(address(pool));
        r.allow(address(balancer));
        r.mint(creator, 1);
        vm.startPrank(creator);
        r.approve(address(balancer), 1);
        uint256 lid = balancer.listCurated(address(r), 1, 0.5 ether);
        vm.stopPrank();
        assertTrue(balancer.canPurchase(buyer));

        (,,,, uint256 w,,,) = pool.listings(lid);
        uint256 total = pool.totalWeight();
        (uint256 fee, uint256 vrf,) = pool.quoteAcquisitionPrice(1);
        uint256 attemptCost = vrf + fee * 500 / 10_500;
        uint256 expectedCostToLock = attemptCost * total / w;
        emit log_named_decimal_uint("expected attacker cost to lock (ETH)", expectedCostToLock, 18);
        assertGt(expectedCostToLock, 0.5 ether, "locking the NFT costs more than its value in expectation");

        NonRefundingBuyer g = new NonRefundingBuyer();
        vm.deal(address(g), 1 ether);
        (,, uint256 pay) = pool.quoteAcquisitionPrice(1);
        uint256[] memory ids = g.buy{value: pay}(address(pool), 1);
        (,,,,,, uint256 slot,) = pool.listings(lid);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        (,,,,,,, uint8 st) = pool.listings(lid);
        assertEq(st, 6, "DeliveryPending: locked unless the purchaser refunds");
        upkeep();
        assertTrue(balancer.canPurchase(buyer), "the pool keeps operating");
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidItem.selector);
        balancer.recoverRefunded(lid, creator);
    }

    function test_griefingThinPoolIsCheap() public {
        address c = makeAddr("thinPoolCreator");
        vm.deal(c, 100 ether);
        vm.prank(c);
        PoolBalancer b = PoolBalancer(payable(factory.createBalancer{value: 2 ether}(bytes32(0))));
        ContractBlockingNFT r = new ContractBlockingNFT();
        r.allow(address(b.pool()));
        r.allow(address(b));
        r.mint(c, 1);
        vm.startPrank(c);
        b.configure(MARKUP, plan([uint256(1), 0, 0, 0, 0, 0, 0, 0, 0]));
        r.approve(address(b), 1);
        uint256 lid = b.listCurated(address(r), 1, 0.5 ether);
        b.open();
        vm.stopPrank();
        balancer = b;
        pool = b.pool();
        fillUp();
        (,,,, uint256 w,,,) = pool.listings(lid);
        (uint256 fee, uint256 vrf,) = pool.quoteAcquisitionPrice(1);
        uint256 expectedCostToLock = (vrf + fee * 500 / 10_500) * pool.totalWeight() / w;
        emit log_named_decimal_uint("thin pool: expected cost to lock a 0.5 ETH NFT (ETH)", expectedCostToLock, 18);
        assertLt(expectedCostToLock, 0.5 ether, "thin pools do not protect restricted collections");
    }
}
