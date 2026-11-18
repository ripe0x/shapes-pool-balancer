// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {IndependentB} from "./IndependentB.t.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {BalancerFactory} from "../src/BalancerFactory.sol";
import {KeeperPolicyV1} from "../src/KeeperPolicyV1.sol";
import {MockNFT} from "../test/utils/Mocks.sol";
contract CurrentStateB is IndependentB {
 function testCurrentDependencyDriftRealLifecycle() public {
 vm.createSelectFork("https://mainnet.gateway.tenderly.co");uint currentBase=block.basefee;fees(currentBase);
 emit log_named_uint("currentBlock",block.number);emit log_named_uint("currentTimestamp",block.timestamp);emit log_named_uint("currentBasefee",currentBase);assertEq(FWA_IMPL.codehash,FWA_CODEHASH);
 address renderer=deployCode("out/ShapePackRenderer.sol/ShapePackRenderer.json",abi.encode(SHAPES));packs=deployCode("out/ShapePacks.sol/ShapePacks.json",abi.encode(SHAPES,renderer,address(this),"B","B",uint(2)));
 PoolBalancer implementation=new PoolBalancer(FWA_FACTORY,FWA_IMPL,FWA_CODEHASH,SHAPES,packs,ENS);factory=new BalancerFactory(address(implementation),keeperAdmin,address(this),address(new KeeperPolicyV1()));nft=new MockNFT();vm.deal(creator,100 ether);vm.deal(buyer,100 ether);vm.deal(keeper,1 ether);
 start(20,1 ether,2500);uint w=wordForSlot(2);uint[] memory req=buy(buyer,1);fulfill(req[0],w);quiesce();(,,,,uint8 status,)=pool.acquisitions(req[0]);assertEq(status,2);assertEq(pool.unsettledAcquisitionCount(),0);unwind();
 }
}
