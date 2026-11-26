# Focused independent update review

Target: `b44e35fc93596430d09c48629b70c473c9f165fa`.
Baseline: `3217bb36fccc67fa4a26244e4223984d3e765320`.
Scope: inventory withdrawal/repricing/refunded-recovery batches, creator ERC20 recovery (R111), new-factory creation pause (R112), ENS library extraction, affected UI and deployment wiring. This is a timeboxed, read-only source review, not a whole-repository audit. No tests, builds, RPC calls, broadcasts or delegation were performed. Discovery used code and owner requirements before consulting receipt evidence; runtime isolation/blindness was not enforced. Existing unrelated dirty files were preserved.

## Result

No actionable security or economic defect was established in the examined update. This bounded result does not establish absence of bugs, complete audit coverage, or release readiness. A new whole-system audit is not intrinsically required by these narrowly scoped wrappers and authority additions; the missing broad economic campaign remains separate and cannot be represented as passed. Mainnet deployment, activation and canary still require their applicable owner authority and gates.

## Independent economic derivation and scorecard

The new flows do not charge a protocol fee. Their new operating cost is transaction gas paid by the caller, normally the creator. No keeper reimbursement is introduced.

| Flow / regime examined | Independent destination derivation and concrete evidence | Limitation |
| --- | --- | --- |
| Curated withdrawal, ordinary/retired | FWA custody -> creator-selected recipient, one exact NFT per listing; no ETH transfer. Receipt fixture lists NFTs at 0.2/0.3 ETH, reprices both to 0.4 ETH, then returns both NFTs. These are notional listing prices, not cash balances. | Two NFTs, not a maximum-20 receipt run. |
| Repricing | Only inverse-weight notional price/accounting changes; 0 ETH moves. Batch failures revert all preceding repricings. | Source proof; runtime assertions were read, not rerun. |
| Refunded curated recovery | Purchaser first takes FWA refund; only FWA DeliveryRefunded then permits owner recovery; NFT goes FWA -> Balancer -> creator-selected recipient. Refund ETH remains a purchaser entitlement, not creator proceeds. | Read actual FWA implementation source and local wrapper; no fresh refund execution. Existing authentic fixture documents 3 recoveries and 0.0315 ETH buyer refund. |
| Refunded Shape/Pack recovery | FWA -> Balancer NFT -> actual redemption; backing ETH remains Balancer operating cash, then creator may claim under existing surplus/credit rules. Batch return is summed ETH received, not a payment to `to`. | No full per-denomination runtime ledger independently recalculated here. |
| ERC20 round trip / retirement | Token contract receives only transfer(currentCreator, amount), zero native value and no approval. UI receipt postflight has exactly 100000000000000000 WETH units at creator and zero at Balancer after 0.1 WETH deposit/recovery. A prior depositor has no claim under R111. | WETH execution; arbitrary-token semantics cannot be guaranteed. |
| Native round trip / retired closeout | Existing deposit/surplus path returns 100000000000000000 wei. Receipt wallet start 898724110310173952 minus end 895729977095110105 = 2994133215063847 wei, exactly recorded transaction gas. Final Balancer ETH, FWA ETH/proceeds and unsettled count are zero. | 11 local signed transactions, chain 31337, fork 26493164; not production signing/mainnet inclusion. |
| New-factory paused creation | Public contribution/creation blocked; policy admin alone may create its own canary. Existing pool assets and exits do not consult this pause. No value ratchet introduced. | Admin creation rights are deliberate R112 policy. Old factory cannot gain this pause by implementation-pointer change. |

The receipt evidence was read from creator-ui-20261125 README/postflight and authentic-economics-20261125 README, not independently regenerated. Nonzero receipt gas fields are documented in their journal; their full provenance and every transaction field were not revalidated in this short review. The scorecard is representative of changed flows only. Quiet/max/idle/zero demand/large-win/gas-spike/dependency-pause and all setting extremes were not rerun. No numeric owner outcome is changed by this report.

## Security and compatibility reasoning

- Every added pool mutation uses existing onlyCreator and nonReentrant. Accepted handoff changes `creator`, so rescue goes only to the new creator; old/pending creators receive no independent authority. Callback attempts cannot enter guarded ownership, exit, accounting or upkeep methods. Unguarded ETH deposit/receive only increase holdings; initialize is already locked after initialization.
- All batches reject zero, >20, and duplicate IDs before effects. Curated batches reject noncurated/tracked-invalid entries; external failure rolls back all local state and prior transfers in the transaction. Withdrawal clears tracking before FWA callbacks; FWA itself checks depositor and unresolved-draw/reservation locks. The unchanged single-item routes remain available to isolate hostile collections. Twenty IDs imply at most 190 duplicate comparisons.
- Repricing invokes the same validated scalar path. Unchanged prices skip external mutation; this does not change any draw commitment. Actual changed prices remain subject to FWA exit lock. Curated witness validation reads actual slot/status, so deleted or withdrawn inventory cannot sustain an obsolete positive witness.
- Recovery checks local drawn state and actual FWA status 7. FWA owner-only recovery clears its NFT controller and verifies ownership. Wrong-state, mixed-invalid or hostile-transfer batches revert atomically. Shape backing is retained by Balancer; no new ETH-forwarding primitive exists.
- ERC20 recovery calls only the fixed ERC20 transfer selector, not arbitrary calldata, approvals, ETH withdrawal or NFT transfer selectors. Creator-supplied hostile tokens can revert/lie or call back, but no new capability to spend unrelated assets was identified. Operating cash/creatorCredit counters are untouched. This does not promise success for every token.
- Public linked PoolPage executes by delegatecall from the guarded creator entrypoint. Its registrar CALL therefore originates from the Balancer, preserving reverse-record identity. No pool storage fields are added or reordered. Factory pause packs into factory storage, but factories are immutable deployments, not upgraded storage proxies.
- Existing clones retain their implementation address. setImplementation changes future clones and predicted addresses only; stale creation hashes bind the reviewed implementation. UI reads each clone's capability marker and uses scalar fallback for legacy clones. Existing factory stays unpaused-capability legacy; only replacement factory provides R112.
- Deployment-only mode separates deployment from pointer activation and snapshots old factory settings. Activation verifies expected implementation, fixed dependencies and postflight configuration; this review grants no authorization to invoke it. New factories explicitly start paused. The current postflight checker distinguishes deployment from activation.

