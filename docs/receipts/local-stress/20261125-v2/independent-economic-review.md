# Interim independent economic review: first six completed cases

This review covers the six completed cases observed at **2026-11-26 00:53:48 UTC**. The campaign was still running. It does not assess subsequently completed cases or the final campaign dataset.

- Input: `app/public/stress-results/results.json`, read at 00:53:48.294166 UTC.
- Observed input SHA-256: `f32ff188ee94723be15cf01e05489ffb0b18170086d533cfbe00c23d78f8c722`.
- Reviewed runner SHA-256: `f4a79f4fb3732a16ad8e17f444b617ab90492a0511292ba9b171b453ca1a11c7`.
- Additional evidence: cumulative `docs/receipts/local-stress/20261125-v2-continuation/receipts.json` and preserved prior-attempt metadata. Receipt totals were separated by scenario and actual Balancer address where the interrupted attempt reused a scenario ID.
- Scope: local V2 diagnostic under OWNER-REQUIREMENTS R118–R125; actual clone, FWA, Shapes, Packs and keeper transactions on the isolated child fork; synthetic coordinator callbacks. This review made no RPC calls, ran no tests and changed no economic rules.

The hash identifies the observed version of the growing input. This document preserves its reviewed measurements; it does not claim that the current results file still has that hash or that a separate full copy of that version was retained.

## Measured comparison

All six cases contain **120 settled requests**, use **0.5 gwei basefee**, and have **zero additional external capital**. Small starts with **0.26 ETH** capital; balanced starts with **0.5725 ETH**. Amounts below are ETH, rounded to nine decimal places.

| Design / nominal requests per day | Actual requests per day | NFT wins / refunds | Protected creator fees | Signed bankroll P/L | Keeper payments | Final reserve shortfall |
|---|---:|---:|---:|---:|---:|---:|
| Small / 10 | 10.08 | 120 / 0 | 0.059895558 | +0.120496821 | 0.073667621 | 0 |
| Small / 240 | 239.87 | 120 / 0 | 0.059895558 | +0.120497017 | 0.073667425 | 0 |
| Small / 86,400 | 52,897.96 | 120 / 0 | 0.059895558 | +0.146969784 | 0.047194658 | 0 |
| Balanced / 10 | 10.08 | 120 / 0 | 0.249783189 | +0.175956078 | 0.075957587 | 0 |
| Balanced / 240 | 239.88 | 120 / 0 | 0.249783189 | +0.175955991 | 0.075957674 | 0 |
| Balanced / 86,400 | 50,330.10 | 106 / 14 | 0.220641817 | +0.310360797 | 0.047304607 | 0 |

For **each of these six cases**, independent arithmetic on the reported final holdings and cumulative flows produced:

- **NAV gap: 0 wei**: final cash plus actual automatic-prize backing equals initial deposit plus collected owner proceeds plus additional capital, less delivered backing, mint fees, keeper payments and creator withdrawals.
- **Creator-fee ledger gap: 0 wei**: final protected fees equal accrued fees less fees reinvested and fees withdrawn.

No current economic invariant failure appeared in these six cases. The preserved earlier `balanced-10` interruption was an RPC failure when the source-read cap was reached, rather than an established economic invariant failure. Its partial run must not be promoted into completed-case evidence.

## What the money figures mean

Signed bankroll P/L is **cash + actual automatic-prize backing − protected creator fees − contributed capital**. It includes actual setup and operating mint fees and keeper payments. Protected creator fees are separate compensation, not additional bankroll profit. Creator transaction gas is an additional cost outside that bankroll figure. These cases have not demonstrated realized recovery of every final asset through closeout.

The small-board batch case pays approximately **0.026472767 ETH less** to keepers than the small-board 240/day case over the same 120 delivered 0.01 ETH prizes. This is a measured batching difference under this runner, not evidence of actual demand or production throughput.

The balanced batch case's higher bankroll P/L cannot be read as better underlying economics. It delivers **106 prizes with 1.33 ETH redeemable backing**, compared with **120 prizes with 1.66 ETH backing** in each serial balanced case. Collected owner proceeds are also lower: **1.975307221 ETH**, compared with **2.236196853 ETH**, rounded. The realized winning mix and refunds differ alongside keeper costs.

All **14 balanced batch refunds, 11.67% of requests**, are status-4 selection/slippage refunds; none is a status-3 expiry. Actual buyer refund credit of **0.273934114552315056 ETH** remains at FWA. Refund credit is a purchaser claim, not an executed payment back to the wallet. The campaign did not exercise refund withdrawal.

VRF charges total **0.15444 ETH** for its 120 requests, including **0.018018 ETH** charged for the 14 refunded requests. Refunding acquisition escrow does not return that VRF charge. These numbers exclude buyer transaction gas.

## Evidence and interpretation limits

- Coordinator impersonation supplies deterministic synthetic words. Genuine proof validation, authentic callback delivery and coordinator commitment consumption are not tested.
- One deterministic seed and 120 requests per case do not establish expected returns, long-run sustainability or a profitability bound. Repeated nominal-rate cases share deterministic setup and should not be counted as independent economic samples.
- Maintenance serializes batches. The nominal 86,400/day schedules achieved about **58–61%** of that label, measured across their short simulated horizons. They are not production capacity or high-arrival concurrency measurements.
- Initial capital is deliberately funded above opening requirements. Zero shortfall here does not establish minimum-capital resilience or eliminate risk under depletion, adverse outcomes, gas disruption or optional replenishment. Those other regimes were outside this six-case snapshot.
- The reviewed cases do not cover curated-NFT economics, fee reinvestment, fee withdrawals, wind-down, dependency pauses, hostile actors or parameter extremes. Completion of later cases cannot be inferred from this review.
- All results remain local diagnostic evidence. They are not an audit, production safety proof, owner-approved profitability outcome or release-readiness determination. Source forwarding counts are not exact Alchemy billing measurements.

## Things that don't make sense

- A higher creator bankroll P/L can accompany fewer successful purchases. Results need refund counts and delivered backing beside profit figures so the changed player experience stays visible.
- Cumulative receipts retain the failed and retried `balanced-10` attempts under the same scenario ID. A naive ID-only gas sum produces a false keeper-loss conclusion. For the completed retried case, separating the actual Balancer address gives measured keeper net of **+0.0100498531 ETH**, including setup and operating keeper receipts. Future retries at the same address require attempt separation rather than address filtering alone.
- A refund claim is economically different from cash already returned to a buyer. The observed refund bucket reconciles, but the withdrawal round trip remains unexercised.
