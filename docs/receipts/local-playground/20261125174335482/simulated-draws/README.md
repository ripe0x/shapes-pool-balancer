# Owner-authorized simulated local draws

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
