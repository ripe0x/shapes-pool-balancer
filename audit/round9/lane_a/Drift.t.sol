// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../src/BalancerFactory.sol";
import {IFWAPool} from "../../../src/interfaces/External.sol";

/// Recent-block drift: the real FWA integration (codehash, createPool, operator install) still works.
contract Drift is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;

    function testRecentBlockInitialize() public {
        vm.createSelectFork("https://mainnet.gateway.tenderly.co", 26405845);
        address renderer = deployCode("ShapePackRenderer.sol:ShapePackRenderer", abi.encode(SHAPES));
        address packs = deployCode(
            "ShapePacks.sol:ShapePacks", abi.encode(SHAPES, renderer, address(0xBEEF), "P", "P", uint256(2))
        );
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS);
        BalancerFactory factory = new BalancerFactory(address(impl), address(0xA11CE));
        address creator = address(0xC0FFEE);
        vm.prank(creator);
        PoolBalancer b = PoolBalancer(payable(factory.createBalancer(bytes32(0))));
        assertEq(b.creator(), creator);
        IFWAPool p = b.pool();
        assertEq(p.owner(), address(b));
        assertEq(p.purchaseOperator(), address(b));
    }
}
