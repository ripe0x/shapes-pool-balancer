// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {AddendumBase, IVRFService} from "../lane_a/addendum/AddendumBase.sol";
import {RevertOnDeliverNFT} from "../lane_a/addendum/RefundPath.t.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {IFWAPool} from "../../../src/interfaces/External.sol";

interface IFWARefund {
    function withdrawAcquisitionRefund() external;
}

/// Appended focused item: failed curated delivery + refund, full wei ledger for every party, real coordinator->VRF
/// route. Board is one 1-ETH Shape (heavy = low draw weight) plus the hostile 0.3 curated, so the hostile curated is
/// drawn with high odds. Its delivery reverts (RevertOnDeliverNFT) -> FWA failed delivery -> PENDING -> after 7 days
/// the player refunds -> creator recoverRefunded returns the NFT.
contract CuratedRefundLedgerTestWithdraw is AddendumBase {
    uint256 lastFee;
    uint256 lastVrf;
    uint256 lastTotal;

    function _acquirePlayer(PoolBalancer b) internal returns (uint256 coordReqId) {
        IFWAPool p = b.pool();
        (uint256 fee, uint256 vrf, uint256 total) = p.quoteAcquisitionPrice(1);
        lastFee = fee;
        lastVrf = vrf;
        lastTotal = total;
        // player is pre-funded once in the test; they pay from their own balance so auto-refunds are observable.
        uint256 iv = p.inventoryVersion();
        vm.recordLogs();
        vm.prank(player);
        p.acquire{value: total}(player, fee, 0, 10_000, iv, block.timestamp + 1000);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == VRF_COORDINATOR && logs[i].topics[0] == REQ_TOPIC) {
                coordReqId = abi.decode(logs[i].data, (uint256));
                found = true;
            }
        }
        require(found, "no coord request");
    }

    function _setupHostile(PoolBalancer b) internal returns (uint256 badLid, RevertOnDeliverNFT bad) {
        vm.prank(creator);
        b.configure(3000, one(D_1, 1)); // one 1-ETH shape: heavy, low draw weight
        vm.deal(address(b), 6 ether);
        vm.prank(creator);
        b.open();
        upkeep(b);
        bad = new RevertOnDeliverNFT();
        bad.mint(creator, 1);
        bad.allow(address(b), address(b.pool())); // allow pull + list; block delivery to winner
        vm.prank(creator);
        bad.setApprovalForAll(address(b), true);
        vm.prank(creator);
        badLid = b.listCurated(address(bad), 1, 0.3 ether);
        upkeep(b);
        require(b.admissionStatus() == 0, "not admitting");
    }

    function testCuratedRefundLedgerHealthy() public {
        PoolBalancer b = newBalancer();
        IFWAPool p = b.pool();
        (uint256 badLid, RevertOnDeliverNFT bad) = _setupHostile(b);
        vm.deal(player, 1000 ether);
        uint256 playerStart = player.balance;

        // Draw until the hostile curated is hit (becomes PENDING after reconcile).
        bool failed;
        for (uint256 w = 1; w <= 60 && !failed; ++w) {
            uint256 s = vm.snapshotState();
            uint256 req = _acquirePlayer(b);
            fulfillReq(req, uint256(keccak256(abi.encode("bad", w))));
            vm.prank(keeper);
            b.performUpkeep();
            (,, uint8 st,,) = b.items(badLid);
            if (st == 2) failed = true;
            else vm.revertToState(s);
        }
        require(failed, "hostile curated not drawn");
        console.log("player paid from own balance; auto-refund at failure (player loss so far):",
            playerStart - player.balance);

        // ---- Ledger ----
        console.log("== player payment ==");
        console.log("  acquisition fee / vrf fee / total paid:", lastFee, lastVrf, lastTotal);
        console.log("== pool/balancer after reconcile (PENDING failed draw) ==");
        uint256 proceeds = p.ownerProceeds();
        console.log("  FWA ownerProceeds credited for draw:", proceeds);
        console.log("  balancer balance:", address(b).balance);
        console.log("  profit / keeperCredit:", uint256(b.profit()), uint256(b.keeperCredit()));
        console.log("  requiredReserve:", b.requiredReserve());

        // The failed draw credits the pool no proceeds and no profit: the payment is escrowed by FWA for the player.
        assertEq(proceeds, 0, "no FWA proceeds from a failed delivery");
        assertEq(uint256(b.profit()), 0, "balancer books no profit from the failed draw");

        // Keepers earn nothing from this draw: no restock (a curated draw creates no shape deficit), credit stays 0.
        assertEq(uint256(b.keeperCredit()), 0, "no keeper credit from the failed draw");

        // ---- 7-day refund: player reclaims the acquisition fee (VRF fee is spent/lost) ----
        vm.warp(block.timestamp + 7 days + 1);
        uint256 playerBefore = player.balance;
        vm.prank(player);
        p.refundFailedDelivery(badLid);
        uint256 refundedNow = player.balance - playerBefore;
        uint256 totalLoss = playerStart - player.balance; // net across the whole life of the draw
        uint256 totalRefunded = lastTotal - totalLoss;
        (,,,,,,, uint8 fwaStatus) = p.listings(badLid);
        console.log("== refund (FWA-internal) ==");
        console.log("  ETH returned by refundFailedDelivery call:", refundedNow);
        console.log("  player TOTAL recovered:", totalRefunded);
        console.log("  player net loss over the whole draw:", totalLoss);
        console.log("  FWA listing status after refund call:", fwaStatus);
        // The refund call itself returns the player 0 in this harness; the acquisition
        // payment refund is FWA-internal (FWA pool source not in the repo). The player's loss here equals the full
        // amount paid, not just VRF. This reproduces and sharpens lane A open-question 2 with an exact figure; it is an
        // FWA mechanism to confirm against FWA source, not a Balancer defect (the Balancer books/holds none of it).
        // FWA refunds by pull: the refund call credits the player, who then withdraws it.
        uint256 beforeWithdraw = player.balance;
        vm.prank(player);
        IFWARefund(address(p)).withdrawAcquisitionRefund();
        uint256 withdrawn = player.balance - beforeWithdraw;
        totalLoss = playerStart - player.balance;
        console.log("  ETH returned by withdrawAcquisitionRefund:", withdrawn);
        console.log("  player net loss after withdrawing the refund:", totalLoss);
        assertEq(withdrawn, lastFee, "player gets back exactly the acquisition fee");
        assertEq(totalLoss, lastTotal - lastFee, "player loses only the VRF fee");

        // ---- Creator recovers the NFT ----
        bad.allow(address(b), creator); // now permit delivery to the creator
        uint256 balBefore = address(b).balance;
        vm.prank(creator);
        uint256 ethOut = b.recoverRefunded(badLid, creator);
        console.log("== recover ==");
        console.log("  recoverRefunded ethOut (0 for a curated NFT):", ethOut);
        console.log("  balancer balance delta on recover:", address(b).balance - balBefore);
        assertEq(bad.ownerOf(1), creator, "curated NFT ends at the creator");
        assertEq(ethOut, 0, "curated recovery returns the NFT, no ETH");
        (,, uint8 stAfter,,) = b.items(badLid);
        assertEq(stAfter, 0, "item cleared, nothing tracked/stranded");

        // Nothing stranded: the balancer owns no leftover of this NFT, holds no escrow, and its ETH is untouched by
        // the failed draw (all player money flowed player -> FWA escrow -> player).
        assertEq(address(b).balance, balBefore, "balancer ETH untouched by the failed draw/refund");
    }
}
