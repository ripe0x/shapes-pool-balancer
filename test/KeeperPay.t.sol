// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {IERC721Min} from "../src/interfaces/External.sol";
import {ListOne} from "./utils/ListOne.sol";

using ListOne for PoolBalancer;

/// @notice Keeper pay: every upkeep that reconciles a draw or lists a prize is paid its gas plus verified work fees from the
///         creator's ETH; a call that does neither is paid nothing. Mainnet fork, real FWA pool, randomness service,
///         Shapes and BAYC tokens. Run with --isolate for real transaction gas (intrinsic gas, cold storage, refunds):
///         forge test --match-path test/KeeperPay.t.sol --isolate -vv
contract BillingWitness {
    function noop() external returns (uint256) { return 42; }
}

contract KeeperPayTest is ForkBase {
    bytes32 constant KEEPER_PAID = keccak256("KeeperPaid(address,uint256,uint256)");
    address constant BAYC = 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;
    uint256 constant WORK_FEE = 0.00002 ether; // V1 formula fee per completed draw or listed Shape unit
    uint256 constant VRF_GAS = 2_340_000; // FWA's randomness charge per draw

    GasProbe probe;
    uint256 gasPrice;
    uint256 nextNft = 200;
    uint256 nftListing;
    bool isolated;

    function setUp() public {
        setUpFork();
        probe = new GasProbe();
        BillingWitness witness = new BillingWitness();
        witness.noop();
        (, bytes memory usage) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        (, uint64 used,,,) = abi.decode(usage, (uint64, uint64, uint64, int64, uint64));
        // This non-view CALL costs far below 1k execution gas: >=21k independently detects included intrinsic gas.
        assertTrue(used < 1_000 || used >= 21_000, "unrecognized Foundry billing mode");
        isolated = used >= 21_000;
    }

    /// @dev Sets the gas context, proves it inside a transaction, and opens a pool of ten 0.01 Shapes and one NFT.
    function _open(uint256 basefee) internal {
        gasPrice = basefee + 0.05 gwei;
        vm.fee(basefee);
        vm.txGasPrice(gasPrice);
        probe.record();
        assertEq(probe.baseFee(), basefee, "basefee inside a transaction");
        assertEq(probe.gasPrice(), gasPrice, "gas price inside a transaction");
        createBalancer(5 ether);
        configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        _listNft();
        vm.prank(creator);
        balancer.open();
    }

    function _listNft() internal {
        uint256 id;
        address holder;
        do {
            id = nextNft++;
            holder = IERC721Min(BAYC).ownerOf(id);
        } while (holder.code.length != 0);
        vm.prank(holder);
        IERC721Min(BAYC).transferFrom(holder, creator, id);
        vm.startPrank(creator);
        IERC721Min(BAYC).approve(address(balancer), id);
        nftListing = balancer.listCurated(BAYC, id, 0.2 ether);
        vm.stopPrank();
    }

    /// @dev The pinned five-field Foundry response already includes intrinsic and applied refunds in isolation.
    ///      Its semantics are guarded by SettingsTest's storage-clear CALL and compared with real Anvil receipts.
    function _paid() internal returns (uint256 reward, uint256 measured, int256 pnl) {
        uint256 billed;
        (reward, measured, pnl, billed) = _paidBilled();
    }

    function _paidBilled() internal returns (uint256 reward, uint256 measured, int256 pnl, uint256 billed) {
        bytes32 uh1 = balancer.settingsHash();
        uint256 before = keeper.balance;
        vm.recordLogs();
        vm.prank(keeper, keeper);
        reward = balancer.performUpkeep(uh1, 0, 0);
        (bool ok, bytes memory usage) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok, "lastCallGas");
        (, uint64 used,,,) = abi.decode(usage, (uint64, uint64, uint64, int64, uint64));
        billed = used;
        if (!isolated) {
            billed += 21_000;
            bytes memory data = abi.encodeWithSignature("performUpkeep(bytes32,uint256,uint256)", uh1, 0, 0);
            for (uint256 i; i < data.length; ++i) billed += data[i] == 0 ? 4 : 16;
        }
        // Pinned 1.8.1's five-field `used` already includes the applied transaction refund.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == KEEPER_PAID) (, measured) = abi.decode(logs[i].data, (uint256, uint256));
        }
        assertEq(keeper.balance - before, reward, "the keeper received the reward");
        pnl = int256(reward) - int256(billed * gasPrice);
    }

    function _noWork() internal {
        bytes32 uh2 = balancer.settingsHash();
        uint256 before = keeper.balance;
        vm.prank(keeper, keeper);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep(uh2, 0, 0);
        assertEq(keeper.balance, before, "no work, no pay");
    }

    function _timeOut(uint256 n) internal returns (uint256[] memory ids) {
        ids = buy(buyer, n);
        vm.roll(vm.getBlockNumber() + 40); // past FWA's 30-block word deadline
    }

    function _drawShapes(uint256 n) internal {
        uint256[] memory ids = buy(buyer, n);
        uint256[] memory active = balancer.getActiveIds();
        uint256 k;
        for (uint256 i; i < active.length && k < n; ++i) {
            (uint8 kind,,,,) = balancer.items(active[i]);
            (,,,,,, uint256 slot, uint8 st) = pool.listings(active[i]);
            if (kind != 2 || st != 1) continue;
            (,,, uint256 tokenId,,,,) = pool.listings(active[i]);
            fulfill(ids[k++], wordForSlot(slot));
            assertEq(shapes.ownerOf(tokenId), buyer, "Shape won");
        }
        assertEq(k, n, "enough Shapes listed");
        settle();
    }

    /// A draw that timed out lists nothing and brings no restocking fee. Reconciling it is paid measured gas plus the
    /// overhead allowance at the reimbursed price, plus the work fee.
    function test_reconcileOnlyCallIsPaid() public {
        _open(0.5 gwei);
        fillUp();
        _timeOut(1);
        pool.processAcquisitions(1);
        uint256 listings = lastListingId();
        uint256 fund = address(balancer).balance;
        (uint256 reward, uint256 measured,) = _paid();
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence(), "reconciled");
        assertEq(lastListingId(), listings, "nothing listed");
        assertEq(reward, (measured + V1_OVERHEAD) * 0.55 gwei + WORK_FEE, "gas at basefee + 0.05 gwei, plus the work fee");
        assertGt(reward, WORK_FEE + 0.00005 ether, "more than the flat reward");
        assertLt(reward, 0.0003 ether, "a reconcile-only call is cheap");
        assertEq(fund - address(balancer).balance, reward, "paid from the Balancer's ETH, nothing else moved");
        _noWork();
    }

    /// Nothing to do, and a draw FWA has not processed: no pay, however often it is called.
    function test_noWorkCallIsPaidNothing() public {
        _open(0.5 gwei);
        fillUp();
        _noWork();
        buy(buyer, 1); // pending: no word yet, deadline not passed
        for (uint256 i; i < 3; ++i) _noWork();
        assertEq(balancer.reconciledSequence(), 0, "nothing reconciled");
    }

    /// FWA processing is permissionless, so anyone can process a ready batch one draw at a time and reconcile after
    /// each: one batch becomes up to five paid calls (audit rc-ec5259c finding 6). The bound is one paid call per
    /// reconciled draw, not one per batch. The splitter needs no draws of its own; players bought these. Upkeep processes
    /// an expired draw only after the processing grace (owner decision 2026-11-23), so the splitter processes each on
    /// FWA as soon as it expires; the paid processing of expired draws is tested in ProcessQueue.
    function test_splitCallsArePaidOncePerProcessedDraw() public {
        _open(0.5 gwei);
        fillUp();
        // Four draws: on this ten-Shape board the fill gate refuses a fifth single draw while four are unreconciled.
        uint256 firstExpired = buyOnePerBlock(buyer, 4);
        uint256 snap = vm.snapshotState();
        // Fewest calls: all four expired at once, processed on FWA, then one call reconciles all four.
        vm.roll(firstExpired + 3);
        pool.processAcquisitions(4);
        (uint256 batched,, int256 batchedPnl) = _paid();
        assertEq(balancer.reconciledSequence(), 4, "one call reconciles all four");
        _noWork();
        vm.revertToState(snap);

        // Most calls: one draw expires per block and is processed on FWA, so each call reconciles exactly one.
        uint256 split;
        int256 splitPnl;
        for (uint256 i; i < 4; ++i) {
            vm.roll(firstExpired + i - 1);
            _noWork(); // the head is neither ready nor expired: nothing to be paid for
            vm.roll(firstExpired + i);
            pool.processAcquisitions(1); // the splitter, as soon as the head expires
            (uint256 reward, uint256 measured, int256 pnl) = _paid();
            splitPnl += pnl;
            assertEq(balancer.reconciledSequence(), i + 1, "each paid call advances reconciliation");
            assertEq(reward, (measured + V1_OVERHEAD) * 0.55 gwei + WORK_FEE);
            assertLt(reward, 0.0003 ether);
            split += reward;
        }
        _noWork();
        assertLt(split - batched, 3 * 0.0003 ether, "splitting costs the creator at most one small reward per extra call");
        emit log_named_decimal_uint("paid for one batched call", batched, 18);
        emit log_named_decimal_uint("paid for four split calls", split, 18);
        emit log_named_decimal_int("keeper net from batched upkeep", batchedPnl, 18);
        emit log_named_decimal_int("keeper net from split upkeep", splitPnl, 18);
        assertEq(4 * WORK_FEE, 0.00008 ether, "same service fees in both schedules");
    }

    /// Audit rc-ec5259c finding 3, repaired (owner decision D3): while closed, `requiredReserve` holds one maximum keeper
    /// reward per unreconciled draw, including deliberately split settlement, so the creator cannot claim it before reconciliation.
    function test_postCloseReconcileIsPaidFromHeldAmount() public {
        _open(0.5 gwei);
        fillUp();
        buy(buyer, 5);
        vm.prank(creator);
        balancer.close();
        uint256 held = 5 * _reconciliationBudget();
        assertEq(balancer.requiredReserve(), held, "five unreconciled draws: one bounded reconciliation each");
        assertEq(balancer.withdrawableSurplus(), address(balancer).balance - held, "everything else is claimable");
        uint256 claimable = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(claimable, creator);
        assertEq(address(balancer).balance, held, "only the held pay is left");

        vm.roll(vm.getBlockNumber() + 40); // past FWA's word deadline
        pool.processAcquisitions(5);
        assertEq(pool.ownerProceeds(), 0, "all five expired: no proceeds");
        assertEq(balancer.reconciledSequence(), 0, "reached: five processed draws await reconciliation");
        (uint256 reward, uint256 measured,) = _paid();
        assertEq(balancer.reconciledSequence(), 5, "the call did useful work");
        assertEq(reward, (measured + V1_OVERHEAD) * gasPrice + 5 * WORK_FEE, "five completed draw sequences");
        assertEq(balancer.requiredReserve(), 0, "nothing owed once reconciled");
        uint256 rest = address(balancer).balance;
        assertEq(rest, held - reward, "the unspent hold stays in the pool");
        assertEq(balancer.withdrawableSurplus(), rest, "and is claimable again");
        vm.prank(creator);
        balancer.claimSurplus(rest, creator);
        assertEq(address(balancer).balance, 0, "closeout leaves nothing");
        emit log_named_decimal_uint("held at close", held, 18);
        emit log_named_decimal_uint("paid to the keeper", reward, 18);
    }

    /// The creator cannot claim the held keeper pay while draws are unreconciled.
    function test_creatorCannotClaimHeldPayWhileClosed() public {
        _open(0.5 gwei);
        fillUp();
        buy(buyer, 5);
        vm.prank(creator);
        balancer.close();
        uint256 all = address(balancer).balance;
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InsufficientSurplus.selector);
        balancer.claimSurplus(all, creator);
        uint256 free = balancer.withdrawableSurplus();
        assertEq(all - free, 5 * _reconciliationBudget(), "exactly the held pay is refused");
        vm.prank(creator);
        balancer.claimSurplus(free, creator);
    }

    /// Nothing is held after closing when every draw is already reconciled.
    function test_closedWithNothingOwedHoldsNothing() public {
        _open(0.5 gwei);
        fillUp();
        vm.prank(creator);
        balancer.close();
        assertEq(balancer.requiredReserve(), 0, "nothing owed");
        assertEq(balancer.withdrawableSurplus(), address(balancer).balance, "everything claimable");
    }

    function test_keeperWalletNotLower_halfGwei() public {
        _walletRun(0.5 gwei);
    }

    function test_keeperWalletNotLower_fiveGwei() public {
        _walletRun(4.95 gwei);
    }

    /// @dev Setup fills, a timed-out draw, an NFT win, one Shape and five Shapes: every call leaves the keeper whole.
    function _walletRun(uint256 basefee) internal {
        _open(basefee);
        int256 wallet;
        uint256 calls;
        while (balancer.creatorWork()) {
            wallet += _step("setup fill");
            ++calls;
        }
        uint256[] memory late = _timeOut(1);
        pool.processAcquisitions(1);
        wallet += _step("reconcile 1 timed-out draw");
        fulfill(late[0], 1); // the service delivers the word it owed; until then FWA refuses a batch of five
        uint256[] memory ids = buy(buyer, 1);
        (,,,,,, uint256 slot,) = pool.listings(nftListing);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        assertEq(IERC721Min(BAYC).ownerOf(nextNft - 1), buyer, "NFT won");
        wallet += _step("reconcile 1 NFT win");
        _listNft();
        _drawShapes(1);
        wallet += _step("reconcile and replace 1 Shape");
        _drawShapes(5);
        wallet += _step("reconcile and replace 5 Shapes");
        calls += 4;
        assertTrue(balancer.canPurchase(buyer), "open at the end");
        emit log_named_uint("paid calls", calls);
        emit log_named_decimal_int("keeper wallet change (ETH)", wallet, 18);
        assertGe(wallet, 0, "the keeper's wallet is not lower");
    }

    /// Calibration of the default overhead: for every paid operation class at the 5 gwei ceiling (gas price = ceiling,
    /// so the reimbursed price is the paid price), the gas reimbursement alone, (measured + overhead), must cover the
    /// billed transaction gas; the work fee is never needed to break even. Run with --isolate for receipt gas.
    function test_overheadCoversBilledGasPerOperationClass() public {
        _open(4.95 gwei);
        uint256 overhead = factory.economics().overheadGas;
        uint256 worst;
        while (balancer.creatorWork()) worst = _max(worst, _calibrate("setup fill (5 Shape units)"));
        uint256[] memory late = _timeOut(1);
        pool.processAcquisitions(1);
        worst = _max(worst, _calibrate("reconcile 1 timed-out draw"));
        fulfill(late[0], 1); // the service delivers the word it owed; until then FWA refuses a batch of five
        late = _timeOut(1);
        pool.processAcquisitions(1); // expired draws are processed on FWA by anyone, not by upkeep
        worst = _max(worst, _calibrate("reconcile 1 timed-out draw processed on FWA"));
        fulfill(late[0], 1);
        uint256[] memory ids = buy(buyer, 1);
        (,,,,,, uint256 slot,) = pool.listings(nftListing);
        fulfill(ids[0], wordForSlot(slot));
        settle();
        worst = _max(worst, _calibrate("reconcile 1 NFT win"));
        _listNft();
        _drawShapes(1);
        worst = _max(worst, _calibrate("reconcile and replace 1 Shape"));
        _drawShapes(5);
        worst = _max(worst, _calibrate("reconcile and replace 5 Shapes"));
        fillUp();
        uint256 head = buy(buyer, 1)[0];
        uint256 behind = buy(buyer, 1)[0];
        fulfill(behind, 7); // not the queue head: FWA's callback leaves it Ready (stuck)
        fulfill(head, 7); // the head: FWA's callback processes it alone
        assertEq(pool.nextSequenceToProcess(), pool.lastIssuedSequence(), "one stuck Ready draw");
        vm.roll(vm.getBlockNumber() + 50); // the default processing grace
        worst = _max(worst, _calibrate("process 1 stuck draw and reconcile 2"));
        fillUp();
        if (balancer.admissionStatus() == 3) _listNft(); // a stuck draw won the NFT: the creator relists one
        assertTrue(balancer.canPurchase(buyer));
        buy(buyer, 5);
        vm.prank(creator);
        balancer.close();
        vm.roll(vm.getBlockNumber() + 40);
        pool.processAcquisitions(5);
        worst = _max(worst, _calibrate("closed: reconcile 5 timed-out draws"));
        emit log_named_uint("largest billed - measured (gas)", worst);
        emit log_named_uint("configured overhead (gas)", overhead);
        if (isolated) assertLe(worst, overhead, "the default overhead covers every operation class");
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) { return a > b ? a : b; }

    function _calibrate(string memory label) internal returns (uint256 outside) {
        (uint256 reward, uint256 measured, int256 pnl, uint256 billed) = _paidBilled();
        outside = billed > measured ? billed - measured : 0;
        emit log(label);
        emit log_named_uint("  measured gas", measured);
        emit log_named_uint("  billed gas", billed);
        emit log_named_uint("  billed - measured", outside);
        emit log_named_decimal_uint("  paid (ETH)", reward, 18);
        emit log_named_decimal_uint("  billed cost (ETH)", billed * gasPrice, 18);
        emit log_named_decimal_int("  keeper net (ETH)", pnl, 18);
    }

    function _step(string memory label) internal returns (int256 pnl) {
        uint256 reward;
        (reward,, pnl) = _paid();
        emit log(label);
        emit log_named_decimal_uint("  reward", reward, 18);
        emit log_named_decimal_int("  reward less gas", pnl, 18);
        assertGe(pnl, 0, "this call paid for its gas");
        assertLe(reward, balancer.policyMaxReward());
    }
}
