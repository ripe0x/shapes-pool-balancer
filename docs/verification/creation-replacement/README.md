# Creation replacement regression fixture

Executed test: `app/src/creation-replacement.test.ts`. All four replacement regimes passed through the exact continuation below; see `replacement-regressions.log` and `scorecard.json`. It is skipped unless explicitly opted in. No transactions were broadcast during preparation. The completed records now reject both ordinary replay and continuation.

```sh
CREATION_REPLACEMENT_RPC=http://127.0.0.1:18795 CREATION_REPLACEMENT_BROADCAST=1 ./node_modules/.bin/vitest run app/src/creation-replacement.test.ts
```

The test verifies its recorded owned child node through the actual PID command, `anvil_nodeInfo`, pinned starting block and deployed factory. It asserts fresh external actor `0x00000000000000000000000000000000000ce001` has zero code, nonce and balance, then funds it with exactly **0.2 synthetic ETH** and impersonates it on this child only. This external-wallet setup adds no transaction and changes no protocol state. Parent node `18766` and canonical node `18789` are never mutated. Node PID, arguments, parent block and log path are in `node.json`, an immutable preparation snapshot whose `broadcasts: 0` is the preparation count. Final submitted and mined counts are in the completed journal and scorecard. The child remains running with automatic mining disabled; the test explicitly mined its own transactions.

The batch has four original/replacement pairs: cancellation, repriced deliberate invalid-rate revert, unrelated replacement after a real receipt wait timeout, and repriced successful atomic creation. One real DemoNFT is minted, approved for the cancelled original and later approved for the successful original. All successful RPC responses come from real deployed contracts. Failure injection only makes historical transaction RPC calls fail.

Bounds: **11 transactions**, gas limit **4,000,000** each, maximum bid **2 gwei**, total submitted gas-limit exposure **0.088 synthetic ETH**; total submitted creation values **0.075 synthetic ETH**, actual successful pool deposit **0.025 synthetic ETH**. Failed/replaced submissions transfer no deposit. Setup receipts count toward gas use and the final creator balance reconciliation. NFT custody must remain with the creator after cancellation and end in the real FWA pool after successful creation.

`transactions.json` is written progressively by the actual test; its existence prevents an accidental second broadcast batch. `scorecard.json` is written only after all cases and the absolute creator balance check pass. A failed run retains its receipts and does not authorize cleanup or another batch. The initial failed empty-curated simulation is retained in `preflight-empty-curated.json`; it caused no broadcast.

One bounded continuation is available for the interrupted three-send checkpoint, whose raw snapshot and failure log remain in `interrupted-after-3-sends.json` and `failed-pending-status.log`. That run mined NFT mint and approval, then submitted original creation A at nonce 2. It found a recovery bug that discarded an actually pending transaction; the helper was repaired before continuation.

```sh
CREATION_REPLACEMENT_RPC=http://127.0.0.1:18795 CREATION_REPLACEMENT_BROADCAST=1 CREATION_REPLACEMENT_RESUME=1 ./node_modules/.bin/vitest run app/src/creation-replacement.test.ts
```

This flag accepts only the exact saved three-send file, its two canonical successful setup receipts, head block, actor latest nonce 2/pending nonce 3, pending original hash and full transaction payload, unchanged creator NFT custody and absent pool. It verifies the actor's balance is the original 0.2 ETH minus those two real gas charges. It reuses the existing counters and original A, without funding, impersonating, mining setup, minting, approving or resubmitting A. The next transaction is replacement B; all remaining work stays inside the original 11-transaction and money bounds. Any other checkpoint is rejected. Default execution still rejects existing evidence.

An additional read-only test uses the completed replacement record. It makes only receipt RPC calls never answer, requires the actual viem `WaitForTransactionReceiptTimeoutError`, then reloads original A and discovers already-mined B through real historical reads. It writes `receipt-timeout-readback.json` only after passing. The original late-replacement case proves a bounded wait rejection before B is submitted; this separate test proves the specific timeout error. Both integration tests skip by default.

```sh
CREATION_REPLACEMENT_RPC=http://127.0.0.1:18795 CREATION_REPLACEMENT_READBACK=1 ./node_modules/.bin/vitest run app/src/creation-replacement.test.ts
```

Limits: helper tests cover the terminal retry predicate and submission boundary after clearing program state. They do not exercise React draft clearing or wallet UI. Real node inclusion ordering is controlled on this isolated child and does not reproduce the public gas market.

Things that don't make sense: the initial empty-curated assumption was disproved by real preflight (`InvalidBatch`). Root's first opt-in run also found EIP-7702 delegation on the reused creator and failed before mutation or broadcast. Both failures and the delegated-account readback are retained here; the zero-code guard remains and the actor is now fresh. No remaining fixture anomaly is known at preparation.
