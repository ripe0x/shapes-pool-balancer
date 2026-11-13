// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {AddendumBase} from "./AddendumBase.sol";
import {PoolBalancer} from "../../../../src/PoolBalancer.sol";
import {IFWAPool} from "../../../../src/interfaces/External.sol";

interface IRedeemable {
    function redeem(uint256 id) external;
    function ownerOf(uint256 id) external view returns (address);
}

/// Draw Pack prize lifecycle with a wei ledger: mint -> list -> win (delivered to player) -> player redeems for exactly
/// the backing; and unlist (withdraw+redeem back to the pool). Real coordinator->service->pool route, no mocks.
contract PackLifecycle is AddendumBase {
    function testPackWinAndRedeem() public {
        PoolBalancer b = newBalancer();
        IFWAPool p = b.pool();
        // target: two 0.02 packs (denom 9, 2 shapes each)
        vm.prank(creator);
        b.configure(3000, one(D_002, 2));
        vm.deal(address(b), 20 ether);
        vm.prank(creator);
        b.open();
        upkeep(b);
        uint256 cid = listNewCurated(b, 0.3 ether);
        upkeep(b);
        require(b.admissionStatus() == 0, "not admitting");

        // Find the pack listing id and token id.
        uint256 packLid;
        uint256 packTok;
        {
            uint256[] memory ids = b.getActiveIds();
            for (uint256 i; i < ids.length; ++i) {
                (uint8 kind, uint8 denom, uint8 state,,) = b.items(ids[i]);
                if (kind == 2 && denom == D_002 && state == 1) {
                    packLid = ids[i];
                    (,,, packTok,,,,) = p.listings(ids[i]);
                    break;
                }
            }
        }
        require(packLid != 0, "no pack listed");
        assertEq(IRedeemable(packs).ownerOf(packTok), address(p), "pack held by FWA pool while listed");

        // Force a draw that wins THIS pack (search words; detect by the pack token moving to the player).
        bool won;
        for (uint256 w = 1; w <= 80 && !won; ++w) {
            uint256 s = vm.snapshotState();
            drawReal(b, uint256(keccak256(abi.encode("pack", w))));
            if (IRedeemable(packs).ownerOf(packTok) == player) {
                won = true;
            } else {
                vm.revertToState(s);
            }
        }
        require(won, "could not win the pack in 80 words");

        // M4: the winning player redeems the pack for EXACTLY its backing (0.02 ETH).
        uint256 before = player.balance;
        vm.prank(player);
        IRedeemable(packs).redeem(packTok);
        uint256 got = player.balance - before;
        console.log("pack backing redeemed by winner (wei):", got);
        assertEq(got, 0.02 ether, "M4: pack did not redeem for exactly its backing");
    }

    function testPackUnlistRedeemsToPool() public {
        PoolBalancer b = newBalancer();
        IFWAPool p = b.pool();
        vm.prank(creator);
        b.configure(3000, one(D_002, 2));
        vm.deal(address(b), 20 ether);
        vm.prank(creator);
        b.open();
        upkeep(b);
        listNewCurated(b, 0.3 ether);
        upkeep(b);

        // collect a pack listing id
        uint256 packLid;
        {
            uint256[] memory ids = b.getActiveIds();
            for (uint256 i; i < ids.length; ++i) {
                (uint8 kind, uint8 denom, uint8 state,,) = b.items(ids[i]);
                if (kind == 2 && denom == D_002 && state == 1) {
                    packLid = ids[i];
                    break;
                }
            }
        }
        require(packLid != 0, "no pack");
        uint256[] memory one_ = new uint256[](1);
        one_[0] = packLid;
        uint256 balBefore = address(b).balance;
        vm.prank(creator);
        b.unlistShapes(one_); // withdraw from FWA + redeem here
        uint256 recovered = address(b).balance - balBefore;
        console.log("pool ETH recovered by unlisting a pack (wei):", recovered);
        // M4: exactly the backing comes back to the pool.
        assertEq(recovered, 0.02 ether, "M4: unlisting a pack did not return exactly its backing");
    }
}
