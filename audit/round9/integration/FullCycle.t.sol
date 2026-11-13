// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC721} from "solady/tokens/ERC721.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../src/BalancerFactory.sol";
import {IFWAPool, IShapes} from "../../../src/interfaces/External.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";

/// A creator's own curated NFT collection (not a protocol counterparty): a plain ERC721.
contract MiniNFT is ERC721 {
    function name() public pure override returns (string memory) { return "Mini"; }
    function symbol() public pure override returns (string memory) { return "MINI"; }
    function tokenURI(uint256) public pure override returns (string memory) { return ""; }
    function mint(address to, uint256 id) external { _mint(to, id); }
}

/// Post-seal addendum — full real-path cycle on the fork. Deploys the stack via `new` (fs_permissions blocks
/// vm.deployCode on the lane out dir), opens a pool through the real FWA factory, and drives real draws. No mocks.
contract FullCycleTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant KEEPER_ADMIN = address(0xA11CE);

    ShapePackRenderer renderer;
    ShapePacks packs;
    PoolBalancer impl;
    BalancerFactory factory;
    PoolBalancer bal;
    IFWAPool pool;
    MiniNFT nft;
    address player = address(0xBEEF);

    function setUp() public {
        vm.createSelectFork("https://mainnet.gateway.tenderly.co", 26382349);
        vm.txGasPrice(1 gwei);
        vm.fee(1 gwei);
        vm.deal(address(this), 100 ether);

        renderer = new ShapePackRenderer(SHAPES);
        packs = new ShapePacks(SHAPES, address(renderer), address(this), "Pool Prize Packs", "PRIZEPACK", 2);
        impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        factory = new BalancerFactory(address(impl), KEEPER_ADMIN);

        bal = PoolBalancer(payable(factory.createBalancer(bytes32(uint256(7)))));
        pool = IFWAPool(bal.pool());

        bal.configure(1500, uint256(3)); // 15% markup, three 0.01 ETH Shapes (size 0)
        nft = new MiniNFT();
        nft.mint(address(this), 1);
        nft.setApprovalForAll(address(bal), true);
        bal.listCurated(address(nft), 1, 0.3 ether);

        bal.depositETH{value: 10 ether}();
        bal.open();
        bal.performUpkeep(); // restock the three Shapes; clears creatorWork
    }

    function test_postflight_readbacks() public view {
        // Mirror script/Deploy.s.sol postflight on a real fork deploy.
        assertEq(factory.implementation(), address(impl), "factory wiring");
        assertEq(factory.keeperAdmin(), KEEPER_ADMIN, "keeper admin");
        assertEq(factory.keepersRestricted(), false, "keepers open");
        assertEq(impl.creator(), address(1), "implementation not locked");
        assertEq(address(impl.FWA_FACTORY()), FWA_FACTORY, "impl FWA factory");
        assertEq(impl.FWA_IMPLEMENTATION(), FWA_IMPL, "impl FWA impl");
        assertEq(address(impl.SHAPES()), SHAPES, "impl SHAPES");
        assertEq(address(impl.ENS()), ENS, "impl ENS");
        assertEq(address(impl.PACKS()), address(packs), "impl PACKS");
        assertEq(packs.shapes(), SHAPES, "packs shapes");
        assertEq(packs.MIN_PACK_VALUE(), 0.02 ether, "pack minimum");
        assertGt(address(impl).code.length, 0, "impl code");
        assertGt(address(factory).code.length, 0, "factory code");
        // Pool opened and admitting.
        assertEq(bal.enabled(), true, "enabled");
        assertEq(bal.admissionStatus(), 0, "admission OK");
        assertEq(bal.getActiveIds().length, 4, "1 curated + 3 shapes listed");
    }

    /// Drive one real acquire and dump every emitted log (emitter + topic0) plus the acquisition, so the real VRF
    /// route (coordinator, consumer, requestId) can be identified without FWA source.
    function test_discover_vrf_route() public {
        uint256 iv = pool.inventoryVersion();
        (uint256 fee, uint256 vrf, uint256 total) = pool.quoteAcquisitionPrice(1);
        emit log_named_uint("inventoryVersion", iv);
        emit log_named_uint("acquisitionFee", fee);
        emit log_named_uint("vrfServiceFee", vrf);
        emit log_named_uint("total", total);

        vm.deal(player, 10 ether);
        vm.recordLogs();
        vm.prank(player);
        uint256 reqId = pool.acquire{value: total}(player, fee, 0, 10_000, iv, block.timestamp + 1 hours);
        emit log_named_uint("acquire requestId", reqId);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        emit log_named_uint("log count", logs.length);
        for (uint256 i; i < logs.length; ++i) {
            emit log_named_address("emitter", logs[i].emitter);
            emit log_named_bytes32("  topic0", logs[i].topics.length > 0 ? logs[i].topics[0] : bytes32(0));
            if (logs[i].topics.length > 1) emit log_named_bytes32("  topic1", logs[i].topics[1]);
            emit log_named_uint("  dataLen", logs[i].data.length);
        }

        (address purch, uint256 rb, uint256 esc, uint256 lid, uint8 st, bool tok) = pool.acquisitions(reqId);
        emit log_named_address("acq.purchaser", purch);
        emit log_named_uint("acq.requestBlock", rb);
        emit log_named_uint("acq.priceEscrowed", esc);
        emit log_named_uint("acq.listingId", lid);
        emit log_named_uint("acq.status", st);
        emit log_named_uint("unsettled", pool.unsettledAcquisitionCount());
    }

    // Chainlink VRF 2.5 Coordinator (mainnet), identified as the emitter of RandomWordsRequested in discovery.
    address constant VRF_COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;
    bytes32 constant RANDOM_WORDS_REQUESTED = 0xeb0e3652e0f44f417695e6e90f2f42c99b65cd7169074c5a654b16b9748c3a4e;

    /// Fulfil a real VRF request by acting as the real Chainlink coordinator calling the real consumer's
    /// rawFulfillRandomWords (VRFConsumerBaseV2Plus gates on msg.sender == coordinator). No mock VRF.
    uint256 lastSpend;

    function _acquireAndFulfil(address who, uint256 randomWord) internal returns (uint256 acqReqId, uint256 lidDrawn) {
        uint256 iv = pool.inventoryVersion();
        (uint256 fee,, uint256 total) = pool.quoteAcquisitionPrice(1);
        vm.deal(who, 10 ether);
        uint256 whoBefore = who.balance;
        vm.recordLogs();
        vm.prank(who);
        acqReqId = pool.acquire{value: total}(who, fee, 0, 10_000, iv, block.timestamp + 1 hours);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 clRequestId;
        address consumer;
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == VRF_COORDINATOR && logs[i].topics[0] == RANDOM_WORDS_REQUESTED) {
                clRequestId = abi.decode(logs[i].data, (uint256)); // first non-indexed word is requestId
                consumer = address(uint160(uint256(logs[i].topics[logs[i].topics.length - 1]))); // sender (indexed, last)
                found = true;
                break;
            }
        }
        require(found, "no RandomWordsRequested from coordinator");
        emit log_named_uint("chainlink requestId", clRequestId);
        emit log_named_address("vrf consumer (sender)", consumer);

        uint256[] memory words = new uint256[](1);
        words[0] = randomWord;
        vm.prank(VRF_COORDINATOR);
        IVrfConsumer(consumer).rawFulfillRandomWords(clRequestId, words);
        lastSpend = whoBefore - who.balance; // = total paid by the player

        // Settle: FWA processes the fulfilled sequence; then our keeper upkeep reconciles it.
        pool.processAcquisitions(5);
        (,,, lidDrawn, , ) = pool.acquisitions(acqReqId);
    }

    /// Full cycle with a real draw and a keeper-billed-gas ledger.
    function test_full_draw_cycle() public {
        uint256 balBefore = address(bal).balance;

        (uint256 acqReqId, uint256 lid) = _acquireAndFulfil(player, uint256(keccak256("w0")));
        emit log_named_uint("player spend total (fee+vrf)", lastSpend);
        emit log_named_uint("drawn listingId", lid);
        (address col,,, uint256 tid, , , , uint8 status) = pool.listings(lid);
        emit log_named_address("drawn collection", col);
        emit log_named_uint("drawn tokenId", tid);
        emit log_named_uint("drawn listing status", status);

        // Verify the winner actually received the prize (delivery, not just settlement).
        address prizeOwner = IShapes(SHAPES).ownerOf(tid);
        emit log_named_address("prize owner after draw", prizeOwner);
        assertEq(prizeOwner, player, "winner must receive the drawn Shape");

        uint256 proceedsBeforeUpkeep = pool.ownerProceeds();

        // Keeper reconciles the settled draw; measure real billed gas x effective price.
        address keeper = address(0x1234);
        vm.deal(keeper, 1 ether);
        vm.fee(1 gwei);
        vm.txGasPrice(1 gwei);
        uint256 kBefore = keeper.balance;
        uint256 g0 = gasleft();
        vm.prank(keeper);
        uint256 reward = bal.performUpkeep();
        uint256 gasUsed = g0 - gasleft();
        uint256 billedCost = gasUsed * 1 gwei; // effective price = basefee+priority capped; here 1 gwei
        emit log_named_uint("keeper reward (wei)", reward);
        emit log_named_uint("approx gasUsed (test-frame, incl overhead)", gasUsed);
        emit log_named_uint("approx billed cost @1gwei", billedCost);
        emit log_named_int("keeper net (reward - billed)", int256(reward) - int256(billedCost));
        assertEq(keeper.balance - kBefore, reward, "keeper paid exactly the reward");

        emit log_named_uint("ownerProceeds settled (pre-upkeep)", proceedsBeforeUpkeep);
        emit log_named_int("pool balance delta over cycle", int256(address(bal).balance) - int256(balBefore));
        emit log_named_uint("pool ownerProceeds now", pool.ownerProceeds());
        emit log_named_uint("reconciledSequence", bal.reconciledSequence());
        emit log_named_uint("keeperCredit now", bal.keeperCredit());
        emit log_named_uint("profit now", bal.profit());
        emit log_named_uint("admission after", bal.admissionStatus());
        emit log_named_uint("active listings after", bal.getActiveIds().length);
    }

    /// P2 — a purchase quoted at gas price 0 (what eth_call/estimateGas return without fee fields) under-funds the VRF
    /// fee and the acquire reverts at a real inclusion gas price.
    function test_gasZeroQuote_underfunds_purchase() public {
        vm.fee(1 gwei);
        vm.txGasPrice(0); // simulate eth_call with no gas price
        (uint256 f0, uint256 v0, uint256 t0) = pool.quoteAcquisitionPrice(1);
        vm.txGasPrice(1 gwei); // real inclusion price
        (, uint256 v1, uint256 t1) = pool.quoteAcquisitionPrice(1);
        emit log_named_uint("vrf @ gasprice0 quote", v0);
        emit log_named_uint("vrf @ inclusion 1gwei", v1);
        emit log_named_uint("total quoted @0 (sent)", t0);
        emit log_named_uint("total required @1gwei", t1);
        assertEq(v0, 0, "vrf is zero at gas price 0");
        assertGt(t1, t0, "gas-price-0 quote under-funds by the VRF fee");

        vm.deal(player, 10 ether);
        uint256 iv = pool.inventoryVersion();
        vm.prank(player);
        vm.expectRevert(); // insufficient value for the real VRF fee at inclusion
        pool.acquire{value: t0}(player, f0, 0, 10_000, iv, block.timestamp + 1 hours);
    }

    /// P2b — performUpkeep simulated at gas price 0 under-reports the keeper reward (reward view ~ incentive only),
    /// which is why the keeper bot and dashboard must simulate at real fees (keeper.ts/App.tsx do).
    function test_gasZeroSim_underreports_upkeep_reward() public {
        // Create reconcilable work: one settled draw.
        _acquireAndFulfil(player, uint256(keccak256("w2")));
        vm.fee(1 gwei);
        uint256 snap = vm.snapshotState();
        vm.txGasPrice(0);
        uint256 reward0 = bal.performUpkeep();
        vm.revertToState(snap);
        vm.txGasPrice(1 gwei);
        uint256 reward1 = bal.performUpkeep();
        emit log_named_uint("upkeep reward simulated @ gasprice0", reward0);
        emit log_named_uint("upkeep reward @ gasprice1", reward1);
        assertLt(reward0, reward1, "gas-price-0 simulation under-reports the reward");
    }

    /// P4 — a listing (what a keeper restock does) bumps inventoryVersion, so a draw pinning the old version reverts;
    /// the same acquire with the current version succeeds. Measures the revert on the real FWA path.
    function test_staleInventoryVersion_reverts_draw() public {
        uint256 ivOld = pool.inventoryVersion();
        // A keeper/creator listing bumps the version (here: list another curated NFT).
        nft.mint(address(this), 2);
        bal.listCurated(address(nft), 2, 0.3 ether);
        uint256 ivNew = pool.inventoryVersion();
        assertGt(ivNew, ivOld, "listing bumped inventoryVersion");

        (uint256 fee,, uint256 total) = pool.quoteAcquisitionPrice(1);
        vm.deal(player, 10 ether);
        // Stale pin -> revert.
        vm.prank(player);
        vm.expectRevert();
        pool.acquire{value: total}(player, fee, 0, 10_000, ivOld, block.timestamp + 1 hours);
        // Current pin -> succeeds (returns a requestId).
        vm.prank(player);
        uint256 rid = pool.acquire{value: total}(player, fee, 0, 10_000, ivNew, block.timestamp + 1 hours);
        assertGt(rid, 0, "current-version draw accepted");
        emit log_named_uint("ivOld", ivOld);
        emit log_named_uint("ivNew", ivNew);
    }

    /// P3 — keeper gas: measure a heavy upkeep (multiple settled draws reconciled + restock in one call) against the
    /// keeper bot's UPKEEP_GAS_FLOOR (4,000,000, keeper.ts) and the reward cap gas (KEEPER_MAX_GAS 3,200,000).
    function test_upkeep_gas_vs_keeper_floor() public {
        // Burst several draws before any settlement (bounded by inventory/admission).
        uint256 drew;
        for (uint256 i; i < 3; ++i) {
            if (bal.admissionStatus() != 0) break;
            _acquireAndFulfilNoSettle(player, uint256(keccak256(abi.encode("burst", i))));
            drew++;
        }
        pool.processAcquisitions(5);
        vm.fee(1 gwei);
        vm.txGasPrice(1 gwei);
        uint256 g0 = gasleft();
        bal.performUpkeep();
        uint256 used = g0 - gasleft();
        emit log_named_uint("draws reconciled in one upkeep", drew);
        emit log_named_uint("upkeep gasUsed (test-frame)", used);
        emit log_named_uint("KEEPER UPKEEP_GAS_FLOOR", 4_000_000);
        emit log_named_uint("KEEPER_MAX_GAS (reward cap)", 3_200_000);
        assertLt(used, 4_000_000, "heavy upkeep stays under the keeper gas floor");
    }

    /// P3 worst case — a true 5-draw burst reconciled + restocked in one upkeep, against the 4M keeper floor.
    function test_worstcase_5draw_upkeep_gas() public {
        bal.configure(1500, uint256(25)); // 25 x 0.01 ETH Shapes keeps fill open through 5 unreconciled draws
        bal.depositETH{value: 30 ether}();
        for (uint256 i; i < 12 && bal.creatorWork(); ++i) bal.performUpkeep(); // stock fully (MAX_OPS=5/call)
        assertGe(uint256(bal.getActiveShapes()[0]), 20, "stocked enough");
        assertEq(bal.admissionStatus(), 0, "open after stocking");

        uint256 drew;
        for (uint256 i; i < 5; ++i) {
            if (bal.admissionStatus() != 0) break;
            _acquireAndFulfilNoSettle(player, uint256(keccak256(abi.encode("wc", i))));
            drew++;
        }
        pool.processAcquisitions(5);
        vm.fee(1 gwei);
        vm.txGasPrice(1 gwei);
        uint256 g0 = gasleft();
        bal.performUpkeep();
        uint256 used = g0 - gasleft();
        emit log_named_uint("burst draws reconciled", drew);
        emit log_named_uint("worst-case upkeep gasUsed (reconcile+restock)", used);
        assertLt(used, 4_000_000, "worst-case upkeep under keeper gas floor");
    }

    function _acquireAndFulfilNoSettle(address who, uint256 randomWord) internal {
        uint256 iv = pool.inventoryVersion();
        (uint256 fee,, uint256 total) = pool.quoteAcquisitionPrice(1);
        vm.deal(who, 10 ether);
        vm.recordLogs();
        vm.prank(who);
        pool.acquire{value: total}(who, fee, 0, 10_000, iv, block.timestamp + 1 hours);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == VRF_COORDINATOR && logs[i].topics[0] == RANDOM_WORDS_REQUESTED) {
                uint256 clId = abi.decode(logs[i].data, (uint256));
                address consumer = address(uint160(uint256(logs[i].topics[logs[i].topics.length - 1])));
                uint256[] memory w = new uint256[](1);
                w[0] = randomWord;
                vm.prank(VRF_COORDINATOR);
                IVrfConsumer(consumer).rawFulfillRandomWords(clId, w);
                return;
            }
        }
        revert("no vrf request");
    }

    receive() external payable {}
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

interface IVrfConsumer {
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}
