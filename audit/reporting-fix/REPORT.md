# Asset-flow reporting correction

**E1 is corrected for current reports.** This is implementation verification of a reporting-only change, not the unfinished independent security audit. No production contract, asset ownership, reserve formula, payout limit, withdrawal permission, deployment path or economic outcome bound changed.

## Mechanism

- Unknown need now emits JSON null for need, above_need and bps, and prints "not determined". The helper no longer substitutes an entire held balance for unknown excess.
- Known Shape/Pack backing is fully encumbered. FWA obligations use its actual acquisition/delivery escrow, purchaser refund-credit and accrued protocol-fee totals, separately from uncollected owner proceeds. Booked creator profit and uncollected proceeds have their own allocation; fund already above the reserve has zero additional operating need.
- Above need is an accounting comparison, not withdrawal authority. The dashboard already reads withdrawableSurplus from the contract; no UI or withdrawal calculation changed.
- The existing shared gate reader supports nullable fields and omits unknown values from numeric metrics. An outcome requiring an unknown metric becomes INCOMPLETE, not zero/passing. Inconsistent null fields are INCOMPLETE. Older numeric files remain readable as historical evidence.

## Reproduction and tool provenance

The existing reader is ~/.agents/guidance/asset-flow-kit/asset_gate.py. Its compatible patch and before/after SHA256 values are in asset-gate-nullable.patch and reader-hashes.json. No alternate gate was added and no signature, bound or deploy check was relaxed. A fresh environment must verify/apply the recorded reader patch before running the nullable-reader checks; do not blindly patch a different version. The repo evidence hash includes the versioned patch, focused tests and deterministic fixture. The fixture clears its own source_hash field before being retained, avoiding a self-referential evidence hash.

Commands and retained logs:

- SOURCE_HASH=report-normalization-check forge test --match-path test/FlowReporting.t.sol -vv: exit0, **1 focused test passed**, including unknown/null, exact1.7ETH backing/zero excess, known-zero need/free capital, shortfall and normalization.
- python3 scripts/test-flow-reporting.py: exit0, **7 tests passed**, including known-bound failure, unknown-bound INCOMPLETE, inconsistent-null INCOMPLETE and legacy numeric compatibility. These use the actual emitted Solidity report and installed reader, no external service replacement or signing keys.
- CANDIDATE_RUN=1 python3 /Users/dd/.agents/guidance/asset-flow-kit/asset_gate.py . --require-review: **25 real-fork regimes regenerated**, every configured numeric outcome within its bounds and no ledger mismatches. Gate exit2 because the changed evidence has no fresh independent review record and revised outcomes remain unsigned. No SOURCE_HASH review seal or owner approval was manufactured. The configured command explicitly uses https://mainnet.gateway.tenderly.co, block26382349, Foundry1.8.1, isolate mode and nonzero gas/basefee asserted inside the executed path.

All25 final scorecards carry source hash24ebb94a1f05a5c9bc39814426eced47a1cd5e9ffd1b4acbce806062cbdfab33. Raw first-pass and final outputs are retained. An initial diff whitespace check flagged only context-marker spaces in the versioned patch; those bytes are required for applying it and were retained.

## Exact before/after

| Quiet-regime bucket | Held ETH | Old above_need ETH | Current stated need ETH | Current above_need ETH |
|---|---:|---:|---:|---:|
| Listed Shape/Pack backing |1.7|1.7|1.7|0|
| FWA pending/refund/protocol obligations |0.196824640644681196|0.196824640644681196|0.196824640644681196|0|

Across all25 regimes, reached economic facts, inflow totals, destination amounts, flows and ledger mismatches are **byte-for-byte equal as parsed JSON** to the prior frozen audit scorecards. Only bucket need/excess labels and source identity change. comparison.json records the check; corrected scorecards are preserved here. Historical reports remain unchanged and retain their original defect disclosure.

No additional capital is required by this correction. The20-Shape opening deposit remains0.2356ETH at basefee0.5gwei/mint fee0.001ETH; stocked target remains0.00368ETH. Existing483-test/120-TypeScript/keeper receipt evidence remains limited to its unchanged production inputs; this correction did not rerun those broad suites. src/, script/ and foundry.toml are unchanged, so the existing24449byte runtime measurement remains applicable.

## Things that don't make sense

None identified in the corrected reporting semantics. Unknown is now explicit, and accounting excess does not grant withdrawal rights. Whole-candidate independent security coverage and launch approval remain incomplete.
