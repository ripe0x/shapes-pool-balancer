// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, console, Vm} from "forge-std/Test.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../src/BalancerFactory.sol";
import {IFWAPoolFactory, IFWAPool, IShapes} from "../../../src/interfaces/External.sol";
import {MockNFT} from "./MockNFT.sol";

/// Addendum harness with the CORRECT VRF route (route correction from the coordinator):
/// 0x7D93..Ed65d is FWA's VRF *service*; its Chainlink *coordinator* is service.coordinator() = 0xD7f8..893a.
/// A draw is settled by: player acquire -> read the Chainlink requestId from the coordinator's request event
/// (topic0 0xeb0e3652..) -> prank the coordinator and call service.rawFulfillRandomWords(reqId, words) so the service
/// does its own bookkeeping and forwards to the pool -> processAcquisitions. This does not exhaust VRF coverage.
/// No vm.mockCall / vm.etch / vm.store on protocol contracts. Curated collections are a local MockNFT.
contract Harness2 is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant VRF_SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;
    bytes32 constant REQ_TOPIC = 0xeb0e3652e0f44f417695e6e90f2f42c99b65cd7169074c5a654b16b9748c3a4e;
    uint256 constant FORK_BLOCK = 26382349;

    PoolBalancer impl;
    BalancerFactory factory;
    address packs;
    address coord; // Chainlink coordinator
    address creator = address(0xC0FFEE);
    address keeper = address(0xCAFE);
    address player = address(0xBEEF);
    PoolBalancer bal;
    IFWAPool pool;
    MockNFT nft;
    uint256 nextNft = 1;

    function _fork() internal {
        vm.createSelectFork("https://mainnet.gateway.tenderly.co", FORK_BLOCK);
    }

    function _deploy() internal {
        address renderer = deployCode("out/ShapePackRenderer.sol/ShapePackRenderer.json", abi.encode(SHAPES));
        packs = deployCode("out/ShapePacks.sol/ShapePacks.json", abi.encode(SHAPES, renderer, address(this), "P", "P", uint256(2)));
        impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS);
        factory = new BalancerFactory(address(impl), address(this));
        nft = new MockNFT();
        (bool ok, bytes memory r) = VRF_SERVICE.staticcall(abi.encodeWithSignature("coordinator()"));
        require(ok, "coordinator()");
        coord = abi.decode(r, (address));
    }

    function _newPool(uint256 deposit) internal {
        vm.deal(creator, creator.balance + deposit + 1 ether);
        vm.prank(creator);
        bal = PoolBalancer(payable(factory.createBalancer{value: deposit}(bytes32(uint256(nextNft + 1000)))));
        pool = IFWAPool(address(bal.pool()));
    }

    function _listCurated(uint256 base) internal returns (uint256 id) {
        uint256 tok = nextNft++;
        nft.mint(creator, tok);
        vm.startPrank(creator);
        nft.setApprovalForAll(address(bal), true);
        id = bal.listCurated(address(nft), tok, base);
        vm.stopPrank();
    }

    function _stock() internal {
        uint256 g;
        while (bal.creatorWork() && g++ < 40) _upkeep(creator);
    }

    function _upkeep(address who) internal returns (uint256 reward, uint256 measured, bool wasSetup) {
        wasSetup = bal.creatorWork();
        vm.recordLogs();
        vm.prank(who);
        try bal.performUpkeep() returns (uint256 r) { reward = r; } catch { return (0, 0, wasSetup); }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("KeeperPaid(address,uint256,uint256)");
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(bal) && logs[i].topics[0] == sig) {
                (uint256 amt, uint256 gm) = abi.decode(logs[i].data, (uint256, uint256));
                reward = amt;
                measured = gm;
            }
        }
    }

    /// Acquire one draw and settle it with `word`, via the correct coordinator->service route.
    function _tryDraw(address buyer, uint256 word) internal returns (bool ok, uint256 lid, uint256 paid) {
        (,, uint256 total) = pool.quoteAcquisitionPrice(1);
        vm.deal(buyer, buyer.balance + total);
        uint256 b0 = buyer.balance;
        vm.recordLogs();
        vm.prank(buyer);
        try pool.acquire{value: total}(buyer, type(uint256).max, 0, 10_000, pool.inventoryVersion(), block.timestamp + 1)
            returns (uint256 reqId)
        {
            paid = b0 - buyer.balance;
            uint256 clReqId = _findReqId();
            uint256[] memory words = new uint256[](1);
            words[0] = word;
            vm.prank(coord);
            (bool f,) = VRF_SERVICE.call(abi.encodeWithSignature("rawFulfillRandomWords(uint256,uint256[])", clReqId, words));
            require(f, "service fulfill failed");
            pool.processAcquisitions(5);
            (,,, lid,,) = pool.acquisitions(reqId);
            ok = true;
        } catch {
            ok = false;
        }
    }

    function _draw(address buyer, uint256 word) internal returns (uint256 lid, uint256 paid) {
        bool ok;
        (ok, lid, paid) = _tryDraw(buyer, word);
        require(ok, "draw failed");
    }

    /// Issue one acquire, then search words (snapshot/revert) until the settled draw hits `target`. Keeps the
    /// winning state. Returns false if no word within `tries` hits it.
    function _drawTargeting(address buyer, uint256 target, uint256 tries) internal returns (bool) {
        for (uint256 k; k < tries; k++) {
            uint256 snap = vm.snapshotState();
            (bool ok, uint256 lid,) = _tryDraw(buyer, uint256(keccak256(abi.encode("t", target, k))));
            if (ok && lid == target) return true;
            vm.revertToState(snap);
        }
        return false;
    }

    function _findReqId() internal returns (uint256 clReqId) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == coord && logs[i].topics.length > 0 && logs[i].topics[0] == REQ_TOPIC) {
                clReqId = abi.decode(logs[i].data, (uint256));
            }
        }
    }

    // split active ids into shape vs curated (ACTIVE only)
    function _activeShapeIds() internal view returns (uint256[] memory out) {
        uint256[] memory ids = bal.getActiveIds();
        out = new uint256[](ids.length);
        uint256 n;
        for (uint256 i; i < ids.length; i++) {
            (uint8 kind,, uint8 state,,) = bal.items(ids[i]);
            if (kind == 2 && state == 1) out[n++] = ids[i];
        }
        assembly { mstore(out, n) }
    }
}
