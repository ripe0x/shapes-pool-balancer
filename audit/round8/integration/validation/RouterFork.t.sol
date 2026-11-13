// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {PoolBalancer} from "../../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../../src/BalancerFactory.sol";
import {IFWAPool, IERC721Min} from "../../../../src/interfaces/External.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";

interface IVRFService {
    function coordinator() external view returns (address);
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata words) external;
}

contract RouterForkTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant BAYC = 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;
    address constant VRF_SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;
    address constant COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;

    address creator = 0x46EFbAedc92067E6d60E84ED6395099723252496;
    address keeper = address(0xB0B);
    address player = address(0xC0FFEE);
    PoolBalancer bal;
    IFWAPool pool;
    IVRFService service = IVRFService(VRF_SERVICE);

    function setUp() public {
        vm.fee(57_954_497); // pinned block basefee
        vm.txGasPrice(1 gwei); // exercise nonzero VRF service fee bookkeeping
        vm.deal(creator, 5 ether); // external EOA wallet setup
        vm.deal(player, 5 ether); // external EOA wallet setup
        assertEq(service.coordinator(), COORDINATOR);
        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        ShapePacks packs = new ShapePacks(SHAPES, address(renderer), address(this), "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer implementation = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        BalancerFactory factory = new BalancerFactory(address(implementation), address(this));
        vm.prank(creator);
        bal = PoolBalancer(payable(factory.createBalancer{value: 1 ether}(bytes32("router-validation"))));
        pool = bal.pool();
        assertEq(IERC721Min(BAYC).ownerOf(1), creator);
        vm.prank(creator);
        IERC721Min(BAYC).approve(address(bal), 1);
        vm.prank(creator);
        bal.listCurated(BAYC, 1, 0.02 ether);
        vm.prank(creator);
        bal.configure(1000, 5);
        vm.prank(creator);
        bal.open();
        vm.prank(keeper);
        bal.performUpkeep();
        assertEq(pool.activeListingCount(), 6);
        assertEq(bal.admissionStatus(), 0);
    }

    function testCoordinatorDeliveryThroughServiceThenAnotherPurchase() public {
        (uint256 fee, uint256 vrf, uint256 total) = pool.quoteAcquisitionPrice(1);
        assertGt(vrf, 0);
        assertEq(total, fee + vrf);
        uint256 version = pool.inventoryVersion();
        uint256 playerBefore = player.balance;
        vm.prank(player, player);
        uint256 requestId = pool.acquire{value: total}(player, fee, 0, 10_000, version, block.timestamp + 1 hours);
        assertLt(player.balance, playerBefore);
        assertEq(pool.requestIdAtSequence(1), requestId);
        assertEq(pool.unsettledAcquisitionCount(), 1);
        (,,,, uint8 pendingStatus,) = pool.acquisitions(requestId);
        assertEq(pendingStatus, 1);

        uint256[] memory words = new uint256[](1);
        words[0] = 60 ether;
        vm.recordLogs();
        vm.prank(COORDINATOR); // allowed exception: actual coordinator delivers the words
        service.rawFulfillRandomWords(requestId, words);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 serviceEvents;
        bool deliveredEvent;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != VRF_SERVICE) continue;
            ++serviceEvents;
            if (logs[i].topics[0] == keccak256("RandomnessDelivered(uint256,address)")) deliveredEvent = true;
        }
        emit log_named_uint("serviceEvents", serviceEvents);
        assertTrue(deliveredEvent);
        (,,, uint256 wonListing, uint8 deliveredStatus,) = pool.acquisitions(requestId);
        assertEq(deliveredStatus, 2); // FWA fulfillment through service
        assertGt(wonListing, 0);
        assertEq(pool.unsettledAcquisitionCount(), 0);
        vm.recordLogs();
        vm.prank(COORDINATOR);
        service.rawFulfillRandomWords(requestId, words); // live router treats duplicate delivery as a no-op
        Vm.Log[] memory duplicateLogs = vm.getRecordedLogs();
        assertEq(duplicateLogs.length, 1);
        assertEq(duplicateLogs[0].emitter, VRF_SERVICE);
        (,,,, uint8 stillDelivered,) = pool.acquisitions(requestId);
        assertEq(stillDelivered, 2);
        pool.processAcquisitions(1);
        vm.prank(keeper);
        bal.performUpkeep();
        assertEq(bal.reconciledSequence(), 1);
        assertEq(bal.admissionStatus(), 0);

        (uint256 secondFee,, uint256 secondTotal) = pool.quoteAcquisitionPrice(1);
        uint256 secondVersion = pool.inventoryVersion();
        uint256 beforeSecond = player.balance;
        vm.prank(player, player);
        uint256 secondId = pool.acquire{value: secondTotal}(player, secondFee, 0, 10_000, secondVersion, block.timestamp + 1 hours);
        assertLt(player.balance, beforeSecond);
        assertTrue(secondId != requestId); // Chainlink IDs are hashes, not monotonic counters
        assertEq(pool.unsettledAcquisitionCount(), 1);
        emit log_named_uint("firstRequest", requestId);
        emit log_named_uint("secondRequest", secondId);
    }
}
