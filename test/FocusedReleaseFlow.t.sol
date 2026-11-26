// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {FlowBreakdown} from "./utils/FlowBreakdown.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {BalancerFactory} from "../src/BalancerFactory.sol";

interface IFocusedWETH {
    function deposit() external payable;
    function transfer(address,uint256) external returns(bool);
    function balanceOf(address) external view returns(uint256);
}

/// @dev Focused native-capital ledger plus separate NFT/ERC20 facts. No draw or synthetic oracle is used.
contract FocusedReleaseFlowTest is ForkBase, FlowBreakdown {
    uint256 internal deposited;
    uint256 internal returned;
    bool internal verified;
    receive() external payable {}
    function setUp() public { setUpFork(); }
    function flowEvidenceValidated() internal view override returns(bool) { return verified; }
    function flowDir() internal pure override returns(string memory) { return "docs/receipts/flow/inventory-update-v2"; }
    function flowInflows() internal view override returns(Item[] memory a) { a=new Item[](1);a[0]=Item("native capital supplied",deposited); }
    function flowOutflows() internal view override returns(Item[] memory a) { a=new Item[](1);a[0]=Item("native capital returned",returned); }
    function flowBuckets() internal view override returns(Bucket[] memory a) { a=new Bucket[](1);a[0]=Bucket("Balancer native capital",address(balancer)==address(0)?0:address(balancer).balance,true,deposited-returned,true,0); }
    function flowFlows() internal view override returns(Flow[] memory a) { a=new Flow[](1);a[0]=Flow("creator native capital roundtrip",deposited,true,returned); }
    function seed() internal { createBalancer(1 ether);deposited=1 ether;assertEq(address(balancer).balance,1 ether); }
    function exit(address owner) internal {
        uint256 amount=balancer.withdrawableSurplus();assertEq(amount,address(balancer).balance);
        uint256 before=owner.balance;vm.prank(owner);balancer.claimSurplus(amount,owner);
        assertEq(owner.balance-before,amount);returned+=amount;
        assertEq(address(balancer).balance,0);assertEq(balancer.creatorCredit(),0);assertEq(pool.ownerProceeds(),0);assertEq(balancer.getActiveIds().length,0);assertEq(pool.activeListingCount(),0);
    }
    function test_focusedInventoryRoundtrip() public {
        Snap memory a=flowBegin(1 gwei,0.5 gwei,FORK_BLOCK);seed();
        uint256[] memory ids=new uint256[](2);ids[0]=listCurated(11,0.2 ether);ids[1]=listCurated(12,0.3 ether);
        uint256[] memory prices=new uint256[](2);prices[0]=0.4 ether;prices[1]=0.6 ether;
        vm.startPrank(creator);balancer.updateCuratedPricesBatch(ids,prices);balancer.withdrawCuratedBatch(ids,creator);vm.stopPrank();
        assertEq(nft.ownerOf(11),creator);assertEq(nft.ownerOf(12),creator);
        assertEq(pool.activeListingCount(),0);assertEq(balancer.getActiveIds().length,0);
        assertEq(address(balancer).balance,1 ether);exit(creator);verified=true;
        Fact[] memory f=new Fact[](3);f[0]=Fact("nfts_returned",2);f[1]=Fact("assets_left",0);f[2]=Fact("native_lost",deposited-returned);
        flowReport("inventory_roundtrip",a,f);
    }
    function test_focusedERC20Roundtrip() public {
        Snap memory a=flowBegin(1 gwei,0.5 gwei,FORK_BLOCK);seed();
        IFocusedWETH weth=IFocusedWETH(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
        vm.startPrank(stranger);weth.deposit{value:1 ether}();assertTrue(weth.transfer(address(balancer),1 ether));vm.stopPrank();
        uint256 before=weth.balanceOf(creator);
        vm.startPrank(creator);balancer.recoverERC20(address(weth),0.4 ether);balancer.recoverERC20(address(weth),0.6 ether);vm.stopPrank();
        assertEq(weth.balanceOf(creator)-before,1 ether);assertEq(weth.balanceOf(address(balancer)),0);
        assertEq(address(balancer).balance,1 ether);assertEq(balancer.creatorCredit(),0);exit(creator);verified=true;
        Fact[] memory f=new Fact[](3);f[0]=Fact("erc20_returned_wei",1 ether);f[1]=Fact("assets_left",0);f[2]=Fact("native_lost",deposited-returned);
        flowReport("erc20_roundtrip",a,f);
    }
    function test_focusedCreationPause() public {
        Snap memory a=flowBegin(1 gwei,0.5 gwei,FORK_BLOCK);
        factory.setCreationPaused(true);
        PoolBalancer.CreationConfig memory c=PoolBalancer.CreationConfig(MARKUP,0,1,shapes.mintFee(),false,factory.creationSettingsHash());
        uint256 before=stranger.balance;vm.prank(stranger);vm.expectRevert(BalancerFactory.CreationPaused.selector);
        factory.createBalancer{value:0.1 ether}(bytes32(uint256(77)),c,new PoolBalancer.CuratedInput[](0));
        assertEq(stranger.balance,before);assertEq(address(factory).balance,0);
        vm.deal(address(this),1 ether);
        balancer=PoolBalancer(payable(factory.createBalancer{value:0.1 ether}(bytes32(uint256(78)),c,new PoolBalancer.CuratedInput[](0))));
        pool=balancer.pool();deposited=0.1 ether;assertEq(balancer.creator(),address(this));assertEq(address(balancer).balance,0.1 ether);
        balancer.close();exit(address(this));assertTrue(factory.creationPaused());verified=true;
        Fact[] memory f=new Fact[](4);f[0]=Fact("public_creation_paused",1);f[1]=Fact("rejected_creation_value_moved",0);f[2]=Fact("assets_left",0);f[3]=Fact("native_lost",deposited-returned);
        flowReport("creation_pause",a,f);
    }
}
