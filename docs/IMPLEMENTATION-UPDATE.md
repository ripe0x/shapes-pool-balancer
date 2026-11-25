# Factory pause and asset recovery follow-up

The new factory starts with public creation paused. Its policy admin may create a canary while paused; only that
admin can pause or resume public creation. Existing pools keep operating and exiting while creation is paused.
The already deployed factory is immutable and lacks this control: using the creation pause requires deployment of
a replacement factory, followed by dashboard/keeper discovery configuration that retains the old factories. Merely
switching the existing factory's implementation cannot add factory methods.

The replacement deployment postflight and canonical verifier require creation to remain paused. No script opens it
automatically. Public creation should be resumed only after the approved owner canary and release checks. The app
reads configured-factory bytecode to distinguish old factories without a getter from failed RPC reads; it refreshes
creation availability and rechecks before every approval and creation. Policy-admin canary access is explicit.

ERC20 recovery sends the requested raw token amount only to the current creator. It has a creator-only interface,
reentrancy protection and no selectable arbitrary call or recipient. The app exposes the token address and raw-unit
amount only on Balancers whose per-pool inventoryBatchVersion is at least 2. Batch-only version-1 pools continue
using batches; older pools retain single-item paths. ERC20 rescue cannot be added to old immutable Balancers.

## Prior implementation-only path (still usable without a factory pause)


This path reuses the existing factory and dependencies. Existing clones never change.
No broadcast has been made or authorized by this document.

1. Freeze and review the candidate, pass the existing asset-flow/release gate, and rehearse this same path on the owned isolated fork.
2. Read the existing factory, its original deployment block and expected implementation from the canonical deployment record. Run deployment-preflight.ts with --existing-factory, --expected-implementation and --factory-snapshot-out to save its live configuration at the pinned block.
3. Set values IMPLEMENTATION_ONLY=true, REUSE_DEPENDENCIES=true, EXISTING_FACTORY and EXPECTED_IMPLEMENTATION. Use script/deploy.sh with the existing keystore and --slow. Review its dry-run manifest and hash: only linked libraries whose exact code is absent and PoolBalancer may be created. Obtain immediate decoded confirmation before each mainnet broadcast.
4. Verify the deployment with scripts/verify-deployment.ts and the existing dry-run/hash/broadcast arguments, plus --existing-factory, --factory-deployment-block (the ORIGINAL block), --factory-snapshot and a separate --out file. This requires the factory pointer/configuration to remain unchanged. Preserve deployments/1.json and all old receipts.
5. Separately review NEW_IMPLEMENTATION and the exact setImplementation transaction. Run the SAME gated script/deploy.sh with --sig "switchImplementation()" only after immediate decoded confirmation. The script checks EXPECTED_IMPLEMENTATION, locked implementation/dependency wiring and unchanged factory configuration.
6. Verify that transaction using verify-deployment.ts --update-tx, --verified-implementation, --verified-implementation-sha256, --rpc-url https://mainnet.gateway.tenderly.co and a separate --out. It checks canonical success, zero value, the policy-admin sender, exact setter calldata and unchanged configuration apart from the pointer. Retain the original factory deployment block for discovery.
7. Refresh creation previews and predicted-address NFT approvals; old approvals do not apply to new predicted addresses. Exercise an explicitly budgeted owner canary. Permissionless creation is already live immediately after switching; only the canary spending is capped. Reverting the pointer affects future creations only.

Deployment records written during simulation are not evidence of broadcast. Release readiness still requires real UI exercise, independent review and the existing economic/rehearsal evidence. The subsequent owner-approved ERC20 recovery rule is stated above.

Things that don't make sense: the old deployed factory has no creation pause and cannot acquire one through an implementation switch.


## Previous implementation evidence (50e1d1f, 2026-11-25)

Scope: source changes based on `3217bb36fccc67fa4a26244e4223984d3e765320`, branch
`codex/batch-inventory-closeout`. This record belongs to its containing implementation commit. No deploy, pointer
update, production publication, canary or asset migration was performed.

