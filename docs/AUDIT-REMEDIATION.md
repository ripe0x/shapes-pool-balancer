# Audit remediation with concurrent purchases

**Retain concurrent purchases and the low-capital reserve. Do not describe E1 as fixed.** Work starts from `2ab49fd` on `codex/audit-remediation`; the audited `9b45f91` and its local batch remain historical evidence. The executable candidate completed the checks below with source hash `ca02fb070a2a839cccc9fced15b3116613f6d7727d4e50133693dd63a4c92eda`. No public-network deployment, real funds or new node broadcast is authorized.

## Owner direction and implementation

R55–R58 reject serialization and a keeper-maintenance barrier between every batch. The owner prioritizes concurrent operation and minimum defensible capital over exact purchase-time profit attribution. The existing `_collect` approximation and reserve formula remain unchanged. General acceptance of bounded approximation is **not numerical acceptance of a new drift ceiling**: the historical 0.001 ETH O9 bound has real counterexamples and is not a universal guarantee.

- **E2:** keeper coverage uses the request-board surcharge component of actual FWA owner proceeds. Selected-listing fees remain a separate inventory statistic. Unsold and pending fee expectations are not liquid ETH.
- **E7:** every checked collection includes zero bookings, and over/underbooking are reported separately and added as absolute error. Opposite errors cannot cancel. Positive entitlement is reached explicitly. The unchanged historical 0.001 ETH threshold is not silently raised; its configuration coverage remains limited.
- **S4:** active estimates use bounded Balancer-context views with explicit block/gas-price context. Candidate costs stay unverified until activation; candidate funding uses the actual pool view. These remain estimates: arbitrary policy state/context and pending transactions require simulation and atomic minimum-payment protection.
- **S2:** admission bounds the first new selection using actual FWA active count, actual unreconciled/unsettled counts and all already-reserved records plus the next guaranteed six-record activation prefix. It retains the old concurrency allowance and requires neither a metadata-sync transaction nor a single-batch barrier. One conservative `shapeStageUpper` count distinguishes possible Shape staging from unrelated curated staging; there is no per-listing flag, queue, activation/sync wrapper or new spending budget.
- **Batch refunds:** sequential fresh single draws are an advisory option for small boards, not a protocol restriction or a requirement for keeper intervention after every batch. Keep FWA's positive-slippage protection. The count-less purchase hook cannot impose a single-draw limit. See [PURCHASE-BATCHING.md](PURCHASE-BATCHING.md).

For tracked count `T`, actual active count `A`, issued-minus-reconciled `q`, unsettled `u`, actual reserved-staging count `K`, conservative Shape/Pack staging-count upper bound `S`, and maximum Shape inverse-backing weight `H`, the current candidate subtracts:

```
C = max(T - A, 0)
unavailable = min(max(q, max(C - (K + 6), 0) + u), q + S)
lowerBound = trackedShapeWeight - unavailable * H
```

The prospective bound must be at least 70% of target weight; existing setup, tracked-curated presence, busy and accepted-mint-fee checks remain. Pool creation verifies the real factory activation budget is six. FWA processes all prior reserved batches before the first new selection and activates that request's reserved/idle prefix. Only those guaranteed activations receive credit. If fewer than six unreserved records remain, all staging clears and the old `q` allowance covers the earlier draw removals; otherwise the nonselectable remainder plus `u` bounds them. Reserved records cannot be withdrawn through FWA while committed, so this credit does not invent untracked inventory. The separate `q + S` bound conservatively charges every possible staged Shape/Pack prize plus every old unreconciled draw. Both loss estimates are upper bounds, so their minimum remains conservative while avoiding treating curated staging as missing Shapes. When `S` is zero, the original `q` gate is used directly. `S` increases only by newly listed Shape/Pack prize count (not contained Shape units), is capped at the then-listed Shape-prize count on each restock, and can clear only on proof that all tracked records are actually active. The same proof is checked before a curated listing adds unrelated staging. It is not a lifetime spending counter and can decrease; no queue synchronization or all-active prerequisite is imposed on purchases. It can still overestimate staging, so this is not a promise of identical admission under every adversarial configuration. This does not insure all later selections in a five-draw batch or promise an immediately full board. Existing unreconciled-curated-win lag remains; the dashboard reads actual selectable/staged records rather than claiming that a tracked count proves a selectable curated NFT.

## Economic scorecard

These are real-fork flows on the reviewed FWA/Shapes and locally deployed Packs at block 26,382,349, with state-changing fee witnesses. AllocationConcurrency reports principal transfers without separately subtracting actor gas. The quiet scenario includes keeper payments and a fixed 0.2 ETH deduction per won curated NFT, but not actual NFT acquisition/opportunity cost or creator transaction gas. Positive creator claims and fixed-demand net positions are not profit forecasts. No later creator ETH top-ups are hidden in the minimum-opening scenarios.

