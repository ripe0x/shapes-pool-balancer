// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {PoolBalancer} from "../../../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../../../src/BalancerFactory.sol";
import {IFWAPool, IShapes, IERC721Min} from "../../../../../src/interfaces/External.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";

interface IShapesAccounting {
    function pendingFees() external view returns (uint256);
    function redeemableBacking() external view returns (uint256);
}

contract ShapeLifecycleFuzzInformedTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant BAYC = 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;
    address constant KEEPER = address(0xBEEF);

    function testFuzzRealShapeMintListCloseUnlistBacking(
        uint8 rawDenom,
        uint8 rawCount,
        uint16 rawMarkup,
        uint8 rawCapital,
        uint8 rawBasefee
    ) public {
        uint8 denom = rawDenom % 4; // 0.01, 0.05, 0.1 and 0.5 ETH real Shapes.
        uint256 count = 1 + rawCount % 5;
        uint256 markup = rawMarkup % 10_001;
        uint256 deposit = 3 ether + (uint256(rawCapital % 10) * 0.1 ether);
        uint256 basefee = (uint256(1 + rawBasefee % 5) * 1 gwei);
        vm.fee(basefee);
        vm.txGasPrice(basefee + 0.05 gwei);
        address creator = IERC721Min(BAYC).ownerOf(1);
        assertEq(creator.code.length, 0, "BAYC owner is not a plain actor EOA");
        assertEq(KEEPER.code.length, 0, "keeper is not a plain actor EOA");
        vm.deal(creator, 5 ether);
        vm.deal(KEEPER, 1 ether);

        uint256 mintFee = IShapes(SHAPES).mintFee();
        uint256 amount = IShapes(SHAPES).denominationAt(denom);
        uint256 feesBefore = IShapesAccounting(SHAPES).pendingFees();
        uint256 backingBefore = IShapesAccounting(SHAPES).redeemableBacking();
        uint256 shapesBalanceBefore = SHAPES.balance;

        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        ShapePacks packs = new ShapePacks(SHAPES, address(renderer), creator, "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        BalancerFactory factory = new BalancerFactory(address(impl), creator);
        vm.startPrank(creator);
        PoolBalancer balancer = PoolBalancer(payable(factory.createBalancer{value: deposit}(bytes32(uint256(73)))));
        IERC721Min(BAYC).approve(address(balancer), 1);
        uint256 curatedId = balancer.listCurated(BAYC, 1, 0.3 ether);
        balancer.configure(uint16(markup), count << (16 * denom));
        balancer.open();
        vm.stopPrank();
        assertTrue(factory.isBalancer(address(balancer)));

        uint256 keeperBefore = KEEPER.balance;
        vm.prank(KEEPER);
        uint256 reward = balancer.performUpkeep();
        assertGt(reward, 0);
        assertEq(KEEPER.balance - keeperBefore, reward);
        assertEq(balancer.keeperCredit(), 0, "creator stockup created keeper credit");
        assertEq(balancer.getActiveShapes()[denom], count);
        assertEq(balancer.admissionStatus(), 0);

        IFWAPool pool = balancer.pool();
        uint256 restock = balancer.restockFee();
        uint256 expectedBase = amount + mintFee + amount * markup / 10_000;
        uint256 expectedPrice = expectedBase + restock;
        uint256[] memory ids = balancer.getActiveIds();
        assertEq(ids.length, count + 1);
        uint256[] memory shapeIds = new uint256[](count);
        uint256 found;
        for (uint256 i; i < ids.length; ++i) {
            uint256 lid = ids[i];
            (uint8 kind, uint8 listedDenom, uint8 state, uint112 base, uint112 price) = balancer.items(lid);
            if (lid == curatedId) {
                assertEq(kind, 1);
                continue;
            }
            assertEq(kind, 2);
            assertEq(listedDenom, denom);
            assertEq(state, 1);
            assertEq(uint256(base), expectedBase);
            assertEq(uint256(price), expectedPrice);
            (address collection,,, uint256 tokenId,, uint256 fwaPrice,, uint8 status) = pool.listings(lid);
            assertEq(collection, SHAPES);
            assertEq(fwaPrice, expectedPrice);
            assertEq(status, 1);
            assertEq(IShapes(SHAPES).ownerOf(tokenId), address(pool));
            assertEq(IShapes(SHAPES).backingOf(tokenId), amount);
            shapeIds[found++] = lid;
        }
        assertEq(found, count);
        assertEq(IShapesAccounting(SHAPES).pendingFees() - feesBefore, count * mintFee);
        assertEq(IShapesAccounting(SHAPES).redeemableBacking() - backingBefore, count * amount);
        assertEq(SHAPES.balance - shapesBalanceBefore, count * (amount + mintFee));

        vm.prank(creator);
        balancer.close();
        uint256 poolBeforeUnlist = address(balancer).balance;
        vm.prank(creator);
        balancer.unlistShapes(shapeIds);
        assertEq(address(balancer).balance - poolBeforeUnlist, count * amount);
        assertEq(IShapesAccounting(SHAPES).redeemableBacking(), backingBefore);
        assertEq(IShapesAccounting(SHAPES).pendingFees(), feesBefore + count * mintFee);
        assertEq(SHAPES.balance, shapesBalanceBefore + count * mintFee);
        assertEq(balancer.getActiveShapes()[denom], 0);

        vm.prank(creator);
        balancer.withdrawCurated(curatedId, creator);
        assertEq(IERC721Min(BAYC).ownerOf(1), creator);
        uint256 liquid = address(balancer).balance;
        vm.prank(creator);
        balancer.claimSurplus(liquid, creator);
        assertEq(address(balancer).balance, 0);
        assertEq(balancer.getActiveIds().length, 0);
        console2.log("case denom/count/markup", uint256(denom), count, markup);
        console2.log("case basefee/deposit", basefee, deposit);
    }
}
