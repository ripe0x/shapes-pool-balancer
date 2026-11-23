// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "../../test/utils/ForkBase.sol";
import {PoolBalancer} from "../../src/PoolBalancer.sol";

interface IShapesFeeAdminChallenge {
    function setMintFee(uint256 fee) external;
}

/// @notice Challenge the R80 accepted-fee reserve across a live fee spike, exact withdrawal,
///         fee reversal and real paid restocking. FWA, Shapes, Packs and VRF are forked contracts.
contract ContractChallengeCapRecovery is ForkBase {
    address constant SHAPES_ADMIN = 0xCB43078C32423F5348Cab5885911C3B5faE217F9;

    function test_capSpikeExactWithdrawalThenPaidRecovery() public {
        setUpFork();
        assertEq(block.basefee, 0.5 gwei, "fork call has nonzero base fee");
        assertEq(tx.gasprice, 1 gwei, "fork call has nonzero transaction gas price");

        curatedRequired = false;
        createBalancer(3 ether);
        configure(plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertEq(balancer.admissionStatus(), 0);
        uint256 accepted = shapes.mintFee();
        assertEq(accepted, 0.001 ether);

        // Six real purchases and wins remove 30% of the board while the Shapes fee moves above cap.
        for (uint256 i; i < 6; ++i) _winSmallest();
        vm.prank(SHAPES_ADMIN);
        IShapesFeeAdminChallenge(SHAPES).setMintFee(10 * accepted);
        assertEq(block.basefee, 0.5 gwei, "fee used inside upkeep call");
        assertEq(tx.gasprice, 1 gwei, "gas price used inside upkeep call");
        upkeep();
        upkeep();
        assertEq(balancer.getActiveShapes()[0], 14, "no high-fee mint");
        assertEq(balancer.admissionStatus(), 0, "remaining 70% still sells");

        balancer.collectProceeds();
        uint256 credit = balancer.creatorCredit();
        assertGt(credit, 0, "collected owner proceeds booked creator credit");
        uint256 reserve = balancer.requiredReserve();
        uint256 claim = balancer.withdrawableSurplus();
        assertGt(claim, credit, "operating surplus exists above protected credit");
        emit log_named_uint("accepted-fee reserve wei", reserve);
        emit log_named_uint("protected credit wei", credit);
        emit log_named_uint("full claim wei", claim);
        vm.prank(creator);
        balancer.claimSurplus(claim, creator);
        assertEq(address(balancer).balance, reserve, "creator withdrew to exact accepted-fee reserve");
        assertEq(balancer.creatorCredit(), 0, "full claim includes the first credit");

        // Sell one more listed Shape while minting is blocked. Its newly collected proceeds
        // create a fresh credit that the keeper must leave liquid through reconciliation and restock.
        _winSmallest();
        balancer.collectProceeds();
        uint256 freshCredit = balancer.creatorCredit();
        assertGt(freshCredit, 0, "seventh real sale booked fresh credit");
        emit log_named_uint("fresh protected credit wei", freshCredit);
        upkeep();
        assertEq(balancer.getActiveShapes()[0], 13, "no high-fee mint after seventh win");
        assertEq(balancer.creatorCredit(), freshCredit, "paid reconcile left fresh credit booked");

        // The fee returns to the accepted cap. Paid restocking must complete from the exact reserve.
        vm.prank(SHAPES_ADMIN);
        IShapesFeeAdminChallenge(SHAPES).setMintFee(accepted);
        uint256 paidCalls = fillUp();
        assertGt(paidCalls, 0, "real paid upkeep ran");
        assertEq(balancer.getActiveShapes()[0], 20, "all seven prizes restored");
        assertEq(balancer.admissionStatus(), 0, "sales remain admitted");
        assertEq(balancer.creatorCredit(), freshCredit, "paid work did not consume booked credit");
        assertGe(address(balancer).balance, freshCredit, "credit remains liquid");
        emit log_named_uint("post-restock balance wei", address(balancer).balance);
        uint256 creatorBefore = creator.balance;
        vm.prank(creator);
        balancer.claimSurplus(freshCredit, creator);
        assertEq(creator.balance - creatorBefore, freshCredit, "creator can take every protected wei after paid recovery");
    }

    function _winSmallest() internal {
        assertEq(block.basefee, 0.5 gwei, "purchase sees fork base fee");
        assertEq(tx.gasprice, 1 gwei, "purchase sees fork gas price");
        uint256[] memory lids = balancer.getActiveIds();
        for (uint256 i; i < lids.length; ++i) {
            (uint8 kind, uint8 d,,,) = balancer.items(lids[i]);
            if (kind != 2 || d != 0) continue;
            (,,, uint256 token,,, uint256 slot, uint8 status) = pool.listings(lids[i]);
            if (status != 1) continue;
            uint256[] memory ids = buy(buyer, 1);
            fulfill(ids[0], wordForSlot(slot));
            settle();
            assertEq(shapes.ownerOf(token), buyer, "real FWA delivered the Shape");
            assertEq(shapes.backingOf(token), 0.01 ether, "winner holds exact backing");
            return;
        }
        fail("no active smallest Shape");
    }
}
