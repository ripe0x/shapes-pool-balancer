# D6 and D7: measurements and recommendations

Measured on the pinned mainnet fork (block 26,382,349) with the real FWA pool, randomness service, Shapes and BAYC. The
gas context is set and asserted inside a transaction in each test. No contract source has changed.

## D6: draw price against expected prize, and a lower cap for the restocking fee's gas price

Under option B the restocking fee in a prize's price and keeper pay are separate: the fee is the creator's income, and
keepers are paid from the creator's ETH. So the gas price used to compute the fee could be capped below the 5 gwei pay
cap. Method: the launch board (24 × 0.01, 8 × 0.02 pack, 12 × 0.05, 2 × 0.1, 1 × 0.5 ETH Shapes, one 0.2 ETH NFT,
25% markup) is listed fresh at each basefee. FWA's own quote gives the current cap. The other caps are recomputed from the
same listings with FWA's formula, `sum(weight × price) / sum(weight) × (1 + 5% edge)`. That formula reproduces FWA's quote
to the wei at all three basefees. The randomness fee is the live service's `requestFee`. Keeper pay is measured: one draw
reconciled plus one Shape restocked, and one NFT-win reconcile (`test/scenario/PriceCaps.t.sol`; computed by
`python3 script/d6-price-caps.py <forge -vv log>`).

"Ratio" is the all-in price (draw price plus randomness fee, before wallet gas) divided by the expected Shape backing a
draw wins. "Creator absorbs" is keeper pay per draw less the restocking fee inside the owner proceeds per draw; negative
means the creator gains.

| Basefee | Fee cap | All-in price | Ratio | Restocking fee in proceeds per draw | Keeper pay per draw | Creator absorbs per draw |
| --- | --- | --- | --- | --- | --- | --- |
| 0.5 gwei | 5, 2 or 1 gwei (no effect below the cap) | 0.024397 ETH | 1.55× | 0.000999 | 0.000647 | −0.000352 |
| 2 gwei | 5 gwei (today) | 0.029928 | 1.87× | 0.002923 | 0.002101 | −0.000822 |
| 2 gwei | 2 gwei | 0.029861 | 1.87× | 0.002859 | 0.002101 | −0.000758 |
| 2 gwei | 1 gwei | 0.028516 | 1.78× | 0.001578 | 0.002101 | +0.000523 |
| 5 gwei | 5 gwei (today) | 0.040744 | 2.46× | 0.006650 | 0.004954 | −0.001696 |
| 5 gwei | 2 gwei | 0.036764 | 2.22× | 0.002859 | 0.004954 | +0.002095 |
| 5 gwei | 1 gwei | 0.035419 | 2.14× | 0.001578 | 0.004954 | +0.003376 |

Expected Shape backing per draw: 0.015712, 0.016005 and 0.016541 ETH at 0.5, 2 and 5 gwei. It moves with prices because
FWA weighs each prize by 1/price. Counting the NFT at its 0.2 ETH value adds about 0.0004 ETH. Keeper pay assumes each
Shape won is replaced by its own call, an upper estimate.

**The floor the randomness fee sets.** With no restocking fee at all, a draw at 5 gwei still costs 0.033762 ETH, 2.04×
the expected backing. FWA's randomness fee alone (0.0117 ETH) is 0.71× the backing. At 0.5 gwei the floor is 1.49×.
The rest of the gap is the 25% markup, FWA's 5% edge and the Shapes mint fee (0.001 ETH per Shape, 10% of a 0.01 ETH
Shape).

**After a spike.** The fee is fixed when a prize is listed. If a whole board were listed at 5 gwei and gas fell back to
0.5 gwei, half of the extra fees are gone after about 38 draws and 90% after about 177 (expected values). A real spike
restocks only the prizes won during it, mostly 0.01 ETH Shapes, and each of those is won again after about 32 draws on
average. The 0.5 ETH Shape takes about 1,094 draws.

| Option | Player price at 5 gwei | Creator per draw at 5 gwei | Change |
| --- | --- | --- | --- |
| **Keep the 5 gwei fee cap** | 0.0407 ETH (2.46×) | gains 0.0017 | none |
| Fee cap 2 gwei | 0.0368 (2.22×), −10% | pays 0.0021 | constant in the contract |
| Fee cap 1 gwei | 0.0354 (2.14×), −13% | pays 0.0034, most of a 25% markup's 0.004 | constant in the contract |
| Pause purchases above about 2 gwei | no sales above it; at 2 gwei 0.0299 (1.87×) | no draws, no income | purchase gate on basefee; fewer sales in spikes |

**Owner decision (confirmed directly 2026-11-13: option a, keep the 5 gwei fee cap):** stay open up to 5 gwei; judge attractiveness at normal gas with a signed
outcome that a player pays at most 1.5× the expected prize backing at 1 gwei or below; report the 5 gwei ratio as
information; the app shows the all-in price (done).

