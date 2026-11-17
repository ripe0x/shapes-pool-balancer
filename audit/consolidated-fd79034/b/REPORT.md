# Launch audit step B: sealed partial uninformed discovery

Target: `fd7903476a63e1c8e912b3b6f4dc1441aeccab11`, shapes-pool-balancer, owned detached checkout `/private/tmp/pool-audit-fd79034-v30pczr5/b`. Whole-candidate requested scope: contracts, policy, FWA, Shapes, Packs, keeper, planner and dashboard. Authorized cap90minutes, no broadcasts/spending. Method uncalibrated; agent-reviewed; human review absent. This is **partial and incomplete**, with no broad negative security conclusion and no release approval.

The controller explicitly ended further adversarial work after a tool safety interruption and instructed this follow-up to report only existing executed evidence. No further attack techniques or sequences were developed/run after that instruction. This is the stop disposition for remaining requirement groups, not an assertion that their execution was infeasible or their properties held. The interruption's underlying policy reason was not available to this lane; it is not recast as an automatic-approval rejection or an owner instruction.

## Independence and preflight

The checkout physically lacked prior reports, decision logs and named prior review tests. No prior report contents, Git history, other lane output or parent/sibling checkout were opened. Initial `git status --short` accidentally printed names of deleted historical reports/test paths; these filenames were seen, not their contents. Broad standard/runbook reads also returned sections beyond0/0b; these were workflow instructions, not target findings. Thus uninformed means procedural answer separation, not enforced blindness; shared-host isolation was not enforced. Public-code training exposure remains unknown.

Actual worker runtime: Foundry1.8.1 commit982849d3140c01fd3b72905759581a132df7aa98; executable `/Users/dd/.local/agent-guards/bin/forge`. Standalone `solc` version0.8.26; actual Forge compilation used pinned Solc0.8.28. Cancun, viaIR, optimizer50; Packs separate optimizer20 profile. Neutral test compiled/executed before target-code discovery and fuzz ran256 cases. Initial sandbox fork attempt failed DNS; approved outside-sandbox retry passed both neutral tests on Tenderly mainnet block26382349. The actual fork URI was `https://mainnet.gateway.tenderly.co` (the shipped mainnet alias resolves there).

Every Forge call emitted missing-submodule auto-install warnings because exact copied dependency contents lack submodule checkout metadata. Installs failed non-destructively on existing nonempty paths; Solidity compilation and fork execution nevertheless succeeded using copied source. No dependency replacement, cache deletion or service termination occurred. Candidate production diff check `git diff --quiet HEAD -- src app shared script foundry.toml` returned0. No tracked production code was edited. The removed `keeper/reserve-economics.ts` and review evidence are packet exclusions, not edits by this lane.

## Economic pass

The independently derived map and attack list were written first in `derived-map.md`, before the builder flow helper was opened. The builder breakdown agrees on actual asset routes: creator ETH to Balancer; backing to Shapes/Packs and FWA custody; mint fees to Shapes; buyer randomness fees irreversibly to VRF; FWA edge/refund escrow separate; bounded keeper pay from operating cash; creator profit above the first10% separated; restock fees in listed prices remain expectations, not cash. Close/unlist/redeem/claim reverses backing and operating cash; randomness, Shapes fees and FWA edge remain one-way, with buyer refunds owed by FWA.

**Executed economic observation E-B1: low-gas buyer/keeper subsidy with creator-selected maximum policy and absent randomness.** An adversarial policy is an allowed untrusted creator-selected input, not a substitute for FWA/Shapes/Packs. At executed basefee1wei and bid2wei, five real FWA acquisitions expire, their entire purchase principal is refunded by FWA, and three paid upkeeps reconcile them. Actual Balancer cash falls by0.000250000001534636ETH; keeper balance rises by that exact amount; buyer loses only0.000000000023400000ETH in five nonrefundable randomness fees. Receipt-billed keeper gas cost plus randomness is0.000000000024582886ETH, producing buyer+keeper net0.000249999976951750ETH. A single draw's principal was0.014006733546227430ETH. When creator joins buyer+keeper, transfers cancel and aggregate cash loses exactly the nonrefundable randomness fee, plus gas economically; no aggregate value creation was established. This is a **conditional creator subsidy**, not a confirmed violation of an approved numeric outcome: creator chose the rewarding policy, the attacker cannot itself suppress real randomness, and1wei basefee is an extreme diagnostic context whose practical mainnet reachability was not established. DefaultV1, practical low-gas contexts, repeated volume and real coordinator timing were not examined. Smallest response is to carry this conditional cost into policy economics and decide the acceptable subsidy before changing policy rules; no repair is authorized or proposed as settled.

