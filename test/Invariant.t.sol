// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {IFWAPool, IShapes} from "../src/interfaces/External.sol";
import {MockNFT} from "./utils/Mocks.sol";

interface IVRFServiceH {
    function coordinator() external view returns (address);
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}

/// @dev Random sequences of player, VRF, keeper and creator actions against the real FWA pool.
contract Handler is Test {
    PoolBalancer public b;
    IFWAPool public pool;
    MockNFT public nft;
    address public creator;
    address constant VRF_SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;
    uint256 constant MARKUP = 1500;
    uint256[] public open;
    uint256 nextNft = 1000;
    uint256 public purchasesAdmitted;
    /// Restocking fees of the prizes keepers listed outside creator work (listed price less `base`).
    uint256 public maxReward;
    /// Keeper rewards paid outside creator work.
    uint256 public paidFromFees;
    uint256 public paidWithoutWork;
    mapping(uint8 => uint256) public closedReasons;

    uint256 immutable targetA;
    uint256 immutable targetB;

    constructor(PoolBalancer b_, MockNFT nft_, address creator_, uint256 a, uint256 bb) {
        b = b_;
        pool = b_.pool();
        nft = nft_;
        creator = creator_;
        targetA = a;
        targetB = bb;
    }

    /// Overlapping purchases are allowed: buy while earlier draws are still pending.
    function buy(uint256 count, uint256 who) external {
        count = bound(count, 1, 5);
        address buyer = address(uint160(bound(who, 1, 50)) + 0x1000);
        if (!b.canPurchase(buyer)) {
            ++closedReasons[b.admissionStatus()];
            return;
        }
        (,, uint256 total) = pool.quoteAcquisitionPrice(count);
        vm.deal(buyer, total);
        uint256 v = pool.inventoryVersion();
        vm.prank(buyer, buyer);
        try pool.acquireBatch{value: total}(buyer, count, 0, 0, 10_000, v, block.timestamp + 1) returns (uint256[] memory ids) {
            for (uint256 i; i < ids.length; ++i) open.push(ids[i]);
            ++purchasesAdmitted;
        } catch {}
    }

    function fulfillAll(uint256 seed) external {
        if (open.length == 0) return;
        vm.roll(block.number + 3);
        address coord = IVRFServiceH(VRF_SERVICE).coordinator();
        for (uint256 i; i < open.length; ++i) {
            uint256[] memory w = new uint256[](1);
            w[0] = uint256(keccak256(abi.encode(seed, open[i])));
            vm.prank(coord);
            IVRFServiceH(VRF_SERVICE).rawFulfillRandomWords{gas: 5_000_000}(open[i], w);
        }
        delete open;
        if (pool.unsettledAcquisitionCount() != 0) pool.processAcquisitions(5);
    }

    function expireAll() external {
        if (open.length == 0) return;
        vm.roll(block.number + 40);
        pool.processAcquisitions(5);
        delete open;
    }

    function upkeep() external {
        uint256[] memory before = b.getActiveIds();
        uint256 last;
        for (uint256 i; i < before.length; ++i) {
            if (before[i] > last) last = before[i];
        }
        uint64 seq = b.reconciledSequence();
        try b.performUpkeep() returns (uint256 reward) {
            if (reward == 0) return;
            paidFromFees += reward;
            if (reward > maxReward) maxReward = reward;
            // A paid call reconciled a draw or listed a prize (listing ids only grow).
            bool worked = b.reconciledSequence() != seq;
            uint256[] memory ids = b.getActiveIds();
            for (uint256 i; i < ids.length && !worked; ++i) {
                if (ids[i] > last) worked = true;
            }
            if (!worked) ++paidWithoutWork;
        } catch {}
    }

    function claim(uint256 amount) external {
        uint256 s = b.withdrawableSurplus();
        if (s == 0) return;
        amount = bound(amount, 1, s);
        vm.prank(creator);
        try b.claimSurplus(amount, creator) {} catch {}
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 0, 2 ether);
        vm.deal(creator, amount);
        vm.prank(creator);
        b.depositETH{value: amount}();
    }

    function addCurated(uint256 base) external {
        base = bound(base, 0.05 ether, 2 ether);
        uint256 id = nextNft++;
        nft.mint(creator, id);
        vm.startPrank(creator);
        nft.approve(address(b), id);
        try b.listCurated(address(nft), id, base) {} catch {}
        vm.stopPrank();
    }

    function withdrawCurated(uint256 idx) external {
        uint256[] memory ids = b.getActiveIds();
        if (ids.length == 0) return;
        uint256 lid = ids[bound(idx, 0, ids.length - 1)];
        (uint8 kind,,,,) = b.items(lid);
        if (kind != 1) return;
        vm.prank(creator);
        try b.withdrawCurated(lid, creator) {} catch {}
    }

    /// Occasionally change the markup and target.
    function reconfigure(uint256 pick) external {
        uint256 t = pick % 2 == 0 ? targetA : targetB;
        uint16 m = uint16(bound(pick, 1000, 3000)); // the allowed markups from the 10% minimum: fees are priced on top
        vm.prank(creator);
        try b.configure(m, t) {} catch {}
    }

    /// Unlist a surplus Shape/pack prize (FWA reverts while draws are unsettled).
    function unlist(uint256 idx) external {
        uint256[] memory ids = b.getActiveIds();
        if (ids.length == 0) return;
        uint256 lid = ids[bound(idx, 0, ids.length - 1)];
        (uint8 kind,,,,) = b.items(lid);
        if (kind != 2) return;
        uint256[] memory one = new uint256[](1);
        one[0] = lid;
        vm.prank(creator);
        try b.unlistShapes(one) {} catch {}
    }
}

