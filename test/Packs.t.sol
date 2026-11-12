// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";

interface IPacksView {
    function valueOf(uint256 packId) external view returns (uint256);
    function contentsOf(uint256 packId) external view returns (uint256[] memory);
    function ownerOf(uint256 packId) external view returns (address);
    function redeem(uint256 packId) external;
}

/// @dev Prize sizes 9-15 are Draw Packs. Target here: 4x0.01 Shape, 3x0.02 pack, 2x0.03 pack, 1x0.25 pack.
contract PacksTest is ForkBase {
    uint256 internal mixTarget;
    uint256 internal constant BACKING = 4 * 0.01 ether + 3 * 0.02 ether + 2 * 0.03 ether + 0.25 ether;

    function setUp() public {
        setUpFork();
        createBalancer(5 ether);
        listCurated(1, 0.3 ether);
        uint256[16] memory c;
        c[0] = 4;
        c[9] = 3;
        c[10] = 2;
        c[12] = 1;
        mixTarget = plan16(c);
        configure(mixTarget);
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertTrue(balancer.canPurchase(buyer), "open with packs");
    }

    function _listingOfSize(uint8 size) internal view returns (uint256 lid) {
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 d,,,) = balancer.items(ids[i]);
            if (kind == 2 && d == size) return ids[i];
        }
        revert("no listing of that size");
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

    function test_packsListedAtExactValueWithFewestShapes() public view {
        uint16[16] memory active = balancer.getActiveShapes();
        assertEq(active[0], 4);
        assertEq(active[9], 3);
        assertEq(active[10], 2);
        assertEq(active[12], 1);
        uint8[3] memory sizes = [uint8(9), 10, 12];
        uint256[3] memory values = [uint256(0.02 ether), 0.03 ether, 0.25 ether];
        uint256[3] memory shapeCounts = [uint256(2), 3, 3];
        for (uint256 k; k < 3; ++k) {
            uint256 lid = _listingOfSize(sizes[k]);
            (address collection,,, uint256 tokenId,,,, uint8 status) = pool.listings(lid);
            assertEq(collection, packs, "listed from the Packs contract");
            assertEq(status, 1, "active on FWA");
            assertEq(IPacksView(packs).ownerOf(tokenId), address(pool));
            assertEq(IPacksView(packs).valueOf(tokenId), values[k], "pack value");
            assertEq(IPacksView(packs).contentsOf(tokenId).length, shapeCounts[k], "fewest Shapes");
            (,,, uint112 base, uint112 price) = balancer.items(lid);
            assertEq(base, values[k] + shapeCounts[k] * shapes.mintFee(), "base is what the prize cost");
            assertEq(price, values[k] * (10_000 + MARKUP) / 10_000, "priced at the current markup");
        }
    }

    function test_drawnPackGoesToWinnerRedeemsExactlyAndIsReplaced() public {
        uint256 lid = _listingOfSize(12);
        (,,, uint256 tokenId,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        assertEq(IPacksView(packs).ownerOf(tokenId), buyer, "winner holds the pack");

        fillUp(); // reconcile and replace
        assertEq(balancer.getActiveShapes()[12], 1, "0.25 pack replaced");
        assertTrue(balancer.canPurchase(buyer));

        uint256 before = buyer.balance;
        vm.prank(buyer);
        IPacksView(packs).redeem(tokenId);
        assertEq(buyer.balance - before, 0.25 ether, "exact backing to the winner");
    }

    function test_unlistRedeemsPacksAndShapesForExactBacking() public {
        vm.prank(creator);
        balancer.close();
        uint256[] memory sids = _allShapeIds();
        uint256 before = address(balancer).balance;
        vm.prank(creator);
        balancer.unlistShapes(sids);
        uint16[16] memory active = balancer.getActiveShapes();
        for (uint256 d; d < 16; ++d) assertEq(active[d], 0);
        assertEq(address(balancer).balance - before, BACKING, "every prize redeemed at its backing");
    }

    /// A smaller target leaves surplus prizes listed; unlistShapes redeems them at exact backing.
    function test_smallerTargetThenUnlistSurplus() public {
        // drop the 0.25 pack from the target; current inventory now exceeds it
        uint256[16] memory c;
        c[0] = 4;
        c[9] = 3;
        c[10] = 2;
        configure(plan16(c));
        assertEq(balancer.creatorWork(), false, "no deficit, so no creator work");
        assertTrue(balancer.canPurchase(buyer), "still open with surplus listed");
        // upkeep restocks deficits only; the surplus 0.25 pack stays listed until unlisted
        vm.prank(keeper);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep();

        uint256 lid = _listingOfSize(12);
        uint256[] memory surplus = new uint256[](1);
        surplus[0] = lid;
        uint256 before = address(balancer).balance;
        vm.prank(creator);
        balancer.unlistShapes(surplus);
        assertEq(address(balancer).balance - before, 0.25 ether, "surplus 0.25 pack redeemed at backing");
        assertEq(balancer.getActiveShapes()[12], 0, "surplus removed");
    }

    function test_refundedPackRecoveredAndRedeemed() public {
        uint256 lid = _listingOfSize(12);
        (,,, uint256 tokenId,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        // Draw Packs only fail a transfer to itself, which the gate refuses; mock the delivery failing.
        vm.mockCallRevert(packs, abi.encodeWithSignature("transferFrom(address,address,uint256)", address(pool), buyer, tokenId), "blocked");
        fulfill(ids[0], wordForSlot(slot));
        settle();
        vm.clearMockedCalls();
        fillUp();
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(buyer);
        pool.refundFailedDelivery(lid);
        uint256 before = address(balancer).balance;
        vm.prank(creator);
        uint256 eth = balancer.recoverRefunded(lid, creator);
        assertEq(eth, 0.25 ether, "pack redeemed at its backing");
        assertEq(address(balancer).balance - before, 0.25 ether);
    }

    function test_packsContractRefusedAsPurchaserAndAsCurated() public {
        assertFalse(balancer.canPurchase(packs));
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.ShapesNotCurated.selector);
        balancer.listCurated(packs, 1, 0.1 ether);
    }

    function test_constructorRejectsPacksThatCannotMakeTheSmallestPack() public {
        address renderer = deployCode("out/ShapePackRenderer.sol/ShapePackRenderer.json", abi.encode(SHAPES));
        address threeUnit = deployCode("out/ShapePacks.sol/ShapePacks.json", abi.encode(SHAPES, renderer, makeAddr("a"), "P", "P", uint256(3)));
        vm.expectRevert(PoolBalancer.UnsupportedFWAConfig.selector);
        new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, threeUnit, ENS);
    }

    /// Reserve while open and fully reconciled: the single largest prize (0.25 pack = backing + 3 fees) for the
    /// implied draw plus a spare, and the keeper rewards for restoring 3 Shape units (ceil(3/6)+1 = 2 calls).
    function test_reserveHoldsLargestPrizeAndKeeperRewards() public view {
        uint256 fee = shapes.mintFee();
        uint256 largest = 0.25 ether + 3 * fee;
        uint256 expected = largest + 2 * balancer.MAX_KEEPER_REWARD();
        assertEq(balancer.requiredReserve(), expected);
    }

    function test_everyPackSizeMintsAtExactValueWithItsShapes() public {
        uint256[16] memory c;
        for (uint256 d = 9; d < 16; ++d) c[d] = 1;
        vm.prank(creator);
        balancer.depositETH{value: 60 ether}();
        configure(plan16(c));
        fillUp();
        assertTrue(balancer.canPurchase(buyer), "open with every pack size");
        uint256[7] memory values = [uint256(0.02 ether), 0.03 ether, 0.2 ether, 0.25 ether, 2 ether, 2.5 ether, 25 ether];
        uint256[7] memory counts = [uint256(2), 3, 2, 3, 2, 3, 3];
        for (uint256 k; k < 7; ++k) {
            (,,, uint256 tokenId,,,,) = pool.listings(_listingOfSize(uint8(9 + k)));
            assertEq(IPacksView(packs).valueOf(tokenId), values[k], "pack value");
            assertEq(IPacksView(packs).contentsOf(tokenId).length, counts[k], "Shapes inside");
        }
    }

    /// A worst batch of five drawn three-Shape packs is rebuilt and the pool reopens.
    function test_worstPackBatchRebuilds() public {
        uint256[16] memory c;
        c[0] = 2;
        c[10] = 6; // 0.03 packs, three Shapes each
        configure(plan16(c));
        fillUp();
        uint256 fee = shapes.mintFee();
        assertEq(balancer.requiredReserve(), (0.03 ether + 3 * fee) + 2 * balancer.MAX_KEEPER_REWARD(), "largest prize + 2 rewards");

        // draw five 0.03 packs in one batch
        uint256[] memory ids = buy(buyer, 5);
        uint256[] memory lids = balancer.getActiveIds();
        uint256 drawn;
        for (uint256 i; i < lids.length && drawn < 5; ++i) {
            (uint8 kind, uint8 d,,,) = balancer.items(lids[i]);
            if (kind != 2 || d != 10) continue;
            (,,,,,, uint256 slot,) = pool.listings(lids[i]);
            fulfill(ids[drawn++], wordForSlot(slot));
        }
        settle();
        fillUp();
        assertTrue(balancer.canPurchase(buyer), "reopened");
        assertEq(balancer.getActiveShapes()[10], 6, "all five packs restored");
    }
}