| Reached case | Measured result | Meaning |
|---|---:|---|
| 20 small Shapes, 0.5 gwei basefee, 0.001 ETH mint fee | 0.2356 ETH exact opening; 0.2 ETH backing; 0.00368 ETH stocked withdrawal reserve | Boundary tested with one wei removed; paid setup and actual custody checked. This is the specified board/context, not every policy's universal minimum. |
| Final 47-prize launch board, 180 quiet draws at 0.5 gwei basefee / 0.55 gwei bid; zero-demand comparison | Quiet creator net position +0.932223826143624805 ETH; actual surcharge 0.140988784474627858 ETH. Zero-demand cost 0.07170554325 ETH | Actual fee coverage replaces selected-fee accounting; listed 1.7 ETH backing remains separate. Fixed demand and NFT valuation assumptions do not predict market income. |
| Default V1, 100% markup, valid 18-block 4.95→0.5 gwei fee decline | 0.108721948639984132 ETH owner proceeds; 0.002240053614343757 ETH overbooking | Four old-price deliveries, one real expiry. Current-board creator credit exceeds purchase-board attribution; the 0.001 ETH bound is missed. |
| Mutable selected policy, 25% markup, surcharge 0.102→0.0002 ETH | 0.589962967692504150 ETH owner proceeds; 0.002729320077460120 ETH overbooking | Five actual deliveries; same settings hash and permitted concurrency. |
| Same transition at 100% markup | 0.010600968921276351 ETH overbooking | A measured adverse example, not a proven maximum. |
| Mutable surcharge 0.0002→0.102 ETH, 100% markup | 0.001744348693206539 ETH underbooking | Positive maker credit remains; zeroing ambiguous profit would itself change the agreed economics. |
| Maximum policy with two concurrent expired draws, after maximum creator claims | Actual reward bounded by 0.0028 ETH; both acquisition refunds remain at FWA | Hostile quote cannot consume purchaser escrow or listed backing. |
| Closed two-draw pool after a valid 31-block fee rise | Later paid call reverts atomically; unpaid processing and both refund withdrawals succeed | Paid continuity can require funding or a volunteer; this is not purchaser-principal insolvency. Two VRF charges total 0.002574 ETH and remain spent. |
| Initial focused E2 run: funded Pack replacement, 25% markup, 4.95 gwei basefee / 5 gwei bid | Actual surcharge 0.004832471072087216 ETH versus keeper 0.00700996 ETH | The selected fee of 0.0141 ETH falsely implies coverage. True one-draw shortfall: 0.002177488927912784 ETH. This reproducer explicitly supplies replacement capital. |

In each concurrent allocation round trip, maximum allowed creator claims can leave temporary target deficits. Tests then process/reconcile, recover inventory and close out, checking actual ETH/backing beside counters and preserving FWA purchaser/protocol obligations. `_collect` can reclassify creator-owned operating capital as the same creator's booked profit; reserve checks limit remaining fund withdrawals, while paid work protects booked profit. This can affect refill speed and income allocation. It does not establish access to purchaser escrow. Exact attribution was not demonstrated necessary for purchaser safety in these reached paths, and no larger reserve or new fee is introduced.

## Source bound and allocation alternatives

For a Shape/Pack listing made with markup `m` basis points, its creator fraction is bounded by:

```
creatorFraction <= (m - 1,000) / (10,000 + m)
```

This ignores positive mint fees and surcharges, which can only lower the fraction. Curated listings contribute zero. A listing at 25% markup therefore contributes at most 12%; a listing at the allowed 100% maximum contributes at most 45%. The 12% bound applies only when all relevant historical/current listings have markup no higher than 25%, not merely when the creator's current setting is 25%.

Both the current-board booked credit and the hypothetical purchase-board credit lie between zero and 45% of the same actual owner proceeds. Their absolute difference is therefore at most **45% of actual owner proceeds**, and summing absolute errors across collections preserves that loose envelope. This is a source-derived bound on creator-owned allocation, **not a new approved O9 tolerance, a proof that drift is small, a universal income promise or permission to deploy**. In the named counterexamples the measured errors are much smaller in absolute terms but still exceed the historical 0.001 ETH value. Purchaser escrow, refund credit and prize backing remain in separate custody regardless of which creator-owned bucket receives a credit.

| Approach | Economic/continuity effect | Decision |
|---|---|---|
| Retain current approximation and quantify its error | Preserves the owner's concurrent operation and current capital/claim model; can delay replenishment or undercredit maker income | Selected under R55–R58; numerical release outcome still requires reconciliation |
| Minimum of current and previous observed fractions | Does not bound a request priced on an older, lower-fraction board during arbitrary overlap | Insufficient as an exact accounting fix |
| Zero ambiguous creator credit, or keep a lifetime minimum until ambiguity clears | Withholds agreed maker allocation and may retain it through a persistent failed-delivery/overlap window | Not adopted without demonstrating a purchaser-safety need and agreeing the changed economics |
| Serialize cohorts to obtain a clean accounting boundary | Restricts concurrency and makes purchases depend on maintenance | Explicitly rejected by the owner |

