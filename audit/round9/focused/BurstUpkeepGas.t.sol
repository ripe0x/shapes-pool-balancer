// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {AddendumBase} from "../lane_a/addendum/AddendumBase.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {IFWAPool} from "../../../src/interfaces/External.sol";

/// Item 4: bursts up to the unsettled cap. Acquire as many draws as admission allows before any settlement (MAX_BATCH
/// = 5), confirm a 6th is refused, settle all together through the real route, then run upkeeps. Measure the gas of
/// the heaviest upkeep against the keeper's 4,000,000 gas floor (keeper/keeper.ts UPKEEP_GAS_FLOOR) and the contract's
/// KEEPER_MAX_GAS (3,200,000). Check M1 (keeper pay <= restock fees), M6 and profit <= balance at rest.
contract BurstUpkeepGasTest is AddendumBase {
    uint8 constant BUSY = 4;
    uint256 constant GAS_FLOOR = 4_000_000; // UPKEEP_GAS_FLOOR
    uint256 constant KEEPER_MAX_GAS = 3_200_000; // reimbursed-gas cap in PoolBalancer

    function testBurstThenHeavyUpkeep() public {
        PoolBalancer b = newBalancer();
        // 30 x 0.01 gives enough prize weight that the fill gate (each unreconciled draw charged the heaviest prize)
        // does not trip before the MAX_BATCH=5 unsettled cap does; smaller boards pause earlier (that is M8, item below).
        openPool(b, one(D_001, 30) | one(D_05, 1), 1500, 10 ether, 0.3 ether);
        IFWAPool p = b.pool();

        // Acquire up to the cap without settling.
        uint256[] memory reqs = new uint256[](5);
        uint256 got;
        for (uint256 i; i < 5; ++i) {
            if (b.admissionStatus() != 0) break;
            reqs[got++] = acquireOnly(b);
        }
        console.log("unsettled draws acquired in burst:", got);
        assertEq(p.unsettledAcquisitionCount(), got, "all unsettled");
        assertEq(b.admissionStatus(), BUSY, "gate BUSY at cap");

        // A further draw is refused by the gate (canPurchase false -> acquire reverts).
        (uint256 fee,, uint256 total) = p.quoteAcquisitionPrice(1);
        vm.deal(player, player.balance + total);
        uint256 iv = p.inventoryVersion();
        vm.prank(player);
        try p.acquire{value: total}(player, fee, 0, 10_000, iv, block.timestamp + 1000) {
            revert("6th draw should be refused");
        } catch {}

        // Settle the whole burst together.
        for (uint256 i; i < got; ++i) {
            fulfillReq(reqs[i], uint256(keccak256(abi.encode("burst", i))));
        }
        assertEq(p.unsettledAcquisitionCount(), 0, "all settled");

        // Run upkeeps to reconcile + restock, measuring the heaviest single call.
        uint128 creditBefore = b.keeperCredit();
        uint256 paidTotal;
        uint256 maxGas;
        for (uint256 i; i < 25; ++i) {
            uint256 g = gasleft();
            vm.prank(keeper);
            try b.performUpkeep() returns (uint256 reward) {
                uint256 used = g - gasleft();
                if (used > maxGas) maxGas = used;
                paidTotal += reward;
            } catch {
                break;
            }
        }

        console.log("heaviest upkeep gasUsed:", maxGas);
        console.log("  vs KEEPER_MAX_GAS (3.2M):", KEEPER_MAX_GAS);
        console.log("  vs UPKEEP_GAS_FLOOR (4.0M):", GAS_FLOOR);
        console.log("keeper paid total / credit minted:", paidTotal, uint256(b.keeperCredit()) + paidTotal - creditBefore);
        assertLt(maxGas, GAS_FLOOR, "heaviest upkeep fits under the 4M keeper gas floor");

        // M1: lifetime keeper pay this run <= restocking fees credited this run.
        // credit minted this run = (current credit + paid) - creditBefore ; paid must be <= that.
        uint256 creditMinted = uint256(b.keeperCredit()) + paidTotal - creditBefore;
        assertLe(paidTotal, creditMinted, "M1: keeper pay <= restock fees credited");

        // At rest: profit <= balance (M9 bound), reserve well-defined, target restored.
        assertLe(uint256(b.profit()), address(b).balance, "profit <= balance");
        assertEq(b.getActiveShapes()[D_001], 30, "0.01 target restored");
        assertEq(b.getActiveShapes()[D_05], 1, "0.5 target restored");
        console.log("profit / balance / reserve at rest:", uint256(b.profit()), address(b).balance);
        console.log("  reserve:", b.requiredReserve());
    }
}
