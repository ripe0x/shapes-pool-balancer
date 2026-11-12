// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";

/// @notice Mainnet-fork gas measurements used to set keeper reward bounds (docs/GAS.md).
///         Run isolated so each call is a real transaction (intrinsic gas, cold storage, final refunds):
///         forge test --match-path test/Gas.t.sol --isolate -vv
///         Rewards outside creator work are capped by the markup earned (keeperCredit), so a reward above the
///         billed gas can only come out of markup the pool has already earned (collection-games#23).
contract GasBench is ForkBase {
    bytes32 constant KEEPER_PAID = keccak256("KeeperPaid(address,uint256,uint256)");
    uint256 constant KEEPER_MAX_GAS = 3_200_000;

    function setUp() public {
        setUpFork();
        createBalancer(20 ether);
        listCurated(1, 0.3 ether);
        listCurated(2, 0.5 ether);
    }

    function _configure(uint256 target) internal {
        vm.prank(creator);
        balancer.configure(MARKUP, target);
        vm.prank(creator);
        balancer.open();
    }

    function _report(string memory label, uint256 reimbursed) internal {
        (bool ok, bytes memory r) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok, "lastCallGas");
        (, uint64 used,, int64 refunded,) = abi.decode(r, (uint64, uint64, uint64, int64, uint64));
        uint256 billed = used;
        uint256 refund = refunded > 0 ? uint256(int256(refunded)) : 0;
        emit log(label);
        emit log_named_uint("  billed gas (after refund)", billed);
        emit log_named_uint("  refund", refund);
        emit log_named_uint("  measured gas", reimbursed);
    }

    function _upkeep(string memory label) internal returns (uint256 reimbursed) {
        vm.recordLogs();
        upkeep();
        reimbursed = _reimbursed();
        _report(label, reimbursed);
    }

    function _reimbursed() internal returns (uint256 gasPaid) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == KEEPER_PAID) (, gasPaid) = abi.decode(logs[i].data, (uint256, uint256));
        }
    }

    function _drawShapes(uint256 n) internal {
        uint256[] memory ids = buy(buyer, n);
        uint256 lastId = lastListingId();
        for (uint256 i; i < n; ++i) {
            (,,,,,, uint256 slot, uint8 st) = pool.listings(lastId - i);
            require(st == 1, "not active");
            fulfill(ids[i], wordForSlot(slot));
        }
        settle();
    }

    function test_gas_initialFill() public {
        _configure(plan([uint256(20), 10, 10, 0, 0, 0, 0, 0, 0]));
        for (uint256 i; i < 8 && !balancer.canPurchase(buyer); ++i) {
            _upkeep("upkeep: fill step (<= 5 mint+list)");
        }
        assertTrue(balancer.canPurchase(buyer));
    }

    /// @dev Worst pack fill: every op mints a three-Shape pack (0.25 = 2x0.1 + 0.05) and lists it.
    function test_gas_packFillStep() public {
        uint256[16] memory c;
        c[12] = 12;
        _configure(plan16(c));
        // MAX_OPS (5) Shape units: one three-Shape pack per call
        for (uint256 i; i < 13 && !balancer.canPurchase(buyer); ++i) {
            _upkeep("upkeep: pack fill step (1 three-Shape pack mint+list)");
        }
        assertTrue(balancer.canPurchase(buyer));
    }

    function test_gas_replaceOne() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        _drawShapes(1);
        _upkeep("upkeep: reconcile + replace 1 Shape");
    }

    function test_gas_replaceFive() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        _drawShapes(5);
        _upkeep("upkeep: reconcile + replace 5 Shapes");
    }

    function test_gas_replaceFiveMixed() public {
        _configure(plan([uint256(4), 2, 2, 1, 1, 0, 0, 0, 0]));
        fillUp();
        _drawShapes(5);
        _upkeep("upkeep: reconcile + replace 5 Shapes across 4 denominations");
    }

    function test_gas_replaceFivePacks() public {
        uint256[16] memory c;
        c[10] = 10; // 0.03 packs, three Shapes each
        _configure(plan16(c));
        fillUp();
        _drawShapes(5);
        _upkeep("upkeep: reconcile + replace 5 three-Shape packs (staged)");
    }

    /// @dev The worst single upkeep: reconcile MAX_RECONCILE (5) settled draws and restock MAX_OPS (6) Shape units
    ///      as two three-Shape packs. Must stay under KEEPER_MAX_GAS with margin.
    function test_gas_worstCaseUpkeep() public {
        // 44 x 0.01 Shapes carry the weight so 10 draws stay admitted; 10 x 0.03 packs are the prizes drawn.
        uint256[16] memory c;
        c[0] = 44;
        c[10] = 10;
        _configure(plan16(c));
        fillUp();
        assertTrue(balancer.canPurchase(buyer));
        // draw ten 0.03 packs, settling each, without reconciling
        for (uint256 k; k < 10; ++k) {
            uint256 lid = _anyActivePack();
            (,,,,,, uint256 slot,) = pool.listings(lid);
            uint256[] memory ids = buy(buyer, 1);
            fulfill(ids[0], wordForSlot(slot));
            settle();
        }
        assertGe(pool.nextSequenceToProcess() - 1, 10, "ten settled, unreconciled");
        assertEq(balancer.reconciledSequence(), 0);
        // one upkeep: reconcile 10 + restock two three-Shape packs (6 Shape units)
        uint256 g = gasleft();
        uint256 reimbursed = _upkeep("WORST CASE upkeep: reconcile 5 of 10 draws + mint/list 2 three-Shape packs");
        uint256 used = g - gasleft();
        emit log_named_uint("  actual gas used (measured span + overhead)", used);
        assertEq(balancer.reconciledSequence(), 5, "reconciled exactly MAX_RECONCILE");
        assertLt(used, KEEPER_MAX_GAS, "worst upkeep under KEEPER_MAX_GAS");
        assertLt(used, (KEEPER_MAX_GAS * 85) / 100, "with >=15% margin");
        reimbursed;
    }

    /// Heaviest restock: 10 settled draws (one of each Shapes size plus a second 0.01), MAX_RECONCILE of them reconciled,
    /// then MAX_OPS single Shapes across several sizes, each size a separate mint call.
    function test_gas_worstCaseUpkeepShapes() public {
        vm.prank(creator);
        balancer.depositETH{value: 200 ether}();
        _configure(plan([uint256(44), 1, 1, 1, 1, 1, 1, 1, 1]));
        fillUp();
        uint8[10] memory sizes = [uint8(0), 0, 1, 2, 3, 4, 5, 6, 7, 8];
        for (uint256 k; k < 10; ++k) {
            assertTrue(balancer.canPurchase(buyer), "admitted while draws are unreconciled");
            (,,,,,, uint256 slot,) = pool.listings(_anyActiveOfSize(sizes[k]));
            uint256[] memory ids = buy(buyer, 1);
            fulfill(ids[0], wordForSlot(slot));
            settle();
        }
        assertEq(balancer.reconciledSequence(), 0);
        uint256 g = gasleft();
        _upkeep("WORST CASE upkeep: reconcile 5 of 10 draws + mint/list 5 Shapes");
        uint256 used = g - gasleft();
        emit log_named_uint("  actual gas used (measured span + overhead)", used);
        assertEq(balancer.reconciledSequence(), 5, "reconciled exactly MAX_RECONCILE");
        assertLt(used, KEEPER_MAX_GAS, "worst upkeep under KEEPER_MAX_GAS");
    }

    /// Heaviest mix of work: MAX_RECONCILE (5) reconciles while six earlier draws (one each of six sizes) wait to be
    /// restocked; restocking is held back by a temporary mint-fee rise above the accepted fee. One call then restocks
    /// MAX_RESTOCK_SIZES (4) sizes, each a separate mint call.
    function test_gas_worstCaseUpkeepSixSizes() public {
        uint8[6] memory first = [uint8(1), 2, 3, 4, 5, 6];
        uint256 used = _worstAfterHeldRestock(first, "WORST CASE upkeep: reconcile 5 draws + mint/list 4 Shapes in 4 sizes");
        uint16[16] memory a = balancer.getActiveShapes();
        for (uint256 d = 1; d <= 6; ++d) assertEq(a[d], d <= 4 ? 1 : 0, "four sizes per call, smallest first");
        assertLt(used, KEEPER_MAX_GAS, "worst upkeep under KEEPER_MAX_GAS");
    }

    /// MAX_OPS (5) Shape units across the four-size cap: 0.01s, 0.05, 0.1, 0.5.
    function test_gas_worstCaseUpkeepFullUnits() public {
        uint8[6] memory first = [uint8(0), 0, 0, 1, 2, 3];
        uint256 used = _worstAfterHeldRestock(first, "WORST CASE upkeep: reconcile 5 draws + mint/list 5 Shapes in 4 sizes");
        assertLt(used, (KEEPER_MAX_GAS * 90) / 100, "worst upkeep under KEEPER_MAX_GAS with 10% margin");
    }

    /// Draws `first` (restock held back by a temporary mint-fee rise), reconciles them, then draws five large prizes and
    /// measures the one upkeep that reconciles those five and restocks the held prizes.
    function _worstAfterHeldRestock(uint8[6] memory first, string memory label) internal returns (uint256 used) {
        vm.prank(creator);
        balancer.depositETH{value: 600 ether}();
        _configure(plan([uint256(44), 1, 1, 1, 1, 1, 1, 3, 3]));
        fillUp();
        for (uint256 k; k < 6; ++k) _drawSize(first[k]);
        address admin = 0xCB43078C32423F5348Cab5885911C3B5faE217F9;
        uint256 fee = shapes.mintFee();
        vm.prank(admin);
        (bool ok,) = SHAPES.call(abi.encodeWithSignature("setMintFee(uint256)", fee * 2));
        assertTrue(ok);
        upkeep(); // reconcile 5, no restock above the accepted fee
        upkeep(); // reconcile the sixth
        assertEq(balancer.reconciledSequence(), 6);
        vm.prank(admin);
        (ok,) = SHAPES.call(abi.encodeWithSignature("setMintFee(uint256)", fee));
        assertTrue(ok);
        uint8[5] memory big = [uint8(7), 7, 8, 8, 7];
        for (uint256 k; k < 5; ++k) _drawSize(big[k]);
        uint256 g = gasleft();
        _upkeep(label);
        used = g - gasleft();
        emit log_named_uint("  actual gas used (measured span + overhead)", used);
        assertEq(balancer.reconciledSequence(), 11);
    }

    function _drawSize(uint8 d) internal {
        (,,,,,, uint256 slot,) = pool.listings(_anyActiveOfSize(d));
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
    }

    function _anyActiveOfSize(uint8 size) internal view returns (uint256) {
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 d,,,) = balancer.items(ids[i]);
            if (kind != 2 || d != size) continue;
            (,,,,,,, uint8 st) = pool.listings(ids[i]);
            if (st == 1) return ids[i];
        }
        revert("no active prize of that size");
    }

    function _anyActivePack() internal view returns (uint256) {
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 d,,,) = balancer.items(ids[i]);
            if (kind != 2 || d != 10) continue;
            (,,,,,,, uint8 st) = pool.listings(ids[i]);
            if (st == 1) return ids[i];
        }
        revert("no active pack");
    }

    function test_gas_curatedOnlyReconcile() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], 1); // slot 1: the first curated NFT
        settle();
        _upkeep("upkeep: reconcile 1 curated draw");
    }

    function test_gas_refundOnlyBatch() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        buy(buyer, 1); // never fulfilled: refunded after the word deadline
        vm.roll(block.number + 40);
        pool.processAcquisitions(1);
        _upkeep("upkeep: reconcile refund-only batch");
    }

    function test_gas_unlistShapes20() public {
        _configure(plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        uint256[] memory all = new uint256[](20);
        uint256[] memory ids = balancer.getActiveIds();
        uint256 n;
        for (uint256 i; i < ids.length && n < 20; ++i) {
            (uint8 kind,,,,) = balancer.items(ids[i]);
            if (kind == 2) all[n++] = ids[i];
        }
        vm.prank(creator);
        balancer.close();
        vm.prank(creator);
        balancer.unlistShapes(all);
        _report("unlistShapes(20): withdraw + redeem 20 Shapes (creator)", 0);
    }

    function test_gas_recoverRefunded() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        uint256 lid = lastListingId();
        (,,, uint256 tokenId,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        vm.mockCallRevert(SHAPES, abi.encodeWithSignature("transferFrom(address,address,uint256)", address(pool), buyer, tokenId), "blocked");
        fulfill(ids[0], wordForSlot(slot));
        settle();
        vm.clearMockedCalls();
        upkeep();
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(buyer);
        pool.refundFailedDelivery(lid);
        vm.prank(creator);
        balancer.recoverRefunded(lid, creator);
        _report("recoverRefunded: recover + redeem a Shape (creator)", 0);
    }

    function test_gas_canPurchase() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        uint256 g = gasleft();
        vm.prank(address(pool));
        balancer.canPurchase(buyer);
        _report("canPurchase (operator check under the FWA 100k stipend)", 0);
        emit log_named_uint("  canPurchase gas", g - gasleft());
    }

    function test_gas_purchaseWithOperator() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        (,, uint256 total) = pool.quoteAcquisitionPrice(5);
        uint256 v = pool.inventoryVersion();
        vm.prank(buyer, buyer);
        pool.acquireBatch{value: total}(buyer, 5, 0, 0, 10_000, v, block.timestamp + 1);
        _report("FWA acquireBatch(5) incl. operator check", 0);
    }

    function test_gas_createBalancer() public {
        address c = makeAddr("gasCreator");
        vm.prank(c);
        factory.createBalancer(bytes32(0));
        _report("createBalancer (clone + FWA pool + operator + approval)", 0);
    }

    /*////////////////////// keeper profitability at the gas-price cap //////////////////////*/

    function _profitAtCap(string memory label) internal returns (int256 pnl) {
        return _profitAt(label, 4.95 gwei);
    }

    function _profitAt(string memory label, uint256 basefee) internal returns (int256 pnl) {
        vm.fee(basefee);
        vm.txGasPrice(basefee + 0.05 gwei);
        vm.recordLogs();
        upkeep();
        uint256 reward;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == KEEPER_PAID) (reward,) = abi.decode(logs[i].data, (uint256, uint256));
        }
        (bool ok, bytes memory r) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok);
        (, uint64 billed,,,) = abi.decode(r, (uint64, uint64, uint64, int64, uint64));
        pnl = int256(reward) - int256(uint256(billed) * (basefee + 0.05 gwei));
        emit log(label);
        emit log_named_uint("  billed gas", billed);
        emit log_named_decimal_int("  keeper PnL (ETH)", pnl, 18);
        vm.fee(0.5 gwei);
        vm.txGasPrice(1 gwei);
    }

    /// Cheapest pool shape: a 0.01 Shape at 15% earns 0.0005 of markup after its mint fee, which is all the keeper
    /// can be paid for replacing it. That covers the call to ~0.5 gwei; above that the keeper is short (an honest
    /// keeper waits for more draws), and the pool never pays more than the markup.
    function test_profitAtCap_replaceOneCheapPool() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        _drawShapes(1);
        uint256 snap = vm.snapshotState();
        assertGe(_profitAt("replace 1 Shape, cheap pool, 0.5 gwei", 0.5 gwei), 0);
        vm.revertToState(snap);
        assertLt(_profitAt("replace 1 Shape, cheap pool, 4.95 gwei", 4.95 gwei), 0);
        assertEq(balancer.keeperCredit(), 0, "the whole markup went to the keeper, no more");
    }

    function test_profitAtCap_replaceOne() public {
        _configure(plan([uint256(2), 2, 2, 0, 0, 0, 0, 0, 0]));
        fillUp();
        _drawShapes(1);
        assertGe(_profitAtCap("replace 1 Shape, typical pool"), 0);
    }

    function test_profitAtCap_replaceFiveMixed() public {
        _configure(plan([uint256(4), 2, 2, 1, 1, 0, 0, 0, 0]));
        fillUp();
        _drawShapes(5);
        assertGe(_profitAtCap("replace 5 Shapes, 4 denominations"), 0);
    }

    function test_profitAtCap_fillSteps() public {
        _configure(plan([uint256(20), 10, 10, 0, 0, 0, 0, 0, 0]));
        // 40 Shapes at MAX_OPS (5) per call
        for (uint256 i; i < 12 && !balancer.canPurchase(buyer); ++i) {
            assertGe(_profitAtCap("fill step"), 0);
        }
        assertTrue(balancer.canPurchase(buyer));
    }

    /// A curated draw needs no restock, so the upkeep only reconciles it, paid from that draw's markup
    /// (0.3 ETH at 15% earns 0.045).
    function test_profitAtCap_curatedReconcile() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        uint256 lid = listCurated(3, 0.3 ether); // listed after configure, at MARKUP
        fillUp();
        (,,,,,, uint256 slot,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        assertGe(_profitAtCap("reconcile 1 curated draw"), 0);
    }

    /*////////////////////// break-even basefee per upkeep type //////////////////////*/

    function _sweep(string memory label) internal returns (uint256 maxProfitable) {
        uint256[8] memory fees = [uint256(0.08 gwei), 0.5 gwei, 1 gwei, 2 gwei, 2.8 gwei, 3.5 gwei, 4.2 gwei, 4.95 gwei];
        emit log(label);
        for (uint256 i; i < fees.length; ++i) {
            uint256 snap = vm.snapshotState();
            int256 pnl = _profitAt("", fees[i]);
            vm.revertToState(snap);
            if (pnl >= 0) maxProfitable = fees[i];
        }
        emit log_named_decimal_uint("  => highest profitable basefee tested (gwei)", maxProfitable, 9);
    }

    function test_breakEven_replaceOneTypical() public {
        _configure(plan([uint256(2), 2, 2, 0, 0, 0, 0, 0, 0]));
        fillUp();
        _drawShapes(1);
        assertEq(_sweep("replace 1 Shape, typical pool (purchase-caused, credit)"), 4.95 gwei);
    }

    function test_breakEven_replaceOneCheap() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        _drawShapes(1);
        assertEq(_sweep("replace 1 Shape, 0.01-only pool (purchase-caused, credit-limited)"), 0.5 gwei);
    }

    function test_breakEven_fillStep() public {
        _configure(plan([uint256(20), 10, 10, 0, 0, 0, 0, 0, 0]));
        assertEq(_sweep("fill step, 5 mints (creator-caused, full incentive)"), 4.95 gwei);
    }
}