## Evidence and limits

Read-only commands: git diff/show/rev-parse/status, rg, sed and cat. Source diffs and relevant callers were read at HEAD, which matched target. The source reviewed includes PoolBalancer, PoolInventory, PoolPage, BalancerFactory, affected App/inventory/factory-creation helpers and deploy/verify scripts; external FWA withdrawal, repricing and refunded-delivery code was read from the vendored StandardPool source. This pass did not independently establish deployed external bytecode/source correspondence or new implementation runtime/EIP170 size. Existing actual evidence is reusable only while relevant source/configuration/dependency assumptions remain unchanged.

Test source includes authorization, atomic rollback, bounds, handoff, WETH and pause cases; reading test assertions is not execution evidence. Fresh callback/cross-asset hostile executions, maximum-size mixed refund batches, refunded-history UI and failed-collection UI are unexecuted in this review. Refer these gaps to the integrated lead verification; do not run duplicate per-item suites. No product build/test command was executed. One documentation evidence read used a nonexistent refund README path and exited 1; no claim relies on that read.

## Things that don't make sense

- “Take everything back” can include Shape redemption into Balancer followed by a separate surplus claim; its `to` parameter does not receive Shape backing directly. Product messaging and receipts must preserve that distinction.
- Existing authentic-economic evidence explicitly uses harness-driven FWA processing and only a small historical proof corpus. It cannot support live keeper profitability/liveness or the approved full 28-regime campaign. Narrowing this update gate must not silently relabel that evidence.

## Follow-up: focused gate migration, staged candidate

Reviewed the staged focused configuration, three reference scorecard bodies, maximum-20 gas/conservation test, deploy-wrapper gate route and both wrapper assertions. Runtime production contracts remain at b44e35f. Old asset-flow.json has no staged or working diff. No tests/build/network/signing/broadcast was performed in this follow-up.

No actionable gate-migration defect established. The standard trusted writer retains its default-deny provenance override; each focused producer sets verified only after real-path assertions. Native principals are absolute 1 ETH (inventory/ERC20) and 0.1 ETH (paused admin canary). Asset facts are literals backed by preceding ownership, token balance, FWA proceeds, creator credit and inventory assertions. The three regimes create no draws and make no oracle-outcome claims. Gas context is set and asserted through the shared state-changing probe. The maximum-20 test separately checks every NFT/pricing state and four native/credit buckets, with raw gas/calldata bounded below 16,777,216; its warm-slot snapshot measurements are explicitly not independent signed-transaction fee comparisons.

The focused approval hash is a NEW approval, not reuse of the broad campaign signature. Empty signature keeps approval incomplete. Trusted asset_gate.py binds outcomes, regimes, source/evidence paths, command, thresholds, scorecard and review directories into the signed outcome digest; exact-source review remains required. Its SOURCE_HASH marker records reviewed inputs and is not an outcome signature or runtime PASS. Wrapper tests assert the focused config plus --require-review; the actual wrapper executes that command and exports the existing marker only after success. No owner key was read or used.

Limits remain: focused reference scorecards are neither the 28 regimes nor a complete all-asset ledger, and the gate does not intrinsically enforce those deferred economics. Fork fixture actor funding is setup, not live funds. A no-draw creation/exit case is not an actual mainnet lifecycle canary. EIP170/runtime artifact verification, authentic refund assertions and all focused regressions must still pass the lead's integrated batch; these test bodies were inspected, not executed here. Broad required outcomes, production activation authority and uncapped launch readiness are not replaced by this source seal.

Things that don't make sense: the narrowed gate must stay described as an inventory-update gate. Its three zero-demand roundtrips cannot support an economic campaign or live-service availability claim, even when green.

## Follow-up: authorized-creator callback regression

Reviewed test/FocusedERC20Callbacks.t.sol and its focused-config inclusion. No production contract changed. The receiver actually accepts the creator role before callback attempts, and asserts Reentrancy() on both native-surplus and WETH-rescue reentry, so Unauthorized cannot falsely satisfy the check. The creator-supplied token maintains and transfers a real 100e18-unit balance; real WETH deposit/transfer establishes 0.1 WETH custody. Genuine historical proof transactions and actual FWA processing/collection establish nonzero creator credit; final assertions preserve that credit, native cash and WETH until legitimate subsequent WETH recovery succeeds. This is an accepted hostile token/receiver, not a substitute for a protocol dependency.

No actionable defect in this added regression was established. New approval hash 191c4b697f12aa9908add65777a92f04a2a11115120ea8388dc6289019620f4d binds the expanded test command/evidence paths; signature remains empty and mandatory. The prior source seal is superseded by the refreshed SOURCE_HASH. This review inspected source only and does not claim the running affected batch passed. Nonzero-credit and cross-asset callback gaps receive direct executable assertions, conditional on successful lead execution. Mixed maximum-size refund batches, refunded-history/failing-batch UI, live-canary and full economic campaign limits remain unchanged.

Things that don't make sense: none newly identified. Historical replay remains bounded historical evidence and cannot establish present oracle liveness or production keeper operation.
