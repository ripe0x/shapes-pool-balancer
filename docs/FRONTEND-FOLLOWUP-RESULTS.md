# Frontend corrections and current candidate rehearsal

This report records delivery `feb71f6` and the rehearsal frozen at `0065ec4`. The subsequent
[creation replacement correction](CREATION-REPLACEMENT-RESULTS.md) has separate source bindings and targeted evidence.

Follow-up to reviewed commit `51dd7b7c3b300eee9a0279127e08021230539030`, PR 10 on
`codex/creator-credit-atomic`. Fetch and PR metadata checks found that exact head, open and draft, with no subsequent
fixes to reconcile. No Solidity, generated ABI, dependencies, production configuration or economic terms were changed.
Historical approvals and archived rehearsal records remain associated with their original source.

## Frontend changes

| Finding | Implemented behavior |
|---|---|
| History starvation | Each selected pool/client has one active history read and one latest queued snapshot. Current polling runs independently. Completed history publishes even after multiple current polls. Prior history survives refresh/error; obsolete pool/client/unmount callbacks and queued work are suppressed. |
| Uncertain creation | One creation attempt is stored in the existing draft before the wallet request, then updated with its submitted hash. Factory registration, creator, factory link, reviewed configuration and FWA pool ownership establish success independently of receipt availability. Unknown/pending attempts cannot submit again. Explicit pre-submission rejection and confirmed revert retain retry paths. Reload and account/chain changes preserve the attempt and guard clearing/navigation. Atomic creation remains approvals plus one creation transaction. |
| Stored revenue rate | Existing-pool calculations derive their rate directly from refreshed stored bps. Only a new draft can use its local override. Earnings, retained revenue, margin and projections share that effective value; explicit zero and 10,000 bps are preserved. |

Actual hook-used orchestration and creation helpers have **27 distinct passing focused regressions** across three
files. The original combined command
`CREATION_RECOVERY_RPC=http://127.0.0.1:18766 npx vitest run app/src/creation.test.ts app/src/refresh.test.ts app/src/revenue-rate.test.ts --reporter=dot`
passed 25 cases, exit 0. After adding the two receipt regressions,
`CREATION_RECOVERY_RPC=http://127.0.0.1:18766 npx vitest run app/src/creation.test.ts` passed 12/12, exit 0;
the unchanged queue/rate suite contributes 15 cases. [Original combined log](verification/frontend-followup/frontend-regressions.log),
[final creation output transcription](verification/frontend-followup/fwa-creation-final-vitest-transcription.log),
[queue/rate log](verification/frontend-followup/history-rate-regressions.log).
The added cases use actual viem receipt waiting on a real mined creation: one receipt-only RPC failure and one actual
receipt timeout. Successful responses come unchanged from the real node. Both retain the serialized hash/predicted
address/context, prevent another wallet submission and recover from actual factory/pool reads.
Deferred tests exercise the production refresh queue, including failed-delivery entries; they do not replace it with a
test-only scheduler or supply successful external RPC responses. Explicit wallet/transport failures exercise the actual
creation submission helper. Successful recovery reads come from the retained real FWA fork. The fresh rehearsal also exercised
actual pending and reverted receipt probes, recorded separately below.

Independent reviewers read the immutable counterpart's implementation and callers, with no actionable findings in
this scope. [Reviewed hashes and limitations](verification/frontend-followup/review.json).

## Browser evidence

Owned Anvil PID 95500 at `127.0.0.1:18766`, chain 31337, Tenderly mainnet fork 26,382,349; synthetic development account
`0x70997970C51812dc3A010C7d01b50e0d17dc79C8`. This is a retained UI fixture, separate from the fresh candidate node.
Successful RPC results were forwarded unchanged. Local proxies only delayed responses or injected service failures.
No extension-wallet signature, public transaction or live oracle behavior is inferred.

