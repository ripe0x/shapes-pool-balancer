// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoolBalancer} from "../../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../../src/BalancerFactory.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";

contract GasPriceForkTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;

    address creator = address(0xA11CE);
    address keeper = address(0xB0B);
    PoolBalancer bal;
    BalancerFactory factory;

    function setUp() public {
        vm.deal(creator, 1 ether);
        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        ShapePacks packs = new ShapePacks(SHAPES, address(renderer), address(this), "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        factory = new BalancerFactory(address(impl), address(this));
        vm.prank(creator);
        bal = PoolBalancer(payable(factory.createBalancer{value: 0.0117 ether}(bytes32("gas-price"))));
        vm.prank(creator);
        bal.configure(0, 1); // one 0.01 ETH Shape, cost 0.011 ETH at live mint fee
        vm.prank(creator);
        bal.open();
    }

    function testGasPriceZeroSimulationDiffersFromBid() public {
        vm.fee(block.number == 26382349 ? 57_954_497 : 739_866_638); // RPC block base fees
        assertEq(address(bal).balance, 0.0117 ether);
        uint256 snap = vm.snapshotState();
        vm.txGasPrice(0);
        vm.prank(keeper);
        uint256 simulatedReward = bal.performUpkeep();
        assertGt(simulatedReward, 0);
        assertEq(bal.getActiveIds().length, 1);

        vm.revertToState(snap);
        vm.txGasPrice(1 gwei);
        vm.prank(keeper);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        bal.performUpkeep();
        assertEq(bal.getActiveIds().length, 0);
    }

    function testRestrictedKeeperListStillLetsCreatorStock() public {
        factory.setKeepersRestricted(true);
        assertFalse(factory.canKeep(address(bal))); // the dashboard's simulation caller
        assertFalse(factory.canKeep(keeper));
        vm.txGasPrice(0);
        vm.prank(creator);
        uint256 reward = bal.performUpkeep();
        assertGt(reward, 0);
        assertEq(bal.getActiveIds().length, 1);
    }
}
