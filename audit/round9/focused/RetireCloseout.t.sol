// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {AddendumBase} from "../lane_a/addendum/AddendumBase.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {IFWAPool} from "../../../src/interfaces/External.sol";

/// Item 3: retire(). Close, retire the real FWA pool, then confirm a draw already in flight still settles and can be
/// reconciled, every prize can be unlisted and redeemed, the curated NFT withdrawn, and the Balancer ends with 0 ETH
/// and nothing stranded (M7). Real coordinator -> VRF service route for the in-flight draw.
contract RetireCloseoutTest is AddendumBase {
    uint8 constant CURATED = 1;
    uint8 constant SHAPE = 2;

    function testRetireClosesOutCleanly() public {
        PoolBalancer b = newBalancer();
        // 3 x 0.01 + 1 x 0.5 shapes, one 0.3 NFT.
        openPool(b, one(D_001, 3) | one(D_05, 1), 1500, 6 ether, 0.3 ether);

        // A draw is acquired and left unsettled (in flight).
        uint256 req = acquireOnly(b);
        assertGt(b.pool().unsettledAcquisitionCount(), 0, "draw in flight");

        // Close then retire while a draw is still outstanding.
        vm.prank(creator);
        b.close();
        vm.prank(creator);
        b.retire();
        assertTrue(b.pool().retired(), "pool retired");

        // The in-flight draw still settles through the real route, and upkeep still reconciles it.
        fulfillReq(req, uint256(keccak256("retire-word")));
        uint64 recBefore = b.reconciledSequence();
        vm.prank(keeper);
        b.performUpkeep();
        assertGt(b.reconciledSequence(), recBefore, "reconciled after retire");
        assertEq(b.pool().unsettledAcquisitionCount(), 0, "settled");

        // Unlist every remaining Shape/pack prize (redeems exact backing) and withdraw every curated NFT.
        uint256[] memory shapeIds = _ids(b, SHAPE);
        if (shapeIds.length != 0) {
            vm.prank(creator);
            b.unlistShapes(shapeIds);
        }
        uint256[] memory cur = _ids(b, CURATED);
        for (uint256 i; i < cur.length; ++i) {
            vm.prank(creator);
            b.withdrawCurated(cur[i], creator);
        }

        // Any item whose delivery failed would be PENDING; record if present (none expected for an EOA winner).
        assertEq(b.getActiveIds().length, 0, "no active listings stranded");

        // Creator withdraws everything; the Balancer ends empty (M7).
        uint256 claim = b.withdrawableSurplus();
        vm.prank(creator);
        b.claimSurplus(claim, creator);
        console.log("balancer balance at closeout:", address(b).balance);
        assertEq(address(b).balance, 0, "M7: 0 ETH, nothing stranded");
    }

    function _ids(PoolBalancer b, uint8 kind) internal view returns (uint256[] memory out) {
        uint256[] memory a = b.getActiveIds();
        uint256 n;
        uint256[] memory tmp = new uint256[](a.length);
        for (uint256 i; i < a.length; ++i) {
            (uint8 k,, uint8 st,,) = b.items(a[i]);
            if (k == kind && st == 1) tmp[n++] = a[i];
        }
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) out[i] = tmp[i];
    }
}
