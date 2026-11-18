# Approved local batch after the independent audit

**The authorized batch completed, across resumed attempts. Mainnet remains blocked.** The supplied audit was reviewed first. The batch then exercised unchanged candidate `9b45f915fcaa27bc24d6125cf4a0062117ef576c` on the isolated Anvil fork at http://127.0.0.1:18554, chain 31337, pinned Ethereum block 26,437,802 from https://mainnet.gateway.tenderly.co. Final readback was at local block 26,438,542. No public-network broadcast, real funds, publication, production repair or policy change occurred.

The [audit disposition](INDEPENDENT-AUDIT-REVIEW.md) and [unaltered supplied report](../audit/independent-9b45f91/REPORT.md) remain separate from this operational evidence. E1 creator allocation, E2 fee-receipt measurement, S2 staged-inventory admission and S4 policy previews remain open. This run did not reproduce their experiments or close their findings.

## One-screen scorecard

All amounts below are synthetic ETH on this isolated fork.

| Check | Actual result | Scope |
|---|---:|---|
| Production deployment | 8 mined transactions; 0 native deployment value | Unchanged Deploy.s.sol, exact role/wiring and actual code checks |
| Pools / deposits | 2 / 6 ETH total | Exactly 3 ETH each, no later deposits |
| Rehearsal | 50 rounds / 152 issued draws | Every actual FWA sequence matched exactly once to the journal; limit 252 |
| Draw outcomes | 65 prizes delivered; 87 slippage refunds | Actual buyer NFT ownership or exact refund event/credit checked; every authenticated word delivered |
| Purchaser refund credits | 2.400431303075223482 ETH | Remain at FWA, not creator capital; withdrawals were outside this batch |
| Pending draws / delivery escrow | 0 / 0 ETH | Both pools fully reconciled |
| All transaction gas | 0.203466407875872872 ETH | Includes deployment, setup, buyers, keeper, coordinator exception and retry; limit 1 ETH |
| Keeper | 54 successful transactions; 0 reverted | 0.04575608195 reward − 0.03867335149 gas = **+0.00708273046 ETH**; actual balance delta agrees exactly |
| Keeper state reloads | 2 | Actual Keeper class with persisted state; controlled ticks, not a new CLI process |
| Gas phases | 38 normal; 4 each at 3, 4.9 and 8 gwei basefee | Paid work at/below cap; no keeper sends above 5 gwei, resumed at lower fees |
| Actual remaining Shape backing | 0.4 ETH per pool | Full target 5×0.01 + 3×0.05 + 2×0.1; actual FWA custody and Shape backing read |
| Runtime / transaction gas limit | 24,449 bytes / maximum 7,023,660 gas | Below EIP-170 and EIP-7825 limits |
| Final checks | Typecheck and read-only canonical receipt/bucket check passed | Production source, ABI, planner, keeper, app, tests and economic outcomes unchanged |

The **87/152 = 57.2% slippage-refund rate** is a player-experience concern for this small-board, one-to-five-draw batching configuration. FWA correctly rejected positive price drift beyond 10%; buyers retained acquisition refund credit, while their randomness fee remained spent. The driver initially assumed every delivered word must win a prize; that assumption was wrong. Correctly handling refunds establishes purchaser entitlements, not satisfactory product behavior or representative market demand. No curated NFT was won or relisted, and no Pack was used in this batch.

## Final buckets

These are actual holdings beside contract-reported counters, not a validation of request-board creator entitlements. Profit is included in Balancer cash, and withdrawable surplus is a view on that cash, so these columns must not be added together. Unsold restocking charges are future pricing expectations and are excluded from liquid cash.

| Bucket / counter | Creator D005 pool | Creator D006 pool |
|---|---:|---:|
| Balancer liquid ETH | 2.717027343900840816 | 2.933226534976083407 |
| Booked creator profit, included above | 0.025595355148303397 | 0.020492628305502233 |
| Required operating reserve at final 0.08 gwei basefee | 0.001454 | 0.001454 |
| Contract-reported withdrawable surplus | 2.715573343900840816 | 2.931772534976083407 |
| Listed Shape backing, separate from cash | 0.4 | 0.4 |
| FWA purchaser refund credits | 1.260299891746668665 | 1.140131411328554817 |
| FWA protocol fees | 0.037741813727542024 | 0.047808684313804155 |
| FWA owner proceeds / acquisition escrow / delivery escrow | 0 / 0 / 0 | 0 / 0 / 0 |
| Actual total FWA ETH | 1.298041705474210689 | 1.187940095642358972 |
| Issued / reconciled draws | 75 / 75 | 77 / 77 |

