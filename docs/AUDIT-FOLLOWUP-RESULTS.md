# Focused independent audit repairs

Base: `cc35dce026d42e5263997f54531015367e98d866` on `main`. Branch: `codex/audit-admission-confirmations`.
Scope is E1 admission, S2 generic wallet confirmation and pool-lifetime dashboard accounting from the supplied
independent audit. R71 authorizes a new PR; R72 explicitly accepts bounded curated-proof refresh. No merge,
deployment, real expenditure or production configuration change is authorized or performed.

## Changes and boundaries

**E1:** tracked curated records no longer prove selectable inventory. Admission requires either an actual FWA
active-listing count greater than all tracked Shape/Pack prizes, or a tracked curated listing still occupying its
cached FWA slot. The pinned FWA implementation deletes that slot mapping on selection and withdrawal, before slot
reuse. The hook rechecks identity each time. There is no unbounded scan or curated-inventory cap.

`refreshCuratedWitness(listingId)` is permissionless and nonpayable. It verifies local curated tracking and actual
FWA active status/nonzero slot. A valid witness is preserved. It moves no assets, creates no maintenance reward and
does not alter creator credit, policy settings or the allowance. Listing seeds a proof from its bounded new batch.
Status 7 means **proof required**, not known absence. Status 3 remains zero locally tracked curated listings.

The owner approved the resulting liveness tradeoff: if a witness exits while another curated NFT is active, anyone
can restore proof in one transaction. If none is active, wait for real readiness or expiry, process the queue,
activate the public FIFO prefix through a curated listing, then refresh. Dashboard activation remains bounded to
20 records per call. The prefix is finite but uncapped curated inventory prevents a constant global call bound.
The production recovery actor is any caller, including the creator through the dashboard; no automatic keeper or
test-driver job is assumed. The caller pays gas. No capital top-up cures a mere proof or activation backlog.

Concurrent FWA batches remain available. The existing once-per-batch busy check can admit four outstanding requests
plus five new ones, reaching nine. Curated presence is established at admission; an earlier pending selection can
still consume the last curated NFT before a later selection. This does not insure the prize mix throughout a queue.
The accepted Shape-weight bound, bounded stocking, settlement and refund rules remain unchanged.

**S2:** generic actions retain the reviewed chain, sender, destination, calldata and value from the prepared write.
Confirmation requires a successful receipt and its actual included transaction matching those fields and block
identity. Cancellation, changed intent, revert and unavailable confirmation stop dependent steps and success
effects. Identical-intent repricing is accepted. Atomic creation retains its separate persisted factory/pool
verification and replacement-recovery path. No general transaction journal is introduced.

**Dashboard:** lifetime operating result is `owner sales − Shape/Pack backing won − mint fees − keeper pay`.
Deposits and withdrawal recipients are grouped by actual event address across all creators. Held assets and
unattributed reconciliation are separate. Either route of the same voluntary ETH gift leaves operating result
unchanged. Wallet gas and curated NFT valuation are excluded. Revenue-share claims remain gross collected-proceeds
rights, not a net-profit promise. Donor withdrawal/recovery rights and custom-policy selection/pricing rights are
unchanged.

These are immutable-contract source changes for future deployments. An older deployed implementation does not
gain the new proof entry point. This work performs no migration or deployment.

## Evidence and limitations

Current production source: **30 files**, fingerprint
`f45cf780c6a9eeac2326a85df1c10391497eb9c9541f769b69f34f243d388acc`.
The [new source manifest](verification/audit-followup/manifest.json) includes `ledger.ts`, transaction and inventory
helpers, generated ABI, contracts, build inputs and dependency pins. The old protected-revenue manifest is preserved
unchanged as historical evidence. [Compiled templates](verification/audit-followup/compiled-inputs.json) bind actual
build outputs and verify production compiler-source hashes and all seven exported ABIs. PoolBalancer runtime template
is **20,492 bytes**, with **4,084 bytes** of EIP-170 headroom; PoolInventory is **11,574 bytes**.

