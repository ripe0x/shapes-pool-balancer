// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";

contract Reader {
    function read() external view returns (uint256 basefee, uint256 gasprice) {
        return (block.basefee, tx.gasprice);
    }
    function write() external returns (uint256 basefee, uint256 gasprice) {
        emit Seen(block.basefee, tx.gasprice);
        return (block.basefee, tx.gasprice);
    }
    event Seen(uint256, uint256);
}

/// What block.basefee and tx.gasprice are inside a fork test, by default and with vm.fee / vm.txGasPrice.
contract FeeContextTest is Test {
    function test_defaults() public {
        vm.createSelectFork("https://mainnet.gateway.tenderly.co", 26382349);
        Reader r = new Reader();
        console.log("test body basefee / gasprice:", block.basefee, tx.gasprice);
        (uint256 b1, uint256 g1) = r.read();
        console.log("view call basefee / gasprice:", b1, g1);
        (uint256 b2, uint256 g2) = r.write();
        console.log("state-changing call basefee / gasprice:", b2, g2);
    }
}
