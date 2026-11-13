// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IFWAPoolFactory, IFWAPool, IShapes} from "../../../src/interfaces/External.sol";

/// Integration/liveness lane — real FWA pool + real Shapes, no mocks. Measures whether listing a prize (exactly what a
/// keeper restock does via pool.listNFTs inside performUpkeep) bumps FWA's inventoryVersion. A player's acquire() pins
/// expectedInventoryVersion; if a restock bumps it, a draw already submitted against the old version is rejected by FWA.
/// This measures the mechanism directly on the real pool, without the Balancer stack.
contract RestockInventoryVersionTest is Test {
    address constant FAC = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;

    function test_listingBumpsInventoryVersion() public {
        vm.createSelectFork("https://mainnet.gateway.tenderly.co", 26382349);

        // Create a real FWA pool owned by this contract (same call the Balancer makes).
        IFWAPool pool = IFWAPool(IFWAPoolFactory(FAC).createPool(bytes32(0), FWA_IMPL));
        assertEq(pool.owner(), address(this));

        IShapes shapes = IShapes(SHAPES);
        uint256 fee = shapes.mintFee();
        uint256 backing = shapes.denominationAt(0); // 0.01 ETH

        // Mint two real 0.01 ETH Shapes to this contract, approve the pool (as the Balancer does at init).
        vm.deal(address(this), 10 ether);
        uint256 id0 = shapes.mintBatch{value: backing + fee}(backing, 1);
        uint256 id1 = shapes.mintBatch{value: backing + fee}(backing, 1);
        shapes.setApprovalForAll(address(pool), true);

        uint256 v0 = pool.inventoryVersion();
        emit log_named_uint("inventoryVersion before listing", v0);

        // First listing (initial stock).
        pool.listNFT(SHAPES, id0, backing * 115 / 100);
        uint256 v1 = pool.inventoryVersion();
        emit log_named_uint("inventoryVersion after 1st listing", v1);

        // Second listing (this is what a keeper RESTOCK does while a player's draw may be in flight).
        pool.listNFT(SHAPES, id1, backing * 115 / 100);
        uint256 v2 = pool.inventoryVersion();
        emit log_named_uint("inventoryVersion after restock listing", v2);
        emit log_named_uint("version delta per listing", v2 - v1);

        // Headline: a restock listing changes inventoryVersion, so any player draw that pinned v1 is now stale.
        assertGt(v2, v1, "restock listing must bump inventoryVersion");
        assertGt(v1, v0, "initial listing bumps inventoryVersion");
    }

    receive() external payable {}
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
