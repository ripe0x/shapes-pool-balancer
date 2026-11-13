// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ForkBase} from "../utils/ForkBase.sol";
import {PoolBalancer} from "../../src/PoolBalancer.sol";

contract LowBalanceHoldProbe is ForkBase {
    function test_closeAfterTwoLargestWinsAtMinimumOpenReserve() public {
        setUpFork();
        vm.fee(4.95 gwei);
        vm.txGasPrice(5 gwei);
        createBalancer(80 ether);
        uint256[16] memory c;
        c[15] = 1; // one 25 ETH Pack
        vm.prank(creator);
        balancer.configure(2500, plan16(c));
        listCurated(1, 1); // untrusted collection with the cheapest permitted listing
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256 available = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(available, creator);
        emit log_named_decimal_uint("fund at minimum reserve", address(balancer).balance, 18);
        for (uint256 win; win < 2; ++win) {
            uint256[] memory lids = balancer.getActiveIds();
            uint256 topLid;
            for (uint256 i; i < lids.length; ++i) {
                (uint8 kind, uint8 d,,,) = balancer.items(lids[i]);
                if (kind == 2 && d == 15) topLid = lids[i];
            }
            assertGt(topLid, 0, "25 ETH Pack still listed");
            uint256[] memory req = buy(buyer, 1);
            (,,,,,, uint256 slot,) = pool.listings(topLid);
            fulfill(req[0], wordForSlot(slot));
            settle();
            (,,,,,,, uint8 st) = pool.listings(topLid);
            assertEq(st, 4, "top won");
            if (win == 0) {
                vm.prank(keeper, keeper);
                balancer.performUpkeep();
                emit log_named_decimal_uint("fund after first restock", address(balancer).balance, 18);
            }
        }
        vm.prank(creator);
        balancer.close();
        emit log_named_decimal_uint("fund at close", address(balancer).balance, 18);
        emit log_named_decimal_uint("held pay at close", balancer.requiredReserve(), 18);
        assertGe(address(balancer).balance, balancer.requiredReserve(), "hold is funded");
        available = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(available, creator);
        uint256 before = keeper.balance;
        vm.prank(keeper, keeper);
        balancer.performUpkeep();
        emit log_named_decimal_uint("keeper paid after close", keeper.balance - before, 18);
        assertGt(keeper.balance - before, 0.0001 ether);
        assertEq(balancer.requiredReserve(), 0);
    }
}
