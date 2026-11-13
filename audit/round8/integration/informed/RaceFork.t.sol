// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {PoolBalancer} from "../../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../../src/BalancerFactory.sol";
import {IFWAPool, IERC721Min} from "../../../../src/interfaces/External.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";

contract RaceForkTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant BAYC = 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;
    address constant VRF_SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;

    address creator = 0x46EFbAedc92067E6d60E84ED6395099723252496;
    address keeper = address(0xB0B);
    address firstBuyer = address(0xC0FFEE);
    address secondBuyer = address(0xC0FFEF);
    PoolBalancer bal;
    IFWAPool pool;

    function setUp() public {
        vm.fee(block.number == 26382349 ? 57_954_497 : 739_866_638); // sampled block basefee; restock later at 5 gwei
        vm.txGasPrice(1 gwei);
        vm.deal(creator, 5 ether);
        vm.deal(firstBuyer, 1 ether);
        vm.deal(secondBuyer, 1 ether);
        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        ShapePacks packs = new ShapePacks(SHAPES, address(renderer), address(this), "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer implementation = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        BalancerFactory factory = new BalancerFactory(address(implementation), address(this));
        vm.prank(creator);
        bal = PoolBalancer(payable(factory.createBalancer{value: 1 ether}(bytes32("round8-race"))));
        pool = bal.pool();
        assertEq(IERC721Min(BAYC).ownerOf(1), creator);
        vm.prank(creator);
        IERC721Min(BAYC).approve(address(bal), 1);
        vm.prank(creator);
        bal.listCurated(BAYC, 1, 0.02 ether);
        vm.prank(creator);
        bal.configure(1_000, 5); // one lost Shape still leaves the 70% admission gate open
        vm.prank(creator);
        bal.open();
        vm.prank(keeper);
        bal.performUpkeep();
        assertEq(bal.admissionStatus(), 0);
        assertEq(pool.activeListingCount(), 6);
    }

    function testKeeperRestockInvalidatesPlayerQuote() public {
        (uint256 firstFee,, uint256 firstTotal) = pool.quoteAcquisitionPrice(1);
        vm.prank(firstBuyer);
        uint256 requestId = pool.acquire{value: firstTotal}(
            firstBuyer, firstFee, 0, 10_000, pool.inventoryVersion(), block.timestamp + 1 hours
        );
        uint256[] memory words = new uint256[](1);
        words[0] = 60 ether;
        vm.prank(VRF_SERVICE); // only allowed protocol-address impersonation: deliver VRF words
        pool.rawFulfillRandomWords(requestId, words);
        pool.processAcquisitions(1);
        (,,, uint256 wonListing, uint8 status,) = pool.acquisitions(requestId);
        assertEq(status, 2);
        (address wonCollection,,,,,,,) = pool.listings(wonListing);
        assertEq(wonCollection, SHAPES);
        assertEq(bal.admissionStatus(), 0);

        (uint256 staleFee,,) = pool.quoteAcquisitionPrice(1);
        uint256 staleVersion = pool.inventoryVersion();
        uint256 activeBefore = pool.activeListingCount();
        vm.fee(5 gwei);
        vm.txGasPrice(5 gwei);
        vm.prank(keeper);
        bal.performUpkeep();
        uint256 freshVersion = pool.inventoryVersion();
        (uint256 freshFee,, uint256 freshTotal) = pool.quoteAcquisitionPrice(1);
        console.log("staleVersion", staleVersion);
        console.log("freshVersion", freshVersion);
        console.log("staleFee", staleFee);
        console.log("freshFee", freshFee);
        console.log("activeBefore", activeBefore);
        console.log("activeAfter", pool.activeListingCount());
        assertGt(freshVersion, staleVersion);
        assertGt(pool.activeListingCount(), activeBefore);
        assertGt(freshFee, staleFee);

        uint256 before = secondBuyer.balance;
        vm.prank(secondBuyer);
        vm.expectRevert(abi.encodeWithSignature("InventoryVersionMismatch(uint256,uint256)", staleVersion, freshVersion));
        pool.acquire{value: freshTotal}(secondBuyer, freshFee, 0, 10_000, staleVersion, block.timestamp + 1 hours);
        assertEq(secondBuyer.balance, before);
        assertEq(pool.unsettledAcquisitionCount(), 0);

        vm.prank(secondBuyer);
        vm.expectRevert(bytes4(keccak256("AcquisitionFeeTooHigh()")));
        pool.acquire{value: freshTotal}(secondBuyer, staleFee, 0, 10_000, freshVersion, block.timestamp + 1 hours);
        assertEq(secondBuyer.balance, before);
        assertEq(pool.unsettledAcquisitionCount(), 0);

        vm.prank(secondBuyer);
        uint256 accepted = pool.acquire{value: freshTotal}(
            secondBuyer, freshFee, 0, 10_000, freshVersion, block.timestamp + 1 hours
        );
        assertGt(accepted, 0);
        assertEq(secondBuyer.balance, before - freshTotal);
        assertEq(pool.unsettledAcquisitionCount(), 1);
    }
}
