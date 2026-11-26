// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LibString} from "solady/utils/LibString.sol";

import {ForkBase} from "./utils/ForkBase.sol";
import {FreezableNFT} from "./utils/Mocks.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {ListOne} from "./utils/ListOne.sol";

using ListOne for PoolBalancer;

/// @dev Real FWA custody and withdrawal paths; creator-listed arbitrary collections are counterparties, not protocol substitutes.
interface IReverseLookup {
    function resolver(bytes32 node) external view returns (address);
    function name(bytes32 node) external view returns (string memory);
}

contract InventoryBatchesTest is ForkBase {
    event ENSNameSet(string name);
    uint256[] internal ids;

    function setUp() public {
        setUpFork();
        createBalancer(1 ether);
        ids.push(listCurated(11, 0.2 ether));
        ids.push(listCurated(12, 0.3 ether));
    }

    function test_withdrawBatchReturnsExactNFTsAndClearsInventory() public {
        uint256 version = pool.inventoryVersion();
        uint256 cash = address(balancer).balance;
        vm.prank(creator);
        balancer.withdrawCuratedBatch(ids, stranger);
        assertEq(nft.ownerOf(11), stranger);
        assertEq(nft.ownerOf(12), stranger);
        assertEq(balancer.getActiveIds().length, 0);
        assertEq(pool.activeListingCount(), 0);
        assertEq(pool.inventoryVersion(), version + 1, "one FWA batch mutation");
        assertEq(address(balancer).balance, cash, "curated withdrawals move no ETH");
        assertEq(balancer.inventoryBatchVersion(), 2);
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = balancer.items(ids[i]);
            (,,,,,,, uint8 status) = pool.listings(ids[i]);
            assertEq(kind, 0);
            assertEq(status, 3, "FWA Withdrawn");
        }
    }

    function test_repriceBatchSetsAbsoluteValuesWithoutMarkup() public {
        uint256[] memory values = new uint256[](2);
        values[0] = 0.4 ether;
        values[1] = 0.6 ether;
        vm.prank(creator);
        balancer.updateCuratedPricesBatch(ids, values);
        for (uint256 i; i < ids.length; ++i) {
            (,,, uint112 base, uint112 price) = balancer.items(ids[i]);
            (,,,,, uint256 actual,,) = pool.listings(ids[i]);
            assertEq(base, values[i]);
            assertEq(price, values[i]);
            assertEq(actual, values[i]);
        }
    }

    function test_allBatchEntryPointsRequireCreator() public {
        uint256[] memory values = new uint256[](2);
        vm.startPrank(stranger);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.withdrawCuratedBatch(ids, stranger);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.updateCuratedPricesBatch(ids, values);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.recoverRefundedBatch(ids, stranger);
        vm.stopPrank();
    }

    function test_batchBoundsAndDuplicateIds() public {
        uint256[] memory empty = new uint256[](0);
        uint256[] memory large = new uint256[](21);
        uint256[] memory duplicate = new uint256[](2);
        duplicate[0] = ids[0];
        duplicate[1] = ids[0];
        vm.startPrank(creator);
        vm.expectRevert(PoolBalancer.InvalidBatch.selector);
        balancer.withdrawCuratedBatch(empty, creator);
        vm.expectRevert(PoolBalancer.InvalidBatch.selector);
        balancer.withdrawCuratedBatch(large, creator);
        vm.expectRevert(PoolBalancer.InvalidBatch.selector);
        balancer.withdrawCuratedBatch(duplicate, creator);
        vm.expectRevert(PoolBalancer.InvalidBatch.selector);
        balancer.updateCuratedPricesBatch(ids, empty);
        vm.expectRevert(PoolBalancer.InvalidBatch.selector);
        balancer.updateCuratedPricesBatch(empty, empty);
        vm.expectRevert(PoolBalancer.InvalidBatch.selector);
        balancer.updateCuratedPricesBatch(large, large);
        vm.expectRevert(PoolBalancer.InvalidBatch.selector);
        balancer.updateCuratedPricesBatch(duplicate, duplicate);
        vm.expectRevert(PoolBalancer.InvalidBatch.selector);
        balancer.recoverRefundedBatch(empty, creator);
        vm.expectRevert(PoolBalancer.InvalidBatch.selector);
        balancer.recoverRefundedBatch(large, creator);
        vm.expectRevert(PoolBalancer.InvalidBatch.selector);
        balancer.recoverRefundedBatch(duplicate, creator);
        vm.stopPrank();
    }

    function test_repriceFailureRollsBackEarlierPrice() public {
        uint256[] memory values = new uint256[](2);
        values[0] = 0.8 ether;
        values[1] = 0;
        uint256 version = pool.inventoryVersion();
        vm.prank(creator);
        vm.expectRevert();
        balancer.updateCuratedPricesBatch(ids, values);
        (,,, uint112 base, uint112 price) = balancer.items(ids[0]);
        (,,,,, uint256 actual,,) = pool.listings(ids[0]);
        assertEq(base, 0.2 ether);
        assertEq(price, 0.2 ether);
        assertEq(actual, 0.2 ether);
        assertEq(pool.inventoryVersion(), version);
    }

    function test_withdrawRejectsInvalidRecipientAndNonCuratedListing() public {
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidRecipient.selector);
        balancer.withdrawCuratedBatch(ids, address(0));
        uint256[] memory invalid = new uint256[](2);
        invalid[0] = ids[0];
        invalid[1] = type(uint256).max;
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidItem.selector);
        balancer.withdrawCuratedBatch(invalid, creator);
        assertEq(nft.ownerOf(11), address(pool));
        assertEq(balancer.getActiveIds().length, 2);
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidItem.selector);
        balancer.recoverRefundedBatch(ids, creator);
    }

    function test_refusingCollectionRollsBackBatchAndSingleWithdrawalStillWorks() public {
        FreezableNFT frozen = new FreezableNFT();
        frozen.mint(creator, 99);
        vm.startPrank(creator);
        frozen.approve(address(balancer), 99);
        uint256 lid = balancer.listCurated(address(frozen), 99, 0.5 ether);
        vm.stopPrank();
        frozen.setFrozen(true);
        uint256[] memory batch = new uint256[](2);
        batch[0] = ids[0];
        batch[1] = lid;
        uint256 version = pool.inventoryVersion();
        vm.prank(creator);
        vm.expectRevert();
        balancer.withdrawCuratedBatch(batch, creator);
        assertEq(nft.ownerOf(11), address(pool));
        assertEq(frozen.ownerOf(99), address(pool));
        assertEq(balancer.getActiveIds().length, 3);
        assertEq(pool.activeListingCount(), 3);
        assertEq(pool.inventoryVersion(), version);
        vm.prank(creator);
        balancer.withdrawCurated(ids[0], creator);
        assertEq(nft.ownerOf(11), creator);
    }

    function test_reverseNameExtractionPreservesBalancerIdentity() public {
        vm.expectEmit(address(balancer));
        emit ENSNameSet("inventory-batches.eth");
        vm.prank(creator);
        balancer.setENSName("inventory-batches.eth");
        bytes32 node = keccak256(abi.encodePacked(
            bytes32(0x91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2),
            keccak256(bytes(LibString.toHexStringNoPrefix(address(balancer))))));
        address resolver = IReverseLookup(ENS).resolver(node);
        assertEq(IReverseLookup(resolver).name(node), "inventory-batches.eth");
        vm.prank(creator);
        balancer.setENSName("");
        assertEq(IReverseLookup(resolver).name(node), "");
    }

    function test_withdrawMaximumBatch() public {
        PoolBalancer.CuratedInput[] memory items = new PoolBalancer.CuratedInput[](20);
        for (uint256 i; i < items.length; ++i) {
            nft.mint(creator, 100 + i);
            items[i] = PoolBalancer.CuratedInput(address(nft), 100 + i, 0.2 ether);
        }
        vm.startPrank(creator);
        nft.setApprovalForAll(address(balancer), true);
        uint256[] memory batch = balancer.listCuratedBatch(items);
        balancer.withdrawCuratedBatch(batch, creator);
        vm.stopPrank();
        for (uint256 i; i < items.length; ++i) assertEq(nft.ownerOf(100 + i), creator);
        assertEq(balancer.getActiveIds().length, 2);
    }

    function test_shapeRejectedAndPendingRealDrawLocksCuratedBatches() public {
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256[] memory active = balancer.getActiveIds();
        uint256[] memory shape = new uint256[](1);
        for (uint256 i; i < active.length; ++i) {
            (uint8 kind,,,,) = balancer.items(active[i]);
            if (kind == 2) shape[0] = active[i];
        }
        assertTrue(shape[0] != 0, "real Shape listed through maintenance");
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidItem.selector);
        balancer.withdrawCuratedBatch(shape, creator);

        buy(buyer, 1); // Real request; no fabricated randomness or protocol state.
        assertEq(pool.unsettledAcquisitionCount(), 1);
        uint256[] memory values = new uint256[](2);
        values[0] = 0.4 ether;
        values[1] = 0.6 ether;
        vm.startPrank(creator);
        vm.expectRevert(bytes4(keccak256("WithdrawLocked()")));
        balancer.withdrawCuratedBatch(ids, creator);
        vm.expectRevert(bytes4(keccak256("WithdrawLocked()")));
        balancer.updateCuratedPricesBatch(ids, values);
        vm.stopPrank();
        assertEq(nft.ownerOf(11), address(pool));
        (,,, uint112 base,) = balancer.items(ids[0]);
        assertEq(base, 0.2 ether);
    }
}
