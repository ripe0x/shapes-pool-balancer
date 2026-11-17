// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ForkBase, ITimeout} from './utils/ForkBase.sol';
import {PoolBalancer} from '../src/PoolBalancer.sol';
import {IKeeperPolicy} from '../src/interfaces/IKeeperPolicy.sol';
import {IERC721Min} from '../src/interfaces/External.sol';
import {KeeperPolicyCalls} from '../src/KeeperPolicyCalls.sol';
import {ReceiptGas} from './utils/ReceiptGas.sol';

interface BRefund { function acquisitionRefundCredit(address) external view returns(uint256); function withdrawAcquisitionRefund() external returns(uint256); }
contract BContext { uint256 public calls; function check(uint256 base,uint256 bid) external { require(block.basefee==base && tx.gasprice==bid,'fee context absent'); ++calls; } }
// Creator-selected policy is deliberately adversarial; it is an untrusted input accepted by design.
contract BHostilePolicy is IKeeperPolicy {
 bool public fail;
 function setFail(bool f) external { fail=f; }
 function version() external pure returns(uint256){return 99;}
 function interfaceVersion() external pure returns(uint256){return 1;}
 function maxReward() external pure returns(uint256){return .311 ether;}
 function quoteReward(Work calldata) external view returns(uint256){require(!fail,'policy unavailable');return type(uint256).max;}
 function quoteRestock(uint8,uint256 units,uint256) external view returns(uint256){require(!fail,'policy unavailable');return units*.102 ether;}
}
contract IndependentLaunchB is ForkBase {
 address constant BAYC=0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;
 BContext probe;
 function setUp() public { setUpFork(); probe=new BContext(); context(.5 gwei,.55 gwei); createBalancer(0); }
 function context(uint256 base,uint256 bid) internal { vm.fee(base); vm.txGasPrice(bid); probe.check(base,bid); }
 function realCurated(uint256 id) internal returns(uint256 lid){
  IERC721Min a=IERC721Min(BAYC);address holder=a.ownerOf(id);vm.prank(holder);a.transferFrom(holder,creator,id);
  vm.startPrank(creator);a.approve(address(balancer),id);PoolBalancer.CuratedInput[] memory one=new PoolBalancer.CuratedInput[](1);one[0]=PoolBalancer.CuratedInput(BAYC,id,.2 ether);lid=balancer.listCuratedBatch(one)[0];vm.stopPrank();
 }
 function fund(uint256 a) internal {vm.prank(creator);balancer.depositETH{value:a}();}
 function openMinimum() internal returns(uint256 need){uint256 snap=vm.snapshotState();fund(900 ether);vm.prank(creator);balancer.open();need=balancer.requiredReserve();assertTrue(vm.revertToState(snap));fund(need);vm.prank(creator);balancer.open();}
 function paid(uint256 floor) internal returns(uint256 r,uint256 gasBilled){bytes32 h=balancer.settingsHash();vm.prank(keeper,keeper);r=balancer.performUpkeep(h,floor);gasBilled=ReceiptGas.lastBilled();}
 function closeExit() internal {
  vm.prank(creator);balancer.close();
  uint256[] memory active=balancer.getActiveIds();uint256[] memory shapeIds=new uint256[](20);uint256 n;
  for(uint256 i;i<active.length;i++){(uint8 kind,,,,)=balancer.items(active[i]);if(kind==2){shapeIds[n++]=active[i];if(n==20){vm.prank(creator);balancer.unlistShapes(shapeIds);n=0;}}else{vm.prank(creator);balancer.withdrawCurated(active[i],creator);}}
  if(n>0){assembly('memory-safe'){mstore(shapeIds,n)}vm.prank(creator);balancer.unlistShapes(shapeIds);}
  uint256 free=balancer.withdrawableSurplus();vm.prank(creator);balancer.claimSurplus(free,creator);
  assertEq(address(balancer).balance,0,'all creator cash returned');assertEq(pool.ownerProceeds(),0);assertEq(balancer.getActiveIds().length,0,'no retained creator prizes');
 }
 function testB_economicAllSixteenDenominationsMinimumIdleExit() public {
  context(5 gwei,5 gwei);uint256 t;for(uint256 d;d<16;d++)t|=uint256(1)<<(16*d);configure(t);realCurated(101);
  uint256 need=openMinimum();uint256 backing;uint256 units;for(uint256 d;d<16;d++){backing+=balancer.denominationAmount(d);units+=(0x3323232111111111>>(4*d))&15;}
  uint256 setup;uint256 calls;while(balancer.creatorWork()){(uint256 r,)=paid(1);setup+=r;require(++calls<30,'setup stalled');}
  uint16[16] memory have=balancer.getActiveShapes();for(uint256 d;d<16;d++)assertEq(have[d],1);
  assertEq(address(balancer).balance,need-backing-units*.001 ether-setup);uint256 held=address(balancer).balance;
  vm.warp(block.timestamp+30 days);assertEq(address(balancer).balance,held,'idle has no ratcheting keeper debt');
  emit log_named_decimal_uint('all16 backing',backing,18);emit log_named_decimal_uint('all16 mintfees',units*.001 ether,18);emit log_named_decimal_uint('all16 initial minimum',need,18);emit log_named_decimal_uint('all16 setup paid',setup,18);emit log_named_decimal_uint('all16 liquid after setup',held,18);
  uint256 before=address(balancer).balance;vm.prank(creator);balancer.close();uint256[] memory ids=balancer.getActiveIds();uint256[] memory shapesOnly=new uint256[](16);uint256 j;for(uint256 i;i<ids.length;i++){(uint8 kind,,,,)=balancer.items(ids[i]);if(kind==2)shapesOnly[j++]=ids[i];}vm.prank(creator);balancer.unlistShapes(shapesOnly);assertEq(address(balancer).balance-before,backing,'exact real Shape+Pack redeem amount');
  closeExit();assertEq(IERC721Min(BAYC).ownerOf(101),creator);
 }
 function testB_policyFailureRefundCloseDisableRecoveryRoundtrip() public {
  configure(20);realCurated(102);uint256 initial=openMinimum();fillUp();
  BHostilePolicy evil=new BHostilePolicy();vm.prank(creator);balancer.proposeKeeperPolicy(address(evil));vm.warp(block.timestamp+2 days);
  (uint256 req,uint256 shortfall)=balancer.policyFunding(address(evil));if(shortfall>0)fund(shortfall);balancer.activateKeeperPolicy();assertEq(balancer.keeperPolicy(),address(evil));assertEq(balancer.requiredReserve(),req);
  uint256[] memory ids=balancer.getActiveIds();(,,,,uint112 oldPrice)=balancer.items(ids[1]);assertLt(oldPrice,.02 ether,'old listing not repriced to hostile surcharge');
  uint256[] memory requests=buy(buyer,5);assertEq(requests.length,5);uint256 price=pool.acquisitionFee();
  evil.setFail(true);vm.roll(vm.getBlockNumber()+ITimeout(address(pool)).selectionTimeoutBlocks()+1);
  bytes32 h=balancer.settingsHash();vm.prank(keeper);vm.expectRevert();balancer.performUpkeep(h,1);assertEq(balancer.reconciledSequence(),0,'failed quote atomically restores processing');
  vm.prank(creator);balancer.close();uint256 hold=balancer.requiredReserve();assertEq(hold,.007 ether,'five actual current draw obligations');
  vm.prank(creator);balancer.setPaidUpkeepEnabled(false);assertEq(balancer.requiredReserve(),0,'emergency stop releases actual paid hold');
  for(uint256 i;i<3;i++){vm.prank(stranger);balancer.performUpkeepUnpaid();}
  assertEq(balancer.reconciledSequence(),5);assertEq(pool.unsettledAcquisitionCount(),0);
  uint256 refund=BRefund(address(pool)).acquisitionRefundCredit(buyer);assertEq(refund,5*price);assertGt(refund,.06 ether,'absolute protected buyer principal');uint256 before=buyer.balance;vm.prank(buyer);BRefund(address(pool)).withdrawAcquisitionRefund();assertEq(buyer.balance-before,refund);assertEq(BRefund(address(pool)).acquisitionRefundCredit(buyer),0);
  emit log_named_decimal_uint('initial20',initial,18);emit log_named_decimal_uint('principal refunded',refund,18);emit log_named_decimal_uint('closed hold before disabling',hold,18);closeExit();
 }
 function testB_callerFloorAndPolicyAuthorityTransfer() public {
  configure(20);realCurated(103);openMinimum();
  uint256 cash=address(balancer).balance;bytes32 h=balancer.settingsHash();vm.prank(keeper);vm.expectRevert(PoolBalancer.MinimumPaymentNotMet.selector);balancer.performUpkeep(h,1 ether);assertEq(address(balancer).balance,cash);assertEq(balancer.getActiveShapes()[0],0,'no prizes mint on rejected floor');
  BHostilePolicy evil=new BHostilePolicy();vm.prank(stranger);vm.expectRevert(PoolBalancer.Unauthorized.selector);balancer.proposeKeeperPolicy(address(evil));
  vm.prank(creator);balancer.proposeKeeperPolicy(address(evil));vm.expectRevert(PoolBalancer.PolicyNotReady.selector);balancer.activateKeeperPolicy();
  vm.prank(creator);balancer.transferCreator(stranger);vm.prank(stranger);balancer.acceptCreator();assertEq(balancer.pendingKeeperPolicy(),address(0),'new creator cancels old proposal');vm.warp(block.timestamp+2 days);vm.expectRevert(PoolBalancer.PolicyNotReady.selector);balancer.activateKeeperPolicy();
  vm.prank(creator);vm.expectRevert(PoolBalancer.Unauthorized.selector);balancer.claimSurplus(1,creator);
  vm.prank(stranger);balancer.setPaidUpkeepEnabled(false);vm.prank(keeper);vm.expectRevert(PoolBalancer.StaleSettings.selector);balancer.performUpkeep(h,0);
  vm.prank(keeperAdmin);factory.setKeepersRestricted(true);vm.prank(keeper);balancer.performUpkeepUnpaid();assertEq(balancer.getActiveShapes()[0],5,'public unpaid maintenance with restricted keeper list');
 }
 function testB_lowGasManufacturedWorkCoalitionAndCreatorSubsidy() public {
  context(1,2);configure(20);realCurated(104);openMinimum();fillUp();
  BHostilePolicy evil=new BHostilePolicy();vm.prank(creator);balancer.proposeKeeperPolicy(address(evil));vm.warp(block.timestamp+2 days);(,uint256 shortage)=balancer.policyFunding(address(evil));if(shortage>0)fund(shortage);balancer.activateKeeperPolicy();
  uint256 keeperBefore=keeper.balance;uint256 buyerBefore=buyer.balance;uint256 poolBefore=address(balancer).balance;
  uint256 quote=pool.acquisitionFee();uint256 vrf=pool.vrfServiceFee();uint256[] memory requests=buy(buyer,5);assertEq(requests.length,5);
  vm.roll(vm.getBlockNumber()+ITimeout(address(pool)).selectionTimeoutBlocks()+1);uint256 reward;uint256 gasBilled;
  for(uint256 i;i<3;i++){(uint256 r,uint256 g)=paid(1);reward+=r;gasBilled+=g;}
  vm.prank(buyer);BRefund(address(pool)).withdrawAcquisitionRefund();assertEq(buyerBefore-buyer.balance,5*vrf,'expired draw principal fully returns');assertEq(keeper.balance-keeperBefore,reward);assertEq(poolBefore-address(balancer).balance,reward,'actual creator subsidy');
  assertEq(balancer.reconciledSequence(),5);assertEq(pool.unsettledAcquisitionCount(),0);assertGt(reward,.00025 ether,'absolute five verified work fees');assertLt(5*vrf+gasBilled*2,reward,'buyer keeper can earn positive subsidy at minimal gas');
  emit log_named_decimal_uint('lowgas creator subsidy',reward,18);emit log_named_decimal_uint('lowgas five randomness fees',5*vrf,18);emit log_named_decimal_uint('lowgas coalition total external cost',5*vrf+gasBilled*2,18);emit log_named_decimal_uint('lowgas buyer keeper net',reward-5*vrf-gasBilled*2,18);emit log_named_decimal_uint('one draw principal',quote,18);
  // When creator joins coalition the reward is internal; their aggregate change is strictly the external fee+gas cost.
  assertEq((poolBefore+buyerBefore+keeperBefore)-(address(balancer).balance+buyer.balance+keeper.balance),5*vrf);
  closeExit();
 }
}
