# Round 9 — Lane A addendum (post-seal)

Start (UTC): 2026-11-13T11:56Z (coordinator continuation). End (UTC): 2026-11-13T12:12Z. The original seal
(`../sealed-inventory.md`, `../discovery-seal.md`) stands and is unchanged; this is additive. Same blind access rules;
no excluded files read. All new work under `addendum/`. Run per file:
`FOUNDRY_TEST=audit/round9/lane_a/addendum FOUNDRY_OUT=audit/round9/lane_a/out FOUNDRY_CACHE_PATH=audit/round9/lane_a/cache forge test --match-path <file>`.

## Method correction applied: real VRF route

All randomness is now delivered through the **real Chainlink coordinator -> VRF service -> pool** route: prank the
coordinator `0xD7f86b4b8Cae7D942340FF628F82735b7a20893a` and call
`service(0x7D93…).rawFulfillRandomWords(reqId, words)`, where `reqId` is the coordinator's `RandomWordsRequested`
requestId captured from the `acquire` tx logs (topic `0xeb0e36…`). The service runs its own bookkeeping and forwards
to the pool. Verified once in `RouteExplore.t.sol::testExploreRoute` (settles the draw, credits proceeds via the
service). The coordinator-level requestId equals the pool's `acquire` return value. Every proceeds-dependent result
below was (re-)run through this route; `AddendumBase.sol` is the shared harness (`drawReal`, `acquireOnly`,
`fulfillReq`). The earlier shortcut (pranking the service to call `pool.rawFulfillRandomWords`) gave identical
tracking/profit figures for the M9 PoC (T1: 0.001985 -> 0.002383 ETH either way), so the original seal's conclusions
are unaffected; proceeds *amounts* are now taken from the real route.

## 1. Extent of the M9 finding (`M9Extent.t.sol`, `M9Scale.t.sol`)

For each creator action / timing, identical proceeds, honest collect vs action-then-collect, in the game-first regime
(fund < reserve, reached via one unreconciled settled draw). Board: 5x0.01 shapes + 1 curated, 30% markup unless noted.
Honest profit baseline = **0.001985 ETH**.

| Lever tested | Result | Is it a lever? |
|----|----|----|
| **withdrawCurated then collect** (T1) | profit 0.001985 -> **0.002383** (x n/(n-1) = 6/5) | **YES** — books more profit on the same proceeds |
| **collection timing**: creator `collectProceeds` standalone vs keeper `performUpkeep` first (T2) | 0.001985 vs **0** (keeper reconciles first, dropping the draws-in-flight reserve term so the game-first gate no longer fires) | TIMING only — changes *when* the creator can withdraw, not the lifetime total (keeper path then lets `balance-reserve` be withdrawn once reconciled) |
| **unlistShapes** a shape (T3) | 0.001985 -> 0.001906 (lower) | NO — identical-denom shapes have positive share; removing one lowers the numerator proportionally |
| **listCurated** more before collect (T4) | 0.001985 -> 0.001702 (lower) | NO — adds a 0-share listing, dilutes creator share (fund-favorable) |
| **creator transfer** (T5) | unchanged | NO |
| **configure** to a bigger target (T6) | unchanged | NO — doesn't change existing-listing shares; didn't flip the (already-short) gate here |

**Worst case at launch scale (`M9Scale::testWorstCaseNetLeak`)**: 100% markup, 10x0.01 shapes + **10 curated**, short
regime, one draw's proceeds. Honest collect books **0 profit** (fund correctly keeps all 0.085 ETH; while short the
creator can withdraw **nothing**). Withdraw all 10 curated, then collect: books **0.01738 ETH** as withdrawable
`profit`; the creator claims it and the **fund drops to 0.0677 ETH** (−0.01738). So a creator action turns a
correctly-zero extraction into a 0.01738-ETH extraction of fund money while the pool is underfunded — a direct M9 /
"game first" violation, confirmed as a *net* extraction (fund ends strictly lower).

**Balanced-mix (packet) at 15% markup, 1 curated of ~40 listings** (`testBalancedMixSingleCuratedLeak`): extra
**0.0000198 ETH/cycle** (ratio ≈ 40/39). The lever scales with k/(n−k) for k curated withdrawn of n listings, so it is
weak with the packet's single NFT and strong only when the creator lists many curated NFTs to withdraw at once.

**Cost to the creator / practical bound.** The maneuver needs the game-first regime (fund < reserve: early life, or
draws in flight) and, after withdrawing curated, re-listing them (else `NO_CURATED` pauses purchases and re-listing
re-triggers a `SETTING_UP` pause). Per cycle the creator pays withdraw+relist+upkeep gas (~3M+ gas ≈ 0.015 ETH at
5 gwei for 10 NFTs), so a single draw's proceeds barely cover it; it pays only when proceeds have accrued across many
draws before the maneuver and the board carries many curated NFTs. A running keeper collects proceeds on each upkeep
(and its reconcile-first path books no profit), which limits how much the creator can let accrue. **Severity: Medium**
— a real, demonstrated violation of a central invariant with net ETH extraction, but bounded and operationally costly.

