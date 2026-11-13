// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {AddendumBase} from "../lane_a/addendum/AddendumBase.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";

/// Challenge test: does lane A's "unlistShapes is neutral/fund-favourable for every subset" hold on a HETEROGENEOUS
/// board? Lane A only tested a homogeneous 5x0.01 board (all shares equal -> removing one is trivially neutral).
///
/// _share(lid) = amount*(markup-MIN)/BPS*1e18 / price, and price carries flat per-shape fees, so a 0.01 ETH shape has
/// a LOWER share than a 0.5 ETH shape at the same markup. _collect books mine = amount*profitShareSum/(n*1e18).
/// Removing a listing whose share s_j < average (profitShareSum/n) RAISES the ratio -> books MORE profit while short.
/// A 0.01 shape in a board that also holds a 0.5 shape is below average, so unlisting it should be a real M9 lever.
contract UnlistShareLever is AddendumBase {
    // Board: 4x0.01 + 1x0.5 shapes, one curated. Pull balance to reserve, then one unreconciled draw -> short regime.
    // Returns a still-ACTIVE 0.01 shape listing id to unlist.
    function _shortHetero(PoolBalancer b, uint16 markup) internal returns (uint256 smallShapeId) {
        openPool(b, one(D_001, 4) | one(D_05, 1), markup, 10 ether, 0.3 ether);
        uint256 bal = address(b).balance;
        uint256 reserve = b.requiredReserve();
        if (bal > reserve) {
            vm.prank(creator);
            b.claimSurplus(bal - reserve, creator);
        }
        // One unreconciled draw; retry words until it hits SOMETHING while leaving >=1 active 0.01 shape to unlist.
        bool ok;
        for (uint256 w = 1; w <= 60 && !ok; ++w) {
            uint256 s = vm.snapshotState();
            drawReal(b, uint256(keccak256(abi.encode("het", w))));
            uint256 found = _firstActiveSmallShape(b);
            if (found != 0 && b.pool().ownerProceeds() > 0 && fundVal(b) < b.requiredReserve()) {
                smallShapeId = found;
                ok = true;
            } else {
                vm.revertToState(s);
            }
        }
        require(ok, "could not reach short regime with an active 0.01 shape");
    }

    // first ACTIVE shape whose denom is 0.01 (denom index 0)
    function _firstActiveSmallShape(PoolBalancer b) internal view returns (uint256) {
        uint256[] memory ids = b.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 denom, uint8 state,,) = b.items(ids[i]);
            if (kind == 2 && state == 1 && denom == 0) return ids[i];
        }
        return 0;
    }

    function testUnlistBelowAverageShapeInflatesProfit() public {
        PoolBalancer b = newBalancer();
        uint256 smallId = _shortHetero(b, 3000); // 30% markup

        uint256[] memory one_ = new uint256[](1);
        one_[0] = smallId;

        // A: honest collect
        uint256 snap = vm.snapshotState();
        b.collectProceeds();
        uint256 honest = b.profit();
        vm.revertToState(snap);

        // B: unlist a below-average-share 0.01 shape, then collect
        vm.prank(creator);
        b.unlistShapes(one_);
        b.collectProceeds();
        uint256 acted = b.profit();

        console.log("honest profit :", honest);
        console.log("acted  profit :", acted);
        if (acted > honest) {
            console.log("LEVER: unlistShapes raised profit by (wei):", acted - honest);
        } else {
            console.log("no lever: delta (honest-acted) wei:", honest - acted);
        }
        // Lane A asserted acted <= honest. If this fires, that claim does not hold on a heterogeneous board.
        assertLe(acted, honest, "CHALLENGE: unlistShapes of a below-average shape increased profit (M9 lever)");
    }
}
