# Creation cancellation and replacement recovery

Focused follow-up to PR 10 at `feb71f652e49c1d7faa9a8b9af09d666c752b282`. The fetched remote head matched that
revision, open and draft. Earlier history, rate, contract accounting, economics and rehearsal findings stay closed
within their recorded scope. This patch changes only the creation helper, its React caller and focused regressions.
No contracts, dependencies, compiler/profile, economic terms, production configuration or release controls changed.

## Behavior

The existing creation draft now retains the original submitted hash, latest replacement hash, observed transaction
nonce and submission block. The nonce is trusted only after reading the actual original transaction and matching its
sender, factory, exact reviewed calldata and value. A pre-wallet nonce estimate is never used as proof.

The creation-only receipt waiter persists viem replacement callbacks and the returned receipt's transaction hash.
The caller reports confirmation only after factory registration, creator, reviewed configuration and FWA pool ownership
verify the expected pool. A successful self-cancellation receipt cannot produce `Create pool: confirmed`.

After timeout or reload, recovery first checks the pool, then the saved transaction. When the original is absent but
its nonce was observed, standard historical account nonce reads locate the first consuming block by binary search.
Recovery requires the actual same-sender/nonce transaction and its canonical receipt. It does not depend on
`eth_getTransactionBySenderAndNonce`, a live callback, an indexer or a general transaction journal.

An absent pool plus a canonical cancellation, different nonce-consuming transaction or reverted receipt permits
returning to the saved design under the existing account/chain/factory checks. Pending, ambiguous or unavailable
evidence remains unresolved and cannot resubmit. Submission-version checks protect persistence, clearing and outcome
publication against stale responses, including another tab retrying the same design. A real pending case caught a
new fallback overwriting its known transaction with an empty search result; the repair preserves that pending state.

## Real replacement cases

Owned child Anvil PID 14847, `http://127.0.0.1:18795`, chain 31337, forked the retained owned UI fixture at block
26,382,399/hash `0x3cf592fb018c2ef796f08cc02d8f3e8ac490e5e441bb222a3f6e0e1773117072`.
Parent 18766 and canonical rehearsal node 18789 were not mutated. The child used fresh zero-code actor
`0x00000000000000000000000000000000000ce001`, funded once with 0.2 synthetic ETH. No protocol balances or state
were fabricated. All successful RPC answers came from actual deployed contracts; failure injection only rejected reads.

| Actual inclusion case | Recovery result |
|---|---|
| Valid creation replaced by successful empty self-send | `cancelled`; callback identity persisted; reload and original-hash retrospective recovery passed; NFT stayed with creator at cancellation |
| Same-calldata, higher-fee replacement with invalid rate 10,001 | `InvalidConfig` preflight; same-calldata replacement mined reverted; replacement identity, reload and original-hash retrospective recovery passed |
| Another transaction mined after a bounded pending receipt wait rejected | `replaced`; retrospective recovery passed without an active callback |
| Same-calldata, higher-fee valid atomic creation | `confirmed` only after real factory/pool verification; 1234 bps, 0.025 ETH deposit and actual NFT custody verified |

The test decodes `InvalidConfig` from actual preflight, then checks the replacement's reverted receipt; it does not decode a mined revert trace.
The deliberate invalid-rate inclusion is a helper regression for a real reverted receipt; the ordinary UI simulation
would reject that invalid draft before broadcast. The test does not claim a valid simulated creation spontaneously reverted.
Missing original identity, unavailable historical reads and changed account/chain/factory remained locked. Clearing a
verified terminal attempt made the submission helper reachable again; the test then deliberately rejected the wallet
request, so no extra creation was sent.

| Money and custody | Actual synthetic result |
|---|---|
| Submitted transactions / mined receipts | 11 / 7; four original transactions replaced; six successful receipts and one intentional revert |
| Gross submitted creation values / actual deposit | 0.075 / 0.025 ETH |
| Cancelled, unrelated and reverted creation deposits | Zero |
| All seven mined transactions' gas | 0.000351298612583226 ETH |
| Actor balance | 0.2 → 0.174648701387416774 ETH; difference equals deposit plus all gas exactly |
| NFT | Actual DemoNFT 2026111901 remained creator-owned at cancellation; later valid replacement transferred it into its intended FWA pool |

