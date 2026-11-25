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


## Authentic recovery proof and guarded rehearsal follow-up (2026-11-25)

This section supersedes the earlier claim that successful recovery necessarily needs a new live oracle request.
A genuine historical proof replay now exercises the candidate through the real coordinator and FWA service.
The test forks immediately before purchase transaction
`0x2d9d2a85771c6ea346a6ed9e581fe5c5c1f5aefb770f669effcee35e254f8283`, creates three real requests with
exact historical request IDs, preserves accounts reached through real calls, advances to canonical block 26,442,757,
and executes the original proof-bearing transactions using `vm.transact`. Setup and proof execution require separate
transaction boundaries; a numerical block roll alone does not provide the canonical blockhash needed by the proof.
No oracle caller is impersonated, no random words are fabricated, and no protocol storage/code/balance is assigned.
Persistent accounts intentionally omit intervening historical mutations: this is a modified-fork proof test, not
complete canonical-history replay or evidence of new live oracle availability. The creator-controlled rejecting
NFT collection is an accepted untrusted counterparty, not a replacement for an integrated protocol.

| Focused asset-flow scorecard | Observed outcome | Limit |
| --- | --- | --- |
| Purchase -> failed delivery -> refund | Three actual failed deliveries (status 6), each 0.0105 ETH including historical 5% edge | Historical fork and genuine historical proofs |
| Buyer refund withdrawal | Exactly 0.0315 ETH returned; refund credit becomes 0; creator sale proceeds remain 0 | Forge wallet accounting is not a signed-wallet gas-cost benchmark |
| Refunded batch recovery | All three exact NFTs return to creator; all three Balancer item records clear | Signed UI recovery remains unexercised |
| Zero-draw rehearsal | New hash-bound mode caps scenario at 30 transactions, 0.1 ETH deposit, 0.1 real WETH, 1 test ETH gas; creation remains paused | Preparation/guard evidence only until completed journal |

Evidence scope is the source tree based on `1ede6d72b7e4baa1d09e144c02b42dedc8cdd0e2`, frozen in this
follow-up commit. `forge test --match-path test/AuthenticRefundRecovery.t.sol -vvvv` exits 0: one focused test passes
at explicit nonzero historical basefee/gas-price settings. Three failed experimental runs are preserved alongside
the final successful trace in `docs/receipts/authentic-refund-recovery-20261125/`.
The production frontend build (`CANDIDATE_RUN=1 npm run build:app`) and `npm run typecheck` also exited 0.
Four new inventory guard tests and 21 existing pure control-input tests pass after one fixture repair. The initial
combined run exited 1 because that old fixture lacked the newly required schema; only that case was rerun, exit 0.
Four inherited receipt-polling cases were inadvertently included; they supply successful service answers, and
are excluded from no-mock acceptance evidence. No new successful-service mocks were added.
Independent focused reviews inspected the authentic proof trace and the local guard/staging repairs; they are
not a full-candidate audit, economic release approval or deployment authorization.

The owner-approved local plan `96fa4ad6dcad52e7cecc3f1125b120960a282bbb2a64f9e8af67ba95a0c95e0a`
at `http://127.0.0.1:18786` failed before broadcast because its staged checkout lacked the public legacy discovery
file required by the deployment wrapper. Eight named synthetic wallets were funded once, totaling 3.22 test ETH;
there are zero broadcast receipts and no deployed candidate contracts. Preserve the node, journal and failure log
in `docs/receipts/current-rehearsal/20261125153241612-1ede6d7/`. The repaired manifest includes that public file;
its changed source fingerprint requires a fresh exact plan approval, not replay of the interrupted journal.

Remaining acceptance: complete the corrected production-path local transaction batch, signed creator UI flows,
and the repository-required economic regimes/exact-source review/outcome approvals. Historical economic runs that
fabricate VRF cannot establish new no-mock evidence. No mainnet deployment or implementation switch occurred.

Things that don't make sense: the old factory cannot acquire a creation pause through an implementation switch.
The successful historical proof closes the refunded-recovery code-path gap, but does not close signed UI or
new-live-oracle availability evidence.


### Completed corrected local batch

Owner-approved plan `63f25eebe0c29822fbda34a90898c80ca3419810a4145b2aa2e6f27f6871f37b`,
source revision `da603f70156693ea32a0b0dbe484c50880c6bc36`, completed on the owned local fork
`http://127.0.0.1:18790`, chain 31337. The exact production deployment wrapper broadcast four deployment
transactions, followed by 14 bounded scenario transactions. All 18 receipts succeeded. Gas cost totaled
0.007270741620849468 test ETH, below the 1 test ETH ceiling. There were zero draws and oracle permissions.

The factory at `0xbe49677a403f77136e81498e5681f8dc22aa1181` remains publicly paused. Its admin-created
Balancer `0x5E638324A84CF6Cf1394D2066cB0a7AC4C655cd9` returned both demo NFTs, recovered 0.1 real fork WETH,
and returned 0.1 test ETH. Independent postflight RPC readbacks found zero Balancer native/WETH balances,
empty active inventory and both NFT owners equal to the synthetic creator. Full receipts, bytecode checks,
canonical deployment output and postflight are in `docs/receipts/current-rehearsal/20261125154241434-da603f7/`.
Command: `CANDIDATE_RUN=1 node --import tsx scripts/current-local-rehearsal.ts --plan <that directory>/bounded-plan.json --approved-plan-hash 63f25eebe0c29822fbda34a90898c80ca3419810a4145b2aa2e6f27f6871f37b --execute`.
Exit status 0. Existing stale-artifact warnings were retained; caches were not deleted and exact approved
creation/runtime hashes were checked against actual deployment receipts. This is local transaction evidence,
not signed creator UI acceptance or a mainnet canary. Existing historical and interrupted local nodes remain preserved.

