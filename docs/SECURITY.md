# Security review

**No external professional audit has been performed.** This report records internal adversarial review by AI agents
and automated tooling. It is bounded evidence, not a statement that the contracts are safe.

## Scope

- `src/PoolBalancer.sol`, `src/BalancerFactory.sol`, `src/interfaces/External.sol`.
- Reviewed target for discovery: commit `c7ead79` (one reviewer's worktree was cut from `959e64f`, whose `src/` differs
  only in keeper constants). Repairs: commits `ac99894` and `e7b1640`.
- Deployed dependencies read from verified sources: FWA PoolFactory `0x8919…477C`, StandardPoolBuyback/StandardPool
  `0x85Fa…fEe7` (runtime code hash `0x0af01f…ce02`), FWA VRF service `0x7D93…d65d`, Shapes `0x6fE9…FAf0`.
- Out of scope: TypeScript keeper and dashboard (tested functionally, not adversarially), FWA and Shapes themselves.

## Method

1. Two independent reviewers with clean context, given only the target commit, the owner requirements and the
   dependency sources (no design notes or prior conclusions). Lanes: custody/authority/keeper; accounting/reserve/
   admission/FWA integration. Both wrote mainnet-fork tests against the real FWA pool.
2. Slither 0.11.5 (medium and above triaged below).
3. The project's own fork suites: scenario, behavior/adversarial, stateful invariants, gas, planner parity.
4. Repairs re-reviewed by the accounting reviewer (see "Repair review").

## Findings

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| R-1 | High | Upkeep called FWA `recoverRefundedNFT` without failure isolation. A refunded curated NFT whose collection later blocks transfers made every `performUpkeep` revert; if another batch was drawn first, it could never be reconciled and `PoolBusy` then blocked `unwind`/`withdrawCurated`. Executed on fork by the reviewer. | Fixed. First repair (`ac99894`, try/catch) was superseded after repair review (R-11); final (`e7b1640`): upkeep never calls curated collections; refunded curated NFTs stay pending for `recoverCuratedNFT`. Reviewer executed the interleaving variant on the repair; regression `test_blockedRefundRecoveryDoesNotBrickUpkeep`. |
| R-2 | Low | A delivery retried to success externally was cleaned up by upkeep, then rolled back by `NoUpkeepNeeded`, leaving `needsUpkeep()` true. | Fixed: pending-set changes count as a state change (unpaid). `test_settledAfterRetryIsCleanedUp`. |
| R-3 | Low (internal) | `_onDrawn` reverted on an unexpected item state, which would brick reconciliation. | Fixed: skip; new checkpoint check `activeListingCount == tracked set` fails closed on any desync. |
| R-4 | Low (internal + Slither context) | `listCurated`/`listCuratedBatch`/`updateCuratedPrice` invalidated the checkpoint after external calls; a collection transfer hook could buy against the still-valid checkpoint, staging the new listing and leaving the pool stuck at `INVENTORY_MISMATCH`. | Fixed: invalidate first. `test_collectionHookCannotBuyDuringListing`. |
| R-5 | Low | `claimSurplus` used stale inventory between FWA settlement and reconciliation. Reviewer showed the worst-5 floor still covered restoration (executed). | Hardened: while open, claims require a reconciled pool. `test_claimWaitsForReconciliationWhileOpen`. |
| R-6 | Info | `unwind` redeemed all spares in one call. | Fixed: at most 20 per call. `test_unwindRedeemsInBoundedSteps`. |
| R-7 | Low/Info | Only one maximum keeper reward is reserved; restocking that needs several upkeeps can require a top-up. | Accepted: fails closed. Documented in OPERATIONS.md. |
| R-8 | Low | No keeper payment for a pure re-checkpoint (e.g. after close/open or a deposit). | Accepted by requirement ("do not pay merely for creating a checkpoint"); the creator can call upkeep. |
| R-9 | Info | A purchaser contract that rejects delivery and never refunds keeps a curated NFT in FWA's delivery escrow indefinitely. Only the purchaser can refund. | FWA property; residual risk below. |
| R-10 | Info | A creator can list a malicious collection in their own pool. | Trust model: affects only that creator's pool. |
| R-11 | Medium (repair review) | The `ac99894` try/catch forwarded unbounded gas to an untrusted curated collection: a gas-burning collection made each upkeep cost ~11.0M gas instead of 0.27M (executed), so keepers would stop servicing the pool. | Fixed in `e7b1640`: upkeep recovers only refunded Shapes (trusted, hook-free). `test_gasGriefingCollectionCannotTaxUpkeep` (< 1.5M gas). |
| R-12 | Low (repair review) | `needsUpkeep()` stayed true for a stuck refunded curated item while `performUpkeep` reverted `NoUpkeepNeeded`. | Fixed in `e7b1640`: the hint ignores refunded curated items. |
| R-13 | Info (repair review) | After `close()`, the creator can claim the full balance while a final batch is still settling, leaving that reconciliation unpaid. Player escrow is held by FWA. | Accepted. |

