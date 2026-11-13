# Asset-flow gate

`script/deploy.sh` is the deploy entry point. Its first step runs the owner's gate
(`~/.agents/guidance/asset-flow-kit/asset_gate.py`) on this repository and stops unless it returns PASS. There is no
bypass flag. `script/Deploy.s.sol` refuses chain id 1 unless `script/deploy.sh` ran the gate first.

## What the gate does

1. Deletes the eight scorecards in `docs/receipts/flow/` and runs `test_command` from `asset-flow.json`
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
