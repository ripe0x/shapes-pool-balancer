// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {AddendumBase} from "../lane_a/addendum/AddendumBase.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";

interface ISetMintFee {
    function setMintFee(uint256 newFee) external;
    function mintFee() external view returns (uint256);
    function admin() external view returns (address);
}

/// Item 2: MINT_FEE_ROSE gate. Raise the LIVE Shapes mint fee above the pool's accepted `mintFeeCap` through the real
/// admin setter (acting as the real Shapes admin), and check: admission flips to MINT_FEE_ROSE, restocking stops,
/// reserve reflects the higher fee, the creator's `configure` re-accepts the fee and restocking resumes, and the
/// creator can still close and withdraw everything (M7). No mocks: the real Shapes contract's own setter is used.
contract MintFeeRoseGateTest is AddendumBase {
    uint8 constant OK = 0;
    uint8 constant MINT_FEE_ROSE = 5;
    uint8 constant CURATED = 1;
    uint8 constant SHAPE = 2;

    function testMintFeeRoseGate() public {
        ISetMintFee sh = ISetMintFee(SHAPES);
        address admin = sh.admin();
        uint256 fee0 = sh.mintFee();
        console.log("live mintFee at setup:", fee0);

        PoolBalancer b = newBalancer();
        // 3 x 0.01 shapes, one 0.3 NFT, 15% markup.
        openPool(b, one(D_001, 3), 1500, 5 ether, 0.3 ether);
        assertEq(b.admissionStatus(), OK, "admitting after stock");
        assertEq(b.mintFeeCap(), fee0, "cap == accepted fee");
        uint256 reserveBefore = b.requiredReserve();

        // Real admin raises the live fee above the accepted cap.
        uint256 newFee = fee0 + 0.001 ether; // 0.002, under MAX_MINT_FEE (0.01)
        vm.prank(admin);
        sh.setMintFee(newFee);
        assertEq(sh.mintFee(), newFee, "fee raised");

        // Admission is gated.
        assertEq(b.admissionStatus(), MINT_FEE_ROSE, "gate = MINT_FEE_ROSE");
        assertFalse(b.canPurchase(player), "purchases refused");

        // Reserve rises: requiredReserve uses max(liveFee, cap) for restock cost.
        uint256 reserveAfter = b.requiredReserve();
        console.log("reserve before / after fee rise:", reserveBefore, reserveAfter);
        assertGt(reserveAfter, reserveBefore, "reserve reflects higher fee");

        // Restocking stops: create a deficit (unlist one shape) then run upkeep; nothing is minted while fee>cap.
        uint256[] memory ids = new uint256[](1);
        ids[0] = b.getActiveIds()[0];
        // ensure it is a SHAPE
        (uint8 k,,,,) = b.items(ids[0]);
        for (uint256 i; k != SHAPE && i < b.getActiveIds().length; ++i) {
            ids[0] = b.getActiveIds()[i];
            (k,,,,) = b.items(ids[0]);
        }
        vm.prank(creator);
        b.unlistShapes(ids);
        uint16[16] memory before = b.getActiveShapes();
        vm.prank(keeper);
        try b.performUpkeep() {} catch {}
        uint16[16] memory afterUp = b.getActiveShapes();
        assertEq(afterUp[D_001], before[D_001], "no restock while fee > cap");
        assertTrue(b.creatorWork(), "creatorWork stuck: restock blocked");
        console.log("missing shapes still present, restock blocked by MINT_FEE_ROSE");

        // Creator re-accepts the fee: configure re-reads the live fee into the cap, restocking resumes.
        vm.prank(creator);
        b.configure(1500, one(D_001, 3));
        assertEq(b.mintFeeCap(), newFee, "cap re-accepted");
        upkeep(b);
        assertEq(b.getActiveShapes()[D_001], 3, "restock resumed to target");
        assertEq(b.admissionStatus(), OK, "admitting again");

        // M7: creator can still close and withdraw everything.
        vm.prank(creator);
        b.close();
        uint256[] memory shapeIds = _activeShapeIds(b);
        if (shapeIds.length != 0) {
            vm.prank(creator);
            b.unlistShapes(shapeIds);
        }
        uint256[] memory cur = _activeCuratedIds(b);
        for (uint256 i; i < cur.length; ++i) {
            vm.prank(creator);
            b.withdrawCurated(cur[i], creator);
        }
        uint256 claim = b.withdrawableSurplus();
        vm.prank(creator);
        b.claimSurplus(claim, creator);
        console.log("final balancer balance after close+withdraw-all:", address(b).balance);
        assertEq(address(b).balance, 0, "M7: nothing stranded");
        assertEq(b.getActiveIds().length, 0, "no listings left");
    }

    function _activeShapeIds(PoolBalancer b) internal view returns (uint256[] memory out) {
        uint256[] memory a = b.getActiveIds();
        uint256 n;
        uint256[] memory tmp = new uint256[](a.length);
        for (uint256 i; i < a.length; ++i) {
            (uint8 k,, uint8 st,,) = b.items(a[i]);
            if (k == SHAPE && st == 1) tmp[n++] = a[i];
        }
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) out[i] = tmp[i];
    }

    function _activeCuratedIds(PoolBalancer b) internal view returns (uint256[] memory out) {
        uint256[] memory a = b.getActiveIds();
        uint256 n;
        uint256[] memory tmp = new uint256[](a.length);
        for (uint256 i; i < a.length; ++i) {
            (uint8 k,, uint8 st,,) = b.items(a[i]);
            if (k == CURATED && st == 1) tmp[n++] = a[i];
        }
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) out[i] = tmp[i];
    }
}
