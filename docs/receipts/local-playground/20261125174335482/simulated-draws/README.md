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

## Exact ETH reconciliation requested by the owner

Read-only analysis at revision `b2fa486`, pinned to completed-run block 26485974. Queried actual Balancer events from its creation at block26485869 through the completed20draw boundary: Deposited, ProceedsCollected, ShapesMinted, ItemDrawn, KeeperPaid and SurplusClaimed. Used fixed denomination backing amounts from shared/planner.ts and the verified mint-cost source; each ShapesMinted cost minus the independently calculated denomination backing is its mint fee. Matched actual collected proceeds to the 20 request-time owner bases; matched paid keeper events and all ending cash. `eth-reconciliation.json` contains exact wei values. All three balance checks exit0: creator cash flow, minted backing minus prizes won, and total input destinations. No RPC broadcasts, state edits, extra draw or contribution occurred.

Initial creator deposit 0.420734 ETH plus 20 purchase payments 0.470438084109075683 ETH equals 0.891172084109075683 ETH. Destinations: buyer prize backing 0.37; listed backing 0.36; protected creator credit 0.046236887919508480; operating cash 0.028325548474045312; Shapes mint fees 0.018 (0.008 setup and0.010 replacement); keeper pay0.001634808977375438; accrued FWA protocol fees0.020173162268546453; VRF service fees0.0468016764696 ETH. Exact unexplained difference: 0 wei. There were no capital top-ups or withdrawals. NFT backing remains inside Shapes backing contracts attached to actual held NFTs, not loose ETH in the recipient wallet. Mint fees accrue in Shapes; FWA protocol fees remain accrued in the FWA pool; VRF service fees are service treasury revenue, not measured authentic Chainlink billing.

The pool received0.403463245370929230 ETH after FWA/service fees. Its realized operating result after all0.37 ETH prize backing won,0.010 ETH replacement mint fees paid and0.001634808977375438 ETH keeper pay is+0.021828436393553792 ETH (before setup fees and walletgas). Yet the11.46% revenue allocation protected0.046236887919508480 ETH as creator credit. Creator credit is a liability calculated on collected revenue; it is not capped by cumulative realized profit or by fully funded target restocking. This is why total Balancer cash0.074562436393553792 ETH can exceed the0.050938500406410000 ETH target reserve while only0.028325548474045312 ETH is usable for maintenance.

Actual winners:15 prizes at0.01 ETH,4 at0.05 ETH,1 pack at0.02 ETH =0.37 ETH. Current reserve breakdown, independently recalculated against live block26485974 parameters:0.0505 ETH missing-prize backing plus mint fee,0.00007550010323 ETH listing budget,0.00036300030318 ETH working buffer; total0.05093850040641 ETH, exactly matching the contract. The remaining liquidity gap is0.022612951932364688 ETH. A subsequent owner decision is needed to change credit economics; no such change is made here.

Wallet gas is outside the pool-capital table: actual20draws and maintenance0.022830673535173452 ETH; old-expired-request simulated callback cleanup0.000450047805257704 ETH; one reverted transaction0.000035100014479908 ETH; total0.023315821354911064 ETH. Fees and profitability reflect this simulated-oracle local run only.

Things that do not make sense: a revenue-based creator entitlement can exceed this sample's realized profit and coexist with an underfunded replacement. ETH conservation alone does not show that the allocation matches a reserve-first business goal.

## Owner-requested additional-count command

User asked for a command to run X further draws; no additional draws were broadcast by the agent in this change. Added explicit `--additional X` preview and `--execute --allow-simulated-randomness --resume --additional X` execution, scoped to1..10 and the same node/pool/actors. No original purchase/gas/transaction cap resets. A fixed append-only extension target survives recorded partial progress. The background keeper remains PID74403; additional mode never starts or ticks another keeper and reports actual requested wins separately from full-restock state. Historical20-draw final/complete/keeper snapshots are retained. Snapshot reads pin a single block; actual ProceedsCollected events handle concurrent keeper collection when verifying sale proceeds.

Independent review identified that reciprocal budget reads alone could race with the existing background keeper. The affected repair publishes a provisional nextAction gate before checking budget/simulation, then reads keeper state and its mtimeNs from the same open file descriptor. It requires a strictly newer completed tick with empty pending/accounting queues before spending; the existing keeper already honors nextAction. The gate remains until receipt accounting, clears on known pre-broadcast failure, and stays for uncertain broadcasts. A single-writer lock prevents concurrent draw processes. Independent affected-repair review found no further actionable issue.

Verification at parent revision b2fa486: `npm run typecheck` exit0; `npx vitest run scripts/local-simulated-draws.test.ts` exit0,10 passed before the gate repair; read-only `node --import tsx scripts/local-simulated-draws.ts --additional 1` exit0 with broadcast=false. After repair, typecheck exit0 and affected keeper tests exit0 (2 passed,9 skipped). Unchanged earlier boundary evidence is reused. The new execution mode/gate handshake has not been exercised by an additional onchain purchase; the command is supplied for the owner to run. SourceSHA256 `165c0f54d2410f2195909b2ae7e2be769e57fe2ae315b2b13239ed020181a940`.

Things that do not make sense: preserving the original100-transaction cap means later commands may have room for fewer than ten draws. A completed draw count is explicitly separate from full restocking.
