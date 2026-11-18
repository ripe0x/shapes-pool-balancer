# Current implementation status: protected revenue, 2026-11-18

The current branch replaces historical inventory-dependent attribution, optional policy settings metadata,
full-inventory activation checks and separate setup transactions. [Current evidence](PROTECTED-REVENUE-RESULTS.md)
records the candidate checks and limitations. Previous signatures and audit seals do not validate this code.
Mainnet deployment, real spending, production configuration changes and merging remain unauthorized. The existing
release gates and historical local rehearsal seal are preserved. Implementation verification and product acceptance
are separate from release readiness.

All material below is historical context for its named revision.

# Mainnet deployment readiness

## Main integration and interrupted local batch (2026-11-18)

All twelve task commits through `8886048` were fast-forwarded and pushed to `main`, including policies, reduced reserves, audit remediation and local gate separation. The owner then-approved exact local batch7b was attempted. Its eight system deployments and one test-NFT creation succeeded; the driver stopped on a receipt-not-found race before creating a pool, depositing creatorETH or requesting draws. The [nine-transaction reconciliation](../audit/local-rehearsal-7b18522f/REPORT.md) accounts for0.002123978546527748syntheticETHgas and every actor balance. Receipt polling is repaired, but the approved material hash is now invalid and no further transaction is authorized by that packet. A separately prepared/reviewed continuation remains required. This was neither a complete rehearsal nor real-wallet/oracle or production-release evidence.

The attempt also exposed a skipped pre-funding CLI under the absolute symlinked temporary path. Its0-byte log is preserved; the later deployment gate did execute. Canonical entrypoint resolution and mandatory matching JSON proof are repaired with a real failing-before symlink regression,13focused tests passing and typecheck passing. The original gate gap is not retroactively called successful. No sends followed these repairs.

## Local gate separation (2026-11-18)

The owner authorized a local-only gate change and preparation of the exact batch for a later decision. The [local rehearsal route](ASSET-FLOW-GATE.md) removes production outcome-signature/whole-review prerequisites only for the hash-bound owned Anvil diagnostic. The default production gate retains both. No batch approval, funding or broadcast follows from implementation authority. [The concrete batch](RELEASE-REHEARSAL.md) remains proposed until the owner approves its final hash.

Production contracts, custody, reserves and policy economics are unchanged. Historical contract verification remains scoped to its original inputs; the changed wrapper has a separate full source fingerprint and no old audit/scorecard stamps are copied onto it. Whole-candidate review, numerical acceptance and real wallet/UI transaction evidence remain open production requirements.

## Release follow-up (`04bc760` production inputs, 2026-11-17)

**Blocked, not release-ready.** The [interrupted review status](../audit/release-04bc760-interrupted/STATUS.md) preserves independent execution, failed diagnostics and unfinished coverage. Both whole-candidate reviewers were stopped by platform filtering; no completed-review seal is supplied. The previously passing 501-test Foundry campaign, 125 TypeScript tests and 25 fixed numerical regimes remain evidence for unchanged inputs, not replacements for this review.

O9 now explicitly scopes 0.001 ETH to its fixed regression. O2/O8/O11 wording also distinguishes reference scenarios from general promises, with all existing numerical thresholds and regime memberships unchanged. An independent adverse gas sequence has a **0.018420439573763843 ETH surcharge-only maintenance loss** despite positive gross creator recovery and zero residual purchaser obligations. The [numerical proposal](RELEASE-OUTCOME-PROPOSAL.md) asks the owner to accept conditional economics; no signature or general loss tolerance is inferred.

Read-only dashboard interactions were exercised against the existing local legacy pool: discovery, actual inventory, separate cash/backing/profit/reserve/expected-fee figures, policy/default quotes, candidate validation and missing-view compatibility. [Screenshots and readback](receipts/release-ui/REPORT.md) retain exact limits. Real extension-wallet connection remains at the user handoff; no signature or UI transaction was completed. The [new rehearsal](RELEASE-REHEARSAL.md) has only deployment simulation/preparation evidence. No fresh funding or broadcast occurred; its production wrapper still requires genuine owner approval and completed current review evidence. These gaps remain open.

## Current remediation candidate (base `2ab49fd`, 2026-11-17)

**No mainnet deployment or real-fund spending is authorized.** [AUDIT-REMEDIATION.md](AUDIT-REMEDIATION.md) is the current change/economic scorecard. R55–R58 retain concurrent requests and approximate current-board creator allocation; exact attribution is not being purchased with serialization, mandatory maintenance between batches, zero creator credit or a larger reserve.

