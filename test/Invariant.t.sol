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
    uint256[] public open;
    uint256 nextNft = 1000;
    uint256 public purchasesAdmitted;
    mapping(uint8 => uint256) public closedReasons;

    constructor(PoolBalancer b_, MockNFT nft_, address creator_) {
        b = b_;
        pool = b_.pool();
        nft = nft_;
        creator = creator_;
    }

    function buy(uint256 count, uint256 who) external {
        count = bound(count, 1, 5);
        address buyer = address(uint160(bound(who, 1, 50)) + 0x1000);
        bool allowed = b.canPurchase(buyer);
        if (!allowed) {
            ++closedReasons[b.admissionStatus()];
            return;
        }
        (,, uint256 total) = pool.quoteAcquisitionPrice(count);
        vm.deal(buyer, total);
        uint256 v = pool.inventoryVersion();
        vm.prank(buyer, buyer);
        uint256[] memory ids = pool.acquireBatch{value: total}(buyer, count, 0, 0, 10_000, v, block.timestamp + 1);
        for (uint256 i; i < ids.length; ++i) {
            open.push(ids[i]);
        }
        ++purchasesAdmitted;
        // a second purchase in the same state must be rejected
        assertFalse(b.canPurchase(buyer), "admission must close after any batch");
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
        try b.performUpkeep() {} catch {}
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
}

contract InvariantTest is ForkBase {
    Handler handler;

    function setUp() public {
        setUpFork();
        createBalancer(5 ether);
        listCurated(1, 0.3 ether);
        listCurated(2, 0.5 ether);
        listCurated(3, 0.8 ether);
        uint256[] memory plans = new uint256[](2);
        plans[0] = plan([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0]);
        plans[1] = plan([uint256(2), 1, 1, 0, 0, 0, 0, 0, 0]);
        configure(0.05 ether, 50, plans);
        vm.prank(creator);
        balancer.open();
        fillUp();
        handler = new Handler(balancer, nft, creator);
        targetContract(address(handler));
    }

    /// @dev Admission implies an exactly reconciled, funded, in-limits inventory.
    function invariant_admissionImpliesSafeState() public view {
        if (!balancer.canPurchase(buyer)) return;
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(pool.lastIssuedSequence(), balancer.reconciledSequence());
        assertFalse(pool.tokenOfferEnabled());
        (bool valid,,,, uint256 reserve) = balancer.checkpoint();
        assertTrue(valid);
        assertGe(address(balancer).balance, reserve);
        (uint128 maxDrawPrice,,) = balancer.config();
        assertLe(pool.acquisitionFee(), maxDrawPrice);
        // tracked active set equals FWA's active set
        assertEq(balancer.getActiveIds().length, pool.activeListingCount());
        // shapes inventory equals the active plan
        uint256 p = balancer.getPlans()[balancer.activePlan()];
        uint16[9] memory active = balancer.getActiveShapes();
        for (uint256 d; d < 9; ++d) {
            assertEq(active[d], (p >> (16 * d)) & 0xFFFF);
        }
    }

    function afterInvariant() public {
        emit log_named_uint("purchases admitted this run", handler.purchasesAdmitted());
        for (uint8 r; r < 14; ++r) {
            if (handler.closedReasons(r) != 0) emit log_named_uint(string.concat("closed reason ", vm.toString(r)), handler.closedReasons(r));
        }
    }

    function invariant_permanentOwnershipAndOperator() public view {
        assertEq(pool.owner(), address(balancer));
        assertEq(pool.purchaseOperator(), address(balancer));
        assertFalse(pool.tokenOfferEnabled());
    }

    /// @dev Shapes are only held inside a transaction (mint-then-list, withdraw-then-redeem).
    function invariant_noShapesHeldBetweenCalls() public view {
        (bool ok, bytes memory r) = SHAPES.staticcall(abi.encodeWithSignature("balanceOf(address)", address(balancer)));
        assertTrue(ok);
        assertEq(abi.decode(r, (uint256)), 0);
    }

    /// @dev Whenever reconciled, the tracked active set matches FWA exactly.
    function invariant_reconciledTrackingMatchesFWA() public view {
        if (pool.unsettledAcquisitionCount() != 0) return;
        if (pool.lastIssuedSequence() != balancer.reconciledSequence()) return;
        assertEq(balancer.getActiveIds().length, pool.activeListingCount());
    }
}

contract HandlerSmokeTest is InvariantTest {
    function test_handlerBuys() public {
        handler.buy(3, 7);
        assertEq(handler.purchasesAdmitted(), 1);
        handler.fulfillAll(1);
        handler.upkeep();
        assertTrue(balancer.canPurchase(buyer));
    }
}
