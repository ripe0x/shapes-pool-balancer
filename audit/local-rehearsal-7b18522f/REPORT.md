# Approved local batch: interrupted before pool creation

**INTERRUPTED, not a completed rehearsal. No real funds or public-network transactions.** Approved plan `7b18522f49bd0809180bc7643969ffcc32d07d4d44e259053d926112f244a236`, executable revision8886048. Endpoint `http://127.0.0.1:18556`, owned Anvil PID50886, chain31337, fork block26,438,875. The owner said “yes approved”; the lead stated its interpretation of the pending exact-batch approval before execution. The separate approval record is under `docs/receipts/rehearsal-04bc760-preparation/approved-batch-7b18522f.json`. This is not an SSH signature or production release approval.

Command: `node --import tsx scripts/run-local-rehearsal.ts --approved-plan-hash 7b18522f49bd0809180bc7643969ffcc32d07d4d44e259053d926112f244a236`. Exit1 with `TransactionReceiptNotFoundError` for the submitted DemoNFT creation. Original journal/logs are byte-preserved under `original-run/`. No failed transaction was replayed.

## Actual outcome scorecard

| Flow/state | Confirmed result |
| --- | ---: |
| One-time synthetic wallet funding | 47.43 test ETH across eight roles; no protocol/coordinator funding |
| System deployments | 8 successful, with original postflight exact runtime/wiring checks |
| First DemoNFT creation | Successful, nonce0 of creatorA; exact input/runtime hashes and predicted address verified separately |
| Actual transactions through block26,438,884 | 9, all known; no other transactions in the local interval |
| Aggregate transaction gas cost | 0.002123978546527748 test ETH |
| Remaining1ETHgas allowance | 0.997876021453472252 test ETH; not permission for a replay |
| Actual pools / pool deposits / buyer payments / draws | 0 /0ETH /0ETH /0 |
| Actor balances | Each equals approved one-time funding less its actual receipt gas; deployer nonce8, creatorA nonce1, other roles nonce0 |

The original journal has one setup placeholder under `pools`, created before its first DemoNFT transaction. It is not an actual pool: `createBalancer` was never sent. No inventory, purchaser escrow, creator profit or keeper reward flow was reached. Real balances and exact gas/creation readbacks are in `reconciled-receipt-and-balances.json`; the first RPC receipt readback is in `interruption-readback.json`.

## Cause, repair and limits

The driver called immediate `getTransactionReceipt` after `sendTransaction` returned a hash. The receipt was temporarily unavailable; later read-only reconciliation found the same transaction mined successfully. A canonical receipt matching the expected sender/nonce/value/calldata/creation address/runtime validates execution, not success of the interrupted lifecycle.

`record()` now uses `waitForTransactionReceipt` with30,000ms timeout and100ms polling, and explicitly requires the returned transaction hash to equal the submitted hash. Waiting submits nothing and cannot silently substitute a replacement receipt. Existing sender/nonce/input/value/target/status/runtime/gas checks remain. Typechecking passes. Actual read-only receipt waiting and input/runtime/balance checks pass against the already-mined transaction. The pending-mining polling branch after this repair has not been exercised by a new transaction.

Independent focused review found no must-fix in the two-line repair and confirmed the original journal must remain interrupted. It made no RPC request or send and is not a whole-candidate audit or seal. The original hash binds earlier driver/document bytes, so it is invalid for further execution after repair. No continuation, redeployment, pool creation, new purchase, additional funding or cleanup send was attempted. The node, synthetic balances and deployed contracts remain preserved for a separately prepared, reviewed and explicitly approved continuation.

Production contract code/bytecode and production release gates are unchanged. The original current-source whole audit, outcome signature and wallet/oracle gaps remain. Integration into main is not release authorization.

## Things that don't make sense

- A returned transaction hash is not proof its receipt is already readable.
- A setup placeholder is not an actual deployed pool, and successful deployment is not a completed rehearsal.
