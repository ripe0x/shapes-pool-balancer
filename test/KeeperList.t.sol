// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {Vm} from "forge-std/Test.sol";
import {BalancerFactory} from "../src/BalancerFactory.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {ListOne} from "./utils/ListOne.sol";

using ListOne for PoolBalancer;

/// @notice The factory's keeper list, on a mainnet fork (real FWA + Shapes).
contract KeeperListTest is ForkBase {
    function setUp() public {
        setUpFork();
        createBalancer(5 ether);
        configure(plan([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0]));
        listCurated(1, 0.3 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertTrue(balancer.canPurchase(buyer));
    }

    function _drawOneShape() internal {
        uint256[] memory active = balancer.getActiveIds();
        uint256 last;
        for (uint256 i; i < active.length; ++i) {
            (uint8 kind,,,,) = balancer.items(active[i]);
            if (kind == 2 && active[i] > last) last = active[i];
        }
        (,,,,,, uint256 slot,) = pool.listings(last);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
    }

    function _paidUpkeep(address who) internal returns (uint256 reward) {
        bytes32 uh1 = balancer.settingsHash();
        vm.recordLogs();
        vm.prank(who, who);
        balancer.performUpkeep(uh1, 0, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("KeeperPaid(address,uint256,uint256)")) {
                (reward,) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
    }

    /// The keeper list lives on the factory and covers every Balancer it deployed: open by default; while restricted,
    /// only approved keepers and each pool's own creator may run upkeep, under the same reward rules. Only the keeper
    /// admin changes it, and that role moves in two steps.
    function test_factoryKeeperListCoversEveryPoolAndIsOpenByDefault() public {
        assertFalse(factory.keepersRestricted(), "open by default");
        assertEq(factory.keeperAdmin(), keeperAdmin);
        vm.startPrank(creator);
        vm.expectRevert(BalancerFactory.Unauthorized.selector);
        factory.setKeepersRestricted(true);
        vm.expectRevert(BalancerFactory.Unauthorized.selector);
        factory.setKeeperApproved(creator, true);
        vm.stopPrank();

        _drawOneShape();
        vm.prank(keeperAdmin);
        factory.setKeepersRestricted(true);
        bytes32 uh2 = balancer.settingsHash();
        vm.prank(stranger, stranger);
        vm.expectRevert(PoolBalancer.KeeperNotApproved.selector);
        balancer.performUpkeep(uh2, 0, 0);
        vm.prank(keeperAdmin);
        factory.setKeeperApproved(keeper, true);
        uint256 reward = _paidUpkeep(keeper);
        assertGt(reward, 0, "an approved keeper is paid as usual");

        _drawOneShape();
        vm.prank(keeperAdmin);
        factory.setKeeperApproved(keeper, false);
        bytes32 uh3 = balancer.settingsHash();
        vm.prank(keeper, keeper);
        vm.expectRevert(PoolBalancer.KeeperNotApproved.selector);
        balancer.performUpkeep(uh3, 0, 0);
        bytes32 uh4 = balancer.settingsHash();
        vm.prank(creator, creator);
        balancer.performUpkeep(uh4, 0, 0); // a pool's creator always can
    }

    /// The keeper admin role moves only when the new admin accepts; the new admin can reopen upkeep to anyone.
    function test_keeperAdminTransferIsTwoStep() public {
        vm.prank(keeperAdmin);
        factory.transferKeeperAdmin(stranger);
        vm.prank(keeperAdmin);
        factory.setKeepersRestricted(true); // still the admin until accepted
        vm.prank(creator);
        vm.expectRevert(BalancerFactory.Unauthorized.selector);
        factory.acceptKeeperAdmin();
        vm.prank(stranger);
        factory.acceptKeeperAdmin();
        vm.prank(keeperAdmin);
        vm.expectRevert(BalancerFactory.Unauthorized.selector);
        factory.setKeepersRestricted(false);

        _drawOneShape();
        vm.prank(stranger);
        factory.setKeepersRestricted(false);
        bytes32 uh5 = balancer.settingsHash();
        vm.prank(keeper, keeper);
        balancer.performUpkeep(uh5, 0, 0); // open again: anyone
    }

    /// One switch on the factory restricts every pool it deployed: a second creator's pool follows the same list.
    function test_oneListCoversEveryPool() public {
        PoolBalancer first = balancer;
        address other = makeAddr("other");
        vm.deal(other, 100 ether);
        vm.prank(other);
        PoolBalancer second = _createFixture(other, bytes32(uint256(9)), 5 ether);
        vm.startPrank(other);
        second.configure(1500, plan([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0]));
        nft.mint(other, 777);
        nft.approve(address(second), 777);
        second.listCurated(address(nft), 777, 0.3 ether);
        second.open();
        vm.stopPrank();
        balancer = second;
        pool = second.pool();
        fillUp();

        vm.prank(keeperAdmin);
        factory.setKeepersRestricted(true);
        _drawOneShape();
        bytes32 uh6 = second.settingsHash();
        vm.prank(stranger, stranger);
        vm.expectRevert(PoolBalancer.KeeperNotApproved.selector);
        second.performUpkeep(uh6, 0, 0);
        vm.prank(keeperAdmin);
        factory.setKeeperApproved(keeper, true);
        bytes32 uh7 = second.settingsHash();
        vm.prank(keeper, keeper);
        second.performUpkeep(uh7, 0, 0);

        balancer = first;
        pool = first.pool();
        _drawOneShape();
        bytes32 uh8 = first.settingsHash();
        vm.prank(stranger, stranger);
        vm.expectRevert(PoolBalancer.KeeperNotApproved.selector);
        first.performUpkeep(uh8, 0, 0);
        bytes32 uh9 = first.settingsHash();
        vm.prank(keeper, keeper);
        first.performUpkeep(uh9, 0, 0);
    }
}
