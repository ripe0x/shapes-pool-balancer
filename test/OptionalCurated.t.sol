// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, ITimeout} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {PoolInventory} from "../src/PoolInventory.sol";

interface IShapesAdmin {
    function setMintFee(uint256) external;
}

/// @notice Optional-curated admission (the new `curatedRequired` default-off mode) on a mainnet fork against the real
///         FWA pool, Shapes and Draw Packs. Randomness is delivered through the real VRF service (ForkBase.fulfill).
///         Money flows are asserted in absolute wei. Admission status codes: 0 OK, 1 CLOSED, 2 SETTING_UP,
///         3 NO_CURATED, 4 BUSY, 6 LOW_INVENTORY, 7 CURATED_PROOF_REQUIRED (3 and 7 only while curatedRequired).
contract OptionalCuratedTest is ForkBase {
    // Live Shapes admin that may change the mint fee (one unit, 0.01 ETH max). Used only as setup, not mocked.
    address internal constant SHAPES_ADMIN = 0xCB43078C32423F5348Cab5885911C3B5faE217F9;

    /*//////////////////////////// helpers ////////////////////////////*/

    /// @dev Direct atomic creation through the real factory with zero curated NFTs. Sets `balancer`/`pool`.
    function _create(bytes32 salt, uint16 rate, bool reqCurated, uint256 target, uint256 funding)
        internal
        returns (PoolBalancer b)
    {
        PoolBalancer.CreationConfig memory cfg =
            PoolBalancer.CreationConfig(MARKUP, rate, target, shapes.mintFee(), reqCurated);
        vm.prank(creator);
        b = PoolBalancer(payable(factory.createBalancer{value: funding}(salt, cfg, new PoolBalancer.CuratedInput[](0))));
        balancer = b;
        pool = b.pool();
    }

    /// @dev A standard-mode (curatedRequired=false) shapes/pack fixture reached through the closed-fixture round trip,
    ///      then reconfigured and opened. Leaves no curated NFT listed.
    function _openStandard(uint256 deposit, uint256 target) internal {
        curatedRequired = false;
        createBalancer(deposit);
        configure(target);
        vm.prank(creator);
        balancer.open();
        fillUp();
    }

    function _activeOfDenom(uint8 d) internal view returns (uint256) {
        uint256[] memory a = balancer.getActiveIds();
        for (uint256 i; i < a.length; ++i) {
            (uint8 kind, uint8 dd,,,) = balancer.items(a[i]);
            if (kind != 2 || dd != d) continue;
            (,,,,,,, uint8 st) = pool.listings(a[i]);
            if (st == 1) return a[i];
        }
        revert("no active prize of that denomination");
    }

    function _allShapeIds() internal view returns (uint256[] memory out) {
        uint256[] memory a = balancer.getActiveIds();
        uint256[] memory tmp = new uint256[](a.length);
        uint256 n;
        for (uint256 i; i < a.length; ++i) {
            (uint8 kind,,,,) = balancer.items(a[i]);
            if (kind == 2) tmp[n++] = a[i];
        }
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) out[i] = tmp[i];
    }

    /// @dev Buyer wins one active prize of denomination `d` through a real VRF callback. Returns the won token.
    function _isActive(uint256 lid) internal view returns (bool) {
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) if (ids[i] == lid) return true;
        return false;
    }

    function _win(uint8 d) internal returns (uint256 token) {
        uint256 lid = _activeOfDenom(d);
        uint256 slot;
        (,,, token,,, slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        assertEq(shapes.ownerOf(token), buyer, "the real prize was delivered to the winner");
        assertEq(shapes.backingOf(token), balancer.denominationAmount(d), "exact backing on the delivered Shape");
    }

    /// @dev Reset access warmth only; protocol storage and balances are unchanged (copied from CuratedAdmission).
    function _coolAdmission() internal {
        address implementation = factory.implementation();
        vm.cool(address(balancer));
        vm.cool(address(pool));
        vm.cool(SHAPES);
        vm.cool(address(PoolInventory));
        vm.cool(implementation);
        vm.cool(FWA_IMPL);
    }

    /*//////////////////////////// 1. atomic creation, zero curated ////////////////////////////*/

    function test_atomicCreationWithZeroCuratedStocksAndOpens() public {
        setUpFork();
        bytes32 salt = bytes32(uint256(1));
        uint256 target = plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]);
        address predicted = factory.predictBalancer(creator, salt);
        PoolBalancer b = _create(salt, 2500, false, target, 2 ether);

        assertEq(address(b), predicted, "deterministic address");
        assertEq(b.creator(), creator);
        assertEq(address(b).balance, 2 ether, "the full deposit is accepted as working capital");
        assertEq(b.markupBps(), MARKUP, "markup stored");
        assertEq(b.creatorRevenueBps(), 2500, "creatorRevenueBps stored exactly as passed");
        assertEq(b.target(), target, "target stored");
        assertEq(b.mintFeeCap(), shapes.mintFee(), "cap is the accepted live mint fee");
        assertFalse(b.curatedRequired(), "standard mode stored");
        assertTrue(b.enabled());
        assertTrue(b.creatorWork());
        assertEq(b.listedShapePrizes(), 0, "creation mints no inventory");
        assertEq(b.admissionStatus(), 2, "SETTING_UP until stocked");
        assertFalse(b.canPurchase(buyer));

        fillUp();
        uint16[16] memory have = b.getActiveShapes();
        for (uint256 i; i < 16; ++i) assertEq(have[i], (target >> (16 * i)) & 0xFFFF, "target stocked exactly");
        assertEq(b.admissionStatus(), 0, "no curated required, admission OK once stocked");
        assertTrue(b.canPurchase(buyer));
    }

    /*//////////////////////////// 2. shapes-only lifecycle ////////////////////////////*/

    function test_shapesOnlyLifecycleAccountedToTheWei() public {
        setUpFork();
        _openStandard(3 ether, plan([uint256(5), 0, 0, 0, 0, 0, 0, 0, 0]));
        assertEq(balancer.getActiveShapes()[0], 5);
        assertEq(balancer.admissionStatus(), 0);

        // purchase + real win + reconcile + restock
        uint256 wonLid = _activeOfDenom(0);
        _win(0);
        assertTrue(_isActive(wonLid), "a delivered Shape stays tracked until upkeep reconciles the draw");
        assertEq(balancer.getActiveShapes()[0], 5);
        uint256 proceeds = pool.ownerProceeds();
        assertGt(proceeds, 0, "the reached board produced owner proceeds");
        assertEq(balancer.collectProceeds(), proceeds, "collected exactly the settled proceeds");
        upkeep();
        assertFalse(_isActive(wonLid), "reconciliation removed the won listing");
        assertEq(balancer.getActiveShapes()[0], 5, "restocked to target in the same call (the draw was already processed)");
        assertEq(balancer.admissionStatus(), 0);

        // close, unlist everything, drain to the creator
        vm.prank(creator);
        balancer.close();
        assertEq(balancer.admissionStatus(), 1, "CLOSED");
        uint256[] memory sids = _allShapeIds();
        assertEq(sids.length, 5);
        uint256 before = address(balancer).balance;
        vm.prank(creator);
        balancer.unlistShapes(sids);
        assertEq(address(balancer).balance - before, 5 * 0.01 ether, "every Shape redeemed at exact backing");
        uint16[16] memory have = balancer.getActiveShapes();
        for (uint256 d; d < 16; ++d) assertEq(have[d], 0, "no inventory remains listed");

        assertEq(balancer.requiredReserve(), 0, "a closed, reconciled pool reserves nothing");
        uint256 surplus = balancer.withdrawableSurplus();
        assertEq(surplus, address(balancer).balance, "all capital is withdrawable");
        uint256 creatorBefore = creator.balance;
        vm.prank(creator);
        balancer.claimSurplus(surplus, creator);
        assertEq(creator.balance - creatorBefore, surplus, "creator received exactly the surplus");
        assertEq(address(balancer).balance, 0, "nothing stranded: the pool is empty to the wei");
        assertEq(balancer.creatorCredit(), 0);
        assertEq(balancer.withdrawableSurplus(), 0);
    }

    /*//////////////////////////// 3. mixed pool, withdraw last curated ////////////////////////////*/

    function test_standardModePurchasesContinueAfterLastCuratedWithdrawn() public {
        setUpFork();
        curatedRequired = false;
        createBalancer(3 ether);
        configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        uint256 c1 = listCurated(1, 0.3 ether);
        uint256 c2 = listCurated(2, 0.3 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertEq(balancer.admissionStatus(), 0);

        vm.prank(creator);
        balancer.withdrawCurated(c1, creator);
        assertEq(balancer.admissionStatus(), 0, "one curated left, still OK");
        vm.prank(creator);
        balancer.withdrawCurated(c2, creator);
        assertEq(balancer.getActiveIds().length, 10, "only the ten Shapes remain");
        assertEq(balancer.admissionStatus(), 0, "standard mode keeps selling Shapes with no curated NFT");

        // Shapes keep selling, subject only to the weight gate.
        assertEq(buy(buyer, 3).length, 3);
        assertEq(balancer.admissionStatus(), 0, "three unsettled still within the weight gate");

        // Contrast: the identical inventory pauses with NO_CURATED under curated-required mode.
        vm.prank(creator);
        balancer.setCuratedRequired(true);
        assertEq(balancer.admissionStatus(), 3, "required mode would pause: no curated NFT listed");
        vm.prank(creator);
        balancer.setCuratedRequired(false);
        assertEq(balancer.admissionStatus(), 0);
    }

    /*//////////////////////////// 4. add curated with listCuratedBatch ////////////////////////////*/

    function test_addCuratedToShapesOnlyPool() public {
        setUpFork();
        _openStandard(3 ether, plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        uint256 lenBefore = balancer.getActiveIds().length;
        assertEq(lenBefore, 10);

        PoolBalancer.CuratedInput[] memory batch = new PoolBalancer.CuratedInput[](3);
        vm.startPrank(creator);
        for (uint256 i; i < 3; ++i) {
            nft.mint(creator, 200 + i);
            nft.approve(address(balancer), 200 + i);
            batch[i] = PoolBalancer.CuratedInput(address(nft), 200 + i, 0.2 ether);
        }
        uint256[] memory lids = balancer.listCuratedBatch(batch);
        vm.stopPrank();

        assertEq(balancer.getActiveIds().length, lenBefore + 3, "three curated NFTs added");
        for (uint256 i; i < 3; ++i) {
            (uint8 kind,,, uint112 base, uint112 price) = balancer.items(lids[i]);
            assertEq(kind, 1, "listed as curated");
            assertEq(base, 0.2 ether, "listed at its value");
            assertEq(price, 0.2 ether, "curated carries no markup");
        }
        assertEq(balancer.admissionStatus(), 0, "listing curated does not close an open pool");
        assertTrue(balancer.canPurchase(buyer));
    }

    /*//////////////////////////// 5. curated-required mode ////////////////////////////*/

    function test_requiredMode_noCuratedListedReturnsThree() public {
        setUpFork(); // curatedRequired stays true (default)
        createBalancer(2 ether);
        configure(plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        uint256 lid = listCurated(1, 0.3 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertEq(balancer.admissionStatus(), 0);
        vm.prank(creator);
        balancer.withdrawCurated(lid, creator);
        assertEq(balancer.admissionStatus(), 3, "required mode: the known absence of any curated NFT");
    }

    function test_requiredMode_lostWitnessReturnsSevenUntilRefresh() public {
        setUpFork();
        createBalancer(3 ether);
        configure(plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        uint256 c0 = listCurated(1, 0.3 ether);
        uint256 c1 = listCurated(2, 0.3 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertEq(balancer.admissionStatus(), 0);

        buy(buyer, 1);
        configure(plan([uint256(32), 0, 0, 0, 0, 0, 0, 0, 0]));
        upkeep();
        upkeep();
        upkeep();
        vm.roll(block.number + ITimeout(address(pool)).selectionTimeoutBlocks() + 1);
        pool.processAcquisitions(1);
        vm.prank(creator);
        balancer.withdrawCurated(c0, creator);
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(balancer.admissionStatus(), 7, "the surviving curated NFT's proof was genuinely lost");

        uint256 balance = address(balancer).balance;
        uint256 credit = balancer.creatorCredit();
        vm.prank(stranger);
        assertTrue(balancer.refreshCuratedWitness(c1), "anyone may re-prove the surviving curated NFT");
        assertEq(balancer.admissionStatus(), 0, "one permissionless refresh restores purchases");
        assertEq(address(balancer).balance, balance, "refresh moves no capital");
        assertEq(balancer.creatorCredit(), credit);
    }

    /// @dev Port of CuratedAdmission's staged-witness attack, run with curatedRequired = true: a curated NFT that is
    ///      only staged (never an active FWA listing) can never authorize a purchase.
    function test_requiredMode_stagedCuratedNeverAuthorizesPurchase() public {
        setUpFork();
        createBalancer(2 ether);
        configure(plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        uint256 active = listCurated(1, 0.3 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertEq(balancer.admissionStatus(), 0);

        buy(buyer, 1);
        assertEq(pool.unsettledAcquisitionCount(), 1);
        configure(plan([uint256(32), 0, 0, 0, 0, 0, 0, 0, 0]));
        upkeep();
        upkeep();
        upkeep();
        uint256 staged = listCurated(2, 0.3 ether);
        (,,,,,, uint256 slot, uint8 status) = pool.listings(staged);
        assertEq(slot, 0);
        assertEq(status, 5, "the second curated NFT is only staged behind the new Shapes");

        vm.roll(block.number + ITimeout(address(pool)).selectionTimeoutBlocks() + 1);
        upkeep();
        assertEq(pool.unsettledAcquisitionCount(), 0);
        vm.prank(creator);
        balancer.withdrawCurated(active, creator);
        (,,,,,, slot, status) = pool.listings(staged);
        assertEq(slot, 0);
        assertEq(status, 5, "the sole remaining curated NFT is still only staged");
        assertEq(balancer.admissionStatus(), 7, "a staged curated NFT does not authorize purchases");

        // A purchase attempt reverts and moves nothing.
        (,, uint256 payment) = pool.quoteAcquisitionPrice(1);
        uint256 poolCash = address(pool).balance;
        uint64 issued = pool.lastIssuedSequence();
        uint256 version = pool.inventoryVersion();
        vm.prank(buyer, buyer);
        vm.expectRevert(bytes4(keccak256("PurchaseNotAllowed()")));
        pool.acquireBatch{value: payment}(buyer, 1, 0, 0, 10_000, version, block.timestamp + 1);
        assertEq(address(pool).balance, poolCash, "the refused purchase paid nothing");
        assertEq(pool.lastIssuedSequence(), issued, "no request was issued");

        // Public FIFO activation plus one refresh restores the proof and purchases.
        vm.prank(stranger);
        pool.activateListings(13);
        (,,,,,, slot, status) = pool.listings(staged);
        assertGt(slot, 0);
        assertEq(status, 1, "the curated NFT is now an active FWA listing");
        vm.prank(stranger);
        assertTrue(balancer.refreshCuratedWitness(staged));
        assertEq(balancer.admissionStatus(), 0);
    }

    /*//////////////////////////// 6. toggling setCuratedRequired ////////////////////////////*/

    function test_toggleCuratedRequiredFlipsAdmissionWithNoAssetMovement() public {
        setUpFork();
        _openStandard(3 ether, plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        assertEq(balancer.admissionStatus(), 0, "standard mode, shapes only");

        uint256 balance = address(balancer).balance;
        uint256 credit = balancer.creatorCredit();
        uint256 listings = balancer.getActiveIds().length;

        vm.prank(stranger);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.setCuratedRequired(true);

        vm.prank(creator);
        balancer.setCuratedRequired(true);
        assertEq(balancer.admissionStatus(), 3, "required mode pauses immediately with no curated NFT");

        vm.prank(creator);
        balancer.setCuratedRequired(false);
        assertEq(balancer.admissionStatus(), 0, "back to OK immediately");

        assertEq(address(balancer).balance, balance, "no ETH moved");
        assertEq(balancer.creatorCredit(), credit, "no credit changed");
        assertEq(balancer.getActiveIds().length, listings, "no listing changed");
    }

    /*//////////////////////////// 7. no-0.01 pool with packs ////////////////////////////*/

    function test_noCheapShapePoolStocksSellsWinsRestocksAndGatesEarly() public {
        setUpFork();
        curatedRequired = false;
        createBalancer(5 ether);
        uint256[16] memory c;
        c[1] = 10; // ten 0.05 ETH Shapes (no 0.01 denomination at all)
        c[9] = 2; //  two 0.02 ETH packs
        c[12] = 1; //  one 0.25 ETH pack
        configure(plan16(c));
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertEq(balancer.getActiveShapes()[1], 10, "0.05 Shapes stocked");
        assertEq(balancer.getActiveShapes()[9], 2, "0.02 packs stocked");
        assertEq(balancer.getActiveShapes()[12], 1, "0.25 pack stocked");
        assertEq(balancer.admissionStatus(), 0);

        // purchase + win + restock a 0.05 Shape
        uint256 wonLid = _activeOfDenom(1);
        _win(1);
        assertTrue(_isActive(wonLid), "a delivered Shape stays tracked until upkeep reconciles the draw");
        fillUp();
        assertFalse(_isActive(wonLid), "reconciliation removed the won 0.05 Shape");
        assertEq(balancer.getActiveShapes()[1], 10, "0.05 Shape restocked");
        assertEq(balancer.admissionStatus(), 0);

        // The gate charges each unsettled draw the weight of a 0.01 Shape, so a pool with no 0.01 Shapes pauses on the
        // LOW_INVENTORY gate well before the five-draw BUSY gate. Record how many unsettled draws it admits.
        uint256 admitted;
        while (balancer.admissionStatus() == 0 && admitted < 6) {
            buy(buyer, 1);
            ++admitted;
        }
        emit log_named_uint("unsettled draws admitted before the weight gate pauses (no-0.01 pool)", admitted);
        assertGt(admitted, 0, "at least the first purchase is admitted from a full board");
        assertLt(admitted, 5, "the weight gate bites before the BUSY gate");
        assertEq(balancer.admissionStatus(), 6, "paused on LOW_INVENTORY, not BUSY");
    }

    /*//////////////////////////// 8. explicit creator revenue at creation ////////////////////////////*/

    function test_creatorRevenueAtCreationStoredAndUsedForCredit() public {
        setUpFork();
        uint256 target = plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]);
        uint16[3] memory rates = [uint16(0), 2500, 10_000];
        for (uint256 k; k < 3; ++k) {
            uint16 rate = rates[k];
            _create(bytes32(uint256(0x80 + k)), rate, false, target, 2 ether);
            assertEq(balancer.creatorRevenueBps(), rate, "rate stored exactly as passed at creation");
            fillUp();

            _win(0); // buyer wins a 0.01 Shape
            uint256 proceeds = pool.ownerProceeds();
            assertGt(proceeds, 0);
            assertEq(balancer.collectProceeds(), proceeds, "collected the actual settled proceeds");
            assertEq(balancer.creatorCredit(), proceeds * rate / 10_000, "credit is exactly the stored share of cash");

            // Claiming credit removes only credit: operating cash (balance - credit) is unchanged to the wei.
            uint256 credit = balancer.creatorCredit();
            uint256 operating = address(balancer).balance - credit;
            if (credit != 0) {
                uint256 creatorBefore = creator.balance;
                vm.prank(creator);
                balancer.claimSurplus(credit, creator);
                assertEq(creator.balance - creatorBefore, credit, "creator received exactly the credit");
            }
            assertEq(address(balancer).balance - balancer.creatorCredit(), operating, "operating cash unchanged by the claim");
            assertEq(balancer.creatorCredit(), 0);
        }
    }

    /*//////////////////////////// 9. mint fee above the cap ////////////////////////////*/

    function test_mintFeeAboveCapKeepsSalesButHaltsMintingUntilReconfigure() public {
        setUpFork();
        _openStandard(5 ether, plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        assertEq(balancer.getActiveShapes()[0], 20);
        assertEq(balancer.admissionStatus(), 0);

        uint256 fee = shapes.mintFee();
        assertEq(balancer.mintFeeCap(), fee, "cap is the accepted fee");

        // Raise the real Shapes mint fee above the cap through its actual admin (setup, not a mock).
        vm.prank(SHAPES_ADMIN);
        IShapesAdmin(SHAPES).setMintFee(fee * 5);
        assertGt(shapes.mintFee(), balancer.mintFeeCap(), "live fee now exceeds the accepted cap");

        // Retired admission code 5 is gone: a full board still admits purchases.
        assertEq(balancer.admissionStatus(), 0, "mint fee no longer gates purchases of listed prizes");
        assertTrue(balancer.canPurchase(buyer));

        // Win Shapes and reconcile; upkeep mints nothing while the fee is above the cap. Six wins keep the weight gate
        // open (14 of 20 Shapes is exactly FILL_BPS); the seventh (via performUpkeepUnpaid) pauses it.
        uint256 wins;
        while (wins < 6) {
            _win(0);
            upkeep(); // paid reconcile, no restock above the cap
            ++wins;
            assertEq(balancer.getActiveShapes()[0], 20 - wins, "paid upkeep reconciled but minted nothing");
        }
        assertEq(balancer.admissionStatus(), 0, "fourteen Shapes still meet the fill threshold");
        _win(0); // seventh win
        vm.prank(stranger);
        balancer.performUpkeepUnpaid(); // unpaid reconcile, also no restock above the cap
        assertEq(balancer.getActiveShapes()[0], 13, "unpaid upkeep reconciled but minted nothing either");
        assertEq(balancer.admissionStatus(), 6, "depletion finally pauses on the weight gate");

        // Reconfiguring re-accepts the live fee; upkeep then restocks at the new fee.
        vm.startPrank(creator);
        balancer.configure(MARKUP, plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]), shapes.mintFee());
        vm.stopPrank();
        assertEq(balancer.mintFeeCap(), shapes.mintFee(), "the live fee is re-accepted as the new cap");
        fillUp();
        assertEq(balancer.getActiveShapes()[0], 20, "restocked at the new fee");
        assertEq(balancer.admissionStatus(), 0);

        // Restore the live fee for any later fork consumer.
        vm.prank(SHAPES_ADMIN);
        IShapesAdmin(SHAPES).setMintFee(fee);
    }

    /// The withdrawal reserve prices missing prizes at the accepted fee, not a higher live fee the pool will not mint at.
    /// Covers claims and withdrawals during the increase, sales of listed prizes, no minting, and explicit acceptance.
    function test_mintFeeAboveCapReserveUsesAcceptedFee() public {
        setUpFork();
        _openStandard(5 ether, plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        uint256 fee = shapes.mintFee();
        assertEq(fee, 0.001 ether, "fork's real Shapes mint fee");
        assertEq(balancer.mintFeeCap(), fee);

        // Three wins, reconciled; the fee rises before upkeep can restock them.
        for (uint256 k; k < 3; ++k) _win(0);
        vm.prank(SHAPES_ADMIN);
        IShapesAdmin(SHAPES).setMintFee(fee * 10);
        upkeep(); // reconciles the three draws; mints nothing above the cap
        assertEq(balancer.getActiveShapes()[0], 17, "three prizes missing, none minted");
        uint256 req = balancer.requiredReserve();

        // Restoring the live fee to the cap leaves the reserve unchanged: a higher live fee adds nothing.
        vm.prank(SHAPES_ADMIN);
        IShapesAdmin(SHAPES).setMintFee(fee);
        assertEq(balancer.requiredReserve(), req, "reserve at a 10x live fee equals the reserve at the accepted fee");
        vm.prank(SHAPES_ADMIN);
        IShapesAdmin(SHAPES).setMintFee(fee * 10);

        // Listed prizes keep selling at the higher fee.
        assertEq(balancer.admissionStatus(), 0);
        assertTrue(balancer.canPurchase(buyer));
        _win(0);
        upkeep();
        assertEq(balancer.getActiveShapes()[0], 16, "a fourth sale reconciled, still nothing minted");
        req = balancer.requiredReserve();

        // Claims during the increase: protected credit plus surplus above the accepted-fee reserve, to the wei.
        balancer.collectProceeds();
        uint256 credit = balancer.creatorCredit();
        uint256 operating = address(balancer).balance - credit;
        assertGt(operating, req);
        uint256 available = balancer.withdrawableSurplus();
        assertEq(available, credit + operating - req, "surplus is measured against the accepted fee");
        uint256 before = creator.balance;
        vm.prank(creator);
        balancer.claimSurplus(available, creator);
        assertEq(creator.balance - before, available, "creator received credit and surplus");
        assertEq(balancer.creatorCredit(), 0);
        assertEq(address(balancer).balance, req, "exactly the accepted-fee reserve remains");
        assertEq(balancer.withdrawableSurplus(), 0);
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InsufficientSurplus.selector);
        balancer.claimSurplus(1, creator);

        // Explicit acceptance: the reserve rises by exactly the four missing Shapes' extra fee, 4 x 9 x 0.001 ETH.
        vm.startPrank(creator);
        balancer.configure(MARKUP, plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]), shapes.mintFee());
        vm.stopPrank();
        assertEq(balancer.mintFeeCap(), fee * 10, "the live fee is the new cap");
        assertEq(balancer.requiredReserve() - req, 4 * 9 * fee, "reserve now prices missing prizes at the new fee");
        assertEq(balancer.requiredReserve() - req, 0.036 ether);
        address donor = makeAddr("donor");
        vm.deal(donor, 1 ether); // funding an outside wallet is setup
        vm.prank(donor);
        balancer.depositETH{value: 1 ether}();
        fillUp();
        assertEq(balancer.getActiveShapes()[0], 20, "restocked at the accepted higher fee");

        vm.prank(SHAPES_ADMIN);
        IShapesAdmin(SHAPES).setMintFee(fee);
    }

    /*//////////////////////////// 10. canPurchase gas under the FWA stipend ////////////////////////////*/

    function test_canPurchaseGasStandardModeUnderStipend() public {
        setUpFork();
        _openStandard(3 ether, plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        _coolAdmission();
        uint256 g = gasleft();
        (bool ok, bytes memory result) =
            address(balancer).staticcall{gas: 100_000}(abi.encodeCall(PoolBalancer.canPurchase, (stranger)));
        uint256 hookGas = g - gasleft();
        emit log_named_uint("canPurchase gas (standard mode, cold)", hookGas);
        assertLt(hookGas, 60_000, "well under the 100k FWA operator stipend");
        assertTrue(ok);
        assertTrue(abi.decode(result, (bool)), "standard-mode board admits");
    }

    function test_canPurchaseGasRequiredModeUnderStipend() public {
        setUpFork(); // curatedRequired stays true
        createBalancer(3 ether);
        configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        listCurated(1, 0.3 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        _coolAdmission();
        uint256 g = gasleft();
        (bool ok, bytes memory result) =
            address(balancer).staticcall{gas: 100_000}(abi.encodeCall(PoolBalancer.canPurchase, (stranger)));
        uint256 hookGas = g - gasleft();
        emit log_named_uint("canPurchase gas (required mode, cold curated-witness path)", hookGas);
        assertLt(hookGas, 100_000, "the curated-witness path still fits the operator stipend");
        assertTrue(ok);
        assertTrue(abi.decode(result, (bool)), "required-mode board with a proven curated NFT admits");
    }
}
