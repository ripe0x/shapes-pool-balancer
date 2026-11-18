# Frontend corrections and current candidate rehearsal

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
creation submission helper. Successful recovery reads come from the retained real FWA fork. The planned fresh rehearsal adds
actual pending and reverted receipt probes; those are recorded separately below.

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
  **12.34%** through reload despite a different suggested rate and submitted exactly1234 bps above.
  [Editor before](verification/frontend-followup/rate-before.txt), [after](verification/frontend-followup/rate-after.jpg),
  [projection](verification/frontend-followup/rate-overview-after.txt),
  [rate receipt and stored readback](verification/frontend-followup/rate-change-readback.json),
  [draft after reload](verification/frontend-followup/draft-after-refresh.txt).

## Current candidate wrapper rehearsal

Preparation and final candidate verification are in progress. No completion is claimed here until the frozen current
packet, canonical wrapper execution, receipts, readbacks and final accounting have been recorded.

## Documentation corrections

New revenue requirements are uniquely numbered **R62–R69**. Historical **R59–R61** and their meanings remain byte-identical;
current references were updated, while historical approval references were preserved. R70 records this focused follow-up.

The implementation report and current reserve summary now explicitly identify creator-selected `ReserveReviewMaxPolicy`
at maximum-paying behavior, withheld randomness and advancement past expiry. At basefee **0.0005 gwei **/bid **0.001 gwei**,
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
