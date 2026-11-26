// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, ITimeout} from "./utils/ForkBase.sol";
import {IFWAPool} from "../src/interfaces/External.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {PoolInventory} from "../src/PoolInventory.sol";

interface ICuratedVrfCoverage {
    function requiredSubscriptionBalance() external view returns (uint256);
    function subscriptionNativeBalance() external view returns (uint256);
    function maxFulfillmentCostWei() external view returns (uint256);
}

contract CuratedAdmissionBuyer {
    function purchase(IFWAPool pool, uint256 value) external returns (uint256 requestId) {
        require(block.basefee == 0.5 gwei && tx.gasprice == 0.55 gwei, "fee context changed");
        uint256[] memory requests = pool.acquireBatch{value: value}(
            address(this), 1, 0, 0, 10_000, pool.inventoryVersion(), block.timestamp + 1
        );
        return requests[0];
    }
    function purchaseBatch(IFWAPool pool, uint256 count) external returns (uint256[] memory) {
        require(block.basefee == 0.5 gwei && tx.gasprice == 0.55 gwei, "fee context changed");
        (,, uint256 payment) = pool.quoteAcquisitionPrice(count);
        return pool.acquireBatch{value: payment}(
            address(this), count, 0, 0, 10_000, pool.inventoryVersion(), block.timestamp + 1
        );
    }
    receive() external payable {}
}