| Check | Exit/result | Limits |
| --- | --- | --- |
| `forge build --sizes` (first candidate) | 1: Solidity compiled, PoolBalancer 24,750 bytes exceeded EIP-170 by 174 | Preserved failed candidate result |
| `forge build src/PoolBalancer.sol --sizes` after ENS extraction | 0: PoolBalancer 24,258 bytes, 318-byte margin | Fixed library addresses must be rebound in release artifacts |
| `forge build script/Deploy.s.sol --sizes` | 0 | Compilation, not deployment rehearsal |
| `npm run abi` and `npm run typecheck` | 0 | Initial typecheck before ABI regeneration failed on missing new function names; corrected by regenerating ABI |
| Focused `forge test --match-path test/InventoryBatches.t.sol -vv` | 0: 9 tests passed | Unrelated test roots and script compilation explicitly excluded with `--skip`; real mainnet counterparties at block 26,382,349 via Tenderly |
| Focused new `test_reverseNameExtractionPreservesBalancerIdentity` | 0: 1 test passed | Added after size repair; real reverse registrar, set/clear and Balancer event identity |
| Focused Vitest inventory, deployment manifests, transaction intent, guard and inherited transaction checks | 0: 34 passed, 5 skipped | Eight inherited `app/src/tx.test.ts` cases supply successful RPC stubs and were inadvertently included. Their results are excluded from real-integration/no-mock evidence. No new successful-service mocks were added |
| App ledger repair: `npm run typecheck` and focused `vitest run app/src/inventory.test.ts app/src/ledger.test.ts` | 0: typecheck; 13 pure tests passed | Completed retries remain accounted at their absolute listed value while hidden from recovery |
| Independent static review and repair review | Operational stale-activation finding repaired; affected activation, ENS and ledger repairs reviewed | Bounded source review, not a whole-candidate security audit |
| Browser preview `http://127.0.0.1:5209/` | Actual retired mainnet pool loaded; NFT/Overview navigation and nonempty status observed | Disconnected viewer only: creator selection, wallet signing and full exit remain unexercised |

### Asset-flow scorecard (focused evidence only)

| Flow | Observed/asserted outcome | Missing evidence |
| --- | --- | --- |
| Curated withdrawal | Two exact NFTs delivered to selected recipient; 20-item maximum also passes; curated ETH movement is 0 wei | Live transaction/wallet canary |
| Curated repricing | Two real FWA listing prices become exactly 0.4 and 0.6 ETH, without markup | Batch gas benchmark |
| Failing collection | Entire failed batch rolls back custody, tracking and inventory version; unrelated single withdrawal works | Full recovery UI interaction |
| Outstanding draw | One real pending request blocks curated withdrawal/repricing; existing owner retains custody | Current-block and release-regime campaigns |
| Refunded recovery | Existing purchaser-refund prerequisite reused; active listings rejected | Successful batch recovery not executed: current harness would fabricate randomness to reach it |
| Wind-down | Source queues eligible recovery, NFT withdrawal, Shape redemption, FWA proceeds collection, ETH withdrawal and final holdings reads | Complete signed production-path rehearsal and economic regime breakdown |

Runtime code was reduced by moving the unchanged ENS reverse-record operation into the permanently linked PoolPage
library. Creator authorization and reentrancy protection remain in PoolBalancer; the registrar and logs still see the
Balancer. This changes PoolPage's code/address, so release must deploy/reuse the exact reviewed library artifact.

The setter verifier checks the verified deployment's chain, canonical receipt, exact admin/calldata/value, old/new
ImplementationChanged event, protected settings at the receipt block, and activation at a separately pinned current
block/hash. The factory has no compare-and-swap setter: the expected-old guard is a preflight/simulation check, and
must be refreshed immediately before broadcast.

Things that don't make sense: signed creator UI flows, successful refunded recovery, full economic regimes and the
production deployment/switch rehearsal remain evidence gaps. This implementation is not release-ready evidence.


## Follow-up evidence: ERC20 rescue and factory pause

Base revision `50e1d1f`, same feature branch. No external transaction, deployment, canary or migration was performed.
The previous evidence above is historical; the following checks cover this follow-up's changed inputs.

