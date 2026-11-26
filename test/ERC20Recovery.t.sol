// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IRecoveryWETH {
    function deposit() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @dev A token the creator supplies may refuse transfers; it is not a substitute for a protocol dependency.
contract RefusingRecoveryToken {
    function transfer(address, uint256) external pure returns (bool) { return false; }
}

contract ERC20RecoveryTest is ForkBase {
    IRecoveryWETH constant WETH = IRecoveryWETH(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    event ERC20Recovered(address indexed token, address indexed to, uint256 amount);

    function setUp() public {
        setUpFork();
        createBalancer(1 ether);
        vm.startPrank(stranger);
        WETH.deposit{value: 1 ether}();
        assertTrue(WETH.transfer(address(balancer), 1 ether));
        vm.stopPrank();
        assertEq(WETH.balanceOf(address(balancer)), 1 ether, "real WETH deposit/transfer path");
    }

    function test_partialAndFullRecoveryPayOnlyCreatorAndPreserveOperatingETH() public {
        uint256 operating = address(balancer).balance;
        uint256 credit = balancer.creatorCredit();
        uint256 recipientBefore = WETH.balanceOf(creator);
        vm.expectEmit(address(balancer));
        emit ERC20Recovered(address(WETH), creator, 0.4 ether);
        vm.prank(creator);
        balancer.recoverERC20(address(WETH), 0.4 ether);
        assertEq(WETH.balanceOf(creator) - recipientBefore, 0.4 ether);
        assertEq(WETH.balanceOf(address(balancer)), 0.6 ether);
        vm.prank(creator);
        balancer.recoverERC20(address(WETH), 0.6 ether);
        assertEq(WETH.balanceOf(address(balancer)), 0);
        assertEq(WETH.balanceOf(creator) - recipientBefore, 1 ether);
        assertEq(address(balancer).balance, operating);
        assertEq(balancer.creatorCredit(), credit);
    }

    function test_senderAndOtherActorsHaveNoRecoveryAuthority() public {
        vm.prank(stranger);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.recoverERC20(address(WETH), 1 ether);
        assertEq(WETH.balanceOf(address(balancer)), 1 ether);
    }

    function test_recoveryFollowsAcceptedCreatorTransfer() public {
        vm.prank(creator);
        balancer.transferCreator(buyer);
        vm.prank(buyer);
        balancer.acceptCreator();
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.recoverERC20(address(WETH), 1 ether);
        uint256 before = WETH.balanceOf(buyer);
        vm.prank(buyer);
        balancer.recoverERC20(address(WETH), 1 ether);
        assertEq(WETH.balanceOf(buyer) - before, 1 ether);
    }

    function test_badTokenAmountAndRefusedTransferLeaveAssetsUntouched() public {
        RefusingRecoveryToken refusing = new RefusingRecoveryToken();
        uint256 native = address(balancer).balance;
        vm.startPrank(creator);
        vm.expectRevert(PoolBalancer.InvalidItem.selector);
        balancer.recoverERC20(address(0), 1);
        vm.expectRevert(PoolBalancer.InvalidItem.selector);
        balancer.recoverERC20(address(WETH), 0);
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        balancer.recoverERC20(address(WETH), 1 ether + 1);
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        balancer.recoverERC20(address(refusing), 1);
        vm.stopPrank();
        assertEq(WETH.balanceOf(address(balancer)), 1 ether);
        assertEq(address(balancer).balance, native);
    }

    function test_pauseCloseAndRetirementDoNotBlockRecovery() public {
        // Public creation pause never freezes existing pool exits.
        factory.setCreationPaused(true);
        vm.prank(creator);
        balancer.retire();
        vm.prank(creator);
        balancer.recoverERC20(address(WETH), 1 ether);
        assertEq(WETH.balanceOf(address(balancer)), 0);
    }
}
