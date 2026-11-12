// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {BalancedRouterTest} from "./BalancedRouter.t.sol";
import {IShapes, IERC721Min} from "../../../../src/interfaces/External.sol";

contract RouterFullCycleTest is BalancedRouterTest {
    function testRealRouterWinRestockCloseUnlistWithdrawRedeem() public {
        (uint256 fee, uint256 vrf, uint256 total) = p.quoteAcquisitionPrice(1);
        assertEq(total, fee + vrf);
        uint256 version = p.inventoryVersion();
        uint256 payerBefore = PLAYER.balance;
        vm.prank(PLAYER, PLAYER);
        uint256 requestId = p.acquire{value: total}(
            PLAYER, fee, 0, 10_000, version, block.timestamp + 1 days
        );
        assertEq(payerBefore - PLAYER.balance, total);
        vm.roll(block.number + 1);
        uint256 trials = _deliverSelectingDenom(requestId, 0);
        (,,, uint256 lid, uint8 status,) = p.acquisitions(requestId);
        assertEq(status, 2);
        (uint8 kind, uint8 denom,,,) = b.items(lid);
        assertEq(kind, 2);
        assertEq(denom, 0);
        (,,, uint256 wonTokenId,,,,) = p.listings(lid);
        assertEq(IShapes(SHAPES).ownerOf(wonTokenId), PLAYER);
        assertEq(IShapes(SHAPES).backingOf(wonTokenId), 0.01 ether);

        vm.prank(KEEPER);
        b.performUpkeep();
        assertEq(b.reconciledSequence(), 1);
        uint16[16] memory have = b.getActiveShapes();
        assertEq(have[0], 20);
        uint256 shapesBeforeUnlist = SHAPES.balance;
        uint256 creatorBeforeClaim = CREATOR.balance;
        vm.prank(CREATOR);
        b.close();
        while (true) {
            uint256[] memory ids = b.getActiveIds();
            uint256[] memory chunk = new uint256[](20);
            uint256 n;
            for (uint256 i; i < ids.length && n < 20; ++i) {
                (uint8 itemKind,,,,) = b.items(ids[i]);
                if (itemKind == 2) chunk[n++] = ids[i];
            }
            if (n == 0) break;
            assembly ("memory-safe") { mstore(chunk, n) }
            vm.prank(CREATOR);
            b.unlistShapes(chunk);
        }
        assertEq(shapesBeforeUnlist - SHAPES.balance, 1.54 ether);
        uint256[] memory remaining = b.getActiveIds();
        assertEq(remaining.length, 1);
        vm.prank(CREATOR);
        b.withdrawCurated(remaining[0], CREATOR);
        assertEq(IERC721Min(BAYC).ownerOf(1), CREATOR);
        vm.prank(CREATOR);
        b.retire();
        assertEq(b.requiredReserve(), 0);
        uint256 reclaim = address(b).balance;
        vm.prank(CREATOR);
        b.claimSurplus(reclaim, CREATOR);
        assertEq(address(b).balance, 0);
        assertEq(CREATOR.balance - creatorBeforeClaim, reclaim);
        uint256 winnerBefore = PLAYER.balance;
        uint256[] memory wonIds = new uint256[](1);
        wonIds[0] = wonTokenId;
        vm.prank(PLAYER, PLAYER);
        assertEq(IShapes(SHAPES).redeemBatch(wonIds), 0.01 ether);
        assertEq(PLAYER.balance - winnerBefore, 0.01 ether);
        assertEq(shapesBeforeUnlist - SHAPES.balance, 1.55 ether);
        emit log_named_uint("wordTrials", trials);
        emit log_named_uint("playerPaid", total);
        emit log_named_uint("winnerRedeemed", 0.01 ether);
        emit log_named_uint("creatorReclaim", reclaim);
    }
}
