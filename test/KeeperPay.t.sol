// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {IERC721Min} from "../src/interfaces/External.sol";

/// @notice Keeper pay: every upkeep that reconciles a draw or lists a prize is paid its gas plus a flat reward from the
///         creator's ETH; a call that does neither is paid nothing. Mainnet fork, real FWA pool, randomness service,
///         Shapes and BAYC tokens. Run with --isolate for real transaction gas (intrinsic gas, cold storage, refunds):
///         forge test --match-path test/KeeperPay.t.sol --isolate -vv
contract KeeperPayTest is ForkBase {
    bytes32 constant KEEPER_PAID = keccak256("KeeperPaid(address,uint256,uint256)");
    address constant BAYC = 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;
    uint256 constant OVERHEAD = 50_000; // PoolBalancer.KEEPER_OVERHEAD_GAS
    uint256 constant FLAT = 0.0001 ether; // PoolBalancer.KEEPER_INCENTIVE
    uint256 constant VRF_GAS = 2_340_000; // FWA's randomness charge per draw

    GasProbe probe;
    uint256 gasPrice;
    uint256 nextNft = 200;
    uint256 nftListing;

    function setUp() public {
        setUpFork();
        probe = new GasProbe();
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

    /// @dev One keeper call. `pnl` is the reward less this call's gas at the gas price, plus 21,000 in case the run is
    ///      not isolated (isolated runs already bill intrinsic gas, so the cost is then overstated).
    function _paid() internal returns (uint256 reward, uint256 measured, int256 pnl) {
        uint256 before = keeper.balance;
        vm.recordLogs();
        vm.prank(keeper, keeper);
        reward = balancer.performUpkeep();
        (bool ok, bytes memory r) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok, "lastCallGas");
        (, uint64 used,,,) = abi.decode(r, (uint64, uint64, uint64, int64, uint64));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == KEEPER_PAID) (, measured) = abi.decode(logs[i].data, (uint256, uint256));
        }
        assertEq(keeper.balance - before, reward, "the keeper received the reward");
        pnl = int256(reward) - int256((uint256(used) + 21_000) * gasPrice);
    }

    function _noWork() internal {
        uint256 before = keeper.balance;
        vm.prank(keeper, keeper);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep();
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
    /// overhead allowance at the reimbursed price, plus the flat reward.
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
        assertEq(reward, (measured + OVERHEAD) * 0.55 gwei + FLAT, "gas at basefee + 0.05 gwei, plus the flat reward");
        assertGt(reward, FLAT + 0.00005 ether, "more than the flat reward");
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
    /// processed draw, not one per batch. The splitter needs no draws of its own; players bought these.
    function test_splitCallsArePaidOncePerProcessedDraw() public {
        _open(0.5 gwei);
        fillUp();
        _timeOut(5);
        uint256 snap = vm.snapshotState();
        pool.processAcquisitions(5);
        (uint256 batched,,) = _paid();
        assertEq(balancer.reconciledSequence(), 5, "one call reconciles all five");
        vm.revertToState(snap);

        uint256 split;
        for (uint256 i; i < 5; ++i) {
            _noWork(); // nothing newly processed: nothing to be paid for
            pool.processAcquisitions(1);
            (uint256 reward, uint256 measured,) = _paid();
            assertEq(balancer.reconciledSequence(), i + 1, "each paid call advances reconciliation");
            assertEq(reward, (measured + OVERHEAD) * 0.55 gwei + FLAT);
            assertLt(reward, 0.0003 ether);
            split += reward;
        }
        _noWork();
        assertLt(split - batched, 4 * 0.0003 ether, "splitting costs the creator at most one small reward per draw");
        emit log_named_decimal_uint("paid for one batched call", batched, 18);
        emit log_named_decimal_uint("paid for five split calls", split, 18);
    }

    /// Audit rc-ec5259c finding 3, repaired (owner decision D3): while closed, `requiredReserve` holds one maximum keeper
    /// reward per five unreconciled draws, so the creator cannot claim it and a later useful reconcile is paid.
    function test_postCloseReconcileIsPaidFromHeldAmount() public {
        _open(0.5 gwei);
        fillUp();
        buy(buyer, 5);
        vm.prank(creator);
        balancer.close();
        uint256 held = balancer.MAX_KEEPER_REWARD();
        assertEq(balancer.requiredReserve(), held, "five unreconciled draws: one call's maximum reward held");
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
        assertEq(reward, (measured + OVERHEAD) * gasPrice + FLAT, "and was paid by the rule");
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
        assertEq(all - free, balancer.MAX_KEEPER_REWARD(), "exactly the held pay is refused");
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

    function _step(string memory label) internal returns (int256 pnl) {
        uint256 reward;
        (reward,, pnl) = _paid();
        emit log(label);
        emit log_named_decimal_uint("  reward", reward, 18);
        emit log_named_decimal_int("  reward less gas", pnl, 18);
        assertGe(pnl, 0, "this call paid for its gas");
        assertLe(reward, balancer.MAX_KEEPER_REWARD());
    }
}