- **Slow history:** the proxy added 35 seconds to one history RPC; its measured total was 44,174 ms. Two normal 15-second
  polling cycles completed current snapshot reads before it returned. Historical earnings then appeared and remained
  visible while the latest queued scan loaded. A subsequent injected history error remained visible beside prior
  earnings, then cleared after successful retry. [Timing and source binding](verification/frontend-followup/history-summary.json),
  [RPC window](verification/frontend-followup/history-rpc-window.jsonl),
  [completed history](verification/frontend-followup/history-completed.jpg),
  [retained history during error](verification/frontend-followup/history-error-retained.jpg).
  The preview alone raised transport timeout to 60 seconds: the production client's 10-second per-RPC timeout otherwise
  prevents a single 35-second response from succeeding. Production transport settings were not changed. Setup attempts
  with that default timeout and development hot reload did not establish successful slow-history acceptance.
- **Successful creation despite failed confirmation:** NFT 2026111802 was approved, then one factory transaction
  `0x090688e3bf5d6728b36d8d6ac952b123d880f8b7a29526035884f30dae616803` created
  `0xA3d5312103C3f64506A914BcA71768b7695297A0`, value **0.536112 synthetic ETH**, gas **2,362,733**.
  Receipt lookups for that factory transaction failed; approval receipts and real state reads succeeded. The interface
  opened the verified pool, stored **1234 bps**, and the selected NFT remained in its FWA pool. One subsequent browser
  unpaid upkeep listed exactly **five Shapes**, spending **0.055 ETH** including **0.005 ETH** mint fees and paying no keeper.
  [RPC failures and sends](verification/frontend-followup/creation-rpc-failures-and-sends.jsonl),
  [actual receipt/configuration/custody](verification/frontend-followup/creation-readback.json),
  [recovered pool stocking](verification/frontend-followup/creation-stocking.jpg).
- **Unresolved outcome across refresh:** receipt lookups and factory recognition temporarily failed for a second
  successful atomic transaction, `0x7656aec1be1ef7604eeeb919e69c286969d3b0ff1f24ee4ca1192cda3165248e`.
  The browser kept its hash and predicted address, offered no second creation, retained them after reload, and required
  the creating account/network before recovery. Reconnecting retained the unknown outcome. Restoring factory reads
  opened `0x26f754B66cAD7F30b891f606E997be637d13028d` while receipt lookup remained unavailable. Exactly one factory
  send occurred. The new pool retained the explicit **0 bps** selection and NFT 2026111803; another reload showed an empty
  fresh draft rather than the submitted attempt. [Before refresh](verification/frontend-followup/creation-unknown-before-refresh.jpg),
  [disconnected context](verification/frontend-followup/creation-after-refresh-disconnected.txt),
  [recovered pool](verification/frontend-followup/creation-after-refresh-recovered.jpg),
  [cleared draft](verification/frontend-followup/creation-draft-cleared-after-refresh.txt),
  [real receipt and custody](verification/frontend-followup/creation-refresh-readback.json),
  [one send plus injected failures](verification/frontend-followup/creation-refresh-rpc-failures-and-sends.jsonl).
- **Rate synchronization:** the existing editor stayed mounted while another client changed stored rate **400→800 bps**.
  Displayed share **4→8%**, earnings **0.00103→0.00206 ETH/draw**, retained **0.02473→0.02370**, and margin
  **0.00608→0.00505** updated together. The monthly projection became **2.47284 ETH** at 40 draws/day, from **1.23642**.
  These are conditional estimates for that actual board/gas, not realized income. A new draft retained its chosen
  **12.34%** through reload despite a different suggested rate and submitted exactly 1234 bps above.
  [Editor before](verification/frontend-followup/rate-before.txt), [after](verification/frontend-followup/rate-after.jpg),
  [projection](verification/frontend-followup/rate-overview-after.txt),
  [rate receipt and stored readback](verification/frontend-followup/rate-change-readback.json),
  [draft after reload](verification/frontend-followup/draft-after-refresh.txt).

## Current candidate wrapper rehearsal

Frozen input candidate: `0065ec4e0356a7ecdb8765880331affafdc636e2`.
The [exact current packet](receipts/current-rehearsal/20261118195158615-0065ec4/bounded-plan.json) has plan hash
`f622ed9c0470910d0a938f650523b610c116e9a812fc3639e80b6fecfe551955` and source fingerprint
`2898e8bf0fa1a537bcdfe8118c9e2d3ee87259b856b72989bc5da21c384aad45` over 146 source/build/driver inputs.
It binds actual Node, mandatory guard, delegated Forge, Anvil and solc executables, installed dependency lock, clean
pinned dependency source, ten exact compiled artifacts, eight decoded deployments and fixed intended actions.

