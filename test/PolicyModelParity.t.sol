// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {KeeperPolicyCalls} from "../src/KeeperPolicyCalls.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";

interface IRefundCredit {
    function acquisitionRefundCredit(address account) external view returns (uint256);
}

/// @notice Step-by-step monetary fixture from real FWA, Shapes and production Draw Packs code on a mainnet fork.
///         Coordinator delivery uses the repository's explicit test exception; it is not live VRF timing evidence.
contract PolicyModelParity is ForkBase {
    bytes32 constant PAID = keccak256("KeeperPaid(address,uint256,uint256)");
    bytes32 constant DEPOSIT = keccak256("Deposited(address,uint256)");
    bytes32 constant COLLECT = keccak256("ProceedsCollected(uint256)");
    bytes32 constant CLAIM = keccak256("SurplusClaimed(address,uint256)");
    bytes32 constant MINT = keccak256("ShapesMinted(uint8,uint256,uint256,uint256)");
    bytes32 constant LIST = keccak256("ShapeListed(uint256,uint8,uint256,uint256)");
    bytes32 constant UNLIST = keccak256("ShapesUnlisted(uint256,uint256)");
    string root;
    uint256 index;
    uint256 previousSequence;
    uint256 previousProcessed;
    uint256 deliveredBacking;
    uint256 ownerAccrued;

    function setUp() public { setUpFork(); }

    function _snapshot(string memory action) internal {
        GasProbe probe = new GasProbe(); probe.record();
        assertEq(probe.baseFee(), 0.5 gwei); assertEq(probe.gasPrice(), 0.55 gwei);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 deposited;
        uint256 collected;
        uint256 claimed;
        uint256 cost;
        uint256 mintedBacking;
        uint256 redeemed;
        uint256 reward;
        uint256 measured;
        uint256 shapeUnits;
        uint256 listedPrizes;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(balancer) || logs[i].topics.length == 0) continue;
            bytes32 t = logs[i].topics[0];
            if (t == PAID) { (uint256 a, uint256 g) = abi.decode(logs[i].data, (uint256, uint256)); reward += a; measured += g; }
            else if (t == DEPOSIT) deposited += abi.decode(logs[i].data, (uint256));
            else if (t == COLLECT) collected += abi.decode(logs[i].data, (uint256));
            else if (t == CLAIM) claimed += abi.decode(logs[i].data, (uint256));
            else if (t == MINT) {
                (, uint256 n, uint256 c) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                cost += c;
                mintedBacking += n * balancer.denominationAmount(uint256(logs[i].topics[1]));
            } else if (t == UNLIST) {
                (, uint256 e) = abi.decode(logs[i].data, (uint256, uint256)); redeemed += e;
            } else if (t == LIST) {
                uint256 d = uint256(logs[i].topics[2]);
                shapeUnits += (0x3323232111111111 >> (4 * d)) & 0xF;
                listedPrizes++;
            }
        }
        string memory key = vm.toString(index++);
        vm.serializeString(key, "action", action);
        vm.serializeString(key, "baseFee", vm.toString(probe.baseFee()));
        vm.serializeString(key, "gasPrice", vm.toString(probe.gasPrice()));
        vm.serializeString(key, "deliveredBacking", vm.toString(deliveredBacking)); deliveredBacking = 0;
        vm.serializeString(key, "ownerAccrued", vm.toString(ownerAccrued)); ownerAccrued = 0;
        vm.serializeString(key, "deposited", vm.toString(deposited));
        vm.serializeString(key, "collected", vm.toString(collected));
        vm.serializeString(key, "claimed", vm.toString(claimed));
        vm.serializeString(key, "mintCost", vm.toString(cost));
        vm.serializeString(key, "mintedBacking", vm.toString(mintedBacking));
        vm.serializeString(key, "redeemed", vm.toString(redeemed));
        vm.serializeString(key, "reward", vm.toString(reward));
        vm.serializeString(key, "measuredGas", vm.toString(measured));
        vm.serializeString(key, "shapeUnits", vm.toString(shapeUnits));
        vm.serializeString(key, "listedPrizes", vm.toString(listedPrizes));
        uint256 processed = pool.nextSequenceToProcess()-1;
        vm.serializeString(key,"processedDraws",vm.toString(processed-previousProcessed)); previousProcessed=processed;
        uint256 seq = balancer.reconciledSequence();
        vm.serializeString(key, "reconciledDraws", vm.toString(seq - previousSequence)); previousSequence = seq;
        vm.serializeString(key, "balance", vm.toString(address(balancer).balance));
        vm.serializeString(key, "creatorCredit", vm.toString(balancer.creatorCredit()));
        vm.serializeString(key, "required", vm.toString(balancer.requiredReserve()));
        vm.serializeString(key, "target", vm.toString(balancer.target()));
        vm.serializeString(key, "maxReward", vm.toString(balancer.policyMaxReward()));
        vm.serializeString(key, "owed", vm.toString(pool.lastIssuedSequence() - seq));
        vm.serializeString(key, "ownerProceeds", vm.toString(pool.ownerProceeds()));
        vm.serializeString(key, "creatorRevenueBps", vm.toString(balancer.creatorRevenueBps()));
        vm.serializeString(key, "activeCount", vm.toString(balancer.getActiveIds().length));
        vm.serializeString(key, "refundCredit", vm.toString(IRefundCredit(address(pool)).acquisitionRefundCredit(buyer)));
        vm.serializeBool(key, "enabled", balancer.enabled());
        uint16[16] memory h = balancer.getActiveShapes();
        uint256[] memory have = new uint256[](16);
        for (uint256 d; d < 16; ++d) have[d] = h[d];
        vm.serializeUint(key, "have", have);
        uint256[] memory active = balancer.getActiveIds();
        string[] memory prices = new string[](active.length);
        uint256 backing;
        uint256 n;
        for (uint256 i; i < active.length; ++i) {
            (uint8 kind, uint8 d,,,) = balancer.items(active[i]);
            (,,,,, uint256 price,, uint8 status) = pool.listings(active[i]);
            if (status != 1) continue;
            prices[n++] = vm.toString(price);
            if (kind == 2) backing += balancer.denominationAmount(d);
        }
        assembly ("memory-safe") { mstore(prices, n) }
        vm.serializeString(key, "livePrices", prices);
        vm.serializeString(key, "listedBacking", vm.toString(backing));
        vm.serializeString(key, "drawPrice", vm.toString(pool.acquisitionFee()));
        vm.serializeString(key, "mintFee", vm.toString(shapes.mintFee()));
        string memory out = vm.serializeUint(key, "version", 1); // one payment formula since R95
        root = vm.serializeString("steps", vm.toString(index - 1), out);
        vm.recordLogs();
    }

    function _drawShape() internal {
        uint256[] memory active = balancer.getActiveIds();
        uint256 token;
        uint256 slot;
        for (uint256 i; i < active.length; ++i) {
            (uint8 kind, uint8 d,,,) = balancer.items(active[i]);
            if (kind != 2 || d != 0) continue;
            (,,, token,,, slot,) = pool.listings(active[i]);
            break;
        }
        assertGt(slot, 0);
        uint256 ev = pool.weightedBackingTotal() / pool.totalWeight();
        uint256[] memory requests = buy(buyer, 1); _snapshot("request delivered draw");
        fulfill(requests[0], wordForSlot(slot));
        assertEq(shapes.ownerOf(token), buyer, "real FWA delivery reached the player");
        assertEq(pool.ownerProceeds(), ev, "FWA credited the request-time harmonic-mean EV");
        deliveredBacking = 0.01 ether; ownerAccrued = ev; _snapshot("FWA delivers Shape");
        upkeep(); _snapshot("reconcile and replace Shape");
    }

    function test_writePolicyModelParity() public {
        vm.fee(0.5 gwei); vm.txGasPrice(0.55 gwei);
        GasProbe probe = new GasProbe(); probe.record();
        assertEq(probe.baseFee(), 0.5 gwei); assertEq(probe.gasPrice(), 0.55 gwei);
        vm.recordLogs();
        createBalancer(5 ether); _snapshot("create");
        uint256 t = 17 | (3 << (16 * 9));
        configure(t); listCurated(1, 0.2 ether); _snapshot("configure");
        vm.prank(creator); balancer.open(); _snapshot("open");
        for (uint256 i; i < 10; ++i) {
            bytes32 expected = balancer.settingsHash();
            vm.prank(keeper);
            try balancer.performUpkeep(expected, 0, 0) {} catch { break; }
            _snapshot("setup");
        }
        assertEq(balancer.getActiveShapes()[0], 17);
        assertEq(balancer.getActiveShapes()[9], 3);
        _drawShape();
        uint256 price = pool.acquisitionFee();
        buy(buyer, 2); _snapshot("request real draws");
        vm.roll(vm.getBlockNumber() + 40);
        settle(); // anyone processes expired draws on FWA; upkeep processes only Ready stuck draws
        upkeep(); _snapshot("reconcile expired draws");
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(IRefundCredit(address(pool)).acquisitionRefundCredit(buyer), 2 * price);
        // R95/R96: no replaceable policy; the app's "Pin current factory values" saves them as local economics.
        KeeperPolicyCalls.Economics memory current = factory.economics();
        vm.prank(creator); balancer.setLocalEconomics(current); _snapshot("pin current factory values");
        _drawShape();
        vm.prank(creator); balancer.close(); _snapshot("close");
        uint256[] memory active = balancer.getActiveIds();
        uint256[] memory shapeIds = new uint256[](20);
        uint256 n;
        uint256 curatedId;
        for (uint256 i; i < active.length; ++i) {
            (uint8 kind,,,,) = balancer.items(active[i]);
            if (kind == 2) shapeIds[n++] = active[i]; else curatedId = active[i];
        }
        assertEq(n, 20);
        vm.prank(creator); balancer.unlistShapes(shapeIds); _snapshot("redeem Shapes and packs");
        vm.prank(creator); balancer.withdrawCurated(curatedId, creator); _snapshot("recover curated NFT");
        uint256 amount = balancer.withdrawableSurplus();
        vm.prank(creator); balancer.claimSurplus(amount, creator); _snapshot("withdraw final ETH");
        vm.prank(creator); balancer.retire(); _snapshot("retire");
        assertEq(address(balancer).balance, 0);
        vm.writeJson(root, "./test/fixtures/keeper-policy-money-path.json");
    }
}
