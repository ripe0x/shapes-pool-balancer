pragma solidity ^0.8.28;
import {Test} from "forge-std/Test.sol";
contract IndependentNeutralB is Test { function testNeutralFork() public { vm.createSelectFork("https://mainnet.gateway.tenderly.co",26382349); assertEq(block.number,26382349); assertGt(block.timestamp,0); } function testFuzzNeutral(uint128 x) public pure { assertEq(uint256(x)+1-1,x); } }
