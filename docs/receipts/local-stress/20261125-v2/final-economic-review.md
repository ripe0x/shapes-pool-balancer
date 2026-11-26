# Final independent economic review of local stress diagnostics

**All 24 retained cases complete and reconcile, but several measured outcomes are unfavorable.** Jackpot designs finish with an unfilled 1 ETH prize and substantial reserve gaps. The top-heavy batch design refunds 75% of requests. Accounting conservation does not establish that the economics or player experience are acceptable.

## Frozen evidence and scope

- Raw results: `docs/receipts/local-stress/20261125-v2-regimes/results.json`, SHA-256 `b97ce224a56bf989ad4d987d8455bcb6d6c8aa2bdea537b89d65c389123dba4c`.
- Retained case counts: **18 baseline cases × 120 requests, five operating stress cases × 40 requests, one zero-demand wind-down with zero requests: 2,360 settled requests total**.
- Raw result clock: started **2026-11-26 00:40:29.970 UTC**, finished **01:06:51.632 UTC**. The six stress cases use shorter horizons than the baselines and must not be compared as equal-length samples.
- Runtime runner SHA-256: `03ce36b4578e2b1736de9f41a42e3f9ffaf853080de383b70276bda73b866292`.
- Public viewer data SHA-256: `ae397e55e2434ed49599f6d7f8c1d12a9e038b834fa2c97e8e48b6edc18ae1aa`. Independent comparison found its entire `scenarios` array identical to the raw results. `publication-annotation.json` in this directory records the correction of two historical error flags and their provenance; monetary results were not changed.
- This is read-only analysis of saved evidence under OWNER-REQUIREMENTS R125 and holistic verification guidance. No RPC calls, contract transactions or tests were performed during this review. Only this report was written. The earlier six-case review remains unchanged.

## Independent accounting checks

For **each of all 24 retained cases**, independently recomputing the following from raw flow totals and final holdings gives **0 wei discrepancy**:

1. **NAV conservation:** final native cash + actual automatic-prize backing = initial deposit + collected owner proceeds + additional external capital − creator withdrawals − backing delivered to winners − mint fees − keeper payments.
2. **Creator-fee conservation:** final protected fees = accrued creator fees − fees reinvested − fees withdrawn.
3. **Signed bankroll result:** final native cash + automatic-prize backing − protected fees − remaining capital = reported signed bankroll P/L.

Across **1,831 saved trace points**, the actual FWA cash field equals its owner-proceeds, acquisition-escrow, delivery-escrow, purchaser-refund and protocol-fee buckets; native Balancer cash covers protected fees; and reported bankroll profit equals signed P/L clipped at zero. These checks concern the saved measurements, not independent live readbacks or every intervening transaction state.

There is **no retained economic invariant failure** in this dataset. Two prior attempts stopped on source-read budget failures; an additional unfinished attempt was replaced with a deliberately shorter continuation. Their records remain in `priorAttempts`. Physical admitted requests total **2,518**, including **158** beyond the retained 2,360; they must remain charged to physical budgets rather than being treated as additional completed evidence.

## Baseline scorecard

All amounts are ETH, rounded to six decimal places. Each row contains 120 settled requests. Nominal rates are schedules, not demonstrated market demand. Creator transaction gas is outside the bankroll figure.

| Design / nominal requests per day | Signed bankroll P/L | Protected creator fees | Refunds / requests | Final operating reserve gap |
|---|---:|---:|---:|---:|
| Small / 10 | +0.120497 | 0.059896 | 0 / 120 | 0 |
| Small / 240 | +0.120497 | 0.059896 | 0 / 120 | 0 |
| Small / 86,400 | +0.146970 | 0.059896 | 0 / 120 | 0 |
| Balanced / 10 | +0.175956 | 0.249783 | 0 / 120 | 0 |
| Balanced / 240 | +0.175956 | 0.249783 | 0 / 120 | 0 |
| Balanced / 86,400 | +0.310361 | 0.220642 | 14 / 120 | 0 |
| Top-heavy / 10 | +0.768236 | 0.288331 | 0 / 120 | 0 |
| Top-heavy / 240 | +0.768236 | 0.288331 | 0 / 120 | 0 |
| Top-heavy / 86,400 | +0.217181 | 0.072500 | 90 / 120 | 0 |
| Jackpot / 10 | **−0.803562** | 0.239588 | 0 / 120 | **0.422186** |
| Jackpot / 240 | −0.803562 | 0.239588 | 0 / 120 | 0.422186 |
| Jackpot / 86,400 | −0.568946 | 0.239815 | 0 / 120 | 0.187570 |
| Zero creator fee / 10 | +0.154935 | 0 | 0 / 120 | 0 |
| Zero creator fee / 240 | +0.154935 | 0 | 0 / 120 | 0 |
| Zero creator fee / 86,400 | +0.136401 | 0 | 0 / 120 | 0 |
| Pack / 10 | +0.108279 | 0.236461 | 0 / 120 | 0 |
| Pack / 240 | +0.108280 | 0.236461 | 0 / 120 | 0 |
| Pack / 86,400 | +0.107398 | 0.218293 | 9 / 120 | 0 |

