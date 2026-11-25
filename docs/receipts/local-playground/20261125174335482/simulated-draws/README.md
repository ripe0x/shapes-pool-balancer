# Owner-authorized simulated local draws

**Current result:** 20 distinct NFT wins verified, zero additional capital deposited, and the real paid keeper is running for this pool. Full restocking remains incomplete: the last 0.05 ETH Shape win leaves one slot missing and a 0.022612951932364688 ETH working-capital shortfall. Purchases remain open. See `summary.json`. Earlier checkpoint details below are historical; the continuation supersedes their pending-run status.

The owner explicitly authorized simulated randomness only for Balancer `0xE0C94BA1ECD2380df5b90eB515D115a3365BB8F4`, FWA pool `0x802d4E8D7315a4B7ceA1ba97e8BbE271fAa3F581`, on the existing 8545 fork, chain 31337. Requested outcome: 20 actual NFT wins with restocking, helper committed. This exception does not apply to genuine proof evidence, a production release, other pools or networks.

Helper: `scripts/local-simulated-draws.ts`; baseline revision `96cbcf3`. Fixed PID 28171, fork block 26485619, original Tenderly fork command, factory, pool, buyer and service/coordinator hashes. Caps: 20 new draws, 100 transactions, 1 test ETH forward purchase payments and 1 test ETH aggregate gas. No funding, code injection or storage edits. The separately requested 0.5 test ETH top-up remains subject to explicit owner approval and its own one-time flag.

## Verification and bounded claims

- Typecheck passed after initial tuple/ABI typing corrections. A read-only preview initially rejected lsof's file-descriptor output; PID filtering was corrected and preflight passed. No transaction preceded these repairs.
- Independent scoped review found an internal mapping incorrectly assumed to have a public getter, and zero-input calldata decoding returns undefined args. Both repaired before broadcasts. A real ABI round-trip regression covers empty arguments; independent repair review found no further actionable issue.
- First boundary test run: 4 passed. Resume/top-up repair: typecheck exit 0; affected test file exit 0, 5 passed. No mocked successful RPC answers.
- Exact execution: `node --import tsx scripts/local-simulated-draws.ts --execute --allow-simulated-randomness`. Actual transactions and snapshots are preserved in journal.json. Five old, already-expired own-pool requests received late simulated callbacks: their acquisition/refund/proceeds states did not change.
- The first new acquisition fulfilled and delivered Shape #1748, worth 0.05 ETH, to synthetic buyer 1e008. Actual ownerOf, fulfilled request, sold listing and owner proceeds were checked. First unpaid upkeep collected/reconciled the sale, but the pool lacked capital to replace the 0.05 ETH Shape. The next upkeep simulation reverted NoUpkeepNeeded; no second noop transaction was sent. This failure is preserved and is not a claim of completed restocking.
- At interruption: operating cash 0.021175149302304881 ETH; required reserve 0.05093924893934 ETH; shortfall 0.029764099637035119 ETH. Creator credit 0.002386893731696565 ETH is separate from operating cash. No additional capital has been sent as part of the initial run.
- Resume reconciles actual successful receipts, calldata, gas/spend totals, current request sequence, fixed runtime/target and already-won NFT ownership, then continues the remaining count. It does not repeat the first purchase/callback. The separately gated exact top-up verifies it adds operating cash without adding creator earnings. Independent review found no actionable issue in that repair. Resume execution awaits the owner decision.

## Simulation limitation

The callbacks use test words derived from request IDs independently of prize selection. They bypass the real coordinator's proof verification and billing. Each real coordinator request commitment is checked to remain pending even though the service marks delivery complete. No claim of authentic VRF fulfillment, unbiased frequencies, paid-keeper profitability, subscription billing/coverage, oracle liveness or production economic release readiness follows from this run. Upkeep is explicitly unpaid; the synthetic buyer bears gas.

Things that do not make sense: the initial operating budget cannot immediately restock this first 0.05 ETH win. It is a real capital shortfall, not a missing NFT delivery. Shared service counters after simulated callbacks do not represent genuine coordinator completion.

## Correction, real keeper and completed draws