Retaining the approximation follows the owner's economic priority; it does not waive purchaser safety. The actual tested custody, refund and claim/recovery round trips are the evidence for that separate boundary. The loose 45% source envelope must not be substituted for an owner-approved practical drift limit.

## Verification and rejected candidates

The final executable source hash is `ca02fb070a2a839cccc9fced15b3116613f6d7727d4e50133693dd63a4c92eda`. **The complete final Foundry run passed 501/501 tests across 67 suites, exit 0**, with 288.42 seconds test time and 192.69 seconds compilation. It includes invariants, actual concurrent allocation/recovery paths and all 25 economic regimes. Those 25 records were stamped inside that same run; the gate reused them with `--no-run --require-review`, avoiding a duplicate campaign.

**All named numerical outcomes passed**, including 0.000145285333333628 ETH absolute allocation error over 180 draws in the fixed `restock_in_flight` regime and zero corrected O11 play shortfall in its named regimes. The larger concurrent counterexamples remain valid, so this does not restore a universal 0.001 ETH promise. The gate returned **exit 2, INCOMPLETE**, solely for the absent/mismatched owner approval hash and missing fresh whole-candidate audit seal. The [bounded final review](../audit/remediation-focused/REPORT.md) reported no actionable findings in its stated scope; it is not that audit seal or release approval.

Final TypeScript verification passed 125 tests in 12 files, exit 0, including actual-RPC legacy compatibility. Typecheck and app build passed against the final exported ABI; the 53-scenario/40-capital-row simulation remains model evidence, distinct from the actual fork regimes. Final runtimes in bytes: PoolBalancer 23,641; PoolInventory 11,023; KeeperPolicyCalls 5,577; PoolPage 1,194; BalancerFactory 3,570; KeeperPolicyV1 1,143.

Three focused final gas checks passed. At the stated isolated-call 0.5 gwei basefee / 1 gwei bid, `canPurchase` billed 43,343 gas (measured span 60,136), actual FWA five-draw purchase billed 1,664,414 gas, and one-Shape upkeep billed 824,631 gas versus 840,350 measured gas. These are not signed-node profitability receipts. Exact commands, exit statuses, source hashes, retained failures and logs are in [verification.json](../audit/remediation-focused/verification.json).

Preserve the rejected evidence: the cached-staging candidate's full run reported **497 passed / 3 failed**. A queue-free current-board-only bound also failed three sustained scenarios. The failures exposed real ordinary-operation pauses, not incorrect tests to delete. The later six-only activation formula completed with **311 passed / 188 failed / 499 total**, exit 1 across 67 suites (323.44 seconds test time plus 185.35 seconds compilation). All 188 failures used the same `PurchaseNotAllowed` selector through inherited setup paths; they are preserved as failures, not 188 independently classified defects. The no-scalar reserved-prefix run reported 490 passes / 10 failures / 500 tests (305.71 seconds test time plus 185.57 seconds compilation). Its shared setup was corrected in the production bound, not hidden by altering the harness. The final gate combines the reserved-prefix and Shape-only upper bounds without a bookkeeping queue. Do not reuse any failed candidate's numerical gate result as final acceptance. The historical aggregate-gas-budget, empty-filter, dependency metadata and receipt-timeout failures also remain recorded.

The source review that found no new extraction issue in the early library moves does not cover later admission changes automatically; the final arithmetic received a separate bounded source review. Human audit, real wallet/browser interactions, owner numerical outcome approval, a fresh whole-candidate audit seal and deployment authorization remain separate. No interactive browser provider is connected, so typechecking and pure/real-RPC tests do not establish changed dashboard acceptance. The completed 50-round local batch used old production bytecode and is not a rehearsal of this repair.

## Recommendations

1. Keep the current reserve and concurrent admission. The reached adversarial round trips preserve purchaser assets without the removed lifetime keeper reserve.
2. Prefer the immutable V1 initially; higher or mutable policy quotes remain creator-funded exposure. Do not raise surcharges or hold hypothetical future draws merely to hide measured allocation drift.
3. Propose a numerical O9 allocation policy for owner review from the full measured range. Keep the old 0.001 ETH counterexamples visible until that decision; do not call a fixed-seed pass universal acceptance.
4. Offer a fresh single-draw option and disclose nonrefundable VRF costs for bulk requests. Do not weaken positive-slippage protection or automatically rebuy refunds.
5. Complete the remaining whole-candidate audit-seal, owner numerical outcome and real-wallet/rehearsal requirements before any release decision. No canary or mainnet transaction is authorized here.

## Things that don't make sense

A creator-owned fund/profit reclassification is not purchaser insolvency, and a fixed-seed drift result is not a universal ceiling. Correctly refunded principal does not make its spent randomness fee harmless. No gate should impose the rejected maintenance barrier simply to make an accounting test pass.
