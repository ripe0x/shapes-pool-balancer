# Reserve redesign: before and after

**TLDR: the current-work design is preferable to `a8fb321` for the stated low-capital product, provided temporary missing inventory and creator-assisted recovery are accepted.** It preserves actual prize backing and FWA purchaser entitlements, funds initial paid setup, and removes duplicate backing and hypothetical future keeper-cycle insurance. It does not promise immediate replacement after every win, uninterrupted paid operation through arbitrary gas changes, or replenishment without demand.

Base: `a8fb321265f50d1d322023c7b26d39d38022da8d`, checked against fetched `origin/codex/replaceable-keeper-policies` before implementation. No mainnet deployment or real-fund spending. Evidence below distinguishes arithmetic, actual fork execution, actual local transaction receipts and model assumptions. Final candidate checks and their preserved failures are recorded separately; none substitutes for owner signatures or deployment authority.

## Reserve and payment design

[RESERVES.md](RESERVES.md) defines all remaining components and compares options A/B/C. Option B was selected: actual missing target inventory and mint fees, canonical paid listing budgets for that missing work, actual unreconciled draw budgets, and one maintenance-call working buffer. Closed pools retain only the actual draw budgets. Disabling payment removes keeper-budget terms; candidate activation restores the positive paid funding check after two days.

Eliminated: duplicate largest-prize backing per outstanding draw and spare, an implied future draw, full policy-maximum multiplication per missing Shape, the whole-board `2 × prizes × maxReward` cycle, and its old-listing-fee offset. Unsold fees remain expected income and never liquid cash. No new tax, surcharge increase or V1 formula change was made.

The immutable work ceiling uses:

```text
gasClass = min(6M, 200k + 1.8M*processedDraws + 150k*reconciledDraws
                   + 700k*listedShapeUnits + 150k*listedPrizes)
reference = min(actualBid, basefee + 0.1 gwei, 50 gwei)
envelope = (min(measuredGas, gasClass) + 100k)*reference
         + 0.00005 ETH*(reconciledDraws + listedShapeUnits)
payout = min(selected quote, cached selected maximum, 0.311 ETH, envelope)
```

Reserve budgets use the full class ceiling and current `basefee + 0.1 gwei`, capped at 50 gwei. They are enforced payment bounds, not promised execution-gas limits. Initial/missing listing budgets follow actual five-unit/four-size/value-order batching with compressed complete batches. The reserve has no iteration per 1,000 prizes.

Actual paid fills retain booked profit and the bound for the candidate work already accumulated in the call. An unaffordable quantity shrinks; an expensive deficit can remain. Paid work may consume its working buffer and leave cash below the withdrawal target. Quotes/minimums remain atomic, so work cannot complete and silently pay less than accepted. Public unpaid recovery remains available under policy failure or keeper restrictions.

The independent spending allowance is reduced from 3.11 ETH burst / floor(0.311 ETH per12s) to **0.622 ETH burst / floor(0.05 ETH per12s)**. It never resets on policy, creator, target or open-state changes. Worst time-only expenditure is **360.6219999999999424 ETH /24h** and **131,400.621999999978976 ETH /365d**, including burst, further bounded by genuine work, current cash, cached policy maximum and class envelope. It is still a generous absolute ceiling, not money required upfront or expected expenditure.

## Exact capital comparison

Default V1 enabled, basefee 0.5 gwei, 0.001 ETH live mint fee, initially empty target, no issued draws. Amounts are ETH. These are **pool deposits/reserves**, excluding creator transaction gas and contributed curated-NFT market value. NFT descriptions/compositions and all five gas cases are in [the 40-row matrix](reserve-redesign-simulation-results.md).

