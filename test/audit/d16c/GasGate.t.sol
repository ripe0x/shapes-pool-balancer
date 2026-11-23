// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "solady/tokens/ERC721.sol";
import {D16bWorstUpkeepTest, ProbeHog} from "../d16b/WorstUpkeepB.t.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";

/// @notice Curated collection (accepted by design) whose transfer out of the pool refuses cheaply when little gas is
///         left, instead of running out of gas. With FWA's full 150k delivery stipend it delivers; starved, it reverts
///         early and hands most gas back, so FWA's processing returns normally with the prize undelivered.
contract GasGate is ERC721 {
    address public pool;
    uint256 public immutable FLOOR;

    constructor(uint256 floor_) {
        FLOOR = floor_;
    }

    function name() public pure override returns (string memory) {
        return "Gate";
    }

    function symbol() public pure override returns (string memory) {
        return "GATE";
    }

    function tokenURI(uint256) public pure override returns (string memory) {
        return "";
    }

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function arm(address pool_) external {
        pool = pool_;
    }

    function _beforeTokenTransfer(address from, address, uint256) internal view override {
        if (from != address(0) && from == pool && gasleft() < FLOOR) revert();
    }
}

contract D16cGasGateTest is D16bWorstUpkeepTest {
    GasGate gate;
    uint256 r4;
    uint256 r5;

    function _listGates(uint256 n, uint256 firstId) internal {
        PoolBalancer.CuratedInput[] memory in_ = new PoolBalancer.CuratedInput[](n);
        for (uint256 i; i < n; ++i) {
            gate.mint(creator, firstId + i);
            vm.prank(creator);
            gate.approve(address(balancer), firstId + i);
            in_[i] = PoolBalancer.CuratedInput(address(gate), firstId + i, 0.01 ether);
        }
        vm.prank(creator);
        balancer.listCuratedBatch(in_);
    }

    function _gateWord(uint256 req, uint256 upTo, bytes memory salt) internal returns (uint256) {
        for (uint256 i; i < 400; ++i) {
            uint256 w = uint256(keccak256(abi.encode(salt, i)));
            uint256 snap = vm.snapshotState();
            fulfill(req, w);
            pool.processAcquisitions(upTo);
            (address coll, uint8 st) = _winner(req);
            vm.revertToState(snap);
            if (coll == address(gate) && st == 2) return w;
        }
        revert("no gate word");
    }

    /// @dev One fast-pathed draw to reconcile, then two ready draws that each reserved six gate listings and each
    ///      select a gate listing (delivered at full gas).
    function _buildGate() internal {
        _setGas(0.5 gwei, 0.55 gwei);
        gate = new GasGate(100_000);
        createBalancer(10 ether);
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1);
        vm.startPrank(creator);
        balancer.configure(2500, plan16(c), shapes.mintFee());
        vm.stopPrank();
        listCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256 r1 = buy(buyer, 1)[0];
        _listGates(12, 100);
        gate.arm(address(pool));
        r4 = buy(buyer, 1)[0];
        r5 = buy(stranger, 1)[0];
        fulfill(r1, uint256(keccak256("w")));
        fulfill(r4, _gateWord(r4, 1, "g4"));
        fulfill(r5, _gateWord(r5, 2, "g5"));
        assertEq(pool.unsettledAcquisitionCount(), 2);
    }

    /// @dev One ready draw that reserved six gate listings and selects one; one fast-pathed draw before it.
    function _buildGateOne(uint256 floor_) internal {
        _setGas(0.5 gwei, 0.55 gwei);
        gate = new GasGate(floor_);
        createBalancer(10 ether);
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1);
        vm.startPrank(creator);
        balancer.configure(2500, plan16(c), shapes.mintFee());
        vm.stopPrank();
        listCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256 r1 = buy(buyer, 1)[0];
        _listGates(6, 100);
        gate.arm(address(pool));
        r4 = buy(buyer, 1)[0];
        r5 = r4;
        fulfill(r1, uint256(keccak256("w")));
        fulfill(r4, _gateWord(r4, 1, "g4"));
        assertEq(pool.unsettledAcquisitionCount(), 1);
    }

    /// @dev As _buildGateOne, but an upkeep reconciles and collects the older draw before the gate draw is ready, so
    ///      the work after processing is only one reconcile and the pay.
    function _buildGateLean(uint256 floor_) internal {
        _setGas(0.5 gwei, 0.55 gwei);
        gate = new GasGate(floor_);
        createBalancer(10 ether);
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1);
        vm.startPrank(creator);
        balancer.configure(2500, plan16(c), shapes.mintFee());
        vm.stopPrank();
        listCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256 r1 = buy(buyer, 1)[0];
        _listGates(6, 100);
        gate.arm(address(pool));
        r4 = buy(buyer, 1)[0];
        r5 = r4;
        fulfill(r1, uint256(keccak256("w")));
        bytes32 uh1 = balancer.settingsHash();
        vm.prank(keeper, keeper);
        balancer.performUpkeep(uh1, 0, 0);
        for (uint256 k; k < 3; ++k) {
            bytes32 uh2 = balancer.settingsHash();
            vm.prank(keeper, keeper);
            try balancer.performUpkeep(uh2, 0, 0) {} catch {}
        }
        assertEq(balancer.reconciledSequence() + 1, pool.lastIssuedSequence(), "only the gate draw left");
        assertEq(pool.ownerProceeds(), 0, "nothing to collect");
        fulfill(r4, _gateWord(r4, 1, "g4"));
        assertEq(pool.unsettledAcquisitionCount(), 1);
    }

    function test_gateLean_floor100k() public {
        lean = true;
        _sweepOne(100_000);
    }

    function test_gateLean_floor120k() public {
        lean = true;
        _sweepOne(120_000);
    }

    bool lean;

    function _sweepOne(uint256 floor_) internal {
        if (lean) _buildGateLean(floor_);
        else _buildGateOne(floor_);
        _setGas(0.5 gwei, 0.55 gwei);
        (bool okHi, bool pHi, uint8 a,, uint256 paidHi, uint256 costHi) = _try(4_000_000);
        _row(4_000_000, okHi, pHi, a, a, paidHi, costHi);
        assertTrue(okHi && pHi && a == 2, "full gas delivers");
        uint256 starvedOk;
        uint256 lowestOk = type(uint256).max;
        for (uint256 G = 300_000; G <= 3_100_000; G += 2_000) {
            (bool ok, bool processed, uint8 s4,, uint256 paid, uint256 cost) = _try(G);
            if (ok && G < lowestOk) lowestOk = G;
            if (ok && s4 == 7) {
                if (starvedOk < 5) _row(G, ok, processed, s4, s4, paid, cost);
                ++starvedOk;
            }
        }
        emit log_named_uint("successful limits (2k steps) that left the deliverable prize undelivered", starvedOk);
        uint256 lo = lowestOk - 2_000;
        uint256 hi = lowestOk;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            (bool okm,,,,,) = _try(mid);
            if (okm) hi = mid;
            else lo = mid;
        }
        (bool ok2, bool p2, uint8 e4,, uint256 paid2, uint256 cost2) = _try(hi);
        emit log_string("least succeeding limit (what eth_estimateGas converges on):");
        _row(hi, ok2, p2, e4, e4, paid2, cost2);
        (ok2, p2, e4,, paid2, cost2) = _try(hi * 13 / 10);
        emit log_string("app limit = estimate x 1.3:");
        _row(hi * 13 / 10, ok2, p2, e4, e4, paid2, cost2);
        // FWA lets any caller pick the gas for processing, so a collection whose transfer depends on gas can be left
        // DeliveryPending (retry or refund under FWA's rules) at some limits, with or without the Balancer: information.
        // Requirement: the app's limit (1.3x the estimate) and the keeper's (1.3x, at least 4M) deliver.
        assertTrue(ok2 && e4 == 2, "the app's limit delivers");
    }

    /// @dev Control: the gate does starve delivery when FWA is called directly, so the sweep above is not vacuous.
    function test_gateOne_directControl() public {
        _buildGateOne(100_000);
        uint256 hits;
        uint256 first;
        for (uint256 G = 200_000; G <= 1_600_000; G += 1_000) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = address(pool).call{gas: G}(abi.encodeWithSignature("processAcquisitions(uint256)", 1));
            (, uint8 st) = _winner(r4);
            vm.revertToState(snap);
            if (ok && st == 7) {
                if (hits == 0) first = G;
                ++hits;
            }
        }
        emit log_named_uint("direct FWA limits that settle DeliveryPending", hits);
        emit log_named_uint("first such limit", first);
        assertGt(hits, 0);
    }

    function test_gateOne_floor100k() public {
        _sweepOne(100_000);
    }

    function test_gateOne_floor120k() public {
        _sweepOne(120_000);
    }

    function _try(uint256 G) internal returns (bool ok, bool processed, uint8 s4, uint8 s5, uint256 paid, uint256 cost) {
        uint256 snap = vm.snapshotState();
        bytes32 uh3 = balancer.settingsHash();
        uint256 before = keeper.balance;
        vm.prank(keeper, keeper);
        (ok,) = address(balancer).call{gas: G}(abi.encodeWithSignature("performUpkeep(bytes32,uint256,uint256)", uh3, 0, 0));
        (, bytes memory r) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        (, uint64 used,,,) = abi.decode(r, (uint64, uint64, uint64, int64, uint64));
        cost = (uint256(used)) * 0.55 gwei;
        paid = keeper.balance - before;
        processed = pool.unsettledAcquisitionCount() == 0;
        (, s4) = _winner(r4);
        (, s5) = _winner(r5);
        vm.revertToState(snap);
    }

    function _row(uint256 G, bool ok, bool processed, uint8 s4, uint8 s5, uint256 paid, uint256 cost) internal {
        emit log_string(string.concat(
            "G=", vm.toString(G), " ok=", ok ? "1" : "0", " processed=", processed ? "1" : "0",
            " status4=", vm.toString(s4), " status5=", vm.toString(s5),
            " paidWei=", vm.toString(paid), " costWei=", vm.toString(cost)
        ));
    }

    /// @dev D16 re-attack 3, finding 2: a prize the full-gas run delivers can end DeliveryPending (7) at a low limit
    ///      while processing returns normally. FWA-level (any caller of processAcquisitions picks the gas); the app's
    ///      and keeper's limits must deliver.
    function test_gate_sweep_and_estimate() public {
        _buildGate();
        _setGas(0.5 gwei, 0.55 gwei);
        (bool okHi, bool pHi, uint8 a, uint8 b, uint256 paidHi, uint256 costHi) = _try(4_000_000);
        _row(4_000_000, okHi, pHi, a, b, paidHi, costHi);
        assertTrue(okHi && pHi && a == 2 && b == 2, "full gas delivers both");

        uint256 starvedOk;
        uint256 lowestOk = type(uint256).max;
        for (uint256 G = 300_000; G <= 3_100_000; G += 20_000) {
            (bool ok, bool processed, uint8 s4, uint8 s5, uint256 paid, uint256 cost) = _try(G);
            if (ok && G < lowestOk) lowestOk = G;
            if (ok && (s4 == 7 || s5 == 7)) {
                ++starvedOk;
                _row(G, ok, processed, s4, s5, paid, cost);
            }
        }
        emit log_named_uint("successful limits that left a deliverable prize undelivered", starvedOk);
        // Emulate an estimator: the least succeeding limit, refined to 100 gas.
        uint256 lo = lowestOk - 20_000;
        uint256 hi = lowestOk;
        while (hi - lo > 100) {
            uint256 mid = (lo + hi) / 2;
            (bool okm,,,,,) = _try(mid);
            if (okm) hi = mid;
            else lo = mid;
        }
        (bool ok2, bool p2, uint8 e4, uint8 e5, uint256 paid2, uint256 cost2) = _try(hi);
        emit log_string("least succeeding limit (what eth_estimateGas converges on):");
        _row(hi, ok2, p2, e4, e5, paid2, cost2);
        (ok2, p2, e4, e5, paid2, cost2) = _try(hi * 13 / 10);
        emit log_string("app limit = estimate x 1.3:");
        _row(hi * 13 / 10, ok2, p2, e4, e5, paid2, cost2);
        assertTrue(ok2 && e4 == 2 && e5 == 2, "the app's limit delivers both");
    }
}
