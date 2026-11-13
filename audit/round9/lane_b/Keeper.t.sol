// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Harness, console} from "./Harness.sol";

/// Keeper incentive pass (M1, M2): lifetime keeper pay outside creator work <= restocking fees of the prizes keepers
/// listed, and reward never exceeds keeperCredit. Real fork receipts; gas price set to a realistic value.
contract KeeperTest is Harness {
    function setUp() public {
        _fork();
        _deploy();
        // 0.5 gwei: the highest the forked FWA VRF subscription covers; above it real draws revert
        // InsufficientVrfCoverage (environmental, recorded). The keeperCredit cap is price-independent.
        vm.fee(0.5 gwei); // basefee
        vm.txGasPrice(0.5 gwei); // honest keeper bids ~basefee
    }

    function testKeeperCapHonest() public {
        _newPool(5 ether);
        vm.prank(creator);
        bal.configure(3000, uint256(5)); // 30% markup, five 0.01 Shapes
        _listCurated(0.05 ether);
        _listCurated(0.05 ether);
        vm.prank(creator);
        bal.open();

        // Creator work: stock the target (paid in full from creator ETH; earns no keeperCredit).
        uint256 guard;
        while (bal.creatorWork() && guard++ < 10) {
            (uint256 r,, bool setup) = _upkeep(creator);
            assertTrue(setup, "should be setup");
        }
        assertEq(bal.keeperCredit(), 0, "no credit during creator work");
        assertEq(bal.admissionStatus(), 0, "open for purchases");

        uint256 sumReward;
        uint256 sumCreditAdded;
        uint256 maxMeasured;
        uint256 cycles;

        // Draw + keeper-upkeep cycles, all outside creator work. Stops when the forked VRF subscription
        // runs out of coverage (bounded number of real paid draws).
        for (uint256 i; i < 20; i++) {
            if (bal.admissionStatus() != 0) _upkeep(keeper); // restock gap: let keeper catch up
            if (bal.admissionStatus() != 0) continue;
            (bool ok,,) = _tryDraw(player, uint256(keccak256(abi.encode("w", i))));
            if (!ok) break;

            uint256 c0 = bal.keeperCredit();
            (uint256 reward, uint256 measured, bool setup) = _upkeep(keeper);
            uint256 c1 = bal.keeperCredit();
            assertFalse(setup, "cycle upkeep is not creator work");
            // credit added this call = (c1 - c0) + reward  (credit += added; then -= reward)
            uint256 creditAdded = c1 + reward - c0;
            sumReward += reward;
            sumCreditAdded += creditAdded;
            cycles++;
            if (measured > maxMeasured) maxMeasured = measured;
            // Per-call: reward never exceeds the credit available after this call's additions.
            assertLe(reward, c0 + creditAdded, "reward exceeds available credit");
        }

        console.log("cycles", cycles);
        console.log("sumReward (non-setup)", sumReward);
        console.log("sumCreditAdded (restock fees)", sumCreditAdded);
        console.log("maxMeasuredGas", maxMeasured);
        console.log("KEEPER_MAX_GAS", uint256(3_200_000));
        assertGe(cycles, 3, "need at least 3 real cycles");
        // M1/M2: lifetime keeper pay outside creator work <= restocking fees credited.
        assertLe(sumReward, sumCreditAdded, "M1 VIOLATION: keeper pay exceeds restock fees");
        // Gas headroom: measured span stays under the cap the reward is computed against.
        assertLe(maxMeasured, uint256(3_200_000), "measured gas exceeds KEEPER_MAX_GAS cap");
    }

    /// A keeper bidding a high priority fee cannot extract more than basefee + 0.05 gwei.
    function testKeeperCannotOverbidPriority() public {
        _newPool(5 ether);
        vm.prank(creator);
        bal.configure(2000, uint256(4));
        _listCurated(0.05 ether);
        _listCurated(0.05 ether);
        vm.prank(creator);
        bal.open();
        uint256 g;
        while (bal.creatorWork() && g++ < 10) _upkeep(creator);

        _draw(player, uint256(keccak256("x")));
        // Honest bid baseline.
        uint256 snap = vm.snapshotState();
        vm.txGasPrice(1 gwei);
        (uint256 rHonest,,) = _upkeep(keeper);
        vm.revertToState(snap);
        // Greedy keeper bids 100 gwei priority; reward price still capped at basefee+0.05gwei.
        vm.txGasPrice(100 gwei);
        (uint256 rGreedy,,) = _upkeep(keeper);
        console.log("reward honest / greedy", rHonest, rGreedy);
        assertEq(rHonest, rGreedy, "priority overbid changed the reward");
    }
}
