# Consolidated candidate audit: partial examination

**Status: INCOMPLETE.** Documentation cleanup and candidate freeze are complete. Two independent agent audit lanes began and executed focused fork checks, but the tool safety system interrupted both during further adversarial examination. A reporting-only follow-up also failed for A; B sealed a partial report. The controller did not route the stopped testing through another agent or tool. No complete whole-candidate negative conclusion, human audit, deployment approval or safety claim follows.

Target: `fd7903476a63e1c8e912b3b6f4dc1441aeccab11`, whose production contracts/configuration match `55c094f`. Exact source, dependency and compiler settings remain unchanged. The working tree contains this audit evidence and documentation only. No production repair was made.

## Examination and separation

| Phase | Evidence | Status |
|---|---|---|
| A, whole-candidate informed audit | Separate detached checkout; independent initial map; own neutral preflight and six focused fork cases | Interrupted before its whole-candidate examination/report finished |
| B, whole-candidate uninformed audit | Separate detached checkout with earlier notes/review tests physically removed; own map, four focused fork cases and 25 asset-flow regimes | Sealed partial after reporting-only stop; no earlier report contents read |
| Controller static review | Slither0.11.5, exact compiler input materialized in separate scratch; 82 results,27 High/Medium dispositions | Code-based triage, not executed rejection of every reported family |
| C, comparison/evidence challenge | Independent reporting-only check of existing assertions/logs; no new adversarial execution | See challenge.md; cannot complete interrupted A/B examination |
| Current-block production-path rehearsal | Earlier implementation receipts remain valid for their stated code and contexts | No new rehearsal performed by this audit |
| Mainnet canary | Proposed unsigned plan in docs/CANARY-PLAN.md | No broadcast or real spending |

Audit workflow and standard are identified in run-record.md. Caps were90minutes per A/B and30minutes comparison; these were caps, not time spent. A/B began around21:49–21:50UTC on2026-11-17; B sealed21:56:05UTC. Exact per-phase elapsed time was not instrumented. File completion timestamps are preserved and must not be presented as execution durations. Method uncalibrated; agent-reviewed; human review absent. The shared host does not enforce blindness. B saw incidental deleted-path filenames, not prior report contents.

## Security findings

**No contract security violation was confirmed by the completed focused cases.** This statement applies only to their asserted paths. Full callback permutations, every owner requirement, independent runtime/source correspondence of every integration, off-chain runtime behavior and all material policy transitions were not independently examined to completion. Earlier builder/focused-review evidence is separately reusable, not new audit coverage.

A's six cases assert: an all16-denomination board and exact aggregate backing round trip; exact twenty-Shape opening/minimum-payment atomic rollback; closed pending-draw refund rights; a frozen curated NFT's delayed-refund credit and successful recovery/withdrawal calls (no post-withdrawal buyer balance delta asserted); failed-policy emergency disable/unpaid recovery; and one zero-fee manufactured-work diagnostic. B's four cases assert: all16 exact-minimum/idle/exit behavior; unavailable policy/refund/close/disable/unpaid roundtrip; caller floor and policy/creator authority transitions; and one extreme-low-fee conditional subsidy diagnostic. Initial harness compilation failed because each adversarial policy omitted the required version() function. Both failures and corrected passing outputs are retained. These are test-harness repairs, not production fixes.

Slither emitted two High alerts (arbitrary ETH sends and reentrancy),25 Medium,39 Low and16 Informational results. High/Medium dispositions are in static-triage.json. Fixed trusted Shapes/Packs destinations, the nonReentrant write boundary, static policy calls and intentional integer batch arithmetic explain the directly inspected alerts. Read-only external callback families are explicitly not closed by that code review. Slither's255 process exit denotes emitted findings; the final JSON reports success=true. Earlier parser failures are preserved. The105 analyzer contract count is not behavioral coverage. Lower-priority alerts were not all independently triaged.

## Economic findings

### E1: encumbered capital is labelled "above need" (confirmed, Low reporting defect)

`test/utils/FlowBreakdown.sol:118–123` substitutes an entire bucket's holdings when its stated need is unknown, then serializes that amount as above_need. In B's quiet scorecard, **1.7ETH** of listed backing and **0.196824640644681196ETH** of FWA pending/refund/edge balances are labelled above need despite their encumbrances. Conservation reconciles; these amounts are not freely withdrawable surplus.

Impact is misleading interpretation of asset-flow evidence, not a demonstrated custody or withdrawal defect. The smallest correction is to encode unknown excess as unknown, or provide the real encumbered need, and keep aggregate holdings separate from disposable capital. This audit leaves the frozen evidence unchanged and records the defect. Future reports and acceptance decisions must not treat those rows as capital available to the creator. A test/helper repair and affected scorecard regeneration remain work for the next candidate.

### E2: conditional creator subsidy, not an established requirement violation

B reached five actual expired/refunded FWA draws under a creator-selected maximum-reward policy at **basefee1wei/bid2wei**. Pool operating cash paid the keeper **0.000250000001534636ETH**; the buyer paid **0.0000000000234ETH** of nonrefundable VRF fees. B reports **0.000249999976951750ETH** after subtracting VRF cost and isolated-call gas from three maintenance calls. This is a **partial maintenance-cost diagnostic**, not all-in buyer/keeper profit: buyer acquisition/refund gas and prior setup/policy/closeout gas are omitted. Including creator in the coalition cancels its internal keeper transfer; external costs remain losses. The attacker cannot itself suppress coordinator availability. This is an extreme diagnostic, not evidence of that gas context or profitability on mainnet. B did not complete practical-fee/default-V1 extensions.