[Transactions and receipts](verification/creation-replacement/transactions.json),
[absolute balance scorecard](verification/creation-replacement/scorecard.json),
[read-only receipt/state postflight](verification/creation-replacement/postflight.json),
[fixture controls and exact command](verification/creation-replacement/README.md).
Limits were 11 transactions, 4M gas each, 2 gwei maximum fee, 0.088 ETH maximum gas-limit exposure and 0.1 ETH submitted
value cap. Gas prices and initial basefee are recorded from the executed path, not inferred from a view-only quote.

Preparation rejected an empty curated batch and then a reused actor with EIP-7702 delegation, both before broadcasting.
The zero-code check was retained. The next run stopped after mint, approval and pending original A when it exposed the
pending-state bug. Its exact snapshot and failed log are preserved. After repair, one narrowly guarded continuation
verified both canonical setup receipts, the unchanged actor balance/custody, head and exact pending A before proceeding
to replacement B. It did not fund again, reset the node or replay A. The same original batch completed within its limits.

## Browser and checks

The isolated preview restored the actual recorded creation attempts into draft storage as test setup. The surrounding
draft is a partial fixture, not a restoration of the original Shape mix. The production app
then read the real child node. It replaced original A's displayed hash with mined B, showed cancellation or revert,
retained B through reload/reconnect, enforced the disconnected context guard and offered `Return to saved design`.
That action opened the saved draft with the recorded NFT/value and 12.34% choice. No browser transaction was sent.
The NFT had subsequently moved in the separate successful fixture case, so this browser check does not assert that it
was still available to retry after the complete fixture. No extension-wallet Cancel interaction is claimed.

[Cancellation screenshot](verification/creation-replacement/browser-cancelled.png),
[cancellation after reload](verification/creation-replacement/browser-cancelled-after-reload.txt),
[returned design](verification/creation-replacement/browser-returned-design.txt),
[reverted replacement](verification/creation-replacement/browser-reverted.png),
[revert after reload](verification/creation-replacement/browser-reverted-after-reload.txt).

A separate read-only regression deliberately made only receipt RPC calls stop answering for an already-mined
replacement. The actual viem waiter was required to throw `WaitForTransactionReceiptTimeoutError`; JSON reload then
recovered B from the original A through real historical reads. No further transaction was sent.
[Explicit timeout result](verification/creation-replacement/receipt-timeout-readback.json),
[passing timeout test](verification/creation-replacement/receipt-timeout-readback.log).

`npm run test:ts` passed **189 tests**, with six opt-in skips across 18 files. The actual replacement test separately
passed all four regimes; the existing creation suite separately passed **13/13**, including real receipt failure and
timeout recovery. Typecheck and production app build passed, retaining existing bundle warnings. The new version guard
regression and real pending case exercise production orchestration, not a separate test-only scheduler.
[Commands, exit statuses, failures and limits](verification/creation-replacement/checks.json).

Independent static review covered the production patch and affected repairs, including the stale cross-tab outcome
publication guard. The [production manifest](verification/protected-revenue/manifest.json) covers the final source;
its fingerprint is `f202dd7009c2ae3f0ec80226b1b3c97ad51b15ee8d1cc66ea42c1ccca855f00b`.
The previous manifest and full rehearsal remain associated with their immutable prior revisions. No second full
contract campaign or wrapper rehearsal was requested for this focused frontend fix.

## Limits and things that don't make sense

If the original disappears before its actual nonce is observed, neither a wallet nonce guess nor an unrelated mined
transaction can safely prove cancellation. That attempt remains explicitly unresolved. An unavailable historical RPC
or canonical receipt also leaves it unresolved. These limits favor avoiding duplicate creation over guessing a retry.
Local inclusion was controlled and used unlocked synthetic actors; it does not establish public gas-market ordering or
extension-wallet signing. No newly unresolved discrepancy remains in the exercised scope. No public deployment, real
spending, production configuration change, merge or new release approval is included.
