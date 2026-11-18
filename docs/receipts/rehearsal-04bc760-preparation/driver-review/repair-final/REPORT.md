# Focused rehearsal-driver repair check

This checks repairs to the previously reviewed local rehearsal driver and plan. It is not a whole-candidate audit, contract vulnerability investigation, owner authorization, signature, review seal or execution pass. No filtered audit was retried. No production contract investigation, RPC request, valid-plan execution, funding, broadcast, node mutation, source edit or commit was performed.

Reviewed HEAD: `06d2e20987068dd653dc3b9e8d62a6ca92f482b4`, with protected runtime/evidence inputs required to match archive candidate `04bc760d506fd29329a3a819c7f2e4a1480377dd` and fingerprint `ca02fb070a2a839cccc9fced15b3116613f6d7727d4e50133693dd63a4c92eda`.

Final computed and saved plan hash: `da615d80ddaf1d71cfb4e2c338abe895954457eef71c5bd1fa2c03b72bd15b6f`.

| File | SHA-256 |
| --- | --- |
| `scripts/run-local-rehearsal.ts` | `140551152aeeae4a5fb5d3be5ebadc20a966f2c871acaa86abb219095c2d9067` |
| `scripts/prepare-local-rehearsal.ts` | `7b627779672569a12423c33fd94122581ac422275303363bfab1ec2e3974824e` |
| `docs/RELEASE-REHEARSAL.md` | `5b197f790716d00d2bde9efef5b2ae8f2ceb2806c7900e0321519a54104c819b` |

## Repair disposition

No further concrete must-fix issue was identified within this repair scope.

- **Missing archive evidence repaired.** Driver lines 182–198 include configured source/evidence paths, verify all exact evidence files exist in the committed manifest, build the private index and compare its fingerprint. The pure stage check passed, including `scripts/test-flow-reporting.py`. No signature or review gate was run or bypassed by this check.
- **Target/value/creation readbacks repaired.** Lines 101–119 compare actual target and native value, check CREATE receipt address versus prediction, and require a null outer creation address for CALL/CREATE2. Lines 214 and 219 bind dry-run type/destination/value and receipt expectations to the approved prepared action. Negative pure assertions reject wrong target/value/CREATE address.
- **Runtime and Demo material bound.** The plan hashes the preparation helper and material JSON. Runtime material covers the eight system creations; its names, predicted addresses and sizes align with deployment actions. The preparer resolves compiler links/declared immutable mappings, and the driver compares resulting exact code hashes after creation. Demo creation now uses prepared, plan-bound `demo-nft.json` bytes rather than reading mutable warm output during execution; both Demo creations have runtime checks. This review did not independently compile or execute these creations, and therefore does not establish a live runtime match.
- **Descendant protection repaired.** Lines 45–55 permit only a descendant HEAD, compare protected source/evidence/keeper/shared/dependency inputs with the archive revision, reject untracked protected inputs, and recompute the exact candidate fingerprint. Pure self-check and stage checks accepted the current evidence-only descendant. The plan separately binds current helpers, document, material files and unsigned gate configuration.
- **Production wrapper and gates retained.** `script/deploy.sh` is byte-unchanged against archive revision. Driver lines 357–364 still place `asset_gate.py --no-run --require-review` before any actor funding; actual deployment still uses the unchanged wrapper and its full gate. The wrong-hash path rejects before `nodeCheck`. No valid-hash branch or gate acceptance was exercised. Genuine owner bounded authorization, owner SSH signature and required current whole-review evidence remain necessary.
- **Closeout readbacks strengthened.** Driver line 333 reads each actual collection/token and checks creator ownership after withdrawal. Lines 337–341 require zero Balancer balance, owner proceeds, tracked/active inventory and buyer refund credit, plus issued equals reconciled, zero unsettled draws, and disabled purchases; sequence readbacks enter the journal. These are source assertions, not executed results.
- **Execution limitations stated accurately.** Document step 1 states the parent imports the eight-action Forge `--slow` child receipts after that child returns, with no parent semantic checkpoint between deployment transactions. It no longer promises parent checks between them. Keeper scope is controlled production-class ticks and persisted health, not CLI/HTTP service execution. UI writes and real-wallet evidence remain explicitly separate and unfinished. Policy step 7 now says contract round trip. Synthetic NFT contributions, their cap/notional values and absence of a real net-profit claim are explicit.

## Pure checks and remaining limits

Final `--self-check`, default-plan and `--check-stage` commands exited 0. Deliberately wrong `--approved-plan-hash invalid-review-only-hash` exited 1 at the plan comparison, before any RPC request. The saved plan matches the final computed hash. Raw outputs and `checks.json` are preserved beside this report.

These checks establish source/data consistency and pure guard behavior only. They do not establish live node ownership/state, signature validity, review-gate acceptance, successful deployment, actual code hashes, gas-budget sufficiency for the whole lifecycle, realized fees/refunds, custody outcomes, external randomness or browser-wallet behavior. The unchanged full wrapper and all applicable approval controls remain authoritative.

Things that don't make sense: none beyond the explicitly stated eight-action child-batch, controlled-Keeper, synthetic-NFT and unexecuted UI/runtime limitations.