B's gas is Foundry1.8.1 lastCallGas isolated-call billing through the shipped ReceiptGas helper, **not a new signed-node transaction receipt**; buyer/creator transaction gas is not a complete receipt ledger in this lane. The previous independently executed signed-node low-gas cycles remain in ../reserve-redesign/verification.json and its economic report. Different gas contexts must not be merged. A's zero-basefee/zero-bid result likewise establishes a zero-fee service-envelope edge only; it is excluded from realistic keeper/coalition profitability claims. These limitations prevent overstating either diagnostic.

The disclosed unpaid game-first spending of booked creator profit remains an operating rule. An independent auditor questioned how it reads against profit-preservation wording; no new actual confiscation of third-party assets was demonstrated. Existing owner context and source explicitly preserve this behavior; any change would be a new economic decision.

## One-screen scorecard

| Context | Exact observed result | Limit |
|---|---|---|
| Twenty0.01ETH Shapes, basefee0.5gwei/mint fee0.001ETH |0.2356ETH opening;0.00368ETH stocked target | Builder final evidence reused; independent A/B reached the opening amount |
| B all16 denominations, basefee/bid5gwei |196.66ETH backing;0.027ETH mint fees;196.79962ETH minimum;0.06589664ETH setup pay;0.04672336ETH remaining cash | One each denomination, not an arbitrary mixed-board guarantee |
| Same B board,30days idle and exit | Balancer cash unchanged across30days idle with no intervening operation; exact aggregate196.66ETH backing redeemed; final creator cash/listings/proceeds0 | Curated NFT returned separately; irreversible fees remain costs |
| B unavailable-policy refund/closeout |0.072498283786359740ETH purchaser principal refunded;0.007ETH closed paid hold,0 after disable | Real FWA route; paid failure rolled back, unpaid path reached |
| B conditional subsidy |0.000250000001534636ETH creator-funded keeper transfer |1wei/2wei diagnostic; not a practical mainnet forecast |
|25 flow regimes | Configured O1–O16 numeric bounds satisfied; wei ledgers reconcile | Shipped harness, signature absent, E1 bucket labels misleading |
| Candidate regression evidence |483 Foundry tests;120 TypeScript tests;28 canonical keeper transactions | Reused unchanged evidence, not another independent audit |
| Limits | Runtime24449bytes; measured deployment maximum submitted limit7023660gas | Existing production-path evidence;127bytes runtime headroom |

Quiet regime destination shares from the actual scorecard: creator claims45.1%, delivered backing28.1%, listed backing18.1%, Shapes fees2.8%, randomness2.5%, FWA pending/refund/edge2.1%, keepers1.2%. These rounded percentages are conservation destinations, not all creator income or all disposable cash. B's derived map/ratchets and full25scorecards are preserved in b/REPORT.md and b/scorecards/.

## Comparison and unresolved paths

| Topic | A | B | Disposition |
|---|---|---|---|
| All16 backing and exit | Executed at0.5gwei | Executed exact minimum at5gwei plus idle | Both support their exact aggregate cases |
| Purchaser refunds across closing/policy failure | Executed | Executed | Focused rights evidence; not all delay/callback permutations |
| Hostile curated NFT frozen delivery/recovery | Executed specific real path | Not executed | A source/log retained; independent full-family reattack absent |
| Caller floor/authority | Minimum rollback executed | Additional ownership/proposal transitions executed | Different finite sequences, not exhaustive authority coverage |
| Conditional service subsidy | Zero-fee edge |1wei/2wei edge | Practical-fee signed-receipt evidence comes from prior work, not these new diagnostics |
| Encumbered bucket labels | Not reported before interruption | E1 identified from real scorecard | Controller confirms exact code and values; no frozen-source repair |
| External runtime/source correspondence | Not completed | Not completed | Critical integration gap for this new whole-candidate audit |
| Keeper/dashboard/planner runtime and full deployment flow | Code reading/earlier evidence only | Not completed | Prior verification reused within scope; independent examination incomplete |

No new adversarial executions were commissioned to replace the safety-stopped work. The comparison therefore identifies gaps rather than claiming to execute every audit disagreement. Current public read-only block26437580 is recorded in current-chain.json; the new independent focused tests use pinned26382349. Earlier recent-state tests remain separately scoped evidence.

## Handoff and remaining actions

1. Correct E1's evidence-label semantics and regenerate affected scorecards in a new verified candidate; preserve this frozen attempt and its raw numbers.
2. Arrange an execution-capable independent audit of the final candidate, including the unresolved integration and off-chain scopes. This document is an intake packet: exact target, requirements, test evidence, findings, limitations and proposed canary plan are available. No external reviewer was hired, no procurement commitment was made and no funds spent.
3. Reconcile the resulting audit against prior evidence, resolve confirmed material issues and rerun affected checks. Do not repeat unrelated valid suites simply because a review occurred.
4. Obtain the owner's actual outcome signature and separate launch authorization. Execute the current-block local production-path rehearsal and separately approve any mainnet canary only within its explicit signer/endpoint/value boundaries.

## Things that don't make sense

Unknown encumbrance is being labelled excess in the flow report. That is a genuine reporting inconsistency. Temporary inventory depletion and delayed expensive-prize replacement are intentional requirements, not inconsistencies. The interrupted testing and absent human review cannot support a whole-candidate safety or launch conclusion.
