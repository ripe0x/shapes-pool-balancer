// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "../utils/ForkBase.sol";
import {PoolBalancer} from "../../src/PoolBalancer.sol";

contract OwnHoldChallenge is ForkBase {
    function setUp() public {
        setUpFork();
        vm.fee(5 gwei);
        vm.txGasPrice(10 gwei);
        createBalancer(5 ether);
        configure(plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        listCurated(1, 0.3 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
    }

    function test_holdAfterCloseReopenRetireAndUnprocessedDraws() public {
        buy(buyer, 5);
        assertEq(pool.lastIssuedSequence(), 5);
        assertEq(pool.nextSequenceToProcess(), 1);
        vm.prank(creator);
        balancer.close();
        uint256 held = balancer.requiredReserve();
        assertEq(held, 0.01635 ether);
        uint256 available = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(available, creator);
        assertEq(address(balancer).balance, held);

        // Reopening with only the held pay cannot remove the hold; it needs fresh backing.
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.ReserveNotFunded.selector);
        balancer.open();
        assertEq(balancer.requiredReserve(), held);
        vm.prank(creator);
        balancer.depositETH{value: 5 ether}();
        vm.prank(creator);
        balancer.open();
        assertTrue(balancer.enabled());
        vm.prank(creator);
        balancer.close();
        available = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(available, creator);
        assertEq(address(balancer).balance, held);

        // FWA retirement leaves ordered expiry and keeper reconciliation usable.
        vm.prank(creator);
        balancer.retire();
        assertTrue(pool.retired());
        vm.roll(block.number + 100);
        for (uint256 i; i < 5; ++i) {
            pool.processAcquisitions(1);
            uint256 before = keeper.balance;
            vm.prank(keeper, keeper);
            balancer.performUpkeep();
            assertGt(keeper.balance - before, 0.0001 ether);
        }
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence());
        assertEq(balancer.requiredReserve(), 0);
        available = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(available, creator);
        assertEq(address(balancer).balance, 0);
    }
}
