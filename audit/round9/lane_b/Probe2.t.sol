// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, console, Vm} from "forge-std/Test.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../src/BalancerFactory.sol";
import {IFWAPoolFactory, IFWAPool, IShapes} from "../../../src/interfaces/External.sol";
import {MockNFT} from "./MockNFT.sol";

contract Probe2Test is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;

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

    function _tryGetter(address t, string memory sig) internal view {
        (bool ok, bytes memory ret) = t.staticcall(abi.encodeWithSignature(sig));
        if (ok && ret.length == 32) console.log(sig, abi.decode(ret, (address)));
    }

    function testProbeDraw() public {
        vm.createSelectFork("https://mainnet.gateway.tenderly.co", 26382349);
        _deploy();
        vm.deal(creator, 100 ether);
        vm.startPrank(creator);
        bal = PoolBalancer(payable(factory.createBalancer{value: 10 ether}(bytes32(0))));
        pool = IFWAPool(address(bal.pool()));

        // one 0.01 Shape target
        uint256 target = uint256(1); // count 1 at denom 0
        bal.configure(2000, target); // 20% markup
        // curated NFT so pool admits purchases
        nft = new MockNFT();
        nft.mint(creator, 1);
        nft.setApprovalForAll(address(bal), true);
        bal.listCurated(address(nft), 1, 0.05 ether);
        bal.open();
        vm.stopPrank();

        // restock via upkeep (creator runs it)
        vm.prank(creator);
        bal.performUpkeep();
        console.log("admissionStatus after upkeep", bal.admissionStatus());
        console.log("activeIds", bal.getActiveIds().length);

        // discover VRF coordinator getters on the pool
        address P = address(pool);
        _tryGetter(P, "vrfCoordinator()");
        _tryGetter(P, "COORDINATOR()");
        _tryGetter(P, "coordinator()");
        _tryGetter(P, "vrfService()");
        _tryGetter(P, "s_vrfCoordinator()");
        _tryGetter(P, "VRF_SERVICE()");
        _tryGetter(P, "feeRouter()");
        _tryGetter(FWA_FACTORY, "vrfService()");
        _tryGetter(FWA_FACTORY, "vrfCoordinator()");
        _tryGetter(FWA_FACTORY, "feeRouter()");

        (uint256 fee, uint256 vrf, uint256 total) = pool.quoteAcquisitionPrice(1);
        console.log("quote fee/vrf/total", fee, vrf, total);
        console.log("inventoryVersion", pool.inventoryVersion());

        // acquire one draw as player
        vm.deal(player, 10 ether);
        vm.recordLogs();
        vm.prank(player);
        try pool.acquire{value: total + 1 ether}(player, type(uint256).max, 0, 10_000, pool.inventoryVersion(), block.timestamp + 1) returns (uint256 reqId) {
            console.log("acquire ok reqId", reqId);
            (address pur, uint256 rb, uint256 esc, uint256 lid, uint8 st, bool tp) = pool.acquisitions(reqId);
            console.log("acq purchaser/lid/status", pur, lid, st);
            console.log("unsettled", pool.unsettledAcquisitionCount());
        } catch Error(string memory r) {
            console.log("acquire revert", r);
        } catch (bytes memory r) {
            console.log("acquire revert bytes len", r.length);
            console.logBytes(r);
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        console.log("nlogs", logs.length);
        for (uint256 i; i < logs.length; i++) {
            console.log("log emitter", logs[i].emitter);
            if (logs[i].topics.length > 0) console.logBytes32(logs[i].topics[0]);
        }
    }
}
