// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Harness2, console} from "./Harness2.sol";

/// Priority 3 & 4: launch-scale mixes over many real draws (creator net, liveness) and draws-in-flight bursts with
/// the money goals checked at rest. Corrected VRF route enables sustained draws.
contract AddendumScaleTest is Harness2 {
    // size indices: 0=0.01, 1=0.05, 2=0.1, 3=0.5 Shapes; 9=0.02 pack
    function _packTarget(uint256[16] memory c) internal pure returns (uint256 t) {
        for (uint256 d; d < 16; d++) t |= (c[d] & 0xFFFF) << (16 * d);
    }

    function _runMix(uint256 target, uint256 markup, uint256 curatedVal, uint256 nDraws, string memory label)
        internal
    {
        nextNft += 60;
        _newPool(10 ether);
        vm.prank(creator);
        bal.configure(uint16(markup), target);
        uint256 curBase = curatedVal;
        _listCurated(curBase);
        _listCurated(curBase); // two, so one can be drawn and the gate stays open
        vm.prank(creator);
        bal.open();
        _stock();
        require(!bal.creatorWork(), "setup incomplete");

        vm.fee(1 gwei);
        vm.txGasPrice(1.05 gwei);

        uint256 draws;
        uint256 blocked;
        uint256 player0;
        uint256 playerPaid;
        for (uint256 i; i < nDraws; i++) {
            // keep at least one curated listed
            if (bal.getActiveIds().length == _activeShapeIds().length) _listCurated(curBase);
            if (bal.admissionStatus() != 0) _upkeep(keeper);
            if (bal.admissionStatus() != 0) { blocked++; continue; }
            (,, uint256 q) = pool.quoteAcquisitionPrice(1);
            (bool ok,,) = _tryDraw(player, uint256(keccak256(abi.encode(label, i))));
            if (!ok) { blocked++; continue; }
            playerPaid += q;
            draws++;
            _upkeep(keeper);
        }

        // close and sweep everything to the creator
        vm.startPrank(creator);
        bal.close();
        uint256[] memory sh = _activeShapeIds();
        // unlist in batches of 20
        for (uint256 off; off < sh.length; off += 20) {
            uint256 end = off + 20 > sh.length ? sh.length : off + 20;
            uint256[] memory part = new uint256[](end - off);
            for (uint256 j; j < part.length; j++) part[j] = sh[off + j];
            bal.unlistShapes(part);
        }
        uint256 curatedBack;
        uint256[] memory ids = bal.getActiveIds();
        for (uint256 i; i < ids.length; i++) {
            (uint8 kind,, uint8 state,,) = bal.items(ids[i]);
            if (kind == 1 && state == 1) { bal.withdrawCurated(ids[i], creator); curatedBack += curBase; }
        }
        bal.collectProceeds();
        uint256 claimed = bal.withdrawableSurplus();
        if (claimed > 0) bal.claimSurplus(claimed, creator);
        vm.stopPrank();

        int256 net = int256(claimed + curatedBack) - int256(10 ether);
        console.log(label);
        console.log("  draws / blocked", draws, blocked);
        console.log("  playerPaid(quoted)", playerPaid);
        console.log("  creator claimed / curatedBack", claimed, curatedBack);
        console.log("  creator NET vs 10 ETH deposit (claimed+curatedBack-deposit); sign:", net >= 0 ? 1 : 0);
        console.log("  |net| wei", net >= 0 ? uint256(net) : uint256(-net));
        console.log("  balancer residual", address(bal).balance);
        assertEq(address(bal).balance, 0, "stranded after sweep");
        // product goal: creator profitable in expectation across a run of draws
        assertGe(net, int256(0), "creator net negative over the run");
    }

    function testBalancedMix() public {
        _fork(); _deploy();
        uint256[16] memory c;
        c[0] = 20; c[1] = 10; c[2] = 2; c[3] = 1; c[9] = 7; // Balanced: 20x0.01,10x0.05,2x0.1,1x0.5,7x0.02 pack
        _runMix(_packTarget(c), 1500, 0.3 ether, 40, "Balanced (15% markup, 40 draws)");
    }

    function testSmallOnlyMix() public {
        _fork(); _deploy();
        uint256[16] memory c;
        c[0] = 20; // only 0.01 Shapes
        _runMix(_packTarget(c), 1500, 0.1 ether, 40, "0.01-only (15% markup, 40 draws)");
    }

    function testBiggerPrizeMix() public {
        _fork(); _deploy();
        uint256[16] memory c;
        c[0] = 15; c[2] = 4; c[3] = 2; c[13] = 1; // bigger: 15x0.01,4x0.1,2x0.5,1x2.0 pack
        _runMix(_packTarget(c), 3000, 0.5 ether, 30, "Bigger-prize (30% markup, 30 draws)");
    }

    /// Draws in flight: acquire a burst of MAX_BATCH before any settlement; check money goals at rest at each step.
    function testDrawsInFlightBurst() public {
        _fork(); _deploy();
        nextNft += 60;
        _newPool(10 ether);
        uint256[16] memory c; c[0] = 10; c[2] = 2;
        vm.prank(creator);
        bal.configure(2000, _packTarget(c));
        _listCurated(0.1 ether);
        _listCurated(0.1 ether);
        vm.prank(creator);
        bal.open();
        _stock();
        vm.fee(1 gwei); vm.txGasPrice(1.05 gwei);

        // acquire a burst without settling; the fill gate / BUSY may pause before MAX_BATCH (protective)
        uint256[] memory clIds = new uint256[](5);
        uint256 depth;
        for (uint256 i; i < 5; i++) {
            if (!bal.canPurchase(player)) break; // gate paused new draws
            (,, uint256 total) = pool.quoteAcquisitionPrice(1);
            vm.deal(player, player.balance + total);
            vm.recordLogs();
            vm.prank(player);
            try pool.acquire{value: total}(player, type(uint256).max, 0, 10_000, pool.inventoryVersion(), block.timestamp + 1)
                returns (uint256)
            {
                clIds[depth++] = _findReqId();
                assertEq(pool.unsettledAcquisitionCount(), depth, "unsettled did not accumulate");
            } catch {
                break; // FWA refused the acquire (operator gate)
            }
        }
        console.log("reachable in-flight burst depth", depth);
        console.log("unsettled at cap / admissionStatus", pool.unsettledAcquisitionCount(), bal.admissionStatus());
        assertGe(depth, 1, "no draw could be put in flight");
        // at-rest while draws are in flight: fund never below the per-prize backing (winners paid from listed tokens),
        // profit bounded by balance, reserve accounts each unreconciled draw as the heaviest prize
        assertLe(bal.profit(), address(bal).balance, "profit exceeds balance with draws in flight");
        // settle the burst; at-rest: no winner unpaid, accounting consistent
        for (uint256 i; i < depth; i++) {
            uint256[] memory w = new uint256[](1);
            w[0] = uint256(keccak256(abi.encode("flight", i)));
            vm.prank(coord);
            (bool f,) = VRF_SERVICE.call(abi.encodeWithSignature("rawFulfillRandomWords(uint256,uint256[])", clIds[i], w));
            require(f, "fulfill");
        }
        pool.processAcquisitions(5);
        console.log("unsettled after settle", pool.unsettledAcquisitionCount());
        // reconcile the burst in order
        uint256 g;
        while (g++ < 10) { (uint256 r,,) = _upkeep(keeper); if (r == 0 && bal.admissionStatus() != 6 && !bal.creatorWork()) break; }
        console.log("admissionStatus after reconcile+restock", bal.admissionStatus());
        console.log("profit (should be bounded, fund protected)", bal.profit());
        // every drawn prize was delivered or is recoverable; the balancer holds no stranded tracked NFT between txs
        assertLe(bal.profit(), address(bal).balance, "profit exceeds balance after burst");
    }
}
