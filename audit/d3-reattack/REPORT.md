# D3 re-attack: the closed-pool keeper-pay hold in `requiredReserve()`

Independent, timeboxed (release-candidate tier, 45 min, informed) re-attack of one repair.

- Target: `src/PoolBalancer.sol` at commit `43885f2`, branch `test/flow-restock-in-flight`.
- Repair diff: `git diff 33ec26d 43885f2 -- src/PoolBalancer.sol`. Logic change is in `requiredReserve()`.
- External facts derived from the vendored, deployed FWA source at
  `external/fwa-poolsv2/StandardPoolBuyback-0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7/src/poolsV2/StandardPool.sol`.
- Evidence: `test/audit/D3ReAttack.t.sol`, run on the mainnet fork.

## The repair

While closed (`!enabled`), `requiredReserve()` changed from `return 0` to:

    owed = pool.lastIssuedSequence() - reconciledSequence;        // issued draws not yet reconciled
    return ceil(owed / MAX_RECONCILE) * MAX_KEEPER_REWARD;         // one max reward per 5-draw batch

`MAX_RECONCILE = 5`, `MAX_KEEPER_REWARD = (3,200,000 + 50,000) * 5 gwei + 0.0001 ETH = 0.01635 ETH`
(verified by independent calculation and against the contract constant). `withdrawableSurplus()` leaves this
amount behind; everything else is claimable.

## Verdict

The repair MEETS the owner's requirement. While closed it holds keeper pay for unreconciled draws, the hold is
sufficient to pay every useful post-close reconcile at the reward rule's hard bounds and through the split-call
pattern, it is released to the creator as draws reconcile, it reaches zero once all draws are reconciled, and a
closeout can end with nothing in the contract. The hold cannot be inflated after close and cannot be permanently
stranded. Timeboxed and informed: not a clean/complete/release-ready certification.

## Commands and gas context

    forge test --match-path test/audit/D3ReAttack.t.sol -vv      # 2 passed

Gas context is overridden from the ForkBase default to the reward rule's HARD bound and asserted from inside a
state-changing call (`FeeWitness.record()`): basefee 5 gwei, bid 10 gwei, so the reimbursed price
`min(bid, basefee + 0.05 gwei, 5 gwei)` clamps to the 5 gwei cap (`KEEPER_MAX_GAS_PRICE`). Fork block 26,382,349.

## Findings (ranked by consequence)

### 1. Sufficiency under split-call reconciliation of no-proceeds draws - executed, PASS

`test_splitCallReconcileOfExpiredDrawsIsFullyPaidFromTheHold`. The owner's exact motivating case: 5 draws issued in
one batch, left pending, then `close()`. `requiredReserve() == 0.01635 ETH` (ceil(5/5)=1 max reward). The creator
claims everything claimable, leaving exactly the hold (0.01635 ETH) as the sole pay source (`ownerProceeds == 0`
throughout - expired draws bring no inflow). FWA processing is permissionless, so each draw is force-expired and
reconciled one per call (`processAcquisitions(1)` then `performUpkeep`).

