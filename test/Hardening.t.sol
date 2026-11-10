// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {MockNFT, FreezableNFT, LyingNFT} from "./utils/Mocks.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";

interface IShapesMint {
    function mintBatch(uint256 amountWei, uint256 quantity) external payable returns (uint256 firstTokenId);
    function mintFee() external view returns (uint256);
    function transferFrom(address, address, uint256) external;
}

/// @notice Simplification and hardening pass: untracked NFT recovery, bounded upkeep with many historical
///         refunds, interrupted repricing at the listing limit, pool-page signatures, reserve without spares.
contract HardeningTest is ForkBase {
    uint256 curatedA;
    uint256 planA = plan([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0]);

    function setUp() public {
        setUpFork();
        createBalancer(10 ether);
        curatedA = listCurated(1, 0.3 ether);
        listCurated(2, 0.5 ether);
        uint256[] memory plans = new uint256[](1);
        plans[0] = planA;
        configure(1 ether, 0, plans);
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

    /*////////////////////////////// untracked NFT recovery //////////////////////////////*/

    function test_recoverUntrackedNFTs() public {
        // direct transferFrom (no hook) and safeTransferFrom (hook accepted) from an unknown collection
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

        // a stray Shape sent directly is untracked too (managed Shapes are never held between calls)
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
        // active curated listing: held by the FWA pool
        vm.expectRevert(PoolBalancer.ProtectedAsset.selector);
        balancer.recoverUntrackedNFT(address(nft), 1, creator);
        // active Shape listing
        (,,, uint256 tokenId,,,,) = pool.listings(_lastShape());
        vm.expectRevert(PoolBalancer.ProtectedAsset.selector);
        balancer.recoverUntrackedNFT(SHAPES, tokenId, creator);
        // the FWA pool and factory are never called
        vm.expectRevert(PoolBalancer.ProtectedAsset.selector);
        balancer.recoverUntrackedNFT(address(pool), 1, creator);
        vm.expectRevert(PoolBalancer.ProtectedAsset.selector);
        balancer.recoverUntrackedNFT(FWA_FACTORY, 1, creator);
        // a collection lying about ownership gets nothing
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
        upkeep();
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
        // the only exit for it is recoverCuratedNFT
        frozen.setFrozen(false);
        vm.prank(creator);
        balancer.recoverCuratedNFT(lid, creator);
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
            upkeep();
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
        // the collection still blocks transfers; nothing about them is keeper work
        vm.prank(keeper);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep();
        uint256 after_ = _shapeUpkeepGas();
        emit log_named_uint("shape upkeep gas before", baseline);
        emit log_named_uint("shape upkeep gas after 200 refunds", after_);
        assertLt(after_, baseline + 20_000, "upkeep gas independent of refund history");
        assertTrue(balancer.canPurchase(buyer));
        // each stays recoverable by the creator once transferable
        frozen.setFrozen(false);
        vm.prank(creator);
        balancer.recoverCuratedNFT(failed[123], creator);
        assertEq(frozen.ownerOf(124), creator);
    }

    /*////////////////////////////// repricing //////////////////////////////*/

    function test_interruptedRepricingAtListingLimit() public {
        vm.startPrank(creator);
        nft.setApprovalForAll(address(balancer), true);
        PoolBalancer.CuratedInput[] memory batch = new PoolBalancer.CuratedInput[](11);
        for (uint256 r; r < 8; ++r) {
            for (uint256 i; i < 11; ++i) {
                uint256 id = 1000 + r * 11 + i;
                nft.mint(creator, id);
                batch[i] = PoolBalancer.CuratedInput(address(nft), id, 0.2 ether + id * 1e12);
            }
            balancer.listCuratedBatch(batch);
        }
        vm.stopPrank();
        uint256[] memory active = balancer.getActiveIds();
        assertEq(active.length, 100, "listing limit");
        nft.mint(creator, 5000);
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.TooManyListings.selector);
        balancer.listCurated(address(nft), 5000, 0.3 ether);
        upkeep();
        assertTrue(balancer.canPurchase(buyer));

        uint256[] memory plans = new uint256[](1);
        plans[0] = planA;
        vm.prank(creator);
        balancer.configure(PoolBalancer.Config(1 ether, 0, 2500), plans);
        assertFalse(balancer.canPurchase(buyer));

        uint256 calls;
        while (balancer.repricing()) {
            // a keeper transaction that runs out of gas changes nothing
            if (calls == 3) {
                vm.prank(keeper);
                vm.expectRevert();
                balancer.performUpkeep{gas: 400_000}();
            }
            // a creator removes listings mid-run: swap-and-pop must not let any listing be skipped
            if (calls == 5 || calls == 9) {
                uint256[] memory ids = balancer.getActiveIds();
                for (uint256 i; i < ids.length; ++i) {
                    (uint8 kind,,,,) = balancer.items(ids[i]);
                    if (kind == 1) {
                        vm.prank(creator);
                        balancer.withdrawCurated(ids[i], creator);
                        break;
                    }
                }
            }
            uint256 g = gasleft();
            upkeep();
            assertLt(g - gasleft(), 3_200_000, "each repricing step within the reimbursable maximum");
            ++calls;
            if (balancer.repricing()) {
                assertEq(balancer.admissionStatus(), 10, "REPRICING");
                assertFalse(balancer.canPurchase(buyer));
            }
            require(calls < 40, "repricing did not converge");
        }
        assertTrue(balancer.canPurchase(buyer), "the step that finishes repricing also re-checkpoints");
        active = balancer.getActiveIds();
        for (uint256 i; i < active.length; ++i) {
            (uint8 kind, uint8 d,, uint112 base, uint112 price) = balancer.items(active[i]);
            assertEq(price, uint256(base) * 12_500 / 10_000, "every listing at the new markup");
            (,,,,, uint256 fwaPrice,,) = pool.listings(active[i]);
            assertEq(fwaPrice, price);
            if (kind == 2) assertEq(base, balancer.denominationAmount(d), "Shape base is its backing");
            else assertEq(base % 1e12, 0, "creator value untouched");
        }
        emit log_named_uint("repricing upkeeps for 100 listings", calls);
    }

    /*////////////////////////////// reserve without spares //////////////////////////////*/

    function test_reserveWithDeficitAndNoSpares() public {
        uint256 fee = shapes.mintFee();
        uint256 batch = 2 * (0.1 ether + fee) + 3 * (0.05 ether + fee);
        assertEq(balancer.requiredReserve(), batch + balancer.MAX_KEEPER_REWARD());
        // a drawn 0.1 Shape is a liability until replaced: deficit + worst batch + one keeper reward
        _drawListing(_lastShape());
        upkeep();
        assertEq(balancer.requiredReserve(), batch + balancer.MAX_KEEPER_REWARD(), "replaced");
        vm.prank(creator);
        balancer.close();
        assertEq(balancer.requiredReserve(), 0, "closed: everything claimable");
        vm.prank(creator);
        balancer.open();
        // withdraw down to the reserve: still admits; one wei less would not have been allowed
        upkeep();
        uint256 s = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(s, creator);
        assertEq(address(balancer).balance, balancer.requiredReserve());
        assertTrue(balancer.canPurchase(buyer));
        assertEq(balancer.MAX_KEEPER_REWARD(), 3_200_000 * 4 / 5 * 2 gwei + 0.0005 ether);
    }

    /*////////////////////////////// FWA pool page (ERC-1271) //////////////////////////////*/

    function test_poolPageApprovalIsNarrow() public {
        string memory issuedAt = "2026-11-10T12:34:56.789Z";
        bytes32 metadataHash = keccak256(
            bytes('{"name":"Test","profile":{"avatarUrl":"","bannerUrl":"","description":"","websiteUrl":"","xUrl":"","discordUrl":""}}')
        );
        // FWA's client template, rebuilt independently of the contract (lowercase hex via vm.toLowercase)
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
        // nothing else validates: other hashes, other messages, raw hashes of the same message
        assertEq(balancer.isValidSignature(keccak256(bytes(message)), ""), bytes4(0xffffffff));
        assertEq(balancer.isValidSignature(bytes32(uint256(digest) ^ 1), ""), bytes4(0xffffffff));

        // the timestamp cannot smuggle extra lines or other characters
        vm.startPrank(creator);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        balancer.approvePoolPage("2026-11-10T12:34:56.78Z", metadataHash);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        balancer.approvePoolPage("2026-11-10\nPool: 0x0000Z", metadataHash);
        vm.stopPrank();
    }
}