- S2 uses the minimum of two conservative bounds: actual prior reserved prefix plus the six-record activation budget, and unreconciled draws plus a single possible-Shape-staging count. There is no per-listing staging queue or synchronization barrier. An earlier six-only formula passed focused admission/concurrency checks and all six sustained scenarios, but failed broader paths involving prior reserved staging. The no-scalar reserved-prefix candidate then reported 490 passes / 10 failures across 500 tests, all in a shared curated-listing setup. The final single-scalar formula passed twenty-seven focused checks and a revised seven-case admission run; its complete final campaign passed 501/501 tests across 67 suites and the bounded final review reported no actionable findings within its scope. Actual selectable/staged records remain distinct in the dashboard.
- S4 active quotes use bounded Balancer-context views; candidate quotes remain unverified. E2 coverage uses actual request-board surcharge receipts, and E7 includes zero bookings and both drift directions.
- E1 is **quantified, not eliminated**. Reproduced drift includes 0.002240053614343757 ETH overbooking under V1, 0.002729320077460120 ETH at 25% markup under a mutable policy, and 0.001744348693206539 ETH underbooking in the reverse case. The original 0.001 ETH O9 value is not a universal ceiling. General acceptance of approximation is not an owner signature on a new number.
- Exact-opening concurrent claim/hostile-policy/unpaid-closeout paths preserved actual FWA purchaser rights and redeemable backing in their reached states. Temporary operating shortfalls and dependency failures remain possible; no unlimited paid-continuity or universal profitability claim follows.
- Final PoolBalancer runtime is 23,641 bytes, 935 below EIP-170. The final `CANDIDATE_RUN=1` Foundry campaign passed 501/501 tests, exit 0; TypeScript passed 125 tests in 12 files, with typecheck/build successful against the final exported ABI. All 25 fresh same-run flow records passed numerical checks. The gate remains exit 2, INCOMPLETE, only for unsigned approval and absent fresh whole-candidate audit seal. [Verification](../audit/remediation-focused/verification.json) preserves exact scope, logs and failures. Rejected candidates and all earlier failures remain preserved, including the 497-pass/3-fail cached-staging campaign and three sustained failures of a later current-board-only bound, the six-only activation campaign's 311 passes / 188 failures / 499 tests (exit 1), and the no-scalar reserved-prefix campaign's 490 passes / 10 failures / 500 tests (exit 1).

Remaining before release: obtain a fresh whole-candidate audit seal; reconcile numerical outcomes and obtain owner approval; exercise changed dashboard interactions and an actual browser wallet; complete the final-revision production-path rehearsal; resolve live FWA page compatibility and role/configuration decisions; separately authorize any mainnet canary. S7/S8 monitoring/availability, S5 external service limits and S6 unsolicited-NFT rights ambiguity remain outside these assigned fixes. R20's hostile curated-NFT risk remains expressly accepted, not newly repaired. The old 50-round local batch is evidence for its old bytecode only. See the historical checklist below for retained details; it does not supersede this status.

## Historical audited candidate: `9b45f91` (2026-11-17)

**Not deployed. Implementation verification is recorded; mainnet deployment is not authorized.**
The current architecture is described in [KEEPER-POLICIES.md](KEEPER-POLICIES.md) and
[RESERVES.md](RESERVES.md). Exact economics, scope and limitations are in
[reserve-redesign-results.md](reserve-redesign-results.md), with command/log digests in
[verification.json](../audit/reserve-redesign/verification.json).

The independent audit of `9b45f91` has been received and [reviewed](INDEPENDENT-AUDIT-REVIEW.md). Mainnet is blocked by open E1/E2 economic-accounting/evidence findings and S2/S4 admission/preview issues; the supplied experiments were inspected, not independently rerun by this review. Parallel [launch preparation](LAUNCH-PREPARATION.md) lives on a separate branch/worktree and adds local-only diagnostic scripts and evidence without changing production inputs. Production contracts remain those of `55c094f`.

### Evidence already obtained

- Reporting correction after the frozen audit: unknown need/excess is null, known backing and purchaser obligations are encumbered, and the existing reader fails closed for outcomes requiring unknown metrics. Production contracts and withdrawal calculations are unchanged.

