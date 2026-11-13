// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "../utils/ForkBase.sol";
import {PoolBalancer} from "../../src/PoolBalancer.sol";

/// Records the gas context a state-changing call actually runs in (Foundry zeroes basefee/gasprice inside calls
/// unless vm.fee/vm.txGasPrice are set), so assertions about the reward price are about the real executed path.
contract FeeWitness {
    uint256 public basefee;
    uint256 public gasprice;

    function record() external {
        basefee = block.basefee;
        gasprice = tx.gasprice;
    }
}

/// @notice D3 re-attack: while closed, `requiredReserve()` holds keeper pay for draws not yet reconciled
///         (one MAX_KEEPER_REWARD per MAX_RECONCILE draws). The owner requires that this hold always pays every
///         useful post-close reconcile, that nothing stays held once all draws are reconciled, that the creator can
///         end a closeout with nothing left, and that the hold cannot be inflated or stranded. These tests run the
///         real FWA pool and VRF service at the reward rule's hard gas bounds: basefee 5 gwei, bid 10 gwei, so the
///         reimbursed price caps at KEEPER_MAX_GAS_PRICE = 5 gwei.
contract D3ReAttackTest is ForkBase {
    uint256 internal constant HARD_BASEFEE = 5 gwei; // basefee + KEEPER_PRIORITY_CAP exceeds the 5 gwei cap
    uint256 internal constant HARD_BID = 10 gwei; // keeper bids above the cap; price clamps to 5 gwei

    function setUp() public {
        setUpFork();
        // Override the ForkBase context to the reward rule's hard bound and prove it reaches calls.
        vm.fee(HARD_BASEFEE);
        vm.txGasPrice(HARD_BID);
        FeeWitness w = new FeeWitness();
        w.record();
        assertEq(w.basefee(), HARD_BASEFEE, "calls run at the hard-bound basefee");
        assertEq(w.gasprice(), HARD_BID, "calls run at the hard-bound bid");

        createBalancer(5 ether);
        // Enough 0.01 Shapes listed that five draws stay above the fill gate and purchases are admitted.
        configure(plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        listCurated(1, 0.3 ether); // the pool gives NFTs away: purchases need a curated listing
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertEq(balancer.admissionStatus(), 0, "open and admitting");
    }

    function _claimAll() internal returns (uint256 claimed) {
        claimed = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(claimed, creator);
    }

    /// The reimbursed price at the hard bound: min(bid, basefee + 0.05 gwei, 5 gwei) = 5 gwei.
    function _hardPrice() internal pure returns (uint256) {
        return 5 gwei;
    }

    /// MAX_KEEPER_REWARD, computed here from the published rule, not read from the contract's own constant.
    function _independentMaxReward() internal pure returns (uint256) {
        return (3_200_000 + 50_000) * _hardPrice() + 0.0001 ether; // 0.01635 ETH
    }

    /// @notice Core D3 requirement under the split-call pattern at the gas cap, with the owner's exact motivating case:
    ///         draws that all expire (no proceeds), reconciled ONE PER CALL. FWA processing is permissionless, so a
    ///         five-draw batch can be reconciled across five paid calls. The batch-sized hold must pay every one.
    function test_splitCallReconcileOfExpiredDrawsIsFullyPaidFromTheHold() public {
        // Independent absolute check of the constant the hold is built from.
        assertEq(balancer.MAX_KEEPER_REWARD(), _independentMaxReward(), "MAX_KEEPER_REWARD = 0.01635 ETH at the cap");
        assertEq(_independentMaxReward(), 0.01635 ether, "0.01635 ETH");

        // Five draws issued in one batch, left pending (no VRF), then closed: the worst in-flight count for one batch.
        uint256[] memory reqs = buy(buyer, 5);
        assertEq(pool.lastIssuedSequence(), 5, "five sequences issued");
        assertEq(balancer.reconciledSequence(), 0, "none reconciled yet");

        vm.prank(creator);
        balancer.close();

        uint256 held = balancer.requiredReserve();
        assertEq(held, _independentMaxReward(), "owed=5 -> ceil(5/5)=1 maximum reward held");
        assertEq(balancer.withdrawableSurplus(), address(balancer).balance - held, "everything else claimable");

        // Creator pulls everything claimable, leaving exactly the hold. This is the adversarial starting point:
        // the hold is now the ONLY ETH available to pay reconciliation.
        _claimAll();
        assertEq(address(balancer).balance, held, "only the held pay remains");
        assertEq(pool.ownerProceeds(), 0, "expired draws bring no proceeds: the hold is the sole pay source");

        // Expire the pending draws (deadline is selectionTimeoutBlocks ahead of issuance), then reconcile ONE per call.
        vm.roll(block.number + 100); // past the 30-block selection timeout

        uint256 totalPaid;
        for (uint256 i; i < reqs.length; ++i) {
            // Force-expire exactly one head sequence in FWA (permissionless), so the next upkeep reconciles just one.
            pool.processAcquisitions(1);
            uint64 before = balancer.reconciledSequence();
            uint256 keeperBefore = keeper.balance;
            vm.prank(keeper, keeper);
            balancer.performUpkeep();
            uint256 pay = keeper.balance - keeperBefore;
            totalPaid += pay;

            assertEq(balancer.reconciledSequence(), before + 1, "exactly one draw reconciled this call");
            // Not truncated to the incentive: the gas component was paid too (overhead alone is 50k x 5 gwei).
            assertGt(pay, 0.0001 ether + 50_000 * _hardPrice(), "gas component paid in full, not balance-starved");
            assertLt(pay, held, "one split reconcile costs far less than the whole batch hold");
            assertEq(pool.ownerProceeds(), 0, "still no proceeds flowed in");
        }

        // Every useful reconcile was paid, and the batch-sized hold covered all five with room to spare.
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence(), "all draws reconciled");
        assertLt(totalPaid, held, "the one-batch hold paid all five split reconciles");
        assertEq(balancer.requiredReserve(), 0, "nothing held once every draw is reconciled");

        // Closeout ends with nothing left: the leftover of the hold is now fully claimable.
        uint256 leftover = address(balancer).balance;
        assertGt(leftover, 0, "hold was more than enough; leftover remains");
        assertEq(balancer.withdrawableSurplus(), leftover, "all of it claimable");
        _claimAll();
        assertEq(address(balancer).balance, 0, "closeout ends at zero");

        // No further paid work exists.
        vm.prank(keeper, keeper);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep();
    }

    /// @notice The hold cannot be grown after close, and in-flight draws that NEVER receive VRF still drain it: FWA
    ///         force-expires a pending head past its deadline, so `nextSequenceToProcess` always catches
    ///         `lastIssuedSequence`. The creator is never permanently blocked from exiting.
    function test_holdCannotGrowAfterCloseAndNeverStrandsOnPendingDraws() public {
        uint256[] memory reqs = buy(buyer, 2);
        vm.prank(creator);
        balancer.close();

        uint256 held = balancer.requiredReserve();
        assertEq(held, _independentMaxReward(), "owed=2 -> one maximum reward held");

        // owed cannot be inflated after close: purchases are refused, so lastIssuedSequence is frozen.
        assertFalse(balancer.canPurchase(buyer), "closed pool admits no purchase");
        uint64 issuedAtClose = pool.lastIssuedSequence();
        // Evaluate the view args before expectRevert, so the guarded call is acquireBatch itself, not a staticcall.
        (,, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 iv = pool.inventoryVersion();
        uint256 deadline = block.timestamp + 1;
        vm.prank(buyer, buyer);
        vm.expectRevert();
        pool.acquireBatch{value: total}(buyer, 1, 0, 0, 10_000, iv, deadline);
        assertEq(pool.lastIssuedSequence(), issuedAtClose, "no new sequence after close");
        assertEq(balancer.requiredReserve(), held, "hold unchanged: it only falls as draws reconcile");

        _claimAll();
        assertEq(address(balancer).balance, held, "hold retained");

        // Never deliver VRF for either draw. After the selection timeout, anyone can force-expire and reconcile.
        vm.roll(block.number + 100);
        pool.processAcquisitions(5); // force-expires both pending heads
        assertEq(pool.nextSequenceToProcess() - 1, pool.lastIssuedSequence(), "FWA caught up; no stuck sequence");

        vm.prank(keeper, keeper);
        balancer.performUpkeep(); // reconciles both (<= MAX_RECONCILE)
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence(), "all reconciled");
        assertEq(balancer.requiredReserve(), 0, "hold released once reconciled");

        _claimAll();
        assertEq(address(balancer).balance, 0, "creator fully exits even though no draw ever won or delivered");
        assertEq(reqs.length, 2);
    }
}
