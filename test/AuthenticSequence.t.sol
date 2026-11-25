// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, IVRFService} from "./utils/ForkBase.sol";
import {MockNFT} from "./utils/Mocks.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {BalancerFactory} from "../src/BalancerFactory.sol";
import {PoolInventory} from "../src/PoolInventory.sol";
import {PoolPage} from "../src/PoolPage.sol";
import {KeeperPolicyCalls} from "../src/KeeperPolicyCalls.sol";
import {IERC721Min} from "../src/interfaces/External.sol";

/// @dev One continuous pool across two distinct historical request blocks; no oracle impersonation or proof recycling.
contract AuthenticSequenceTest is ForkBase {
    string internal corpus;
    address internal coordinator;
    uint256 internal first;
    uint256 internal accepted;
    GasProbe internal probe;

    function key(string memory group, uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".", group, "[", vm.toString(i), "].", field);
    }
    function number(string memory group, uint256 i, string memory field) internal view returns (uint256) {
        return vm.parseUint(vm.parseJsonString(corpus, key(group, i, field)));
    }
    function context(uint256 height) internal {
        if (block.number != height) vm.rollFork(height);
        // Counterfactual economic gas context; canonical request blockhash still binds each genuine proof.
        vm.fee(0.5 gwei); vm.txGasPrice(0.55 gwei);
        probe.record(); assertEq(probe.baseFee(), 0.5 gwei); assertEq(probe.gasPrice(), 0.55 gwei);
    }
    function setUp() public {
        // Canonical transaction-prefix replay includes EIP-7702; compiler target remains Cancun.
        vm.setEvmVersion("prague");
        assertEq(vm.getEvmVersion(), "prague");
        corpus = vm.readFile("test/fixtures/authentic-vrf-proofs.json");
        vm.createSelectFork("mainnet", vm.parseJsonBytes32(corpus, key("previousEntries", 0, "requestTx")));
        assertEq(block.number, number("previousEntries", 0, "requestBlock"));
        vm.fee(0.5 gwei); vm.txGasPrice(0.55 gwei);
        address renderer = deployCode("out/ShapePackRenderer.sol/ShapePackRenderer.json", abi.encode(SHAPES));
        packs = deployCode("out/ShapePacks.sol/ShapePacks.json", abi.encode(SHAPES, renderer, creator, "Pool Prize Packs", "PRIZEPACK", uint256(2)));
        factory = new BalancerFactory(address(new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS)), keeperAdmin, address(this));
        factory.setCreationPaused(false);
        nft = new MockNFT(); curatedRequired = false;
        vm.deal(creator, 10 ether); vm.deal(buyer, 10 ether); vm.deal(keeper, 1 ether);
        createBalancer(5 ether);
        vm.startPrank(creator);
        balancer.configure(2500, uint256(24) | (uint256(12) << 16) | (uint256(2) << 32) | (uint256(1) << 48) | (uint256(8) << 144), shapes.mintFee());
        vm.stopPrank();
        listCurated(100, 0.2 ether);
        vm.prank(creator); balancer.open();
        fillUp(); assertEq(balancer.listedShapePrizes(), 47);
        first = buy(buyer, 1)[0];
        assertEq(first, number("previousEntries", 0, "requestId"));
        coordinator = IVRFService(VRF_SERVICE).coordinator();
        probe = new GasProbe(); probe.record();
        assertEq(probe.gasPrice(), 0.55 gwei); assertEq(probe.baseFee(), 0.5 gwei);
        address[] memory a = new address[](15);
        a[0]=address(pool); a[1]=address(balancer); a[2]=address(factory); a[3]=address(nft); a[4]=packs;
        a[5]=renderer; a[6]=FWA_FACTORY; a[7]=VRF_SERVICE; a[8]=coordinator; a[9]=SHAPES;
        a[10]=address(PoolInventory); a[11]=address(PoolPage); a[12]=address(KeeperPolicyCalls);
        a[13]=factory.implementation(); a[14]=address(probe);
        vm.makePersistent(a); vm.makePersistent(creator,buyer,keeper);
    }
    function submit(string memory group, uint256 i, uint256 id) internal {
        assertEq(id, number(group,i,"requestId"));
        context(number(group,i,"fulfillmentBlock"));
        assertEq(blockhash(number(group,i,"requestBlock")),vm.parseJsonBytes32(corpus,key(group,i,"requestBlockHash")));
        (bool ok,bytes memory reason)=coordinator.call(vm.parseJsonBytes(corpus,key(group,i,"input")));
        if(!ok) assembly { revert(add(reason,32),mload(reason)) }
        ++accepted; pool.processAcquisitions(3);
        (address purchaser,,,uint256 lid,uint8 status,)=pool.acquisitions(id);
        assertEq(status,2); assertEq(purchaser,buyer);
        (address collection,,,uint256 tokenId,,,,)=pool.listings(lid);
        assertEq(IERC721Min(collection).ownerOf(tokenId),buyer);
    }
    function test_distinctHistoricalBatchesContinueAfterActualRestocking() public {
        submit("previousEntries",0,first);
        fillUp();
        assertEq(balancer.reconciledSequence(),1);
        assertEq(balancer.listedShapePrizes(),47);
        assertLt(number("previousEntries",0,"fulfillmentBlock"),number("entries",0,"requestBlock"));
        // Fork immediately before the canonical request, so uncached service slots do not import that request.
        vm.rollFork(vm.parseJsonBytes32(corpus,key("entries",0,"requestTx")));
        context(number("entries",0,"requestBlock"));
        uint256[] memory next=buy(buyer,3);
        for(uint256 i;i<3;++i)submit("entries",i,next[i]);
        fillUp();
        assertEq(accepted,4); assertEq(pool.lastIssuedSequence(),4);
        assertEq(balancer.reconciledSequence(),4); assertEq(pool.unsettledAcquisitionCount(),0);
        assertEq(balancer.listedShapePrizes(),47);
        uint256 credit=balancer.creatorCredit(); assertGt(credit,0);
        balancer.collectProceeds(); assertEq(balancer.creatorCredit(),credit,"keeper already collected each actual sale once");
        vm.prank(creator); balancer.close();
        uint256[] memory ids=balancer.getActiveIds();
        for(uint256 i;i<ids.length;++i){(uint8 kind,,,,)=balancer.items(ids[i]);if(kind==1){vm.prank(creator);balancer.withdrawCurated(ids[i],creator);}}
        ids=balancer.getActiveIds();
        for(uint256 start;start<ids.length;start+=20){uint256 n=ids.length-start>20?20:ids.length-start;uint256[] memory batch=new uint256[](n);for(uint256 i;i<n;++i)batch[i]=ids[start+i];vm.prank(creator);balancer.unlistShapes(batch);}
        uint256 amount=balancer.withdrawableSurplus();assertEq(amount,address(balancer).balance);assertGt(amount,3 ether);
        uint256 wallet=creator.balance;vm.prank(creator);balancer.claimSurplus(amount,creator);assertEq(creator.balance-wallet,amount);
        assertEq(address(balancer).balance,0);assertEq(balancer.creatorCredit(),0);assertEq(balancer.getActiveIds().length,0);
        assertEq(pool.ownerProceeds(),0);assertEq(pool.unsettledAcquisitionCount(),0);
    }
}
