// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, ITimeout} from "./utils/ForkBase.sol";
import {IFWAPool} from "../src/interfaces/External.sol";

contract CuratedAdmissionBuyer {
    function purchase(IFWAPool pool, uint256 value) external returns (uint256 requestId) {
        require(block.basefee == 0.5 gwei && tx.gasprice == 0.55 gwei, "fee context changed");
        uint256[] memory requests = pool.acquireBatch{value: value}(
            address(this), 1, 0, 0, 10_000, pool.inventoryVersion(), block.timestamp + 1
        );
        return requests[0];
    }
    receive() external payable {}
}

contract CuratedAdmissionTest is ForkBase {
    /// @dev E1 regression: real FWA expiry and FIFO staging, with no randomness callback override.
    function test_stagedCuratedBehindTwelveShapesCannotAuthorizePurchase() public {
        setUpFork();
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        createBalancer(2 ether);
        configure(plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        uint256 originalCurated = listCurated(1, 0.3 ether);
        vm.prank(creator); balancer.open();
        fillUp();
        assertEq(balancer.admissionStatus(), 0);
        CuratedAdmissionBuyer actor = new CuratedAdmissionBuyer();
        vm.deal(address(actor), 1 ether); // External purchaser funding, never protocol balance setup.
        (,, uint256 firstPayment) = pool.quoteAcquisitionPrice(1);
        actor.purchase(pool, firstPayment);
        assertEq(pool.unsettledAcquisitionCount(), 1);

        configure(plan([uint256(32), 0, 0, 0, 0, 0, 0, 0, 0]));
        upkeep(); upkeep(); upkeep();
        uint256 stagedCurated = listCurated(2, 0.3 ether);
        (,,,,,, uint256 slot, uint8 status) = pool.listings(stagedCurated);
        assertEq(slot, 0);
        assertEq(status, 5);
        vm.roll(block.number + ITimeout(address(pool)).selectionTimeoutBlocks() + 1);
        upkeep();
        assertEq(pool.unsettledAcquisitionCount(), 0);
        vm.prank(creator); balancer.withdrawCurated(originalCurated, creator);
        assertEq(pool.activeListingCount(), 20);
        assertEq(balancer.listedShapePrizes(), 32);
        assertEq(balancer.getActiveIds().length, 33);
        assertEq(pool.reservedStagedCount(), 0);
        (,,,,,, slot, status) = pool.listings(stagedCurated);
        assertEq(slot, 0);
        assertEq(status, 5, "sole curated NFT remains behind twelve unreserved Shapes");
        (uint256 fee, uint256 vrf, uint256 payment) = pool.quoteAcquisitionPrice(1);
        assertEq(fee, 0.01385475 ether);
        assertEq(vrf, 0.001287 ether);
        assertEq(payment, 0.01514175 ether);
        uint256 buyerCash = address(actor).balance;
        uint256 poolCash = address(pool).balance;
        uint256 serviceCash = VRF_SERVICE.balance;
        uint64 issued = pool.lastIssuedSequence();
        assertEq(balancer.admissionStatus(), 3, "tracked but unselectable curated inventory must not authorize a draw");
        vm.expectRevert(bytes4(keccak256("PurchaseNotAllowed()")));
        actor.purchase(pool, payment);
        assertEq(address(actor).balance, buyerCash);
        assertEq(address(pool).balance, poolCash);
        assertEq(VRF_SERVICE.balance, serviceCash);
        assertEq(pool.lastIssuedSequence(), issued);
        assertEq(pool.unsettledAcquisitionCount(), 0);

        uint256 fund = address(balancer).balance;
        uint256 keeperCash = keeper.balance;
        vm.prank(stranger); pool.activateListings(13);
        (,,,,,, slot, status) = pool.listings(stagedCurated);
        assertGt(slot, 0);
        assertEq(status, 1);
        assertEq(address(balancer).balance, fund, "public FIFO activation needs no new pool capital");
        assertEq(keeper.balance, keeperCash, "public FIFO activation creates no keeper compensation");
        assertEq(balancer.admissionStatus(), 0);
        (,, payment) = pool.quoteAcquisitionPrice(1);
        actor.purchase(pool, payment);
        assertEq(address(actor).balance, buyerCash - payment);
        assertEq(pool.unsettledAcquisitionCount(), 1, "same buyer resumes without another Balancer synchronization");
    }
}
