# Implementation-only release

This path reuses the existing factory and dependencies. Existing clones never change.
No broadcast has been made or authorized by this document.

1. Freeze and review the candidate, pass the existing asset-flow/release gate, and rehearse this same path on the owned isolated fork.
2. Read the existing factory, its original deployment block and expected implementation from the canonical deployment record. Run deployment-preflight.ts with --existing-factory, --expected-implementation and --factory-snapshot-out to save its live configuration at the pinned block.
3. Set values IMPLEMENTATION_ONLY=true, REUSE_DEPENDENCIES=true, EXISTING_FACTORY and EXPECTED_IMPLEMENTATION. Use script/deploy.sh with the existing keystore and --slow. Review its dry-run manifest and hash: only linked libraries whose exact code is absent and PoolBalancer may be created. Obtain immediate decoded confirmation before each mainnet broadcast.
4. Verify the deployment with scripts/verify-deployment.ts and the existing dry-run/hash/broadcast arguments, plus --existing-factory, --factory-deployment-block (the ORIGINAL block), --factory-snapshot and a separate --out file. This requires the factory pointer/configuration to remain unchanged. Preserve deployments/1.json and all old receipts.
5. Separately review NEW_IMPLEMENTATION and the exact setImplementation transaction. Run the SAME gated script/deploy.sh with --sig "switchImplementation()" only after immediate decoded confirmation. The script checks EXPECTED_IMPLEMENTATION, locked implementation/dependency wiring and unchanged factory configuration.
6. Verify that transaction using verify-deployment.ts --update-tx, --verified-implementation, --verified-implementation-sha256, --rpc-url https://mainnet.gateway.tenderly.co and a separate --out. It checks canonical success, zero value, the policy-admin sender, exact setter calldata and unchanged configuration apart from the pointer. Retain the original factory deployment block for discovery.
7. Refresh creation previews and predicted-address NFT approvals; old approvals do not apply to new predicted addresses. Exercise an explicitly budgeted owner canary. Permissionless creation is already live immediately after switching; only the canary spending is capped. Reverting the pointer affects future creations only.

Deployment records written during simulation are not evidence of broadcast. Release readiness still requires real UI exercise, independent review and the existing economic/rehearsal evidence. No ERC20 ownership rule is introduced.

Things that don't make sense: the factory has no creation pause, so the owner canary cannot cap all creation exposure.


## Implementation evidence (2026-11-25)

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
