// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, ITimeout} from "test/utils/ForkBase.sol";
import {PoolBalancer} from "src/PoolBalancer.sol";
import {IFWAPool} from "src/interfaces/External.sol";

interface IShapesAdmin {
    function admin() external view returns (address);
    function setMintFee(uint256) external;
}

contract FeeContext {
    uint256 public observedBaseFee;
    uint256 public observedGasPrice;
    function record() external {
        observedBaseFee = block.basefee;
        observedGasPrice = tx.gasprice;
    }
}

contract FreshReviewMintCap is ForkBase {
    function setUp() public {
        setUpFork();
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        FeeContext probe = new FeeContext();
        probe.record();
        assertEq(probe.observedBaseFee(), 0.5 gwei);
        assertEq(probe.observedGasPrice(), 0.55 gwei);

        uint256 target = plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]);
        uint256 fee = shapes.mintFee();
        PoolBalancer.CuratedInput[] memory empty = new PoolBalancer.CuratedInput[](0);
        vm.prank(creator);
        balancer = PoolBalancer(payable(factory.createBalancer{value: 0.3 ether}(
            bytes32(uint256(88)),
            PoolBalancer.CreationConfig(1500, 1, target, fee, false), empty
        )));
        assertEq(balancer.creator(), creator, "real creator makes the creation call");
        pool = IFWAPool(address(balancer.pool()));
        fillUp();
        assertEq(balancer.getActiveShapes()[0], 20);
        assertEq(balancer.admissionStatus(), 0);
    }

    function test_feeSpikeDoesNotBlockListedPurchasesOrCreateUnfundedMint() public {
        uint256 accepted = balancer.mintFeeCap();
        uint256 beforeReserve = balancer.requiredReserve();
        vm.prank(IShapesAdmin(SHAPES).admin());
        IShapesAdmin(SHAPES).setMintFee(0.01 ether);
        assertGt(shapes.mintFee(), accepted);
        assertEq(balancer.requiredReserve(), beforeReserve, "higher live fee must not lock surplus");
        assertEq(balancer.admissionStatus(), 0, "listed prizes remain saleable");

        uint256[] memory requests = buy(buyer, 1);
        assertEq(requests.length, 1);
        fulfill(requests[0], wordForSlot(1));
        upkeep();
        assertEq(balancer.getActiveShapes()[0], 19, "fulfilled prize leaves a genuine deficit");
        assertEq(balancer.admissionStatus(), 0, "19 of 20 keeps admission open");
        uint256 reserveAtAcceptedFee = balancer.requiredReserve();
        assertLt(reserveAtAcceptedFee, 0.03 ether);
        // The first reconciliation may leave collectible owner proceeds, which is still useful unpaid work.
        bytes32 settings = balancer.settingsHash();
        vm.prank(keeper, keeper);
        try balancer.performUpkeep(settings, 0, 0) {} catch {}
        assertEq(balancer.getActiveShapes()[0], 19, "fee cap blocks minting");

        uint256 target = balancer.target();
        vm.prank(creator);
        balancer.configure(1500, target);
        assertEq(balancer.mintFeeCap(), 0.01 ether);
        assertEq(balancer.requiredReserve(), reserveAtAcceptedFee + 0.009 ether,
            "one missing Shape adds exactly the fee difference to the reserve");
    }

    function test_pendingDrawBudgetSurvivesStagedRestock() public {
        vm.fee(4.9 gwei);
        vm.txGasPrice(5 gwei);
        FeeContext probe = new FeeContext();
        probe.record();
        assertEq(probe.observedBaseFee(), 4.9 gwei);
        assertEq(probe.observedGasPrice(), 5 gwei);
        uint256 surplus = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(surplus, creator);
        uint256[] memory first = buy(buyer, 5);
        fulfill(first[0], wordForSlot(1));
        assertEq(pool.unsettledAcquisitionCount(), 4, "one real VRF win and four waiting draws");
        upkeep();
        assertEq(balancer.getActiveShapes()[0], 20, "the missing Shape was restocked while draws wait");
        uint256 operating = address(balancer).balance - balancer.creatorCredit();
        uint256 reserve = balancer.requiredReserve();
        assertLt(operating, reserve, "restock spent some of the withdrawal reserve");
        emit log_named_decimal_uint("operating after staged restock", operating, 18);
        emit log_named_decimal_uint("reserve after staged restock", reserve, 18);
        vm.roll(block.number + ITimeout(address(pool)).selectionTimeoutBlocks() + 1);
        while (balancer.reconciledSequence() < pool.lastIssuedSequence()) upkeep();
        assertEq(balancer.reconciledSequence(), 5, "all four expired draws get paid maintenance");
    }

    function test_paidKeeperCompletesFiveExpiredDrawsAtGasCap() public {
        vm.fee(4.9 gwei);
        vm.txGasPrice(5 gwei);
        uint256 surplus = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(surplus, creator);
        buy(buyer, 5);
        assertEq(pool.unsettledAcquisitionCount(), 5);
        vm.roll(block.number + ITimeout(address(pool)).selectionTimeoutBlocks() + 1);
        bool blocked;
        for (uint256 i; i < 5 && balancer.reconciledSequence() < 5; ++i) {
            bytes32 settings = balancer.settingsHash();
            vm.prank(keeper, keeper);
            try balancer.performUpkeep(settings, 0, 0) {} catch { blocked = true; break; }
        }
        assertFalse(blocked, "paid path stays funded for five refunds without owner proceeds");
        assertEq(balancer.reconciledSequence(), 5, "all expired draws reconcile through paid upkeep");
        emit log_named_decimal_uint("operating after five paid refunds", address(balancer).balance - balancer.creatorCredit(), 18);
    }
}
