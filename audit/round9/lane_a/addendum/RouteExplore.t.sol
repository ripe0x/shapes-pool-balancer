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
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}

/// Explore the real Chainlink coordinator -> VRF service -> pool fulfilment route and capture the coordinator-level
/// requestId emitted during acquire, so later work can deliver randomness through the service's own bookkeeping.
contract RouteExplore is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant VRF_SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;
    address constant VRF_COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;

    PoolBalancer impl;
    BalancerFactory factory;
    address packs;
    address creator = address(0xC0FFEE);
    address keeper = address(0x1111);
    address player = address(0x9A9A);
    SimpleNFT nft;

    function setUp() public {
        vm.createSelectFork("https://mainnet.gateway.tenderly.co", 26382349);
        address renderer = deployCode("ShapePackRenderer.sol:ShapePackRenderer", abi.encode(SHAPES));
        packs = deployCode("ShapePacks.sol:ShapePacks", abi.encode(SHAPES, renderer, address(0xBEEF), "P", "P", uint256(2)));
        impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS);
        factory = new BalancerFactory(address(impl), address(0xA11CE));
        nft = new SimpleNFT();
    }

    function _upkeep(PoolBalancer b) internal {
        for (uint256 i; i < 10; ++i) {
            vm.prank(keeper);
            try b.performUpkeep() {} catch { break; }
            if (!b.creatorWork()) break;
        }
    }

    function testExploreRoute() public {
        vm.prank(creator);
        PoolBalancer b = PoolBalancer(payable(factory.createBalancer(bytes32(0))));
        IFWAPool p = b.pool();
        vm.prank(creator);
        b.configure(3000, 3);
        vm.deal(address(b), 10 ether);
        vm.prank(creator);
        b.open();
        _upkeep(b);
        nft.mint(creator, 1);
        vm.prank(creator);
        nft.approve(address(b), 1);
        vm.prank(creator);
        b.listCurated(address(nft), 1, 0.3 ether);
        _upkeep(b);
        require(b.admissionStatus() == 0, "not admitting");

        (uint256 fee,, uint256 total) = p.quoteAcquisitionPrice(1);
        vm.deal(player, total);
        uint256 iv = p.inventoryVersion();
        vm.recordLogs();
        vm.prank(player);
        uint256 poolReqId = p.acquire{value: total}(player, fee, 0, 10_000, iv, block.timestamp + 1000);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // Find the coordinator's RandomWordsRequested; requestId is the first non-indexed word.
        bytes32 reqTopic = 0xeb0e3652e0f44f417695e6e90f2f42c99b65cd7169074c5a654b16b9748c3a4e;
        uint256 coordReqId;
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == VRF_COORDINATOR && logs[i].topics[0] == reqTopic) {
                coordReqId = abi.decode(logs[i].data, (uint256));
                found = true;
            }
        }
        require(found, "no RandomWordsRequested from coordinator");
        console.log("coordinator requestId:", coordReqId);

        // Drive the REAL route: act as the Chainlink coordinator, deliver to the VRF service, which does its own
        // bookkeeping and forwards to the pool.
        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("real-route"));
        uint256 proceedsBefore = p.ownerProceeds();
        vm.prank(VRF_COORDINATOR);
        IVRFService(VRF_SERVICE).rawFulfillRandomWords(coordReqId, words);
        console.log("unsettled after real-route fulfill:", p.unsettledAcquisitionCount());
        console.log("ownerProceeds before/after:", proceedsBefore, p.ownerProceeds());
        console.log("nextSequenceToProcess:", p.nextSequenceToProcess());
        assertEq(p.unsettledAcquisitionCount(), 0, "real route settled the draw");
        assertGt(p.ownerProceeds(), proceedsBefore, "real route credited proceeds");
    }
}
