// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {PoolBalancer} from "../../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../../src/BalancerFactory.sol";
import {IFWAPool} from "../../../../src/interfaces/External.sol";
import {SimpleNFT} from "../helpers/MockCollections.sol";

interface IVRFService {
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}

/// Shared harness for the lane-A addendum. All randomness is delivered through the REAL route: act as the Chainlink
/// coordinator calling the VRF service, which runs its own bookkeeping and forwards to the pool. No protocol contract
/// is mocked.
abstract contract AddendumBase is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant VRF_SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;
    address constant VRF_COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;
    bytes32 constant REQ_TOPIC = 0xeb0e3652e0f44f417695e6e90f2f42c99b65cd7169074c5a654b16b9748c3a4e;

    // size indices (PoolBalancer size table)
    uint256 constant D_001 = 0; // 0.01 ETH shape
    uint256 constant D_05 = 3; //  0.5 ETH shape
    uint256 constant D_1 = 4; //   1 ETH shape
    uint256 constant D_002 = 9; // 0.02 ETH pack (2 shapes)
    uint256 constant D_02 = 11; // 0.2 ETH pack
    uint256 constant D_025 = 12; // 0.25 ETH pack

    PoolBalancer impl;
    BalancerFactory factory;
    address packs;
    address creator = address(0xC0FFEE);
    address keeper = address(0x1111);
    address player = address(0x9A9A);
    SimpleNFT nft;
    uint256 nextNftId = 1;

    function setUp() public virtual {
        vm.createSelectFork("https://mainnet.gateway.tenderly.co", 26382349);
        address renderer = deployCode("ShapePackRenderer.sol:ShapePackRenderer", abi.encode(SHAPES));
        packs = deployCode("ShapePacks.sol:ShapePacks", abi.encode(SHAPES, renderer, address(0xBEEF), "P", "P", uint256(2)));
        impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS);
        factory = new BalancerFactory(address(impl), address(0xA11CE));
        nft = new SimpleNFT();
    }

    function newBalancer() internal returns (PoolBalancer b) {
        vm.prank(creator);
        b = PoolBalancer(payable(factory.createBalancer(bytes32(uint256(nextNftId++)))));
    }

    function upkeep(PoolBalancer b) internal {
        for (uint256 i; i < 15; ++i) {
            vm.prank(keeper);
            try b.performUpkeep() {} catch { break; }
            if (!b.creatorWork()) break;
        }
    }

    // pack a single (denom,count) into a target word
    function one(uint256 d, uint256 n) internal pure returns (uint256) {
        return n << (16 * d);
    }

    function listNewCurated(PoolBalancer b, uint256 base) internal returns (uint256 id) {
        uint256 tid = 1_000 + nextNftId++;
        nft.mint(creator, tid);
        vm.prank(creator);
        nft.approve(address(b), tid);
        vm.prank(creator);
        id = b.listCurated(address(nft), tid, base);
    }

    /// Acquire one draw as `player` WITHOUT settling it; returns the coordinator-level requestId to fulfill later.
    function acquireOnly(PoolBalancer b) internal returns (uint256 coordReqId) {
        IFWAPool p = b.pool();
        (uint256 fee,, uint256 total) = p.quoteAcquisitionPrice(1);
        vm.deal(player, player.balance + total);
        uint256 iv = p.inventoryVersion();
        vm.recordLogs();
        vm.prank(player);
        p.acquire{value: total}(player, fee, 0, 10_000, iv, block.timestamp + 1000);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == VRF_COORDINATOR && logs[i].topics[0] == REQ_TOPIC) {
                coordReqId = abi.decode(logs[i].data, (uint256));
                found = true;
            }
        }
        require(found, "no coordinator request");
    }

    /// Deliver randomness for a previously-acquired request through the real coordinator->service route.
    function fulfillReq(uint256 coordReqId, uint256 word) internal {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        vm.prank(VRF_COORDINATOR);
        IVRFService(VRF_SERVICE).rawFulfillRandomWords(coordReqId, words);
    }

    /// Acquire one draw as `player` and deliver `word` through the real coordinator->service->pool route.
    /// Returns the drawn FWA listingId (read from the pool before reconcile) via its purchaser having changed is hard,
    /// so callers detect the drawn item by its side effects (NFT transfer / inventory change).
    function drawReal(PoolBalancer b, uint256 word) internal {
        IFWAPool p = b.pool();
        (uint256 fee,, uint256 total) = p.quoteAcquisitionPrice(1);
        vm.deal(player, player.balance + total);
        uint256 iv = p.inventoryVersion();
        vm.recordLogs();
        vm.prank(player);
        p.acquire{value: total}(player, fee, 0, 10_000, iv, block.timestamp + 1000);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 coordReqId;
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == VRF_COORDINATOR && logs[i].topics[0] == REQ_TOPIC) {
                coordReqId = abi.decode(logs[i].data, (uint256));
                found = true;
            }
        }
        require(found, "no coordinator request");
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        vm.prank(VRF_COORDINATOR);
        IVRFService(VRF_SERVICE).rawFulfillRandomWords(coordReqId, words);
    }

    function fund(PoolBalancer b) internal view {} // placeholder for symmetry

    // open a pool with `target`, `markup`, funded to `ethDeposit`, inventory built, one curated listed; returns curated id
    function openPool(PoolBalancer b, uint256 target, uint16 markup, uint256 ethDeposit, uint256 curatedBase)
        internal
        returns (uint256 curatedId)
    {
        vm.prank(creator);
        b.configure(markup, target);
        vm.deal(address(b), ethDeposit);
        vm.prank(creator);
        b.open();
        upkeep(b);
        curatedId = listNewCurated(b, curatedBase);
        upkeep(b);
        require(b.admissionStatus() == 0, "openPool: not admitting");
    }

    function fundVal(PoolBalancer b) internal view returns (uint256) {
        return address(b).balance - b.profit();
    }
}
