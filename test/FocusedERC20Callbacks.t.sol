// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AuthenticEconomicFlowsTest} from "./AuthenticEconomicFlows.t.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";

interface ICallbackWETH {
    function deposit() external payable;
    function transfer(address,uint256) external returns(bool);
    function balanceOf(address) external view returns(uint256);
}
interface IRecoveryHook { function onRecovery() external; }

/// @dev Untrusted token accepted by the rescue interface, with real balances and a hostile receiver callback.
contract CallbackRecoveryToken {
    mapping(address=>uint256) public balanceOf;
    constructor(address holder) { balanceOf[holder]=100 ether; }
    function transfer(address to,uint256 amount) external returns(bool) {
        balanceOf[msg.sender]-=amount;balanceOf[to]+=amount;IRecoveryHook(to).onRecovery();return true;
    }
}
contract CallbackRecoveryCreator is IRecoveryHook {
    PoolBalancer public immutable balancer;
    address public immutable weth;
    bool public nativeReentry;
    bool public wethReentry;
    bytes public nativeReason;
    bytes public wethReason;
    constructor(PoolBalancer b,address w) { balancer=b;weth=w; }
    receive() external payable {}
    function accept() external { balancer.acceptCreator(); }
    function rescue(address token,uint256 amount) external { balancer.recoverERC20(token,amount); }
    function onRecovery() external {
        (nativeReentry,nativeReason)=address(balancer).call(abi.encodeCall(balancer.claimSurplus,(0.1 ether,address(this))));
        (wethReentry,wethReason)=address(balancer).call(abi.encodeCall(balancer.recoverERC20,(weth,0.1 ether)));
    }
}
contract FocusedERC20CallbacksTest is AuthenticEconomicFlowsTest {
    function test_authorizedCreatorCallbackCannotDrainNativeWETHOrNonzeroCredit() public {
        vm.rollFork(26442757);vm.fee(548662718);vm.txGasPrice(565418379);probe.record();
        assertEq(probe.baseFee(),548662718);assertEq(probe.gasPrice(),565418379);
        vm.transact(0x16ccbb75cd9b6cec741d78957e43f723b6bf00d7d70d0882d13e4300bb072616);
        vm.transact(0x3e361ce8123ab51584b68873e23b29b05187a575495cd3c939dc8a39b21774d8);
        vm.transact(0x9fbe95ea1760ed9e5dae0ece749cb6ae534aad8507fa02246038def196336abe);
        pool.processAcquisitions(3);assertEq(pool.unsettledAcquisitionCount(),0);balancer.collectProceeds();
        uint256 credit=balancer.creatorCredit();assertGt(credit,0,"actual sale proceeds establish nonzero protected credit");
        ICallbackWETH w=ICallbackWETH(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
        vm.startPrank(creator);w.deposit{value:0.1 ether}();assertTrue(w.transfer(address(balancer),0.1 ether));vm.stopPrank();
        CallbackRecoveryCreator receiver=new CallbackRecoveryCreator(balancer,address(w));
        vm.prank(creator);balancer.transferCreator(address(receiver));receiver.accept();
        assertEq(balancer.creator(),address(receiver));
        CallbackRecoveryToken token=new CallbackRecoveryToken(address(balancer));
        uint256 native=address(balancer).balance;
        receiver.rescue(address(token),100 ether);
        assertFalse(receiver.nativeReentry());assertFalse(receiver.wethReentry());
        assertEq(bytes4(receiver.nativeReason()),bytes4(keccak256("Reentrancy()")));
        assertEq(bytes4(receiver.wethReason()),bytes4(keccak256("Reentrancy()")));
        assertEq(address(balancer).balance,native);assertEq(balancer.creatorCredit(),credit);
        assertEq(w.balanceOf(address(balancer)),0.1 ether);assertEq(w.balanceOf(address(receiver)),0);
        assertEq(token.balanceOf(address(balancer)),0);assertEq(token.balanceOf(address(receiver)),100 ether);
        receiver.rescue(address(w),0.1 ether);
        assertEq(w.balanceOf(address(balancer)),0);assertEq(w.balanceOf(address(receiver)),0.1 ether);
        assertEq(address(balancer).balance,native);assertEq(balancer.creatorCredit(),credit);
    }
}