Owned node `127.0.0.1:18789`, PID 38404, chain 31337, fork 26,444,161/hash
`0x42e2df8e0e3ff9493773e68d8c878ce56573011bdcf14a7800df53a3f3b9d54a`.
The canonical simulation skipped compilation and passed strict raw artifact equality. Limits are 2 ETH pool deposits,
5 ETH buyer payments, 1 ETH total gas with 0.1 ETH closeout reserve, 20 gwei fee ceiling and 160 draws maximum (157 planned).
[Root packet review](receipts/current-rehearsal/20261118195158615-0065ec4/packet-review.json) records the current owner
request as authority; no historical approval or production signature is transferred.

The exercise **completed** through `script/deploy.sh`, the existing `Deploy.s.sol` and production `Keeper.tick()` entry
points: **157 draws, 419 receipts**, including one declared negative creation transaction. Its real pending transaction, then
confirmed reverted receipt, were observed by the frontend recovery helper; no NFT moved on that revert. The two valid approved
atomic creations each listed two curated NFTs and zero Shapes before bounded stocking. Concurrent purchases and
replenishment, collection/claims, unpaid upkeep, policy replacement without settings metadata, underfunded activation,
late closed settlement, actual expiry/refund withdrawal, unsold curated NFT return and retirement all completed.
[Journal with decoded actions/receipts/readbacks](receipts/current-rehearsal/20261118195158615-0065ec4/journal.json),
[pending/revert probe](receipts/current-rehearsal/20261118195158615-0065ec4/creation-recovery-probes.json),
[canonical deployment](receipts/current-rehearsal/20261118195158615-0065ec4/canonical-deployment.log),
[read-only final verification](receipts/current-rehearsal/20261118195158615-0065ec4/final-verification.json).

| Economic observation | Actual synthetic ETH / result |
|---|---|
| Pool deposits | 2.000000000000000000, fixed; no top-ups |
| Gross buyer submitted value, including immediate refunds | 3.336047773899341322, within 5 ETH cap |
| Actual buyer purchase payments after expiry refund, excluding buyer gas | 2.896050539499938484 |
| All actor gas, including intentional revert and coordinator callbacks | 0.270486714751984388, within 1 ETH cap |
| Keeper rewards / all keeper gas / net | 0.102684633744238840 / 0.088303259171782935 / **+0.014381374572455905** |
| A / B creator withdrawals, including returned capital | 0.736882702795217182 / 0.740997177270009272; NFT market value unmeasured, no creator net-profit claim |
| Both retired Balancers | Cash, creator credit, operating cash, reserve and active inventory all zero |
| Both FWA purchaser obligations and owner proceeds | Escrow, refunds and owner proceeds zero; protocol fees remain 0.057997008674636187 / 0.058831217015837003 |
| Custody | Four unsold curated NFTs returned to their creators; buyer retains actual 1 ETH Shape and 0.02 ETH Pack backing |

Actual acquisition fees were **2.469101173899341322 ETH**, VRF payments **0.4426578 ETH**, and the expiry fee refund
was **0.015708434399402838 ETH**. Gross submitted value is a conservative budget counter, not net spending.

Full-cycle cash event totals reconciled exactly to the wei. Credit event replay reached each actual final zero balance,
with additional storage checks at the claim and unpaid-maintenance checkpoints. After the real 1 ETH
winner, A held only **0.017597251623779500 ETH** operating cash against **1.00542 ETH** inventory reserve. Claiming its
**0.000585195725990812 ETH** credit preserved that operating cash exactly. Replacement V2 activated with maintenance
exposure **0.00368 ETH** and zero maintenance shortfall while the 1 ETH inventory deficit remained. A separate unpaid
case held **0.030390297967683406 ETH** entirely as credit, preserved it through maintenance, then claimed it with operating
cash still zero. Existing listing-price preservation is covered by retained Solidity regressions, not a new assertion
in this driver. Gas regimes included 3 and 4.9 gwei, four 8 gwei rounds skipped as unprofitable, and resumed keeper
operation after gas fell. No keeper revert occurred.

