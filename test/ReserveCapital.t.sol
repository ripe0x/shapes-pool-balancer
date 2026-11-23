// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {KeeperPolicyCalls} from "../src/KeeperPolicyCalls.sol";
import {KeeperPolicyV1} from "../src/KeeperPolicyV1.sol";
import {IKeeperPolicy} from "../src/interfaces/IKeeperPolicy.sol";
import {ITimeout} from "./utils/ForkBase.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";
import {ReceiptGas} from "./utils/ReceiptGas.sol";

interface IRefunds {
    function acquisitionRefundCredit(address) external view returns (uint256);
    function withdrawAcquisitionRefund() external;
}

contract ReserveCapitalTest is ForkBase {
    function setUp() public {
        setUpFork();
        vm.txGasPrice(0.55 gwei);
        vm.fee(0.5 gwei);
        GasProbe contextProbe = new GasProbe(); contextProbe.record();
        assertEq(contextProbe.baseFee(),0.5 gwei,"basefee inside executed context");
        assertEq(contextProbe.gasPrice(),0.55 gwei,"bid inside executed context");
        createBalancer(0);
    }

    function _deposit(uint256 amount) internal {
        vm.prank(creator);
        balancer.depositETH{value: amount}();
    }

    function _quoteOpen() internal returns (uint256 required) {
        // policyFunding previews the enabled target after it is already open; opening itself checks this exact value.
        uint256 snapshot = vm.snapshotState();
        _deposit(1_000 ether);
        vm.prank(creator); balancer.open();
        required = balancer.requiredReserve();
        vm.revertToState(snapshot);
    }

    function _paid() internal returns (uint256 reward, uint256 billed) {
        bytes32 generation = balancer.settingsHash();
        vm.prank(keeper, keeper);
        reward = balancer.performUpkeep(generation, 1, 0);
        billed = ReceiptGas.lastBilled();
    }

    function test_exactMinimumTwentyShapeOpeningAndPaidSetup() public {
        configure(plan([uint256(20),0,0,0,0,0,0,0,0]));
        listCurated(1, 0.2 ether);
        uint256 need = _quoteOpen();
        assertEq(need, 0.2356 ether, "inventory .22 + four listing bounds .01192 + call buffer .00368");
        _deposit(need - 1);
        vm.prank(creator); vm.expectRevert(PoolBalancer.ReserveNotFunded.selector); balancer.open();
        _deposit(1);
        vm.prank(creator); balancer.open();
        assertEq(balancer.admissionStatus(), 2, "initial setup remains closed to purchases");
        uint256 paid;
        uint256 gas;
        for (uint256 i; i < 4; ++i) {
            (uint256 reward, uint256 billed) = _paid();
            paid += reward;
            gas += billed;
        }
        assertEq(balancer.getActiveShapes()[0],20);
        assertEq(balancer.admissionStatus(),0);
        assertEq(balancer.requiredReserve(),0.00368 ether);
        assertEq(address(balancer).balance,need - 0.22 ether - paid);
        assertGt(paid,0.005 ether,"real setup payment, not an unpaid bootstrap");
        assertLt(paid,0.01192 ether,"actual setup stays within its enforced budget");
        emit log_named_decimal_uint("exact twenty opening",need,18);
        emit log_named_decimal_uint("actual twenty setup reward",paid,18);
        emit log_named_uint("actual setup billed gas",gas);
        emit log_named_decimal_uint("stocked reserve",balancer.requiredReserve(),18);
        emit log_named_decimal_uint("post setup withdrawable",balancer.withdrawableSurplus(),18);
    }

    function _minimumPaidBootstrap(uint256 t, uint256 cost) internal {
        configure(t);
        listCurated(1,0.2 ether);
        uint256 need = _quoteOpen();
        _deposit(need);
        vm.prank(creator); balancer.open();
        uint256 paid;
        uint256 gas;
        uint256 maximumGas;
        uint256 calls;
        while(balancer.creatorWork()) {
            (uint256 reward,uint256 billed)=_paid();
            paid+=reward; gas+=billed; ++calls;
            if(billed>maximumGas)maximumGas=billed;
            require(calls<=400,"initial setup did not finish within shape-unit batch count");
        }
        uint16[16] memory have=balancer.getActiveShapes();
        for(uint256 d;d<16;++d)assertEq(have[d],(t>>(16*d))&0xFFFF,"minimum funding restores every denomination");
        assertEq(address(balancer).balance,need-cost-paid);
        assertGe(address(balancer).balance,balancer.requiredReserve(),"initial budget leaves its working buffer");
        assertLt(maximumGas,16_777_216,"each reached upkeep is executable below EIP7825");
        emit log_named_decimal_uint("exact minimum opening",need,18);
        emit log_named_decimal_uint("actual setup reward",paid,18);
        emit log_named_uint("actual setup billed gas",gas);
        emit log_named_uint("largest reached upkeep billed gas",maximumGas);
        emit log_named_uint("paid setup calls",calls);
        emit log_named_decimal_uint("stocked reserve",balancer.requiredReserve(),18);
    }

    function test_exactMinimumMixed47PaidBootstrap() public {
        _minimumPaidBootstrap(plan16([uint256(24),12,2,1,0,0,0,0,0,8,0,0,0,0,0,0]),1.755 ether);
    }

    function test_exactMinimumThousandExpensivePackPaidBootstrap() public {
        _minimumPaidBootstrap(plan16([uint256(900),0,0,0,0,0,0,0,0,80,0,0,0,0,19,1]),84.22 ether);
    }

    function test_expensiveTopPrizeDoesNotNeedDuplicateBacking() public {
        configure(plan([uint256(19),0,0,0,0,0,0,0,1]));
        listCurated(1,0.2 ether);
        uint256 need = _quoteOpen();
        assertLt(need,100.25 ether,"no second100ETH backing obligation");
        assertGt(need,100.21 ether,"actual initial inventory and working capital funded");
        _deposit(need);
        vm.prank(creator); balancer.open();
        fillUp();
        assertEq(balancer.getActiveShapes()[8],1);
        assertEq(balancer.requiredReserve(),0.00368 ether);
        emit log_named_decimal_uint("top prize opening",need,18);
    }

    function test_nineOutstandingDrawsAreReservedFromActualSequences() public {
        configure(plan([uint256(20),0,0,0,0,0,0,0,0]));
        listCurated(1,0.2 ether);
        _deposit(_quoteOpen());
        vm.prank(creator); balancer.open();
        fillUp();
        uint256 free = balancer.withdrawableSurplus();
        vm.prank(creator); balancer.claimSurplus(free,creator);
        uint256[] memory first = buy(buyer,5);
        // Deliver non-head words first: the real service releases VRF coverage while FWA waits for its queue head.
        // Slot 2 is a Shape: word 0 would win the only curated NFT, and admission must then refuse (status 7).
        for (uint256 i=1;i<5;++i) fulfill(first[i],wordForSlot(2));
        fulfill(first[0],wordForSlot(2));
        assertEq(pool.unsettledAcquisitionCount(),4);
        uint256 price = pool.acquisitionFee();
        buy(buyer,5);
        assertEq(pool.unsettledAcquisitionCount(),9,"one pre-batch gate check admits five after four unsettled");
        assertEq(pool.lastIssuedSequence()-balancer.reconciledSequence(),10,"one finalized draw also awaits reconciliation");
        assertEq(balancer.requiredReserve(),0.01768 ether,"ten actual owed bounds plus one call buffer");
        assertEq(balancer.withdrawableSurplus(),0);
        vm.roll(vm.getBlockNumber() + ITimeout(address(pool)).selectionTimeoutBlocks() + 1);
        while (balancer.reconciledSequence()<pool.lastIssuedSequence()) _paid();
        assertEq(balancer.reconciledSequence(),10);
        assertEq(pool.unsettledAcquisitionCount(),0);
        assertEq(IRefunds(address(pool)).acquisitionRefundCredit(buyer),5*price);
        uint256 before = buyer.balance;
        vm.prank(buyer); IRefunds(address(pool)).withdrawAcquisitionRefund();
        assertEq(buyer.balance-before,5*price,"new five requests expire and refund through real FWA");
        assertEq(IRefunds(address(pool)).acquisitionRefundCredit(buyer),0);
    }

    function test_refundReconciliationMaySpendBelowWorkingTarget() public {
        configure(plan([uint256(20),0,0,0,0,0,0,0,0]));
        listCurated(1,0.2 ether);
        _deposit(_quoteOpen());
        vm.prank(creator); balancer.open(); fillUp();
        uint256 free=balancer.withdrawableSurplus();
        vm.prank(creator); balancer.claimSurplus(free,creator);
        buy(buyer,5);
        assertLt(address(balancer).balance,balancer.requiredReserve());
        vm.roll(vm.getBlockNumber()+ITimeout(address(pool)).selectionTimeoutBlocks()+1);
        while(balancer.reconciledSequence()<pool.lastIssuedSequence()) _paid();
        assertEq(balancer.reconciledSequence(),5);
        assertEq(pool.ownerProceeds(),0,"expired draws create no operating proceeds");
        assertLt(address(balancer).balance,balancer.requiredReserve(),"paid progress can consume its buffer");
    }

    function test_partialExpensiveDeficitCanTradeAndMarkupEditDoesNotRestartSetup() public {
        configure(plan([uint256(19),0,0,0,0,0,0,0,1]));
        listCurated(1,0.2 ether);
        _deposit(_quoteOpen());
        vm.prank(creator); balancer.open();
        fillUp();
        uint256 free = balancer.withdrawableSurplus();
        vm.prank(creator); balancer.claimSurplus(free,creator);
        uint256 top = lastListingId();
        (,,,uint256 token,,,uint256 slot,) = pool.listings(top);
        uint256[] memory request = buy(buyer,1);
        fulfill(request[0],wordForSlot(slot));
        settle();
        assertEq(shapes.ownerOf(token),buyer,"the100ETH backed prize was delivered without liquid spare");
        _paid();
        assertEq(balancer.getActiveShapes()[8],0,"no cash for immediate100ETH replacement");
        assertEq(balancer.admissionStatus(),0,"small Shapes preserve more than70% of inverse backing weight");
        assertGt(balancer.requiredReserve(),100 ether);
        assertEq(balancer.withdrawableSurplus(),balancer.creatorCredit(),"missing inventory reserves subsequent operating income");
        uint256 target=balancer.target();
        vm.startPrank(creator); balancer.configure(1600,target, shapes.mintFee()); vm.stopPrank();
        assertFalse(balancer.creatorWork(),"ordinary markup change does not restart initial setup");
        assertEq(balancer.admissionStatus(),0);
        buy(buyer,1);
    }

    function test_unpaidBootstrapNeedsOnlyActualInventoryAndDelayedReenableFunding() public {
        configure(plan([uint256(20),0,0,0,0,0,0,0,0]));
        listCurated(1,0.2 ether);
        vm.prank(creator); balancer.setPaidUpkeepEnabled(false);
        _deposit(0.22 ether);
        vm.prank(creator); balancer.open();
        for(uint256 i;i<4;++i) {
            vm.prank(stranger); balancer.performUpkeepUnpaid();
        }
        assertEq(balancer.getActiveShapes()[0],20);
        assertEq(address(balancer).balance,0,"unpaid caller fronts its own gas; inventory is the only pool expense");
        assertEq(balancer.requiredReserve(),0,"disabled compensation does not lock hypothetical paid work");
        (uint256 required,uint256 shortfall)=balancer.policyFunding(balancer.keeperPolicy());
        assertEq(required,0.00368 ether);
        assertEq(shortfall,required);
        vm.prank(creator); vm.expectRevert(PoolBalancer.ReserveNotFunded.selector); balancer.setPaidUpkeepEnabled(true);
        _deposit(shortfall);
        vm.prank(creator); balancer.setPaidUpkeepEnabled(true);
        assertTrue(balancer.paidUpkeepEnabled());
        assertEq(balancer.requiredReserve(),0.00368 ether);
        vm.prank(creator); balancer.setPaidUpkeepEnabled(false);
        uint256 withdrawable=balancer.withdrawableSurplus();
        assertEq(withdrawable,0.00368 ether,"emergency disable releases the no-longer-necessary payment buffer");
        vm.prank(creator); balancer.claimSurplus(withdrawable,creator);
        assertEq(address(balancer).balance,0);
    }

    function test_collectedRevenueIsCreditedBeforeTheExpensiveDeficitIsReconciled() public {
        configure(plan([uint256(19),0,0,0,0,0,0,0,1]));
        listCurated(1,0.2 ether);
        _deposit(_quoteOpen());
        vm.prank(creator); balancer.open(); fillUp();
        uint256 free=balancer.withdrawableSurplus();
        vm.prank(creator); balancer.claimSurplus(free,creator);
        (,,,,,,uint256 slot,)=pool.listings(lastListingId());
        uint256[] memory request=buy(buyer,1);
        fulfill(request[0],wordForSlot(slot)); settle();
        uint256 proceeds=pool.ownerProceeds();
        uint256 expected=proceeds*balancer.creatorRevenueBps()/10_000;
        assertGt(expected,0,"actual owner proceeds receive the stored allocation");
        balancer.collectProceeds();
        assertEq(balancer.creatorCredit(),expected,"creator allocation is preserved before the missing100ETH prize is reconciled");
        uint256 fund=address(balancer).balance-balancer.creatorCredit();
        vm.prank(creator); balancer.claimSurplus(expected,creator);
        assertEq(address(balancer).balance,fund,"claiming existing credit leaves operating funds unchanged");
        _paid();
        assertEq(balancer.getActiveShapes()[8],0);
        assertEq(balancer.creatorCredit(),0);
        assertEq(balancer.withdrawableSurplus(),0,"actual large deficit retains all remaining operating capital");
    }

    function test_feeAndCapSensitiveBoundForActualWork() public {
        assertEq(KeeperPolicyCalls.paymentBound(0.311 ether,0.5 gwei,1,1,0,0),0.0014 ether);
        assertEq(KeeperPolicyCalls.paymentBound(0.311 ether,0.5 gwei,0,0,1,1),0.00074 ether);
        assertEq(KeeperPolicyCalls.paymentBound(0.0001 ether,0.5 gwei,0,0,1,1),0.0001 ether);
        assertEq(KeeperPolicyCalls.paymentBound(0.311 ether,0.5 gwei,0,5,5,5),0.00368 ether);
    }

    function test_writeImmutableEnforcementFixture() public {
        string memory key = "keeperEnforcement";
        vm.serializeString(key,"hardMaxReward",vm.toString(KeeperPolicyCalls.HARD_MAX_REWARD));
        vm.serializeString(key,"burst",vm.toString(KeeperPolicyCalls.BURST));
        vm.serializeString(key,"refillPerSecond",vm.toString(KeeperPolicyCalls.REFILL_PER_SECOND));
        vm.serializeString(key,"maxGas",vm.toString(KeeperPolicyCalls.MAX_GAS));
        vm.serializeString(key,"overheadGas",vm.toString(KeeperPolicyCalls.OVERHEAD_GAS));
        vm.serializeString(key,"baseGas",vm.toString(KeeperPolicyCalls.BASE_GAS));
        vm.serializeString(key,"processGas",vm.toString(KeeperPolicyCalls.PROCESS_GAS));
        vm.serializeString(key,"reconcileGas",vm.toString(KeeperPolicyCalls.RECONCILE_GAS));
        vm.serializeString(key,"shapeGas",vm.toString(KeeperPolicyCalls.SHAPE_GAS));
        vm.serializeString(key,"prizeGas",vm.toString(KeeperPolicyCalls.PRIZE_GAS));
        vm.serializeString(key,"priorityAllowance",vm.toString(KeeperPolicyCalls.PRIORITY_ALLOWANCE));
        vm.serializeString(key,"gasPriceCeiling",vm.toString(KeeperPolicyCalls.GAS_PRICE_CEILING));
        vm.serializeString(key,"workFee",vm.toString(KeeperPolicyCalls.WORK_FEE));
        vm.serializeString(key,"maxUnits","5");
        vm.serializeString(key,"maxSizes","4");
        vm.serializeString(key,"maxReconciles","5");
        vm.serializeString(key,"maxProcessed","2");
        string memory json = vm.serializeString(key,"byValue",vm.toString(KeeperPolicyCalls.BY_VALUE));
        vm.writeJson(json,"./test/fixtures/keeper-enforcement.json");
    }
}