Slither (medium+): reentrancy reports are inside `nonReentrant` functions and concern view functions or the now-fixed
R-4 ordering; divide-before-multiply mirrors FWA's exact formula deliberately; `reward == 0` strict equality is intended.

## Properties examined

| Property | Evidence | Outcome |
| --- | --- | --- |
| Admission ≤ FWA's 100k stipend | real 100k staticcall on fork: 46.8k–49.3k gas; no loops in `admissionStatus` | held |
| One batch at a time, ≤ 5 draws | fork: second `acquire`/`acquireBatch` reverts `PurchaseNotAllowed` until reconciled; invariant handler asserts closure after every batch | held |
| Token purchases impossible | no code path reaches `configureTokenOffer`; `acquireWithToken` reverts; creator/stranger cannot configure; no fallback | held |
| Operator permanent | set once in `initialize`; no setter | held |
| Only the creator moves curated NFTs and ETH; keeper only receives a bounded reward | code review by both reviewers; permission tests for every creator function | held |
| Keeper reward bounds under gas-price manipulation | fork: 5,000 gwei priority and 80 gwei basefee both capped | held |
| No payment for redundant or self-created work | fork: duplicate call reverts; config-only re-checkpoint unpaid; work requires paid purchases | held |
| Worst-5 reserve, spares and deficits | fork: reserve math; plan switch with spares; reviewer's worst case (5 × 0.5 ETH after pulling to the floor) | held |
| Inventory equals FWA state at admission | invariant suite; checkpoint totals and listing-count checks | held under tested sequences |
| Upkeep cannot be bricked | R-1/R-3 fixed; repair review | see repair review |
| Reentrancy via ERC721 hooks, Shapes mint, ETH payout | reentrant and hook-buying collections on fork; force-sent reward to a reverting keeper | held |
| Outstanding draws/refunds/claims independent of the Balancer | FWA code paths are permissionless and do not call the Balancer except the read-only gate | held (reasoned) |

## Repair review

The accounting reviewer re-reviewed `ac99894` on the fork: R-1 fixed including the interleaving case (executed), R-5
fixed, R-3/R-4 sound; it found R-11 and R-12, fixed in `e7b1640` using its recommended option. It then re-reviewed
`e7b1640` on the fork: gas-griefing upkeep 248,022 gas (was ~11.0M), hint consistent, interleaving still reconciles,
creator recovery works on healthy and fails in isolation on hostile collections; no new revert path found. Remaining
Info: refunded curated NFTs the creator has not recovered stay in `pendingIds` (one cheap read each per upkeep).

## Residual risks

- **FWA trust.** FWA's factory owner can pause purchases, VRF or set withdraw-only globally; the reviewed pool
  implementation is pinned, but FWA infrastructure behavior (VRF service, fee router) is trusted.
- **Shapes admin** can raise the mint fee up to 0.01 ETH; admission closes until re-funded, and small denominations can
  become uneconomic.
- **Economics.** The reserve guarantees funding for the next restoration, not profitability. Simulations show losses at
  low markups, small denominations, high gas or high mint fees (docs/simulation-results.md).
- **Curated delivery escrow** (R-9) and malicious collections chosen by the creator.
- **Pool page metadata.** FWA's off-chain page edits need an owner wallet signature; the Balancer cannot sign. Purchases
  are unaffected.
- **No professional audit, no formal verification.** Invariant campaigns were short (16–64 runs × 25–64 calls).
