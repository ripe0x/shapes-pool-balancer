// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../src/BalancerFactory.sol";
import {IFWAPool, IERC721Min, IShapes} from "../../../src/interfaces/External.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";

contract EconomicProbe is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant BAYC = 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;
    address constant CREATOR = 0x46EFbAedc92067E6d60E84ED6395099723252496;
    address constant KEEPER = address(0xBEEF);
    address constant PLAYER = address(0xCAFE);
    address constant VRF_COORDINATOR = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;

    PoolBalancer b;
    IFWAPool p;
    uint256 shapesBalanceBefore;

    function setUp() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.05 gwei);
        shapesBalanceBefore = SHAPES.balance;
        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        ShapePacks packs = new ShapePacks(SHAPES, address(renderer), CREATOR, "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        BalancerFactory factory = new BalancerFactory(address(impl), CREATOR);
        vm.deal(CREATOR, 10 ether);
        vm.deal(KEEPER, 1 ether);
        vm.deal(PLAYER, 1 ether);
        vm.startPrank(CREATOR);
        b = PoolBalancer(payable(factory.createBalancer{value: 4 ether}(bytes32(uint256(1)))));
        p = b.pool();
        uint256 plan = uint256(20) | (uint256(10) << 16) | (uint256(2) << 32) | (uint256(1) << 48)
            | (uint256(7) << (16 * 9));
        b.configure(1500, plan);
        IERC721Min(BAYC).approve(address(b), 1);
        b.listCurated(BAYC, 1, 0.3 ether);
        b.open();
        vm.stopPrank();
        for (uint256 i; i < 20 && b.creatorWork(); ++i) {
            vm.prank(KEEPER);
            b.performUpkeep();
        }
        assertFalse(b.creatorWork(), "opening stockup unfinished");
        assertEq(b.admissionStatus(), 0, "not open");
    }

    function testOpeningAndRetirementLedger() public {
        uint256 fee = IShapes(SHAPES).mintFee();
        assertEq(fee, 0.001 ether, "pinned fee changed");
        assertEq(SHAPES.balance, shapesBalanceBefore + 1.54 ether + 47 * fee, "Shapes did not receive backing and fees");
        uint256 stockBalance = address(b).balance;
        uint256 count;
        uint256[] memory ids = b.getActiveIds();
        bool[16] memory seen;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 denom,,, uint112 price) = b.items(ids[i]);
            if (kind == 2) {
                ++count;
                if (!seen[denom]) {
                    seen[denom] = true;
                    console2.log("first prize denomination", denom);
                    console2.log("first prize price", price);
                }
            }
        }
        assertEq(count, 40, "listed prize count");
        console2.log("opening pool ETH", stockBalance);
        console2.log("opening keeper credit", b.keeperCredit());
        console2.log("opening FWA quote", p.acquisitionFee());
        console2.log("FWA total weight", p.totalWeight());
        console2.log("FWA weighted backing total", p.weightedBackingTotal());
        console2.log("opening reserve", b.requiredReserve());
        assertEq(b.keeperCredit(), 0, "creator-started stock creates keeper credit");

        vm.prank(CREATOR);
        b.close();
        while (true) {
            ids = b.getActiveIds();
            uint256[] memory chunk = new uint256[](20);
            uint256 n;
            for (uint256 i; i < ids.length && n < 20; ++i) {
                (uint8 kind,,,,) = b.items(ids[i]);
                if (kind == 2) chunk[n++] = ids[i];
            }
            if (n == 0) break;
            assembly ("memory-safe") { mstore(chunk, n) }
            vm.prank(CREATOR);
            b.unlistShapes(chunk);
        }
        assertEq(address(b).balance, stockBalance + 1.54 ether, "backing did not return exactly");
        assertEq(SHAPES.balance, shapesBalanceBefore + 47 * fee, "backing remained in Shapes after redemption");
        assertEq(b.requiredReserve(), 0, "closed reserve");
        ids = b.getActiveIds();
        assertEq(ids.length, 1, "curated item only");
        vm.prank(CREATOR);
        b.withdrawCurated(ids[0], CREATOR);
        assertEq(IERC721Min(BAYC).ownerOf(1), CREATOR, "curated NFT not returned");
        vm.prank(CREATOR);
        b.retire();
        uint256 reclaim = address(b).balance;
        vm.prank(CREATOR);
        b.claimSurplus(reclaim, CREATOR);
        assertEq(address(b).balance, 0, "ETH stranded in Balancer");
        console2.log("retired creator reclaim", reclaim);
        console2.log("initial unrepaid fees and keeper pay", 4 ether - reclaim);
    }

    function testDrawRestockWinnerAndCreatorRoundTrip() public {
        (uint256 fee, uint256 vrf, uint256 total) = p.quoteAcquisitionPrice(1);
        assertEq(total, fee + vrf, "quote decomposition");
        uint256 payerBefore = address(this).balance;
        vm.prank(PLAYER);
        uint256 requestId = p.acquire{value: total}(PLAYER, fee, 0, 10_000, p.inventoryVersion(), block.timestamp + 1 days);
        assertEq(payerBefore - address(this).balance, total, "caller funded quote");
        assertEq(p.unsettledAcquisitionCount(), 1, "draw did not enter flight");
        console2.log("draw fee", fee);
        console2.log("vrf fee", vrf);
        console2.log("status at one in-flight draw", b.admissionStatus());

        vm.roll(block.number + 1);
        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("lane-b-real-vrf-delivery"));
        vm.prank(VRF_COORDINATOR);
        p.rawFulfillRandomWords(requestId, words);
        p.processAcquisitions(5);
        (,,, uint256 lid, uint8 acquisitionStatus,) = p.acquisitions(requestId);
        console2.log("drawn listing", lid);
        console2.log("acquisition status", acquisitionStatus);
        assertEq(acquisitionStatus, 2, "draw not fulfilled");
        (uint8 kind, uint8 denom,, uint112 base, uint112 price) = b.items(lid);
        console2.log("drawn kind", kind);
        console2.log("drawn denom", denom);
        console2.log("drawn base", base);
        console2.log("drawn price", price);
        assertEq(kind, 2, "word did not draw Shape/Packs prize");

        uint256 creditBefore = b.keeperCredit();
        uint256 poolBefore = address(b).balance;
        uint256 keeperBefore = KEEPER.balance;
        vm.prank(KEEPER);
        uint256 reward = b.performUpkeep();
        (bool gasOk, bytes memory rawGas) = address(vm).staticcall(abi.encodeWithSignature("lastFrameGas()"));
        assertTrue(gasOk, "gas frame unavailable");
        assertEq(rawGas.length, 160, "unexpected gas frame ABI");
        (, uint64 gasTotal, , int64 refund, ) = abi.decode(rawGas, (uint64, uint64, uint64, int64, uint64));
        assertGe(refund, 0, "negative refund");
        uint256 gasUsed = uint256(gasTotal);
        uint256 frameNetGas = gasUsed - uint256(int256(refund));
        uint256 creditAfter = b.keeperCredit();
        assertEq(keeperBefore + reward, KEEPER.balance, "keeper receipt");
        assertEq(creditBefore + b.restockFee() - reward, creditAfter, "fee credit ledger for one Shape");
        assertEq(b.reconciledSequence(), p.lastIssuedSequence(), "draw not reconciled");
        console2.log("keeper reward", reward);
        console2.log("upkeep frame gas total", gasTotal);
        console2.log("upkeep frame refund", refund);
        console2.log("upkeep in-process frame net gas", frameNetGas);
        console2.log("upkeep in-process frame net cost", frameNetGas * tx.gasprice);
        console2.log("keeper credit after", creditAfter);
        console2.log("pool balance delta", int256(address(b).balance) - int256(poolBefore));

        (,,, uint256 wonTokenId,,,,) = p.listings(lid);
        assertEq(IShapes(SHAPES).ownerOf(wonTokenId), PLAYER, "winner did not receive Shape");
        assertEq(IShapes(SHAPES).backingOf(wonTokenId), 0.01 ether, "winner backing changed");
        vm.prank(CREATOR);
        b.close();
        while (true) {
            uint256[] memory ids = b.getActiveIds();
            uint256[] memory chunk = new uint256[](20);
            uint256 n;
            for (uint256 i; i < ids.length && n < 20; ++i) {
                (uint8 itemKind,,,,) = b.items(ids[i]);
                if (itemKind == 2) chunk[n++] = ids[i];
            }
            if (n == 0) break;
            assembly ("memory-safe") { mstore(chunk, n) }
            vm.prank(CREATOR);
            b.unlistShapes(chunk);
        }
        assertEq(SHAPES.balance, shapesBalanceBefore + 0.01 ether + 48 * IShapes(SHAPES).mintFee(), "Shape backing after creator unlist");
        uint256[] memory remaining = b.getActiveIds();
        assertEq(remaining.length, 1, "unexpected remaining inventory");
        vm.prank(CREATOR);
        b.withdrawCurated(remaining[0], CREATOR);
        vm.prank(CREATOR);
        b.retire();
        uint256 creatorReclaim = address(b).balance;
        vm.prank(CREATOR);
        b.claimSurplus(creatorReclaim, CREATOR);
        assertEq(address(b).balance, 0, "creator ETH stranded after draw lifecycle");
        uint256 winnerBefore = PLAYER.balance;
        uint256[] memory wonIds = new uint256[](1);
        wonIds[0] = wonTokenId;
        vm.prank(PLAYER);
        assertEq(IShapes(SHAPES).redeemBatch(wonIds), 0.01 ether, "winner redemption amount");
        assertEq(PLAYER.balance - winnerBefore, 0.01 ether, "winner did not receive exact backing");
        assertEq(SHAPES.balance, shapesBalanceBefore + 48 * IShapes(SHAPES).mintFee(), "Shape backing stranded after winner redemption");
        console2.log("post-draw creator reclaim", creatorReclaim);
    }

    function testGasSweepOneDrawOneRestock() public {
        uint256[8] memory baseFees = [uint256(0), 0.05 gwei, 0.1 gwei, 1 gwei, 3 gwei, 4.9 gwei, 5.1 gwei, 10 gwei];
        for (uint256 i; i < baseFees.length; ++i) {
            uint256 snapshot = vm.snapshotState();
            uint256 baseFee = baseFees[i];
            uint256 bid = baseFee == 0 ? 0 : baseFee + 0.05 gwei;
            vm.fee(baseFee);
            vm.txGasPrice(bid);
            uint256 listingPrice = baseFee + 0.05 gwei;
            if (listingPrice > 5 gwei) listingPrice = 5 gwei;
            uint256 expectedFee = 900_000 * listingPrice + 0.0002 ether;
            assertEq(b.restockFee(), expectedFee, "restock price formula");

            (uint256 fee,, uint256 total) = p.quoteAcquisitionPrice(1);
            vm.prank(PLAYER);
            uint256 requestId = p.acquire{value: total}(PLAYER, fee, 0, 10_000, p.inventoryVersion(), block.timestamp + 1 days);
            vm.roll(block.number + 1);
            uint256[] memory words = new uint256[](1);
            words[0] = uint256(keccak256("lane-b-real-vrf-delivery"));
            vm.prank(VRF_COORDINATOR);
            p.rawFulfillRandomWords(requestId, words);
            p.processAcquisitions(5);
            (,,, uint256 lid, uint8 status,) = p.acquisitions(requestId);
            assertEq(status, 2, "draw not fulfilled");
            (uint8 kind, uint8 denom,,,) = b.items(lid);
            assertEq(kind, 2, "non-prize draw");
            assertEq(denom, 0, "not a one-Shape draw");

            uint256 gasBefore = gasleft();
            vm.prank(KEEPER);
            uint256 reward = b.performUpkeep();
            uint256 gasUsed = gasBefore - gasleft();
            uint256 costUpperBound = gasUsed * bid;
            assertLe(reward, expectedFee, "keeper exceeded fee credit");
            assertEq(b.keeperCredit(), expectedFee - reward, "credit mismatch");
            console2.log("base fee wei", baseFee);
            console2.log("quote total wei", total);
            console2.log("restock fee wei", expectedFee);
            console2.log("keeper reward wei", reward);
            console2.log("call gas pre-refund upper bound", gasUsed);
            console2.log("keeper spread versus upper-bound cost wei", int256(reward) - int256(costUpperBound));
            vm.revertToState(snapshot);
        }
    }

    function testQuoteToInclusionBasefeeJump() public {
        vm.fee(0.1 gwei);
        vm.txGasPrice(0.15 gwei);
        (uint256 oldFee, uint256 oldVrf, uint256 oldTotal) = p.quoteAcquisitionPrice(1);
        vm.roll(block.number + 1);
        vm.fee(3 gwei);
        vm.txGasPrice(3.05 gwei);
        (uint256 newFee, uint256 newVrf, uint256 newTotal) = p.quoteAcquisitionPrice(1);
        assertEq(oldFee, newFee, "inventory fee changed without inventory change");
        assertGt(newVrf, oldVrf, "VRF service quote did not track basefee");
        console2.log("old total", oldTotal);
        console2.log("new total", newTotal);
        console2.log("VRF jump", newVrf - oldVrf);
        uint256 poolBalanceBefore = address(p).balance;
        uint256 payerBefore = address(this).balance;
        vm.prank(PLAYER);
        (bool accepted, bytes memory reason) = address(p).call{value: oldTotal}(
            abi.encodeCall(IFWAPool.acquire, (PLAYER, oldFee, 0, 10_000, p.inventoryVersion(), block.timestamp + 1 days))
        );
        assertFalse(accepted, "stale quote was accepted");
        bytes4 selector;
        assembly ("memory-safe") { selector := mload(add(reason, 32)) }
        console2.logBytes4(selector);
        assertEq(p.unsettledAcquisitionCount(), 0, "reverted draw changed state");
        vm.prank(PLAYER);
        uint256 requestId = p.acquire{value: newTotal}(PLAYER, newFee, 0, 10_000, p.inventoryVersion(), block.timestamp + 1 days);
        assertEq(p.unsettledAcquisitionCount(), 1, "updated quote rejected");
        assertEq(payerBefore - address(this).balance, newTotal, "unexpected payer charge");
        (,, uint256 escrowed,,,) = p.acquisitions(requestId);
        console2.log("pool balance delta", int256(address(p).balance) - int256(poolBalanceBefore));
        console2.log("acquisition escrowed", escrowed);
    }

    function testReserveAfterTwoLargeWinsAtMaxWithdrawal() public {
        vm.startPrank(CREATOR);
        b.close();
        vm.stopPrank();
        while (true) {
            uint256[] memory ids = b.getActiveIds();
            uint256[] memory chunk = new uint256[](20);
            uint256 n;
            for (uint256 i; i < ids.length && n < 20; ++i) {
                (uint8 kind,,,,) = b.items(ids[i]);
                if (kind == 2) chunk[n++] = ids[i];
            }
            if (n == 0) break;
            assembly ("memory-safe") { mstore(chunk, n) }
            vm.prank(CREATOR);
            b.unlistShapes(chunk);
        }
        uint256 plan = uint256(5) | (uint256(5) << 48); // five 0.01 and five 0.5 ETH Shapes
        vm.startPrank(CREATOR);
        b.configure(1500, plan);
        b.open();
        vm.stopPrank();
        for (uint256 i; i < 10 && b.creatorWork(); ++i) {
            vm.prank(KEEPER);
            b.performUpkeep();
        }
        assertFalse(b.creatorWork(), "heavy mix stockup unfinished");
        assertEq(b.admissionStatus(), 0, "heavy mix closed");
        uint256 withdrawable = b.withdrawableSurplus();
        assertGt(withdrawable, 0, "no surplus to test max claim");
        vm.prank(CREATOR);
        b.claimSurplus(withdrawable, CREATOR);
        assertEq(address(b).balance, b.requiredReserve(), "claim did not leave exact reserve");
        console2.log("pre-burst reserve", b.requiredReserve());
        console2.log("pre-burst pool ETH", address(b).balance);
        console2.log("creator max withdrawal", withdrawable);

        (uint256 batchFee,, uint256 batchTotal) = p.quoteAcquisitionPrice(2);
        vm.prank(PLAYER);
        uint256[] memory requestIds = p.acquireBatch{value: batchTotal}(
            PLAYER, 2, batchFee, 0, 10_000, p.inventoryVersion(), block.timestamp + 1 days
        );
        assertEq(requestIds.length, 2, "two-draw batch not issued");
        assertEq(p.unsettledAcquisitionCount(), 2, "batch not in flight");
        console2.log("two-draw player total", batchTotal);

        vm.roll(block.number + 1);
        uint256 triesFirst = _fulfillSelectingDenom(requestIds[0], 3);
        uint256 triesSecond = _fulfillSelectingDenom(requestIds[1], 3);
        console2.log("first large-win trials", triesFirst);
        console2.log("second large-win trials", triesSecond);
        assertEq(p.unsettledAcquisitionCount(), 0, "batch not settled");
        uint256 proceeds = p.ownerProceeds();
        console2.log("settled FWA owner proceeds", proceeds);
        console2.log("pool ETH before upkeep", address(b).balance);

        vm.prank(KEEPER);
        b.performUpkeep();
        uint16[16] memory have = b.getActiveShapes();
        console2.log("large prizes after one upkeep", have[3]);
        console2.log("pool ETH after one upkeep", address(b).balance);
        console2.log("reserve after one upkeep", b.requiredReserve());
        console2.log("withdrawable after one upkeep", b.withdrawableSurplus());
        assertLt(have[3], 5, "target restored despite reserve hypothesis");
        vm.prank(KEEPER);
        (bool canRun, bytes memory reason) = address(b).call(abi.encodeCall(PoolBalancer.performUpkeep, ()));
        assertFalse(canRun, "keeper unexpectedly restored target");
        bytes4 selector;
        assembly ("memory-safe") { selector := mload(add(reason, 32)) }
        assertEq(selector, PoolBalancer.NoUpkeepNeeded.selector, "unexpected upkeep failure");
        console2.log("admission status with unfunded target", b.admissionStatus());
    }

    function testBalancedLaunchMixReserveAfterLargeAndMediumWins() public {
        uint256 withdrawable = b.withdrawableSurplus();
        vm.prank(CREATOR);
        b.claimSurplus(withdrawable, CREATOR);
        assertEq(address(b).balance, b.requiredReserve(), "claim did not leave exact reserve");
        console2.log("Balanced pre-burst reserve", b.requiredReserve());
        console2.log("Balanced creator max withdrawal", withdrawable);
        (uint256 batchFee,, uint256 batchTotal) = p.quoteAcquisitionPrice(2);
        vm.prank(PLAYER);
        uint256[] memory requestIds = p.acquireBatch{value: batchTotal}(
            PLAYER, 2, batchFee, 0, 10_000, p.inventoryVersion(), block.timestamp + 1 days
        );
        vm.roll(block.number + 1);
        uint256 triesLarge = _fulfillSelectingDenom(requestIds[0], 3);
        uint256 triesMedium = _fulfillSelectingDenom(requestIds[1], 2);
        console2.log("Balanced large-win trials", triesLarge);
        console2.log("Balanced medium-win trials", triesMedium);
        console2.log("Balanced two-draw player total", batchTotal);
        console2.log("Balanced FWA owner proceeds", p.ownerProceeds());
        vm.prank(KEEPER);
        b.performUpkeep();
        uint16[16] memory have = b.getActiveShapes();
        console2.log("Balanced 0.1 prizes after upkeep", have[2]);
        console2.log("Balanced 0.5 prizes after upkeep", have[3]);
        console2.log("Balanced pool ETH after upkeep", address(b).balance);
        console2.log("Balanced required reserve after upkeep", b.requiredReserve());
        assertEq(have[2], 2, "medium prize not restocked");
        assertEq(have[3], 0, "large prize unexpectedly restocked");
        vm.prank(KEEPER);
        (bool canRun,) = address(b).call(abi.encodeCall(PoolBalancer.performUpkeep, ()));
        assertFalse(canRun, "second upkeep unexpectedly funded");
        assertEq(b.admissionStatus(), 0, "admission behavior changed");
    }

    function testFiveInflightGateAndReconcile() public {
        uint256 beforeReserve = b.requiredReserve();
        (uint256 fee,, uint256 total) = p.quoteAcquisitionPrice(5);
        vm.prank(PLAYER);
        uint256[] memory ids = p.acquireBatch{value: total}(
            PLAYER, 5, fee, 0, 10_000, p.inventoryVersion(), block.timestamp + 1 days
        );
        assertEq(ids.length, 5, "five draws not issued");
        assertEq(p.unsettledAcquisitionCount(), 5, "five draws not in flight");
        assertEq(b.admissionStatus(), 4, "busy gate failed");
        assertEq(b.prizeWeight(), b.targetWeight(), "unsettled draw changed tracked prize weight");
        assertGt(b.requiredReserve(), beforeReserve, "in-flight reserve did not rise");
        console2.log("five in-flight reserve", b.requiredReserve());
        console2.log("five in-flight status", b.admissionStatus());
        vm.roll(block.number + 1);
        for (uint256 i; i < ids.length; ++i) {
            uint256[] memory words = new uint256[](1);
            words[0] = uint256(keccak256(abi.encodePacked("lane-b-five", i)));
            vm.prank(VRF_COORDINATOR);
            p.rawFulfillRandomWords(ids[i], words);
            p.processAcquisitions(5);
        }
        assertEq(p.unsettledAcquisitionCount(), 0, "five draws not settled");
        vm.prank(KEEPER);
        b.performUpkeep();
        assertEq(b.reconciledSequence(), p.lastIssuedSequence(), "five draws not reconciled");
        console2.log("status after five-draw upkeep", b.admissionStatus());
        console2.log("credit after five-draw upkeep", b.keeperCredit());
    }

    function testKeeperOverbidAndGasLimitDoNotInflateReward() public {
        vm.fee(3 gwei);
        vm.txGasPrice(3.05 gwei);
        (uint256 fee,, uint256 total) = p.quoteAcquisitionPrice(1);
        vm.prank(PLAYER);
        uint256 requestId = p.acquire{value: total}(PLAYER, fee, 0, 10_000, p.inventoryVersion(), block.timestamp + 1 days);
        vm.roll(block.number + 1);
        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("lane-b-real-vrf-delivery"));
        vm.prank(VRF_COORDINATOR);
        p.rawFulfillRandomWords(requestId, words);
        p.processAcquisitions(5);
        (,,, uint256 lid, uint8 status,) = p.acquisitions(requestId);
        (uint8 kind, uint8 denom,,,) = b.items(lid);
        assertEq(status, 2, "draw not fulfilled");
        assertEq(kind, 2, "not a prize");
        assertEq(denom, 0, "not a one-Shape prize");
        uint256 snapshot = vm.snapshotState();

        uint256 gasBefore = gasleft();
        vm.prank(KEEPER);
        (bool successA, bytes memory retA) = address(b).call{gas: 4_000_000}(abi.encodeCall(PoolBalancer.performUpkeep, ()));
        assertTrue(successA, "normal bid upkeep failed");
        uint256 rewardA = abi.decode(retA, (uint256));
        uint256 gasA = gasBefore - gasleft();
        vm.revertToState(snapshot);

        vm.txGasPrice(10 gwei);
        gasBefore = gasleft();
        vm.prank(KEEPER);
        (bool successB, bytes memory retB) = address(b).call{gas: 10_000_000}(abi.encodeCall(PoolBalancer.performUpkeep, ()));
        assertTrue(successB, "overbid upkeep failed");
        uint256 rewardB = abi.decode(retB, (uint256));
        uint256 gasB = gasBefore - gasleft();
        assertEq(rewardA, rewardB, "overbid or gas limit inflated reward");
        console2.log("normal reward", rewardA);
        console2.log("overbid reward", rewardB);
        console2.log("normal call pre-refund gas", gasA);
        console2.log("overbid call pre-refund gas", gasB);
        console2.log("normal spread vs upper-bound cost", int256(rewardA) - int256(gasA * 3.05 gwei));
        console2.log("overbid spread vs upper-bound cost", int256(rewardB) - int256(gasB * 10 gwei));
    }

    function testCheapShapeMixFiveDrawsAfterMaxWithdrawal() public {
        vm.startPrank(CREATOR);
        b.close();
        b.configure(1500, 20); // retain only the 20 listed 0.01 ETH Shapes
        vm.stopPrank();
        while (true) {
            uint256[] memory ids = b.getActiveIds();
            uint256[] memory chunk = new uint256[](20);
            uint256 n;
            for (uint256 i; i < ids.length && n < 20; ++i) {
                (uint8 kind, uint8 denom,,,) = b.items(ids[i]);
                if (kind == 2 && denom != 0) chunk[n++] = ids[i];
            }
            if (n == 0) break;
            assembly ("memory-safe") { mstore(chunk, n) }
            vm.prank(CREATOR);
            b.unlistShapes(chunk);
        }
        vm.prank(CREATOR);
        b.open();
        assertEq(b.admissionStatus(), 0, "cheap mix closed");
        uint256 claim = b.withdrawableSurplus();
        vm.prank(CREATOR);
        b.claimSurplus(claim, CREATOR);
        assertEq(address(b).balance, b.requiredReserve(), "not at max withdrawal");
        console2.log("cheap mix pre-burst reserve", b.requiredReserve());
        console2.log("cheap mix creator max claim", claim);
        (uint256 fee,, uint256 total) = p.quoteAcquisitionPrice(5);
        vm.prank(PLAYER);
        uint256[] memory requests = p.acquireBatch{value: total}(
            PLAYER, 5, fee, 0, 10_000, p.inventoryVersion(), block.timestamp + 1 days
        );
        vm.roll(block.number + 1);
        for (uint256 i; i < requests.length; ++i) {
            uint256[] memory words = new uint256[](1);
            words[0] = uint256(keccak256(abi.encodePacked("lane-b-cheap", i)));
            vm.prank(VRF_COORDINATOR);
            p.rawFulfillRandomWords(requests[i], words);
            p.processAcquisitions(5);
            (,,, uint256 lid, uint8 status,) = p.acquisitions(requests[i]);
            (uint8 kind, uint8 denom,,,) = b.items(lid);
            assertEq(status, 2, "cheap draw not fulfilled");
            assertEq(kind, 2, "cheap draw chose curated NFT");
            assertEq(denom, 0, "cheap draw chose other denomination");
        }
        vm.prank(KEEPER);
        b.performUpkeep();
        uint16[16] memory have = b.getActiveShapes();
        console2.log("cheap mix restocked 0.01 Shapes", have[0]);
        console2.log("cheap mix pool ETH after burst", address(b).balance);
        console2.log("cheap mix required reserve after burst", b.requiredReserve());
        assertEq(have[0], 20, "cheap mix failed target restoration");
        assertEq(b.admissionStatus(), 0, "cheap mix did not reopen");
    }

    function _fulfillSelectingDenom(uint256 requestId, uint8 wantedDenom) internal returns (uint256 trials) {
        for (uint256 word = 1; word <= 5000; ++word) {
            uint256 snapshot = vm.snapshotState();
            uint256[] memory words = new uint256[](1);
            words[0] = uint256(keccak256(abi.encodePacked("lane-b-heavy", requestId, word)));
            vm.prank(VRF_COORDINATOR);
            p.rawFulfillRandomWords(requestId, words);
            p.processAcquisitions(5);
            (,,, uint256 lid, uint8 status,) = p.acquisitions(requestId);
            (uint8 kind, uint8 denom,,,) = b.items(lid);
            if (status == 2 && kind == 2 && denom == wantedDenom) return word;
            vm.revertToState(snapshot);
        }
        fail("requested prize not selected within 5000 real deliveries");
    }
}