| Check | Result |
| --- | --- |
| New admission regressions | **7 passed**, including the real 100,000-gas hook and externally sponsored concurrent batch checks |
| Existing selectable-inventory controls | **7 passed** on the same frozen production source |
| Affected contract suites | **53 passed**: CI fork suite 9, protected revenue/atomic creation 16, gas 25, queue 1, concurrent refund/exit 1, planner parity 1 |
| TypeScript suite | **199 passed, 6 opt-in cases skipped**, including live read-only generic replacement confirmation |
| `npm run typecheck` | Exit **0** |
| `CANDIDATE_RUN=1 npm run build:app` | Exit **0**, existing dependency/chunk warnings retained |
| `CANDIDATE_RUN=1 forge build --sizes` | Exit **0**, solc **0.8.28**, via IR **50** / Packs **20**, Cancun; compilation **217.81 seconds** |
| Independent delegated source review | No remaining actionable finding; pool-list status-7 omission corrected before final checks |

Commands, statuses and immutable input hashes are in [checks](verification/audit-followup/checks.json).
The first TypeScript run timed out in the 5-second source-binding test while app/contract work ran concurrently:
**198 passed / 1 timed out / 6 skipped**. Its [output](verification/audit-followup/test-ts-initial-timeout.log) is
preserved. The complete rerun with **2 workers** passed in **4.65 seconds**, without increasing a test timeout or
changing product source. The successful app build took **18.71 seconds**. Existing contract regressions include
legacy controlled coordinator callbacks; their sale/credit/gas assertions are conditional local execution evidence,
not a fresh genuine Chainlink fulfillment or oracle-timing claim.

The affected economic round trip preserved **zero purchaser principal shortfall**, with **0.002574 ETH** of actual
nonrefundable VRF charges for two expiries; creator closeout left refunds at FWA until each buyer withdrew.
The 1,000-prize/100-curated upkeep regression used **2,592,327** isolated billed gas, below **2.88 million**
(90% of its 3.2-million gas bound), under its inherited **0.5 gwei basefee / 1 gwei bid** setup. This latter regime
uses the existing controlled selections and is distinct from the new no-oracle-override admission tests.

A deliberately strict artifact check initially rejected test-only `ForkBase` metadata and virtual `foundry-pp`
inputs in `KeeperPolicyV2`. The cache reports preprocessing and generated `VmContractHelper62`; installed Forge
contains `DynamicTestLinkingPreprocessor`. This points to Foundry test preprocessing, rather than a production
source mismatch. Exact transformed test text is absent from minimal build-info, so it was not independently
reconstructed. All eight production artifacts' source entries match actual files; the test/rehearsal-only artifact
hash and its provenance limitation are recorded separately. No cache was cleared or deployment gate weakened.

The permanent E1 regression was run before repair and reached the reported real FWA expiry/staging state, then
failed because admission returned 0 rather than rejecting. [Original failing output](verification/audit-followup/e1-before.log)
is retained. At basefee **0.5 gwei** and transaction gas price **0.55 gwei**, the rejected new request's exact quoted
payment is **0.01514175 ETH**, including **0.001287 ETH** nonrefundable VRF fees. The regression checks no payment or
new request is created on refusal, then restores progress through real public activation and proof refresh.

New Solidity tests use actual FWA/Shapes fork contracts at block **26,382,349**, synthetic external actor funding and
no successful-service mocks, protocol storage edits or oracle impersonation. Withdrawal and slot reuse execute the
same pinned FWA removal routine used by selection. Successful curated-win invalidation before reconciliation is
source-reviewed, not a new real-oracle fulfillment witness. Existing legacy controlled-callback tests are reported
separately from that limitation.

Initial batch checks exposed the real service's `InsufficientVrfCoverage()` and are preserved in
[the failed run](verification/audit-followup/admission-focused-initial-failed.log) and
[trace](verification/audit-followup/vrf-coverage-diagnostic.log). The service retains coordinator liabilities even
after local acquisition expiry. Its required subscription balance is its buffer plus outstanding/prepared requests
times its maximum fulfillment cost. No fee-context mismatch or admission-hook rejection caused those failures.
The corrected tests transfer a computed pre-fee shortfall from an external synthetic sponsor through the service's
real payable receive path; the real service then funds the real coordinator. They never fake a protocol balance.
The sponsor contributes **0.345411994884955013 ETH** in each six-liability case and **1.691550994884955013 ETH** in
the nine-request case. These are conservative pre-buyer-fee contributions, not minimum necessary donations or
production funding automation. Actual subscription balance began at **2.599866375641270950 ETH**. Required coverage
was **3.05 ETH** or **4.4 ETH** respectively. A funded service is a condition of those acquisition checks; proof
refresh cannot cure an external VRF outage or liquidity shortage.