FWA balances equal their named obligations exactly. Both pools retain their two original creator-issued DemoNFTs in FWA custody. Their assigned listing values are not measured market acquisition costs. No surplus claim or wind-down was included, so this is not a creator net-income or complete capital-recovery experiment. E1 specifically means the booked-profit column cannot be accepted as independently proven entitlement.

Keeper receipt breakdown:

| Inclusion basefee | Transactions | Rewards ETH | Gas ETH | Net ETH |
|---|---:|---:|---:|---:|
| 0.08 gwei | 46 | 0.01124705 | 0.00681393154 | +0.00443311846 |
| 3 gwei | 4 | 0.011744438 | 0.01071315855 | +0.00103127945 |
| 4.9 gwei | 4 | 0.02276459395 | 0.0211462614 | +0.00161833255 |

Keeper inclusion price includes the 0.05 gwei priority allowance. These are receipt costs, not eth_estimateGas. They exclude infrastructure costs, competition and failed attempts outside this batch, so they are not a market profitability forecast. Forced fee transitions are synthetic stresses, not a demonstration of EIP-1559 reachability.

## Failures retained and recovery

The [verification manifest](receipts/launch-preparation/local-batch-verification.json) contains exact commands, exit statuses and file digests. Original logs and before-recovery journals are retained. The batch was not restarted with fresh funds or replayed purchases.

1. **Attempt 1, exit 1:** dry-run decoding treated an inputless function's undefined args as an array. No setup transaction was sent; actual nonce/code confirmed it. The harness decoder was corrected.
2. **Attempt 2, exit 1:** gas estimation for the real service's callback allowed authenticated-word storage but not forwarding. The original stored word was delivered before its deadline using the service's real permissionless retry, with a 5-million gas limit. No new purchase or replacement randomness. Callback gas is now explicit, as in existing fork helpers.
3. **Attempt 3, exit 1:** the harness rejected two legitimate slippage refunds. Read-only verification established exact FWA events and full purchaser credits before advancing the journal. Subsequent checks require delivered words plus actual prize ownership or the precise slippage entitlement; pending/expired outcomes are rejected.
4. **Attempt 4, exit 1:** viem's receipt watcher timed out on an already-mined callback. A direct read confirmed its successful canonical receipt. Recovery journaled that cost and delivered only the remaining original request. Caller receipt recording now polls the exact hash; it never rebroadcasts a timed-out send. This does not establish the cause of the separate historical keeper e2e timeout.
5. **Attempt 5, exit 0:** completed the remaining rounds and all final diagnostic assertions. A separate read-only check matched all 286 receipts to canonical blocks, every actual issued draw to the journal, actual FWA obligations and keeper balance delta, role separation, policy wiring, bytecode size and all approved numerical limits.

The local harness reserves the full worst-case Forge setup phase before starting it; Forge waits between internal sends, but receipts enter our journal after the phase returns. Other caller and keeper writes are journaled before another guarded send. The extended 4,096-block keeper journal window preserves the whole exercise. The owner-retained coordinator impersonation exception is used, without overriding any protocol balance or storage. Fresh external actor funding is synthetic setup. The owned node remains running for subsequent local work.

## Remaining acceptance gaps

The run uses 3 ETH per pool and therefore cannot establish minimum-capital resilience. It uses the actual shared Keeper class with a guarded signer, controlled ticks and persisted state; it is not a CLI-launcher, live competition, reorganization, real-wallet or indexer test. There is no dashboard interaction, FWA profile publication, policy replacement, close/retirement, refund withdrawal or mainnet canary in this batch. The earlier evidence remains scoped to its own revision and assumptions. No owner outcome signature or new audit/review seal was produced.

Production repairs and affected economic evidence must address the received findings before any release decision. Do not sign the current outcome packet or interpret the successful local plumbing checks as release readiness.

## Things that don't make sense

- The unchanged creator allocation and selected-fee income metric still disagree with the declared economic outcomes, as detailed in E1/E2.
- A batch can settle every purchaser entitlement while refunding most draws. Calling that an unqualified player-experience success would misrepresent this result.
