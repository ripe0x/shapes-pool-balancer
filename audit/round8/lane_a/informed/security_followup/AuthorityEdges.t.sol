// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {PoolBalancer} from "../../../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../../../src/BalancerFactory.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";

contract AuthorityEdgesInformedTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant CREATOR = address(0xC0);
    address constant NEW_CREATOR = address(0xC1);
    address constant ADMIN = address(0xAD);
    address constant PENDING_A = address(0xA1);
    address constant ADMIN_B = address(0xA2);
    address constant KEEPER = address(0xBEEF);

    PoolBalancer balancer;
    BalancerFactory factory;

    function setUp() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.05 gwei);
        assertEq(CREATOR.code.length, 0);
        assertEq(NEW_CREATOR.code.length, 0);
        assertEq(ADMIN.code.length, 0);
        assertEq(PENDING_A.code.length, 0);
        assertEq(ADMIN_B.code.length, 0);
        assertEq(KEEPER.code.length, 0);
        vm.deal(CREATOR, 2 ether);
        vm.deal(KEEPER, 1 ether);
        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        ShapePacks packs = new ShapePacks(SHAPES, address(renderer), CREATOR, "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        factory = new BalancerFactory(address(impl), ADMIN);
        vm.prank(CREATOR);
        balancer = PoolBalancer(payable(factory.createBalancer{value: 1 ether}(bytes32(uint256(982)))));
        vm.startPrank(CREATOR);
        balancer.configure(0, 1);
        balancer.open();
        vm.stopPrank();
    }

    function testOverwrittenPendingRolesAndCreatorUpkeepBypass() public {
        vm.prank(ADMIN);
        factory.transferKeeperAdmin(PENDING_A);
        vm.prank(PENDING_A);
        vm.expectRevert(BalancerFactory.Unauthorized.selector);
        factory.setKeepersRestricted(true);
        vm.prank(ADMIN);
        factory.transferKeeperAdmin(ADMIN_B);
        vm.prank(PENDING_A);
        vm.expectRevert(BalancerFactory.Unauthorized.selector);
        factory.acceptKeeperAdmin();
        assertEq(factory.keeperAdmin(), ADMIN);
        vm.prank(ADMIN_B);
        factory.acceptKeeperAdmin();
        assertEq(factory.keeperAdmin(), ADMIN_B);
        vm.prank(ADMIN);
        vm.expectRevert(BalancerFactory.Unauthorized.selector);
        factory.setKeepersRestricted(true);
        vm.prank(ADMIN_B);
        factory.setKeepersRestricted(true);
        vm.prank(KEEPER);
        vm.expectRevert(PoolBalancer.KeeperNotApproved.selector);
        balancer.performUpkeep();
        vm.prank(CREATOR);
        uint256 creatorReward = balancer.performUpkeep();
        assertGt(creatorReward, 0);
        assertEq(balancer.getActiveShapes()[0], 1);

        vm.prank(CREATOR);
        balancer.transferCreator(address(0));
        assertEq(balancer.creator(), CREATOR);
        assertEq(balancer.pendingCreator(), address(0));
        vm.prank(PENDING_A);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.acceptCreator();
        vm.prank(CREATOR);
        balancer.transferCreator(PENDING_A);
        vm.prank(CREATOR);
        balancer.transferCreator(NEW_CREATOR);
        vm.prank(PENDING_A);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.acceptCreator();
        vm.prank(NEW_CREATOR);
        balancer.acceptCreator();
        assertEq(balancer.creator(), NEW_CREATOR);
        vm.prank(CREATOR);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.claimSurplus(0, CREATOR);
        vm.prank(ADMIN_B);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.close();

        uint256[] memory ids = balancer.getActiveIds();
        assertEq(ids.length, 1);
        vm.prank(NEW_CREATOR);
        balancer.unlistShapes(ids);
        assertTrue(balancer.creatorWork());
        vm.prank(ADMIN_B);
        factory.setKeeperApproved(KEEPER, true);
        uint256 keeperBefore = KEEPER.balance;
        vm.prank(KEEPER);
        uint256 keeperReward = balancer.performUpkeep();
        assertGt(keeperReward, 0);
        assertEq(KEEPER.balance - keeperBefore, keeperReward);
        assertEq(balancer.getActiveShapes()[0], 1);

        vm.prank(NEW_CREATOR);
        balancer.close();
        uint256 finalLiquid = address(balancer).balance;
        vm.prank(NEW_CREATOR);
        balancer.claimSurplus(finalLiquid, NEW_CREATOR);
        assertEq(address(balancer).balance, 0);
        console2.log("creator setup reward wei", creatorReward);
        console2.log("approved keeper reward wei", keeperReward);
        console2.log("new creator liquid exit wei", finalLiquid);
    }
}
