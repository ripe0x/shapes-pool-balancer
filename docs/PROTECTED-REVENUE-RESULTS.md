# Protected collected revenue and atomic creation

Implementation candidate, 2026-11-18. Branch `codex/creator-credit-atomic`, based on current main
`2f83f9a412a2f0b9de00a72af3bec5e86f57fb73`. A remote main read confirmed that revision at task start;
there were no newer mainline fixes to reconcile. The original audit checkout and its unrelated work were preserved.
The implementation commit containing this report is the reviewable candidate. Tests ran against its working source;
[manifest.json](verification/protected-revenue/manifest.json) records the exact production source SHA-256 values.
No mainnet deployment, real expenditure, production configuration change or merge occurred.

## Implemented behavior

- Actual FWA owner proceeds received add `floor(amount * creatorRevenueBps / 10000)` protected credit, including after
  closing. Rates 0 and 10,000 are supported. Capital movements add no credit. Paid and unpaid mint/list/payment paths
  retain credit. Existing-credit claims make no external reads and leave operating cash unchanged.
- Total withdrawable is `C + max((B-C)-R,0)`. A 0.20 ETH balance, 0.02 credit and 0.10 reserve permits **0.10 ETH**,
  with no double counting, reached through a real FWA collection/replacement path. `claimSurplus` remains the one withdrawal API; collection is a separate transaction.
- A creator rate change first collects available proceeds at the old rate, then stores the new one. Pending purchases
  collected later use the new rate. Ordinary turnover, markup, target, gas and policy changes never recompute it.
- The planner calibrates the initial suggestion from expected Shape markup above 10%, actual FWA inverse-price weights,
  packs/mint costs and owner proceeds excluding edge/VRF charges. Curated allocation is zero in that calibration.
  Creator allocation, retained revenue, replacement/mint/keeper costs and margin are separate. Unknown costs stay unknown.
- Replaceable policies retain the full `Work`/restock quote interface, bounded static calls, cached/immutable maxima,
  two-day delay, cancellation, emergency disable, generation invalidation and persistent allowance. The sole paid API
  is `performUpkeep(hash, minimumFixed, minimumGas)`; its floor is fixed plus gas component times actual transaction price.
- Activation compares shared maintenance budgets from one current work/basefee/enabled snapshot. Nonincreases need no
  new cash; increases need the entire candidate maintenance budget in operating cash. Full opening/withdrawal reserve
  still includes missing backing, mint expense and bounded listing work. Inventory deficits remain visible.
- Creation is typed and atomic after NFT approvals. The authenticated factory caller supplies creator identity and NFT
  source; initialization establishes state and holds the reentrancy lock before NFT interactions. No target Shapes are
  minted in creation. Existing bounds, concurrent purchases, staged admission, purchaser refunds and recovery remain.
- Current controls and historical scans load independently. A discovery outage has manual-address recovery; failed
  history or policy quotes leave credit claims, disable, proposal, unpaid maintenance and closing usable.

## Removed production code and state

Deleted `Settings.sol`, policy metadata decoding/getters, factory/V1 settings getters, historical listing allocation
markup, `profitShareSum`, `_share`, `listedFees`/`listedRestockFees`, old paid overloads, duplicate maximum getter,
unpaid credit clipping, close-time credit reset and partial-creation draft migration. `profit` was replaced by
`creatorCredit` plus the stored rate. Historical attribution comparisons and O9 drift acceptance were superseded;
nonobsolete concurrent refund/capital recovery coverage moved to `ConcurrentRecovery.t.sol`. The release evidence
path list binds both that preserved recovery suite and the new native credit/creation suite.
The active listing array, actual prices/base values, custody state and factory remain. Historical audit reports and
approvals were preserved as history.

Routine decisions: use uint256 credit; retain `settingsHash()` solely as the existing journal's policy-generation
identity (no settings interpretation); store the reviewed initial mint-fee cap exactly and reject a live fee above it;
use creator withdrawal followed by a normal deposit for voluntary reinvestment. No new migration, indexing or multicall
framework was added. `OWNER-REQUIREMENTS.md` R59–R66 supersede conflicting historical economics without forging a new
release signature.

