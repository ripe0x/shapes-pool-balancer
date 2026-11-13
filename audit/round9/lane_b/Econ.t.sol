// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Harness, console} from "./Harness.sol";

/// Economic pass (M4-M9): fund/profit accounting, round trips, nothing stranded, and the "fund keeps all NFT sale
/// money" rule. Real fork, real draws (<=0.5 gwei for VRF coverage).
contract EconTest is Harness {
    function setUp() public {
        _fork();
        _deploy();
        vm.fee(0.3 gwei);
        vm.txGasPrice(0.3 gwei);
    }

    function _stock() internal {
        uint256 g;
        while (bal.creatorWork() && g++ < 15) _upkeep(creator);
    }

    /// M7: after close, unlist and withdraw, nothing is stranded; creator recovers everything; profit/fund consistent.
    function testFullCycleNothingStranded() public {
        _newPool(5 ether);
        vm.prank(creator);
        bal.configure(2000, uint256(4)); // four 0.01 Shapes
        uint256 cur = _listCurated(0.05 ether);
        _stock();
        vm.prank(creator);
        bal.open();

        uint256 deposited = 5 ether;
        // a few draws
        for (uint256 i; i < 6; i++) {
            if (bal.admissionStatus() != 0) _upkeep(keeper);
            if (bal.admissionStatus() != 0) continue;
            (bool ok,,) = _tryDraw(player, uint256(keccak256(abi.encode("d", i))));
            if (!ok) break;
            _upkeep(keeper);
        }
        // close and sweep everything
        vm.startPrank(creator);
        bal.close();
        // unlist any remaining shapes
        uint256[] memory ids = bal.getActiveIds();
        // split curated vs shape
        uint256[] memory shapeIds = new uint256[](ids.length);
        uint256 ns;
        for (uint256 i; i < ids.length; i++) {
            (uint8 kind,, uint8 state,,) = bal.items(ids[i]);
            if (kind == 2 && state == 1) shapeIds[ns++] = ids[i];
        }
        if (ns > 0) {
            assembly { mstore(shapeIds, ns) }
            bal.unlistShapes(shapeIds);
        }
        // withdraw any still-active curated
        (uint8 ck,, uint8 cs,,) = bal.items(cur);
        if (ck == 1 && cs == 1) bal.withdrawCurated(cur, creator);
        bal.collectProceeds();
        uint256 surplus = bal.withdrawableSurplus();
        if (surplus > 0) bal.claimSurplus(surplus, creator);
        vm.stopPrank();

        console.log("balancer residual wei", address(bal).balance);
        console.log("pool ownerProceeds residual", pool.ownerProceeds());
        // M7: nothing stranded in the balancer after full sweep (allow pool ownerProceeds already collected).
        assertEq(address(bal).balance, 0, "ETH stranded in balancer after close+withdraw");
        assertEq(bal.profit(), 0, "profit nonzero after closed sweep");
    }

    /// M9 probe: does NFT-sale money get booked into withdrawable `profit` while below the reserve?
    /// The owner's rule: "the fund keeps ... all NFT sale money". Draw a curated NFT, collect against a set that
    /// still holds a high-markup Shape, and measure profit booked from that pure NFT-sale collection.
    function testNftSaleMoneyBookedAsProfit() public {
        _newPool(0.14 ether); // near the reserve so the below-reserve profit path is active
        vm.prank(creator);
        bal.configure(10000, uint256(2)); // 100% markup, two 0.01 Shapes (high share)
        _listCurated(0.01 ether); // curated NFT tokenId 1 (cheap => high weight => drawn)
        _listCurated(0.01 ether); // curated NFT tokenId 2
        _stock();
        vm.prank(creator);
        bal.open();

        uint256 nftDraws;
        uint256 nftProfitBooked;
        uint256 shapeProfitBooked;
        for (uint256 i; i < 12; i++) {
            if (bal.admissionStatus() != 0) _upkeep(keeper);
            if (bal.admissionStatus() != 0) continue;
            uint256 pBefore = (nft.ownerOf(1) == player ? 1 : 0) + (nft.ownerOf(2) == player ? 1 : 0);
            (bool ok,,) = _tryDraw(player, uint256(keccak256(abi.encode("n", i))));
            if (!ok) break;
            bool wasNft = ((nft.ownerOf(1) == player ? 1 : 0) + (nft.ownerOf(2) == player ? 1 : 0)) > pBefore;

            uint256 fundBefore = address(bal).balance - bal.profit();
            bool below = fundBefore < bal.requiredReserve();
            uint256 profitBefore = bal.profit();
            uint256 proceeds = pool.ownerProceeds();
            vm.prank(creator);
            bal.collectProceeds();
            uint256 booked = bal.profit() - profitBefore;
            console.log("draw i / wasNft / proceeds", i, wasNft ? 1 : 0, proceeds);
            console.log("   below / profitBooked / activeN", below ? 1 : 0, booked, bal.getActiveIds().length);
            if (below && wasNft) { nftDraws++; nftProfitBooked += booked; }
            else if (below) { shapeProfitBooked += booked; }
            _upkeep(keeper); // restock for next round
        }
        console.log("NFT draws below reserve", nftDraws);
        console.log("profit booked from NFT-sale collections", nftProfitBooked);
        console.log("profit booked from Shape collections", shapeProfitBooked);
        // M9 evidence: the fund is meant to keep ALL NFT sale money, so nftProfitBooked should be 0.
    }

    /// M9 fund invariant: claiming surplus never reduces the fund (= balance - profit) and never breaches the reserve
    /// via the free path.
    function testClaimPreservesFund() public {
        _newPool(5 ether);
        vm.prank(creator);
        bal.configure(5000, uint256(3));
        _listCurated(0.05 ether);
        _stock();
        vm.prank(creator);
        bal.open();
        for (uint256 i; i < 6; i++) {
            if (bal.admissionStatus() != 0) _upkeep(keeper);
            if (bal.admissionStatus() != 0) continue;
            (bool ok,,) = _tryDraw(player, uint256(keccak256(abi.encode("c", i))));
            if (!ok) break;
            _upkeep(keeper);
            // claim whatever is withdrawable each step (owner withdraws everything allowed every step)
            uint256 s = bal.withdrawableSurplus();
            if (s == 0) continue;
            uint256 fundBefore = address(bal).balance - bal.profit();
            uint256 reqBefore = bal.requiredReserve();
            vm.prank(creator);
            bal.claimSurplus(s, creator);
            uint256 fundAfter = address(bal).balance - bal.profit();
            console.log("claim / fundBefore / fundAfter", s, fundBefore, fundAfter);
            // fund must not drop below the reserve as a result of the claim (game-first)
            assertGe(fundAfter + 1, fundBefore > reqBefore ? reqBefore : fundBefore, "claim pushed fund below reserve");
        }
    }
}
