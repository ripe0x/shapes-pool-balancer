// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ForkBase, ITimeout} from "./utils/ForkBase.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";

contract SelectableInventoryTest is ForkBase {

    function _launch() internal {
        setUpFork();
        GasProbe probe = new GasProbe(); probe.record();
        assertEq(probe.baseFee(), 0.5 gwei);
        assertEq(probe.gasPrice(), 1 gwei);
        createBalancer(3 ether);
        configure(plan([uint256(20),0,0,0,0,0,0,0,0]));
        listCurated(1, 0.2 ether);
        vm.prank(creator); balancer.open(); fillUp();
        assertEq(balancer.admissionStatus(), 0);
        assertLe(factory.implementation().code.length, 24_576);
    }

    function test_stagedBoardCannotPassAndPublicActivationRestoresAdmission() public {
        _launch();
        buy(buyer, 1);
        vm.startPrank(creator); balancer.configure(1500, plan([uint256(100),0,0,0,0,0,0,0,0]), shapes.mintFee()); vm.stopPrank();
        for (uint256 i; i < 16; ++i) { vm.roll(vm.getBlockNumber() + 1); upkeep(); }
        assertEq(balancer.listedShapePrizes(), 100);
        assertEq(pool.activeListingCount(), 21, "80 backed Shapes remain nonselectable staging");
        assertEq(balancer.admissionStatus(), 6, "staging cannot satisfy selectable inventory");
        (,,uint256 quote) = pool.quoteAcquisitionPrice(1);
        uint256 version = pool.inventoryVersion();
        vm.prank(buyer, buyer);
        vm.expectRevert(bytes4(keccak256("PurchaseNotAllowed()")));
        pool.acquireBatch{value: quote}(buyer, 1, 0, 0, 10_000, version, block.timestamp + 1);
        vm.roll(vm.getBlockNumber() + ITimeout(address(pool)).selectionTimeoutBlocks() + 1);
        vm.prank(stranger, stranger); balancer.performUpkeepUnpaid();
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(balancer.reconciledSequence(), 1);
        vm.prank(creator); balancer.setPaidUpkeepEnabled(false);
        uint256 beforeKeeper = keeper.balance;
        uint256 beforeETH = address(balancer).balance;
        for (uint256 i; i < 4; ++i) {
            vm.prank(stranger, stranger); pool.activateListings(20);
            if (i == 2) assertEq(balancer.admissionStatus(), 0, "80% selectable inventory suffices before the final activation batch");
        }
        assertEq(keeper.balance, beforeKeeper, "activation creates no keeper reward");
        assertEq(address(balancer).balance, beforeETH, "activation spends no pool ETH");
        assertEq(pool.activeListingCount(), 101);
        assertEq(balancer.admissionStatus(), 0, "actual selectable board reopens without new capital");
        assertEq(_backing(), 1 ether, "100 real Shapes retain their full backing");
    }

    function test_fiveShapeWinsWithoutUpkeepStillAdmitTheNextBatch() public {
        _launch();
        uint256[] memory first = buy(buyer, 5);
        for (uint256 i; i < first.length; ++i) {
            fulfill(first[i], wordForSlot(_shapeSlot()));
            (,,,uint256 lid,uint8 status,) = pool.acquisitions(first[i]);
            assertEq(status, 2, "each first-batch Shape was actually delivered");
            (uint8 kind,,,,) = balancer.items(lid);
            assertEq(kind, 2);
        }
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(balancer.reconciledSequence(), 0, "no keeper intervened between batches");
        assertEq(pool.activeListingCount(), 16, "15 selectable Shapes and the original curated NFT remain");
        assertEq(balancer.admissionStatus(), 0, "the original75% lower bound still admits concurrent production behavior");
        uint256[] memory second = buy(stranger, 5); // Actual FWA purchase hook has its fixed100k stipend.
        assertEq(second.length, 5);
        assertEq(pool.lastIssuedSequence(), 10);
        assertEq(pool.unsettledAcquisitionCount(), 5);
        assertEq(balancer.admissionStatus(), 4, "the existing outstanding-request cap remains");
    }

    function test_oneShapeWinDoesNotCreateFalseCuratedAbsence() public {
        _launch();
        uint256[] memory first = buy(buyer, 1);
        fulfill(first[0], wordForSlot(_shapeSlot()));
        assertEq(pool.activeListingCount(), 20, "19 Shapes plus the curated NFT remain selectable");
        assertEq(balancer.listedShapePrizes(), 20, "the win has not been reconciled");
        assertEq(balancer.admissionStatus(), 0);
        uint256[] memory second = buy(stranger, 2);
        assertEq(second.length, 2, "another buyer can purchase before any keeper acts");
        assertEq(balancer.reconciledSequence(), 0);
    }

    function test_reservedActivationNeedsNoAdditionalBalancerSync() public {
        _launch();
        uint256[] memory first = buy(buyer, 5);
        for (uint256 i; i < 4; ++i) {
            fulfill(first[i], wordForSlot(_shapeSlot()));
            upkeep();
        }
        assertEq(balancer.reconciledSequence(), 4);
        assertEq(pool.activeListingCount(), 17, "four replacements remain staged");
        assertEq(balancer.admissionStatus(), 0, "guaranteed FWA activation avoids an unnecessary maintenance barrier");
        buy(stranger, 4);
        assertEq(pool.lastIssuedSequence(), 9);
        vm.roll(vm.getBlockNumber() + ITimeout(address(pool)).selectionTimeoutBlocks() + 1);
        vm.prank(stranger, stranger); pool.processAcquisitions(5);
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(pool.activeListingCount(), 21, "FWA itself activated the reserved prefix");
        assertEq(balancer.reconciledSequence(), 4, "no additional Balancer call occurred");
        assertEq(balancer.admissionStatus(), 0, "the original75% bound needs no cache-sync transaction");
        // The actual late callback clears one service reservation without changing the finalized expired draw.
        fulfill(first[4], 0);
        assertEq(buy(buyer, 1).length, 1, "a real purchase succeeds without another keeper call");
    }

    function test_earlierReservedBatchesCountBeforeTheNextSelection() public {
        _launch();
        uint256[] memory first = buy(buyer, 3);
        vm.startPrank(creator); balancer.configure(1500, plan([uint256(32),0,0,0,0,0,0,0,0]), shapes.mintFee()); vm.stopPrank();
        upkeep(); upkeep(); upkeep();
        assertEq(pool.activeListingCount(), 21);
        assertEq(pool.reservedStagedCount(), 0);
        assertEq(balancer.admissionStatus(), 0, "six guaranteed activations satisfy the first new selection bound");
        uint256 fourth = buy(buyer, 1)[0];
        assertEq(pool.reservedStagedCount(), 6, "the prior request committed its actual staged prefix");
        assertEq(pool.unsettledAcquisitionCount(), 4);
        assertEq(balancer.admissionStatus(), 0, "prior reserved activation must not become an extra purchase barrier");
        uint256 fifth = buy(stranger, 1)[0];
        assertEq(pool.reservedStagedCount(), 12);
        vm.roll(vm.getBlockNumber() + ITimeout(address(pool)).selectionTimeoutBlocks() + 1);
        for (uint256 i; i < 3; ++i) {
            vm.prank(stranger, stranger); balancer.performUpkeepUnpaid();
        }
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(pool.reservedStagedCount(), 0);
        assertEq(pool.activeListingCount(), 33, "expiry activates every committed Shape without removing backing");
        assertEq(_backing(), 0.32 ether);
        assertEq(balancer.admissionStatus(), 0);
        // Authentic late callbacks release the real service's reservations; expired FWA draws stay final.
        for (uint256 i; i < first.length; ++i) fulfill(first[i], 0);
        fulfill(fourth, 0); fulfill(fifth, 0);
        buy(buyer, 1);
        for (uint256 i; i < 24; ++i) listCurated(i + 2, 0.2 ether);
        assertEq(balancer.admissionStatus(), 0, "prior Shape-stage uncertainty clears before curated-only staging");
        assertEq(buy(stranger, 4).length, 4, "no bookkeeping call is needed after the prior activation round trip");
    }

    function test_curatedOnlyStagingDoesNotReduceShapeAdmission() public {
        _launch();
        buy(buyer, 1);
        for (uint256 i; i < 24; ++i) listCurated(i + 2, 0.2 ether);
        assertEq(pool.activeListingCount(), 21);
        assertEq(balancer.admissionStatus(), 0, "staged curated NFTs cannot manufacture a missing-Shape deficit");
        for (uint256 i; i < 4; ++i) assertEq(buy(stranger, 1).length, 1);
        assertEq(pool.reservedStagedCount(), 24);
        assertEq(pool.unsettledAcquisitionCount(), 5);
        vm.roll(vm.getBlockNumber() + ITimeout(address(pool)).selectionTimeoutBlocks() + 1);
        for (uint256 i; i < 3; ++i) {
            vm.prank(stranger, stranger); balancer.performUpkeepUnpaid();
        }
        assertEq(pool.activeListingCount(), 45);
        assertEq(pool.reservedStagedCount(), 0);
        assertEq(_backing(), 0.2 ether);
        for (uint256 i; i < 25; ++i) assertEq(nft.ownerOf(i + 1), address(pool));
    }

    function test_stagedWithdrawalHoleIsClearedExactlyOnce() public {
        _launch();
        buy(buyer, 1);
        vm.startPrank(creator); balancer.configure(1500, plan([uint256(30),0,0,0,0,0,0,0,0]), shapes.mintFee()); vm.stopPrank();
        upkeep(); upkeep();
        uint256[] memory ids = balancer.getActiveIds();
        uint256[] memory one = new uint256[](1);
        for (uint256 i; i < ids.length; ++i) {
            (,,,,,,,uint8 status) = pool.listings(ids[i]);
            if (status == 5) { one[0] = ids[i]; break; }
        }
        assertGt(one[0], 0);
        uint256 before = address(balancer).balance;
        vm.prank(creator); balancer.unlistShapes(one);
        assertEq(address(balancer).balance - before, 0.01 ether, "the withdrawn staged Shape redeems its actual backing");
        assertEq(pool.activeListingCount(), 21, "withdrawal removed staging, not selectable inventory");
        vm.roll(vm.getBlockNumber() + ITimeout(address(pool)).selectionTimeoutBlocks() + 1);
        vm.prank(stranger, stranger); balancer.performUpkeepUnpaid();
        vm.prank(stranger, stranger); pool.activateListings(20);
        fillUp();
        assertEq(_backing(), 0.3 ether);
        assertEq(balancer.admissionStatus(), 0);
    }

    function _shapeSlot() internal view returns (uint256 slot) {
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = balancer.items(ids[i]);
            (,,,,,,uint256 candidate,uint8 status) = pool.listings(ids[i]);
            if (kind == 2 && status == 1) return candidate;
        }
        revert("no actual selectable Shape");
    }

    function _backing() internal view returns (uint256 total) {
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = balancer.items(ids[i]);
            if (kind != 2) continue;
            (,,,uint256 token,,,,uint8 status) = pool.listings(ids[i]);
            assertEq(status, 1);
            assertEq(shapes.ownerOf(token), address(pool));
            total += shapes.backingOf(token);
        }
    }
}
