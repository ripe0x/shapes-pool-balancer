# Asset-flow gate

`script/deploy.sh` is the deploy entry point. Its first step runs the owner's gate
(`~/.agents/guidance/asset-flow-kit/asset_gate.py`) on this repository and stops unless it returns PASS. There is no
bypass flag. `script/Deploy.s.sol` refuses chain id 1 unless `script/deploy.sh` ran the gate first.

## What the gate does

1. Deletes the configured scorecards (25 regimes for the reserve candidate) in `docs/receipts/flow/` and runs `test_command` from `asset-flow.json`
   (`test/scenario/FlowBreakdown.t.sol`: real FWA, Shapes, Draw Packs and randomness service on the pinned fork, gas
   price asserted inside a transaction).
2. Checks every regime wrote a fresh scorecard for the current sources, that inflows equal destinations to the wei,
   and that the Balancer's prize counters match the backing the FWA pool really holds.
3. Checks each outcome in `asset-flow.json` in every regime it names, and drift between the regimes that share inputs
   (`quiet`, `limits_at_max`, `max_then_idle`).
4. Verifies the owner's SSH signature over the outcomes. Without it the result is INCOMPLETE.

Run it by hand: `python3 ~/.agents/guidance/asset-flow-kit/asset_gate.py .` (exit 0 PASS, 1 FAIL, 2 INCOMPLETE).
The system map is `docs/SYSTEM-MAP.md`. The outcomes in `asset-flow.json` are drafts until the owner signs them; only
the owner adds the `approval` block.

## Ways to deploy without the gate

| Way | Reaches mainnet? | What stops or shows it |
| --- | --- | --- |
| `forge script script/Deploy.s.sol` directly on chain id 31337 (`keeper/e2e.ts`, `keeper/rehearsal.ts`, the README local demo) | no | nothing; local rehearsal is not gated |
| `ASSET_GATE_PASSED=yes forge script script/Deploy.s.sol ...` set by hand | yes | nothing; the variable is a reminder, not a lock |
| `forge create`, `cast send --create`, another script, or any tool sending the bytecode in `out/` | yes | nothing |
| Editing `script/deploy.sh` or `script/Deploy.s.sol`, or deploying from a commit before the gate | yes | visible in `git diff` / the deployed commit only |
| A different signers file (`ASSET_FLOW_SIGNERS`), or replacing the kit files under `~/.agents/guidance/asset-flow-kit/` | yes | the gate prints `NON-DEFAULT SIGNERS FILE`; replacing kit files shows nowhere |
| `asset_gate.py --no-run` | no | it is not wired anywhere; `script/deploy.sh` never passes it |
| Someone else deploying this public code, and any creator calling `createBalancer` on a deployed factory | yes | outside this repository; the gate covers the system deployment, not each pool |

CI (`.github/workflows/ci.yml`) and Git hooks do not run the gate. The source hash covers `src`, `script`,
`foundry.toml`, `.gitmodules` and the scenario test files; it does not cover the contents of the `lib/` submodules
(Draw Packs is deployed from there) or the kit itself.


## Policy candidate (2026-11-17)

The work-based payment mechanism supersedes O1's flat-per-call wording. O3 now holds one selected maximum per outstanding draw, including split settlement. Their previous owner signature remains in Git history and is not copied onto changed outcomes. The current manifest is intentionally unsigned; the deployment gate must return INCOMPLETE until the owner signs the new outcomes and the exact reviewed candidate has valid evidence. This is a mainnet release blocker, not permission to bypass the gate for production. Local production-path rehearsals remain isolated on chain 31337 with test ETH.

## Current-work reserve candidate

The current 25 regimes include exact-minimum twenty-Shape operation and a minimally funded mixed-board large win. O5 now records open admission in the explicit creator-response regimes; the old zero-missing-days guarantee failed at 11/14 days and is explicitly superseded by the owner's partial-depletion request. Missing inventory remains in the measurement records. The final manifest stays unsigned: a matching source review and successful measurements do not grant owner approval or deployment authority.

Foundry 1.8.1 discovery/list-only output can leave ABI-only artifacts for changed tests. A zero-test result is never accepted as verification; check a positive executed count. Preserve the failed discovery output and regenerate the affected current-source artifact without clearing caches.

## Bucket obligations and unknown excess

A bucket's held balance is separate from its need and from creator withdrawal authority. Known Shape/Pack backing, booked creator profit, uncollected owner proceeds and FWA escrow/refund/protocol-fee obligations have explicit needs. The FWA obligation amount comes from its actual acquisition/delivery escrow, refund-credit and accrued-fee counters. Fund above the operating reserve has a known zero additional need.

If need is unknown, the helper prints "not determined" and emits JSON null for need, above_need and its bps share. An outcome requiring that unknown metric is INCOMPLETE, never silently zero or passing. Existing numeric report files remain readable as historical data; their labels are not retroactively corrected. Above need is an accounting comparison, not permission to withdraw; the dashboard's withdrawable amount remains the contract's withdrawableSurplus calculation.

The existing shared reader at ~/.agents/guidance/asset-flow-kit/asset_gate.py has nullable support. Its exact compatible patch and before/after digests are versioned in audit/reporting-fix/asset-gate-nullable.patch and reader-hashes.json. A fresh audit environment should verify/install that tool update against the recorded prior version rather than blindly replacing a different local reader. No alternate gate or deployment bypass was introduced. Focused checks: forge test --match-path test/FlowReporting.t.sol, then python3 scripts/test-flow-reporting.py. Neither creates signing keys or supplies an owner signature.
