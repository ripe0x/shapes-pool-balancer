// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, console, Vm} from "forge-std/Test.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../src/BalancerFactory.sol";
import {IFWAPoolFactory, IFWAPool, IShapes} from "../../../src/interfaces/External.sol";
import {MockNFT} from "./MockNFT.sol";

contract Probe3Test is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant VRF = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;

    PoolBalancer impl;
    BalancerFactory factory;
    address packs;
    address creator = address(0xC0FFEE);
    address player = address(0xBEEF);
    PoolBalancer bal;
    IFWAPool pool;
    MockNFT nft;

    function _deploy() internal {
        address renderer = deployCode("out/ShapePackRenderer.sol/ShapePackRenderer.json", abi.encode(SHAPES));
        packs = deployCode("out/ShapePacks.sol/ShapePacks.json", abi.encode(SHAPES, renderer, address(this), "P", "P", uint256(2)));
        impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS);
        factory = new BalancerFactory(address(impl), address(0xADA));
    }

    function testDrawCycle() public {
        vm.createSelectFork("https://mainnet.gateway.tenderly.co", 26382349);
        _deploy();
        vm.deal(creator, 100 ether);
        vm.startPrank(creator);
        bal = PoolBalancer(payable(factory.createBalancer{value: 10 ether}(bytes32(0))));
        pool = IFWAPool(address(bal.pool()));
        bal.configure(2000, uint256(3)); // three 0.01 Shapes
        nft = new MockNFT();
        nft.mint(creator, 1);
        nft.setApprovalForAll(address(bal), true);
        bal.listCurated(address(nft), 1, 0.05 ether);
        bal.open();
        vm.stopPrank();
        vm.prank(creator);
        bal.performUpkeep();
        console.log("activeIds after restock", bal.getActiveIds().length);
        console.log("ownerProceeds before draw", pool.ownerProceeds());

        (,, uint256 total) = pool.quoteAcquisitionPrice(1);
        vm.deal(player, 10 ether);
        vm.prank(player);
        uint256 reqId = pool.acquire{value: total}(player, type(uint256).max, 0, 10_000, pool.inventoryVersion(), block.timestamp + 1);
        console.log("reqId status/unsettled", 1, pool.unsettledAcquisitionCount());

        // fulfill as the real VRF coordinator
        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("w"));
        vm.prank(VRF);
        try pool.rawFulfillRandomWords(reqId, words) {
            console.log("fulfilled");
        } catch Error(string memory r) { console.log("fulfill revert", r); }
        catch (bytes memory r) { console.log("fulfill revert bytes"); console.logBytes(r); }

        console.log("unsettled after fulfill", pool.unsettledAcquisitionCount());
        (address pur, uint256 rb, uint256 esc, uint256 lid, uint8 st, bool tp) = pool.acquisitions(reqId);
        console.log("acq lid/status", lid, st);
        uint256 proc = pool.processAcquisitions(5);
        console.log("processed", proc);
        console.log("ownerProceeds after settle", pool.ownerProceeds());
        console.log("lastIssuedSeq/nextToProcess", pool.lastIssuedSequence(), pool.nextSequenceToProcess());
        console.log("player nft balance?", nft.ownerOf(1) == player ? 1 : 0);
        console.log("shapes owner of drawn?", lid);
    }
}
