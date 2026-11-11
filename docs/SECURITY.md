# Security review

**No external professional audit has been performed.** This report records internal adversarial review by AI agents
and automated tooling. It is bounded evidence, not a statement that the contracts are safe.

## Scope

- `src/PoolBalancer.sol`, `src/BalancerFactory.sol`, `src/interfaces/External.sol`.
- Deployed dependencies read from verified sources: FWA PoolFactory `0x8919…477C`, StandardPoolBuyback/StandardPool
  `0x85Fa…fEe7` (runtime code hash `0x0af01f…ce02`), FWA VRF service `0x7D93…d65d`, Shapes `0x6fE9…FAf0`.
- Out of scope: TypeScript keeper and dashboard (tested functionally; round 5 reviewed them as secondary scope), FWA
  and Shapes themselves, and FWA's off-chain pool-page server.

Six rounds:

| Round | Target | Repairs |
| --- | --- | --- |
| 1 (initial build) | `c7ead79` | `ac99894`, `e7b1640` |
| 2 (simplification and hardening pass) | `924bf99` | `d0b720a`, `c3203a4`, `cbc75d3`, `7fcdbe4` |
| 3 (keeper liveness and griefing bound, owner review) | `1f352fa` | `6a2dabe` |
| 4 (reimbursement re-evaluated against FWA V2; launch rehearsal) | `5161e8f`, then `0a48e84` | `0a48e84`, `31edef6` |
| 5 (independent adversarial audit, `audit/report.md`) | `0f01784` | dashboard only; contracts unchanged |
| 6 (pack prizes: Draw Packs sizes 9-15) | `57510f3` | this round's repair commit |

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
| L-1 | Low | FWA lets a buyer name any purchaser. Naming the Balancer: if a curated NFT's delivery then fails (transfer-restricted collection), only the Balancer could refund, and it has no function for that; after the 7-day window the NFT stays in FWA (executed). | Fixed (`1f352fa`): `canPurchase` refuses the Balancer, Shapes and the FWA pool as purchasers. Re-review: correct, 52k gas cold, no other acquire path. Remaining class bounded below (G-1). |
| I-1 | Info | Naming the Balancer as purchaser delivers the drawn NFT (e.g. a Shape) to the Balancer, which then holds it between transactions. | Fixed by the same purchaser gate (`1f352fa`). |
| I-2 | Info | Naming the Shapes contract as purchaser makes a drawn Shape undeliverable (Shapes rejects self-custody) and unrefundable; its backing stays in FWA (executed). `recoverRefundedShape` is effectively unreachable with mainnet Shapes. | Fixed by the same purchaser gate (`1f352fa`). |
| I-4 | Info | A markup change and change back (A→B→A) before any upkeep leaves `repricing` set with nothing to reprice; that call scans 100 listings (~0.4M gas) and may also reconcile and mint, possibly exceeding 3.2M. | Accepted: the keeper is under-reimbursed for that one call; no funds or authority affected. |
| I-6 | Info (repair review) | A batch bought before a creator action that closes admission (configure, close) is reconciled with the full incentive. The buyer cannot cause or time the creator action. Confirmed: no remaining path sets or keeps the creator-work flag while purchases can be admitted (only setters close admission; it clears in the call that writes the checkpoint; the keeper payout's 100k stipend cannot fund an FWA purchase). | Accepted. |
| I-5 | Info | The 4/5 rule and the absent intrinsic credit mean single-call keepers absorb ~20% of gas plus 21k; gas-only paths (refund-only batches, `recoverRefundedShape`) always lose money for keepers. | Accepted by design: the incentive covers paid work at normal gas; the bundled keeper's `MAX_LOSS_WEI` covers the rest. |

## Round 6 (pack prizes)

One independent AI reviewer, target `57510f3`, scope: the pack-prize change in `PoolBalancer`, `PoolPage`, the deploy
script, the vendored Draw Packs at `3a463f7` as a dependency, and TypeScript parity.

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | Medium | The checkpoint and `requiredReserve` held one keeper reward for restoring a batch, but five drawn three-Shape packs (15 Shape units) take three upkeep calls. Failed safe (no overdraw or wrong admission; the pool stayed closed), but surplus claims could leave a pack pool stuck until topped up. | Fixed: `_batchSteps` holds one maximum reward per restoring call; mirrored in `shared/planner.ts`; `test_worstPackBatchRebuildsWithinTheReserve` rebuilds five drawn packs in at most the three calls held. |
| 2 | Low | `createPackTo` needs exact payment; `_cost` equals it only because each pack value is an exact greedy sum of Shapes, with no runtime guard. | Covered by test instead of bytecode (164 B margin): `test_everyPackSizeMintsAtExactValueWithItsShapes` mints all 7 sizes and checks value and Shape count. |
| 3 | Info | `PoolPage` is a linked external library; a missed library deployment or verification could look like success. | Confirmed on the 8545 fork (library deployed through the CREATE2 deployer, address present in the implementation's code); readiness lists Etherscan verification of the library and the Draw Packs pair. |

Checked sound by the reviewer: the packed size tables decode correctly; the three-fee reserve bound holds for any mint
fee; every listed price maps back to one size for markups 0-100%; every prize is redeemed for exactly its backing on
unwind, plan switch and refund recovery; no new reentrancy path (`onERC721Received` is pure, all mutating entry points
are `nonReentrant`); the gate refuses the Balancer, Shapes, Draw Packs and the FWA pool; Draw Packs is not upgradeable
or pausable, charges no fee and its admin reaches presentation only; deploy wiring and TypeScript parity.

## Round 5 (independent adversarial audit)

An AI auditor with no access to earlier findings audited `0f01784` (contracts unchanged since `31edef6`) for 12
auditor-hours: two discovery lanes, then informed challenge reviews, fork PoCs at block 26,382,349, guided stateful
campaigns (128 single-draw and 64 mixed-batch admissions), Slither, and a secondary pass over the dashboard and
keeper. Report: `audit/report.md` (PoC sources and raw outputs are kept off the public repository). Its limits: discovery isolation was prompt-level only; no human
review; schema-2 path gate not passed (4/55 entrypoints mapped in its manifest); 14 Slither alerts on dependency
boundaries left open; no live refunded-Shape state reached. No outsider path to take ETH or tracked assets was found.

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| F1 | Medium (conditional) | A curated collection with a backdoor can move a listed NFT out of FWA while the listing stays drawable; a buyer who draws it gets the acquisition fee back after 7 days and loses the VRF fee (0.00234 ETH at 1 gwei). Requires the creator to list such a collection. | Accepted, documented: the contract cannot check custody within FWA's 100k-gas hook. Dashboard: list only trusted collections. |
| F2 | Medium (conditional) | A collection that can freeze transfers blocks withdrawal and recovery of its listed NFT. Other exits keep working. | Accepted, documented (same warning). |
| F3 | Low | The creator's own collection can call `configure` during `listCurated`; that listing keeps the old markup while purchases are admitted. Buyers get a discount; no third party loses. | Accepted, documented in SPEC (Curated NFTs). Fix if wanted: `nonReentrant` on `configure`. |
| F4 | Low | Status 0 can coexist with FWA's VRF service refusing a purchase for lack of capacity (after local expiry without a callback). Costs the buyer gas only; a late callback restored service. | Accepted, documented: status 0 is labelled "the Balancer admits purchases". |
| F5 | Low | A creator `configure` that changes nothing, while a batch is outstanding, makes that batch's refill creator work, paid the full incentive (+0.00021 ETH over the edge credit). Extends V-5. | Accepted, documented in SPEC (keeper reward). Creator-only; gating it would stall upkeep after creator edits. |
| S1 | Low | Dashboard: the prepared write did not name the simulated account, so a wallet that switched accounts before sending sent from the new one (e.g. pool creation with a deposit). | Fixed: `prepareWrite` returns the simulated account and chain; wagmi refuses a mismatch (`app/src/tx.test.ts`). |
| S2 | Low | Dashboard: after an account switch the previous account's Balancer stayed selected. | Fixed: the selection is kept only if it belongs to the connected account. |
| S3 | Low | Dashboard: "Approve and publish" posted the pool page to FWA even when the approval failed. | Fixed: `send` reports success and publishing stops on failure. |
| S4 | Low | Keeper: `MAX_LOSS_WEI` is checked against the estimate at the current basefee; a receipt can exceed it if basefee rises. | Accepted, documented in OPERATIONS (already estimate-based). |

Requirement clarifications from the audit, now in SPEC: unsolicited ETH and NFTs belong to the creator; the odds floor
applies to the first draw after a checkpoint; FWA may refund a draw in a batch when earlier draws moved the price (VRF
fee not refunded); status 0 is the Balancer's admission, not FWA's; the reserve guarantee holds for the plan and mint
fee in force; the edge credit limits a payment from the Balancer's ETH; ERC-1271 approval wording narrowed.

## Round 4 (keeper reimbursement vs FWA V2, launch rehearsal)

The owner asked for the reimbursement policy to be re-derived against FWA V2's sponsored processing (gas + 55k at
`min(bid, min(basefee, 5) + 1 gwei)`, ≤ 2.1M gas, ≤ 0.02 ETH, no incentive) and adversarial keeper competition.
Evidence: 90-day basefee and inclusion-priority data, real fork receipts, `test/KeeperAdversarial.t.sol` (inflated
bids and gas limits, caller-side refunds, self-dealing single / ten repeated batches / curated drain / forced plan
switch, purchases during repricing, deposits, creator action during a batch), simulation of competing keepers, and
the launch rehearsal (real keeper process, pinned basefee below, near and above the cap, restarts). A reviewer with
clean context reviewed `5161e8f`, and another reviewed the final financial logic at `0a48e84`.

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| V-1 | Low | The once-per-transaction intrinsic credit used a transient flag in each clone's storage, so a transaction calling several Balancers was credited 21k per clone. | Fixed (`0a48e84`): no intrinsic credit; the fixed 0.0005 ETH covers gas outside the measured span. |
| V-2 | Low | The edge credit counted every drawn listing's escrowed fee, including failed deliveries whose fee the purchaser can refund in full, edge included; a buyer-keeper could recover the edge and also be paid incentives funded by it. | Fixed (`0a48e84`): only delivered draws (`A_FULFILLED`) add to `incentiveCredit`. |
| V-3 | Medium (liveness) | Launch rehearsal at 4.9 gwei: the real keeper skipped profitable fill steps and the pool stayed closed. It costs work with `eth_estimateGas`, which exceeded billed gas by 71k–295k (median 78k, 25 transactions); the old `shortfall + 0.0001 ETH` margin did not cover that. | Fixed (`0a48e84`): incentive = the withheld 1/5 + 0.0005 ETH. Rehearsal rerun under the final rule (READINESS). |
| V-4 | Low/Info | Gas-only calls (refund-only reconciliation, `recoverRefundedShape`) paid both fifths of measured gas; that stayed below billed gas only through fixed overhead, which a transaction making several such calls pays once while their refunds add up. Not farmable (refund-only batches need VRF expiry; refunded Shape deliveries need a purchaser the gate refuses). | Fixed (`31edef6`): gas-only calls get the 4/5 part only, so reimbursed gas ≤ billed holds by EIP-3529 on every path; the gas suite's `KeeperPaid` assertion is now the whole payment there. |
| V-5 | Info | A creator action while a batch is unreconciled (e.g. `close`) makes that batch's reconciliation creator work, paid the full incentive instead of from the edge credit. | Accepted: at most one incentive, from the creator's own pool, after the creator acts. `test_creatorActionDuringOutstandingBatchBound`. |
| V-6 | Info | A Shapes mint-fee rise after a batch was admitted makes its restoration cost up to 5 × the increase more than the held reserve; at the exact boundary the restore stops at `INSUFFICIENT_RESERVE`. | Accepted: fail-closed, buyers already received their draws, the held keeper reward is untouched; the creator tops up. |

Policy decisions from this round (`docs/GAS.md`, `docs/simulation-results.md`): priority cap kept at 0.05 gwei
(competing keepers bid the reimbursed priority; 1 gwei raised simulated keeper spend 91% with no faster inclusion);
FWA V2's rule rejected for permissionless upkeep (no rational keeper sends without an incentive: 0% of upkeeps
executed in simulation); no separate ETH payout cap (3.2M gas × 5 gwei already bounds every reward at 0.0165 ETH).

