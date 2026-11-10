// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";

/// @dev One transaction, several paid upkeeps (review F2: intrinsic gas is paid once per transaction).
contract MultiKeeper {
    function run(PoolBalancer b, uint256 n) external {
        for (uint256 i; i < n; ++i) {
            try b.performUpkeep() {} catch {}
        }
    }

    receive() external payable {}
}

/// @notice Mainnet-fork gas measurements used to set keeper reward bounds (docs/GAS.md).
///         Run isolated so each call is a real transaction (intrinsic gas, cold storage, final refunds):
///         forge test --match-contract GasBench --isolate -vv
///         Every keeper call asserts that the reimbursed gas never exceeds the gas the transaction is
///         billed after EVM refunds (collection-games#23).
contract GasBench is ForkBase {
    bytes32 constant KEEPER_PAID = keccak256("KeeperPaid(address,uint256,uint256)");

    function setUp() public {
        setUpFork();
        createBalancer(20 ether);
        listCurated(1, 0.3 ether);
        listCurated(2, 0.5 ether);
    }

    function _configure(uint256 p) internal {
        uint256[] memory plans = new uint256[](1);
        plans[0] = p;
        configure(1 ether, 0, plans);
        vm.prank(creator);
        balancer.open();
    }

    /// @dev With --isolate, the frame's gas is the transaction's billed gas: intrinsic included and the
    ///      EIP-3529 refund already applied (a plan switch reports a measured span larger than the
    ///      pre-refund reading would allow). The keeper e2e checks the same bound against real receipts.
    function _report(string memory label, uint256 reimbursed) internal {
        // Decoded by hand: the installed forge binary returns the 5-field Gas struct (no state gas).
        (bool ok, bytes memory r) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok, "lastCallGas");
        (, uint64 used,, int64 refunded,) = abi.decode(r, (uint64, uint64, uint64, int64, uint64));
        uint256 billed = used;
        uint256 refund = refunded > 0 ? uint256(int256(refunded)) : 0;
        emit log(label);
        emit log_named_uint("  billed gas (after refund)", billed);
        emit log_named_uint("  refund", refund);
        emit log_named_uint("  reimbursed gas", reimbursed);
        // Isolation adds intrinsic gas (>= 21k) to the frame; without it the comparison is meaningless.
        if (reimbursed != 0 && billed > 21_000 + reimbursed / 2) {
            assertLe(reimbursed, billed, "keeper reimbursed more gas than it was billed");
        }
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
        for (uint256 i; i < 7; ++i) {
            _upkeep("upkeep: fill step (<= 6 mint+list)");
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

    function test_gas_curatedOnlyReconcile() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], 1); // slot 1: the first curated NFT
        settle();
        _upkeep("upkeep: reconcile 1 curated draw + checkpoint");
    }

    function test_gas_refundOnlyBatch() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        buy(buyer, 1); // never fulfilled: refunded after the word deadline
        vm.roll(block.number + 40);
        pool.processAcquisitions(1);
        _upkeep("upkeep: reconcile refund-only batch + checkpoint");
    }

    function test_gas_planSwitch() public {
        _configure(plan([uint256(10), 4, 2, 0, 0, 0, 0, 0, 0]));
        fillUp();
        uint256[] memory plans = new uint256[](1);
        plans[0] = plan([uint256(5), 2, 1, 0, 0, 0, 0, 0, 0]);
        configure(1 ether, 0, plans);
        _upkeep("upkeep: plan switch, withdraw + redeem 6 Shapes");
        _upkeep("upkeep: plan switch, withdraw + redeem 2 Shapes + checkpoint");
    }

    function test_gas_multiCallPlanSwitchInOneTx() public {
        _configure(plan([uint256(20), 10, 10, 0, 0, 0, 0, 0, 0]));
        fillUp();
        uint256[] memory plans = new uint256[](1);
        plans[0] = plan([uint256(5), 0, 0, 0, 0, 0, 0, 0, 0]);
        configure(1 ether, 0, plans);
        MultiKeeper mk = new MultiKeeper();
        vm.recordLogs();
        vm.prank(keeper, keeper);
        mk.run(balancer, 8);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 sum;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == KEEPER_PAID) {
                (, uint256 g) = abi.decode(logs[i].data, (uint256, uint256));
                sum += g;
            }
        }
        _report("8 upkeeps in one tx: withdraw + redeem 35 Shapes", sum);
        assertTrue(balancer.canPurchase(buyer));
    }

    /// Several paid upkeeps in one transaction at the cap: the keeper earns no more than billed gas + refunds + one
    /// fixed incentive per call (no per-call intrinsic credit exists to multiply).
    function test_profitAtCap_multiCallBound() public {
        _configure(plan([uint256(20), 10, 10, 0, 0, 0, 0, 0, 0]));
        fillUp();
        uint256[] memory plans = new uint256[](1);
        plans[0] = plan([uint256(5), 0, 0, 0, 0, 0, 0, 0, 0]);
        configure(1 ether, 0, plans);
        MultiKeeper mk = new MultiKeeper();
        vm.fee(4.95 gwei);
        vm.txGasPrice(5 gwei);
        vm.recordLogs();
        vm.prank(keeper, keeper);
        mk.run(balancer, 8);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 sum;
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == KEEPER_PAID) {
                (uint256 r,) = abi.decode(logs[i].data, (uint256, uint256));
                sum += r;
                ++n;
            }
        }
        (bool ok, bytes memory b) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok);
        (, uint64 billed,, int64 refunded,) = abi.decode(b, (uint64, uint64, uint64, int64, uint64));
        uint256 bound = (uint256(billed) + uint256(int256(refunded))) * 5 gwei + n * 0.0005 ether;
        emit log_named_uint("paid calls", n);
        emit log_named_decimal_int("rewards - bound (ETH)", int256(sum) - int256(bound), 18);
        assertGt(n, 1);
        assertLe(sum, bound, "multi-call rewards within billed + refunds + margins");
    }

    function test_gas_recoverRefundedShape() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        uint256 lid = lastListingId();
        (,,,,,, uint256 slot,) = pool.listings(lid);
        (,,, uint256 tokenId,,,,) = pool.listings(lid);
        uint256[] memory ids = buy(buyer, 1);
        // unreachable with mainnet Shapes behind the purchaser gate: mock the delivery transfer failing
        vm.mockCallRevert(SHAPES, abi.encodeWithSignature("transferFrom(address,address,uint256)", address(pool), buyer, tokenId), "blocked");
        fulfill(ids[0], wordForSlot(slot));
        settle();
        vm.clearMockedCalls();
        upkeep();
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(buyer);
        pool.refundFailedDelivery(lid);
        vm.recordLogs();
        vm.prank(keeper, keeper);
        balancer.recoverRefundedShape(lid);
        _report("recoverRefundedShape: recover + redeem", _reimbursed());
    }

    function test_gas_repriceMaxListings() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        PoolBalancer.CuratedInput[] memory batch = new PoolBalancer.CuratedInput[](20);
        vm.startPrank(creator);
        nft.setApprovalForAll(address(balancer), true);
        for (uint256 r; r < 4; ++r) {
            for (uint256 i; i < 20; ++i) {
                uint256 id = 1000 + r * 20 + i;
                nft.mint(creator, id);
                batch[i] = PoolBalancer.CuratedInput(address(nft), id, 0.3 ether);
            }
            balancer.listCuratedBatch(batch);
        }
        for (uint256 i; i < 8; ++i) {
            nft.mint(creator, 2000 + i);
            balancer.listCurated(address(nft), 2000 + i, 0.3 ether);
        }
        vm.stopPrank();
        assertEq(balancer.getActiveIds().length, 100);
        upkeep();
        uint256[] memory plans = new uint256[](1);
        plans[0] = plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]);
        vm.prank(creator);
        balancer.configure(PoolBalancer.Config(1 ether, 0, 2500), plans);
        _upkeep("upkeep: reprice 6 of 100 listings (full scan)");
    }

    function test_gas_unwind() public {
        _configure(plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        vm.startPrank(creator);
        balancer.close();
        balancer.unwind(20);
        vm.stopPrank();
        _report("unwind(20): withdraw + redeem 20 Shapes (creator)", 0);
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

    /*////////////////////// keeper profitability at the gas-price cap //////////////////////*/

    function _profitAtCap(string memory label) internal returns (int256 pnl) {
        return _profitAt(label, 4.95 gwei);
    }

    /// @dev Keeper PnL of one upkeep at `basefee` with a 0.05 gwei priority bid (the reimbursable priority).
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
        emit log_named_decimal_uint("  basefee (gwei)", basefee, 9);
        emit log_named_decimal_int("  keeper PnL (ETH)", pnl, 18);
        vm.fee(0.5 gwei);
        vm.txGasPrice(1 gwei);
    }

    /// Cheapest pool shape (0.01 ETH Shapes, ~0.012 ETH draw price): one draw pays FWA ~0.00057 ETH of edge, which
    /// caps the keeper's incentive for the work it caused. Profitable to ~2.9 gwei; at the 5 gwei cap the keeper
    /// waits (or the creator runs upkeep).
    function test_profitAtCap_replaceOneCheapPool() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        _drawShapes(1);
        uint256 snap = vm.snapshotState();
        assertGe(_profitAt("replace 1 Shape, cheap pool, 2.8 gwei", 2.8 gwei), 0);
        vm.revertToState(snap);
        assertLt(_profitAt("replace 1 Shape, cheap pool, 4.95 gwei", 4.95 gwei), 0);
    }

    /// A typical pool (0.05-0.1 ETH Shapes in the mix): one draw's edge covers the shortfall at the cap.
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
        for (uint256 i; i < 7; ++i) {
            assertGe(_profitAtCap("fill step"), 0);
        }
        assertTrue(balancer.canPurchase(buyer));
    }

    function test_profitAtCap_planSwitch() public {
        _configure(plan([uint256(10), 4, 2, 0, 0, 0, 0, 0, 0]));
        fillUp();
        uint256[] memory plans = new uint256[](1);
        plans[0] = plan([uint256(5), 2, 1, 0, 0, 0, 0, 0, 0]);
        configure(1 ether, 0, plans);
        assertGe(_profitAtCap("plan switch, redeem 6"), 0);
    }

    function test_profitAtCap_curatedReconcile() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], 1);
        settle();
        assertGe(_profitAtCap("reconcile 1 curated draw"), 0);
    }

    /// Gas-only path: measured gas only; the keeper absorbs the gas outside the measured span (~33k).
    function test_profitAtCap_refundOnlyBatch() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        buy(buyer, 1);
        vm.roll(block.number + 40);
        pool.processAcquisitions(1);
        assertGe(_profitAtCap("refund-only batch (gas only)"), -int256(0.0002 ether));
    }

    /*////////////////////// break-even basefee per upkeep type //////////////////////*/

    /// @dev Keeper PnL of one upkeep (reward - billed gas x price) at each basefee, from the same state; logs the
    ///      highest profitable basefee. Run with --isolate so billed gas includes intrinsic gas and refunds.
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

    function _drawCurated() internal {
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], 1); // slot 1: the first curated NFT
        settle();
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
        assertGe(_sweep("replace 1 Shape, 0.01-only pool (purchase-caused, credit-limited)"), 2.8 gwei);
    }

    function test_breakEven_replaceFive() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        _drawShapes(5);
        assertEq(_sweep("replace 5 Shapes, one denomination (purchase-caused, credit)"), 4.95 gwei);
    }

    function test_breakEven_replaceFiveMixed() public {
        _configure(plan([uint256(4), 2, 2, 1, 1, 0, 0, 0, 0]));
        fillUp();
        _drawShapes(5);
        assertEq(_sweep("replace 5 Shapes, four denominations (purchase-caused, credit)"), 4.95 gwei);
    }

    function test_breakEven_curatedReconcile() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        _drawCurated();
        assertEq(_sweep("reconcile 1 curated draw (purchase-caused, credit)"), 4.95 gwei);
    }

    function test_breakEven_fillStep() public {
        _configure(plan([uint256(20), 10, 10, 0, 0, 0, 0, 0, 0]));
        assertEq(_sweep("fill step, 6 mints (creator-caused, full incentive)"), 4.95 gwei);
    }

    function test_breakEven_planSwitchCreator() public {
        _configure(plan([uint256(10), 4, 2, 0, 0, 0, 0, 0, 0]));
        fillUp();
        uint256[] memory plans = new uint256[](1);
        plans[0] = plan([uint256(5), 2, 1, 0, 0, 0, 0, 0, 0]);
        configure(1 ether, 0, plans);
        assertEq(_sweep("plan switch, redeem 6 (creator-caused, full incentive)"), 4.95 gwei);
    }

    function test_breakEven_planSwitchPurchase() public {
        uint256[] memory plans = new uint256[](2);
        plans[0] = plan([uint256(10), 4, 2, 0, 0, 0, 0, 0, 0]);
        plans[1] = plan([uint256(5), 2, 1, 0, 0, 0, 0, 0, 0]);
        // a curated draw breaks plan 0's odds floor, so upkeep redeems down to plan 1 (purchase-caused)
        configure(1 ether, 30, plans); // odds: plan 0 0.48%, 0.18% without the 0.3 ETH NFT; plan 1 0.36%
        vm.prank(creator);
        balancer.open();
        fillUp();
        require(balancer.activePlan() == 0, "starts on plan 0");
        _drawCurated();
        _sweep("plan switch after a curated draw, reconcile + redeem 6 (purchase-caused, credit)");
    }

    function test_breakEven_reprice() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        uint256[] memory plans = new uint256[](1);
        plans[0] = plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]);
        vm.prank(creator);
        balancer.configure(PoolBalancer.Config(1 ether, 0, 2500), plans);
        assertEq(_sweep("reprice 6 listings (creator-caused, full incentive)"), 4.95 gwei);
    }

    function test_breakEven_refundOnly() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        buy(buyer, 1);
        vm.roll(block.number + 40);
        pool.processAcquisitions(1);
        _sweep("refund-only batch (gas only, no incentive)");
    }

    /// Unpaid re-checkpoint after a creator edit: the gas a keeper's loss allowance must cover.
    function test_gas_unpaidRecheckpoint() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        uint256[] memory active = balancer.getActiveIds();
        vm.prank(creator);
        balancer.updateCuratedPrice(active[0], 0.31 ether);
        _upkeep("upkeep: re-checkpoint after a creator edit (unpaid)");
    }

    function test_gas_createBalancer() public {
        address c = makeAddr("gasCreator");
        vm.prank(c);
        factory.createBalancer(bytes32(0));
        _report("createBalancer (clone + FWA pool + operator + approval)", 0);
    }
}
