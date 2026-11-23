// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, ITimeout} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {IKeeperPolicy} from "../src/interfaces/IKeeperPolicy.sol";
import {KeeperPolicyV1} from "../src/KeeperPolicyV1.sol";
import {KeeperPolicyCalls} from "../src/KeeperPolicyCalls.sol";
import {ERC721} from "solady/tokens/ERC721.sol";

/// @dev An accepted creator-selected counterparty, deliberately requesting every allowed wei and no surcharge.
contract ReserveReviewMaxPolicy is IKeeperPolicy {
    function interfaceVersion() external pure returns(uint256){return 2;}
    function version() external pure returns(uint256){return 1;}
    function quoteReward(Work calldata, Economics calldata) external pure returns(uint256){return type(uint256).max;}
    function quoteRestock(uint8, uint256, uint256, Economics calldata) external pure returns(uint256){return 0;}
}

contract ReserveReviewLowPolicy is IKeeperPolicy {
    function interfaceVersion() external pure returns(uint256){return 2;}
    function version() external pure returns(uint256){return 1;}
    function quoteReward(Work calldata, Economics calldata) external pure returns(uint256){return 0.00005 ether;}
    function quoteRestock(uint8, uint256, uint256, Economics calldata) external pure returns(uint256){return 0;}
}

/// @dev Creator-created collection, which FWA accepts without an allowlist.
contract ReserveReviewNFT is ERC721 {
    address public immutable controller=msg.sender;
    address public refusedRecipient;
    function setRefused(address recipient) external {require(msg.sender==controller);refusedRecipient=recipient;}
    function _beforeTokenTransfer(address,address to,uint256) internal view override {require(to==address(0)||to!=refusedRecipient,"collection refused recipient");}
    function name() public pure override returns(string memory){return "Economic review";}
    function symbol() public pure override returns(string memory){return "ECON";}
    function tokenURI(uint256) public pure override returns(string memory){return "";}
    function mint(address to,uint256 id) external {_mint(to,id);}
}

contract ReserveReviewContext {
    uint256 public observedBaseFee;
    uint256 public observedGasPrice;
    function record() external {observedBaseFee=block.basefee;observedGasPrice=tx.gasprice;}
}

interface ReserveReviewRefund {
    function acquisitionRefundCredit(address) external view returns(uint256);
    function withdrawAcquisitionRefund() external returns(uint256);
}