**Diagnostic limitation E-B2:** builder scorecards mark all listed backing as `above_need` when need is null. Quiet regime reports1.7ETH of backing as above need, and0.196824640644681196ETH of pending/refund/edge FWA balances likewise. These are encumbered assets/rights, not disposable excess. This affects interpretation of the breakdown, not an executed loss. The independent map treats listed backing and buyer/FWA obligations as fully encumbered.

### One-screen scorecard

| Reached context | Measurement | What it establishes |
|---|---:|---|
| All16 denominations, one of each, basefee/bid5gwei |196.66ETH exact backing;0.027ETH mint fees;196.79962ETH opening;0.06589664ETH actual setup pay;0.04672336ETH remaining cash| All real Shape/Pack sizes mint/list with minimum quoted funding;30day idle adds no cash debt; unlisting redeems exactly196.66ETH and final creator cash/listings/proceeds become0 |
|20small Shapes, basefee0.5gwei/bid0.55gwei|0.2356ETH opening| Independent setup reached using real FWA/Shapes/Packs and actual BAYC |
| Five expired draws, hostile policy becomes unavailable |0.072498283786359740ETH buyer principal refunded;0.007ETH closed paid hold; hold0 after disable| Failed paid quote atomically rolls back processing; restricted-independent unpaid path processes/refunds; closeout returns creator balances |
| Low-gas conditional work subsidy, basefee1wei/bid2wei|0.000250000001534636ETH creator cost;0.000249999976951750ETH buyer+keeper net| Conditional cost distribution, no coalition-wide profit when creator included |
| Builder gate25regimes |O1 max62,216refundgas/draw;O2 max0.2538ETH listed fees;O8 max1,184bps;O9 drift0.000027004958979084ETH;O10 max1.4717x| Numeric configured gates satisfied in their named measured regimes; not independent new attacks |
| Builder closeout/minimum regime |O3/O4/O6 measured0;O15 exact0.2356ETH;O16 topups0| Shipped scenarios report protected closeout and explicit no-topup minimum contexts |
| Gate authority |exit2, unsigned/mismatched approved-outcome hash | **INCOMPLETE**. No signature, deploy authorization or review seal created |

Gate quiet destinations (% of inflow): creator claims45.1%; delivered backing28.1%; listed backing18.1%; Shapes fees2.8%; randomness2.5%; FWA pending/refund/edge2.1%; keepers1.2%. Like-input limits_at_max/max_then_idle have measured destination drift below the configured500bps threshold. Other regime destination changes are contextual, not automatically beneficial. All25 raw regenerated scorecards are retained under `scorecards/`; the one-screen table does not replace them.

Regimes executed by the asset gate: quiet, limits_at_max, max_then_idle, zero_demand, large_win, gas_spike, randomness_not_delivered, closeout_pending, restock_in_flight, top_heavy, whatif_large_win_top_up, whatif_large_win_drop_top, normal_gas, gas_2_gwei, gas_5_gwei, extreme_top_heavy, extreme_bottom_heavy, smallest_board, largest_board, no_processor, no_processor_5_gwei, burst, policy_switch, minimum_capital, minimum_large_win. Their configured metrics passed. Gate exit2 was solely outcome approval absent/mismatched. Current source hash4e8ea5806e516d7ecb23626bca37dcb8855c6a1166400b6cb1b96e161f172bfa, outcome hash7f75fee903715d28f96f27f4f73cc6394e6c0333dafb1cf46d2805d50179d70c. Neither hash is an audit approval.

