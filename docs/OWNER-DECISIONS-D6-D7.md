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

**Recommendation: keep the 5 gwei fee cap, show the all-in price (now done in the app), and set the ceiling as an
outcome:** "all-in draw price ≤ 2.5× the expected backing up to 5 gwei on the launch board" (measured worst 2.46×). A
lower fee cap saves players at most 13% at 5 gwei and turns the restocking fee into a cost to the creator. It cannot get
below the 2.04× floor that FWA's own randomness fee sets. If the owner wants ≤ 2× at all times, the only lever is a
purchase pause at high gas, which is a separate contract change and costs sales.

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

### Can we stop such collections being listed through our system?

Players buy on FWA's site, and anyone can create a plain FWA pool with any collection. These options protect pools made
through our factory.

| Option | What it stops | What it does not stop | Cost (measured where possible) | Permissionless creation |
| --- | --- | --- | --- | --- |
| **Allowlist at the factory**, set by an admin, with an "open to all" switch: the keeper list's pattern | Any collection not vetted: seizing, refusing, fake | A vetted collection whose admin can move tokens or that is upgradeable (vet for that). An inflated value on a real NFT | **5,450 gas** per curated listing (cold factory check, measured); a few hundred bytes. PoolBalancer has 3,841 bytes of room under the limit; the factory is 2,117 bytes | Pools stay permissionless; curated NFTs come only from listed collections. An admin key decides the list (no custody or fund powers) |
| Checks at listing | Collections without code, non-ERC-721, a failed transfer in (already enforced); could also reject upgradeable proxies (EIP-1967 slot) | Seizing, pausing, owner-only transfers, behaviour that changes after listing: **the hostile test collection passes every check** | a few thousand gas | unchanged |
| Bound the harm: cap curated NFTs per pool (count, or share of draw weight) | The size of the loss: a board made mostly of fake NFTs | The loss on each capped NFT | small | unchanged; limits creator designs |
| App warnings only (flag collections not on a known list) | Creators and players using our site | Players on FWA's site; on-chain behaviour | none on-chain | unchanged |

**Recommendation: the factory allowlist plus app labels, launching with a short vetted list.** The seizing
collection takes a player's whole payment, and no check at listing time can see it coming. The allowlist costs 5,450
gas per curated listing, and the admin's only power is which collections can be listed. If the owner wants curated
listings fully permissionless, use the cap plus app warnings, and state the remaining risk to players.

## Things that don't make sense

- `test/utils/ForkBase.sol`'s `buy` reads `pool.inventoryVersion()` after `vm.prank`, so the test contract pays and the
  named buyer is only the purchaser. Results that measure the buyer's balance must not use it. The new tests don't; the
  existing tests only use it to create draws.
- The randomness-fee floor (2.04× at 5 gwei) sits outside our control. Any player-price outcome above 2 gwei is mostly
  about FWA's fee.