contract InvariantTest is ForkBase {
    Handler handler;
    uint256 constant MAX_PRIZE_WEIGHT = 1e36 / 0.01 ether;
    uint256 constant FILL_BPS = 7_000;

    function setUp() public {
        setUpFork();
        createBalancer(5 ether);
        configure(plan16([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0, 2, 1, 0, 1, 0, 0, 0]));
        listCurated(1, 0.3 ether);
        listCurated(2, 0.5 ether);
        listCurated(3, 0.8 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256 a = plan16([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0, 2, 1, 0, 1, 0, 0, 0]);
        uint256 bb = plan16([uint256(2), 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
        handler = new Handler(balancer, nft, creator, a, bb);
        targetContract(address(handler));
    }

    /// @dev Admission OK implies the gate conditions hold (idle enough, funded inventory, in-limits).
    function invariant_admissionImpliesGateConditions() public view {
        if (!balancer.canPurchase(buyer)) return;
        assertTrue(balancer.enabled());
        assertFalse(balancer.creatorWork());
        assertFalse(pool.tokenOfferEnabled());
        assertTrue(balancer.getActiveIds().length != _listedShapes(), "has a curated listing");
        assertLt(pool.unsettledAcquisitionCount(), 5, "below BUSY");
        assertLe(shapes.mintFee(), balancer.mintFeeCap());
        uint256 lost = (pool.lastIssuedSequence() - balancer.reconciledSequence()) * MAX_PRIZE_WEIGHT;
        uint256 w = balancer.prizeWeight();
        assertGe(w, lost, "weight above the unreconciled allowance");
        assertGe((w - lost) * 10_000, FILL_BPS * balancer.targetWeight(), "inventory at or above the fill floor");
    }

    /// The creator's unclaimed profit is always held, claims never exceed the balance, and the creator's share of the
    /// listed prices counts only Shape markups, each at most half its price (markup at most 100%).
    function invariant_profitHeldAndShareBounded() public view {
        uint256 bal = address(balancer).balance;
        assertLe(balancer.profit(), bal, "profit held");
        assertLe(balancer.withdrawableSurplus(), bal, "claims within the balance");
        assertLe(balancer.profitShareSum(), _listedShapes() * 5e17, "only Shape markups, at most half each price");
        if (!balancer.enabled()) assertEq(balancer.profit(), 0, "everything claimable while closed");
    }

    function _listedShapes() internal view returns (uint256 n) {
        uint16[16] memory a = balancer.getActiveShapes();
        for (uint256 d; d < 16; ++d) n += a[d];
    }

    function afterInvariant() public {
        emit log_named_uint("purchases admitted this run", handler.purchasesAdmitted());
        for (uint8 r; r < 7; ++r) {
            if (handler.closedReasons(r) != 0) emit log_named_uint(string.concat("closed reason ", vm.toString(r)), handler.closedReasons(r));
        }
    }

    /// Keepers are paid only for a call that reconciled a draw or listed a prize, at most MAX_KEEPER_REWARD each.
    function invariant_keeperPaidOnlyForWork() public view {
        assertEq(handler.paidWithoutWork(), 0);
        assertLe(handler.maxReward(), balancer.MAX_KEEPER_REWARD());
    }

    function invariant_permanentOwnershipAndOperator() public view {
        assertEq(pool.owner(), address(balancer));
        assertEq(pool.purchaseOperator(), address(balancer));
        assertFalse(pool.tokenOfferEnabled());
    }

    /// @dev Shapes and packs are only held inside a transaction (mint-then-list, withdraw-then-redeem).
    function invariant_noShapesHeldBetweenCalls() public view {
        (bool ok, bytes memory r) = SHAPES.staticcall(abi.encodeWithSignature("balanceOf(address)", address(balancer)));
        assertTrue(ok);
        assertEq(abi.decode(r, (uint256)), 0);
        (ok, r) = packs.staticcall(abi.encodeWithSignature("balanceOf(address)", address(balancer)));
        assertTrue(ok);
        assertEq(abi.decode(r, (uint256)), 0, "no pack held between calls");
    }

    /// @dev prizeWeight equals the sum of 1e36/backing over tracked Shape and pack prizes (DECISIONS 72).
    function invariant_prizeWeightMatchesTrackedPrizes() public view {
        uint256[] memory ids = balancer.getActiveIds();
        uint256 sum;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 denom,,,) = balancer.items(ids[i]);
            if (kind == 2) sum += 1e36 / balancer.denominationAmount(denom);
        }
        assertEq(sum, balancer.prizeWeight());
    }

    /// @dev When idle and fully reconciled, every tracked active id is an active FWA listing (staged listings, which
    ///      we track before FWA activates them, can only make our count the larger).
    function invariant_reconciledTrackingMatchesFWA() public view {
        if (pool.unsettledAcquisitionCount() != 0) return;
        if (pool.lastIssuedSequence() != balancer.reconciledSequence()) return;
        assertGe(balancer.getActiveIds().length, pool.activeListingCount());
    }
}

contract HandlerSmokeTest is InvariantTest {
    function test_handlerBuysAndSettles() public {
        handler.buy(1, 7);
        assertEq(handler.purchasesAdmitted(), 1);
        handler.fulfillAll(1);
        handler.upkeep();
        assertTrue(balancer.canPurchase(buyer));
    }
}
