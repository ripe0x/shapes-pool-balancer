# Cost-first creator proceeds

New clones expose `profitAccountingVersion() == 1`. Existing immutable clones keep the old protected-percentage
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
