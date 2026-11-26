# Local stress scorecard — 2026-11-25

**24 completed scenarios; 2,360 settled requests; 2,247 actual NFT wins, including 4 curated wins; 113 pull-credit refunds.**
Local child fork 18555, source block 26486068, v2 implementation. Simulated randomness; normal basefee 0.5 gwei, bid 0.55 gwei. This is diagnostic evidence, not release readiness or a return forecast.

## Design/rate comparison

Each baseline contains 120 requests. Refund columns follow nominal rates **10 / 240 / 86,400 per day**. Ranges span those three samples; ETH amounts are rounded to six decimals.

| Design | Refunds per rate | Protected creator fees, ETH | Signed bankroll P/L, ETH | Largest final reserve gap, ETH |
| --- | --- | --- | --- | --- |
| small | 0/0/0 | 0.059896 to 0.059896 | 0.120497 to 0.146970 | 0.000000 |
| balanced | 0/0/14 | 0.220642 to 0.249783 | 0.175956 to 0.310361 | 0.000000 |
| topheavy | 0/0/90 | 0.072500 to 0.288331 | 0.217181 to 0.768236 | 0.000000 |
| jackpot | 0/0/0 | 0.239588 to 0.239815 | -0.803562 to -0.568946 | 0.422186 |
| zeroFee | 0/0/0 | 0.000000 to 0.000000 | 0.136401 to 0.154935 | 0.000000 |
| pack | 0/0/9 | 0.218293 to 0.236461 | 0.107398 to 0.108280 | 0.000000 |

## Focused regimes

These use the balanced design; the reinvestment case deliberately has less initial capital and a forced largest first prize. They are not equal-capital return comparisons.

| Regime | Requests | Final signed bankroll P/L, ETH | Reached behavior |
| --- | --- | --- | --- |
| keeperOutage | 40 | 0.113109 | One-hour outage removed; real keeper resumed. |
| gasSpike | 40 | 0.113109 | 8 gwei basefee held keeper at 5 gwei cap; recovery reached. |
| forcedLargest | 40 | 0.021493 | Largest first prize delivered; controlled outcome. |
| feeReinvestOnGap | 40 | -0.065131 | Reinvested 0.045805 ETH; gap cleared; first-gap withdrawal was zero. |
| feeWithdrawEvery20 | 40 | 0.111488 | Claimed 0.083261 ETH creator fees to wallet. |
| zeroDemandWinddown | 0 | -0.017538 | 30 idle days, redeemed backing; returned 0.554962 ETH; cash/backing zero. |

## Accounting and exceptions

- Signed bankroll P/L excludes protected creator fees. Overall native result includes fees and returned capital, but excludes wallet gas and personal curated-NFT cost basis. Reinvestment creates capital, not extra profit.
- Automatic backing, native NAV changes, fee conservation, delivered-request owner proceeds, actual NFT custody and named FWA cash obligations passed the runtime assertions in every completed case. Independent review is recorded separately; fully accounted does not mean economically desirable.
- The top-heavy burst refunded **75%** of requests. The separate positive price-drift guard is **10%**; cheap wins can move the price beyond it before keeper restocking. Those 90 requests left **0.115830 ETH** in charged VRF fees spent despite refunds. These are charged amounts with simulated delivery, not measured authentic-proof costs.
- The jackpot design retains three operating shortfalls. Both slow jackpot cases still admit draws with the 1 ETH prize missing. Protected creator fees coexist with a losing bankroll. The top-up diagnostic ended funded with negative bankroll P/L but a positive overall native change of 0.015966 ETH; reinvested earned fees increase its capital basis.
- The highest rate is nominal: serialized maintenance and automined blocks do not establish Ethereum production throughput. One deterministic seed, controlled adverse outcomes and short horizons do not establish sustainable profitability. Actual rates/horizons are in the viewer.
- Refund credits were checked, not withdrawn. Authentic VRF proofs/billing/liveness, competing users, dependency pauses and all parameter extremes remain outside scope. No protocol economics were changed.

## Execution evidence

- Physical work, including interrupted attempts: **2518 admitted requests, 6630 transactions, 2.702275 test ETH gas**, 49.648694 test ETH purchases. Elapsed 26.36 minutes, including repairs. These are local test funds.
- Read-only source proxy: **19778 cumulative forwarded requests**, closed after completion. Guard interruptions at 5,000 and 12,000 reads are preserved; ceiling extensions retained consumption and the original deadline. Counts do not measure Alchemy billing.
- All 18 baseline cases retained 120 requests. Remaining stress cases used 40 requests to preserve coverage under that deadline. One partial stress attempt was intentionally interrupted and retained; no counters were reset.
- Verification: focused pure tests and TypeScript checks passed; actual browser filters, charts, loss/fee separation and historical-failure labels were exercised. Contract bytecode is unchanged; no broad contract suite or mainnet broadcast occurred.
- `publication-annotation.json` records a metadata-only correction to two historical cap-failure labels. Raw runner results are unchanged; all published scenario and monetary data is identical.

## Things that don't make sense

- A creator-fee balance can look attractive while the bankroll loses capital; show both.
- The jackpot design keeps selling after it can no longer replace its largest prize.
- Bursts on a thin prize mix can refund most requests while buyers still pay charged VRF fees.
- A nominal rate or a successful synthetic callback is not a production throughput or verified-randomness result.
