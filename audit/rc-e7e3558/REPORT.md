# Whole-candidate release review: `e7e3558` plus test fix `b294de0`

**This consolidated report is authoritative.** Where `lane-A.md` or `lane-B.md` differ from it, this report wins; each
lane file carries a correction notice at its top. Corrections made on 2026-11-19 after a detailed release review are
listed under [Corrections](#corrections).

**Result: no Critical, High or Medium finding. No finding blocks a small capped mainnet launch.** This is a timeboxed
AI-agent review at the release-candidate tier. It is not a human audit, not exhaustive and not proof of safety.

| Item | Value |
| --- | --- |
| Contract/deployment source | `e7e3558f4d0de3e30d24f92f3b0e2dbdde664028` (`src/`, `script/`, `foundry.toml`, `.gitmodules`) |
| Reviewed tree | `b294de0` = `e7e3558` plus one test-only correction in `test/ReserveCapital.t.sol` |
| Gate source hash | `341db26a17447a8e789a33726da6cbb4bc18d25df8615a67869492df1e984deb` (recorded in `SOURCE_HASH`) |
| Standard | `~/.agents/guidance/adversarial-security-audit-standard.md`, launch-audit steps A–C, plus holistic verification |
| Toolchain | Foundry 1.8.1, fork block 26,382,349 via `https://mainnet.gateway.tenderly.co` |

## Lanes

| Lane | Inputs | Actual elapsed (harness wall clock) | Report |
| --- | --- | --- | --- |
| A, informed | Code, requirements, docs, prior cc35dce audit | 9.4 min, 32 tool calls; follow-up 4.2 min, 11 tool calls | [lane-A.md](lane-A.md) |
| B, uninformed | Code, `OWNER-REQUIREMENTS.md`, `asset-flow.json` only; `docs/` and `audit/` removed from its copy | 11.0 min, 31 tool calls | [lane-B.md](lane-B.md) |
| C, comparison and execution | Builder session | — | this file |

Both lane reports state about 75 minutes in their phase tables. Those figures are wrong and are not evidence of depth;
the harness times above are. Lane B is uninformed, not provably blind: its checkout still had git history.

## Executed evidence (this candidate)

| Check | Command | Result |
| --- | --- | --- |
| Asset-flow regimes | `python3 ~/.agents/guidance/asset-flow-kit/asset_gate.py . --require-review` | 25/25 fresh, all 15 outcomes within bounds, 0 drift failures, 0 counter/holding mismatches. Exit 2 for the unsigned approval and, at that time, no review record. [log](logs/asset-gate-run.log), [scorecards](scorecards/) |
| Full Foundry campaign | `SOURCE_HASH=<hash> CANDIDATE_RUN=1 forge test --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 --isolate --threads 8 --gas-limit 100000000000` on `e7e3558` | 69 suites, **518 passed, 1 failed, 0 skipped (519)**, 6 min 44 s, exit 1. [complete log](logs/full-forge.log) with totals, failure block and exit status |
| Failed suite after fix | `CANDIDATE_RUN=1 forge test --match-path test/ReserveCapital.t.sol --gas-limit 100000000000` on `b294de0` | 11/11 passed, exit 0. [log](logs/reserve-capital-after-fix.log). The other 68 suites were not rerun; their inputs did not change |
| TypeScript | `CANDIDATE_RUN=1 npm run typecheck`; `CANDIDATE_RUN=1 npx vitest run` | exit 0; 205 passed, 7 opt-in skipped |
| Sizes | `forge build --sizes` | PoolBalancer runtime 20,492 B (4,084 under EIP-170), initcode 21,585 B |
| Deployment simulation | `forge script script/Deploy.s.sol` on the existing chain-31337 fork, no broadcast | 8 transactions, 21,223,646 total gas limit, largest 5,912,115. [summary](logs/deploy-simulation.json) |
| Production-path rehearsal | PR #15 at `ef32a48`, identical `src/` and `script/` bytes | **Reported, not re-verified here.** PR #15 states 158 draws, 424 receipts reverified and both pools retired with exact cash/credit reconciliation, with evidence at `docs/receipts/current-rehearsal/20261119142931547-ef32a48/` in the workspace that ran it. That directory was not committed and is not present on this machine; no RPC replay was performed |

### The one failure

`test_nineOutstandingDrawsAreReservedFromActualSequences` reverted with FWA `PurchaseNotAllowed()`. Trace:
`PoolInventory.admission()` returned 7 because word 0 selected slot 1, the pool's only curated listing, and one settled
draw won it. Refusing further paid draws is the R71/R72 curated-presence repair working as specified; the test was
written before that repair. Fix `b294de0` delivers words that select a Shape slot, so the reserve (0.01768 ETH) and
refund assertions are reached and unchanged. Curated-loss refusal stays covered by `test/CuratedAdmission.t.sol`. Lane A
independently confirmed the diagnosis and that no sibling test encodes the same assumption.

## Findings after comparison

| ID | Severity | Source | Finding | Disposition |
| --- | --- | --- | --- | --- |
| L-1 | Low | A | `keeper/keeper.ts` `health().ok` ignores per-pool `errors`; a status-only probe can read green while one pool's reads fail | Confirmed. Documented in OPERATIONS.md. Monitoring must read the `errors` field. No code change |
| B-1 | Info | B | `createBalancer` is public, so the accepted R20 hostile-curated-NFT exception is reachable by any creator | Accepted, disclosed design; the canary limits are owner pilot limits, not a global cap |
| B-2 | **Withdrawn** | B | Claimed that withdrawing protected credit reduces operating cash and starves the pool | **Incorrect.** See below |
| B-3 | Info | B | `activateKeeperPolicy` is public after the 2-day delay; funding uses one current snapshot | Matches R66/R67; the creator can cancel or disable before activation |
| B-4 | **Corrected** | B | Claimed the signature covers only each outcome's gated number | **Incorrect.** See below |
| B-5 | Rejected | B | `drift_groups` called vestigial | Wrong: the verifier marks a config without `drift_groups` INCOMPLETE |

**B-2 correction.** Operating cash is `address(this).balance - creatorCredit` (`src/PoolBalancer.sol:366, 376, 391, 695`).
A claim up to `creatorCredit` reduces balance and credit by the same amount (`claimSurplus`, lines 481–488), so operating
cash is unchanged. Paid upkeep (`KeeperPolicyCalls.pay(..., balance - creatorCredit)`), policy activation and opening all
already exclude credit. Choosing a higher creator percentage leaves less of each newly collected payment for operations;
claiming credit that is already protected creates no additional shortfall. `test/ProtectedRevenueAtomic.t.sol:164` claims
all credit while real 1 ETH and 100 ETH prizes are missing and asserts operating cash is exactly unchanged. Claiming earnings during
expensive recovery is intended (R63).

**B-4 correction.** The owner's signature covers `outcomes_sha256`, the SHA-256 of the canonical JSON of every approved
key (`outcomes` with their complete text, `explained`, `required_regimes`, `source_paths`, `evidence_paths`,
`drift_threshold_bps`, `drift_groups`, `test_command`, `scorecard_dir`, `review_dir`), with the `approval` field excluded.
It approves the complete outcome text and gate configuration. Separately, the automated gate checks each outcome's
configured metric in its named regimes. Behaviour described in the text beyond that metric (for example O1's 0.311 ETH
and 0.622 ETH limits, or O8's claims during depletion) is supported by focused tests and code review, not by the gate.

Comparison rule (A found, B missed, or the reverse) was applied: L-1 was confirmed by reading the code, and B-3 was
confirmed against `src/PoolBalancer.sol:365` and `src/KeeperPolicyCalls.sol:73`.

## Economic pass

`quiet` reconciles to the wei: inflow 9.364669993865986350 ETH (5 ETH deposit plus player payments) equals the sum of
these destinations:

| Destination | ETH |
| --- | ---: |
| claimed by the creator | 4.068446924008082280 |
| prize backing delivered to winners | 2.790000000000000000 |
| Shape and Pack backing still listed on FWA | 1.700000000000000000 |
| Shapes mint fees (258 × 0.001) | 0.258000000000000000 |
| randomness fees (180 × 0.001287) | 0.231660000000000000 |
| held by FWA: pending draws, refund credit, FWA edge | 0.196809999707904070 |
| paid to keepers | 0.116073070150000000 |
| creator reserve increase | 0.003680000000000000 |
| **Total** | **9.364669993865986350** |

Lane A's displayed list omitted the 1.7 ETH of listed backing and the 0.196809999707904070 ETH held at FWA; its stated
total was right because it came from the scorecard. Lane A checked conservation on 6 regimes and lane B executed 3; all
25 scorecards show zero mismatches.

Execution scope: every fork scenario delivers randomness by impersonating the real Chainlink VRF coordinator with
selected words (an owner-approved exception). Live oracle delivery was not tested.

## Not covered

Real-broadcast keeper inclusion and competition; live oracle delivery; R52 coalition economics model; browser-wallet
extension signing; FWA pool-page ERC-1271 acceptance; human review. No new attack contract was written in this round;
both lanes relied on existing adversarial suites, which all pass in the full campaign.

## Corrections

1. B-2 withdrawn and B-4 corrected (above).
2. Lane A's reconciliation listing completed (above); its "no supplied randomness" statement corrected (above).
3. `logs/full-forge-summary.log` held only five suite headings; replaced by the complete original campaign log
   `logs/full-forge.log` (870 lines, retained from the run).
4. PR #15 rehearsal evidence relabelled as reported, not re-verified (above).

## Things that don't make sense

1. Lane reports overstated elapsed time about sevenfold.
2. Main CI runs only `Fork.t.sol` and one FlowBreakdown test; a stale failing test sat on `main` through two merges.
3. The PR #15 rehearsal directory is cited as evidence but was never committed.