**Per-month figure.** With K curated of N listings at markup m and P ETH of proceeds collected per short-regime cycle,
the per-cycle leak ≈ P · share(m) · K/(N−K), share(m) ≈ (m−0.10)/(1+m) of the drawn value. At 100% markup, K=N/2:
leak ≈ 0.45·P per cycle. At, say, 10 short-regime collect cycles/month that evade keeper collection, and P≈0.1 ETH
accrued per cycle: order 0.45 ETH/month — but this requires the creator to repeatedly win the race against keepers and
pay the per-cycle gas, so treat it as an upper bound, not an expected value.

**Root cause (unchanged from the seal):** `_collect` (src/PoolBalancer.sol:830-842) splits all accrued proceeds by the
*current* `profitShareSum / activeIds.length`, and the listing-set-mutating creator functions don't `_collect` first.
Suggested fix (suggestion only): `_collect()` at the start of `withdrawCurated`, `unlistShapes`, `listCurated*`,
`updateCuratedPrice`, `configure`, and attribute per settled draw rather than by a post-reconcile snapshot average.

## 2. Draws in flight (`StatefulCycle.t.sol`)

20x0.01 board, 30% markup. One draw in flight (settle, reconcile) and a **burst of 5** (the MAX_BATCH max) acquired
before any settlement, then settled and reconciled. Invariants asserted at rest after every step (open, build, curated,
each acquire, each settle, each reconcile, collect, max-claim, close, each unlist batch, teardown):
`profit <= balance`, `keeperCredit <= balance`, `withdrawableSurplus <= balance`, `#active-shape-items ==
sum(activeShapes)`, and (at fully-reconciled points) every active shape's token held by the FWA pool. **All held.** The
5th acquire is admitted (unsettled reaches 5); the FILL gate's per-unreconciled-draw `MAX_PRIZE_WEIGHT` charge is what
makes the mid-flight "token delivered to winner but still tracked ACTIVE" window safe. Result: PASS.

## 3. Draw Pack lifecycle (`PackLifecycle.t.sol`)

0.02-ETH pack (denom 9, 2 shapes). Minted by upkeep (`createPackTo`), listed, held by the FWA pool while listed. Forced
a draw to win the pack; **the winning player redeems it for exactly 0.02 ETH** (`testPackWinAndRedeem`). Unlisting a
pack withdraws it from FWA and redeems here for **exactly 0.02 ETH to the pool** (`testPackUnlistRedeemsToPool`). M4
holds for packs. Result: PASS.

## 4. Failed delivery / refund (`RefundPath.t.sol`)

- **Hostile receiver** (rejects `onERC721Received`, refuses ETH): its draw settles, the prize Shape is delivered via
  **plain `transferFrom`** (no hook check), so the item is FULFILLED and deleted and **reconciliation is not bricked**
  (`testDeliveryFailureRefundLedger`). A hostile receiver cannot force a failed-delivery/refund.
- **Transfer-reverting curated collection** (`testCuratedFailedDeliveryRecovered`): a curated NFT whose delivery to the
  winner reverts does fail delivery -> item PENDING, FWA status 6. The pool is credited **no proceeds** for it
  (`ownerProceeds` stays 0, so no double-dip). The winner (purchaser) calls `refundFailedDelivery` after the 7-day
  window (it is `NotPurchaser()`-gated to the winner), moving the listing to status 7; then creator `recoverRefunded`
  **returns the NFT to the creator and clears the item**. Verified. The player-side refund *amount* is FWA-internal and
  measured as 0 in this harness; attributing it needs FWA source (out of blind scope) — flagged for the informed phase.

## 5. Stateful full cycle

Covered by `StatefulCycle.t.sol` (section 2): open -> build -> draws (1 + burst 5) -> restock -> collect -> max-claim
-> close -> unlist -> withdraw, invariants after every step, **M7 teardown clean** (0 residual ETH, 0 listings, 0
stranded proceeds).

## New untested / residual

- The player's exact ETH outcome on a failed curated delivery (FWA-internal; needs FWA source).
- The automatic (no-creator-action) curated-draw-books-NFT-money-as-profit case still lacks a standalone PoC (the
  withdrawCurated and timing levers above are the creator-action instances of the same root cause).
- Mint-fee rise to 0.005/0.01 ETH, gas-price sweeps, and off-chain parity remain as in the original seal §4.