## Security pass: bounded executed results

No independently confirmed security finding was established in the four executed sequences. That is limited to these paths:

- A1ETH caller payment floor rejects and rolls back real mint/list work, preserving cash and inventory; unauthorized stranger policy proposal reverts; activation before2days reverts.
- Creator acceptance cancels the departing creator's pending policy; that proposal remains unactivatable after maturation. Old creator withdrawal reverts. Emergency disable changes settings hash; stale paid call reverts. Paid keeper restriction still permits actual public unpaid mint/list recovery.
- A selected policy that later reverts cannot partially commit FWA processing via paid upkeep. Closing retains exactly five current draw budgets; disabling releases their hold; three public unpaid calls process five real expired requests and buyer refund withdrawal receives exact original principal. This is expiry, not failed NFT delivery.
- All16denomination backing identity and exact aggregate redemption were exercised through actual Shape and production Pack mint/list/withdraw/redeem routes. No mock protocol, synthetic counterparty state/balance, or direct protocol-caller impersonation was used. Actual BAYC assets provide curated positive controls; allowed coordinator impersonation exists in the shipped driver but was not used by these four independent tests, which intentionally exercise absent randomness.

Each monetary test uses `vm.fee` and `vm.txGasPrice` and a separate state-changing context probe requiring both values. Calls run `--isolate`; receipt gas uses pinned Foundry lastCallGas. Buyer setup, owner BAYC transfer impersonation and external actor wallet funding are setup, not protocol-state replacement. Keeper-only paid processing and creator closeout are real public entry points. The builder driver can deliver deterministic words as actual coordinator through realVRFService, an explicitly retained exception. Its `settle()` helper also manually calls FWA processing; the no_processor regimes omit that helper and exercise keeper ownership instead. This lane did not independently trace each builder callback or every regime postcondition.

## Requirement-group execution and remaining gaps

| Group | Existing executed evidence | Remaining gap / stop disposition |
|---|---|---|
|Authority/deployment R1-R3|No live writes; forkURI explicitlyTenderly; source diff0|Deployment/rehearsal not performed; authority unchanged|
|Paidkeeper/auth/floors R4,R5,R10-R13,R28-R32,R37,R50|Independent floor, role transfer, restriction/unpaid, expiry pay;25regimegate|Real service receipts, defaultV1 lowgas, hostile gas exhaustion/maximum caller bounds not independently executed; controller stop|
|Game economics/markup/restocking R6-R9,R14-R19,R24-R27,R30-R33,R35-R38|Independent all16 minimum+idle+redemption;25regimegate|Independent adversarial top/bottom price and max1000board; every markup/NFT choice; compromised owner extremes not all executed; controller stop|
|CuratedNFT/failure rights R20-R23,R34,R47|ActualBAYC positive custody and recovery; expired acquisition refund|Hostile collection seizure, failedNFT delivery retry/refund/recovery and reentrant recipient not independently executed; controller stop|
|Replaceablepolicy R39-R45,R51|Pending cancellation,2day delay, stalehash, emergencydisable, unavailablepolicyunpaid;gatepolicy_switch|Hostile returndata/gasburn/mutablequotes, defaults/newpool isolation, paidallowance persistence not independently executed; controller stop|
|Capital R46-R49,R52-R54|All16 exact minimum,20small, actualpool/creator/buyer/keeper lowgasflows;minimum regimes no topups|Full continuum/extremegas and practicallowgas/frequency/recovery economics not independently executed; controller stop|
|Keeper/planner/dashboard R44,R53|Read affected keeper quote/floor/trace/pending paths and dashboard funding/status/policy code|No independently run keeper integration, TS suite, browser interactions or live service; controller stop|
|Dependency correspondence|Constructor checks live FWAimpl codehash0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;real fork calls;local productionPacks artifact|Vendored verified FWA/Shapes/VRF source-to-runtime correspondence not independently rebuilt/verified; no recentblockdrift; explicit unresolved integration gap|
|Static/stateful methods|Focused executed sequences and shipped25regimes|No Slither or independent invariant campaign; controller stop|