## Production source and runtime size

Solidity 0.8.28, Cancun, optimizer 50, via IR, unchanged compiler/profile and EIP-170 checks. Baseline artifacts were
reused only after every source/dependency keccak hash in their metadata matched the reviewed revision and declared
submodules. Current `CANDIDATE_RUN=1 forge build --sizes` exited 0. Tests and docs are excluded from these counts.

| Production measure | Before | After | Change |
|---|---:|---:|---:|
| Solidity source files | 10 | 9 | −1 |
| Solidity source lines | 1,864 | 1,822 | −42 |
| Solidity source bytes | 94,484 | 91,140 | −3,344 |
| PoolBalancer runtime bytes | 23,641 | 20,516 | −3,125 |
| BalancerFactory runtime bytes | 3,570 | 3,501 | −69 |
| PoolInventory runtime bytes | 11,023 | 10,707 | −316 |
| KeeperPolicyCalls runtime bytes | 5,577 | 4,833 | −744 |
| KeeperPolicyV1 runtime bytes | 1,143 | 829 | −314 |

Additional production source (lines include comments; tests, diagnostics and docs excluded):

| Source category | Lines before → after | Bytes before → after |
|---|---:|---:|
| Creator app | 2,806 → 2,863 | 207,445 → 213,293 |
| Shared planner | 521 → 518 | 26,659 → 27,318 |
| Production keeper | 631 → 626 | 38,465 → 37,767 |
| Production deployment | 114 → 114 | 7,316 → 7,316 |
| Generated ABI | 8 → 8 | 47,495 → 46,416 |

App scope is `app/src` TS/TSX/CSS excluding tests; shared scope is planner/design; keeper scope is its production
service; deployment scope is the one production script/wrapper. Generated ABI is shown separately from handwritten code.
Handwritten production totals: **5,936 → 5,943 lines**, **374,369 → 376,834 bytes**. Contract runtime and accounting
state simplify substantially; the complete source tree is not represented as a net line-count reduction.
The app adds current/history failure isolation and manual-address recovery while removing partial setup; those required
controls explain its source growth. No dependency was added.

PoolBalancer has **4,060 bytes** of EIP-170 headroom. Each listed component is individually under 24,576 bytes.
These are deployed runtime sizes, not source size, initcode or aggregate deployment gas.

## Creation transaction flow and browser evidence

| Before | After |
|---|---|
| Create/deposit, configure, approve NFTs, list initial batches, open | Approve predicted Balancer, then one typed create/configure/deposit/list/open-to-stocking transaction |
| Creation could precede an unsaved design or partial initial listing | Any configuration, funding, transfer or listing failure reverts the entire creation |
| Initial target filled by later bounded maintenance | Same bounded stocking; purchases wait for completion |

A browser used the development connector on owned isolated Anvil `127.0.0.1:18766`, chain 31337, Tenderly fork
26,382,349. It reviewed a 25% markup, **12.34% creator share**, 19-prize target, 0.001 ETH mint-fee cap and one actual
creator-owned demo NFT priced 0.25 ETH. It sent exactly an NFT approval followed by **one creation transaction**, value
**0.536116 synthetic ETH**, gas **2,362,733**. The receipt/configuration verified rate **1234 bps**, authenticated creator,
NFT custody at the new FWA pool, zero Shape mint events/listed Shapes and initial admission status 2. One browser unpaid
stocking call then listed **five Shape units**, spent **0.055 ETH** (0.05 backing + 0.005 actual mint fees), paid no keeper,
retained rate 1234 and stayed in stocking with 14 target prizes missing. No extra configure/list/open transaction ran.
[Decoded receipts and readbacks](verification/protected-revenue/ui-atomic-creation.json).