- Measured per reconcile at the 5 gwei cap: gasUsed 38,356, pay 0.00054178 ETH = (38,356 + 50,000) * 5 gwei
  + 0.0001 ETH (matches the published rule exactly; confirms the price was the 5 gwei cap, not Foundry's zero).
- Five split reconciles: total paid 0.0027089 ETH, every call paid in full (never balance-truncated;
  asserted pay > 0.0001 + 50,000 * 5 gwei). Leftover 0.0136411 ETH (~6x headroom).
- After the fifth: `reconciledSequence == lastIssuedSequence`, `requiredReserve() == 0`, leftover fully claimable,
  creator claims it, balance == 0, and a further `performUpkeep` reverts `NoUpkeepNeeded`.

The batch-sized hold (0.00327 ETH/draw) comfortably exceeds the worst real per-draw split cost (0.00054 ETH/draw at
the cap) because a closed-pool upkeep does no restocking - only `_collect` (which early-returns while closed) plus a
bounded reconcile loop. No attacker-controlled loop can push a single closed reconcile near `KEEPER_MAX_GAS`.

### 2. Hold cannot be inflated after close, and never strands on pending draws - executed, PASS

`test_holdCannotGrowAfterCloseAndNeverStrandsOnPendingDraws`. 2 draws, `close()`, hold 0.01635 ETH.

- No inflation: `canPurchase == false`; a real `acquireBatch` reverts; `lastIssuedSequence` is frozen, so owed
  (hence the hold) cannot grow. `close()` sets FWA `acquisitionsEnabled = false` and the admission gate returns
  CLOSED - two independent barriers. Staging/activation and FWA processing do not issue sequences.
- No stranding (liveness): neither draw ever receives VRF. Derived from deployed FWA source: a Pending head past
  `wordDeadlineBlock` (= issue block + `selectionTimeoutBlocks`, here 30, capped at `MAX_WINDOW_BLOCKS = 7,200`) is
  force-expired by the permissionless `processAcquisitions`, which advances `nextSequenceToProcess`. So
  `nextSequenceToProcess` always catches `lastIssuedSequence`, the balancer can always reconcile, and the hold
  releases. Executed: rolled past the timeout, `processAcquisitions(5)` expired both, one `performUpkeep` reconciled
  both, `requiredReserve() == 0`, creator exits to balance 0 - even though no draw ever won or delivered.

### 3. No free drain and no underflow - reasoned from code

- A closed `performUpkeep` pays the keeper only when `reconciled` is true (`ops == 0` while closed). Collecting
  proceeds alone pays nothing. Total paid closed calls <= owed, each <= its measured reward; once
  `reconciledSequence == lastIssuedSequence`, `performUpkeep` reverts `NoUpkeepNeeded`. A hostile approved keeper
  cannot drain beyond actual reconcile cost, and the creator reclaims the leftover.
- `reconciledSequence` only advances to `nextSequenceToProcess - 1 <= lastIssuedSequence`, so owed never
  underflows; the closed reserve/surplus/claim path cannot be bricked by underflow.
- `ceil(owed/5) * 0.01635e18` does not overflow uint256 at any realistic or even uint64-bounded owed.

## Economic pass - where the held ETH ends, per path (absolute amounts)

Hold while closed = ceil(owed / 5) * 0.01635 ETH. Per path:

1. Reconciled by a keeper (expired / no-proceeds draws): keeper receives the measured-gas reward (0.00054178 ETH per
   draw at the 5 gwei cap, executed); the creator reclaims the remainder; contract -> 0.
2. Reconciled by the creator (always an authorized upkeep caller): creator both pays and receives the reward, net
   reclaims the whole hold; contract -> 0.
3. Reconciled draws that won/delivered a prize: reconciling pulls in the sale proceeds (>> keeper pay), so the hold
   is never the binding source; creator claims the surplus. (reasoned.)
4. Never reconciled by anyone: not a persistent state - FWA force-expiry + permissionless processing guarantee
   owed -> 0 in bounded time; the hold releases. Worst case the creator drives it himself. (executed via the
   pending->expiry path.)
5. Pool retired with draws outstanding: `retirePool()` deliberately does not require an empty queue;
   `processAcquisitions` and the balancer reconcile have no `retired` guard, so the hold still drains and releases.
   (reasoned, not executed in this timebox.)

Scorecard line: closed-pool reserve holds ceil(owed/5) x 0.01635 ETH; at the gas cap the real cost to reconcile one
no-proceeds draw is 0.00054 ETH, so the hold over-provisions ~6x per batch and the excess returns to the creator on
reconciliation. Nothing ratchets; the hold only falls.

## What I did not cover

- Delivered-prize split reconcile per-call gas (path 3) - reasoned only; the hold is not the binding source there.
- Retired-pool drain of the hold (path 5) - reasoned from the absence of a `retired` guard; not executed.
- The OPEN-side `requiredReserve()` branch and `open()`-after-`close()` reserve recheck beyond noting a failed
  recheck reverts the reopen and leaves the closed hold intact.
- Non-fork concerns (live keeper behaviour, gas-market timing, VRF delivery failure in production).

## Things that don't make sense

None blocking. Notes:

- The diff comment cites finding 6's accepted split cost as "0.000124 ETH per draw at 0.55 gwei"; that is the OPEN
  upkeep split. The CLOSED per-draw cost measured at the 5 gwei hard cap is 0.00054 ETH, against a 0.00327 ETH/draw
  hold - consistent and amply covered.
- The closed hold rounds up per 5-draw batch, so when owed is not a multiple of 5 the creator's immediately
  claimable amount is slightly reduced, but the full excess is released once the draws reconcile. Intended and benign.
