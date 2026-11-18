// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {IndependentB,MoneyB} from "./IndependentB.t.sol";
import {RejectingKeeper} from "../test/utils/Mocks.sol";
interface ReserveBatchB {function reservedListingCount(uint64) external view returns(uint);}
contract StagingAndReceiverB is IndependentB {
 function testSecurityStagedPacksWithConcurrentPurchasesKeepRealCustody() public {start(board(),5 ether,2500);uint[] memory a=buy(buyer,2);vm.prank(creator);balancer.configure(2500,board()+(uint(2)<<144));quiesce();assertEq(balancer.getActiveShapes()[9],10);assertEq(balancer.admissionStatus(),0);uint[] memory b=buy(stranger,3);assertEq(ReserveBatchB(address(pool)).reservedListingCount(3),2);assertEq(pool.reservedStagedCount(),2);fulfill(b[2],uint(keccak256("pack reserved B5")));fulfill(b[0],uint(keccak256("pack reserved B3")));fulfill(a[1],uint(keccak256("pack reserved B2")));fulfill(b[1],uint(keccak256("pack reserved B4")));fulfill(a[0],uint(keccak256("pack reserved B1")));quiesce();assertEq(pool.unsettledAcquisitionCount(),0);assertEq(balancer.reconciledSequence(),5);assertEq(pool.reservedStagedCount(),0);assertEq(MoneyB(address(pool)).acquisitionEscrowTotal(),0);assertLe(balancer.profit(),address(balancer).balance);unwind();}
 function testSecurityRejectingKeeperStillReceivesOnlyBoundedQuote() public {createBalancer(1 ether);configure(20);listCurated(1,1 ether);vm.prank(creator);balancer.open();RejectingKeeper hostile=new RejectingKeeper();hostile.upkeep(address(balancer));assertEq(balancer.getActiveShapes()[0],5);assertGt(address(hostile).balance,0);assertLe(address(hostile).balance,balancer.maxKeeperReward());emit log_named_uint("forcedKeeperPayout",address(hostile).balance);quiesce();unwind();}
}
