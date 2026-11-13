// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../src/BalancerFactory.sol";
import {IFWAPoolFactory, IFWAPool, IShapes, IShapePacks} from "../../../src/interfaces/External.sol";

/// Blind probe: stand up the real system on the pinned fork and learn the FWA draw/VRF path.
contract ProbeTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;

    PoolBalancer impl;
    BalancerFactory factory;
    address packs;
    address creator = address(0xC0FFEE);
    PoolBalancer bal;
    IFWAPool pool;

    function _deploy() internal {
        address renderer = deployCode("out/ShapePackRenderer.sol/ShapePackRenderer.json", abi.encode(SHAPES));
        packs = deployCode(
            "out/ShapePacks.sol/ShapePacks.json",
            abi.encode(SHAPES, renderer, address(this), "P", "P", uint256(2))
        );
        impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS);
        factory = new BalancerFactory(address(impl), address(0xADA));
    }

    function testProbe() public {
        vm.createSelectFork("https://mainnet.gateway.tenderly.co", 26382349);
        _deploy();
        console.log("edgeBps", IFWAPoolFactory(FWA_FACTORY).edgeBps());
        console.log("maxAcq", IFWAPoolFactory(FWA_FACTORY).maxAcquisitionsPerTx());
        console.log("maxStaged", IFWAPoolFactory(FWA_FACTORY).maxStagedListings());
        console.log("mintFee", IShapes(SHAPES).mintFee());

        vm.deal(creator, 100 ether);
        vm.prank(creator);
        address b = factory.createBalancer(bytes32(0));
        bal = PoolBalancer(payable(b));
        pool = IFWAPool(address(bal.pool()));
        console.log("balancer", b);
        console.log("pool", address(pool));
        console.log("vrfServiceFee", pool.vrfServiceFee());
        (uint256 fee, uint256 vrf, uint256 total) = pool.quoteAcquisitionPrice(1);
        console.log("quote fee/vrf/total", fee, vrf, total);
        console.log("localPurchasesEnabled", pool.localPurchasesEnabled());
        console.log("acquisitionFee", pool.acquisitionFee());
    }
}
