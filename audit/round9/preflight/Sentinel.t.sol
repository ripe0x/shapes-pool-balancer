// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

/// Neutral capability sentinel: compiler, local execution, fuzzing, and fork reads. No target knowledge.
contract SentinelTest is Test {
    function testNeutralArithmetic() public pure {
        assert(2 + 2 == 4);
    }

    function testFuzzNeutralArithmetic(uint64 x) public pure {
        assert(uint256(x) + 1 > uint256(x));
    }

    /// Runs only when SENTINEL_FORK=1: reads a mainnet block through the public RPC.
    function testForkReadsBlock() public {
        if (!vm.envOr("SENTINEL_FORK", false)) return;
        vm.createSelectFork("https://mainnet.gateway.tenderly.co", 26382349);
        assertEq(block.number, 26382349);
        assertGt(address(0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e).code.length, 0);
    }
}