**The 1.5× outcome fails on the launch board at 25% markup above about 0.3 gwei.** Measured (current 5 gwei fee cap; a
lower fee cap changes nothing at or below 1 gwei, because the fee's gas price is already below any of the caps):

| Basefee (gas price +0.05) | All-in price | Ratio at 25% markup | 20% | 15% | 10% |
| --- | --- | --- | --- | --- | --- |
| 0.058 gwei (the pinned block's real basefee) | 0.022764 ETH | **1.46×** | | | |
| 0.5 gwei | 0.024397 | 1.55× | 1.48× | 1.41× | 1.34× |
| 1 gwei (basefee 0.95) | 0.026059 | **1.65×** | 1.58× | 1.51× | 1.44× |
| 2 gwei | 0.029928 | 1.87× | 1.80× | 1.73× | 1.66× |
| 5 gwei | 0.040744 | 2.46× | 2.39× | 2.32× | 2.24× |

Even with no restocking fee, the launch board at 25% is 1.54× at 1 gwei. The markup, FWA's 5% edge and the Shapes mint
fee (0.001 ETH per Shape, 10% of a 0.01 ETH Shape) set most of the ratio at low gas.

| Option for the outcome | What it means | Creator cost | Recommendation |
| --- | --- | --- | --- |
| **a) ≤ 1.5× at today's normal gas (basefee ≤ 0.1 gwei), and report 1 gwei** | passes at 25% (1.46× measured); 1 gwei shows 1.65× as information | none | **Recommended**: matches "attractive at normal gas" with the board and markup you chose; mainnet basefee was 0.058 gwei at the pinned block |
| b) ≤ 1.5× at 1 gwei, with the launch markup lowered to 14% | 15% gives 1.51×, so 14% or less | markup per draw falls by about 44% (14/25) | only if 1 gwei is the "normal gas" you mean |
| c) ≤ 1.65× at 1 gwei at 25% | passes (1.65× measured, no margin) | none | weaker than what was asked |

Markup is each creator's choice; this outcome describes the launch board. The fee-cap question (lower than 5 gwei)
only matters above 1 gwei; the earlier table shows it saves players at most 13% at 5 gwei and costs the creator up to
0.0034 ETH per draw. **Recommendation: keep the 5 gwei fee cap; no contract change.** If "yes do that" meant implementing
a lower cap, say which cap and I will make it in the repair batch.

## D7: a curated collection that turns hostile

A creator-controlled ERC-721 that behaves while listed, then turns hostile, run through the real FWA pool
(`test/HostileCollection.t.sol`). Draw at basefee 0.5 gwei, gas price 1 gwei. The player paid 0.017493 ETH: a draw
price of 0.015153 plus a randomness fee of 0.00234.

| Variant | Where the NFT ends | Player's payment | Randomness fee | What the "winner" gets | Creator's gain |
| --- | --- | --- | --- | --- | --- |
| Refuses delivery; the player claims the refund after 7 days | back with the creator (`recoverRefunded`) | refunded in full, 0.015153 | lost (0.00234) | nothing, after 7 days and two transactions | none: no proceeds for an undelivered prize |
| Refuses delivery; the player never claims | stays at FWA; the creator cannot recover it | stays in FWA escrow, claimable by the player at any later time | lost | nothing | none |
| Refuses delivery and recovery | stuck at FWA for good (the creator's loss) | refunded on claim | lost | nothing | none |
| Paused at the win, unpaused within 7 days | delivered on anyone's retry | normal | normal | the NFT | normal proceeds |
| **Seizes after delivery** | **taken back from the winner by the creator** | **kept: 0.014432 credited to the creator's pool** | lost | **nothing** | **the draw's proceeds plus the prize back** |

**Can a creator use this to take players' money?** Yes, with a seizing collection. Delivery succeeds, FWA credits the
draw to the pool, and the creator takes the NFT back. Each win of that NFT is a full draw payment taken. A creator could
build a board of such NFTs. Refusing collections take no money; they burn the player's randomness fee (0.00234 at
1 gwei, 0.0117 at 5 gwei) and lock the price for 7 days. The creator can relist the NFT and repeat.

The simplest version needs no hostile code: list a worthless NFT at a high value. FWA prices it as worth that value.
Seizure is the same harm with a real-looking NFT.

### Owner decision: follow FWA's rules

**Owner decision (confirmed directly 2026-11-13; a collection label was considered and dropped for now, since FWA has no on-chain list and its site's verdict is not reachable from our app):** "defer to whatever FWA already does, since we're a pass-through for them". No
allowlist and no new prevention in our contracts. FWA's rules, from its verified source, are now written into
`docs/SPEC.md` (curated NFTs) and the closeout outcome O6 carries the exception: an NFT whose delivery failed stays at
FWA until its winner takes the refund (or for good, if the collection also refuses recovery). The pool page's text for a
failed delivery states the same rules.

**What remains for players, stated for the record:** FWA treats a transfer that succeeded as final. A collection whose
owner can move tokens can take a prize back from its winner after FWA credited the draw: measured, the winner paid
0.017493 ETH and kept nothing, and 0.014432 ETH went to the creator's pool. Under the owner's decision this is FWA's
domain, as for any FWA pool.

## Things that don't make sense

- `test/utils/ForkBase.sol`'s `buy` reads `pool.inventoryVersion()` after `vm.prank`, so the test contract pays and the
  named buyer is only the purchaser. Results that measure the buyer's balance must not use it. The new tests don't; the
  existing tests only use it to create draws.
- The randomness-fee floor (2.04× at 5 gwei) sits outside our control. Any player-price outcome above 2 gwei is mostly
  about FWA's fee.