- Final candidate: 483 Foundry tests passed, zero failures; 120 TypeScript tests passed; typechecking and dashboard build passed.
- Keeper integration: 28 canonical transactions, 27 successes and one intentional stale-policy revert; nonce/replacement/reorg recovery and receipt accounting exercised.
- All 25 fixed real-dependency asset-flow regimes were regenerated after the reporting fix and their current numeric checks pass. The independent audit nevertheless demonstrates an O9 violation outside those seeds and an incorrect O11 fee-receipt metric; the old numeric pass is not correct economic acceptance. The gate remains **INCOMPLETE because revised outcomes are unsigned and the corrected evidence lacks a fresh independent review record**.
- Independent focused reserve security and economic reviews ran. Actual low-gas hostile-policy round trips close the earlier measurement gap for their executed cases.
- PoolBalancer runtime is 24,449 bytes (127 bytes below EIP-170). Actual deployment submitted gas limits and individual setup receipts remain below EIP-7825.
- Real local-fork dashboard interactions exercised surplus withdrawal, partial inventory disclosure and Add ETH recovery. This does not substitute for a real browser-wallet extension test.

### Remaining before mainnet

1. Resolve the received independent audit findings before release; the [review](INDEPENDENT-AUDIT-REVIEW.md) separates actual defects, accepted risks, conditional liveness and owner decisions. The unchanged candidate completed a local diagnostic batch and remains unendorsed for release. The [new audit attempt](../audit/consolidated-fd79034/REPORT.md) is **partial**: both independent agents were interrupted by tool safety controls. Ten focused cases and a static scan produced bounded evidence, not full coverage. The confirmed flow-report labelling defect is corrected in the [reporting-fix evidence](../audit/reporting-fix/REPORT.md); encumbered backing/escrow is no longer labelled excess. The old audit report remains historical. The supplied audit adds partial source/runtime correspondence and bounded off-chain examination, not complete recompilation or full coverage. Human technical review is absent.
2. Owner approval/signature of revised asset-flow outcomes after audit reconciliation. The [review packet](OUTCOME-APPROVAL.md) groups all16 unchanged outcomes, measured numbers and tradeoffs. Temporary inventory depletion replaces immediate full-restoration insurance; prior zero-missing-days claims are explicitly superseded, not passed. No measurement is an owner signature.
3. Final-candidate current-block production-path rehearsal with the keeper and dashboard, signed local transactions, actual fee fields and live outcome readbacks. The approved [local batch](LOCAL-BATCH-RESULTS.md) completed the unchanged production deployment and actual Keeper-class exercise at fork block 26,437,802: 50 rounds / 152 draws, 65 prizes / 87 slippage refunds, 0.203466407875872872 test ETH gas. Exact receipt/obligation checks passed across resumed attempts. No dashboard/real-wallet or fresh CLI/reorg test was included, and the known-finding candidate is not a release pass. Earlier rehearsals remain scoped to their revisions and assumptions.
4. Real-wallet extension writes and the FWA pool-page answer for an ERC-1271 contract owner. The [current read-only investigation](FWA-PAGE-COMPATIBILITY.md) confirms client format only; server acceptance remains unverified. Local wallet actions are specified in the preparation checklist, not reported passed.
5. Confirm launch values and roles: keeper eligibility admin, distinct policy-default admin, Draw Packs presentation admin/name/symbol and final dependencies. No live addresses are inferred from local test deployments.
6. Review the [proposed canary plan](CANARY-PLAN.md), caps that can and cannot be enforced, exit and monitoring; separately authorize any mainnet deployment/canary. No mainnet broadcast or real spending is authorized by this checklist.

The design intentionally permits delayed replenishment and exposes actual inventory. A last curated NFT win or insufficient admission weight can pause sales and require creator action; future demand cannot fund a paused pool. Public unpaid recovery retains the existing game-first ability to consume booked creator profit. These are disclosed operating rules, not audit findings by themselves.

## Historical readiness records

Everything below is retained history for its named revision. References to "current", "open" or "resolved" below do not override the checklist above. Valid evidence is reused only while its code, dependencies, configuration and assumptions remain unchanged.

## Historical policy candidate (`a8fb321`, 2026-11-17)

Implementation evidence is in [keeper-policy-results.md](keeper-policy-results.md). Real-dependency V1→V2 lifecycles, affected Foundry tests, 70 TypeScript tests, a 300-round local keeper rehearsal, dashboard interactions and two focused independent reviews were exercised. The initial broad Foundry command had 67 failures; repaired affected runs pass, with the full failure history retained. This does not imply a clean full-suite command or comprehensive audit.

