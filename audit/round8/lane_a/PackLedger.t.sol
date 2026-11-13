// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../src/BalancerFactory.sol";
import {IFWAPool, IERC721Min, IShapes} from "../../../src/interfaces/External.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";

interface IShapesLedger {
    function pendingFees() external view returns (uint256);
    function redeemableBacking() external view returns (uint256);
    function redeem(uint256 tokenId) external;
}

contract KeeperProbe {
    PoolBalancer internal balancer;
    uint256 public beforeBasefee;
    uint256 public duringBasefee;
    uint256 public afterBasefee;
    uint256 public beforeRestock;
    uint256 public duringRestock;
    uint256 public afterRestock;

    function run(PoolBalancer b) external {
        balancer = b;
        beforeBasefee = block.basefee;
        beforeRestock = b.restockFee();
        b.performUpkeep();
        afterBasefee = block.basefee;
        afterRestock = b.restockFee();
    }

    receive() external payable {
        duringBasefee = block.basefee;
        duringRestock = balancer.restockFee();
    }
}

contract PackLedgerTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant BAYC = 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;

    function testPackListingFeeCustodyAndUnlistRedemption() public {
        vm.fee(block.basefee);
        vm.txGasPrice(1 gwei);
        console2.log("fork block", block.number);
        address creator = IERC721Min(BAYC).ownerOf(1);
        assertEq(creator.code.length, 0);
        vm.deal(creator, 3 ether);
        uint256 fee = IShapes(SHAPES).mintFee();
        uint256 oldFees = IShapesLedger(SHAPES).pendingFees();
        uint256 oldBacking = IShapesLedger(SHAPES).redeemableBacking();

        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        ShapePacks packs = new ShapePacks(SHAPES, address(renderer), address(this), "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        BalancerFactory factory = new BalancerFactory(address(impl), address(this));

        vm.startPrank(creator);
        PoolBalancer balancer = PoolBalancer(payable(factory.createBalancer{value: 1 ether}(bytes32(uint256(2)))));
        IERC721Min(BAYC).approve(address(balancer), 1);
        balancer.listCurated(BAYC, 1, 1 ether);
        balancer.configure(2_000, 1 << (16 * 9)); // One 0.02 ETH Draw Pack with 20% markup.
        balancer.open();
        uint256 restockBefore = balancer.restockFee();
        console2.log("basefee before upkeep", block.basefee);
        console2.log("restock before upkeep", restockBefore);
        KeeperProbe probe = new KeeperProbe();
        probe.run(balancer);
        console2.log("probe before basefee", probe.beforeBasefee());
        console2.log("probe during basefee", probe.duringBasefee());
        console2.log("probe after basefee", probe.afterBasefee());
        console2.log("probe before restock", probe.beforeRestock());
        console2.log("probe during restock", probe.duringRestock());
        console2.log("probe after restock", probe.afterRestock());
        console2.log("basefee after upkeep", block.basefee);

        uint256[] memory ids = balancer.getActiveIds();
        assertEq(ids.length, 2);
        uint256 lid = ids[1];
        (uint8 kind, uint8 denom, uint8 state, uint112 base, uint112 price) = balancer.items(lid);
        assertEq(kind, 2);
        assertEq(denom, 9);
        assertEq(state, 1);
        uint256 restock = balancer.restockFee();
        console2.log("restock after upkeep", restock);
        assertEq(uint256(base), 0.02 ether + 2 * fee + 0.004 ether);
        assertEq(uint256(price), uint256(base) + 2 * restock);

        IFWAPool pool = balancer.pool();
        (,,, uint256 packId,, uint256 listedPrice,,) = pool.listings(lid);
        assertEq(listedPrice, price);
        assertEq(packs.ownerOf(packId), address(pool));
        assertEq(packs.valueOf(packId), 0.02 ether);
        uint256[] memory shapeIds = packs.contentsOf(packId);
        assertEq(shapeIds.length, 2);
        uint256 tokenBacking;
        for (uint256 i; i < 2; ++i) {
            assertEq(IShapes(SHAPES).ownerOf(shapeIds[i]), address(packs));
            tokenBacking += IShapes(SHAPES).backingOf(shapeIds[i]);
        }
        assertEq(tokenBacking, 0.02 ether);
        assertEq(IShapesLedger(SHAPES).pendingFees() - oldFees, 2 * fee);
        assertEq(IShapesLedger(SHAPES).redeemableBacking() - oldBacking, 0.02 ether);

        // The pool's blanket Shape approval must not let an outsider list a preexisting Balancer-held Shape.
        address outsider = address(0xBEEF);
        vm.deal(outsider, 0.1 ether);
        vm.stopPrank();
        vm.startPrank(outsider);
        uint256 outsiderShape = IShapes(SHAPES).mintBatch{value: 0.01 ether + fee}(0.01 ether, 1);
        IERC721Min(SHAPES).transferFrom(outsider, address(balancer), outsiderShape);
        vm.expectRevert(bytes4(keccak256("OwnerOnlyInventory()")));
        pool.listNFT(SHAPES, outsiderShape, 0.1 ether);
        assertEq(IShapes(SHAPES).ownerOf(outsiderShape), address(balancer));
        vm.stopPrank();
        vm.startPrank(creator);
        balancer.recoverUntrackedNFT(SHAPES, outsiderShape, creator);
        assertEq(IShapes(SHAPES).ownerOf(outsiderShape), creator);
        IShapesLedger(SHAPES).redeem(outsiderShape);

        balancer.close();
        uint256 beforeUnlist = address(balancer).balance;
        uint256[] memory remove = new uint256[](1);
        remove[0] = lid;
        balancer.unlistShapes(remove);
        assertEq(address(balancer).balance - beforeUnlist, 0.02 ether);
        assertEq(IShapesLedger(SHAPES).redeemableBacking(), oldBacking);
        assertEq(packs.totalSupply(), 0);
        assertEq(balancer.getActiveShapes()[9], 0);

        balancer.withdrawCurated(ids[0], creator);
        uint256 allLiquid = address(balancer).balance;
        balancer.claimSurplus(allLiquid, creator);
        assertEq(address(balancer).balance, 0);
        assertEq(IERC721Min(BAYC).ownerOf(1), creator);
        vm.stopPrank();
    }
}