A separate concrete creator-UI local plan is prepared in `docs/receipts/creator-ui-20261125/bounded-plan.json`.
It has not been executed or approved. It adds no wallet funding and caps writes at 12 local transactions,
0.1 ETH gas, 0.1 ETH deposit, and 0.1 existing WETH. It does not inherit the prior packet's authority.

Things that don't make sense: the previous broad economic gate uses fabricated randomness and cannot count as fresh
no-mock evidence. UI and economic release evidence remain outstanding; no mainnet deployment/switch is approved.


### Completed creator UI batch (2026-11-25)

The owner approved the prepared local creator UI batch and 15 active minutes, then explicitly amended the omitted
`depositETH()` method before its 0.1 test ETH deposit. The CUA-driven app preview at http://127.0.0.1:5211/
completed 11 successful local transactions, nonces 14 through 24, on the preserved owned fork at http://127.0.0.1:18790.
Two NFTs were listed at 0.2/0.3 ETH and repriced together to 0.4 ETH. NFT #1 was selectively withdrawn with NFT #2
excluded; a reload showed NFT #2 still listed. The actual ERC20 form recovered 0.1 real fork WETH. After deposit and
retirement, Take everything back returned NFT #2 and 0.1 test ETH. Its final UI message agreed with independent
readbacks. Gas totaled 0.002994133215063847 test ETH, below 0.1; the owner's native wallet decrease equals that
receipt gas exactly. The Balancer and FWA pool hold zero native ETH, Balancer WETH is zero, both NFTs belong to the
synthetic creator, active inventory is empty, FWA proceeds/unsettled counts are zero, and public creation remains
paused. No new wallet funding occurred. Independent focused acceptance review found no consequential inconsistency.

See `docs/receipts/creator-ui-20261125/README.md`, journal, amendment, exact intents and postflight for scope,
nonzero transaction fee context and preserved read-only operator failures. This is unlocked-node development-wallet
UI evidence, not production extension signing or refunded-history UI evidence. No production source changed;
existing valid build/fork proofs remain reusable. Economic harness correction, 28 current-source regimes and
exact-source independent review remain required by the existing production gate. No mainnet transaction occurred.

Things that don't make sense: the broad economic harness still fabricates randomness. Its 28 old-source scorecards
cannot be refreshed unchanged as no-mock release evidence.


### Genuine-proof economic lifecycle and synthetic-path retirement (2026-11-25)

Added test/AuthenticEconomicFlows.t.sol: 47 Shape/Pack prizes with 1.7 ETH backing, 25% markup, 5 ETH funding and
three genuine historical VRF proofs. All three purchases deliver actual prizes; independent quote arithmetic,
66,278,634,547,026,369 wei proceeds, exactly 2,651,145,381,881,054 wei creator credit booked once, paid reconciliation,
exact remaining backing redemption and creator closeout pass. The final creator claim is 4,913,901,123,666,667,089 wei.
Historical fee context is asserted inside state-changing calls. The pre-existing authentic failed-delivery recovery
and reporting tests also pass; reader checks pass seven tests. See docs/receipts/authentic-economics-20261125/README.md
for commands, failures/repairs, all bounded claims and the scorecard. No public-chain transaction occurred.

The historical campaign's synthetic word/callback methods now revert, candidate execution is refused, and the shared
reporter rejects unverified producers before writing. No release scorecards or approved outcome/configuration values
were changed. This new three-draw case is additional scoped evidence, not any of the 28 required monthly regimes.

Remaining: distinct historical request/proof corpus and compatible scheduling for the full workload, followed by
28 current-source regimes and exact-source independent review. There is no claim of fresh oracle availability,
production wallet gas profit, keeper-only liveness or complete protocol/mint/oracle-fee conservation.

Things that don't make sense: forced winners and reused proofs cannot be relabelled as authentic full-regime evidence.


### Genuine proof corpus and continuous multi-batch execution (2026-11-25)

Added bounded read-only Tenderly corpus collection with checkpoint reuse. A backward scan observed836service requests
across453purchase batches; only FOUR actual request/proof pairs were captured and validated, explicitly distinguished
from event availability. The main three-entry anchor prefix remains unchanged; previousEntries holds its immediately
preceding single request. No approved outcome/gate configuration was changed.

Added actual public-coordinator proof submission: three genuine proofs succeed from an ordinary caller without oracle
impersonation, outputs equal canonical historical words, tampered gamma is rejected, consumed proof replay is rejected,
and real keeper-role reconciliation/restocking succeeds. Added a separate continuous pool: one request/proof at
26442101/26442106, then three at26442752/26442757, with reconciliation/restocking between cohorts, sequence4 and full
creator closeout. All three affected cases pass, with the failed sequence case rerun only after repairs. Typecheck passes.

The sequence fixture forks BEFORE the actual later request transaction; selecting the block's post-state imported
canonical pending-request state through uncached storage and produced DuplicateRequestId. Canonical transaction-prefix
replay also requires Prague EXECUTION for EIP-7702; compiler settings stay Cancun. Both failures and the successful
repair trace are preserved in docs/receipts/authentic-sequence-20261125/. Independent review checked these repairs.

This establishes genuine sequential proof execution locally, not the complete180-draw/28-regime campaign. Next action:
materialize a larger contiguous prefix from the observed836requests, then port scheduling/accounting while preserving
approved workloads/outcomes. No public-chain broadcast, fresh oracle-service availability or production-wallet profit
is claimed. The four-pair capture and bounded passing evidence are in the receipt README and fixture.

Things that don't make sense: four verified proofs must not be described as836verified proofs or full-regime completion.
