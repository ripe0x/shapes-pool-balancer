// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";
import {IFWAPoolFactory} from "../src/interfaces/External.sol";

interface IReservedListings {
    function reservedListingCount(uint64 sequence) external view returns (uint256);
}

/// @notice Launch audit B, S1 (owner decision D16, narrowed 2026-11-23): a draw whose request reserved a staged restock,
///         or a Ready draw behind the queue head, skips FWA's randomness fast path and waits for `processAcquisitions`.
///         A draw whose randomness never arrived (TimedOut, or Pending past its word deadline) is stuck too.
///         Upkeep processes such stuck draws once they were requested at least the economics' grace ago (50 blocks,
///         10 while sales are paused), paid as gas plus one work fee per processed draw. Mainnet fork, real FWA pool,
///         randomness service and Shapes.
contract ProcessQueueTest is ForkBase {

    function setUp() public {
        setUpFork();
        vm.txGasPrice(0.55 gwei); // a keeper bids basefee + the 0.05 gwei the Balancer reimburses
        GasProbe probe = new GasProbe();
        probe.record();
        assertEq(probe.baseFee(), 0.5 gwei, "basefee inside a transaction");
        assertEq(probe.gasPrice(), 0.55 gwei, "gas price inside a transaction");
        vm.deal(stranger, 100 ether);
    }

    function _keeper() internal {
        bytes32 uh1 = balancer.settingsHash();
        vm.prank(keeper, keeper);
        try balancer.performUpkeep(uh1, 0, 0) {} catch {}
    }

    function test_upkeepSettlesDrawsThatReservedAStagedRestock() public {
        createBalancer(10 ether);
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1); // the launch board
        vm.startPrank(creator);
        balancer.configure(2500, plan16(c), shapes.mintFee());
        vm.stopPrank();
        listCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertEq(balancer.admissionStatus(), 0, "open");

        uint256 reserved;
        uint256 refused;
        uint256 nft = 1;
        for (uint256 i; i < 40; ++i) {
            if (balancer.admissionStatus() == 3) listCurated(++nft, 0.2 ether); // an NFT was won: the creator relists
            if (!balancer.canPurchase(buyer)) {
                ++refused;
                _keeper();
                continue;
            }
            uint256[] memory a = buy(buyer, 1);
            _keeper(); // runs while that draw is in flight: earlier wins' restocks are staged
            uint256[] memory b;
            if (balancer.canPurchase(stranger)) {
                b = buy(stranger, 1); // a second player, while the first draw is unsettled
                if (IReservedListings(address(pool)).reservedListingCount(pool.lastIssuedSequence()) != 0) ++reserved;
            }
            fulfill(a[0], uint256(keccak256(abi.encode("a", i))));
            if (b.length != 0) fulfill(b[0], uint256(keccak256(abi.encode("b", i))));
            // nobody touches FWA's queue; the keeper's next upkeep comes with the next player
        }
        assertGt(reserved, 0, "reached: draws reserved a staged restock and lost the randomness fast path");
        vm.roll(vm.getBlockNumber() + 50); // every waiting draw is past the processing grace
        // keepers alone settle everything that has its randomness; with --isolate each call is its own transaction, so
        // the keeper's real cost (billed gas after refunds, plus 21,000) can be set against its reward
        for (uint256 k; k < 10 && pool.unsettledAcquisitionCount() != 0; ++k) {
            bytes32 uh2 = balancer.settingsHash();
            uint256 before = keeper.balance;
            vm.prank(keeper, keeper);
            vm.recordLogs();
            try balancer.performUpkeep(uh2, 0, 0) returns (uint256 reward) {
                Vm.Log[] memory logs = vm.getRecordedLogs();
                for (uint256 q; q < logs.length; ++q) {
                    if (logs[q].topics[0] == keccak256("KeeperPaid(address,uint256,uint256)")) {
                        (, uint256 measured) = abi.decode(logs[q].data, (uint256, uint256));
                        emit log_named_uint("  measured inside performUpkeep", measured);
                    }
                    if (logs[q].topics[0] == keccak256("AcquisitionFulfilled(uint256,uint256,address)")) emit log("  a draw settled");
                }
                (bool ok, bytes memory r) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
                require(ok, "lastCallGas");
                (, uint64 used,,,) = abi.decode(r, (uint64, uint64, uint64, int64, uint64));
                assertEq(keeper.balance - before, reward, "paid");
                emit log_named_uint("processing upkeep: reward (wei)", reward);
                emit log_named_uint("  receipt billed gas", uint256(used));
                int256 margin = int256(reward) - int256((uint256(used)) * 0.55 gwei);
                emit log_named_int("  keeper margin over billed gas (wei)", margin);
                assertGe(margin, 0, "a processing upkeep pays the keeper at least its billed gas");
            } catch {}
        }
        assertEq(pool.unsettledAcquisitionCount(), 0, "upkeep processed FWA's queue");
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence(), "and reconciled every draw");
        assertEq(balancer.admissionStatus(), 0, "sales open");
        emit log_named_uint("draws that reserved a staged restock", reserved);
        emit log_named_uint("purchase attempts refused along the way", refused);
    }

    bytes32 constant PAID = keccak256("KeeperPaid(address,uint256,uint256)");

    struct Up { bool ok; uint256 reward; uint256 measured; uint256 processed; uint256 reconciled; }

    function _up() internal returns (Up memory u) {
        uint64 n0 = pool.nextSequenceToProcess();
        uint64 r0 = balancer.reconciledSequence();
        bytes32 h = balancer.settingsHash();
        uint256 k0 = keeper.balance;
        vm.recordLogs();
        vm.prank(keeper, keeper);
        try balancer.performUpkeep(h, 0, 0) returns (uint256 reward) { (u.ok, u.reward) = (true, reward); } catch {}
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 q; q < logs.length; ++q) {
            if (logs[q].emitter == address(balancer) && logs[q].topics[0] == PAID) {
                (, u.measured) = abi.decode(logs[q].data, (uint256, uint256));
            }
        }
        u.processed = pool.nextSequenceToProcess() - n0;
        u.reconciled = balancer.reconciledSequence() - r0;
        assertEq(keeper.balance - k0, u.reward, "the keeper received exactly the reward");
    }

    /// Runs upkeep until it has nothing to do, asserting it processes nothing.
    function _drainWithoutProcessing() internal {
        for (uint256 i; i < 20; ++i) {
            Up memory u = _up();
            assertEq(u.processed, 0, "no processing");
            if (!u.ok) return;
        }
        revert("upkeep never settled");
    }

    function _board() internal {
        createBalancer(10 ether);
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1);
        vm.startPrank(creator);
        balancer.configure(2500, plan16(c), shapes.mintFee());
        vm.stopPrank();
        listCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
    }

    /// Two draws, randomness out of order: FWA's callback processes the head alone and leaves the second Ready (stuck).
    function _stuckBehindHead() internal returns (uint256 t0) {
        t0 = vm.getBlockNumber();
        uint256[] memory a = buy(buyer, 2);
        fulfill(a[1], wordForSlot(3)); // Shape slots: slot 1 holds the curated NFT, listed first
        fulfill(a[0], wordForSlot(2));
        assertEq(pool.nextSequenceToProcess(), pool.lastIssuedSequence(), "one Ready draw stuck behind the processed head");
    }

    function test_stuckDrawProcessedOnlyAfterGrace_freshDrawUntouched_paidOnce() public {
        _board();
        uint256 t0 = _stuckBehindHead();
        assertEq(balancer.admissionStatus(), 0, "sales open: the 50-block grace applies");
        _drainWithoutProcessing(); // reconciles the head and restocks its prize
        vm.roll(t0 + 49);
        Up memory u = _up();
        assertFalse(u.ok, "one block before the grace: nothing to do, nothing paid");
        assertEq(u.processed, 0);
        uint256[] memory c = buy(stranger, 1); // a fresh draw behind the stuck one
        fulfill(c[0], 13); // block t0 + 52: the stuck draw is past the grace, the fresh one is 3 blocks old
        u = _up();
        assertEq(u.processed, 1, "the stuck draw only");
        assertEq(pool.nextSequenceToProcess(), pool.lastIssuedSequence(), "the fresh draw is untouched");
        assertEq(u.reconciled, 1);
        assertLe(u.measured, 2_150_000, "within the operation bounds for one processed and one reconciled draw");
        assertEq(u.reward, (u.measured + V1_OVERHEAD) * 0.55 gwei + 2 * 0.00002 ether,
            "measured gas at the reimbursed price, plus one work fee for processing and one for reconciling");
        emit log_named_uint("processing upkeep measured gas", u.measured);
        _drainWithoutProcessing(); // no second payment: the fresh draw waits for its own grace
        vm.roll(t0 + 49 + 50);
        u = _up();
        assertEq(u.processed, 1, "the second draw after its own grace");
        assertEq(u.reconciled, 1);
        assertEq(pool.unsettledAcquisitionCount(), 0);
        _drainWithoutProcessing();
    }

    function test_stuckDrawShorterGraceWhilePaused() public {
        _board();
        vm.prank(creator);
        balancer.setBacklogThreshold(1);
        uint256 t0 = _stuckBehindHead();
        assertEq(balancer.admissionStatus(), 4, "BUSY: the stuck draw pauses sales");
        _drainWithoutProcessing();
        vm.roll(t0 + 9);
        assertEq(_up().processed, 0, "before the 10-block paused grace");
        vm.roll(t0 + 10);
        Up memory u = _up();
        assertEq(u.processed, 1, "processed 10 blocks after its request while sales are paused");
        assertEq(u.reward, (u.measured + V1_OVERHEAD) * 0.55 gwei + 2 * 0.00002 ether);
        assertTrue(balancer.admissionStatus() != 4, "no longer BUSY");
    }

    function test_headWaitingForRandomnessIsProcessedOnlyAfterItsDeadline() public {
        _board();
        vm.prank(creator);
        balancer.setBacklogThreshold(1); // the shortest grace
        uint256 t0 = vm.getBlockNumber();
        uint256[] memory a = buy(buyer, 2);
        (, uint64 deadline,,,,) = pool.acquisitionMeta(a[0]);
        fulfill(a[1], 11); // Ready, behind a head still waiting for its word
        assertEq(balancer.admissionStatus(), 4, "BUSY: the 10-block grace applies");
        vm.roll(t0 + 25); // past the 10-block grace, inside FWA's word deadline
        Up memory u = _up();
        assertEq(u.processed, 0, "the head is not Ready");
        assertFalse(u.ok, "nothing to do, nothing paid");
        vm.roll(deadline); // FWA expires a Pending draw only once block.number > wordDeadlineBlock
        u = _up();
        assertEq(u.processed, 0, "at the deadline block FWA would process nothing");
        assertFalse(u.ok, "so upkeep is not paid for it");
        vm.roll(uint256(deadline) + 1);
        u = _up();
        assertEq(u.processed, 2, "the expired head and the Ready draw behind it");
        assertEq(u.reward, (u.measured + V1_OVERHEAD) * 0.55 gwei + 4 * 0.00002 ether);
    }

    /// Owner decision (2026-11-23): a draw whose randomness never arrives is stuck too. After its word deadline and the
    /// grace, upkeep expires it on FWA (the buyer's fee becomes refund credit), is paid gas plus the work fee, and the
    /// Ready draw queued behind it proceeds in the same call.
    function test_drawWithoutRandomnessProcessedAfterDeadlineAndGrace_drawBehindProceeds() public {
        _board();
        uint256[] memory a = buy(buyer, 2);
        (, uint256 requested,,,,) = pool.acquisitions(a[0]);
        (, uint64 deadline,,,,) = pool.acquisitionMeta(a[0]);
        fulfill(a[1], 11); // Ready behind a head whose randomness never arrives
        assertEq(balancer.admissionStatus(), 0, "sales open: the 50-block grace applies");
        assertGt(requested + 50, uint256(deadline) + 1, "the grace, not the deadline, binds");
        _drainWithoutProcessing();
        vm.roll(requested + 49); // past the word deadline, one block before the grace
        Up memory u = _up();
        assertEq(u.processed, 0, "expired, but inside the grace");
        assertFalse(u.ok, "nothing to do, nothing paid");
        vm.roll(requested + 50);
        u = _up();
        assertEq(u.processed, 2, "the expired head and the Ready draw behind it");
        assertEq(u.reconciled, 2);
        (,,,, uint8 status,) = pool.acquisitions(a[0]);
        assertEq(status, 3, "FWA expired the draw without randomness");
        assertEq(pool.unsettledAcquisitionCount(), 0, "the queue moved on");
        assertEq(u.reward, (u.measured + V1_OVERHEAD) * 0.55 gwei + 4 * 0.00002 ether,
            "measured gas at the reimbursed price, two processing and two reconcile fees");
        emit log_named_uint("expired-head upkeep measured gas", u.measured);
        _drainWithoutProcessing();
    }

    /// A keeper that buys a draw to manufacture paid processing pays FWA's edge and the randomness fee, which never come
    /// back. Its gain is the processing call's net: pay (measured gas plus the overhead allowance at the price, plus the
    /// work fees) less the gas it is billed, which FWA's storage refunds push below the measured span. Measured at
    /// 5 gwei from the transaction's own gas; run with --isolate so that gas is the receipt's (refunds applied).
    function test_manufacturedStuckDrawLosesMoney() public {
        _board();
        vm.fee(4.95 gwei);
        vm.txGasPrice(5 gwei); // reimbursed price min(5, 4.95 + 0.05, ceiling 5) = 5 gwei
        (uint256 fee, uint256 vrf,) = pool.quoteAcquisitionPrice(1);
        uint256 edgeBps = IFWAPoolFactory(FWA_FACTORY).edgeBps();
        uint256 edge = fee * edgeBps / (10_000 + edgeBps);
        uint256 t0 = _stuckBehindHead(); // the manufactured draw: Ready behind the processed head
        _drainWithoutProcessing();
        vm.roll(t0 + 50);
        bytes32 h = balancer.settingsHash();
        uint64 n0 = pool.nextSequenceToProcess();
        uint256 k0 = keeper.balance;
        vm.prank(keeper, keeper);
        uint256 reward = balancer.performUpkeep(h, 0, 0);
        (bool ok, bytes memory r) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok, "lastCallGas");
        (, uint64 billed,,,) = abi.decode(r, (uint64, uint64, uint64, int64, uint64));
        assertEq(pool.nextSequenceToProcess() - n0, 1, "the manufactured draw was processed");
        assertEq(keeper.balance - k0, reward, "paid");
        int256 net = int256(reward) - int256(uint256(billed) * 5 gwei);
        emit log_named_decimal_uint("draw fee (ETH)", fee, 18);
        emit log_named_decimal_uint("FWA edge in it (ETH)", edge, 18);
        emit log_named_decimal_uint("randomness fee (ETH)", vrf, 18);
        emit log_named_uint("processing call billed gas", billed);
        emit log_named_decimal_uint("processing call pay (ETH)", reward, 18);
        emit log_named_decimal_int("keeper net of billed gas (ETH)", net, 18);
        assertGt(int256(edge + vrf), net, "a self-bought stuck draw costs more than its processing call nets");
    }
}