### Focused economic and gas scorecard

| Regime / flow | Measured result | Meaning and limit |
| --- | --- | --- |
| Staged-only curated, quiet after real expiry | Rejected quote **0.01514175 ETH**; buyer, FWA and VRF balances unchanged by refusal | Prevents the reported paid admission; first request's normal expiry/refund rights remain separate |
| Recovery from that staging backlog | Public activation of **13** records plus one proof refresh; **0 ETH** pool/keeper transfer | Caller pays gas; no new capital, reward or policy change |
| Lost witness, another curated NFT active | **1** permissionless refresh restores a **5**-request batch; credit, allowance, settings and reconciliation unchanged | This approved pause is explicit; the test separately sponsors external VRF coverage |
| Concurrent limit | **4 + 5 = 9** pending real FWA requests, then busy refusal | Hook remains once per batch; no serialization or new cap |
| Maximum board, cold proof path | **1,000** tracked Shape prizes and **100** curated; **71,194** caller-span gas; successful `staticcall{gas:100000}` and real acquisition of **5** requests | Includes cold clone/library/implementation accounts and storage; spans are not mined receipt gas |
| Cold proof refresh | **79,142** caller-span gas, below the test's **150,000** bound | Execution-span arithmetic at **0.55 gwei** is **0.0000435281 ETH**, before transaction intrinsic gas/refunds; no pool payment |
| Zero operating activity and creator capital | Real dashboard: **0.025 ETH** deposits/held; **0 ETH** operating result | Capital is not sales or profit |
| Recorded versus eventless **1 ETH** gift | Arithmetic regression: **0 ETH** operating result for either route; residual **0** versus **1 ETH** | Participant grouping and unattributed residual differ; rights and gift destination do not |

The changed gate performs no value transfer. Existing affected recovery/credit tests cover principal refund,
redemption and creator exit. New successful-sale, market demand, NFT valuation, billed proof-refresh transactions,
high-fee inclusion and live-oracle measurements are not supplied by this focused work. There is no new lifetime
spending counter or other economic ratchet. At the same execution span a **50 gwei** bid would cost
**0.0039571 ETH** before intrinsic gas/refunds; 50 gwei is a comparison point, not a user-transaction fee cap.

The browser checked production generic confirmation/orchestration against actual retained mined cancellation,
reverted replacement and successful same-intent replacement receipts on the owned isolated local node
`http://127.0.0.1:18795`, chain **31337**. An included-transaction lookup failure was the only injected failure.
Cancellation, revert and unavailable evidence stopped dependent steps; same-intent repricing continued once.
This is retrospective receipt handling, not an extension wallet Cancel-button exercise or a new broadcast.
[Browser output](verification/audit-followup/browser-confirmation.txt) and
[setup](verification/audit-followup/preview-setup.mjs) preserve those limits.

The real dashboard read the retained pool `0x07469a232cCDD03984eD2A509f4923f459A040FB` through block **26,382,406**:
**0.025 ETH** recorded deposits and holdings, zero operating activity and **0 ETH** operating result/reconciliation.
The creator address appears as the depositor; no personal return is inferred.
[Rendered readback](verification/audit-followup/browser-dashboard.txt) and screenshots accompany the checks.
The new proof-refresh button has contract and caller coverage; no fresh deployed candidate or wallet broadcast
was used for browser verification.

Historical rehearsal, audit, approval and source-seal records remain bound to their original revisions. They are
not relabeled as a rehearsal or release approval for this candidate. A new production-path deployment rehearsal,
live oracle delivery and public canary are outside this no-deployment follow-up.

## Things that don't make sense

An exact curated-presence scan cannot be both uncapped and constrained to the 100,000-gas hook using the deployed
FWA views. The explicitly approved proof-refresh pause addresses that constraint. No donor return promise,
policy-price cap, automatic recovery service or creator net-profit claim is added to make the results look better.