contract ReserveEconomicReviewTest is ForkBase {
    function setUp() public {
        setUpFork();
        vm.fee(0.0005 gwei);
        vm.txGasPrice(0.001 gwei);
        ReserveReviewContext probe=new ReserveReviewContext();probe.record();
        assertEq(probe.observedBaseFee(),500_000);
        assertEq(probe.observedGasPrice(),1_000_000);
        createBalancer(1 ether);
        configure(plan([uint256(20),0,0,0,0,0,0,0,0]));
        listCurated(1,0.2 ether);
        address hostile=address(new ReserveReviewMaxPolicy());
        vm.prank(creator);balancer.setKeeperPolicy(hostile);
        vm.prank(creator);balancer.open();
        fillUp();
        assertEq(balancer.getActiveShapes()[0],20);
        assertEq(balancer.requiredReserve(),(3_200_000+V1_OVERHEAD)*0.0505 gwei+0.0002 ether,"one current call, no hypothetical full future board");
    }

    function test_manufacturedExpiredDrawPaysBuyerKeeperButCostsTheirCreator() public {
        uint256 creatorStart=address(balancer).balance;
        uint256 bkStart=buyer.balance+keeper.balance;
        (uint256 price,uint256 vrf,uint256 total)=pool.quoteAcquisitionPrice(1);
        assertEq(vrf,2_340_000_000_000,"deployed VRF fee at .001 gwei");
        buy(buyer,1);
        vm.roll(block.number+ITimeout(address(pool)).selectionTimeoutBlocks()+1);
        upkeep();
        assertEq(balancer.reconciledSequence(),1,"expired draw was actually reconciled");
        assertEq(ReserveReviewRefund(address(pool)).acquisitionRefundCredit(buyer),price);
        vm.prank(buyer);ReserveReviewRefund(address(pool)).withdrawAcquisitionRefund();
        uint256 reward=creatorStart-address(balancer).balance;
        assertGt(reward,vrf,"buyer+keeper can earn from creator subsidy before gas");
        assertEq(buyer.balance+keeper.balance-bkStart,reward-vrf);
        assertEq(creatorStart+bkStart-address(balancer).balance-buyer.balance-keeper.balance,vrf,"internal keeper reward cancels from coalition wealth");
        assertEq(total,price+vrf);
        emit log_named_decimal_uint("expired draw reward",reward,18);
        emit log_named_decimal_uint("expired draw coalition loss before gas",vrf,18);
    }

    function test_creatorManufacturedUnlistRestockLosesMintFeeBeyondInternalReward() public {
        uint256 creatorStart=address(balancer).balance;
        uint256 keeperStart=keeper.balance;
        uint256[] memory ids=balancer.getActiveIds();
        uint256[] memory selected=new uint256[](1);
        for(uint256 i;i<ids.length;++i){(uint8 kind,,,,)=balancer.items(ids[i]);if(kind==2){selected[0]=ids[i];break;}}
        vm.prank(creator);balancer.unlistShapes(selected);
        assertEq(address(balancer).balance,creatorStart+0.01 ether,"actual backing returned");
        upkeep();
        assertEq(balancer.getActiveShapes()[0],20);
        uint256 reward=keeper.balance-keeperStart;
        assertGt(reward,0.00002 ether,"gas paid beyond the one work fee");
        assertEq(creatorStart+keeperStart-address(balancer).balance-keeper.balance,0.001 ether,"only new mint fee leaves coalition before gas");
        assertEq(_listedFees(balancer),0,"hostile zero quote never becomes imagined cash");
    }

    function test_largeWinWithoutTopupsHasHonestSlowRecoveryAndCreatorAllocation() public {
        // A fresh default-policy pool isolates the launch economics from the hostile policy cases.
        vm.fee(0.5 gwei);vm.txGasPrice(0.55 gwei);
        ReserveReviewContext probe=new ReserveReviewContext();probe.record();
        assertEq(probe.observedBaseFee(),0.5 gwei);assertEq(probe.observedGasPrice(),0.55 gwei);
        vm.prank(creator);balancer=_createFixture(creator, bytes32(uint256(1)), 110 ether);
        pool=balancer.pool();
        configure(plan([uint256(19),0,0,0,0,0,0,0,1]));
        listCurated(2,0.2 ether);
        vm.prank(creator);balancer.open();fillUp();
        uint256 surplus=balancer.withdrawableSurplus();
        vm.prank(creator);balancer.claimSurplus(surplus,creator);
        assertEq(address(balancer).balance,0.001993 ether,"only current-call buffer remains liquid");
        assertEq(_listedFees(balancer),0.01401 ether,"unsold fee expectation is distinct from liquid ETH");
        uint256 top;uint256 topSlot;uint256 token;
        uint256[] memory ids=balancer.getActiveIds();
        for(uint256 i;i<ids.length;++i){(uint8 kind,uint8 d,,,)=balancer.items(ids[i]);if(kind==2&&d==8){top=ids[i];(,,,token,,,topSlot,)=pool.listings(top);break;}}
        assertGt(top,0);
        uint256[] memory requests=buy(buyer,1);fulfill(requests[0],wordForSlot(topSlot));
        assertEq(shapes.ownerOf(token),buyer);
        upkeep();
        assertEq(balancer.getActiveShapes()[8],0);
        assertEq(balancer.admissionStatus(),0);
        assertFalse(balancer.creatorWork());
        assertGt(balancer.requiredReserve(),100 ether);
        uint256 beforeFund=address(balancer).balance-balancer.creatorCredit();
        uint256 beforeProfit=balancer.creatorCredit();
        for(uint256 n;n<10;++n){
            uint256 slot;
            uint256[] memory current=balancer.getActiveIds();
            for(uint256 i;i<current.length;++i){(uint8 kind,uint8 d,,,)=balancer.items(current[i]);if(kind==2&&d==0){(,,,,,,slot,)=pool.listings(current[i]);break;}}
            uint256[] memory request=buy(buyer,1);fulfill(request[0],wordForSlot(slot));upkeep();
            assertEq(balancer.getActiveShapes()[0],19,"ordinary small prizes still restock without topups");
            assertEq(balancer.getActiveShapes()[8],0,"large deficit remains missing");
            assertEq(balancer.admissionStatus(),0);
        }
        uint256 gain=(address(balancer).balance-balancer.creatorCredit())-beforeFund;
        uint256 creatorGain=balancer.creatorCredit()-beforeProfit;
        assertGt(gain,0,"fund accumulates actual ETH");assertGt(creatorGain,0,"above10percent creator allocation is still booked");
        assertEq(balancer.withdrawableSurplus(),balancer.creatorCredit());
        emit log_named_decimal_uint("ten small draws real fund gain after100ETHwin",gain,18);
        emit log_named_decimal_uint("ten small draws creator booked profit",creatorGain,18);
        emit log_named_uint("conditional draws for100ETH at observed gain",100 ether*10/gain);
        vm.prank(creator);balancer.close();
        uint256[] memory all=balancer.getActiveIds();uint256[] memory small=new uint256[](19);uint256 count;
        for(uint256 i;i<all.length;++i){(uint8 kind,,,,)=balancer.items(all[i]);if(kind==2)small[count++]=all[i];}
        assertEq(count,19);
        uint256 liquid=address(balancer).balance;
        vm.prank(creator);balancer.unlistShapes(small);
        assertEq(address(balancer).balance,liquid+0.19 ether);
        uint256 claim=balancer.withdrawableSurplus();vm.prank(creator);balancer.claimSurplus(claim,creator);
        assertEq(address(balancer).balance,0);
        assertEq(pool.ownerProceeds(),0);
    }

    function test_maturePolicySwitchFundsCurrentDrawAndPreservesOldListingPrices() public {
        vm.fee(0.5 gwei);vm.txGasPrice(0.55 gwei);
        ReserveReviewContext probe=new ReserveReviewContext();probe.record();
        assertEq(probe.observedBaseFee(),0.5 gwei);assertEq(probe.observedGasPrice(),0.55 gwei);
        vm.prank(creator);balancer=_createFixture(creator, bytes32(uint256(2)), 1 ether);
        pool=balancer.pool();configure(plan([uint256(20),0,0,0,0,0,0,0,0]));listCurated(3,0.2 ether);
        // Minimal local economics: no gas reimbursement and a 0.000005 ETH work fee, so one call can cost at most 0.00005.
        IKeeperPolicy.Economics memory low=_econWith(address(new ReserveReviewLowPolicy()));
        low.gasPriceCeiling=0;low.workFee=0.000005 ether;
        vm.prank(creator);balancer.setLocalEconomics(low);
        vm.prank(creator);balancer.open();fillUp();
        uint256 free=balancer.withdrawableSurplus();vm.prank(creator);balancer.claimSurplus(free,creator);
        assertEq(address(balancer).balance,0.00005 ether);
        uint256[] memory listings=balancer.getActiveIds();
        uint256 oldShape;uint112 oldBase;uint112 oldPrice;
        for(uint256 i;i<listings.length;++i){(uint8 kind,,,uint112 bs,uint112 pr)=balancer.items(listings[i]);if(kind==2){oldShape=listings[i];oldBase=bs;oldPrice=pr;break;}}
        assertEq(oldPrice,0.0125 ether);
        IKeeperPolicy.Economics memory higher=_econWith(address(new ReserveReviewMaxPolicy()));
        uint256[] memory request=buy(buyer,1);
        assertEq(pool.lastIssuedSequence()-balancer.reconciledSequence(),1);
        (uint256 required,uint256 shortfall)=balancer.maintenanceFunding(higher);
        assertEq(required,_workingBufferAt(0.55 gwei)+(2_150_000+V1_OVERHEAD)*0.55 gwei+0.00002 ether,"one current call plus one actual draw");
        assertEq(shortfall,required-0.00005 ether);
        vm.prank(creator);vm.expectRevert(PoolBalancer.ReserveNotFunded.selector);balancer.setLocalEconomics(higher);
        vm.prank(creator);balancer.depositETH{value:shortfall}();vm.prank(creator);balancer.setLocalEconomics(higher);
        (,,,uint112 afterBase,uint112 afterPrice)=balancer.items(oldShape);
        assertEq(afterBase,oldBase);assertEq(afterPrice,oldPrice,"activation never reprices unsold old inventory");
        fulfill(request[0],0);upkeep();
        assertEq(balancer.reconciledSequence(),1);assertEq(pool.unsettledAcquisitionCount(),0);
    }

    function test_disableThenWindDownReleasesOnlyActualLiquidETHAndBacking() public {
        uint256 liquid=address(balancer).balance;
        vm.prank(creator);balancer.setPaidUpkeepEnabled(false);
        assertEq(balancer.requiredReserve(),0);
        assertEq(balancer.withdrawableSurplus(),liquid);
        vm.prank(creator);balancer.close();
        uint256[] memory ids=balancer.getActiveIds();
        uint256[] memory selected=new uint256[](20);uint256 n;
        for(uint256 i;i<ids.length;++i){(uint8 kind,,,,)=balancer.items(ids[i]);if(kind==2)selected[n++]=ids[i];}
        assertEq(n,20);
        vm.prank(creator);balancer.unlistShapes(selected);
        assertEq(address(balancer).balance,liquid+0.2 ether,"20 real Shapes redeem exact principal");
        uint256 all=balancer.withdrawableSurplus();
        vm.prank(creator);balancer.claimSurplus(all,creator);
        assertEq(address(balancer).balance,0);
        assertEq(_listedFees(balancer),0);
        assertEq(pool.ownerProceeds(),0);
    }
}