A second browser regression injected only RPC errors for historical logs and representative policy quote reads.
All successful reads were forwarded unchanged to that real local node. Manual address entry opened current controls;
claim/disable/proposal/unpaid/closing controls remained usable. The browser claimed **0.003092531885935719 ETH** of
existing credit. Its real receipt succeeded using **50,067 gas**; credit became zero and operating cash remained exactly
**2.590270664947933817 ETH**. [Claim evidence](verification/protected-revenue/ui-credit-claim.json).
The 100% preview showed zero retained revenue and an explicit operating-funding warning.
[Claim screenshot](verification/protected-revenue/ui-claim-recovery.jpg),
[stocking screenshot](verification/protected-revenue/ui-atomic-stocking.jpg).
These are synthetic local transactions, not extension-wallet signatures or live publication.

## Large deficits, replacement policies and activation

Real FWA acquisitions delivered the expensive Shape to the buyer, with exact backing checked. Each board kept its
original target, continued a permitted small-prize sale, collected actual proceeds and claimed all accrued credit.
There was **no post-win deposit or target reduction**. Gas context was witnessed inside execution: basefee 0.5 gwei,
transaction price 0.55 gwei, fork 26,382,349. The chosen test rate was 1,000 bps.

| Actual missing prize | Creator credit claimed | Operating ETH after claim | Expensive replacement |
|---|---:|---:|---|
| 1 ETH Shape | 0.002826771927742353 | 0.028998836549681180 | Still missing |
| 100 ETH Shape | 0.002827589190799155 | 0.029004213017192403 | Still missing |

`KeeperPolicyV2` has no settings method, pays per listed prize rather than V1's underlying Shape units and has a distinct
pack/denomination surcharge formula. The production keeper serviced mixed V1/V2 pools, adopted V2 after the delay,
rejected a stale pending V1 transaction and recovered a policy-changing replacement whose response was lost.
Creator-client integration made 16 bounded pool surcharge reads and representative bounded reward reads at one block,
with **zero settings selectors**, against both V1 and V2. This tests a different work basis, not a metadata fallback.

With 100 ETH inventory missing, V2's maintenance requirement at 0.5 gwei was **0.00368 ETH**, shortfall zero; activation
preserved credit/allowance and left full restoration over 100 ETH. Reenabling from disabled at basefee 5 gwei required
**0.02753 ETH** operating cash; it failed below that, succeeded at the full budget and still left inventory depleted.
An independent case had operating cash 0.01645 ETH exceeding the 0.01108 ETH old/candidate difference yet correctly
rejected the increase because it lacked the full 0.02753 ETH. Requests and basefee introduced after proposal were
rechecked, and same-address disable/reenable invalidated both old hashes without resetting allowance or its timestamp.

The literal cash example also passed onchain through real paths: explicit 1 ETH initial diagnostic funding,
20 small Shapes, a creator-selected immutable pricing policy, a real **0.02 ETH** FWA collection at 100% credit, and
**0.011 ETH** unpaid replacement expense reached **B=0.20, C=0.02, O=0.18**. A witnessed 20 gwei basefee/20.05 gwei
bid made the stocked maintenance reserve **0.10 ETH** under the selected 0.10 ETH maximum. Total withdrawal was
exactly **0.10 ETH**, ending B=0.10 and C=0, without fake balances or storage. This diagnostic uses its explicit
custom pricing policy; it is separate from the no-top-up large-deficit demonstrations.
[Exact cash test](verification/protected-revenue/exact-cash-example.log).

## One-screen economic scorecard

Actual fork cash, not the selected listing's surcharge. Reference gas 0.5/0.55 gwei; stress/limits and all exact contexts
are retained in the [25 raw regime scorecards](verification/protected-revenue/asset-flow-scorecards.json).
Rows below use 400 bps stored credit; aggregate percentage display can round to 399 bps because each collection rounds
down. Every collection's exact credit error is **zero**. Claims include returned creator capital as well as earnings.
The reference scenarios start with 5 ETH; actual deposits, capital returns, backing and other regimes' inputs remain in
those scorecards. Regimes script demand and curated contributions; these are not market forecasts.