The 23-regime asset-flow run meets its numeric bounds and has a matching review source record, but **the gate returns INCOMPLETE because changed outcomes are unsigned**. The old owner signature was not reused. The new conservative reserves, generous immutable spending exposure and remaining low-gas hostile-policy profitability gap need owner consideration. Historical open items below are not closed merely by this refactor. There is no mainnet deployment authority, live-transaction rehearsal or canary evidence here.

## Rewrite status (2026-11-11)

The contract was rewritten: simplified gate, markup applied at listing, `unlistShapes`, creator-only `recoverRefunded`,
keepers paid only from a restocking fee priced into prizes and a reserve that bounds withdrawals and, since DECISIONS 61, admits purchases (SPEC.md, DECISIONS 43-56). **This rewrite is a verified
slice, not a frozen release candidate:** every fork test file passes when run one at a time, the invariants pass at 64
runs × 4,096 calls, and one independent AI review (round 7) is resolved. The verification under "Earlier verification" below ran
against the previous design (commit `3f1735f`); its suite results, gas numbers and rehearsals do not carry over to the
rewrite and must be re-run against it before release.

Open before release:

0. **Round 8 audit (partial, `audit/round8/report.md`) and its repairs (DECISIONS 61-64).** E1, E2, E4-E8 and S4 are
   fixed with focused fork tests; S1, S2, S5 (dishonest curated collections) and S3 are documented trust limits; E3
   (simulation VRF fee and destination checks) is open. The repairs have not been re-audited, and the audit's
   structural gate failed with open paths. DECISIONS 66 then replaced the purchase-time funding check with a funded
   `open()` and a 10% minimum markup; E1 is accepted by the owner and needs re-audit with the rest. DECISIONS 67-68 add the
   profit split (`profit`, `profitShareSum`, a new `claimSurplus` limit), which changes who is paid from the balance and
   needs the same re-audit, economic pass included.
