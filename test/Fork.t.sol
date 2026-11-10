// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {IFWAPool} from "../src/interfaces/External.sol";

interface IERC721View {
    function ownerOf(uint256) external view returns (address);
}

/// @notice Required end-to-end scenario on a mainnet fork with the real FWA pool and Shapes.
contract ForkScenarioTest is ForkBase {
    bytes4 constant PURCHASE_NOT_ALLOWED = bytes4(keccak256("PurchaseNotAllowed()"));
    bytes4 constant TOKEN_OFFER_UNAVAILABLE = bytes4(keccak256("TokenOfferUnavailable()"));
    bytes4 constant UNAUTHORIZED = bytes4(keccak256("Unauthorized()"));

    uint256 curatedA;
    uint256 curatedB;
    uint256 mainPlan;

    function setUp() public {
        setUpFork();
        createBalancer(5 ether);
        curatedA = listCurated(1, 0.3 ether);
        curatedB = listCurated(2, 0.5 ether);
        // 5 x 0.01, 3 x 0.05, 2 x 0.1 => 0.4 ETH backing
        mainPlan = plan([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0]);
        uint256[] memory plans = new uint256[](1);
        plans[0] = mainPlan;
        configure(0.03 ether, 30, plans); // 0.30% floor; one curated at 0.5 base is ~0.34%
        vm.prank(creator);
        balancer.open();
    }

    function test_ownershipAndOperator() public view {
        assertEq(pool.owner(), address(balancer), "balancer owns FWA pool");
        assertEq(pool.purchaseOperator(), address(balancer), "balancer is purchase operator");
        assertEq(balancer.creator(), creator);
        assertTrue(factory.isBalancer(address(balancer)));
    }

    function test_initialUpkeepBuildsInventoryAndCheckpoints() public {
        assertEq(balancer.admissionStatus(), 2, "needs upkeep before first purchase");
        assertFalse(balancer.canPurchase(buyer));
        uint256 keeperBefore = keeper.balance;
        fillUp();
        assertGt(keeper.balance, keeperBefore, "keeper paid for real work");
        uint16[9] memory active = balancer.getActiveShapes();
        assertEq(active[0], 5);
        assertEq(active[1], 3);
        assertEq(active[2], 2);
        assertEq(pool.activeListingCount(), 12);
        assertEq(balancer.admissionStatus(), 0);
        assertTrue(balancer.canPurchase(buyer));
        assertLe(pool.acquisitionFee(), 0.03 ether);
        // second call has nothing to do
        vm.prank(keeper);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep();
    }

    function test_canPurchaseFitsStipend() public {
        fillUp();
        uint256 g = gasleft();
        vm.prank(address(pool));
        bool ok = balancer.canPurchase(buyer);
        uint256 used = g - gasleft();
        assertTrue(ok);
        assertLt(used, 100_000, "operator check under FWA stipend");
        emit log_named_uint("canPurchase gas (warm-ish)", used);
    }

    function test_singleShapeDrawReplenishes() public {
        fillUp();
        uint256 last = lastListingId(); // a 0.1 Shape, listed last
        (,,, uint256 tokenId,,,,) = pool.listings(last);
        uint256[] memory ids = buy(buyer, 1);
        assertFalse(balancer.canPurchase(buyer), "closed while batch unresolved");

        (, , uint256 slot,) = _slotOf(last);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        assertEq(IERC721View(SHAPES).ownerOf(tokenId), buyer, "Shape delivered to buyer");
        uint256 proceeds = pool.ownerProceeds();
        assertGt(proceeds, 0, "owner proceeds credited");
        assertFalse(balancer.canPurchase(buyer), "closed until reconciled");

        uint256 balBefore = address(balancer).balance;
        upkeep();
        uint16[9] memory active = balancer.getActiveShapes();
        assertEq(active[2], 2, "0.1 Shape replaced");
        assertEq(pool.activeListingCount(), 12);
        assertTrue(balancer.canPurchase(buyer), "reopened");
        assertEq(pool.ownerProceeds(), 0, "proceeds collected");
        // balance: +proceeds - (0.1 + mintFee) - keeper reward
        assertLt(address(balancer).balance, balBefore + proceeds);

        uint256 surplus = balancer.withdrawableSurplus();
        assertGt(surplus, 0);
        uint256 before = creator.balance;
        vm.prank(creator);
        balancer.claimSurplus(surplus, creator);
        assertEq(creator.balance, before + surplus);
        assertTrue(balancer.canPurchase(buyer), "claiming surplus keeps admission funded");
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InsufficientSurplus.selector);
        balancer.claimSurplus(1, creator);
    }

    function test_curatedDrawDeliversAndPoolStaysOpen() public {
        fillUp();
        (, , uint256 slot,) = _slotOf(curatedA);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        assertEq(nft.ownerOf(1), buyer, "curated NFT delivered");
        upkeep();
        assertTrue(balancer.canPurchase(buyer), "one curated item left, still feasible");
        // with a stricter floor the same inventory is infeasible and admission closes
        uint256[] memory plans = new uint256[](1);
        plans[0] = mainPlan;
        configure(0.03 ether, 50, plans);
        vm.prank(keeper);
        balancer.performUpkeep();
        assertEq(balancer.admissionStatus(), 5, "INFEASIBLE");
        (uint8 kind,,,,) = balancer.items(curatedA);
        assertEq(kind, 0, "curated record cleared");
    }

    function test_lastCuratedDrawnClosesPool() public {
        fillUp();
        vm.prank(creator);
        balancer.withdrawCurated(curatedB, creator);
        upkeep();
        assertTrue(balancer.canPurchase(buyer));
        (, , uint256 slot,) = _slotOf(curatedA);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        upkeep();
        assertEq(balancer.admissionStatus(), 4, "NO_CURATED");
        assertFalse(balancer.canPurchase(buyer));
        // adding a curated NFT reopens without minting (keeper reconciles unpaid re-checkpoint)
        listCurated(3, 0.4 ether);
        vm.prank(creator);
        balancer.performUpkeep();
        assertTrue(balancer.canPurchase(buyer), "reopened");
    }

    function test_batchOfFiveThenRejectUntilReconciled() public {
        fillUp();
        uint256[] memory ids = buy(buyer, 5);
        assertEq(ids.length, 5);
        // next purchase rejected by the operator while the batch is unresolved
        (,, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 v = pool.inventoryVersion();
        vm.prank(stranger);
        vm.deal(stranger, 1 ether);
        vm.expectRevert(PURCHASE_NOT_ALLOWED);
        pool.acquire{value: total}(stranger, 0, 0, 10_000, v, block.timestamp + 1);

        for (uint256 i; i < 5; ++i) {
            fulfill(ids[i], uint256(keccak256(abi.encode("word", i))));
        }
        settle();
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertFalse(balancer.canPurchase(stranger), "still closed after settlement, before upkeep");
        vm.prank(stranger);
        vm.expectRevert(PURCHASE_NOT_ALLOWED);
        pool.acquire{value: total}(stranger, 0, 0, 10_000, v, block.timestamp + 1);

        upkeep();
        uint16[9] memory active = balancer.getActiveShapes();
        assertEq(active[0], 5);
        assertEq(active[1], 3);
        assertEq(active[2], 2);
        assertTrue(balancer.canPurchase(stranger), "reopened after reconciliation");
        buy(stranger, 1);
    }

    function test_tokenPurchasesImpossible() public {
        fillUp();
        assertFalse(pool.tokenOfferEnabled());
        uint256 v = pool.inventoryVersion();
        vm.prank(buyer);
        vm.expectRevert(TOKEN_OFFER_UNAVAILABLE);
        pool.acquireWithToken(buyer, 1, 0, 10_000, v, 0, block.timestamp + 1);
        // FWA's owner-only configuration cannot be reached by the creator or a stranger
        vm.prank(creator);
        vm.expectRevert(UNAUTHORIZED);
        pool.configureTokenOffer(1, 0, true);
        vm.prank(stranger);
        vm.expectRevert(UNAUTHORIZED);
        pool.configureTokenOffer(1, 0, true);
        // the Balancer exposes no fallback through which the selector could be forwarded
        vm.prank(creator);
        (bool ok,) = address(balancer).call(abi.encodeCall(IFWAPool.configureTokenOffer, (1, 0, true)));
        assertFalse(ok);
        assertFalse(pool.tokenOfferEnabled());
    }

    function test_mintFeeRiseClosesAdmission() public {
        fillUp();
        // Shapes admin may raise the fee up to one unit; simulate via storage-agnostic mock call.
        vm.mockCall(SHAPES, abi.encodeWithSignature("mintFee()"), abi.encode(uint256(0.005 ether)));
        assertEq(balancer.admissionStatus(), 7, "MINT_FEE_ROSE");
        upkeep(); // re-checkpoints at the new fee if still funded
        assertTrue(balancer.canPurchase(buyer));
        vm.clearMockedCalls();
    }

    function test_insufficientReserveKeepsClosed() public {
        fillUp();
        vm.startPrank(creator);
        balancer.close();
        balancer.claimSurplus(address(balancer).balance, creator); // closed => everything withdrawable
        balancer.open();
        vm.stopPrank();
        vm.prank(keeper);
        balancer.performUpkeep();
        assertEq(balancer.admissionStatus(), 6, "INSUFFICIENT_RESERVE");
        assertFalse(balancer.canPurchase(buyer));
        vm.prank(creator);
        balancer.depositETH{value: 1 ether}();
        upkeep();
        assertTrue(balancer.canPurchase(buyer));
    }

    function test_unwindAndRetire() public {
        fillUp();
        vm.startPrank(creator);
        vm.expectRevert(PoolBalancer.NotClosed.selector);
        balancer.unwind(20);
        balancer.close();
        uint256 before = address(balancer).balance;
        balancer.unwind(20);
        assertEq(address(balancer).balance, before + 0.4 ether, "Shapes redeemed for exact backing");
        uint16[9] memory active = balancer.getActiveShapes();
        assertEq(active[0] + active[1] + active[2], 0);
        balancer.withdrawCurated(curatedA, creator);
        balancer.withdrawCurated(curatedB, creator);
        balancer.retire();
        assertTrue(pool.retired());
        balancer.claimSurplus(address(balancer).balance, creator);
        vm.stopPrank();
        assertEq(address(balancer).balance, 0);
        assertEq(nft.ownerOf(1), creator);
        assertEq(nft.ownerOf(2), creator);
    }

    function _slotOf(uint256 lid) internal view returns (address, uint256, uint256, uint8) {
        (address c,,, uint256 t,,, uint256 s, uint8 st) = pool.listings(lid);
        return (c, t, s, st);
    }
}