Randomness was controlled by impersonating the real fork coordinator for callbacks selecting small prizes and then
the explicit 1 ETH prize; one request deliberately received no word and expired. The coordinator used its actual fork
balance; its state and balance were not replaced or topped up. This tests real local settlement/refund transfers under
those conditions, not live oracle availability, outside ability to force expiry, MEV, demand or profit distributions.
Keeper ticks were explicitly driven, rather than asserting CLI scheduling. Trusted Shape delivery failure was not
artificially forced, and the fresh exercise did not manufacture another hostile-NFT failure; retained focused custody
and recovery tests keep their original source scope.

The final source check matched all **146 inputs, ten full artifacts, executable hashes and pinned dependencies**.
Read-only postflight re-fetched all 419 receipts and current retired pool balances. The execution log and journal carry
the successful completion markers. The original terminal session expired across context continuation before its OS
exit status could be recovered; that status is **unavailable**, rather than reported as a captured zero. The separate
postflight command exited 0. [Execution output](receipts/current-rehearsal/20261118195158615-0065ec4/execution-command.log).
The `feb71f6` delivery was an output-only descendant of the frozen candidate. The later creation replacement fix has
its own source manifest and targeted checks; this rehearsal is not relabeled as exercising that later patch.

The [first failed preparation](receipts/current-rehearsal/20261118193325396-855c926/STATUS.md) rejected source-map/ID
artifact drift caused by a staged library symlink; bytecode was unchanged and the node remained unfunded. The repaired
stage copies verified tracked dependency sources into ordinary directories and preserves timestamps. The next packet
passed preparation but was [superseded before execution](receipts/current-rehearsal/20261118194607091-6b5f742/STATUS.md)
to seal the actual Forge executable behind its unchanged mandatory guard. Both packets, pristine-node proofs, warnings
and failures are retained. All production guards, archived signatures/plans and strict mismatch checks remain intact.

## Verification

Final frozen candidate `0065ec4`: `CANDIDATE_RUN=1 npm run test:ts` passed **188 tests**, with four opt-in skips across
17 files. All 27 distinct focused frontend cases passed separately, including the real-fork receipt failures/timeouts.
Typecheck, production app build, 32 current/legacy gate cases and applicable CI fork suite (9 cases) passed. The existing
large-chunk build warning is retained. `forge build --sizes` passed: PoolBalancer **20,516 bytes**, 4,060 below EIP-170.
[Commands, results and scope](verification/frontend-followup/checks.json). No unrelated broad audit campaign was repeated.

The [production manifest at that delivery](https://github.com/ripe0x/shapes-pool-balancer/blob/feb71f652e49c1d7faa9a8b9af09d666c752b282/docs/verification/protected-revenue/manifest.json) covers all 29 production files, including the
three frontend helpers, with fingerprint `54cada588b35987b8c82cacdd469e696248c5d0db4bcdca7da29954ef0602e2a`.
Its scope is narrower than the 146-input rehearsal fingerprint. Historical reports retain their original evidence.

## Documentation corrections

New revenue requirements are uniquely numbered **R62–R69**. Historical **R59–R61** and their meanings remain byte-identical;
current references were updated, while historical approval references were preserved. R70 records this focused follow-up.

The implementation report and current reserve summary now explicitly identify creator-selected `ReserveReviewMaxPolicy`
at maximum-paying behavior, withheld randomness and advancement past expiry. At basefee **0.0005 gwei**/bid **0.001 gwei**,
reward was **0.000050253116 ETH** and buyer plus keeper gained **0.000047094427 ETH** from creator operating cash.
The creator/buyer/keeper combined loss of **0.000003158689 ETH** reconciles gas/VRF costs; it does not neutralize the
outsider gain or establish creator protection. These are real local transfers under the selected policy and missing
randomness. They do not establish that an outside buyer can force expiry with a normally operating oracle. All original
measured figures and historical source associations remain preserved.

## Limits and things that don't make sense

The old transport request may still finish after a context switch; its result and queued follow-up cannot publish.
Creation verification uses current pool terms and ownership. An owner changing those terms before recovery can leave an
explicit mismatch requiring inspection. Browser checks use the development connector and synthetic funds, not real
wallet signing. No new economic-design issue was identified in this focused follow-up. Live oracle timing, production
release approval and any public canary remain outside this authorization.
