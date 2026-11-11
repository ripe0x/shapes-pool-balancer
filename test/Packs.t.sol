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

/// @dev Prize sizes 9-15 are Draw Packs. Plan here: 4x0.01 Shape, 3x0.02 pack, 2x0.03 pack, 1x0.25 pack.
contract PacksTest is ForkBase {
    uint256 internal mixPlan;
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
        mixPlan = plan16(c);
        uint256[] memory plans = new uint256[](1);
        plans[0] = mixPlan;
        configure(1 ether, 10, plans);
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
            (address collection,,, uint256 tokenId,,, , uint8 status) = pool.listings(lid);
            assertEq(collection, packs, "listed from the Packs contract");
            assertEq(status, 1, "active on FWA");
            assertEq(IPacksView(packs).ownerOf(tokenId), address(pool));
            assertEq(IPacksView(packs).valueOf(tokenId), values[k], "pack value");
            assertEq(IPacksView(packs).contentsOf(tokenId).length, shapeCounts[k], "fewest Shapes");
            (,,, uint112 base, uint112 price) = balancer.items(lid);
            assertEq(base, values[k]);
            assertEq(price, values[k] * (10_000 + MARKUP) / 10_000, "priced like any prize");
        }
    }

    function test_drawnPackGoesToWinnerRedeemsExactlyAndIsReplaced() public {
        uint256 lid = _listingOfSize(12);
        (,,, uint256 tokenId,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        assertEq(IPacksView(packs).ownerOf(tokenId), buyer, "winner holds the pack");

        upkeep(); // reconcile and replace
        for (uint256 i; i < 5 && balancer.admissionStatus() == 2; ++i) upkeep();
        assertEq(balancer.getActiveShapes()[12], 1, "0.25 pack replaced");
        assertTrue(balancer.canPurchase(buyer));

        uint256 before = buyer.balance;
        vm.prank(buyer);
        IPacksView(packs).redeem(tokenId);
        assertEq(buyer.balance - before, 0.25 ether, "exact backing to the winner");
    }

    function test_unwindRedeemsPacksAndShapesForExactBacking() public {
        vm.prank(creator);
        balancer.close();
        uint256 before = address(balancer).balance;
        for (uint256 i; i < 5; ++i) {
            vm.prank(creator);
            balancer.unwind(20);
        }
        uint16[16] memory active = balancer.getActiveShapes();
        for (uint256 d; d < 16; ++d) assertEq(active[d], 0);
        assertEq(address(balancer).balance - before, BACKING, "every prize redeemed at its backing");
    }

    function test_planSwitchRedeemsSurplusPacks() public {
        uint256[16] memory c;
        c[0] = 4;
        c[9] = 1; // two 0.02 packs fewer
        uint256[] memory plans = new uint256[](1);
        plans[0] = plan16(c);
        configure(1 ether, 10, plans);
        uint256 before = address(balancer).balance;
        fillUp();
        uint16[16] memory active = balancer.getActiveShapes();
        assertEq(active[9], 1);
        assertEq(active[10], 0);
        assertEq(active[12], 0);
        assertTrue(balancer.canPurchase(buyer));
        // 2x0.02 + 2x0.03 + 0.25 redeemed, minus the keeper rewards paid from the balance
        assertGt(address(balancer).balance, before + 0.3 ether, "surplus packs came back as ETH");
    }

    function test_refundedPackRecoveredAndRedeemed() public {
        uint256 lid = _listingOfSize(12);
        (,,, uint256 tokenId,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        // Draw Packs only fails a transfer to itself, which the gate refuses; mock the delivery failing.
        vm.mockCallRevert(packs, abi.encodeWithSignature("transferFrom(address,address,uint256)", address(pool), buyer, tokenId), "blocked");
        fulfill(ids[0], wordForSlot(slot));
        settle();
        vm.clearMockedCalls();
        upkeep();
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(buyer);
        pool.refundFailedDelivery(lid);
        uint256 before = address(balancer).balance;
        vm.prank(stranger, stranger);
        uint256 reward = balancer.recoverRefundedShape(lid);
        assertEq(address(balancer).balance + reward - before, 0.25 ether, "pack redeemed at its backing");
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

    function test_reserveTakesTheFiveLargestValues() public view {
        // largest five: 0.25, 0.03, 0.03, 0.02, 0.02; each charged three mint fees
        uint256 fee = shapes.mintFee();
        uint256 expected = 0.25 ether + 2 * 0.03 ether + 2 * 0.02 ether + 5 * 3 * fee + balancer.MAX_KEEPER_REWARD();
        (,,,, uint256 reserve) = balancer.checkpoint();
        assertEq(reserve, expected);
    }
}
