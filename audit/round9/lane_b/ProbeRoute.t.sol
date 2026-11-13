// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, console, Vm} from "forge-std/Test.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../src/BalancerFactory.sol";
import {IFWAPoolFactory, IFWAPool, IShapes} from "../../../src/interfaces/External.sol";
import {MockNFT} from "./MockNFT.sol";

/// Verify the CORRECT VRF route: coordinator -> service.rawFulfillRandomWords(chainlinkReqId, words) -> pool.
contract ProbeRouteTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant VRF_SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;

    function _getter(address t, string memory sig) internal view returns (address a) {
        (bool ok, bytes memory ret) = t.staticcall(abi.encodeWithSignature(sig));
        if (ok && ret.length == 32) a = abi.decode(ret, (address));
    }

    function testRoute() public {
        vm.createSelectFork("https://mainnet.gateway.tenderly.co", 26382349);
        address renderer = deployCode("out/ShapePackRenderer.sol/ShapePackRenderer.json", abi.encode(SHAPES));
        address packs = deployCode("out/ShapePacks.sol/ShapePacks.json", abi.encode(SHAPES, renderer, address(this), "P", "P", uint256(2)));
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS);
        BalancerFactory factory = new BalancerFactory(address(impl), address(this));
        MockNFT nft = new MockNFT();

        address creator = address(0xC0FFEE);
        address player = address(0xBEEF);
        vm.deal(creator, 100 ether);
        vm.prank(creator);
        PoolBalancer bal = PoolBalancer(payable(factory.createBalancer{value: 10 ether}(bytes32(0))));
        IFWAPool pool = IFWAPool(address(bal.pool()));
        vm.startPrank(creator);
        bal.configure(2000, uint256(3));
        nft.mint(creator, 1);
        nft.setApprovalForAll(address(bal), true);
        bal.listCurated(address(nft), 1, 0.05 ether);
        bal.open();
        vm.stopPrank();
        vm.prank(creator);
        bal.performUpkeep();

        // discover the coordinator the service forwards from
        address coord = _getter(VRF_SERVICE, "coordinator()");
        console.log("service.coordinator()", coord);
        console.log("service.vrfCoordinator()", _getter(VRF_SERVICE, "vrfCoordinator()"));

        // 10 draws at 3 gwei via the correct route: coordinator -> service.rawFulfillRandomWords(chainlinkReqId)
        vm.fee(3 gwei);
        vm.txGasPrice(3 gwei);
        bytes32 reqTopic = 0xeb0e3652e0f44f417695e6e90f2f42c99b65cd7169074c5a654b16b9748c3a4e;
        uint256 settled;
        for (uint256 d; d < 10; d++) {
            if (bal.admissionStatus() != 0) { vm.prank(creator); try bal.performUpkeep() {} catch {} }
            if (bal.admissionStatus() != 0) { console.log("blocked at d", d, bal.admissionStatus()); continue; }
            (,, uint256 total) = pool.quoteAcquisitionPrice(1);
            vm.deal(player, total);
            vm.recordLogs();
            vm.prank(player);
            pool.acquire{value: total}(player, type(uint256).max, 0, 10_000, pool.inventoryVersion(), block.timestamp + 1);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            uint256 clReqId;
            for (uint256 i; i < logs.length; i++) {
                if (logs[i].emitter == coord && logs[i].topics[0] == reqTopic) {
                    clReqId = abi.decode(logs[i].data, (uint256)); // first data word = requestId
                }
            }
            uint256[] memory words = new uint256[](1);
            words[0] = uint256(keccak256(abi.encode("w", d)));
            vm.prank(coord);
            (bool ok, bytes memory ret) = VRF_SERVICE.call(abi.encodeWithSignature("rawFulfillRandomWords(uint256,uint256[])", clReqId, words));
            pool.processAcquisitions(5);
            if (ok && pool.unsettledAcquisitionCount() == 0) settled++;
            console.log("d / fulfilled / unsettled", d, ok ? 1 : 0, pool.unsettledAcquisitionCount());
            if (!ok) { console.logBytes(ret); }
        }
        console.log("settled draws", settled);
        // Route verification: every attempted draw settled via coordinator->service with NO VRF-coverage failure.
        // Draws stop here only because this probe lists a single curated NFT (NO_CURATED after it is drawn);
        // sustained 16- and 40-draw runs at 1/3/4.9 gwei are in AddendumGas.t.sol / AddendumScale.t.sol.
        assertGe(settled, 3, "corrected route did not settle draws at 3 gwei");
        assertEq(bal.admissionStatus(), 3, "stop reason should be NO_CURATED, not a VRF failure");
    }
}
