// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Harness, console} from "./Harness.sol";

contract ProbeVrfTest is Harness {
    function testVrfThreshold() public {
        _fork();
        _deploy();
        _newPool(5 ether);
        vm.prank(creator);
        bal.configure(2000, uint256(3));
        _listCurated(0.05 ether);
        vm.prank(creator);
        bal.open();
        uint256 g;
        while (bal.creatorWork() && g++ < 10) _upkeep(creator);

        uint64[6] memory prices = [uint64(0), 0.02 gwei, 0.05 gwei, 0.1 gwei, 0.2 gwei, 0.5 gwei];
        for (uint256 i; i < prices.length; i++) {
            uint256 snap = vm.snapshotState();
            vm.fee(uint256(prices[i]));
            vm.txGasPrice(uint256(prices[i]));
            (,, uint256 total) = pool.quoteAcquisitionPrice(1);
            vm.deal(player, total + 1 ether);
            vm.prank(player);
            try pool.acquire{value: total}(player, type(uint256).max, 0, 10_000, pool.inventoryVersion(), block.timestamp + 1) returns (uint256) {
                console.log("gasprice wei OK:", uint256(prices[i]), total);
            } catch {
                console.log("gasprice wei FAIL:", uint256(prices[i]), total);
            }
            vm.revertToState(snap);
        }
    }
}