| Regime | Actual owner proceeds ETH | Credit accrued ETH | Actual keeper pay ETH | Days ending with a prize missing |
|---|---:|---:|---:|---:|
| quiet | 3.936200 | 0.157448 | 0.116073 | 9 |
| limits_at_max | 3.946311 | 0.157852 | 0.090849 | 6 |
| max_then_idle | 3.946311 | 0.157852 | 0.090849 | 6 |
| zero_demand | 0.000000 | 0.000000 | 0.016601 | 0 |
| large_win | 3.903457 | 0.156138 | 0.118194 | 20 |
| gas_spike | 3.388819 | 0.135553 | 0.283871 | 8 |
| randomness_not_delivered | 2.619047 | 0.104762 | 0.083639 | 7 |
| closeout_pending | 2.017913 | 0.080717 | 0.053390 | 2 |
| restock_in_flight | 3.935996 | 0.157440 | 0.113486 | 9 |

All 25 cash breakdowns have zero reported holding/flow mismatches and exact credit error zero; 26 flow tests passed
across the initial and affected repaired runs. Zero demand earns no credit and still costs setup. Missing days are
reported, not cured with hidden capital. The minimum-large-win case has zero operating top-ups and 22 depleted days.
Closed closeout resolves balances/backing/proceeds to zero, except purchaser-controlled FWA failed-delivery rights.
Raw scorecard `source_hash` fields are empty because `SOURCE_HASH` was unset; the accompanying manifest binds the
working production source rather than falsely attributing execution to unchanged main.

A separate **97-receipt** local run covered expiry/refund, Shape win/redeem, curated win/return, unlist/restock and failed
NFT delivery/refund/recovery, then closed/unlisted/claimed/retired each pool. Each received 1 synthetic ETH creator
capital and no additional capital; ending Balancer balances were zero. At basefee 0.0005 gwei/bid 0.001 gwei, actual
expiry reward was **0.000050253116 ETH**: buyer+keeper gained **0.000047094427 ETH**, funded by creator operating cash,
while the combined creator/buyer/keeper cycle lost **0.000003158689 ETH** including gas/VRF. This is a bounded existing
work-incentive subsidy, not a security-accounting loss or universal loss-free keeper claim. Across the complete run,
actor gas was **0.000085179558 ETH** and coalition loss **0.103402950772953270 ETH**, reconciling gas, mint, VRF and FWA
fees exactly. [Full receipts](verification/protected-revenue/receipt-economics.log),
[cycle summaries](verification/protected-revenue/receipt-economics-summary.json).

Monotonic values are sequence reconciliation cursors, policy generations and page epochs: they prevent replay and
only advance after corresponding accepted work/authority changes. They are not accumulating money entitlements.
Credit decreases on claims; the allowance refills only to its fixed burst and is never reset by a policy change.
Each monetary bucket is independently measured; balanced accounting is not represented as a guarantee that a creator
will like a regime's economics.

## Verification record

Foundry **1.8.1**, Node **22.19.0** and the exact declared npm packages/submodule commits were used. All listed final
checks exited 0 unless explicitly stated. Full checks used `CANDIDATE_RUN=1`; repairs repeated only affected checks.
No mocks, fabricated protocol balances/state or replacement protocol contracts were introduced. Creator-selectable
hostile collections/policies and attacker actors exercise actual paths. Existing controlled coordinator delivery is
an explicit oracle-timing limitation; real expiry/refund paths also ran without fabricated delivery.

