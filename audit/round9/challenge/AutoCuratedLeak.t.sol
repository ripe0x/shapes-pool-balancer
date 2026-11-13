// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {AddendumBase} from "../lane_a/addendum/AddendumBase.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {IFWAPool} from "../../../src/interfaces/External.sol";

interface IERC721Min2 {
    function ownerOf(uint256) external view returns (address);
}

/// Open question from both lanes: WITHOUT any creator action, does a CURATED NFT draw's proceeds (pure NFT-sale money,
/// which M9 says the fund must keep in full) get partly booked as withdrawable `profit` while the fund is below the
/// reserve? Lane A flagged the mechanism but could not PoC it (its single-curated draw pushed the fund back above the
/// reserve). Lane B's H9 found "no counterexample" only because the fund stayed above reserve in its exercised domain.
/// Here: draw the curated NFT itself (word-targeted via the real coordinator route) and leave it unreconciled so the
/// reserve stays inflated (fund < reserve); then collect. _collect books amount*profitShareSum/(n*1e18); since the
/// shapes contribute positive profitShareSum and `amount` is the curated sale price, any booked profit is NFT money.
contract AutoCuratedLeak is AddendumBase {
    function testCuratedDrawBooksNftMoneyAsProfit() public {
        PoolBalancer b = newBalancer();
        uint256 cid = openPool(b, one(D_001, 5), 3000, 10 ether, 0.3 ether); // 30% markup, curated base 0.3
        // pull balance down to the (pre-draw) reserve
        uint256 bal = address(b).balance;
        uint256 reserve = b.requiredReserve();
        if (bal > reserve) {
            vm.prank(creator);
            b.claimSurplus(bal - reserve, creator);
        }
        // identify the curated NFT tokenId behind listing `cid`
        IFWAPool p = b.pool();
        (,,, uint256 curTokenId,,,,) = p.listings(cid);

        // word-search a draw that DELIVERS THE CURATED to the player (ownerOf == player), left unreconciled
        bool hitCurated;
        for (uint256 w = 1; w <= 120 && !hitCurated; ++w) {
            uint256 s = vm.snapshotState();
            drawReal(b, uint256(keccak256(abi.encode("cur", w))));
            if (IERC721Min2(address(nft)).ownerOf(curTokenId) == player) {
                hitCurated = true;
            } else {
                vm.revertToState(s);
            }
        }
        require(hitCurated, "could not draw the curated NFT within the word budget");

        uint256 proceeds = p.ownerProceeds();
        uint256 fundV = fundVal(b);
        uint256 req = b.requiredReserve();
        console.log("curated-draw proceeds (NFT sale money, wei):", proceeds);
        console.log("fund / reserve (wei):", fundV, req);
        require(proceeds > 0, "no proceeds");
        require(fundV < req, "not short - cannot test the below-reserve booking");

        uint256 profitBefore = b.profit();
        b.collectProceeds();
        uint256 profitAfter = b.profit();
        uint256 booked = profitAfter - profitBefore;
        console.log("profit booked from the curated (NFT) proceeds (wei):", booked);
        // M9: "the fund keeps ... all NFT sale money" while below reserve. Any booked profit here violates it.
        assertEq(booked, 0, "LEAK: curated-draw NFT-sale money was booked as withdrawable profit while short");
    }
}