| Board | Listed backing | Mint fees | Before opening | Current paid opening | Reduction ETH / % | Before stocked reserve | Current stocked reserve |
|---|---:|---:|---:|---:|---:|---:|---:|
| 10 small + curated NFT | 0.1 | 0.01 | 0.68030 | 0.11964 | 0.56066 / 82.41% | 0.398850 | 0.00368 |
| 20 small + 0.2 ETH NFT | 0.2 | 0.02 | 1.28380 | 0.23560 | 1.04820 / 81.65% | 0.720900 | 0.00368 |
| 47 mixed Shapes/Packs | 1.7 | 0.055 | 4.77285 | 1.79092 | 2.98193 / 62.48% | 2.074875 | 0.00368 |
| 100 mixed | 3.51 | 0.117 | 9.40845 | 3.69917 | 5.70928 / 60.68% | 3.775485 | 0.00368 |
| 200 mixed | 6.92 | 0.232 | 18.11520 | 7.29172 | 10.82348 / 59.75% | 6.985560 | 0.00368 |
| 1,000, including expensive Packs | 83.1 | 1.12 | 160.61280 | 84.88328 | 75.72952 / 47.15% | 57.190400 | 0.00368 |
| NFT-heavy, 17 small Shapes | 0.17 | 0.017 | 1.10275 | 0.20092 | 0.90183 / 81.78% | 0.624285 | 0.00368 |
| 19 small + 100 ETH top Shape | 100.19 | 0.02 | 201.26380 | 100.22560 | 101.03820 / 50.20% | 100.710900 | 0.00368 |

For twenty Shapes the stocked liquid hold falls **0.71722 ETH, 99.49%**. Initial capital is not declared successful solely because that number falls: exact-minimum paid setup, subsequent real purchases/deferred replacement, refunds and complete wind-down are exercised. At basefees 0.15 / 0.5 / 1 / 3 / 5 gwei, twenty-Shape paid opening needs **0.227375 / 0.235600 / 0.247350 / 0.293870 / 0.302250 ETH**; stocked reserves are **0.001825 / 0.003680 / 0.006330 / 0.016450 / 0.016450 ETH**. Higher future gas may require replenishment; initial funding is quoted in its actual context.

Actual pinned-fork paid setup at base/bid **0.5/0.55 gwei**:

| Reached target | Setup calls | Billed upkeep gas total | Actual keeper compensation | Withdrawable after exact-minimum setup |
|---|---:|---:|---:|---:|
| 20 small | 4 | 10,223,823 | 0.00608058425 | 0.00583941575 |
| 47 mixed | 12 | 27,916,178 | 0.0166727077 | 0.0155672923 |
| 1,000 expensive-Pack mix | 240 | 562,704,705 | 0.33576768375 | 0.32383231625 |

The 47/1,000 measurements above initially ran before the final profit-booking/payment-disable branches, which do not affect initial default-paid setup. The complete final suite repeats both on the final source. Maximum reached individual upkeep in the 1,000-prize setup bills **2,655,082 gas**. Aggregate harness gas is not one Ethereum transaction.

Unpaid bootstrap is a separate route: with payment disabled, **0.22 ETH** stocks twenty small Shapes, leaving zero Balancer ETH; the caller separately pays actual transaction gas. Paid reenabling then needs the real **0.00368 ETH** buffer and two-day process. Do not advertise that unpaid deposit as a funded paid-service minimum.

## Revenue, profit and partial operation

Shape/Pack prices still include backing, real mint fees, creator markup and the selected surcharge. Successful FWA deliveries generate owner proceeds from the pool draw price, not the notional price of the selected jackpot. Refunds do not generate owner revenue. Old FWA listings and original markup records stay fixed through policy changes.

The existing above-10% markup share is now always booked while open before reconciliation/paid inventory work. Removing the old reserve cushion otherwise let collection on the still-tracked old board treat funds as adequate, then spend them after the draw revealed a deficit. This was a source-derived preservation repair with a passing new regression; no failed-before independent reproduction is claimed. Paid maintenance and activation exclude booked profit. Public unpaid maintenance retains the prior game-first behavior and can consume unclaimed profit for inventory/mint fees; the independent security probe measured **0.000379273672380286 ETH** consumed. Profit is therefore not an always-liquid claim across the unpaid path.

