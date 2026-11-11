# Schema-2 advisory gate attempt

Target: frozen repository revision `0f017843ec333f499809f751e19017be325448e3`, Ethereum mainnet fork block `26382349` via `https://mainnet.gateway.tenderly.co`. This is an informed continuation of the existing audit. No source, existing test, or other audit file was changed; no chain transaction was broadcast.

## Artifacts and method

- `build_manifest.py` builds `audit-gate.json` and `open-coverage.json`. It copies the exact inventory, Slither JSON, and selected previously captured proof/review files into `audit/gate/evidence/` because `audit_gate.py` requires every referenced artifact to resolve within the manifest directory. The manifest contains three detailed critical paths: the batch markup callback and hostile curated withdrawal as bounded violations, and the expired VRF/router coverage case as **unresolved** beyond its exact conditional observation. This is a partial manifest, not a completed source-wide mapping.
- The source inventory has **55** Balancer entrypoints, **75** external calls, and **159** mechanical path IDs. The manifest assesses **4** entrypoints and **4** calls. `open-coverage.json` explicitly lists **51** unmapped entrypoints, **71** unmapped calls, all **159** mechanical path IDs as lacking individual schema-2 acceptance, **45** untriaged High/Medium Slither alert IDs, and eight named consequential semantic gaps. Some selected mechanical paths overlap a bounded critical path, but none received the inventory's own path-by-path postcondition review.
- Slither JSON reports `success: true` and 326 detector records. The original command `slither . --json audit/slither.json` exited 255 after compilation, as the existing run record reports. Its stdout/stderr log was not retained. This manifest deliberately leaves `slither_run.log` absent; the run record is a narrative, not a substitute log. Re-running Slither solely to fabricate a historical log would be wrong. An actual new captured run would be a separate resource-consuming analysis and could rebuild the Foundry cache.
- The informed challenge reviewed the bounded callback and hostile-withdrawal claims, and a separate VRF challenge reviewed its conditional claim. Neither is a manifest-specific independent assessment of every postcondition and inventory path. The manifest leaves `independent_review.postcondition_review` empty rather than assigning acceptance on that reviewer's behalf. The supplied evidence files and copies remain editable in the shared workspace; hashes detect accidental mismatch, not protected provenance.

## Exact final commands and result

Run from `.`:

```sh
python3 audit/gate/build_manifest.py
python3 ~/.agents/skills/adversarial-audit/scripts/audit_gate.py audit/gate/audit-gate.json --inventory audit/source-inventory.json --slither-json audit/slither.json > audit/gate/gate.out 2>&1
```

Builder exit **0**. Gate exit **1**, with **53** `FAIL:` lines in the complete saved [gate.out](gate.out). The first failures are:

```text
FAIL: Slither run log: file and SHA-256 required
FAIL: path expired-vrf-coverage: unresolved outcome
FAIL: path expired-vrf-coverage: value_attribution family unresolved
FAIL: path expired-vrf-coverage: callback family unresolved
FAIL: entrypoint_review: must exactly cover compiler inventory
FAIL: external_call_review: must exactly cover compiler inventory
FAIL: triage must exactly cover all High/Medium Slither alerts
```

The output then lists each of the 45 untriaged High/Medium detector IDs and ends `FAIL: independent reviewer must assess every postcondition`. The gate did not report a source-hash, compiler-input, artifact-hash, or evidence-ID error after the referenced files were copied inside `audit/gate/`. A first local attempt that referenced `../` artifacts also failed the gate's manifest-directory restriction; those references were corrected before this final attempt. No test, fork call, or Slither run was repeated here.

## Feasibility and disposition

**Honest schema-2 completion is not feasible within this 45-minute continuation or by mapping generic reasons to the remaining IDs.** It requires site-specific review of the remaining compiler calls and paths, evidence that actually exercises or rules out each claimed adversarial variant, exact triage of all 45 High/Medium detector records, a captured Slither run log, and an independent reviewer who inspects the finished assertions and evidence. The factory has a separate 6-entrypoint/6-call/12-path inventory outside this Balancer manifest; a future Balancer gate PASS alone would not close factory coverage. The current gate is advisory and checks structure, not semantic truth or release readiness.

No PASS claim is made. The two recorded violations remain bounded to their tested states. The VRF recovery, refund, and asset-delta questions are unresolved. The remaining compiler and semantic paths stay open in `open-coverage.json`. This continuation took approximately six minutes from 02:35 to 02:41 UTC; no additional hour beyond lane A's original allocation was used.
