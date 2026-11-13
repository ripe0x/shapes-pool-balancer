// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

contract SentinelTest {
    function testNeutralArithmetic() public pure {
        assert(2 + 2 == 4);
    }

    function testFuzzNeutralArithmetic(uint64 x) public pure {
        assert(uint256(x) + 1 > uint256(x));
    }
}
