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
    uint256 mainTarget;

    function setUp() public {
        setUpFork();
        createBalancer(5 ether);
        curatedA = listCurated(1, 0.3 ether);
        curatedB = listCurated(2, 0.5 ether);
        // 5 x 0.01, 3 x 0.05, 2 x 0.1 => 0.4 ETH backing
        mainTarget = plan([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0]);
        configure(mainTarget);
        vm.prank(creator);
        balancer.open();
    }

    function test_ownershipAndOperator() public view {
        assertEq(pool.owner(), address(balancer), "balancer owns FWA pool");
        assertEq(pool.purchaseOperator(), address(balancer), "balancer is purchase operator");
        assertEq(balancer.creator(), creator);
        assertTrue(factory.isBalancer(address(balancer)));
    }

    function test_initialUpkeepBuildsInventory() public {
        assertEq(balancer.admissionStatus(), 2, "SETTING_UP before first purchase");
        assertFalse(balancer.canPurchase(buyer));
        uint256 keeperBefore = keeper.balance;
        fillUp();
        assertGt(keeper.balance, keeperBefore, "keeper paid for real work");
        uint16[16] memory active = balancer.getActiveShapes();
        assertEq(active[0], 5);
        assertEq(active[1], 3);
        assertEq(active[2], 2);
        assertEq(pool.activeListingCount(), 12);
        assertEq(balancer.admissionStatus(), 0);
        assertTrue(balancer.canPurchase(buyer));
        assertEq(balancer.prizeWeight(), balancer.targetWeight(), "fully listed");
        // second call has nothing to do
        vm.prank(keeper);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep();
    }

    function test_canPurchaseFitsStipend() public {
        fillUp();
        // Cold, as in FWA's purchase transaction: every account and slot the hook reads starts unaccessed.
        vm.cool(address(balancer));
        vm.cool(address(pool));
        vm.cool(FWA_IMPL);
        vm.cool(SHAPES);
        uint256 g = gasleft();
        vm.prank(address(pool));
        bool ok = balancer.canPurchase(buyer);
        uint256 used = g - gasleft();
        assertTrue(ok);
        assertLt(used, 100_000, "operator check under FWA stipend");
        emit log_named_uint("canPurchase gas (cold)", used);
    }

    function test_singleShapeDrawReplenishes() public {
        fillUp();
        uint256 last = lastListingId(); // a 0.1 Shape, listed last
        (,,, uint256 tokenId,,,,) = pool.listings(last);
        (,,,,,, uint256 slot,) = pool.listings(last);
        uint256[] memory ids = buy(buyer, 1);
        assertTrue(balancer.canPurchase(buyer), "overlapping purchases admitted while a draw is unsettled");

        fulfill(ids[0], wordForSlot(slot));
        settle();
        assertEq(IERC721View(SHAPES).ownerOf(tokenId), buyer, "Shape delivered to buyer");
        uint256 proceeds = pool.ownerProceeds();
        assertGt(proceeds, 0, "owner proceeds credited");

        uint256 balBefore = address(balancer).balance;
        upkeep();
        uint16[16] memory active = balancer.getActiveShapes();
        assertEq(active[2], 2, "0.1 Shape replaced");
        assertEq(pool.activeListingCount(), 12);
        assertTrue(balancer.canPurchase(buyer));
        assertEq(pool.ownerProceeds(), 0, "proceeds collected");
        assertLt(address(balancer).balance, balBefore + proceeds);
        assertEq(pool.lastIssuedSequence(), balancer.reconciledSequence(), "reconciled");

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
        (,,,,,, uint256 slot,) = pool.listings(curatedA);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        assertEq(nft.ownerOf(1), buyer, "curated NFT delivered");
        upkeep();
        assertTrue(balancer.canPurchase(buyer), "one curated item left, still open");
        (uint8 kind,,,,) = balancer.items(curatedA);
        assertEq(kind, 0, "curated record cleared after delivery");
    }

    function test_lastCuratedDrawnClosesPool() public {
        fillUp();
        vm.prank(creator);
        balancer.withdrawCurated(curatedB, creator);
        assertTrue(balancer.canPurchase(buyer), "one curated remains, no upkeep needed");
        (,,,,,, uint256 slot,) = pool.listings(curatedA);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        upkeep();
        assertEq(balancer.admissionStatus(), 3, "NO_CURATED");
        assertFalse(balancer.canPurchase(buyer));
        // adding a curated NFT reopens immediately: the gate only needs one active curated listing
        listCurated(3, 0.4 ether);
        assertTrue(balancer.canPurchase(buyer), "reopened");
    }

    /// Overlapping purchases are allowed up to MAX_BATCH unsettled; the 5th makes the pool BUSY.
    /// A high-weight target so the heaviest-prize LOW_INVENTORY allowance does not close the gate first.
    function test_overlappingPurchasesBusyAtFive() public {
        configure(plan([uint256(40), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        for (uint256 i; i < 4; ++i) {
            assertTrue(balancer.canPurchase(buyer), "admitted below 5 unsettled");
            buy(buyer, 1);
        }
        assertEq(pool.unsettledAcquisitionCount(), 4);
        assertTrue(balancer.canPurchase(buyer), "4 unsettled still admits one more batch");
        buy(buyer, 1);
        assertEq(pool.unsettledAcquisitionCount(), 5);
        assertEq(balancer.admissionStatus(), 4, "BUSY at 5 unsettled");
        assertFalse(balancer.canPurchase(buyer));
        // FWA refuses the next acquisition while BUSY
        (,, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 v = pool.inventoryVersion();
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(PURCHASE_NOT_ALLOWED);
        pool.acquire{value: total}(stranger, 0, 0, 10_000, v, block.timestamp + 1);
    }

    function test_tokenPurchasesImpossible() public {
        fillUp();
        assertFalse(pool.tokenOfferEnabled());
        uint256 v = pool.inventoryVersion();
        vm.prank(buyer);
        vm.expectRevert(TOKEN_OFFER_UNAVAILABLE);
        pool.acquireWithToken(buyer, 1, 0, 10_000, v, 0, block.timestamp + 1);
        vm.prank(creator);
        vm.expectRevert(UNAUTHORIZED);
        pool.configureTokenOffer(1, 0, true);
        vm.prank(stranger);
        vm.expectRevert(UNAUTHORIZED);
        pool.configureTokenOffer(1, 0, true);
        vm.prank(creator);
        (bool ok,) = address(balancer).call(abi.encodeCall(IFWAPool.configureTokenOffer, (1, 0, true)));
        assertFalse(ok);
        assertFalse(pool.tokenOfferEnabled());
    }

    function test_unlistAndRetire() public {
        fillUp();
        vm.startPrank(creator);
        vm.expectRevert(PoolBalancer.NotClosed.selector);
        balancer.retire();
        balancer.close();
        uint256 before = address(balancer).balance;
        balancer.unlistShapes(_allShapeIds());
        assertEq(address(balancer).balance, before + 0.4 ether, "Shapes redeemed for exact backing");
        uint16[16] memory active = balancer.getActiveShapes();
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

    function _allShapeIds() internal view returns (uint256[] memory out) {
        uint256[] memory ids = balancer.getActiveIds();
        uint256[] memory tmp = new uint256[](ids.length);
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = balancer.items(ids[i]);
            if (kind == 2) tmp[n++] = ids[i];
        }
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) out[i] = tmp[i];
    }
}
