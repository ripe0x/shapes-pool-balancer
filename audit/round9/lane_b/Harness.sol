// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, console, Vm} from "forge-std/Test.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../src/BalancerFactory.sol";
import {IFWAPoolFactory, IFWAPool, IShapes} from "../../../src/interfaces/External.sol";
import {MockNFT} from "./MockNFT.sol";

/// Shared fork harness: real FWA pool, real Shapes, real Draw Packs, real VRF service (pranked as coordinator, the
/// accepted method). No vm.mockCall / vm.etch / vm.store on protocol contracts. Curated NFTs use a local ERC721.
contract Harness is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant VRF = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;
    uint256 constant FORK_BLOCK = 26382349;

    PoolBalancer impl;
    BalancerFactory factory;
    address packs;
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
        factory = new BalancerFactory(address(impl), address(this)); // this test is the keeper admin
        nft = new MockNFT();
    }

    function _newPool(uint256 deposit) internal {
        vm.deal(creator, creator.balance + deposit + 1 ether);
        vm.prank(creator);
        bal = PoolBalancer(payable(factory.createBalancer{value: deposit}(bytes32(uint256(nextNft)))));
        pool = IFWAPool(address(bal.pool()));
    }

    function _listCurated(uint256 base) internal returns (uint256 id) {
        id = nextNft++;
        nft.mint(creator, id);
        vm.startPrank(creator);
        nft.setApprovalForAll(address(bal), true);
        bal.listCurated(address(nft), id, base);
        vm.stopPrank();
    }

    /// Run upkeep as `who`. Returns (reward, measuredGas-from-event, wasSetup).
    function _upkeep(address who) internal returns (uint256 reward, uint256 measured, bool wasSetup) {
        wasSetup = bal.creatorWork();
        vm.recordLogs();
        vm.prank(who);
        try bal.performUpkeep() returns (uint256 r) {
            reward = r;
        } catch {
            return (0, 0, wasSetup);
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("KeeperPaid(address,uint256,uint256)");
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(bal) && logs[i].topics[0] == sig) {
                (uint256 amt, uint256 g) = abi.decode(logs[i].data, (uint256, uint256));
                reward = amt;
                measured = g;
            }
        }
    }

    /// Drive one paid draw by `buyer`, choosing `word`. Fulfills as the VRF coordinator and settles.
    /// Returns (drawnListingId, pricePaid). Reverts if acquire fails.
    function _draw(address buyer, uint256 word) internal returns (uint256 lid, uint256 paid) {
        bool ok;
        (ok, lid, paid) = _tryDraw(buyer, word);
        require(ok, "draw failed");
    }

    /// Like `_draw` but returns ok=false instead of reverting when FWA refuses the acquire (e.g. the forked VRF
    /// subscription runs out of coverage after several paid draws). Records that as an environmental limit.
    function _tryDraw(address buyer, uint256 word) internal returns (bool ok, uint256 lid, uint256 paid) {
        (,, uint256 total) = pool.quoteAcquisitionPrice(1);
        vm.deal(buyer, buyer.balance + total);
        uint256 b0 = buyer.balance;
        vm.prank(buyer);
        try pool.acquire{value: total}(buyer, type(uint256).max, 0, 10_000, pool.inventoryVersion(), block.timestamp + 1)
            returns (uint256 reqId)
        {
            paid = b0 - buyer.balance;
            uint256[] memory words = new uint256[](1);
            words[0] = word;
            vm.prank(VRF);
            pool.rawFulfillRandomWords(reqId, words);
            pool.processAcquisitions(5);
            (,,, lid,,) = pool.acquisitions(reqId);
            ok = true;
        } catch {
            ok = false;
        }
    }

    function _restockFeeNow() internal view returns (uint256) {
        return bal.restockFee();
    }
}