**Worst measured bankroll outcome:** jackpot / 10 ends at **−0.803562409401003561 ETH**, with **0.239587864651810013 ETH** of protected creator fees. Including those fees in native wealth, final cash plus automatic backing minus the **2.1645 ETH** initial deposit is **−0.563974544749193548 ETH**, approximately **−26.06%**, before creator transaction gas. Fees are compensation despite bankroll loss, not proof of positive overall investment return.

The largest reported settled-trace reserve gap is **0.503605807037315488 ETH** in jackpot / 10 at request 71. Its final gap is **0.422185909401003561 ETH**. All three jackpot cases end with the **1 ETH prize missing**, while `admissionStatus` remains **0**, allowing sales. The recorded operating requirement is **1.0031235 ETH**; jackpot / 10 has only **0.580937590598996439 ETH** operating cash. A completed campaign case therefore does not imply a restored or fully funded target.

Top-heavy and Pack designs include a real local DemoNFT valued by its creator at 0.2 ETH. This is not a measured purchase cost or redeemable ETH backing. Their native P/L must not be presented as total NFT investment return. The top-heavy batch and each Pack case actually deliver one such NFT; the top-heavy serial cases do not.

## Refunds and player costs

There are **113 actual status-4 selection/slippage refunds**, no status-3 expiries, and **2,247 NFT wins** across the retained 2,360 requests. Refunds are concentrated in the five-request batch cases:

- Balanced: **14 / 120, 11.67%**.
- Top-heavy: **90 / 120, 75%**.
- Pack: **9 / 120, 7.5%**.

Actual buyer pull-credit balances total **2.616279946602550183 ETH** across these independent cases. The money remains at FWA as purchaser claims; it was not withdrawn to buyer wallets. At the recorded baseline VRF charge of **0.001287 ETH per request**, the 113 refunded requests still incur **0.145431 ETH** of VRF charges, excluding buyer transaction gas. Acquisition refunds do not reverse this cost.

Higher bankroll P/L under batching cannot be interpreted without successful deliveries and refund mix. For example, balanced batching delivers **106 prizes with 1.33 ETH backing**, versus **120 prizes with 1.66 ETH backing** in each serial balanced case. Both the realized outcomes and keeper costs change.

## Operating stress cases actually reached

| Case | Requests | Observed result |
|---|---:|---|
| Keeper outage | 40 | One simulated hour without keeper maintenance; two further purchases admitted and supplied synthetic randomness; real keeper then resumes. Final gap 0, signed bankroll P/L +0.113109357 ETH. |
| Gas spike | 40 | Basefee set to 8 gwei, keeper skips above its 5 gwei bid ceiling; two further purchases admitted; normal basefee restored and keeper resumes. Final gap 0, signed bankroll P/L +0.113109209 ETH. |
| Forced largest first win | 40 | Largest active automatic tier selected first. Final gap 0; signed bankroll P/L +0.021493085 ETH. This is a controlled adverse case, not an unbiased sample. |
| Fee reinvestment on a gap | 40 | Lower initial capital **0.491163 ETH**, then controlled largest first win. First recorded gap **0.073118283192052961 ETH**, coexisting with **0.002081526571122013 ETH** fees; execution asserts withdrawals blocked. Actual fees reinvested **0.045804724551318473 ETH**. Final target restored and gap 0. |
| Fee withdrawal every 20 | 40 | Actual creator fee withdrawals total **0.083261062844880520 ETH**. Final protected fees 0; remaining signed bankroll P/L +0.111487883 ETH. Wallet arrival is checked by the runner. |
| Zero demand and wind-down | 0 | Advances **2,592,001 simulated seconds**, closes, redeems automatic backing and claims cash. Final cash, automatic backing and FWA owner proceeds are all 0. Creator receives **0.55496210905 ETH** of its **0.5725 ETH** deposit; **0.01753789095 ETH** setup mint fees and keeper payments remain spent, plus creator gas outside this figure. |

