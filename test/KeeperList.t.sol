// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {Vm} from "forge-std/Test.sol";
import {BalancerFactory} from "../src/BalancerFactory.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";

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
        vm.recordLogs();
        vm.prank(who, who);
        balancer.performUpkeep();
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
        vm.prank(stranger, stranger);
        vm.expectRevert(PoolBalancer.KeeperNotApproved.selector);
        balancer.performUpkeep();
        vm.prank(keeperAdmin);
        factory.setKeeperApproved(keeper, true);
        uint256 reward = _paidUpkeep(keeper);
        assertGt(reward, 0, "an approved keeper is paid as usual");

        _drawOneShape();
        vm.prank(keeperAdmin);
        factory.setKeeperApproved(keeper, false);
        vm.prank(keeper, keeper);
        vm.expectRevert(PoolBalancer.KeeperNotApproved.selector);
        balancer.performUpkeep();
        vm.prank(creator, creator);
        balancer.performUpkeep(); // a pool's creator always can
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
        vm.prank(keeper, keeper);
        balancer.performUpkeep(); // open again: anyone
    }

    /// One switch on the factory restricts every pool it deployed: a second creator's pool follows the same list.
    function test_oneListCoversEveryPool() public {
        PoolBalancer first = balancer;
        address other = makeAddr("other");
        vm.deal(other, 100 ether);
        vm.prank(other);
        PoolBalancer second = PoolBalancer(payable(factory.createBalancer{value: 5 ether}(bytes32(uint256(9)))));
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
        vm.prank(stranger, stranger);
        vm.expectRevert(PoolBalancer.KeeperNotApproved.selector);
        second.performUpkeep();
        vm.prank(keeperAdmin);
        factory.setKeeperApproved(keeper, true);
        vm.prank(keeper, keeper);
        second.performUpkeep();

        balancer = first;
        pool = first.pool();
        _drawOneShape();
        vm.prank(stranger, stranger);
        vm.expectRevert(PoolBalancer.KeeperNotApproved.selector);
        first.performUpkeep();
        vm.prank(keeper, keeper);
        first.performUpkeep();
    }
}
