// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";

contract Reader2 {
    uint256 public basefee;
    uint256 public gasprice;
    function write() external {
        basefee = block.basefee;
        gasprice = tx.gasprice;
    }
}

/// Do vm.fee / vm.txGasPrice set in setUp reach state-changing calls made in the test function?
contract SetUpFeeTest is Test {
    Reader2 r;
    function setUp() public {
        vm.createSelectFork("https://mainnet.gateway.tenderly.co", 26382349);
        vm.txGasPrice(1 gwei);
        vm.fee(0.5 gwei);
        r = new Reader2();
    }
    function test_setUpValuesReachCalls() public {
        console.log("test body basefee / gasprice:", block.basefee, tx.gasprice);
        r.write();
        console.log("inside call basefee / gasprice:", r.basefee(), r.gasprice());
        vm.roll(block.number + 3);
        r.write();
        console.log("after vm.roll, inside call:", r.basefee(), r.gasprice());
    }
}
