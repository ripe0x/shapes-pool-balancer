// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Harness, console} from "./Harness.sol";
import {IShapes} from "../../../src/interfaces/External.sol";

/// End-to-end economic scenario + round trips. Real fork; paid draws bounded by the forked VRF subscription coverage.
contract ScenarioTest is Harness {
    function setUp() public {
        _fork();
        _deploy();
        vm.fee(0.3 gwei);
        vm.txGasPrice(0.3 gwei);
    }

    function _stock() internal {
        uint256 g;
        while (bal.creatorWork() && g++ < 20) _upkeep(creator);
    }

    function testCreatorNetAndRoundTrip() public {
        uint256 deposit = 2 ether;
        _newPool(deposit);
        vm.prank(creator);
        bal.configure(3000, uint256(5)); // 30% markup, five 0.01 Shapes
        _listCurated(0.05 ether);
        _listCurated(0.05 ether);
        _stock();
        vm.prank(creator);
        bal.open();

        uint256 playerPaid;
        uint256 keeperEarned;
        uint256 draws;
        uint256 blocked;

        for (uint256 i; i < 20; i++) {
            if (bal.admissionStatus() != 0) {
                (uint256 r,,) = _upkeep(keeper);
                keeperEarned += r;
            }
            if (bal.admissionStatus() != 0) { blocked++; continue; }
            (,, uint256 quoted) = pool.quoteAcquisitionPrice(1);
            (bool ok,,) = _tryDraw(player, uint256(keccak256(abi.encode("s", i))));
            if (!ok) break;
            playerPaid += quoted;
            draws++;
            (uint256 r2,,) = _upkeep(keeper);
            keeperEarned += r2;
        }

        // Close and sweep to the creator.
        vm.startPrank(creator);
        bal.close();
        assertEq(bal.keeperCredit(), 0, "close must return keeper credit to creator");
        assertEq(bal.profit(), 0, "close zeroes profit");
        // keeper upkeep after close earns nothing
        vm.stopPrank();
        (uint256 rAfter,,) = _upkeep(keeper);
        assertEq(rAfter, 0, "keeper paid after close");

        vm.startPrank(creator);
        uint256[] memory ids = bal.getActiveIds();
        uint256[] memory sh = new uint256[](ids.length);
        uint256 ns;
        uint256[] memory cu = new uint256[](ids.length);
        uint256 nc;
        for (uint256 i; i < ids.length; i++) {
            (uint8 kind,, uint8 state,,) = bal.items(ids[i]);
            if (state != 1) continue;
            if (kind == 2) sh[ns++] = ids[i];
            else cu[nc++] = ids[i];
        }
        if (ns > 0) { assembly { mstore(sh, ns) } bal.unlistShapes(sh); }
        for (uint256 i; i < nc; i++) bal.withdrawCurated(cu[i], creator);
        bal.collectProceeds();
        uint256 creatorGot = bal.withdrawableSurplus();
        if (creatorGot > 0) bal.claimSurplus(creatorGot, creator);
        vm.stopPrank();

        console.log("draws / blocked", draws, blocked);
        console.log("playerPaid total (quoted)", playerPaid);
        console.log("keeperEarned total", keeperEarned);
        console.log("creator claimed at close", creatorGot);
        console.log("deposit", deposit);
        console.log("balancer residual", address(bal).balance);
        // M7: fully swept.
        assertEq(address(bal).balance, 0, "stranded ETH after full sweep");
        // creatorGot vs deposit is the creator's cash delta; the two 0.05 ETH NFTs were returned to the creator
        // (withdrawCurated to `creator`) and retain their value, so true net = (creatorGot - deposit) + NFTs back.
    }

    /// Round trip: remove the trigger. After close with no draws, the creator recovers exactly the deposit
    /// (minus nothing): mint fees were spent on real Shapes that are redeemed back; keeper credit returns.
    function testOpenCloseRoundTripNoDraws() public {
        uint256 deposit = 1 ether;
        _newPool(deposit);
        vm.prank(creator);
        bal.configure(2000, uint256(3));
        _listCurated(0.05 ether);
        _stock();
        vm.prank(creator);
        bal.open();
        // immediately close without any draw
        vm.startPrank(creator);
        bal.close();
        uint256[] memory ids = bal.getActiveIds();
        uint256[] memory sh = new uint256[](ids.length);
        uint256 ns;
        for (uint256 i; i < ids.length; i++) {
            (uint8 kind,, uint8 state,,) = bal.items(ids[i]);
            if (kind == 2 && state == 1) sh[ns++] = ids[i];
        }
        if (ns > 0) { assembly { mstore(sh, ns) } bal.unlistShapes(sh); }
        // withdraw curated
        for (uint256 i; i < ids.length; i++) {
            (uint8 kind,, uint8 state,,) = bal.items(ids[i]);
            if (kind == 1 && state == 1) bal.withdrawCurated(ids[i], creator);
        }
        uint256 s = bal.withdrawableSurplus();
        bal.claimSurplus(s, creator);
        vm.stopPrank();
        console.log("deposit / recovered", deposit, s);
        console.log("residual", address(bal).balance);
        assertEq(address(bal).balance, 0, "stranded after no-draw round trip");
        // Creator recovers the full deposit: mint fees became Shape backing that was redeemed back in unlistShapes.
        assertApproxEqAbs(s, deposit, 1, "creator did not recover deposit after no-draw round trip");
    }
}
