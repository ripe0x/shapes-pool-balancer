# Asset-flow gate

`script/deploy.sh` is the deploy entry point. Its default production route runs the owner's gate
(`~/.agents/guidance/asset-flow-kit/asset_gate.py`) on this repository and stops unless it returns PASS. There is no
bypass flag for production. `script/Deploy.s.sol` refuses chain id 1 unless `script/deploy.sh` ran the gate first.

## Isolated local rehearsal route (owner-authorized, 2026-11-18)

The owner explicitly authorized separating this local diagnostic from production release approval. The same wrapper accepts `--local-rehearsal-plan <absolute-plan-file> --approved-plan-hash <exact-hash>` before its Forge arguments. It calls the read-only `scripts/local-rehearsal-gate.ts`, which accepts only the prepared `127.0.0.1:18556` Anvil fork on chain 31337, its recorded listener PID/process command/fork hash, named synthetic actors, exact decoded deployment and fixed budgets. Changed materials, RPCs, chain IDs, signers, destinations, funding or Forge flags stop it. It neither sets nor inherits the production `ASSET_GATE_PASSED` marker into Forge.

The local driver requires the owner's separate approval of the exact frozen batch hash before funding or broadcasting. A successful read-only preflight is not that approval. It retains transaction simulation, nonce/receipt/custody readbacks, the shared 6 test ETH deposit/1 test ETH gas ceilings and the other [batch caps](RELEASE-REHEARSAL.md). The route submits the same `Deploy.s.sol`; it is not a second deployment implementation. No private key or production wallet is involved.

Owner outcome signatures, completed whole-candidate review and fresh numerical release evidence remain mandatory for the default production route. The local preflight is not release acceptance and writes no review seal or signature. Changing the wrapper changes the full production source/evidence fingerprint. Old scorecards are not restamped: the local plan identifies archived contract inputs separately from the local wrapper overlay. The historical source-bound results below retain their original revision and limits.

The prepared fork retains block 26,438,875 from its original preparation. Its successful future run would be a diagnostic of those pinned dependencies, not proof of current mainnet gas, oracle availability or real browser-wallet signing.

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
| `asset_gate.py --no-run` | no | the production wrapper never passes it; read-only reporting validation is separate |
| Someone else deploying this public code, and any creator calling `createBalancer` on a deployed factory | yes | outside this repository; the gate covers the system deployment, not each pool |

CI (`.github/workflows/ci.yml`) and Git hooks do not run the gate. The source hash covers `src`, `script`,
`foundry.toml`, `.gitmodules` and the scenario test files; it does not cover the contents of the `lib/` submodules
(Draw Packs is deployed from there) or the kit itself.


## Historical policy candidate (2026-11-17)

The work-based payment mechanism supersedes O1's flat-per-call wording. O3 now holds one selected maximum per outstanding draw, including split settlement. Their previous owner signature remains in Git history and is not copied onto changed outcomes. The current manifest is intentionally unsigned; the deployment gate must return INCOMPLETE until the owner signs the new outcomes and the exact reviewed candidate has valid evidence. This is a mainnet release blocker, not permission to bypass the gate for production. Local production-path rehearsals remain isolated on chain 31337 with test ETH.

> The selected-maximum-per-draw wording above is historical. Current O3 uses actual unreconciled draws times their current immutable operation-sensitive reconciliation budget while paid upkeep is enabled; see [RESERVES.md](RESERVES.md). No historical owner signature carries into the revised payload.

## Current-work reserve candidate

The current 25 regimes include exact-minimum twenty-Shape operation and a minimally funded mixed-board large win. O5 now records open admission in the explicit creator-response regimes; the old zero-missing-days guarantee failed at 11/14 days and is explicitly superseded by the owner's partial-depletion request. Missing inventory remains in the measurement records. The final manifest stays unsigned: a matching source review and successful measurements do not grant owner approval or deployment authority.

Foundry 1.8.1 discovery/list-only output can leave ABI-only artifacts for changed tests. A zero-test result is never accepted as verification; check a positive executed count. Preserve the failed discovery output and regenerate the affected current-source artifact without clearing caches.

## Bucket obligations and unknown excess

A bucket's held balance is separate from its need and from creator withdrawal authority. Known Shape/Pack backing, booked creator profit, uncollected owner proceeds and FWA escrow/refund/protocol-fee obligations have explicit needs. The FWA obligation amount comes from its actual acquisition/delivery escrow, refund-credit and accrued-fee counters. Fund above the operating reserve has a known zero additional need.

If need is unknown, the helper prints "not determined" and emits JSON null for need, above_need and its bps share. An outcome requiring that unknown metric is INCOMPLETE, never silently zero or passing. Existing numeric report files remain readable as historical data; their labels are not retroactively corrected. Above need is an accounting comparison, not permission to withdraw; the dashboard's withdrawable amount remains the contract's withdrawableSurplus calculation.

The existing shared reader at ~/.agents/guidance/asset-flow-kit/asset_gate.py has nullable support. Its exact compatible patch and before/after digests are versioned in audit/reporting-fix/asset-gate-nullable.patch and reader-hashes.json. A fresh audit environment should verify/install that tool update against the recorded prior version rather than blindly replacing a different local reader. No alternate gate or deployment bypass was introduced. Focused checks: forge test --match-path test/FlowReporting.t.sol, then python3 scripts/test-flow-reporting.py. Neither creates signing keys or supplies an owner signature.


## Concurrent audit remediation

The current [remediation](AUDIT-REMEDIATION.md) retains approximate current-board allocation and concurrent requests under R55–R58. O9 now measures both error directions, but its historical 0.001 ETH fixed-regime bound has actual counterexamples outside that seed; no new universal number or owner signature is inferred. O11 uses the request-board surcharge component of real owner proceeds, not the selected prize's fee.

A complete final Foundry run may execute and write the same 25 current-source regimes as part of its broader test set. The authorized `--no-run` command can validate those already fresh records without paying to execute them twice; it still checks source/evidence hashes, outcomes and approval and is not used by `script/deploy.sh` to bypass production gating. Final results, raw failures and exact revision/source hashes must be recorded. Passing numeric checks remains distinct from owner numerical approval, a current independent review and deployment authority. No gate implementation or signer configuration changes are made by this documentation update.


Final scalar candidate source `ca02fb070a2a839cccc9fced15b3116613f6d7727d4e50133693dd63a4c92eda` executed all 25 records inside its complete 501-test Foundry pass. `--no-run --require-review` returned exit 2 with **all numerical checks passing**, and only two incomplete conditions: missing/mismatched owner approval hash and no fresh whole-candidate audit seal. The fixed in-flight O9 absolute error was 0.000145285333333628 ETH per 180 draws, while broader adversarial cases still exceeded 0.001 ETH; do not convert that named pass into a universal limit. Corrected O11 named play shortfall was 0. The focused final-source review is bounded and is not represented as a whole-candidate audit seal. Exact evidence is in [verification.json](../audit/remediation-focused/verification.json).
