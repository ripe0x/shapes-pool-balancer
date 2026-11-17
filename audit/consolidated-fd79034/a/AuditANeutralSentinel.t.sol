// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {Test} from "forge-std/Test.sol";
contract AuditANeutralSentinel is Test {
 function testSentinel() public {vm.createSelectFork("https://mainnet.gateway.tenderly.co",26382349); vm.fee(1 gwei); vm.txGasPrice(2 gwei); assertEq(block.number,26382349); assertEq(block.basefee,1 gwei); assertEq(tx.gasprice,2 gwei); assertGt(block.timestamp,0); }
 function testFuzzSentinel(uint64 n) public pure {assertEq(uint256(n)+1-1,uint256(n));}
}
