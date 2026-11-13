// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../src/BalancerFactory.sol";
import {IFWAPool, IShapes, IERC721Min} from "../../../src/interfaces/External.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";

contract IntegrationForkTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant BAYC = 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;

    // BAYC #1 is owned by this EOA at both pinned fork blocks.
    address creator = 0x46EFbAedc92067E6d60E84ED6395099723252496;
    address keeper = address(0xB0B);
    address player = address(0xC0FFEE);

    PoolBalancer bal;
    IFWAPool pool;
    ShapePacks packs;

    function setUp() public {
        vm.deal(creator, 5 ether);
        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        packs = new ShapePacks(SHAPES, address(renderer), address(this), "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer implementation = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        BalancerFactory factory = new BalancerFactory(address(implementation), address(this));
        vm.prank(creator);
        bal = PoolBalancer(payable(factory.createBalancer{value: 1 ether}(bytes32("round8-integration"))));
        pool = bal.pool();
        assertEq(pool.owner(), address(bal));
        assertEq(pool.purchaseOperator(), address(bal));
        assertEq(address(bal).balance, 1 ether);
    }

    function testMintListWithdrawRedeemRoundTrip() public {
        uint256 target = 1 | (uint256(1) << (16 * 9)); // one 0.01 Shape, one 0.02 pack
        uint256 fee = IShapes(SHAPES).mintFee();
        uint256 backing = 0.03 ether;
        uint256 mintFees = 3 * fee;
        vm.prank(creator);
        bal.configure(1_000, target);
        vm.prank(creator);
        bal.open();

        uint256 balBefore = address(bal).balance;
        uint256 keeperBefore = keeper.balance;
        vm.prank(keeper);
        uint256 reward = bal.performUpkeep();
        assertEq(keeper.balance - keeperBefore, reward);
        assertEq(address(bal).balance, balBefore - backing - mintFees - reward);
        assertEq(pool.activeListingCount(), 2);
        assertEq(bal.getActiveIds().length, 2);

        uint256[] memory ids = bal.getActiveIds();
        bool foundShape;
        bool foundPack;
        for (uint256 i; i < ids.length; ++i) {
            (address collection,,, uint256 tokenId,,,,) = pool.listings(ids[i]);
            if (collection == SHAPES) {
                foundShape = true;
                assertEq(IShapes(SHAPES).ownerOf(tokenId), address(pool));
                assertEq(IShapes(SHAPES).backingOf(tokenId), 0.01 ether);
            } else if (collection == address(packs)) {
                foundPack = true;
                assertEq(packs.ownerOf(tokenId), address(pool));
                assertEq(packs.valueOf(tokenId), 0.02 ether);
            } else {
                fail("unexpected collection");
            }
        }
        assertTrue(foundShape && foundPack);

        vm.prank(creator);
        bal.close();
        uint256 beforeRedeem = address(bal).balance;
        vm.prank(creator);
        bal.unlistShapes(ids);
        assertEq(address(bal).balance - beforeRedeem, backing);
        assertEq(pool.activeListingCount(), 0);
        assertEq(bal.getActiveIds().length, 0);
        assertEq(bal.withdrawableSurplus(), address(bal).balance);

        uint256 creatorBefore = creator.balance;
        uint256 remainder = address(bal).balance;
        vm.prank(creator);
        bal.claimSurplus(remainder, creator);
        assertEq(creator.balance - creatorBefore, remainder);
        assertEq(address(bal).balance, 0);
        assertEq(1 ether - reward - mintFees, remainder);
    }

    function testRealCuratedListingAndPurchaseGate() public {
        assertEq(IERC721Min(BAYC).ownerOf(1), creator);
        vm.prank(creator);
        IERC721Min(BAYC).approve(address(bal), 1);
        vm.prank(creator);
        uint256 curatedId = bal.listCurated(BAYC, 1, 0.02 ether);
        assertEq(IERC721Min(BAYC).ownerOf(1), address(pool));

        vm.prank(creator);
        bal.configure(1_000, uint256(1) | (uint256(1) << (16 * 9)));
        vm.prank(creator);
        bal.open();
        vm.prank(keeper);
        bal.performUpkeep();
        assertEq(bal.admissionStatus(), 0);
        assertFalse(bal.canPurchase(address(bal)));
        assertFalse(bal.canPurchase(SHAPES));
        assertFalse(bal.canPurchase(address(packs)));
        assertFalse(bal.canPurchase(address(pool)));
        assertTrue(bal.canPurchase(player));

        (uint256 fee, uint256 vrf, uint256 total) = pool.quoteAcquisitionPrice(1);
        assertEq(total, fee + vrf);
        vm.deal(player, total + 1 ether);
        uint256 version = pool.inventoryVersion();
        vm.prank(player);
        uint256 requestId = pool.acquire{value: total}(player, fee, 0, 10_000, version, block.timestamp + 1 hours);
        (address purchaser,, uint256 escrowed,, uint8 status,) = pool.acquisitions(requestId);
        assertEq(purchaser, player);
        assertEq(escrowed, fee);
        assertEq(status, 1); // FWA pending fulfillment
        assertEq(pool.unsettledAcquisitionCount(), 1);
        assertEq(IERC721Min(BAYC).ownerOf(1), address(pool));
        (uint8 kind,,,,) = bal.items(curatedId);
        assertEq(kind, 1);

        uint256[] memory words = new uint256[](1);
        words[0] = 0;
        vm.prank(0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d); // live FWA VRF coordinator
        pool.rawFulfillRandomWords(requestId, words);
        pool.processAcquisitions(1);
        (,,, uint256 wonListing, uint8 finalStatus,) = pool.acquisitions(requestId);
        assertEq(finalStatus, 2);
        assertGt(wonListing, 0);
        assertEq(pool.unsettledAcquisitionCount(), 0);

        vm.prank(keeper);
        bal.performUpkeep();
        assertEq(bal.reconciledSequence(), 1);
        (uint8 wonKind,,,,) = bal.items(wonListing);
        assertEq(wonKind, 0); // delivered items leave Balancer tracking
    }

    function testShapeWinAndExactRedemption() public {
        _prizeWinAndRedeem(60 ether, SHAPES, 0.01 ether);
    }

    function testPackWinAndExactRedemption() public {
        _prizeWinAndRedeem(150 ether, address(packs), 0.02 ether);
    }

    function testEightyShapeOpenAndCloseout() public {
        assertEq(IERC721Min(BAYC).ownerOf(1), creator);
        vm.prank(creator);
        IERC721Min(BAYC).approve(address(bal), 1);
        vm.prank(creator);
        uint256 curatedId = bal.listCurated(BAYC, 1, 0.02 ether);
        vm.prank(creator);
        bal.configure(1_000, 80);
        vm.prank(creator);
        bal.open();

        uint256 rewards;
        for (uint256 i; i < 16; ++i) {
            vm.prank(keeper);
            rewards += bal.performUpkeep();
        }
        assertEq(bal.getActiveIds().length, 81);
        assertEq(pool.activeListingCount(), 81);
        assertEq(bal.admissionStatus(), 0);
        uint256 fees = 80 * IShapes(SHAPES).mintFee();
        assertEq(address(bal).balance, 1 ether - 0.8 ether - fees - rewards);

        vm.prank(creator);
        bal.close();
        uint256[] memory all = bal.getActiveIds();
        uint256[] memory batch = new uint256[](20);
        uint256 cursor;
        for (uint256 i; i < all.length; ++i) {
            if (all[i] == curatedId) continue;
            batch[cursor++ % 20] = all[i];
            if (cursor % 20 == 0) {
                vm.prank(creator);
                bal.unlistShapes(batch);
            }
        }
        assertEq(cursor, 80);
        assertEq(pool.activeListingCount(), 1);
        assertEq(address(bal).balance, 1 ether - fees - rewards);
        vm.prank(creator);
        bal.withdrawCurated(curatedId, creator);
        assertEq(IERC721Min(BAYC).ownerOf(1), creator);
        assertEq(pool.activeListingCount(), 0);
        uint256 creatorBefore = creator.balance;
        uint256 remainder = address(bal).balance;
        vm.prank(creator);
        bal.claimSurplus(remainder, creator);
        assertEq(creator.balance - creatorBefore, remainder);
        assertEq(address(bal).balance, 0);
    }

    function testRetireThenUnlistAndRedeem() public {
        vm.prank(creator);
        bal.configure(1_000, uint256(1) | (uint256(1) << (16 * 9)));
        vm.prank(creator);
        bal.open();
        vm.prank(keeper);
        bal.performUpkeep();
        uint256[] memory ids = bal.getActiveIds();
        vm.prank(creator);
        bal.close();
        vm.prank(creator);
        bal.retire();
        assertTrue(pool.retired());
        uint256 before = address(bal).balance;
        vm.prank(creator);
        bal.unlistShapes(ids);
        assertEq(address(bal).balance - before, 0.03 ether);
        assertEq(pool.activeListingCount(), 0);
    }

    function _prizeWinAndRedeem(uint256 word, address expectedCollection, uint256 expectedBacking) internal {
        assertEq(IERC721Min(BAYC).ownerOf(1), creator);
        vm.prank(creator);
        IERC721Min(BAYC).approve(address(bal), 1);
        vm.prank(creator);
        bal.listCurated(BAYC, 1, 0.02 ether);
        vm.prank(creator);
        bal.configure(1_000, uint256(1) | (uint256(1) << (16 * 9)));
        vm.prank(creator);
        bal.open();
        vm.prank(keeper);
        bal.performUpkeep();
        assertEq(bal.admissionStatus(), 0);

        (uint256 fee,, uint256 total) = pool.quoteAcquisitionPrice(1);
        vm.deal(player, total + 1 ether);
        vm.prank(player);
        uint256 requestId = pool.acquire{value: total}(
            player, fee, 0, 10_000, pool.inventoryVersion(), block.timestamp + 1 hours
        );
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        vm.prank(0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d);
        pool.rawFulfillRandomWords(requestId, words);
        (,,, uint256 wonListing, uint8 status,) = pool.acquisitions(requestId);
        assertEq(status, 2);
        (address collection,,, uint256 tokenId,,,,) = pool.listings(wonListing);
        assertEq(collection, expectedCollection);
        assertEq(IERC721Min(collection).ownerOf(tokenId), player);

        uint256 playerBeforeRedeem = player.balance;
        vm.prank(player);
        if (collection == SHAPES) {
            uint256[] memory tokenIds = new uint256[](1);
            tokenIds[0] = tokenId;
            IShapes(SHAPES).redeemBatch(tokenIds);
        } else {
            packs.redeem(tokenId);
        }
        assertEq(player.balance - playerBeforeRedeem, expectedBacking);

        uint256 balBefore = address(bal).balance;
        uint256 proceeds = pool.ownerProceeds();
        vm.prank(keeper);
        uint256 reward = bal.performUpkeep();
        assertEq(bal.reconciledSequence(), 1);
        assertEq(pool.ownerProceeds(), 0);
        assertEq(pool.activeListingCount(), 3);
        assertEq(bal.getActiveIds().length, 3);
        assertEq(IERC721Min(BAYC).ownerOf(1), address(pool));
        assertLt(address(bal).balance, balBefore + proceeds); // restocking and keeper pay spend ETH
        assertGt(reward, 0);
    }
}
