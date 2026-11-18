pragma solidity 0.8.28;
import {Test} from "forge-std/Test.sol";
contract FeeB { uint public n; function touch() external { require(block.basefee==0.5 gwei && tx.gasprice==1 gwei,"fees"); ++n; }}
contract NeutralB is Test { function testFuzzCapability(uint64 x) public {vm.createSelectFork("https://mainnet.gateway.tenderly.co",26382349);vm.fee(0.5 gwei);vm.txGasPrice(1 gwei);FeeB f=new FeeB();f.touch();assertEq(f.n(),1);assertEq(uint256(x)+1,uint256(x)+1);assertEq(block.chainid,1);} }
