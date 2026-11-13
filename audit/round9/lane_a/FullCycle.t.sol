// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../src/BalancerFactory.sol";
import {IFWAPool, IFWAPoolFactory, IShapes} from "../../../src/interfaces/External.sol";
import {SimpleNFT} from "./helpers/MockCollections.sol";

/// Full-cycle economic pass: real FWA draws settled through the real VRF service path (acting as the
/// coordinator that fulfills the VRF service). No protocol contract is mocked.
contract FullCycle is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant VRF_SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;

    PoolBalancer impl;
    BalancerFactory factory;
    address packs;
    address keeperAdmin = address(0xA11CE);
    address creator = address(0xC0FFEE);
    address keeper = address(0x1111);
    address player = address(0x9A9A);
    SimpleNFT nft;

    function setUp() public {
        vm.createSelectFork("https://mainnet.gateway.tenderly.co", 26382349);
        address renderer = deployCode("ShapePackRenderer.sol:ShapePackRenderer", abi.encode(SHAPES));
        packs = deployCode(
            "ShapePacks.sol:ShapePacks", abi.encode(SHAPES, renderer, address(0xBEEF), "P", "P", uint256(2))
        );
        impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS);
        factory = new BalancerFactory(address(impl), keeperAdmin);
        nft = new SimpleNFT();
    }

    function _newBalancer(address c) internal returns (PoolBalancer b) {
        vm.prank(c);
        b = PoolBalancer(payable(factory.createBalancer(bytes32(uint256(uint160(c))))));
    }

    // Run upkeep to completion (clear creator work), bounded.
    function _upkeepUntilReady(PoolBalancer b) internal {
        for (uint256 i; i < 10; ++i) {
            vm.prank(keeper);
            try b.performUpkeep() {} catch {
                break;
            }
            if (!b.creatorWork()) break;
        }
    }

    // Acquire one draw as `player` and settle it via the real VRF service path. Returns the request id.
    function _drawOnce(PoolBalancer b, uint256 word) internal returns (uint256 requestId) {
        IFWAPool p = b.pool();
        (uint256 fee,, uint256 total) = p.quoteAcquisitionPrice(1);
        vm.deal(player, player.balance + total);
        uint256 iv = p.inventoryVersion();
        vm.prank(player);
        requestId = p.acquire{value: total}(player, fee, 0, 10_000, iv, block.timestamp + 1000);
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        vm.prank(VRF_SERVICE);
        p.rawFulfillRandomWords(requestId, words);
    }

    // Build a pool: `shapeCount` 0.01 shapes (denom 0) + one 0.3 curated, open, inventory built, balance pulled to the
    // reserve. Returns the curated listing id.
    function _buildPool(PoolBalancer b, uint256 shapeCount, uint16 markup) internal returns (uint256 curatedId) {
        vm.prank(creator);
        b.configure(markup, shapeCount); // count `shapeCount` at denom 0
        vm.deal(address(b), 10 ether);
        vm.prank(creator);
        b.open();
        _upkeepUntilReady(b);
        nft.mint(creator, 1);
        vm.prank(creator);
        nft.approve(address(b), 1);
        vm.prank(creator);
        curatedId = b.listCurated(address(nft), 1, 0.3 ether);
        _upkeepUntilReady(b);
        require(b.admissionStatus() == 0, "not admitting");
        // pull balance down to the reserve so the fund sits at the reserve
        uint256 reserve = b.requiredReserve();
        uint256 bal = address(b).balance;
        if (bal > reserve) {
            vm.prank(creator);
            b.claimSurplus(bal - reserve, creator);
        }
    }

    // --- M9: a creator action (withdrawCurated) timed before collectProceeds moves fund money into profit. ---
    // M9 forbids "No creator action (... withdrawing NFTs ... timing of collection ...) may move fund money into
    // profit." `_collect` splits ALL accrued proceeds by the current profitShareSum/activeIds.length. Removing a
    // curated listing (share 0) shrinks the denominator with no change to the numerator, so the same proceeds book
    // MORE profit. A/B under one snapshot: identical proceeds, two collect orderings.
    function testM9WithdrawCuratedInflatesProfit() public {
        PoolBalancer b = _newBalancer(creator);
        IFWAPool p = b.pool();
        uint256 curatedId = _buildPool(b, 5, 3000); // five 0.01 shapes + curated, 30% markup

        // Drive ONE draw and settle it (ownerProceeds credited) but do NOT reconcile: the unreconciled-draw term keeps
        // requiredReserve inflated, so the fund sits below the reserve (the game-first regime). Force it to hit a shape
        // (curated must survive for the withdrawCurated step) by searching random words under a snapshot.
        bool ok;
        for (uint256 w = 1; w <= 40 && !ok; ++w) {
            uint256 s0 = vm.snapshotState();
            _drawOnce(b, uint256(keccak256(abi.encode("mf", w))));
            if (nft.ownerOf(1) == address(p)) {
                ok = true; // shape drawn, curated intact
            } else {
                vm.revertToState(s0);
            }
        }
        require(ok, "could not hit a shape in 40 words");
        require(p.ownerProceeds() > 0, "no proceeds");
        require(p.unsettledAcquisitionCount() == 0, "all settled");
        uint256 reserve = b.requiredReserve();
        uint256 fundNow = address(b).balance - b.profit();
        console.log("fund:", fundNow, "reserve:", reserve);
        require(fundNow < reserve, "not in game-first regime");

        // A: collect first (honest ordering)
        uint256 snap = vm.snapshotState();
        b.collectProceeds();
        uint256 profitHonest = b.profit();

        // B: creator withdraws the curated listing, THEN collects the same proceeds
        vm.revertToState(snap);
        vm.prank(creator);
        b.withdrawCurated(curatedId, creator);
        b.collectProceeds();
        uint256 profitManip = b.profit();

        console.log("profit (collect first):", profitHonest);
        console.log("profit (withdrawCurated then collect):", profitManip);
        assertGt(profitManip, profitHonest, "M9: creator action moved fund money into profit");
    }

    // --- M4/M6/M7 full-cycle at-rest conservation: open, draws, restock, close, unlist, withdraw. ---
    function testFullCycleConservation() public {
        PoolBalancer b = _newBalancer(creator);
        IFWAPool p = b.pool();
        // target: three 0.01 shapes
        vm.prank(creator);
        b.configure(3000, 3); // 30% markup, three 0.01 shapes
        vm.deal(address(b), 10 ether);
        vm.prank(creator);
        b.open();
        _upkeepUntilReady(b);
        // list a curated NFT for admission
        nft.mint(creator, 1);
        vm.prank(creator);
        nft.approve(address(b), 1);
        vm.prank(creator);
        b.listCurated(address(nft), 1, 0.3 ether);
        _upkeepUntilReady(b);

        // Up to five draws; re-list the curated NFT whenever it gets drawn so admission stays open. Restock between.
        uint256 drawn;
        for (uint256 i; i < 10 && drawn < 5; ++i) {
            _upkeepUntilReady(b);
            if (b.admissionStatus() == 3 && nft.ownerOf(1) == player) {
                // curated was drawn and delivered to the player; relist a fresh one to keep admission open
                nft.mint(creator, 100 + i);
                vm.prank(creator);
                nft.approve(address(b), 100 + i);
                vm.prank(creator);
                b.listCurated(address(nft), 100 + i, 0.3 ether);
                _upkeepUntilReady(b);
            }
            if (b.admissionStatus() != 0) continue;
            _drawOnce(b, uint256(keccak256(abi.encode("cycle", i))));
            drawn++;
        }
        _upkeepUntilReady(b);
        require(drawn > 0, "no draws completed");

        // At rest invariant (M4): every active Shape prize is backed by a redeemable token held by the FWA pool.
        // Teardown: close + unlist all shapes + withdraw/recover any curated, then withdraw everything.
        vm.prank(creator);
        b.close();
        assertEq(b.requiredReserve(), 0, "reserve zero while closed");
        assertEq(b.profit(), 0, "profit cleared on close");

        // unlist remaining shapes (collect their backing back to the contract)
        uint256[] memory ids = b.getActiveIds();
        // separate shape ids from curated id
        uint256[] memory shapeIds = new uint256[](ids.length);
        uint256 ns;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = b.items(ids[i]);
            if (kind == 2) shapeIds[ns++] = ids[i];
        }
        assembly {
            mstore(shapeIds, ns)
        }
        if (ns > 0) {
            vm.prank(creator);
            b.unlistShapes(shapeIds);
        }
        // withdraw curated NFT if still listed
        uint256[] memory ids2 = b.getActiveIds();
        for (uint256 i; i < ids2.length; ++i) {
            (uint8 kind,,,,) = b.items(ids2[i]);
            if (kind == 1) {
                vm.prank(creator);
                b.withdrawCurated(ids2[i], creator);
            }
        }
        // collect any residual proceeds
        b.collectProceeds();
        // withdraw everything
        uint256 bal = address(b).balance;
        uint256 creatorBalBefore = creator.balance;
        if (bal > 0) {
            vm.prank(creator);
            b.claimSurplus(bal, creator);
        }
        // M7: nothing stranded in the balancer; all ETH recoverable by creator, no tracked listings remain.
        console.log("draws completed:", drawn);
        console.log("balancer residual after full withdraw (wei):", address(b).balance);
        assertEq(address(b).balance, 0, "M7: ETH stranded in balancer after close+unlist+withdraw");
        assertEq(b.getActiveIds().length, 0, "M7: tracked listings remain after teardown");
        assertEq(p.ownerProceeds(), 0, "M7: proceeds stranded in FWA pool");
    }
}
