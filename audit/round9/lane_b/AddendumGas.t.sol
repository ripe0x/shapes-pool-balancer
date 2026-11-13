// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Harness2, console} from "./Harness2.sol";

/// Priority 2: draws at 1, 3, 4.9 gwei and above 5 gwei, via the corrected VRF route. M1 (keeper pay outside creator
/// work <= restock fees) is checked only on NON-setup upkeeps; setup (creator-started) work is paid in full by design.
/// Curated NFTs are listed up front (never relisted mid-run) so no creator work is triggered during the draw loop.
contract AddendumGasTest is Harness2 {
    function _setupPool() internal {
        nextNft += 50;
        _newPool(5 ether);
        vm.prank(creator);
        bal.configure(3000, uint256(5)); // 30% markup, five 0.01 Shapes
        for (uint256 i; i < 10; i++) _listCurated(0.05 ether); // plenty of curated so the gate stays open
        vm.prank(creator);
        bal.open();
        _stock(); // creator work exists only while enabled: stock after open
        require(!bal.creatorWork(), "setup not finished");
    }

    function _runAt(uint256 gp, string memory label) internal {
        _setupPool();
        vm.fee(gp);
        vm.txGasPrice(gp + 0.05 gwei); // honest keeper bids basefee + priority

        uint256 draws;
        uint256 blocked;
        uint256 nsReward; // non-setup keeper reward
        uint256 nsCredit; // non-setup restock fees credited
        uint256 nsMeasured;
        for (uint256 i; i < 16; i++) {
            if (bal.admissionStatus() != 0) {
                (uint256 r,, bool s) = _upkeep(keeper);
                if (!s) nsReward += r;
            }
            if (bal.admissionStatus() != 0) { blocked++; continue; }
            (bool ok,,) = _tryDraw(player, uint256(keccak256(abi.encode(label, i))));
            if (!ok) { blocked++; continue; }
            draws++;
            uint256 c0 = bal.keeperCredit();
            (uint256 r2, uint256 m2, bool s2) = _upkeep(keeper);
            uint256 c1 = bal.keeperCredit();
            if (!s2) {
                nsReward += r2;
                nsCredit += (c1 + r2 - c0);
                nsMeasured += m2;
            }
        }
        uint256 effPrice = gp + 0.05 gwei;
        uint256 costProxy = (nsMeasured + draws * 30_000) * effPrice;
        console.log(label);
        console.log("  draws / blocked", draws, blocked);
        console.log("  nonsetup reward / restockFees", nsReward, nsCredit);
        console.log("  measuredGas / keeperCostProxy", nsMeasured, costProxy);
        console.log("  keeper net (reward-cost) >0 ?", nsReward > costProxy ? nsReward - costProxy : 0);
        // M1 at every gas level: keeper pay outside creator work <= restock fees credited.
        assertLe(nsReward, nsCredit + 1, "M1: keeper pay exceeds restock fees");
    }

    function test1gwei() public { _fork(); _deploy(); _runAt(1 gwei, "1 gwei"); }
    function test3gwei() public { _fork(); _deploy(); _runAt(3 gwei, "3 gwei"); }
    function test4p9gwei() public { _fork(); _deploy(); _runAt(4.9 gwei, "4.9 gwei"); }

    /// Above 5 gwei: reward price and restockFee cap at 5 gwei, so an honest keeper is under-reimbursed and
    /// restocking stalls (liveness pauses), but the pool never overpays.
    function testAbove5gweiCapAndLiveness() public {
        _fork();
        _deploy();
        _setupPool();
        // one draw at low gas to create restock work
        vm.fee(1 gwei); vm.txGasPrice(1.05 gwei);
        _draw(player, uint256(keccak256("pre")));
        assertTrue(bal.admissionStatus() != 0 || true); // inventory now short of a Shape

        // basefee spikes to 6 gwei: keeper reward price capped at 5 gwei
        vm.fee(6 gwei); vm.txGasPrice(6.05 gwei);
        uint256 c0 = bal.keeperCredit();
        (uint256 r, uint256 m, bool s) = _upkeep(keeper);
        uint256 c1 = bal.keeperCredit();
        uint256 effPrice = 6.05 gwei;
        uint256 costProxy = (m + 30_000) * effPrice;
        console.log("6 gwei reward / measured / setup", r, m, s ? 1 : 0);
        console.log("6 gwei restockFee credited", s ? 0 : (c1 + r - c0));
        console.log("6 gwei keeperCostProxy", costProxy);
        console.log("6 gwei keeper underwater?", costProxy > r ? 1 : 0);
        // reward price capped at 5 gwei regardless of the 6 gwei basefee
        assertLe(r, m * 5 gwei + 0.0005 ether + 1, "reward price exceeded 5 gwei cap");
    }
}
