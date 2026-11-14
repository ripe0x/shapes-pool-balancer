// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolBalancer} from "../../src/PoolBalancer.sol";

/// @notice Tests list one curated NFT through `listCuratedBatch`, the only listing entry point. The batch call is the
///         first external call, so a preceding `vm.prank` or `vm.expectRevert` applies to it.
library ListOne {
    function listCurated(PoolBalancer b, address collection, uint256 tokenId, uint256 base) internal returns (uint256) {
        PoolBalancer.CuratedInput[] memory one = new PoolBalancer.CuratedInput[](1);
        one[0] = PoolBalancer.CuratedInput(collection, tokenId, base);
        uint256[] memory ids = b.listCuratedBatch(one);
        return ids.length == 0 ? 0 : ids[0]; // empty only when vm.expectRevert caught the call
    }
}