The initial stop required full restocking after every draw. That was an agent-selected condition, not an owner requirement or the contract's admission policy. It was corrected: each new purchase still requires actual admission status 0 and no unsettled request; partial inventory is explicitly recorded, and the final exact target assertion remains. No test word was changed to favor a cheap prize, and no capital was injected to hide the shortfall. The first missing 0.05 ETH Shape was later replenished from subsequent draw proceeds.

At the owner's instruction, restocking now uses the existing `Keeper` class with its real profitability simulation, paid `performUpkeep`, actual receipt accounting and source-defined minimum payment protections. The keeper is funded synthetic account 1e004, distinct from the buyer 1e008 and creator ripe0x.eth. It was ticked sequentially during the run and remains as a background watcher afterward. Its pre-send guard refuses other pools, checks local identity/runtime, and combines the draw gas with actual keeper cost and pending/accounting reservations. Both sides retain the aggregate 1 ETH gas and 100 transaction bounds. The keeper does not bypass insufficient capital or fall back to unpaid upkeep. No extra operating-capital approval was received or used.

One purchase attempt after the idle interval reverted `TransactionExpired`: Anvil's latest block timestamp lagged the next mined block, although the call simulation accepted the old deadline. The failed receipt/trace and gas remain preserved in `deadline-revert.json` and the execution log. Its native value was reverted and is excluded from actual purchase spending. Resume accepts only that exact decoded known failure with matching calldata/deadline, block/hash, nonce, sequence and NFT ownership. New deadlines use max(chain time, wall time) + 600 seconds. The conservative purchase cap still includes the failed attempt's requested value.

Affected verification: typecheck exit 0, final focused boundary tests 8 passed, and independent focused review of keeper integration and deadline/resume repairs found no further actionable issue. The 20-draw continuation reached the final target assertion and exited 1 because one 0.05 ETH Shape was still missing. That failed final assertion is retained; the run is **not** reported as fully restocked or release-qualified. All 20 successful acquisitions are terminal Fulfilled, their selected NFTs are owned by the test buyer, all 20 token identities are distinct, and all 25 total FWA sequences (five earlier expiries plus 20 new wins) are reconciled with zero unsettled acquisitions.

| Observed outcome | Amount / result |
| --- | --- |
| Actual successful purchase payments, including service fees | 0.470438084109075683 test ETH |
| Forward-cap usage including the reverted attempt | 0.493574597398852833 test ETH, below 1 ETH |
| All draw/callback/manual-initial/keeper gas | 0.023315821354911064 test ETH, below 1 ETH |
| Actual transactions | 66, including one reverted purchase; below 100 |
| Real paid keeper | 19 successful calls, zero reverts |
| Keeper compensation / gas / net | 0.001634808977375438 / 0.000794793649846330 / +0.000840015327529108 test ETH |
| Creator earned credit | 0.046236887919508480 test ETH |
| Operating ETH / required | 0.028325548474045312 / 0.050938500406410000 test ETH |
| Missing capital for the final target | 0.022612951932364688 test ETH |
| Additional capital deposited | 0 ETH |
| Final listed prizes / target | 13 / 14; one 0.05 ETH Shape missing |
| Purchase status | enabled, admission 0 |

`keeper-state-at-completion.json` is an immutable receipt/accounting snapshot. `keeper-state.json` is ignored mutable runtime state. Run only one keeper process for that state/signer. Background mode is `node --import tsx scripts/local-simulated-draws.ts --keeper`; the draw process must be finished before starting it. This watcher is confined to the current authorized pool and existing remaining test budget.

Final helper SHA-256: `cc22836e0d8ea53e4a43c9c0c22da3101e7d238983e7ba7faccc68a46fbdb1ae`. Parent checkpoint: `2c1c51e`. No protocol source, UI, ABI, owner revenue share, policy setting, reserve setting or deployment was changed in this continuation. The full economic campaign remains separate.

Things that do not make sense: a keeper cannot fund a large replacement when operating cash is short. Replenishment can recover from later sales while admission permits them, but these 20 draws ended with another shortfall. The earlier mandatory per-draw full-restock condition was too strict and is no longer confused with a contract pause.
