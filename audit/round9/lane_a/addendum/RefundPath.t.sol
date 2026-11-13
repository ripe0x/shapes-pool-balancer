// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {AddendumBase, IVRFService} from "./AddendumBase.sol";
import {PoolBalancer} from "../../../../src/PoolBalancer.sol";
import {IFWAPool} from "../../../../src/interfaces/External.sol";

/// A hostile purchaser/receiver that rejects NFT delivery (reverts in onERC721Received) and refuses ETH. A legitimate
/// adversary, not a protocol stand-in. It can still call FWA.acquire (canPurchase only bars this/Shapes/Packs/pool).
contract HostileReceiver {
    bool public rejectNfts = true;

    function acquire(IFWAPool p, uint256 fee, uint256 total, uint256 iv) external payable returns (uint256) {
        return p.acquire{value: total}(address(this), fee, 0, 10_000, iv, block.timestamp + 1000);
    }

    function setReject(bool v) external {
        rejectNfts = v;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        require(!rejectNfts, "reject");
        return this.onERC721Received.selector;
    }

    receive() external payable {
        revert("no eth");
    }
}

/// A curated collection that allows listing moves (to the balancer, to the pool) but REVERTS when FWA delivers to the
/// winner, forcing a failed delivery. Legitimate adversary (a creator could list from a weird collection).
contract RevertOnDeliverNFT {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    address public allowA;
    address public allowB;

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
    }

    function allow(address a, address bb) external {
        allowA = a;
        allowB = bb;
    }

    function approve(address to, uint256 id) external {
        getApproved[id] = to;
    }

    function setApprovalForAll(address op, bool ok) external {
        isApprovedForAll[msg.sender][op] = ok;
    }

    function transferFrom(address from, address to, uint256 id) public {
        require(to == allowA || to == allowB, "blocked delivery");
        ownerOf[id] = to;
        getApproved[id] = address(0);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        transferFrom(from, to, id);
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

/// Failed-delivery / refund path with a hostile winner, tracing where every wei ends.
contract RefundPath is AddendumBase {
    function testDeliveryFailureRefundLedger() public {
        PoolBalancer b = newBalancer();
        IFWAPool p = b.pool();
        vm.prank(creator);
        b.configure(3000, one(D_001, 5));
        vm.deal(address(b), 20 ether);
        vm.prank(creator);
        b.open();
        upkeep(b);
        listNewCurated(b, 0.3 ether);
        upkeep(b);
        require(b.admissionStatus() == 0, "not admitting");

        HostileReceiver eve = new HostileReceiver();
        (uint256 fee,, uint256 total) = p.quoteAcquisitionPrice(1);
        vm.deal(address(eve), total);
        uint256 iv = p.inventoryVersion();

        // acquire as the hostile receiver, capture the coordinator requestId, deliver through the real route.
        vm.recordLogs();
        eve.acquire(p, fee, total, iv);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 reqId;
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == VRF_COORDINATOR && logs[i].topics[0] == REQ_TOPIC) {
                reqId = abi.decode(logs[i].data, (uint256));
                found = true;
            }
        }
        require(found, "no coord request");

        uint256[] memory activeBefore = b.getActiveIds();
        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("refund"));
        vm.prank(VRF_COORDINATOR);
        IVRFService(VRF_SERVICE).rawFulfillRandomWords(reqId, words);

        // Reconcile on the Balancer: a hostile receiver must not brick reconciliation.
        vm.prank(keeper);
        b.performUpkeep();

        // Identify the drawn listing = the id that left activeIds.
        uint256 drawnLid;
        {
            uint256[] memory activeAfter = b.getActiveIds();
            for (uint256 i; i < activeBefore.length; ++i) {
                bool still;
                for (uint256 j; j < activeAfter.length; ++j) {
                    if (activeAfter[j] == activeBefore[i]) still = true;
                }
                if (!still) drawnLid = activeBefore[i];
            }
        }
        require(drawnLid != 0, "no drawn listing identified");
        (uint8 kind, uint8 denom, uint8 state,,) = b.items(drawnLid);
        console.log("drawn lid:", drawnLid);
        console.log("drawn item kind/denom/state:", kind, denom, state);
        (,,,,,,, uint8 fwaStatus) = p.listings(drawnLid);
        console.log("FWA listing status:", fwaStatus);

        if (state != 2) {
            // Item FULFILLED and deleted though the winner rejects the ERC721 hook => FWA delivered via plain
            // transferFrom (no onERC721Received check). A hostile receiver cannot force a failed delivery / refund.
            console.log("delivery did NOT fail; FWA used plain transferFrom; reconciliation not bricked");
            return;
        }

        // Delivery failed -> item PENDING. Drive FWA's refund after the 7-day window, then recover here.
        vm.warp(block.timestamp + 7 days + 1);
        try p.refundFailedDelivery(drawnLid) {
            console.log("refundFailedDelivery OK");
        } catch (bytes memory e) {
            console.log("refundFailedDelivery reverted len:", e.length);
        }
        (,,,,,,, fwaStatus) = p.listings(drawnLid);
        console.log("FWA status after refund window:", fwaStatus);

        uint256 poolBefore = address(b).balance;
        vm.prank(creator);
        try b.recoverRefunded(drawnLid, creator) returns (uint256 ethOut) {
            console.log("recoverRefunded eth to pool:", address(b).balance - poolBefore, "returned:", ethOut);
        } catch (bytes memory e) {
            console.log("recoverRefunded reverted len:", e.length);
            console.logBytes(e);
        }
    }

    // The real refund path: a curated NFT whose delivery to the winner reverts -> FWA failed delivery -> PENDING ->
    // 7-day refund -> recoverRefunded returns the NFT to `to`. Trace states and the player's payment.
    function testCuratedFailedDeliveryRecovered() public {
        PoolBalancer b = newBalancer();
        IFWAPool p = b.pool();
        vm.prank(creator);
        b.configure(3000, one(D_001, 5));
        vm.deal(address(b), 20 ether);
        vm.prank(creator);
        b.open();
        upkeep(b);

        // A normal curated so admission has >1 curated; plus the hostile one we want drawn.
        listNewCurated(b, 0.3 ether);
        RevertOnDeliverNFT bad = new RevertOnDeliverNFT();
        bad.mint(creator, 1);
        bad.allow(address(b), address(p)); // allow pull to balancer and listing to pool, block delivery to winner
        vm.prank(creator);
        bad.setApprovalForAll(address(b), true);
        vm.prank(creator);
        uint256 badLid = b.listCurated(address(bad), 1, 0.3 ether);
        upkeep(b);
        require(b.admissionStatus() == 0, "not admitting");

        // Force a draw that hits the hostile curated (detect: its item becomes PENDING after reconcile).
        bool failed;
        for (uint256 w = 1; w <= 120 && !failed; ++w) {
            uint256 s = vm.snapshotState();
            drawReal(b, uint256(keccak256(abi.encode("badwin", w))));
            vm.prank(keeper);
            b.performUpkeep();
            (,, uint8 st,,) = b.items(badLid);
            if (st == 2) failed = true; // PENDING = delivery failed
            else vm.revertToState(s);
        }
        if (!failed) {
            console.log("hostile curated was not drawn within 120 words (heavy listing, low odds)");
            return;
        }
        (,,,,,,, uint8 fwaStatus) = p.listings(badLid);
        console.log("hostile curated PENDING; FWA status:", fwaStatus);
        // Wei ledger around a failed delivery: is the player's payment credited to the pool as proceeds, or held in
        // escrow for the player? Read the escrowed price of this acquisition and pool proceeds.
        console.log("pool ownerProceeds (failed draw):", p.ownerProceeds());
        console.log("player balance before refund:", player.balance);

        // The winner (purchaser) reclaims their payment after the window; this sets the listing refundable (status 7).
        vm.warp(block.timestamp + 7 days + 1);
        uint256 playerBefore = player.balance;
        vm.prank(player);
        p.refundFailedDelivery(badLid);
        console.log("player refunded (wei):", player.balance - playerBefore);
        console.log("pool ownerProceeds after refund:", p.ownerProceeds());
        (,,,,,,, fwaStatus) = p.listings(badLid);
        console.log("FWA status after player refund:", fwaStatus);

        // recoverRefunded sends the curated NFT to `to` via safeTransferFrom (bad blocks unless `to` is allowed).
        bad.allow(address(b), creator);
        vm.prank(creator);
        uint256 ethOut = b.recoverRefunded(badLid, creator);
        console.log("curated recovered; eth:", ethOut);
        assertEq(bad.ownerOf(1), creator, "curated NFT returned to creator");
        (,, uint8 stAfter,,) = b.items(badLid);
        assertEq(stAfter, 0, "item cleared after recovery");
    }
}