A lower reserve deliberately releases creator-owned surplus sooner. Missing actual inventory restricts further surplus claims. The first 10% markup supports replenishment; surplus above the reserve can still be claimed. This is not permanent escrow owned by another party.

An expensive missing prize can have negligible inverse weight. The real 70% gate may keep sales open while revenue accumulates; actual FWA inventory determines current prices/odds. On the representative seven-prize fork board, a 0.5 ETH win takes **52 subsequent small-prize draws** to restore the target/working reserve while the creator claims **0.051184665310434272 ETH**. Five prizes totaling 0.72 ETH require **70 subsequent draws**. These are forced reached paths, not demand forecasts.

A 100 ETH jackpot can take a very long time to replenish. The independent economic test delivers it, then executes ten small wins without top-ups: operating funds grow **0.018073957464399730 ETH**, creator profit **0.004982698235993700 ETH**, and the 100 ETH prize remains missing. A conditional linear extrapolation is about 55,328 further similar draws, not demonstrated recovery. The creator must be willing to leave that deficit, add capital, reduce the target, or close.

Below the weight gate, after the last curated NFT is won, or without enough affordable maintenance, **future demand cannot refill a paused pool**. Existing proceeds, Add ETH, a smaller design or wind-down are explicit recovery. The dashboard distinguishes real backing, operating cash, current reserve, unsold future fee expectations and withdrawable capital; it shows partially stocked/paused states and removes the old 0.01 ETH funding-rounding overhead.

## Policy replacement

Core interface v1, factory default snapshots, separate policy admin, two-day creator/default delays, cancellation, emergency disable, stale-offer protection, bounded staticcall and unpaid fallback are retained. Current candidate funding ignores hypothetical lifetime activity and old unsold fees. At 0.5 gwei, V1 and V2 declarations both exceed the immutable one-call working bound, so a larger declaration alone does not force another whole-board deposit. A genuinely binding low selected cap or different gas/actual deficits can produce a shortfall; activation excludes booked profit and rechecks exact funding.

This redesign changes immutable enforcement for **new deployments**. Already deployed implementations cannot acquire the new reserve kernel through a policy switch. No production pool is migrated.

## Manufactured-work economics

The independent economic lane measures real isolated-Anvil receipts through the production deployment path and complete closeout. At included **basefee 0.0005 gwei / bid 0.001 gwei**, an accepted max-quoting, zero-surcharge hostile policy gives:

| Incremental operation on an already stocked pool | Buyer + keeper net | Creator operating cash change | Combined creator/buyer/keeper net |
|---|---:|---:|---:|
| Real expiry/refund | +0.000047101972 | −0.000050253108 | −0.000003151136 |
| Creator unlist/relist maintenance | +0.000050078593 | −0.001050894261 | −0.001001207006 |
| Creator-controlled NFT refuses delivery, then seven-day refund/recovery | +0.000047013757 | −0.000050232431 | −0.000003376427 |

Keeper payments cancel inside the combined controller. External gas, VRF charges, mint fees and FWA edge do not. Expiry assumes actual service non-delivery, not buyer control of Chainlink; refused creator-controlled delivery is the stronger attacker-controlled route. Full launch-through-retirement expiry loses **0.020019279942 ETH**, including 0.02 ETH initial mint fees, all actor transaction gas 0.000016939942 and VRF 0.00000234. The failed-delivery full lifecycle loses **0.020019189477 ETH**. All original Shape backing returns, and the purchaser actually withdraws its principal.

At the independent reference **basefee 0.16477224 gwei / bid 0.2 gwei**, expiry buyer+keeper net becomes **−0.0005296056 ETH** and failed-delivery net **−0.0005472486 ETH**. The basefee was read from public Tenderly block **26,437,289**, then explicitly set and asserted in the local executed path. This closes the previous unmeasured low-gas gap for the reached cases; it does not prove every possible strategy loses. A creator can intentionally subsidize work, and buyer/keeper accounts may receive that subsidy from creator capital. No measured route reaches unrelated purchaser escrow or refund assets.

