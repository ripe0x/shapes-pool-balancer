// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {KeeperPolicyCalls} from "../src/KeeperPolicyCalls.sol";
import {IKeeperPolicy} from "../src/interfaces/IKeeperPolicy.sol";
import {IShapes} from "../src/interfaces/External.sol";

/// @dev The non-view call asserts fee context inside execution and reads the real Shapes mint fee.
///      Its inputs describe hypothetical inventory; no protocol state, balance or successful answer is replaced.
contract ReserveCapitalQuoteProbe {
    IShapes public immutable shapes;
    uint256 public calls;

    constructor(address shapes_) { shapes = IShapes(shapes_); }

    function quote(KeeperPolicyCalls.Reserve memory r, IKeeperPolicy.Economics memory e, uint256 expectedBase, uint256 expectedBid)
        external returns (uint256 need, uint256 mintFee)
    {
        require(block.basefee == expectedBase && tx.gasprice == expectedBid, "executed fee context");
        mintFee = shapes.mintFee();
        require(mintFee == 0.001 ether, "fork mint fee changed");
        r.baseFee = block.basefee;
        r.mintFee = mintFee;
        ++calls;
        need = KeeperPolicyCalls.reserve(e, r);
    }
}

/// @notice Contract funding-quote parity for eight boards at five gas regimes. This does not mint forty boards.
contract ReserveCapitalMatrixTest is ForkBase {
    string internal root;
    uint256 internal index;
    ReserveCapitalQuoteProbe internal probe;
    uint256 internal maximum;
    IKeeperPolicy.Economics internal econ;
    IKeeperPolicy.Economics internal none;

    function setUp() public {
        setUpFork();
        probe = new ReserveCapitalQuoteProbe(SHAPES);
        econ = factory.economics();
        maximum = (uint256(econ.maxGas) + econ.overheadGas) * econ.gasPriceCeiling + 10 * uint256(econ.workFee);
        assertEq(maximum, (3_200_000 + V1_OVERHEAD) * 5 gwei + 0.0002 ether);
    }

    function _board(uint256 which) internal pure returns (string memory name, uint16[16] memory counts) {
        if (which == 0) { name = "10 small"; counts[0] = 10; }
        else if (which == 1) { name = "20 small"; counts[0] = 20; }
        else if (which == 2) {
            name = "mixed Shapes and packs";
            counts[0] = 24; counts[9] = 8; counts[1] = 12; counts[2] = 2; counts[3] = 1;
        } else if (which == 3) {
            name = "100 mixed";
            counts[0] = 52; counts[9] = 17; counts[1] = 25; counts[2] = 4; counts[3] = 2;
        } else if (which == 4) {
            name = "200 mixed";
            counts[0] = 108; counts[9] = 32; counts[1] = 48; counts[2] = 8; counts[3] = 4;
        } else if (which == 5) {
            name = "1000 with expensive Packs";
            counts[0] = 900; counts[9] = 80; counts[14] = 19; counts[15] = 1;
        } else if (which == 6) { name = "NFT heavy"; counts[0] = 17; }
        else { name = "100 ETH top prize"; counts[0] = 19; counts[8] = 1; }
    }

    function _plan(uint16[16] memory counts) internal pure returns (uint256 packed) {
        for (uint256 d; d < 16; ++d) packed |= uint256(counts[d]) << (16 * d);
    }

    function _serializeCounts(string memory key, string memory field, uint16[16] memory counts) internal {
        uint256[] memory values = new uint256[](16);
        for (uint256 d; d < 16; ++d) values[d] = counts[d];
        vm.serializeUint(key, field, values);
    }

    function _recordBoard(uint256 which, uint256 baseFee) internal {
        (string memory name, uint16[16] memory target) = _board(which);
        uint256 bid = baseFee == 5 gwei ? baseFee : baseFee + 0.05 gwei;
        vm.fee(baseFee); vm.txGasPrice(bid);
        KeeperPolicyCalls.Reserve memory r;
        r.enabled = true;
        r.target = _plan(target);
        (uint256 opening, uint256 mintFee) = probe.quote(r, econ, baseFee, bid);
        r.have = target;
        (uint256 stocked,) = probe.quote(r, econ, baseFee, bid);
        uint256 backing;
        uint256 shapeUnits;
        PoolBalancer implementation = PoolBalancer(payable(factory.implementation()));
        for (uint256 d; d < 16; ++d) {
            backing += uint256(target[d]) * implementation.denominationAmount(d);
            shapeUnits += uint256(target[d]) * ((0x3323232111111111 >> (4 * d)) & 0xF);
        }
        assertGe(opening, backing + shapeUnits * mintFee, "funding includes actual inventory cost");
        assertLt(stocked, backing, "stocked quote does not relock listed backing");
        if (which == 1 && baseFee == 0.5 gwei) {
            assertEq(backing, 0.2 ether);
            assertEq(shapeUnits * mintFee, 0.02 ether);
            assertEq(opening, 0.229565 ether);
            assertEq(stocked, 0.001993 ether);
        }
        string memory key = vm.toString(index++);
        vm.serializeString(key, "kind", "board");
        vm.serializeString(key, "name", name);
        _serializeCounts(key, "target", target);
        vm.serializeString(key, "baseFee", vm.toString(baseFee));
        vm.serializeString(key, "gasPrice", vm.toString(bid));
        vm.serializeString(key, "mintFee", vm.toString(mintFee));
        vm.serializeString(key, "maxReward", vm.toString(maximum));
        vm.serializeString(key, "opening", vm.toString(opening));
        vm.serializeString(key, "stocked", vm.toString(stocked));
        vm.serializeString(key, "backing", vm.toString(backing));
        vm.serializeString(key, "shapeUnits", vm.toString(shapeUnits));
        string memory row = vm.serializeUint(key, "forkBlock", FORK_BLOCK);
        root = vm.serializeString("capitalMatrix", key, row);
    }

    function _recordEdges() internal {
        vm.fee(0.5 gwei); vm.txGasPrice(0.55 gwei);
        (, uint16[16] memory target) = _board(1);
        KeeperPolicyCalls.Reserve memory r;
        r.target = _plan(target);
        r.have[0] = 17;
        r.owed = 2;
        // Closed: only two actual outstanding draw sequences, despite three missing inventory prizes.
        (uint256 closed, uint256 mintFee) = probe.quote(r, econ, 0.5 gwei, 0.55 gwei);
        assertEq(closed, 0.002471 ether); // two owed draws at (2.15M + 60k) * 0.55 gwei + 0.00002
        // Paid disabled: actual missing inventory cost remains, while no compensation budget is locked.
        r.enabled = true;
        (uint256 disabled,) = probe.quote(r, none, 0.5 gwei, 0.55 gwei);
        assertEq(disabled, 0.033 ether);
        for (uint256 i; i < 2; ++i) {
            string memory key = vm.toString(index++);
            vm.serializeString(key, "kind", i == 0 ? "closed" : "paid-disabled");
            _serializeCounts(key, "target", target);
            _serializeCounts(key, "have", r.have);
            vm.serializeBool(key, "enabled", i == 1);
            vm.serializeString(key, "baseFee", vm.toString(uint256(0.5 gwei)));
            vm.serializeString(key, "mintFee", vm.toString(mintFee));
            vm.serializeString(key, "maxReward", vm.toString(i == 0 ? maximum : 0));
            vm.serializeUint(key, "owed", 2);
            string memory row = vm.serializeString(key, "required", vm.toString(i == 0 ? closed : disabled));
            root = vm.serializeString("capitalMatrix", key, row);
        }
    }

    function test_exportEightBoardFiveGasCapitalQuotes() public {
        uint256[5] memory bases = [uint256(0.15 gwei), 0.5 gwei, 1 gwei, 3 gwei, 5 gwei];
        for (uint256 b; b < 8; ++b) for (uint256 g; g < 5; ++g) _recordBoard(b, bases[g]);
        _recordEdges();
        assertEq(index, 42);
        assertEq(probe.calls(), 82);
        vm.writeJson(root, "./test/fixtures/reserve-capital.json");
    }
}