## Command and evidence ledger

All commands ran in the owned checkout; redirections retain stdout+stderr. No full Foundry suite, `--force`, cache clearing, process killing, secret access, broadcast or funding transaction occurred.

1. `forge --version; solc --version`, initial runtime inventory: exit0; Foundry/compiler facts above. Runtime output was returned through the tool, not a dedicated log. Initial inventory printed historical deleted-path filenames as disclosed.
2. `forge test --match-path test/IndependentNeutralB.t.sol -vv > .../preflight.log 2>&1`: exit1. Solc0.8.28 compilation succeeds; fuzz256passes; forkDNSfailure.
3. Same neutral command outside sandbox to `preflight-outside.log`: exit0;2tests pass. Suite310.55ms. Fork block26382349.
4. `python3 /Users/dd/.agents/guidance/asset-flow-kit/asset_gate.py --help`: script treats positional `--help` as a nonexistent repo and reports missingconfig. Exit2 inferred from script behavior; the combined shell later exited0 after unrelated reads. This unsuccessful non-target invocation is not gate evidence.
5. `python3 /Users/dd/.agents/guidance/asset-flow-kit/asset_gate.py . > .../asset-gate.log 2>&1`: exit2;25regimes regenerated, configured outcomes satisfy measured bounds, approval incomplete. The config invokes `CANDIDATE_RUN=1 forge test --fork-url https://mainnet.gateway.tenderly.co --fork-block-number26382349 --isolate --threads8 --match-path test/scenario/FlowBreakdown.t.sol --gas-limit100000000000` with spaces as actually specified in asset-flow.json. Exact configured command: `forge --version | grep -q 'Version: 1.8.1' || { echo 'gas evidence needs Foundry 1.8.1 (CI pins it)'; exit 1; }; CANDIDATE_RUN=1 forge test --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 --isolate --threads 8 --match-path test/scenario/FlowBreakdown.t.sol --gas-limit 100000000000`. Successful nested Forge stdout is suppressed by gate; no independent receipt trace retained for all25regimes.
6. `forge test --match-path test/IndependentLaunchB.t.sol --isolate -vv > .../independent-initial.log 2>&1`: exit1. Harness compile fails because adversarial policy omitted required `version()`; no behavioral result.
7. Same independent command to `independent-v2.log`: exit0;4tests pass, Solc0.8.28 compile2.61s, suite825.64ms; test names and exact amounts in rawlog. Added only policy `version()` to resolve setup; no production change.
8. `git rev-parse HEAD`: candidate confirmed. `git diff --quiet HEAD -- src app shared script foundry.toml`: exit0. This does not compare the explicitly excluded review/economic files or dependencyGitmetadata.

Preserved sources: `IndependentLaunchB.t.sol`, `IndependentNeutralB.t.sol`; preserve original logs including both failures. Exact generated scorecards under `scorecards/`. No `SOURCE_HASH` deploy-review record was written; the controller owns subsequent challenge/repair/release gates.

Time: preflight first log finalized2026-11-17T21:50:28Z; successfulpreflight21:50:44Z; gate21:52:15Z; failedharness21:53:05Z; passedharness21:53:30Z. These are UTC filecompletion timestamps, not elapsed perphase. Setup/intake occurred earlier; exact perstep durations were not instrumented. Reporting occurred after the explicit stop. No timebox completion or90minutecoverage is claimed.

## Things that don't make sense

- A keeper policy can deliberately make refunded requests a creator-paid service income source when randomness is unavailable and gas is extremely cheap; practical context and acceptable subsidy need separate evaluation.
- The builder's `above_need` rows label encumbered backing/escrow as excess when need is unknown.
- The copied dependencies work but Forge repeatedly tries impossible auto-installs; warnings obscure real failures.
- New proposed outcomes remain unsigned; numerical gate results grant no deployment authority.
- Independent real-runtime source correspondence and whole-system keeper/dashboard behavior remain unexamined when this partial report is sealed.
