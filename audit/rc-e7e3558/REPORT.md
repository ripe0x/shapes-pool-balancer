# Whole-candidate release review: `e7e3558` plus test fix `b294de0`

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

| Lane | Inputs | Actual elapsed | Report |
| --- | --- | --- | --- |
| A, informed | Code, requirements, docs, prior cc35dce audit | 9.4 min, 32 tool calls (+ follow-up) | [lane-A.md](lane-A.md) |
| B, uninformed | Code, `OWNER-REQUIREMENTS.md`, `asset-flow.json` only; `docs/` and `audit/` removed from its copy | 11.0 min, 31 tool calls | [lane-B.md](lane-B.md) |
| C, comparison and execution | Builder session | this file | — |

Both lane reports state about 75 minutes per phase table; harness wall-clock shows 9.4 and 11.0 minutes. The harness
figures are used here. Lane B is uninformed, not provably blind: its checkout still had git history.

## Executed evidence (this candidate)

| Check | Command | Result |
| --- | --- | --- |
| Asset-flow regimes | `python3 ~/.agents/guidance/asset-flow-kit/asset_gate.py . --require-review` | 25/25 fresh, all 15 outcomes within bounds, 0 drift failures, 0 counter/holding mismatches. Exit 2 only for unsigned approval and (then) no review record. [log](logs/asset-gate-run.log), [scorecards](scorecards/) |
| Full Foundry campaign | `CANDIDATE_RUN=1 forge test --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 --isolate --threads 8 --gas-limit 100000000000` | 69 suites, **518 passed, 1 failed**, exit 1 on `e7e3558`. [summary](logs/full-forge-summary.log) |
| Failed test after fix | `CANDIDATE_RUN=1 forge test --match-path test/ReserveCapital.t.sol --gas-limit 100000000000` | 11/11 passed, exit 0. [log](logs/reserve-capital-after-fix.log) |
| TypeScript | `CANDIDATE_RUN=1 npm run typecheck`; `CANDIDATE_RUN=1 npx vitest run` | exit 0; 205 passed, 7 opt-in skipped |
| Sizes | `forge build --sizes` | PoolBalancer runtime 20,492 B (4,084 under EIP-170), initcode 21,585 B |
| Deployment simulation | `forge script script/Deploy.s.sol` on the existing chain-31337 fork, no broadcast | 8 transactions, 21,223,646 total gas limit, largest 5,912,115. [summary](logs/deploy-simulation.json) |
| Production-path rehearsal | PR #15, `ef32a48`, identical `src/` and `script/` bytes | 158 draws, 424 receipts reverified, both pools retired with exact cash/credit reconciliation (as recorded in the PR; local evidence directory not committed) |

### The one failure

`test_nineOutstandingDrawsAreReservedFromActualSequences` reverted with FWA `PurchaseNotAllowed()`. Trace:
`PoolInventory.admission()` returned 7 because word 0 selected slot 1, the pool's only curated listing, and one settled
draw won it. Refusing further paid draws is the R71/R72 curated-presence repair working as specified; the test was
written before that repair and encoded the old E1 behaviour. PR #15 records that the broad local runs on this source
ended with OS status 137, so the stale test was never reached. Fix `b294de0` delivers words that select a Shape slot; its
reserve (0.01768 ETH) and refund assertions are unchanged. Curated-loss refusal stays covered by
`test/CuratedAdmission.t.sol`. Lane A independently checked the diagnosis and diff (see lane-A.md, "Follow-up").

## Findings after comparison

| ID | Severity | Source | Finding | Disposition |
| --- | --- | --- | --- | --- |
| L-1 | Low | A | `keeper/keeper.ts:559` `health().ok` ignores per-pool `errors`; a status-only probe can read green while one pool's reads fail | Confirmed in code. Already documented in OPERATIONS.md. Monitoring must read the `errors` body field, especially with a restricted single-keeper canary. No code change |
| B-1 | Info | B | `createBalancer` is public from block one, so the accepted R20 hostile-curated-NFT exception is reachable by any creator | Existing accepted risk; canary plan already states there is no system-wide cap |
| B-2 | Info | B | A creator may claim protected credit below the reserve and starve its own pool | By design (R63); purchaser backing and refunds untouched |
| B-3 | Info | B | `activateKeeperPolicy` is public after the 2-day delay; funding uses one current snapshot | Matches R66/R67; creator can cancel or disable before activation |
| B-4 | Info | B | The signature enforces each outcome's gated number; O1/O8 prose describes more than the metric | Carried into the owner approval summary |
| B-5 | Rejected | B | `drift_groups` called vestigial | Wrong: the real verifier marks a config without `drift_groups` INCOMPLETE |

Comparison rule (A found, B missed, or the reverse) was applied: L-1 was confirmed by reading the code; B-3 was confirmed
against `src/PoolBalancer.sol:365` and `src/KeeperPolicyCalls.sol:73`; B-1/B-2 are documented accepted rules.

## Economic pass

Both lanes reconcile `quiet` to the wei (inflow 9.364669993865986350 ETH = 5 ETH deposit + player payments; creator
claimed 4.068446924, prize backing delivered 2.79, randomness 180 × 0.001287 = 0.23166, mint fees 258 × 0.001 = 0.258,
keepers 0.11607307015). Lane A checked conservation on 6 regimes, lane B on 3 by execution; all 25 scorecards show zero
mismatches. Outcome results are in the [release record](../../docs/RELEASE-RECORD.md).

## Not covered

Real-broadcast keeper inclusion/competition; live oracle delivery; R52 coalition economics model; browser-wallet
extension signing; FWA pool-page ERC-1271 acceptance; human review. No new attack contract was written in this round;
both lanes relied on existing adversarial suites, which all pass in the full campaign.

## Things that don't make sense

1. Lane reports overstate elapsed time about sevenfold. The depth is what was executed, listed above.
2. Main CI runs only `Fork.t.sol` and one FlowBreakdown test; a stale failing test sat on `main` through two merges.
3. The PR #15 rehearsal evidence directory is cited but not committed and was not found on this machine.