1. **Review of the round 7 repairs and the keeper-pay changes** (per-call limits, reserve fee, setup checks; keepers
   then paid from `keeperCredit`; since replaced by DECISIONS 73, every reconciling or listing call paid from the creator's ETH), made after
   the independent review. The fee-at-draw version had one independent AI review; crediting at listing (DECISIONS 57)
   has not been independently reviewed.
2. **Re-run the fork suites, keeper e2e and both launch rehearsals** against the rewrite, then freeze a release
   candidate. The keeper e2e and rehearsals start their own anvil fork on port 18546 and need that port's approval.
3. **Gas finding resolved (DECISIONS 51-56):** outside creator-started work keepers are paid only from restocking fees
   players pay in prize prices, so keepers never touch the creator's markup; when gas rises after listing, restocking
   waits and purchases pause instead. Opening the pool (stocking it) is still paid from the creator's ETH. Players pay
   about 16% more per Balanced draw at 1 gwei; whether that changes demand is untested.
4. **Gas jump after listing: resolved (DECISIONS 57-58).** At `6fc2b9b` the 50-round rehearsal stalled at its 3 gwei
   step. With fees credited when the keeper lists a prize: keeper e2e passes (12 txs, 0 reverted, 0 skipped); the
   50-round rehearsal passed on its second run (48/48 buyers found the pool open; 3 and 4.9 gwei batches serviced;
   above 8 gwei the keeper waited 4/4 and resumed; 59 keeper txs, 0 reverted). Its first run had one reverted keeper
   transaction whose cause was not captured; the harness now prints reverted transactions. 300 rounds: 288/288 buyers
   found the pool open, 24 batches each at 3 and 4.9 gwei serviced, above 8 gwei the keeper waited 24/24 and resumed,
   keeper balance reconciled to the wei; **3 of 340 keeper transactions reverted** after ~1.9M gas each, and one mined
   call billed 291k gas more than its estimate. A second 300-round run at `8c8d0e9` passed with 0 reverted (288/288
   open; billed exceeded the estimate by up to 218k gas). Suspected, not confirmed: the bundled keeper's 30% gas-limit
   headroom is exceeded when work grows between estimate and inclusion; the keeper now logs the gas limit on every
   receipt.
5. **Real wallet extension test** of the dashboard writes (carried over; see "Checks that could not be executed").
6. **FWA pool-page server answer:** whether `pools.fwa.fun` accepts ERC-1271 from a contract owner (carried over).
7. **Draw Packs deploy values and audit status (DECISIONS 36):** the name "Pool Prize Packs", symbol "PRIZEPACK" and the
   presentation admin `PACKS_ADMIN` are your call; Draw Packs' own audit status as used in ape-Ball is not confirmed
   here.
8. **Keeper admin address (DECISIONS 60):** `KEEPER_ADMIN`, who controls the factory's keeper list, is your call.
9. **Your explicit deployment authorization** and the release-candidate checks below, re-run on the frozen rewrite.

## Release-candidate checks (2026-11-13, commit `7b32497`)

Frozen at `7b32497` (tracked tree clean). Verification of the implementation only; not an audit, product acceptance
or release readiness.

- `CANDIDATE_RUN=1 forge test`: 112 tests in 12 suites passed, exit 0 (invariants included, 64 runs × 4,096 calls; the
  campaign admits only a few purchases per run, so it is weak on draw paths).
- `CANDIDATE_RUN=1 npm run test:ts`: 48 tests in 5 files passed; `npm run typecheck` and `npm run build:app` exit 0
  (Vite warns about chunk size only). `PoolBalancer` runtime 20,818 B (limit 24,576).
- Fork economics matrix, 8 scenarios with full closeout (`docs/fork-economics.md`): every draw sold, none refused,
  the Balancer empty after closeout and the realized result equal to the estimate to the wei in every run.
- `npm run keeper:e2e`: passed. `npm run rehearsal -- --rounds 300`: passed; buyers found pools open 288/288 times,
  832 draws, the keeper sent 388 transactions with 0 reverted, waited all 24 above-cap periods and resumed without
  help, and its ETH reconciled to the wei (net +0.1436 ETH).
- Open: E3 (simulation), the real-wallet test, the FWA pool-page answer, deploy values (`KEEPER_ADMIN`, Draw Packs)
  and your deployment authorization.

## Round 9 audit and repair (2026-11-13)

- Round 9 audit on `c686534` (`audit/round9/report.md`): one Low finding (R9-E1, the profit split used the listings at
  collection), E3 still open, no security finding; structural gate passed; agent review only.
- Repair (DECISIONS 69): collect before reconciling and before listing changes; three mocked tests removed. Contract
  changed after the audited commit, so the audit evidence covers `c686534`, not this repair. `PoolBalancer` runtime
  20,873 B. Per-file runs passed: Reserve 10 (both new assertions fail on the old contract), Balancer 29, Packs 9,
  Gas 23, Hardening 13, KeeperAdversarial 8, KeeperList 3, Fork 9, Parity 1, Invariant 1, EconFork 2. Not re-run:
  the TypeScript suite (no ABI or planner change), the fork matrix, keeper e2e and rehearsal.
- Gas context: Foundry runs test transactions at gas price 0 and basefee 0 inside calls unless set. `ForkBase` sets
  basefee 0.5 gwei and gas price 1 gwei for every repository fork test, the release-candidate runs and the fork
  matrix; `test/ForkContext.t.sol` now fails if that stops reaching calls and checks the listed restocking fee and
  FWA's VRF fee against an independent calculation (both tests fail with the settings removed). Several round 9
  audit harnesses ran at zero gas (erratum in `audit/round9/report.md`).

## Independent-audit repairs (2026-11-13, DECISIONS 70-71)

- Fork test files one at a time on the repaired contract: ForkContext 2, Reserve 13, Balancer 29, Packs 9, Gas 23,
  Hardening 13, KeeperAdversarial 8, KeeperList 3, Fork 9, Parity 1, Invariant 2, EconFork 2, all passed. The four
  new contract tests fail on the previous contract. `PoolBalancer` runtime 21,161 B.
- `npm run keeper:e2e` passed, including a restart after an unrecorded broadcast. Vitest planner and tx tests passed;
  typecheck and app build exit 0.
- Dashboard on the 8545 dev fork with the new factory: created a pool with an NFT (design saved before listing; NFT
  listed at 0.0625 ETH = 0.05 + 25%), purchases opened and the first upkeep listed Shapes; a pool transferred to the
  dev account appears in its list. Not exercised in the UI: the mint-fee-fall reserve and live Shape prices after a
  markup change (planner unit test only).

## Earlier verification (previous design, commit `3f1735f`)

The checks in this section ran against the pre-rewrite design and are kept as a record of the verification method. They
must be re-run against the rewrite before release.

Commit `3f1735f`. Contracts, keeper service, planner and dashboard are identical to `13a61ed`, where the suites
ran; later commits change only the e2e and rehearsal harnesses, which were re-run at `b6ffee9` (e2e) and `3f1735f`
(rehearsals). Later commits change documentation, the audit record (`audit/`) and the dashboard only (30% gas-limit
margin; round-5 fixes S1–S3), re-checked with the app tests, typecheck, build and a fork browser check. Run with `CANDIDATE_RUN=1` on
2026-11-10, mainnet fork pinned at block 26,382,349 via `https://mainnet.gateway.tenderly.co`.

| Check | Command | Result |
| --- | --- | --- |
| Build and sizes | `forge build --sizes` | pass after the round 6 repair; 50 optimizer runs; PoolBalancer runtime 24,412 B (limit 24,576, margin 164), PoolPage 1,194 B, ShapePacks 17,768 B (its own 20-run via-IR build), BalancerFactory 1,207 B. Mainnet deploy: Etherscan verification must cover the `PoolPage` library (deployed by forge through the CREATE2 deployer and linked into PoolBalancer; confirmed on the 8545 fork) and the Draw Packs pair |
| Foundry suites (fork) | `forge test --no-match-path test/Gas.t.sol` | 78 passed, 0 failed (7 suites incl. `KeeperAdversarial` 9, hardening 22, behavior 32, scenario 11, parity 1, invariants at 64 runs × 64 calls) |
| Gas benchmarks and break-even, refund-checked | `forge test --match-path test/Gas.t.sol --isolate -vv` | 32 passed; every keeper path reimbursed ≤ billed gas; PnL table in GAS.md |
| Planner parity and keeper policy | `npx vitest run` | 25 passed |
| Typecheck | `npm run typecheck` | pass (also at `3f1735f`) |
| Dashboard build | `npm run build:app` | pass |
| Keeper integration (2 real FWA pools on a fork) | `npm run keeper:e2e` | pass at `b6ffee9` (failed at `13a61ed`: stale refunded-Shape step, see below): fill, direct FWA draws incl. a 5-draw batch, receipt audit on 8 keeper txs, restart, replacement, reorg, downtime, spike wait, purchaser gate, pool-page ERC-1271, per-pool error isolation |
| Economic simulation | `npm run sim -- --runs 60` | completed; `docs/simulation-results.md` unchanged (deterministic) |
| Launch rehearsal, short | `npm run rehearsal -- --rounds 50` | **pass** at `3f1735f` (also at `13a61ed`): 48/48 arrivals found the pool open; 4 batches each at 3 gwei and 4.9 gwei serviced; above 8 gwei the keeper waited 4/4 and resumed unaided; 2 purchase-caused and 2 creator-caused plan switches; 2 keeper restarts; 57 keeper txs, 0 reverted, 0 skipped as unprofitable; reopen median 58 ms, max 1.5 s |
| Launch rehearsal, sustained | `npm run rehearsal -- --rounds 300` | **pass** at `3f1735f`, 15 min: 288/288 arrivals found the pool open; 832 draws; 24 batches each at 3 gwei and 4.9 gwei serviced; above 8 gwei the keeper waited 24/24 and resumed unaided; 12 purchase-caused and 12 creator-caused plan switches; 7 creator edits (2 at 4.9 gwei, where the unpaid re-checkpoint is beyond the keeper allowance, run by the creator); 3 curated restocks; 2 keeper restarts; 324 keeper txs, 0 reverted; reopen median 64 ms, max 1.2 s; estimate − billed 7k–295k gas (median 75.5k) |
| Keeper ETH reconciliation | inside both rehearsals | exact to the wei: Δbalance = Σ`KeeperPaid` − Σ(receipt gas × effective price) + other value (300 rounds: 0.375721938518941543 − 0.215830965555422905 = 0.159890972963518638 ETH over 317 reward events and 324 receipts; 50 rounds: 0.067842415288632562 − 0.039510238693974763 = 0.028332176594657799 ETH; no other transfers) |
| Deploy rehearsal | `forge script script/Deploy.s.sol` on a chain-id 31337 fork | pass (inside keeper e2e and both rehearsals) |
| Independent review of the final financial logic | clean-context AI reviewer at `0a48e84` | no extraction found; 1 Low/Info fixed (`31edef6`), 2 Info accepted; SECURITY.md round 4 |

No mainnet contracts were deployed and no mainnet transactions were sent. The dashboard was built, not re-exercised
in a browser this round (its code is unchanged; only planner constants changed, covered by parity tests).

Failures found during this verification, and what changed:
- First short rehearsal (`0a48e84`): the purchase-caused plan switch was scheduled inside the 8 gwei window, where the
  keeper correctly waits. Driver fixed (`13a61ed`); rerun passed.
- Keeper e2e (`13a61ed`): the refunded-Shape step bought a draw naming the Shapes contract as purchaser, which the
  purchaser gate now refuses. Step replaced by a gate assertion (`b6ffee9`); passed. The keeper's refund-watch path
  has no end-to-end exercise any more.
- Sustained rehearsal: anvil did not start within the driver's 10 s wait (wait raised to 60 s, `b6ffee9`); rounds
  took ~18 s because viem polled receipts every 4 s (direct receipt fetch, ~3 s, `5b36729`); then three driver gaps,
  each fixed in `3f1735f`: the creator never restocked curated NFTs, so a pool correctly closed for `NO_CURATED`;
  `listCurated` sent with an exact gas estimate reverted at 63/64 of its limit (driver now adds 30%); failed driver
  transactions now report decoded reasons. No contract or keeper-service change.

## Requirement status (previous design: reimbursement re-evaluated against FWA V2)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Priority allowance from first principles (0.05–1 gwei, fee schedule) | done: kept 0.05 gwei | GAS.md "Priority allowance" (90-day inclusion data); simulation policy table |
| Reimbursement and bonus together; operation-aware; separate ETH cap | done: 4/5 gas + (1/5 gas + 0.0005 ETH); no ETH cap (bounded by gas × price caps) | GAS.md "Keeper reward", "Reimbursement model comparison" |
| Real receipts with refunds | done | isolated gas suite (32), e2e receipt audit, rehearsal receipts |
| Batching protections preserved | done; strengthened (gas-only 4/5, no per-call intrinsic) | `test_gas_multiCallPlanSwitchInOneTx`, `test_profitAtCap_multiCallBound`, SECURITY V-1, V-4 |
| Adversarial competition: bids at/above cap, max reimbursement, self-dealing, multi-call, refund-heavy, spikes | done | `test/KeeperAdversarial.t.sol` (9), spike tests; all self-dealing net negative (−0.0011 to −0.069 ETH) |
| Liveness and capital per policy (executed %, reopen time, max economical gas, 30-day spend, exposure, reserve, creator net) | done | `docs/simulation-results.md` policy table; GAS.md PnL table; rehearsals |
| Reserve reduction without weakening obligations; exact boundary; repeated maintenance | done | `test_exactRequiredReserveOpens*`, `test_claimSurplusRespectsReserveWhileOpen`, `test_repeatedMaxClaimWorstBatchesAtCap` |
| Launch rehearsal: fresh keeper, wei reconciliation, pinned basefee, short + sustained | done (see Candidate) | `keeper/rehearsal.ts` |
| Independent review of final financial logic | done | SECURITY.md round 4 |

## Requirement status (previous design: simplification and hardening pass)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Remove `needsUpkeep`; keeper simulates `performUpkeep` | done | `performUpkeep` returns the reward; keeper classifies `NoUpkeepNeeded`/`PoolBusy`, surfaces other reverts; e2e |
| Remove on-chain `maxShapeCapital`; keep it in the planner; show ETH committed | done | `Config` has three fields; dashboard "Total ETH committed" |
| Keep up to four fallback plans with first-feasible selection | done | `test_switchesToFallbackPlanWhenInfeasible`, `test_planBeyondListingLimitIsInfeasible` |
| Remove spare Shapes; redeem surplus; simplify reserve | done | `test_planShrinkRedeemsAndRegrowthPaysMintFees` (re-growth pays 6 mint fees), invariant `noShapesHeldBetweenCalls` |
| Untracked NFT recovery that cannot release protected assets | done | `test_recoverUntrackedNFTs`, `test_cannotRecoverProtectedAssets`, reviewer tests |
| No pending-delivery accumulation; bounded loops | done | `test_historicalRefundsDoNotGrowUpkeepGas` (200 refunds: 847k → 836k) |
| Configurable markup with bounded, resumable repricing | done | `test_interruptedRepricingAtListingLimit` (100 listings, 17 steps, out-of-gas call and removals mid-run) |
| ApeBall-safe reimbursement: priority cap 0.05 gwei, max gas price, refund-safe gas | done | `test_priorityOverbidIsNotReimbursed`, isolated gas suite, e2e receipt audit, multi-call test |
| Incentive not farmable, not paid for no-ops | done | `test_drawCausedWorkEarnsAtMostEdgePaid`, `test_creatorTopUpWhileOpenKeepsCredit`, reviewer PnL tests (all negative) |
| Keeper profitability policy, waits in spikes, never exceeds reimbursable gas | done | `keeper/keeper.test.ts`, e2e spike step |
| Rebenchmark 8 operations; justify caps | done | `docs/GAS.md` |
| Dashboard economics: Funded / Projected sustainable / Projected loss, 10 figures, markup warning | done | `app/src/App.tsx` Economics panel |
| FWA pool metadata investigation and narrow ERC-1271 | done (server unverified) | client template reconstructed; viem `verifyMessage` on fork; epochs and revocation |
| Simulation: previous vs simplified | done | `docs/simulation-results.md`: redemption costs 0.02–0.11 ETH/30 days in re-mint fees under frequent plan switching, same uptime |

## Checks that could not be executed

- **FWA's pool-page server.** Whether `pools.fwa.fun` verifies ERC-1271 for a contract owner, and its freshness policy,
  cannot be tested without a mainnet pool and a live POST. The dashboard submits only on chain 1.
- **Real Chainlink VRF fulfillment.** Randomness is delivered through the real FWA VRF service by impersonating its
  coordinator.
- **Mainnet Etherscan verification.** `--verify` runs only on a real deployment.
- **External professional audit and formal verification.** None performed.
- **Long invariant campaigns.** 64 runs × 64 calls per suite.
- **Real wallet extension.** Every dashboard write (creator calls, pool creation, upkeep) is simulated, then sent
  with a gas limit of its estimate + 30% (`app/src/tx.ts`, after the rehearsal saw an exact `listCurated` estimate
  revert at inclusion). Checked with the dev connector on a fork (upkeep, a creator edit, pool creation: limit =
  estimate × 1.3, applied once; a failing claim reported by name with nothing sent), not with a wallet extension, which
  may replace the supplied limit.

## Remaining risks

See `docs/SECURITY.md`. In short: the rewrite had one AI review (round 7); the gate is approximate and leans on FWA
pricing and slippage refunds; FWA and Shapes admin powers; restricted-collection griefing (G-1); collections that can
move or freeze listed NFTs (F1, F2); FWA's VRF service refusing purchases while status shows 0 (F4); keepers wait above a
5 gwei basefee (~0.9% of blocks) and when gas has risen since prizes were listed; refund-only and curated-only
reconciliation is unpaid once credit is spent and relies on the creator, the keeper allowance or later prize draws; the
creator still pays the opening stock-up gas and the mint fees of prizes listed at close, and prize luck can put short
runs below zero; the restocking fee raises the draw price, most on mixes of small prizes; the FWA page template could change;
no professional audit.

## Your actions to deploy

These follow the rewrite being reviewed and re-verified (see "Rewrite status").

1. Review and merge [PR #1](https://github.com/ripe0x/shapes-pool-balancer/pull/1).
2. Decide whether to commission an external professional audit first. An independent AI audit (round 5,
   `audit/report.md`) found no outsider path to take funds; it is not a professional audit.
3. Optional: ask FWA to confirm ERC-1271 support for pool pages, or to allow a creator editor address.
4. Create or choose a deployer keystore (no keys on the command line) and fund it for about 5.3M gas.
5. Deploy and verify (the script re-checks the FWA implementation and code hash and aborts if FWA changed):

   ```bash
   PACKS_ADMIN=<address> KEEPER_ADMIN=<address> script/deploy.sh --rpc-url https://mainnet.gateway.tenderly.co --account <keystore-name> --broadcast --verify
   ```

   `script/deploy.sh` runs the asset-flow gate first and stops unless it passes (`docs/ASSET-FLOW-GATE.md`).

   `ETHERSCAN_API_KEY` must be set in the environment for `--verify`. The script writes `deployments/1.json`.
6. Start the keeper with a funded keeper key from your secret store (`docs/OPERATIONS.md`), `FROM_BLOCK` = deployment
   block, and `MAX_LOSS_WEI` (default 0.0002 ETH) for reconcile-only calls.
7. Build the dashboard with `VITE_CHAIN_ID=1`, `VITE_FACTORY=<factory>`, `VITE_FROM_BLOCK=<block>` and host it.
8. Create a first pool with a small deposit and a conservative markup, and watch one full draw-and-upkeep cycle.
