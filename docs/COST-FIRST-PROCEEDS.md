# Creator fees and cost-first withdrawals

## Current candidate: version 2

Owner requirements R118–R121 supersede the version 1 net-profit-only compensation model below.
New source exposes `profitAccountingVersion() == 2`. Version 2 is deployed and selected on the local 8545
playground under R122–R124; no version 2 mainnet deployment is authorized. Existing clones remain fixed.

### Current acceptance and next step

The [local stress diagnostics](local-stress-diagnostics.md) completed 24 cases with 2,360 settled requests,
including actual keeper recovery, creator-fee reinvestment, claims and wind-down. The independent saved-result
accounting review reconciles all 24 cases. Randomness is simulated; this does not replace authentic-proof tests.
R126–R127 accept partial-inventory operation and the measured slippage-refund/randomness-charge behavior.
Those observations remain in the frozen reports but require no product or contract repair.

**Focused release progress (2026-11-25):** [current evidence](receipts/focused-v2-release/README.md) records
46 passing focused contract tests, including the formerly RPC-blocked genuine-proof v2 cases, three refreshed
scorecards, the signed bankroll-loss UI repair and read-only component acceptance. The subsequent
[approved local UI batch](receipts/focused-v2-ui/README.md) verifies real top-up/withdrawal receipts, three simulated
NFT wins with production keeper restocking, and exact retained backing. Owner signature is committed as `9d0e79d`; gate PASS. The original blocked checkpoint
below is historical and remains preserved. [Production preparation](MAINNET-CREATOR-FEE-V2.md) uses a replacement
factory because the live immutable factory has no creation pause. Runtime contracts remain unchanged from `213a6ab`.

**Next action:** owner-authorized merge to main, then a fresh canonical production dry run and immediate decoded
broadcast approval. The [focused signature packet](receipts/focused-inventory-update/OWNER-SIGNATURE.md) is signed;
its source/evidence digest remains unchanged. The informed independent review is bounded and does not constitute a
full audit. Full campaign and authentic live oracle/service availability claims stay separate. No production
transaction has been sent.

| Bucket | Rule |
| --- | --- |
| Reserved creator fees C | Actual collected FWA owner receipts × effective automatic rate; cannot fund maintenance without the creator opting in |
| Operating cash | Balancer ETH balance B minus C |
| Bankroll profit | `max(accounted cash + automatic backing - C - contributed capital, 0)` after reconciliation |
| Contributed capital | Native ETH deposits/gifts plus explicit creator-fee reinvestment; never income |

The automatic rate uses the intended automatic target and active curated weights. Only automatic backing markup
above the first 10 percentage points contributes to the allocation. Mint fees and priced restocking charges remain
in the draw-price denominator; curated asking prices create no invented capital claim. The creation-tuple rate
field stays zero and the old manual setter rejects.

Rates use collection epochs, because FWA offers no per-purchase rate hook. Configuration and curated edits collect
existing receipts at the old rate first. An updated rate activates only after all issued draws are reconciled, no
draw is unsettled and every tracked listing is activated. Ordinary temporary automatic-prize depletion does not
change the target-based allocation. These fees are gross compensation; bankroll losses can coexist with fees.

Open withdrawal limit: zero if operating cash is below reserve; otherwise C plus the lesser of bankroll profit and
operating cash above reserve. Claims consume fees, then profit, then closed-pool capital. Maintenance and keeper
payment use only operating cash. Closing allows separate capital recovery after pending draws settle.

`reinvestCreatorFees(maximumAmount)` is creator-only. It recollects receipts, calculates the current full
refill/opening reserve, and uses `min(maximumAmount, C, max(reserve - operating cash, 0))`. Zero is rejected.
It reduces C and increases contributed capital by the same amount. Balancer cash does not move, and bankroll profit
does not increase. The UI displays the exact maximum and remaining fees. It may follow with maintenance only while
open. Closed pools may fund reopening; retired pools cannot reinvest. New receipts collected during execution do
not increase the approved maximum. A smaller live gap uses less. The UI refreshes after confirmation.

Example: 0.05 ETH accrued fees and 0.02 ETH needed uses 0.02 ETH, leaves 0.03 ETH fees and makes 0.02 ETH available
for replacement. If fees are only 0.01 ETH, it uses 0.01 ETH and leaves a 0.01 ETH gap. Native deposits still create
zero fees or profit. A user must fund any remaining gap or reduce the target. No automatic fee reinvestment occurs.

The [creator-fee implementation checkpoint](receipts/creator-fee-v2/REPORT.md) preserves its original blocked
test results and static review. Subsequent local deployment and stress evidence have their own scopes and
do not relabel that blocked batch as passed. The full economic campaign, real browser-wallet transactions and
production release approvals remain separate. Gross fees do not prove that a pool is sustainably profitable.

## Historical version 1


The previous implementation exposes `profitAccountingVersion() == 1`. Existing immutable clones keep the old protected-percentage
accounting; a factory implementation change affects only future clones. This source change authorizes no deployment.

## Cash and assets

| Bucket | Enters from | Leaves for | Creates earnings? |
| --- | --- | --- | --- |
| Contributed ETH capital | Creation funding, deposits, gifts, forced ETH | Closed capital recovery | No |
| Accounted cash | Capital, settled owner receipts, redeemed backing | Mint/backing, keeper, creator | Only net settled receipts after losses |
| Automatic backing | Actual Shape/Pack minting | Prize allocation or unlisting/redemption | No, an asset conversion |
| Curated inventory | Creator listings | Winner, creator withdrawal or refund recovery | No invented ETH cost basis |
| FWA escrow/refund credits | Player payments | FWA settlement/refunds | Never Balancer capital or earnings |

`earned = max(accounted cash + automatic backing - contributed capital, 0)`.

Direct or forced ETH is excluded from earned cash immediately and recorded as capital at the next accounting action.
Only exact actual FWA owner withdrawals are receipts. Mint fees and keeper payments reduce assets. Shape/Pack backing
is written off on reconciliation even when delivery fails; refunded redemption reverses that loss with actual ETH.
Outstanding and unreconciled draws block claims and suppress the earnings view. Active inventory redemption changes
liquidity only. A target reduction, curated repricing or creator transfer creates no earnings.

While open, the claim limit is the smaller of earned proceeds and cash above `requiredReserve()`. The reserve includes
missing target backing, accepted mint fees, owed keeper work and the current maintenance buffer. Maintenance can use
all pool cash. Closing permits recovery of remaining cash capital after draws settle. Capital recovery reduces the
hurdle only by the amount beyond earnings, retaining any prior loss through reopening.

A 1 ETH deposit has zero earnings. If actual net operating receipts create 0.015 ETH of surplus, at most 0.015 ETH
can leave while open, and less if current reserve funding needs it. A curated NFT's 1 ETH listing value creates no
1 ETH debt. These are game cash proceeds, not personal investment profit after offchain NFT acquisition costs.

## Pricing and compatibility

There is no manual earnings percentage for this version. The retained creation-tuple field must be zero; the old
setter rejects. Markup and mix inform an estimated cash margin after expected automatic backing, mint and keeper
costs. The projection cannot promise realized returns, future gas prices, demand or the timing of large wins.

The old economic simulation and protected-revenue test expectations describe the historical model. They are not
release evidence for this implementation. A new release candidate still needs its economic campaign and production
rehearsal, followed by separately authorized onchain canary work.
