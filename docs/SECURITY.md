# Security review

**No external professional audit has been performed.** This report records internal adversarial review by AI agents
and automated tooling. It is bounded evidence, not a statement that the contracts are safe.

## Scope

- `src/PoolBalancer.sol`, `src/BalancerFactory.sol`, `src/interfaces/External.sol`.
- Deployed dependencies read from verified sources: FWA PoolFactory `0x8919…477C`, StandardPoolBuyback/StandardPool
  `0x85Fa…fEe7` (runtime code hash `0x0af01f…ce02`), FWA VRF service `0x7D93…d65d`, Shapes `0x6fE9…FAf0`.
- Out of scope: TypeScript keeper and dashboard (tested functionally, not adversarially), FWA and Shapes themselves, and
  FWA's off-chain pool-page server.

Two rounds:

| Round | Target | Repairs |
| --- | --- | --- |
| 1 (initial build) | `c7ead79` | `ac99894`, `e7b1640` |
| 2 (simplification and hardening pass) | `924bf99` | `d0b720a`, `c3203a4`, `cbc75d3`, and the N-2 fix |

## Method

1. Each round: two reviewers with clean context, given the immutable target commit, the owner requirements, the
   dependency sources, scope, methods and budget; no design notes or earlier conclusions. Lanes: custody / authority /
   ERC-1271 / reentrancy / admission, and keeper reimbursement / refunds / reserve / repricing / liveness. Both wrote and
   executed mainnet-fork tests against the real FWA pool and Shapes, including `--isolate` gas measurements and real
   anvil receipts. Reviewers were told not to read `docs/` or other worktrees; the repository still contained earlier
   reports and test names that describe earlier findings, so these reviews are independent, not process-blind.
2. Repairs re-reviewed by the reviewer of the affected lane, which re-ran its attack tests against the repair commit.
3. The project's own fork suites: scenario, behavior/adversarial, hardening, stateful invariants, gas (isolated),
   planner parity; keeper e2e asserting reimbursed gas ≤ receipt gas on every keeper transaction.
4. Slither 0.11.5 in round 1 (medium and above triaged).

## Round 2 findings

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| F1 | Medium | A repricing step that finished inside an upkeep was followed by a fresh 6-operation rebalance budget: 12 operations and 3.39M billed gas, above the 3.2M reward cap (executed). Rational keepers would skip it; the pool stays closed until the creator runs upkeep. | Fixed (`d0b720a`): one budget per call. Re-review: fixed; worst bounded case 5 reconciles + 6 mints in 6 denominations billed 3.10M. `test_repricingAndRebalanceShareOpsBudget`. |
| F2 | Low | The 21k intrinsic-gas credit was added per call, so a contract making several paid upkeeps in one transaction was reimbursed more gas than billed (executed, isolated and real receipt: +19k gas over 7 calls). | Fixed: no intrinsic credit; reimbursed gas is 4/5 of the measured span. Re-review: 7 calls billed 5,471,393, reimbursed 5,349,227 (real receipt). `test_gas_multiCallPlanSwitchInOneTx`. |
| F3 | Low | The fixed 0.0005 ETH incentive could be farmed by buying one's own draws in pools whose draw price is below ~0.007–0.01 ETH (executed: +0.0002 ETH per cycle). | Fixed in two steps. `d0b720a` capped the incentive at FWA's edge on one draw at the current price; re-review showed draining a pool's only cheap curated NFT made that cap 10× the edge actually paid (executed, +0.00031 ETH). `c3203a4` capped at the edge actually escrowed by the call's draws; re-review showed a cheap draw forcing a 7-call plan switch let the 6 draw-free calls each earn a full incentive (executed, +0.0032 ETH). Final repair: purchase-caused work is paid from a per-batch credit equal to FWA's edge on that batch, spent across all following calls; creator-started work pays in full. `test_drawCausedWorkEarnsAtMostEdgePaid`, `test_incentiveCapUsesEscrowedFee`, `test_incentiveCappedByDrawEdge`. |
| F4 | Low | A checkpoint could be written with too little ETH to stay admissible after the same call paid its keeper; funding exactly `requiredReserve()` never opened the pool. | Fixed: `_checkpoint` also requires one more maximum keeper reward (`d0b720a`), and `requiredReserve()` holds it while open (`c3203a4`, see N-1). `test_checkpointCoversItsOwnReward`, `test_claimAllSurplusThenRecheckpointStaysOpen`. `requiredReserve()` now also counts one reward per refill step still needed; funding exactly it opens a new pool (`test_exactRequiredReserveOpens`). |
| N-2 | Low (repair review) | In `cbc75d3`, a creator deposit (or `open()` on an open pool) set the creator-work flag without closing admission, so a self-dealer's purchase-caused work again earned full incentives (executed, +0.0031 ETH). | Fixed: deposits never set it; `open()` sets it only while no valid checkpoint exists. Every action that sets it has closed admission. `test_creatorTopUpWhileOpenKeepsCredit`. |
| N-1 | Info (repair review) | After `d0b720a`, claiming all reported surplus left the balance below what the next re-checkpoint needed, so any creator edit closed purchases. | Fixed in `c3203a4`. |
| L-2 | Low | Pool-page approvals could not be revoked and survived a creator transfer; `isValidSignature` ignores signature bytes, so any approved digest is replayable by anyone. | Fixed (`d0b720a`): approvals are scoped to an epoch; `revokePoolPages()` and every accepted creator transfer start a new one. Re-review: fixed. `issuedAt` is format-checked, not range-checked (Info: the creator can revoke). |
| I-3 | Info | A plan that could not fit beside the curated listings within the 100-listing limit made every upkeep revert `TooManyListings` while open, blocking reconciliation and creator edits until `close()`. | Fixed (`d0b720a`): such a plan is infeasible. Re-review: fixed, including a plan switch at capacity. `test_planBeyondListingLimitIsInfeasible`. |
| L-1 | Low | FWA lets a buyer name any purchaser. Naming the Balancer: if a curated NFT's delivery then fails (transfer-restricted collection), only the Balancer could refund, and it has no function for that; after the 7-day window the NFT stays in FWA (executed). | Accepted and documented: the attacker pays the full draw price for a random draw and the collection must reject transfers to the Balancer. A fix would add an FWA refund path. |
| I-1 | Info | Naming the Balancer as purchaser delivers the drawn NFT (e.g. a Shape) to the Balancer, which then holds it between transactions. | Accepted: untracked, creator-recoverable with `recoverUntrackedNFT`; not counted in reserve. |
| I-2 | Info | Naming the Shapes contract as purchaser makes a drawn Shape undeliverable (Shapes rejects self-custody) and unrefundable; its backing stays in FWA (executed). `recoverRefundedShape` is effectively unreachable with mainnet Shapes. | Accepted: costs the attacker about the damage in expectation. |
| I-4 | Info | A markup change and change back (A→B→A) before any upkeep leaves `repricing` set with nothing to reprice; that call scans 100 listings (~0.4M gas) and may also reconcile and mint, possibly exceeding 3.2M. | Accepted: the keeper is under-reimbursed for that one call; no funds or authority affected. |
| I-5 | Info | The 4/5 rule and the absent intrinsic credit mean single-call keepers absorb ~20% of gas plus 21k; gas-only paths (refund-only batches, `recoverRefundedShape`) always lose money for keepers. | Accepted by design: the incentive covers paid work at normal gas; the bundled keeper's `MAX_LOSS_WEI` covers the rest. |