Verified by the final reviewer: permissionless entry points; gas part ≤ billed for any composition and price ≤
`tx.gasprice`; inflated bids, gas limits and caller-side refunds do not change payment; purchase-caused incentives
≤ FWA's edge on delivered draws (all self-dealing variants negative: −0.0011 to −0.069 ETH); `_checkpoint` holds the
worst batch + one maximum reward after paying its own keeper; 23,937 B at review (23,919 B after V-4).

## Round 3 (keeper liveness, purchaser griefing)

Owner review of `bc1d916` asked for keeper liveness from measured profitability and a specific griefing bound. Changes in
`1f352fa`: price-linked incentive, 5 gwei cap, purchaser gate. Both reviewers re-reviewed the change with executed tests.

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| K-1 | Low/Info | The liveness shortfall re-added 21k intrinsic gas per paid call: 7 calls in one transaction earned ~0.00014 ETH per extra call above margin + refunds (executed). Only creator-caused chunked work; purchase-caused calls are credit-capped. | Fixed (`6a2dabe`): intrinsic credited once per transaction (transient flag). `test_profitAtCap_multiCallCreditsIntrinsicOnce`. |
| K-2 | Info | For creator-caused work at high gas the incentive pays margin + refunds, so the 4/5 protection is neutral there (e.g. +0.00126 ETH for a redeem-heavy plan switch at 5 gwei). | Accepted: creator-initiated; bounded by `MAX_KEEPER_REWARD`. |
| K-3 | Info | Keeper allowances in the reserve are large at a 5 gwei cap: ~0.113 of 0.2298 ETH for an empty ten-0.01-Shape pool. | Accepted: idle capital, claimable once closed; documented in GAS.md. |
| K-4 | Info | Pools with draw prices below ~0.012 ETH: credit-capped replacement work loses money for keepers above ~2.9 gwei, so those pools pause earlier. | Accepted: fails closed; creator can run upkeep. |
| G-1 | Low | A purchaser contract that never refunds can lock a curated NFT from a collection that refuses transfers to contracts (or transfers to itself, or needs more than FWA's 150k delivery gas). Expected attacker cost to lock it = (VRF fee + FWA edge on the fee) × totalWeight / its weight; worst case use the creator's odds floor in place of its share; repeatable by fresh contracts once per such NFT. Lower bound assumes the attacker values other drawn NFTs at no more than their creator base. Executed: ~1.06 ETH for a 0.5 ETH NFT in a typical pool, ~0.18 ETH in a thin pool; a processor cannot force a delivery failure by gas-limiting `processAcquisitions` (857 gas levels, 0 failures). | Mitigated, not closed: dashboard simulates a transfer to a contract before listing and requires "List anyway". Closing it would require refusing all contract purchasers (owner decision). `test_griefingBoundForRestrictedCurated`, `test_griefingThinPoolIsCheap`. |

Verified in re-review: self-dealing PnL negative in all four attack variants (−0.00014 to −0.00023 ETH); keeper PnL at the cap
matches GAS.md; `canPurchase` 52–57k gas; exact `requiredReserve()` funding opens a pool.

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
| Reimbursed price ≤ basefee + 0.05 gwei and ≤ 5 gwei | fork tests with a 3 gwei bid at 0.15 gwei basefee (ApeBall pattern), 5,000 gwei bid, 80 gwei basefee | held |
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
- **Restricted collections (G-1).** A hostile purchaser contract can lock curated NFTs from collections that refuse
  transfers to contracts; cheap in thin pools. Do not list such collections.
- **Hostile collections (F1, F2).** A collection whose contract can move, burn or freeze tokens can take a listed NFT
  out of FWA or block its withdrawal. List only collections you trust.
- **FWA VRF capacity (F4).** FWA's VRF service can refuse purchases while the Balancer shows status 0.
- **Shapes admin** can raise the mint fee up to 0.01 ETH; admission closes until re-funded, and small denominations
  become uneconomic.
- **Economics.** The reserve funds the next restoration, not profitability (`docs/simulation-results.md`).
- **Keeper liveness.** Above 5 gwei basefee (~0.9% of blocks measured) keepers wait and new purchases pause; pools
  whose draws all cost ~0.01 ETH pause from ~4.2 gwei. Keepers judging work by `eth_estimateGas` need the estimate
  within ~80–100k gas of billed for the thinnest paid upkeeps at the cap. Unpaid re-checkpoints rely on a keeper's loss allowance or
  the creator. Creators can always run upkeep themselves.
- **Pool page.** Whether FWA's server accepts ERC-1271 from a contract owner is unverified; FWA's message template is
  copied from its client and could change.
- **No professional audit, no formal verification.** Invariant campaigns are short (64 runs × 64 calls).