## Verification and review

The immutable review manifest is `/private/tmp/reserve-review-target-mtk_bq5d/MANIFEST.json`, SHA-256 `2291b07ab2278d26c5bc8b8e841956aa5298b05a8cbabeef53aeb6ee5ca9331a`. Independent review reports contain target correspondence, own rights maps, absolute flows, failed hypotheses, commands and limits. These are focused fresh-context AI reviews, not professional audits or an exhaustive/blind safety claim.

Final production SHA-256 (PoolBalancer has a separately reviewed comment-only correction after the immutable discovery snapshot; stripped code is identical):

```text
KeeperPolicyCalls.sol ef5a39266f16b2590f5c9353b6de1378717f26353a6ba43a8430af7b11ced988
PoolBalancer.sol      e98890d6a5a3a495b988c9c812d4ca5b1b6d1f450a1d1d3d646d640d1651c8d5
PoolInventory.sol     149c5fc01034056cc821908198ab480a7a6190e90fa44604f5da2aafed8ee59a
```

PoolBalancer runtime is **24,449 bytes**, leaving **127 bytes** under EIP-170. Fixed libraries remain permanently linked. Early over-limit builds are retained as failed attempts; they are superseded by the final extraction/cached-count repair. Policy library is 5,577 bytes, inventory library 7,992 bytes. Submitted gas-limit readbacks from the final local keeper/deployment run are recorded below; billed gas alone is not used as an EIP-7825 limit proof.

The pinned fork is **26,382,349**, actual deployed FWA/Shapes and production Draw Packs deployed locally. Coordinator impersonation is the owner-retained exception; it does not establish real VRF latency/availability. Mainnet readbacks at block **26,437,232** confirmed the factory implementation, exact pinned FWA implementation codehash and live 0.001 ETH mint fee. The recent-state test uses that block. No successful protocol answers, protocol balances or storage were mocked.

The initial complete Foundry run executed 482 tests: 467 passed and 15 failed. All failures were retained and repaired as obsolete price-insurance/setup/jackpot assumptions, a measured-gas equality assumption, or a harness subtraction that assumed reserves could never exceed cash. The repaired 11 legacy cases plus a new real fee-jump/unpaid-refund case pass (12/12), and all 25 asset-flow regimes execute and pass their current measurements. The final complete warm-cache run passed **483 tests, 0 failed, 0 skipped, across 62 suites**, in **397.84 seconds**. Its command, exit status and log digest are recorded in the verification manifest. Zero-test artifact/discovery outputs were not counted as passes.

All 120 TypeScript tests pass; typechecking passes. The full keeper E2E passes with **28 canonical transactions, 27 successes and one intentional stale-policy revert**; persisted gas **0.017851310467099955 ETH** and reward **0.019984386987698762 ETH** equal chain receipts. Current reached replacement net at bids 0.15 / 0.5 / 5 gwei is **0.00004849945 / 0.0000683315 / 0.000323315 ETH**; a timeout-only call at 5 gwei nets **0.00009472 ETH**. Tips are 0.05 gwei and basefees are correspondingly 0.10 / 0.45 / 4.95. These are operation receipts before allocated hosting/competition cost.

The production-path isolated deployment uses eight transactions, maximum submitted limit **7,023,660 gas** and maximum billed deployment **5,402,816 gas**, below EIP-7825's 16,777,216. Keeper executable limits also retain the hard EIP-7825 check. Dashboard preview uses a separate build/port, preserving the earlier preview. It exercised real surplus withdrawal, a real unlisted-prize deficit, visible partial inventory/current odds, separated cash/backing/unsold-fee expectations, exact **0.001164 ETH** Add ETH recovery and restored actual inventory. A local-Anvil-only indexed-log query compatibility fix was required; production discovery retains its creator filter. No successful service reply was mocked. Earlier failures remain under `/private/tmp/reserve-*.log`: obsolete immediate-spare assertions, a filter selecting no tests, an initial three-byte EIP-170 overrun, the normal four-plus-five VRF coverage failure, and corrected test-harness time/enum assumptions. They are not silently reported as passed runs.

