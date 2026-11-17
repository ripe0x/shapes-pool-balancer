// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {IKeeperPolicy} from "../src/interfaces/IKeeperPolicy.sol";
import {ERC721} from "solady/tokens/ERC721.sol";
import {console2} from "forge-std/console2.sol";
interface AFWA {function acquisitionRefundCredit(address) external view returns(uint256); function withdrawAcquisitionRefund() external returns(uint256);}
contract AHostilePolicy is IKeeperPolicy {
 bool public fail;
 function arm(bool value) external {fail=value;}
 function version() external pure returns(uint256){return 31337;}
 function interfaceVersion() external pure returns(uint256){return 1;}
 function maxReward() external pure returns(uint256){return .311 ether;}
 function quoteReward(Work calldata) external view returns(uint256){require(!fail,"broken"); return type(uint256).max;}
 function quoteRestock(uint8,uint256 units,uint256) external view returns(uint256){require(!fail,"broken");return units*.001 ether;}
}
contract AHostileNFT is ERC721 {
 bool public frozen;
 function name() public pure override returns(string memory){return "Hostile";}
 function symbol() public pure override returns(string memory){return "H";}
 function tokenURI(uint256) public pure override returns(string memory){return "";}
 function mint(address who,uint256 id) external {_mint(who,id);}
 function freeze(bool f) external {frozen=f;}
 function _beforeTokenTransfer(address from,address,uint256) internal view override {require(!frozen||from==address(0),"frozen");}
}
contract AuditACandidate is ForkBase {
 function setUp() public {setUpFork();}
 function context(uint256 fee,uint256 price) internal {vm.fee(fee);vm.txGasPrice(price);assertEq(block.basefee,fee);assertEq(tx.gasprice,price);}
 function start(uint256 t,uint256 deposit,uint16 markup) internal {createBalancer(deposit);vm.prank(creator);balancer.configure(markup,t);listCurated(1,1 ether);vm.prank(creator);balancer.open();}
 function allShapeIds() internal view returns(uint256[] memory ids){uint256[] memory active=balancer.getActiveIds();uint256 n;for(uint256 i;i<active.length;i++){(uint8 k,,,,)=balancer.items(active[i]);if(k==2)n++;}ids=new uint256[](n);n=0;for(uint256 i;i<active.length;i++){(uint8 k,,,,)=balancer.items(active[i]);if(k==2)ids[n++]=active[i];}}
 function balancerAmount(uint256 d) internal pure returns(uint256){uint256 a=0x9c400fa00c800190014000300022710138803e801f400640032000a00050001;return((a>>(16*d))&65535)*.01 ether;}
 function testAll16BackingRoundTrips() public {
  context(.5 gwei,1 gwei);uint256 t;uint256 backing;uint256 units;
  for(uint256 d;d<16;d++){t|=uint256(1)<<(16*d);backing+=balancerAmount(d);units+=d<9?1:((d==10||d==12||d==14||d==15)?3:2);}
  start(t,500 ether,2500);uint256 before=address(balancer).balance;uint256 keeperBefore=keeper.balance;fillUp();assertEq(balancer.listedShapePrizes(),16);assertEq(balancer.creatorWork(),false);
  uint256 paid=keeper.balance-keeperBefore;assertEq(before-address(balancer).balance,backing+units*.001 ether+paid,"backing+real mint fees+actual keeper pay");assertGt(balancer.listedRestockFees(),0);uint256 liquid=address(balancer).balance;
  vm.prank(creator);balancer.close();uint256[] memory ids=allShapeIds();vm.prank(creator);balancer.unlistShapes(ids);assertEq(address(balancer).balance-liquid,backing,"every Shape/Pack returns exact backing");assertEq(balancer.listedRestockFees(),0);assertEq(balancer.profitShareSum(),0);
  vm.prank(creator);balancer.withdrawCurated(1,creator);uint256 claim=balancer.withdrawableSurplus();vm.prank(creator);balancer.claimSurplus(claim,creator);assertEq(address(balancer).balance,0);assertEq(pool.ownerProceeds(),0);assertEq(pool.activeListingCount(),0);
  console2.log("all16 backing",backing);console2.log("all16 mint fees",units*.001 ether);console2.log("all16 keeper pay",paid);
 }
 function testMinimumCapitalExactAndPaidAtomicFloor() public {
  context(.5 gwei,1 gwei);start(20,.2356 ether,2500);assertEq(balancer.requiredReserve(),.2356 ether);uint256 bal=address(balancer).balance;uint256 k=keeper.balance;bytes32 h=balancer.settingsHash();
  vm.prank(keeper,keeper);vm.expectRevert(PoolBalancer.MinimumPaymentNotMet.selector);balancer.performUpkeep(h,1 ether);assertEq(address(balancer).balance,bal);assertEq(keeper.balance,k);assertEq(balancer.listedShapePrizes(),0);
  fillUp();assertEq(balancer.listedShapePrizes(),20);assertEq(balancer.admissionStatus(),0);console2.log("minimum setup keeper pay",keeper.balance-k);
 }
 function testClosedPendingExpiryPreservesBuyerRefund() public {
  context(.5 gwei,1 gwei);start(20,1 ether,2500);fillUp();(uint256 draw,uint256 vrf,uint256 total)=pool.quoteAcquisitionPrice(1);uint256 buyerBefore=buyer.balance;buy(buyer,1);assertEq(buyerBefore-buyer.balance,total);assertEq(total,draw+vrf);vm.prank(creator);balancer.close();
  uint256 hold=balancer.requiredReserve();uint256 before=address(balancer).balance;uint256 claim=balancer.withdrawableSurplus();vm.prank(creator);balancer.claimSurplus(claim,creator);assertEq(address(balancer).balance,hold);assertGt(hold,0);assertLt(hold,before);
  vm.roll(block.number+31);upkeep();assertEq(pool.unsettledAcquisitionCount(),0);assertEq(balancer.requiredReserve(),0);assertEq(AFWA(address(pool)).acquisitionRefundCredit(buyer),draw);uint256 buyerRefundBefore=buyer.balance;vm.prank(buyer);AFWA(address(pool)).withdrawAcquisitionRefund();assertEq(buyer.balance-buyerRefundBefore,draw);assertEq(buyerBefore-buyer.balance,vrf,"only actual randomness fee irreversible");
  vm.prank(creator);balancer.setPaidUpkeepEnabled(false);uint256[] memory ids=allShapeIds();vm.prank(creator);balancer.unlistShapes(ids);vm.prank(creator);balancer.withdrawCurated(1,creator);claim=balancer.withdrawableSurplus();vm.prank(creator);balancer.claimSurplus(claim,creator);assertEq(address(balancer).balance,0);
  console2.log("expired buyer draw refund",draw);console2.log("expired buyer VRF loss",vrf);console2.log("closed real hold",hold);
 }
 function testFrozenCuratedRefundRecoveryRight() public {
  context(.5 gwei,1 gwei);createBalancer(1 ether);configure(20);AHostileNFT hostile=new AHostileNFT();hostile.mint(creator,71);PoolBalancer.CuratedInput[] memory input=new PoolBalancer.CuratedInput[](1);input[0]=PoolBalancer.CuratedInput(address(hostile),71,.02 ether);
  vm.startPrank(creator);hostile.approve(address(balancer),71);balancer.listCuratedBatch(input);balancer.open();vm.stopPrank();fillUp();hostile.freeze(true);(uint256 draw,uint256 vrf,)=pool.quoteAcquisitionPrice(1);uint256[] memory requests=buy(buyer,1);fulfill(requests[0],0);settle();upkeep();
  (,,,,,,,uint8 status)=pool.listings(1);assertEq(status,6);assertEq(hostile.ownerOf(71),address(pool));assertEq(pool.ownerProceeds(),0);vm.prank(creator);vm.expectRevert();pool.refundFailedDelivery(1);vm.warp(block.timestamp+7 days);vm.prank(buyer);pool.refundFailedDelivery(1);assertEq(AFWA(address(pool)).acquisitionRefundCredit(buyer),draw);vm.prank(creator);vm.expectRevert();balancer.recoverRefunded(1,creator);
  hostile.freeze(false);vm.prank(creator);balancer.recoverRefunded(1,creator);assertEq(hostile.ownerOf(71),creator);assertEq(AFWA(address(pool)).acquisitionRefundCredit(buyer),draw);vm.prank(buyer);AFWA(address(pool)).withdrawAcquisitionRefund();console2.log("failed delivery refund",draw);console2.log("failed delivery VRF cost",vrf);
 }
 function testPolicyFailureEmergencyAndUnpaidRecovery() public {
  context(.5 gwei,1 gwei);start(20,2 ether,2500);fillUp();AHostilePolicy hostile=new AHostilePolicy();vm.prank(creator);balancer.proposeKeeperPolicy(address(hostile));vm.warp(block.timestamp+2 days);balancer.activateKeeperPolicy();uint256[] memory one=new uint256[](1);one[0]=allShapeIds()[0];vm.prank(creator);balancer.unlistShapes(one);
  hostile.arm(true);uint256 before=address(balancer).balance;bytes32 h=balancer.settingsHash();vm.prank(keeper);vm.expectRevert();balancer.performUpkeep(h);assertEq(address(balancer).balance,before);assertEq(balancer.listedShapePrizes(),19);
  vm.prank(creator);balancer.proposeKeeperPolicy(address(hostile));vm.warp(block.timestamp+2 days);vm.prank(creator);balancer.setPaidUpkeepEnabled(false);vm.expectRevert();balancer.activateKeeperPolicy();vm.prank(stranger);balancer.performUpkeepUnpaid();assertEq(balancer.listedShapePrizes(),20);assertEq(before-address(balancer).balance,.011 ether);assertFalse(balancer.paidUpkeepEnabled());
 }
 function testLowGasManufacturedExpiryCoalition() public {
  context(0,0);start(20,1 ether,2500);fillUp();AHostilePolicy hostile=new AHostilePolicy();vm.prank(creator);balancer.proposeKeeperPolicy(address(hostile));vm.warp(block.timestamp+2 days);balancer.activateKeeperPolicy();uint256 coalitionBefore=creator.balance+buyer.balance+keeper.balance+address(balancer).balance;uint256 k=keeper.balance;(uint256 draw,uint256 vrf,)=pool.quoteAcquisitionPrice(1);buy(buyer,1);vm.roll(block.number+31);upkeep();vm.prank(buyer);AFWA(address(pool)).withdrawAcquisitionRefund();uint256 coalitionAfter=creator.balance+buyer.balance+keeper.balance+address(balancer).balance;
  assertEq(keeper.balance-k,.00005 ether,"immutable service cap at zero gas");assertEq(coalitionBefore-coalitionAfter,vrf,"service transfers internal to coalition");assertEq(AFWA(address(pool)).acquisitionRefundCredit(buyer),0);assertGt(draw,0);console2.log("zero-gas manufactured keeper subsidy",keeper.balance-k);console2.log("zero-gas coalition cost",coalitionBefore-coalitionAfter);
 }
}
