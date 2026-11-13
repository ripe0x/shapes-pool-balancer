// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../src/BalancerFactory.sol";
import {IFWAPool, IERC721Min} from "../../../src/interfaces/External.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";
import {LibClone} from "solady/utils/LibClone.sol";

contract ReserveReopenTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant BAYC = 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;

    function testCloseDrainReopenAdmitsWithReserveDeficit() public {
        vm.fee(block.basefee); // Carry the fork block's basefee into nested stateful calls.
        vm.txGasPrice(1 gwei);
        console2.log("fork block", block.number);
        address creator = IERC721Min(BAYC).ownerOf(1);
        assertEq(creator.code.length, 0, "creator is external EOA on fork");
        vm.deal(creator, 103 ether);

        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        ShapePacks packs = new ShapePacks(SHAPES, address(renderer), address(this), "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        assertEq(impl.creator(), address(1), "implementation is locked");
        vm.expectRevert(PoolBalancer.AlreadyInitialized.selector);
        impl.initialize(address(this));
        BalancerFactory factory = new BalancerFactory(address(impl), address(this));

        vm.startPrank(creator);
        PoolBalancer balancer = PoolBalancer(payable(factory.createBalancer{value: 101 ether}(bytes32(uint256(1)))));
        IERC721Min(BAYC).approve(address(balancer), 1);
        balancer.listCurated(BAYC, 1, 1 ether);
        address outsider = IERC721Min(BAYC).ownerOf(2);
        assertTrue(outsider != creator && outsider.code.length == 0, "second BAYC has distinct EOA owner");
        IFWAPool poolBefore = balancer.pool();
        vm.stopPrank();
        vm.prank(outsider);
        IERC721Min(BAYC).approve(address(poolBefore), 2);
        vm.startPrank(outsider);
        vm.expectRevert();
        poolBefore.listNFT(BAYC, 2, 1 ether);
        assertEq(IERC721Min(BAYC).ownerOf(2), outsider, "outsider token stayed with outsider");
        vm.stopPrank();
        vm.startPrank(creator);
        balancer.configure(0, 1 << (16 * 8)); // One 100 ETH Shape.
        balancer.open();
        balancer.performUpkeep();
        assertEq(balancer.getActiveShapes()[8], 1, "stocked one 100 ETH Shape");
        assertEq(balancer.admissionStatus(), 0, "admitted when funded");

        balancer.close();
        uint256 liquid = address(balancer).balance;
        balancer.claimSurplus(liquid, creator);
        assertEq(address(balancer).balance, 0, "drained when closed");

        balancer.open();
        assertGt(balancer.requiredReserve(), 0, "reserve still needed");
        assertEq(address(balancer).balance, 0, "reserve absent");
        assertEq(balancer.admissionStatus(), 0, "gate admits without reserve");
        assertTrue(balancer.canPurchase(address(0xBEEF)), "FWA operator also admits");
        vm.stopPrank();

        IFWAPool pool = balancer.pool();
        (uint256 fee,, uint256 total) = pool.quoteAcquisitionPrice(1);
        assertLt(total, 5 ether, "draw costs far less than largest prize");
        console2.log("reserve wei", balancer.requiredReserve());
        console2.log("draw payment wei", total);
        address player = address(0xBEEF);
        vm.deal(player, total + 1 ether);
        uint256 version = pool.inventoryVersion();
        vm.prank(player);
        uint256 requestId = pool.acquire{value: total}(player, fee, 0, 10_000, version, block.timestamp + 1 hours);
        assertEq(pool.unsettledAcquisitionCount(), 1, "real FWA accepted purchase");
        uint256[] memory word = new uint256[](1);
        vm.prank(player);
        vm.expectRevert();
        pool.rawFulfillRandomWords(requestId, word);

        // Factory admin can censor outside keepers, but cannot move this pool's assets.
        factory.setKeepersRestricted(true);
        assertFalse(factory.canKeep(outsider));
        vm.prank(outsider);
        vm.expectRevert(PoolBalancer.KeeperNotApproved.selector);
        balancer.performUpkeep();
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.claimSurplus(0, address(this));

        // Both ownership transfers require acceptance; page approvals end at the creator handoff.
        vm.prank(creator);
        bytes32 digest = balancer.approvePoolPage("2026-11-10T12:34:56.789Z", keccak256("page"));
        assertEq(balancer.isValidSignature(digest, ""), bytes4(0x1626ba7e));
        vm.prank(creator);
        balancer.transferCreator(player);
        vm.prank(player);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.configure(0, 1);
        vm.prank(player);
        balancer.acceptCreator();
        assertEq(balancer.creator(), player);
        assertEq(balancer.isValidSignature(digest, ""), bytes4(0xffffffff));
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.close();

        factory.transferKeeperAdmin(outsider);
        assertEq(factory.keeperAdmin(), address(this), "old admin remains until acceptance");
        vm.prank(outsider);
        factory.acceptKeeperAdmin();
        assertEq(factory.keeperAdmin(), outsider);
        vm.expectRevert(BalancerFactory.Unauthorized.selector);
        factory.setKeepersRestricted(false);

        // An outside clone can initialize, but it is absent from the official factory registry.
        address outsideAddress = LibClone.clone(address(impl));
        PoolBalancer outside = PoolBalancer(payable(outsideAddress));
        address outsideCreator = address(0xCAFE);
        vm.prank(outsideCreator);
        outside.initialize(outsideCreator);
        assertEq(outside.creator(), outsideCreator);
        assertEq(address(outside.factory()), outsideCreator);
        assertFalse(factory.isBalancer(outsideAddress));
    }
}
