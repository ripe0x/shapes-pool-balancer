// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {AddendumBase} from "../lane_a/addendum/AddendumBase.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../src/BalancerFactory.sol";

/// Item 5: reward-callback reentrancy. A creator that is a contract runs `performUpkeep` itself; when it receives the
/// keeper reward it is paid by SafeTransferLib.forceSafeTransferETH, whose inner call forwards only
/// GAS_STIPEND_NO_GRIEF = 100_000 gas. Crucially, if that inner call reverts or runs out of gas, forceSafeTransferETH
/// delivers the ETH through a temporary self-destruct contract instead, and the entire re-entrant frame (every state
/// change it attempted) is discarded. So a re-entry persists ONLY if the whole callback completes within 100k gas.
///
/// This drives the real reward callback and, per run, re-enters ONE creator function as leanly as possible, then
/// checks from outside whether its persistent effect took hold. Guarded functions (nonReentrant) revert `Reentrancy`
/// inside the 100k frame -> discarded. profit <= balance and keeperCredit are checked after every upkeep.
contract ReentrantCreator {
    PoolBalancer public b;
    bool public active;
    uint8 public mode; // 0 transferCreator, 1 close, 2 configure, 3 collectProceeds(guarded)
    bool public reentered; // set true only if a full re-entrant frame completed

    function create(BalancerFactory f, bytes32 salt) external {
        b = PoolBalancer(payable(f.createBalancer(salt)));
    }

    function setup(uint256 target) external {
        b.configure(1500, target);
        b.open();
    }

    function runUpkeep(uint8 m) external returns (bool ok) {
        mode = m;
        active = true;
        try b.performUpkeep() { ok = true; } catch { ok = false; }
        active = false;
    }

    receive() external payable {
        if (!active) return;
        active = false; // single attempt per reward
        PoolBalancer p = b;
        uint8 m = mode;
        // Lean re-entry: one external call, then a single SSTORE marking completion. If the call + this frame exceed
        // the 100k stipend, forceSafeTransferETH reverts the frame and `reentered` never persists.
        if (m == 0) { p.transferCreator(address(0xDEAD)); reentered = true; }
        else if (m == 1) { p.close(); reentered = true; }
        else if (m == 2) { p.configure(2000, 1); reentered = true; }
        else { p.collectProceeds(); reentered = true; } // guarded -> reverts -> frame discarded
    }
}

contract RewardReentrancyTest is AddendumBase {
    function _fresh(uint256 salt) internal returns (ReentrantCreator atk, PoolBalancer b) {
        atk = new ReentrantCreator();
        atk.create(factory, bytes32(salt));
        b = atk.b();
        vm.deal(address(b), 4 ether);
        atk.setup(one(D_001, 20));
        assertTrue(b.creatorWork(), "in setup");
    }

    function _drive(ReentrantCreator atk, PoolBalancer b, uint8 mode) internal {
        for (uint256 i; i < 10; ++i) {
            bool ok = atk.runUpkeep(mode);
            assertLe(uint256(b.profit()), address(b).balance, "profit <= balance");
            assertLe(uint256(b.keeperCredit()), address(b).balance, "keeperCredit <= balance");
            if (atk.reentered()) break; // a frame completed
            if (!ok || !b.creatorWork()) break;
        }
    }

    function testTransferCreatorReentry() public {
        (ReentrantCreator atk, PoolBalancer b) = _fresh(0xA1);
        _drive(atk, b, 0);
        console.log("transferCreator reentry completed within stipend:", atk.reentered());
        console.log("  pendingCreator after:", b.pendingCreator());
        // Whether or not it fit, money invariants hold.
        assertLe(uint256(b.profit()), address(b).balance, "profit<=balance");
    }

    function testCloseReentry() public {
        (ReentrantCreator atk, PoolBalancer b) = _fresh(0xA2);
        _drive(atk, b, 1);
        console.log("close reentry completed within stipend:", atk.reentered());
        console.log("  enabled after (false => close executed re-entrantly):", b.enabled());
    }

    function testConfigureReentry() public {
        (ReentrantCreator atk, PoolBalancer b) = _fresh(0xA3);
        _drive(atk, b, 2);
        console.log("configure reentry completed within stipend:", atk.reentered());
        console.log("  markupBps after (2000 => configure executed re-entrantly):", b.markupBps());
    }

    function testGuardedCollectReentry() public {
        (ReentrantCreator atk, PoolBalancer b) = _fresh(0xA4);
        _drive(atk, b, 3);
        // guarded: nonReentrant reverts inside the frame; forceSafeTransferETH swallows it; nothing persists.
        console.log("guarded collectProceeds reentry completed:", atk.reentered());
        assertFalse(atk.reentered(), "guarded function cannot re-enter");
    }
}