## Actual asset-flow scorecard

Thirty-day pinned-fork regimes use six attempted draws/day, not the stochastic model's forty. Base/bid 0.5/0.55 gwei unless named. Creator net includes actual remaining ETH/backing and contributions; NFT market prices and creator transaction gas are outside this cash ledger. Curated NFT relisting in these regimes is explicit.

| Regime | Draws / refused | Creator net ETH | Keeper net ETH | Max operating shortfall ETH | Days target missing |
|---|---:|---:|---:|---:|---:|
| Quiet launch board | 180 / 0 | +0.932648 | +0.015200 | 0.129591 | 11 |
| Zero demand | 0 / 0 | −0.071673 | +0.001324 | 0 | 0 |
| One forced 0.5 ETH win | 180 / 0 | +0.234695 | +0.015446 | 0.482240 | 25 |
| Gas spike | 145 / 35 | +0.667907 | +0.024396 | 0.129591 | 9 |
| Exact-minimum twenty Shapes | 180 / 0 | +0.382695 | +0.014077 | 0 | 0 |
| Exact-minimum mixed / large win | 180 / 0 | +0.221382 | +0.015616 | 0.506962 | 27 |
| Bursty settlement | 161 / 0 | +0.446749 | +0.017052 | 0 | 0 |
| Policy switch with pending draw | 19 / 0 | +0.036027 | +0.002657 | 0.006467 | 0 |

All 25 ledgers reconcile to the wei. Policy-switch operating deposit is **0.003949880025564352 ETH**, driven by the actual current funding state rather than a full future board. The old O5 zero-missing-days rule **fails** the Add ETH/drop-top regimes at 11/14 days; later adverse wins create fresh deficits. It is explicitly replaced by the new partial-depletion/open-admission condition. Those regimes still execute 180 draws with zero refusals. This is a different proposed acceptance condition, not evidence that the old promise passed. A passing current gate measurement supplies no owner signature.

## Remaining limitations and owner decisions

Temporary depletion, including expensive prizes absent for a long time, is accepted by this design and visible in the dashboard. A count of cheap-prize weight is not the same as retaining every large-prize opportunity. The existing weight gate is retained rather than adding another inventory insurance requirement.

The 40 capital rows match actual library opening/stocked quotes plus two disabled/closed edge cases; they are not forty executed setup lifecycles. stochastic scenarios are explicitly model-only for demand, gas, selection, batching and timing. Baseline models never auto-replace curated NFTs; the sole NFT can be won before a later stress phase. Named long stress/high-volume scenarios explicitly count replacement NFTs and assert the disputed phase was reached. Zero ledger gaps are conservation checks, not proof of profitability or demand.

The lower burst/refill remains a generous absolute exposure; reached high-volume receipts and cap/parameter-reset probes support bounded claims only. Existing keeper journal limits remain 64 blocks/1,000 receipts, with manual reconciliation for deep/pruned history or external-cancellation/reorg/reinclusion. Mempool competition, real mainnet oracle timing, creator willingness, professional audit and separately authorized live rehearsal/canary remain outside this local implementation.

Owner-review decisions: choose conditional working-capital operation over full immediate-replacement insurance; retain current deficits as withdrawal restrictions; use current-gas immutable budgets; lower work/service/priority and cumulative envelopes; preserve booked markup before paid work; release payment holds while disabled; retain unpaid game-first profit use; keep the existing admission gate and expose actual partial inventory. Changed asset-flow outcomes need a fresh owner signature. No passing measurement supplies that signature or authority to deploy.

## Things that don't make sense

A 100 ETH jackpot cannot both be instantly replaced and require no spare 100 ETH. The new design avoids that duplication and makes the resulting long-lived deficit explicit. A paused pool cannot recover from imaginary demand, and positive work fees can subsidize buyer/keeper activity at very low gas even when the combined controller loses. These are product/economic tradeoffs, not missing purchaser backing.