| Check | Result | Scope/limitations |
| --- | --- | --- |
| `forge build src/PoolBalancer.sol --sizes` | Exit 0; runtime 24,453 bytes, 123-byte EIP-170 margin | Exact linked library artifacts still need release binding |
| `forge build src/BalancerFactory.sol script/Deploy.s.sol --sizes` | Exit 0; factory runtime 5,594 bytes | Compile/postflight code only, not deployment rehearsal |
| `npm run abi` and `npm run typecheck` | Exit 0 | Includes pause/rescue UI and current ABI |
| Focused FactoryPause/ERC20Recovery/InventoryBatches Foundry pass | Exit 0; 21 tests passed | Real FWA, Shapes, ENS and WETH at block 26,382,349; unrelated test compilation excluded; no fabricated randomness in selected tests |
| Focused factory-creation/inventory/ledger/implementation-deployment/deployment-preflight Vitest pass | Exit 0; 21 pure tests passed | No external-success service responses supplied |
| Actual compiled factory selector inspection | creationPaused PUSH4 present | Confirms frontend selector recognition for this compiler output |
| Independent review and affected local-driver repair review | No unresolved actionable source finding | Bounded review; local diagnostic drivers not executed |
| Asset-flow gate `--no-run --require-review` | Exit 2 INCOMPLETE | Existing regime records have stale source hashes; no current-source review recorded; no broad tests or scorecards regenerated |

### Focused asset/authority scorecard

| Flow | Concrete exercised result | Remaining limit |
| --- | --- | --- |
| ERC20 rescue | Real WETH wraps 1 ETH from an external actor, then 0.4 WETH and 0.6 WETH go only to the creator; Balancer native balance and creator credit do not change | Nonstandard/fee-on-transfer token amounts are token-defined; no gas benchmark or current-block campaign |
| Creator handoff | Prior creator rejected after acceptance; the new creator receives the full 1 WETH | No recovery rights attach to original token sender |
| Failed rescue | No-code/zero amount, insufficient balance and a refusing untrusted token revert without changing native/WETH holdings | No claim of general token safety |
| Paused creation | Ordinary creation creates 0 clones, transfers 0 NFTs and 0 wei; policy admin creates one own canary | Old deployed factories cannot be paused retroactively |
| Existing pool exit | Maintenance continues; withdrawing the NFT, redeeming exactly 0.01 ETH Shape backing and claiming operating capital still work while creation is paused | Broad regime campaign and live wallet acceptance remain pending |

## Exactly what remains for release evidence

1. **Successful refunded-batch recovery:** replace the fabricated-VRF helper as the evidence source. Obtain at least
   two actual failed deliveries produced by the real Chainlink/FWA route in an explicitly budgeted owner canary.
   A fork captured after those real callbacks can advance only time past the seven-day window, then execute the
   real purchaser refund and batch recovery. Assert purchaser refund credit/payment, real NFT custody and both
   FWA/Balancer tracking. No production recovery logic change is currently identified. A fork cannot make Chainlink
   spontaneously service newly invented local requests; impersonating its coordinator would not close this gap.
2. **Creator-wallet UI acceptance:** run the final app against actual new and legacy deployments with an authorized
   test wallet. Exercise select/exclude/batch withdraw, repricing, recovery, interrupted-step refresh, ERC20 rescue,
   pause refusal/admin canary, and final holdings readback. Sign local test transactions and match displayed intent,
   receipts and holdings. A disconnected viewer preview or TypeScript build does not supply this evidence.
3. **Deployment rehearsal:** freeze the implementation, linked libraries, replacement factory and values; prepare a
   fresh bounded local plan through `script/deploy.sh`. The plan must explicitly include policy-admin canary access
   and any public resume operation, retain legacy discovery, use test signers/real fees, and verify canonical
   receipts and default-paused state. The historical prepared action whitelist cannot authorize the new setter;
   update its reviewed action list/plan rather than bypassing it. The historical VRF-fabricating diagnostics are
   labelled accordingly and are not this rehearsal.
4. **Gate proof:** run required economic regimes once on the frozen candidate, obtain the repository's exact-source
   review and applicable outcome approvals, then recheck the existing gate. Approve each decoded mainnet broadcast
   immediately before execution. Deployment of unused code, owner canary acceptance and public opening are separate
   steps; a later canary result is not automatically a blocker for deploying unused code, but public opening must
   not be represented as verified before its evidence is complete.

Things that don't make sense: the old factory cannot gain a pause through an implementation switch. Real-randomness
recovery, signed UI acceptance and the new production-path rehearsal remain unexecuted, explicitly scoped evidence gaps.