| Command / scope | Result and evidence |
|---|---|
| `forge build --sizes` | Pass; production size/profile unchanged. [Sizes](verification/protected-revenue/sizes.log) |
| `forge test --no-match-path 'test/{audit,scenario}/**' -vv` | Initial **198 passed, 7 failed**, exit 1; 32 suites, 561.80 s. Includes both invariant/handler suites, 64 runs × 4,096 calls, zero reverts; all seven invariants passed. [Initial pipeline](verification/protected-revenue/contracts-initial.log) |
| Affected `BalancerTest`, `ReserveTest`, `ReserveSecurityReviewTest` | **53 passed, 1 failed** initially (prank consumed by argument read); subsequent relevant recovery suite **12/12 passed**, native/policy **28/28 passed**. All seven broad-run failures have passing affected reruns; no duplicate full run. [First repairs](verification/protected-revenue/contracts-repairs-initial.log), [recovery](verification/protected-revenue/contracts-recovery-repaired.log), [native/policy](verification/protected-revenue/native-and-policy-final.log) |
| `EconFork` controlled late-win and random cases, `--gas-limit 100000000000` | Both passed with actual-fulfillment assertions; late-win driver uses the documented long-run gas budget. The affected random case reran successfully in 84.07 s. Per-call gas context remains witnessed; this is not a billion-gas production transaction. [Late win](verification/protected-revenue/economic-late-win-repaired.log), [random](verification/protected-revenue/economic-random-final.log) |
| `forge test --match-path test/scenario/FlowBreakdown.t.sol --gas-limit 100000000000 -vv` | Initial **24 passed, 2 failed**; two obsolete credit/top-up assertions corrected and **2/2** rerun passed. All 26 current checks covered once plus affected repairs. [Initial](verification/protected-revenue/asset-flow-initial.log), [repairs](verification/protected-revenue/asset-flow-repaired.log) |
| `forge test --match-path test/audit/** --gas-limit 100000000000 -vv` | **267/267 passed**, 33 suites, 192.56 s after the first affected-harness compilation (116.79 s). [Regression campaign](verification/protected-revenue/audit-regressions.log) |
| `forge test --match-path test/scenario/PriceCaps.t.sol --gas-limit 100000000000 -vv` | **5/5 passed**, including their fee/markup scenarios. [Evidence](verification/protected-revenue/price-caps.log) |
| Fixture generators (`ParityFixture`, policy quotes, enforcement, money path) | **4/4 passed** against changed contracts; generated fixtures were replayed, not manually adjusted. [Generation](verification/protected-revenue/fixtures.log) |
| Literal cash-vector real-path regression | **1/1 passed**; B=0.20, C=0.02, R=0.10 permits total 0.10. [Evidence](verification/protected-revenue/exact-cash-example.log) |
| `npm run abi` | Generated ABIs from current Foundry artifacts; obsolete selectors removed. |
| `npm run test:ts` | **147 passed**, one opt-in live RPC test skipped in default run; it separately passed against both V1 and V2. Initial reporting crash on deleted Settings source repaired without weakening execution gates. [Final](verification/protected-revenue/typescript-final.log), [initial failure](verification/protected-revenue/typescript-initial-failed.log) |
| `npm run typecheck` | Pass on final TypeScript. [Output](verification/protected-revenue/typecheck-final.log) |
| `npm run build:app` | Pass; existing large-chunk warnings remain. [Build](verification/protected-revenue/app-build-final.log) |
| `E2E_PORT=18746 E2E_KEEP_NODE=1 npm run keeper:e2e` | Pass; **28 keeper receipts**, 27 successful and one intentional stale-policy revert. Actual gas **0.017759236320355315 ETH**, rewards **0.019913897179388490 ETH**. Nonces, restart, reorg, response loss, replacements, mixed policies and actual receipt accounting exercised. [Final](verification/protected-revenue/keeper-e2e-final.log) |
| `REHEARSAL_PORT=18747 npm run rehearsal -- --rounds 50` | Pass: **48/48** arrivals open, **150** draws, **59** keeper tx, zero reverts, 4 high-gas waits/resumes, two restarts. Keeper reward **0.040144418701363331** minus gas **0.033376208122102266** = **0.006768210579261065 ETH**. Median reopen 51 ms, max 1,085 ms. [Diagnostic](verification/protected-revenue/rehearsal-50.log) |
| Recent fork lifecycle | Pass at then-current mainnet block **26,442,936**, using Tenderly public RPC. [Evidence](verification/protected-revenue/recent-block.log) |
| `npm run sim` | Pass: **45 scenarios**, explicit demand/capital/NFT assumptions; exact quote matrix and step-by-step fork money-path replay. [Report](reserve-redesign-simulation-results.md), [output](verification/protected-revenue/simulation.log) |
| `node --import tsx keeper/reserve-economics.ts` | Pass; 97 actual local receipts and five complete asset cycles. |
| Creator policy preview integration | **2/2** each against real V1 and V2; no settings reads. [V1](verification/protected-revenue/frontend-policy-v1.log), [V2](verification/protected-revenue/frontend-policy-v2.log) |
| Browser interactions | Actual credit claim under history/quote failure; 100% preview; NFT approval, exact 1234-bps atomic creation and first bounded unpaid stocking. See decoded evidence above. |