contract CuratedAdmissionTest is ForkBase {
    /// @dev A real service treasury contribution isolates admission from the fork's finite VRF liquidity.
    ///      Expiry does not release Chainlink liabilities. No protocol balance or request state is faked.
    function _fundVrfCoverage(uint256 additional) internal {
        ICuratedVrfCoverage service = ICuratedVrfCoverage(VRF_SERVICE);
        uint256 required = service.requiredSubscriptionBalance() + additional * service.maxFulfillmentCostWei();
        uint256 subscription = service.subscriptionNativeBalance();
        uint256 treasury = VRF_SERVICE.balance;
        uint256 available = subscription + treasury;
        uint256 contribution = required > available ? required - available : 0;
        emit log_named_decimal_uint("VRF required after additional requests", required, 18);
        emit log_named_decimal_uint("VRF actual subscription before contribution", subscription, 18);
        emit log_named_decimal_uint("VRF actual treasury before contribution", treasury, 18);
        emit log_named_decimal_uint("external synthetic sponsor VRF contribution", contribution, 18);
        assertLe(contribution, 3 ether, "bounded external test sponsorship");
        if (contribution != 0) {
            address sponsor = makeAddr("curated-admission-vrf-sponsor");
            vm.deal(sponsor, contribution); // Only an external actor is funded.
            vm.prank(sponsor);
            (bool ok,) = VRF_SERVICE.call{value: contribution}("");
            assertTrue(ok);
            assertEq(sponsor.balance, 0);
            assertEq(VRF_SERVICE.balance, treasury + contribution);
        }
    }

    function _batch(uint256 count) internal returns (uint256[] memory) {
        CuratedAdmissionBuyer actor = new CuratedAdmissionBuyer();
        vm.deal(address(actor), 1 ether);
        return actor.purchaseBatch(pool, count);
    }
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
        assertEq(balancer.admissionStatus(), 0, "sales open: the 50-block processing grace applies");
        vm.roll(vm.getBlockNumber() + 50); // past FWA's word deadline and the 50-block processing grace (sales open)
        pool.processAcquisitions(1); // Expired Selecting requests are processed publicly on FWA, not by paid upkeep.
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
        assertEq(fee, 0.013860525 ether); // 20 Shapes at 0.0132005 (910k restocking gas) plus the 5% edge
        assertEq(vrf, 0.001287 ether);
        assertEq(payment, 0.015147525 ether);
        uint256 buyerCash = address(actor).balance;
        uint256 poolCash = address(pool).balance;
        uint256 serviceCash = VRF_SERVICE.balance;
        uint64 issued = pool.lastIssuedSequence();
        assertEq(balancer.admissionStatus(), 7, "tracked but unselectable curated inventory needs a fresh proof");
        vm.prank(stranger); vm.expectRevert(bytes4(keccak256("InvalidItem()")));
        balancer.refreshCuratedWitness(stagedCurated);
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
        vm.prank(stranger); assertTrue(balancer.refreshCuratedWitness(stagedCurated));
        assertEq(balancer.admissionStatus(), 0);
        (,, payment) = pool.quoteAcquisitionPrice(1);
        actor.purchase(pool, payment);
        assertEq(address(actor).balance, buyerCash - payment);
        assertEq(pool.unsettledAcquisitionCount(), 1, "same buyer resumes without another Balancer synchronization");
    }

    function _launch(uint256 count, uint256 curated) internal returns (uint256[] memory lids) {
        setUpFork();
        vm.fee(0.5 gwei); vm.txGasPrice(0.55 gwei);
        createBalancer(count * 0.011 ether + 1 ether);
        configure(plan([count, 0, 0, 0, 0, 0, 0, 0, 0]));
        lids = new uint256[](curated);
        for (uint256 i; i < curated; ++i) lids[i] = listCurated(i + 1, 0.3 ether);
        vm.prank(creator); balancer.open();
        fillUp();
        assertEq(balancer.getActiveShapes()[0], count);
        assertEq(balancer.admissionStatus(), 0);
    }

    function _slot(uint256 lid) internal view returns (uint256 slot) {
        (,,,,,, slot,) = pool.listings(lid);
    }

    function test_lostWitnessPausesUntilOnePermissionlessRefreshAndCannotBeChurned() public {
        uint256[] memory curated = _launch(20, 2);
        vm.prank(stranger); assertFalse(balancer.refreshCuratedWitness(curated[1]), "a valid witness cannot be replaced");
        buy(buyer, 1);
        configure(plan([uint256(32), 0, 0, 0, 0, 0, 0, 0, 0]));
        upkeep(); upkeep(); upkeep();
        vm.roll(block.number + ITimeout(address(pool)).selectionTimeoutBlocks() + 1);
        pool.processAcquisitions(1);
        vm.prank(creator); balancer.withdrawCurated(curated[0], creator);
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(balancer.reconciledSequence(), 0);
        assertEq(pool.activeListingCount(), 21);
        assertEq(balancer.listedShapePrizes(), 32);
        assertGt(_slot(curated[1]), 0);
        assertEq(balancer.admissionStatus(), 7, "old proof was preserved and then genuinely lost");
        uint256 balance = address(balancer).balance;
        uint256 credit = balancer.creatorCredit();
        uint256 allowance = balancer.keeperAllowance();
        bytes32 policy = balancer.settingsHash();
        _coolAdmission();
        vm.prank(stranger);
        uint256 gasStart = gasleft();
        bool changed = balancer.refreshCuratedWitness(curated[1]);
        uint256 refreshGas = gasStart - gasleft();
        assertTrue(changed);
        emit log_named_uint("cold permissionless curated refresh gas", refreshGas);
        assertLt(refreshGas, 150_000);
        assertEq(address(balancer).balance, balance);
        assertEq(balancer.creatorCredit(), credit);
        assertEq(balancer.keeperAllowance(), allowance);
        assertEq(balancer.settingsHash(), policy);
        assertEq(balancer.reconciledSequence(), 0, "proof refresh does not manufacture maintenance work");
        assertEq(balancer.admissionStatus(), 0);
        _fundVrfCoverage(5);
        assertEq(_batch(5).length, 5, "one refresh restores a concurrent batch without keeper synchronization");
        assertEq(pool.unsettledAcquisitionCount(), 5);
        assertEq(balancer.admissionStatus(), 4);
    }

    /// @dev Real withdrawal uses FWA's same slot-removal routine as selection. Successful-win invalidation is
    ///      source-reviewed; this test does not impersonate the oracle or claim to execute a successful draw.
    function test_withdrawnCuratedAndReusedSlotCannotAuthorizeStagedCurated() public {
        uint256[] memory curated = _launch(20, 1);
        uint256 oldSlot = _slot(curated[0]);
        buy(buyer, 1);
        configure(plan([uint256(32), 0, 0, 0, 0, 0, 0, 0, 0]));
        upkeep(); upkeep(); upkeep();
        uint256 later = listCurated(2, 0.3 ether);
        vm.roll(block.number + ITimeout(address(pool)).selectionTimeoutBlocks() + 1);
        pool.processAcquisitions(1);
        vm.prank(creator); balancer.withdrawCurated(curated[0], creator);
        assertEq(_slot(curated[0]), 0);
        assertEq(balancer.reconciledSequence(), 0);
        assertEq(balancer.admissionStatus(), 7, "a removed curated witness is not selectable");
        vm.prank(stranger); pool.activateListings(1);
        uint256 reusedBy = pool.slotToListing(oldSlot);
        assertGt(reusedBy, 0);
        assertTrue(reusedBy != curated[0]);
        (uint8 kind,,,,) = balancer.items(reusedBy);
        assertEq(kind, 2, "real FWA free-list reuses the old curated slot for a Shape");
        assertEq(_slot(later), 0);
        assertEq(balancer.admissionStatus(), 7);
        for (uint256 i; i < 4; ++i) {
            uint256 lid = i == 0 ? curated[0] : i == 1 ? later : i == 2 ? reusedBy : type(uint256).max;
            vm.prank(stranger); vm.expectRevert(PoolBalancer.InvalidItem.selector);
            balancer.refreshCuratedWitness(lid);
        }
        upkeep();
        assertEq(balancer.admissionStatus(), 7, "reconciliation alone cannot activate the remaining curated NFT");
    }

    function test_lastCuratedWithdrawalIsKnownAbsence() public {
        uint256[] memory curated = _launch(20, 1);
        vm.prank(creator); balancer.withdrawCurated(curated[0], creator);
        assertEq(balancer.admissionStatus(), 3);
    }

    function test_activeCountProofDoesNotDependOnLostWitness() public {
        uint256[] memory curated = _launch(20, 2);
        vm.prank(creator); balancer.withdrawCurated(curated[0], creator);
        assertEq(pool.activeListingCount(), 21);
        assertEq(balancer.listedShapePrizes(), 20);
        assertEq(balancer.admissionStatus(), 0, "active count proves curated presence despite the lost witness");
        assertEq(buy(stranger, 4).length, 4);
    }

    function test_fourOutstandingRequestsStillAdmitAnotherFiveRequestBatch() public {
        _launch(20, 1);
        assertEq(buy(buyer, 4).length, 4);
        assertEq(pool.unsettledAcquisitionCount(), 4);
        assertEq(balancer.admissionStatus(), 0);
        _fundVrfCoverage(5);
        assertEq(_batch(5).length, 5, "the operator is checked once per batch, not once per request");
        assertEq(pool.unsettledAcquisitionCount(), 9);
        assertEq(balancer.admissionStatus(), 4);
    }

    function _coolAdmission() internal {
        // Reset access warmth only. Protocol storage and balances are unchanged.
        address implementation = factory.implementation();
        vm.cool(address(balancer)); vm.cool(address(pool)); vm.cool(SHAPES);
        vm.cool(address(PoolInventory)); vm.cool(implementation); vm.cool(FWA_IMPL);
    }

    function test_coldWitnessHookAtThousandShapesAndHundredCuratedAdmitsFive() public {
        _launch(995, 1);
        buy(buyer, 1);
        configure(plan([uint256(1000), 0, 0, 0, 0, 0, 0, 0, 0]));
        upkeep();
        for (uint256 i; i < 99; ++i) listCurated(i + 2, 0.3 ether);
        vm.roll(block.number + ITimeout(address(pool)).selectionTimeoutBlocks() + 1);
        pool.processAcquisitions(1);
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(pool.activeListingCount(), 996);
        assertEq(balancer.listedShapePrizes(), 1000);
        assertEq(balancer.getActiveIds().length, 1100);
        assertEq(balancer.reconciledSequence(), 0);
        _coolAdmission();
        uint256 gasStart = gasleft();
        (bool ok, bytes memory result) = address(balancer).staticcall{gas: 100_000}(
            abi.encodeCall(PoolBalancer.canPurchase, (stranger)));
        uint256 hookGas = gasStart - gasleft();
        emit log_named_uint("cold curated witness canPurchase gas", hookGas);
        assertLt(hookGas, 100_000);
        assertTrue(ok);
        assertTrue(abi.decode(result, (bool)), "cold witness path fits the actual operator stipend");
        _fundVrfCoverage(5);
        CuratedAdmissionBuyer actor = new CuratedAdmissionBuyer();
        vm.deal(address(actor), 1 ether);
        _coolAdmission();
        uint256[] memory ids = actor.purchaseBatch(pool, 5);
        assertEq(ids.length, 5, "real FWA operator check succeeds with cold Balancer/library state");
        assertEq(pool.unsettledAcquisitionCount(), 5);
        assertEq(balancer.admissionStatus(), 4);
    }
}