## Round 1 findings (initial build)

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| R-1 | High | Upkeep called FWA `recoverRefundedNFT` without failure isolation; a refunded curated NFT whose collection blocked transfers made every upkeep revert. | Fixed; round 2 removed pending scanning from upkeep entirely. |
| R-11 | Medium | The first R-1 repair forwarded unbounded gas to curated collections (~11M gas per upkeep). | Fixed: upkeep never calls curated collections. |
| R-2, R-3, R-4, R-5, R-6, R-12 | Low/Info | Settled-after-retry rollback, `_onDrawn` revert, invalidate-after-external-call in listing, claims during the reconcile window, unbounded unwind, stale `needsUpkeep` hint. | Fixed (R-12 by removing `needsUpkeep`). |
| R-7, R-8, R-13 | Low/Info | One keeper reward reserved; no pay for pure re-checkpoints; closing lets the creator claim before the last batch's upkeep. | Accepted (R-7 now two rewards while open). |

## Properties examined (round 2)

| Property | Evidence | Outcome |
| --- | --- | --- |
| Reimbursed gas ≤ billed gas after refunds | proof sketch (EIP-3529 cap ≥ 1/5) + isolated benchmarks of 13 paths + real anvil receipts in keeper e2e and review (single and multi-call) | held after F2 repair |
| Reimbursed price ≤ basefee + 0.05 gwei and ≤ 2 gwei | fork tests with a 3 gwei bid at 0.15 gwei basefee (ApeBall pattern), 5,000 gwei bid, 80 gwei basefee | held |
| No paid self-created work | self-dealing PnL tests by reviewer (three rounds), credit tests; incentives from purchase-caused work are bounded by FWA's edge on the purchases by construction | held after the third F3 repair |
| ≤ 6 inventory operations and ≤ 3.2M gas per upkeep | F1 tests, worst bounded case 3.10M | held except I-4 |
| Upkeep gas independent of history | 200 refunded curated deliveries on a frozen collection: 847k before, 836k after | held |
| Repricing never skips a listing, resumes, keeps creator values, closes admission | 100-listing test with out-of-gas keeper call and two withdrawals mid-run | held |
| Untracked recovery never releases protected assets | active curated/Shape listings, pending and refunded deliveries, pool/factory as collection, lying collection, hostile reentry | held |
| ERC-1271 approves only this pool's FWA page message | digest equals EIP-191 of FWA's template (independent reconstruction in Solidity and viem `verifyMessage`), raw/altered/arbitrary messages rejected, epochs | held |
| Reentrancy via hostile ERC721 into every public function | reviewer test reentering upkeep, claim, recovery, withdrawal | held |
| Admission: one batch per checkpoint, < 100k gas, no token offers | fork tests (cold `canPurchase` ~49.2k) | held |
| Reserve after redemption and plan switches; claims cannot break admission | reserve tests, claim-all-then-edit test, invariants (4,096 calls) | held after N-1 |

## Residual risks

- **FWA trust.** FWA's factory owner can pause purchases or VRF and set withdraw-only globally; the reviewed pool
  implementation is pinned, but FWA infrastructure (VRF service, fee router, off-chain site) is trusted.
- **Purchaser naming (L-1, I-1, I-2).** Griefing at roughly the attacker's own cost.
- **Shapes admin** can raise the mint fee up to 0.01 ETH; admission closes until re-funded, and small denominations
  become uneconomic.
- **Economics.** The reserve funds the next restoration, not profitability (`docs/simulation-results.md`).
- **Keeper liveness.** Above 2 gwei basefee keepers wait and new purchases pause. Fill steps are unprofitable for keepers
  above ~0.76 gwei. Creators can always run upkeep themselves.
- **Pool page.** Whether FWA's server accepts ERC-1271 from a contract owner is unverified; FWA's message template is
  copied from its client and could change.
- **No professional audit, no formal verification.** Invariant campaigns are short (64 runs × 64 calls).