Committed text-log copies normalize trailing whitespace and excess final blank lines only; original local outputs
remain under `/private/tmp/fwa-credit-*.log`. All result, failure and numeric content is retained.

Preserved failures also include occupied default E2E port 18546, initial sandbox DNS/IPC restrictions, the old policy-cap
log assertion and an admin transaction receipt timeout. Port collision preserved the unrelated listener; tests used
isolated ports. Removing metadata correctly made the local bid cap independent from V1 reimbursement. The harness now
checks actual no-send/no-maintenance during the spike, uses explicit admin fee fields, and can retain its owned node on
failure for readback. No product invariant was relaxed to make those checks pass.

## Independent review and limits

Independent reviewers read full consequential Solidity flows plus callers/actual dependency source, and separately
reviewed creator UI cash, policy, failure and creation paths. Frozen production SHA values match the manifest. No
remaining actionable Solidity finding was reported in that bounded pass. UI findings were repaired and re-reviewed;
one subsequent estimate-unavailable copy correction was exercised in the browser and built. Coverage review found five
missing focused cases; permanent tests now cover fee changes after proposal, native 1,000-target creation/first bounded
upkeep, actual hostile FWA listing rollback, latched reentry/initialization attempts and same-address stale quotes.
This is agent implementation review, not an exhaustive independent security audit or release approval.

The sealed `script/deploy.sh --local-rehearsal-plan ...` route still belongs to archived **04bc760** and its interrupted
approved batch. It rejects this changed candidate. Its historical plan/hash, verifier, production wrapper and approval
requirements remain intact. The affected gate tests passed **15/15** after binding both current credit and preserved concurrent-recovery evidence
paths, including rejection of changed inputs outside the archived source seal. [Gate tests](verification/protected-revenue/local-gate-final.log).
The passing npm rehearsal exercises the existing deployment implementation/keeper on a
separate synthetic node; **a new candidate-specific, hash-bound full wrapper rehearsal has not run**. No old signature
or report is presented as validation of this code. Production outcome approval, whole-candidate release review, real
wallet signing and any separately authorized mainnet canary remain outside implementation completion.

Other evidence limits: controlled randomness does not test live Chainlink timing/availability; all current committed test directories were exercised through the broad partitions and affected repairs; separate
historical audit evidence outside the test tree was not rerun. Refund recovery of real Shape backing was not artificially forced because trusted Shape transfers cannot be rejected by an NFT receiver. General
simulation demand/gas paths are hypotheses beyond the matched fork replay. Private fork hashes are local evidence,
not mainnet explorer transactions. Retained local nodes/previews are task fixtures, not production services.

## Things that don't make sense

- At a 100% allocation the pool earns no new operating revenue. Replenishment needs existing capital or an explicit
  creator contribution; the setting is intentionally permitted and labeled.
- Quote/trace estimates sometimes understated billed keeper gas (rehearsal worst estimate −563,808 gas; worst trace
  expense −172,279). Aggregate keeper results were positive, but individual inclusion/work changes can still cost the
  operator gas. Atomic payment floors bound accepted compensation, not every failed attempt's loss.
- The existing flat work incentive can subsidize buyer/keeper manufactured expiry work from creator operating cash at
  very low gas. The measured amount and whole-coalition loss are separated above; caps are not a universal profitability
  guarantee. No new economic outcome approval or public launch authority is implied.
