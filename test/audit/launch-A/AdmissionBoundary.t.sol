// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "../../utils/ForkBase.sol";

contract LaunchAGasWitness {
    uint256 public basefee;
    uint256 public gasprice;

    function record() external {
        basefee = block.basefee;
        gasprice = tx.gasprice;
    }
}

contract AdmissionBoundaryTest is ForkBase {
    function setUp() public {
        setUpFork();
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        LaunchAGasWitness witness = new LaunchAGasWitness();
        witness.record();
        assertEq(witness.basefee(), 0.5 gwei);
        assertEq(witness.gasprice(), 0.55 gwei);
    }

    function test_threeSmallShapesPauseWhileDrawUnsettledThenReopen() public {
        createBalancer(1 ether);
        uint256[9] memory counts;
        counts[0] = 3;
        configure(plan(counts));
        listCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();

        assertEq(pool.unsettledAcquisitionCount(), 0, "no pending draw");
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence(), "all draws reconciled");
        assertEq(balancer.getActiveShapes()[0], 3, "full target stocked");
        assertEq(balancer.prizeWeight(), balancer.targetWeight(), "no prize missing");
        assertEq(balancer.admissionStatus(), 0, "first purchase admitted at full inventory");
        buy(buyer, 1);
        assertEq(pool.lastIssuedSequence(), 1, "first purchase issued");
        assertEq(balancer.admissionStatus(), 6, "pause while draw unsettled");
        assertFalse(balancer.canPurchase(buyer), "second purchase refused");

        (,, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 version = pool.inventoryVersion();
        vm.prank(buyer, buyer);
        vm.expectRevert();
        pool.acquireBatch{value: total}(buyer, 1, 0, 0, 10_000, version, block.timestamp + 1);
        assertEq(pool.lastIssuedSequence(), 1, "second purchase refused");

        vm.roll(block.number + 40);
        assertEq(pool.processAcquisitions(1), 1, "real FWA expired the pending draw");
        bytes32 uh1 = balancer.settingsHash();
        vm.prank(keeper, keeper);
        balancer.performUpkeep(uh1, 0, 0);
        assertEq(balancer.admissionStatus(), 0, "reconciled draw reopens sales");
    }

    function test_fourSmallShapesAdmitFirstPurchase() public {
        createBalancer(1 ether);
        uint256[9] memory counts;
        counts[0] = 4;
        configure(plan(counts));
        listCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();

        assertEq(balancer.admissionStatus(), 0, "four-shape boundary admits");
        buy(buyer, 1);
        assertEq(pool.lastIssuedSequence(), 1, "real FWA purchase issued");
    }
}