Reinvestment is not external funding or newly created profit. The reinvestment case finishes with **0.536967724551318473 ETH** capital, **0.035291843227961138 ETH** protected fees and **−0.065130855013392166 ETH** signed bankroll P/L. Native economic change measured directly as final cash + automatic backing + withdrawals − initial deposit − additional external capital is **+0.015965712765887445 ETH**. This differs from signed bankroll P/L because reinvested earned fees become contributed capital. The runner checks unchanged cash and unchanged signed P/L at each actual reinvestment.

The gas-spike case makes no new listing during the elevated-basefee interval; it demonstrates keeper waiting and recovery with purchases continuing, not economics of replenishing a board at 8 gwei. No dependency-paused regime, real randomness outage, hostile-actor economics or full parameter-extreme campaign was exercised.

## Limits, budget and provenance

The nominal 86,400/day baselines achieve **46,493–52,898 settled requests/day** over short simulated horizons, approximately **54–61%** of their labels. Maintenance serializes batches. There are no competing users or a real gas market, and all random words are synthetic. One seed and 120 requests per baseline do not establish expected profit, sustainable profitability, production capacity or a general bound.

The initial-capital regimes differ deliberately; the reinvestment case alone removes the usual 20% backing buffer. Its shorter controlled run must not be used to claim that every design operates safely with that funding. All 24 cases use the same production contract economics; diagnostic setup choices do not authorize changing those rules.

The saved source meter records **19,778 cumulative forwarded reads**, a **24,000-read ceiling**, `closed: true`, and original deadline **2026-11-26 01:10:07.305 UTC**. Proxy continuations retained source consumption and the original deadline. These counts are not exact Alchemy requests or billing. The durable ledger retains **6,630 transaction reservations**, **2.7022750779 synthetic ETH gas accounting**, and unfinished-attempt costs; none is mainnet spending evidence. Uncertain sends retain conservative reservations.

Historical error flags in the original raw findings were incorrectly cleared when an identically named case later completed. Public annotations correct only those flags and source paths, retaining the failures and all financial data. The reviewed source-only follow-up at runner SHA-256 `d5c91f0ebd4cde40f2e9dd3f5c558734e8986902f53382a731805a8f36a67bac` makes historical status sticky and preserves an existing `attemptSource`; it changes neither execution nor economic calculations. Static review found that narrow provenance repair consistent with the preserved failed-attempt records.

This report is bounded local diagnostic evidence, not an audit, a proof of safety, owner-approved numerical outcomes or release readiness. Assets being accounted for does not establish that their destination or the user experience is desirable.

## Things that don't make sense

- Jackpot pools keep selling with a missing 1 ETH prize, negative bankroll P/L and protected fees that cannot cure the reserve gap automatically. The dataset exposes this accepted partial-inventory behavior; a green accounting check does not make it a good creator outcome.
- A top-heavy five-request batch succeeds only 25% of the time in this sample while all requests incur VRF charges. That is a material player-experience result, even though every refund obligation reconciles.
- `complete` describes bounded scenario execution, not restoration of the prize design, a withdrawable profit or a full lifecycle exit.
- Curated-NFT sale proceeds have no measured investment cost basis here. Native P/L and the creator's total return cannot be equated.
- Refund pull-credit conservation was reached, but actual purchaser refund withdrawal was not. The one-way VRF cost remains after the acquisition refund.
- Receipts reuse scenario IDs and, after the cache optimization, pool addresses across snapshot-reverted attempts. Summing receipts by ID or address alone can double-count historical costs and produce false keeper-loss conclusions; attempt boundaries remain necessary.
