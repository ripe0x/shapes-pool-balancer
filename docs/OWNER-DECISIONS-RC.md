# Owner decisions for the release candidate

Draft for the owner. Nothing here is approved or signed. Every number is measured on the pinned mainnet fork (block
26,382,349, basefee 0.5 gwei and gas price 0.55 gwei asserted inside a transaction), with real FWA, randomness service,
Shapes, Draw Packs and BAYC, using `test/scenario/FlowBreakdown.t.sol`. Shared inputs: a Balanced board (24 × 0.01,
8 × 0.02 pack, 12 × 0.05, 2 × 0.1, 1 × 0.5 ETH Shapes; 47 prizes, 55 Shapes, 1.7 ETH of backing), a 25% markup, one
0.2 ETH NFT, a 5 ETH deposit and 180 draws over 30 days. The creator claims everything claimable each day. Source:
branch `test/flow-restock-in-flight`, contract source identical to `ec5259c` (option B).

## E9: after two 0.5 ETH wins, the top prize is missing

**What happens.** The two 0.5 ETH Shapes are won on draws 60 and 61. Restocking the top prize needs 1.05 ETH more than
the Balancer holds. **No purchase is refused**: in this mix the missing prize is a small part of the gate's prize
weight. Players keep buying from a board without its headline prize, priced on that board by FWA.

| Option | What the creator does | Top prize missing | Draws refused | Creator's ETH locked | Creator's claims by day 30 | Creator's end position (claims + everything still in the pool) | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Wait (today) | nothing | **20 of 30 days, still missing at day 30** | 0 | the reserve it already holds | 3.373 ETH | 4.833 ETH | The board lacks its headline prize indefinitely. Sales refill the fund only slowly (the game's 10% of markup plus fees), so in this run they never covered the 1.05 ETH. The dashboard keeps showing a design the pool doesn't have. |
| **Add ETH** | deposits what the reserve is short by, right after the second win | 0 days | 0 | **+0.963 ETH deposited**; at day 30, 0.273 ETH more in the reserve and 0.5 ETH more in listed backing than waiting | 3.768 ETH | 6.001 ETH on 5.963 deposited | Capital at risk if the top prize is won a third time. |
| **Continue without the 0.5 ETH prize** | saves the same design without it | 0 days (the design no longer has it) | 0 | none extra; the reserve requirement falls | **3.500 ETH (+0.127 vs wait)** | 4.833 ETH | Players lose the top prize until the creator adds it back (save the design again plus deposit). |

How to read the position column: the wait and continue rows sold the same draws to the same winners, so their positions
match (4.8333 vs 4.8332 ETH). Continuing frees 0.127 ETH sooner. The add-ETH row's draws were priced with the top
prize back on the board: players paid 0.055 ETH more over the 118 later draws. It also had different winners, who were
paid 0.14 ETH less backing. That part is luck from one run of random words, not an effect of the option.

**Recommendation: build "Continue without the 0.5 ETH prize" and show it next to "Add 0.96 ETH" on a pool whose top
prize is missing.** The creator chooses. Why:
- Both options end the gap at once; waiting doesn't end it within 30 days.
- Continuing needs no new ETH and frees 0.127 ETH sooner. The contract already supports it (`configure`); the change is
  dashboard only.
- No contract change is needed and no default is imposed on the creator.

**Not measured here:** a top-heavy board, where the missing prize drops prize weight below the gate's 70% and purchases
stop (the case the independent audit raised). There the same two actions apply; continuing without the prize reopens
purchases. A fork proof for that case is still to do.

## Outcomes, ready for signature at the release candidate

These are the gate's outcomes (`asset-flow.json`), as measured on every required regime. **Who set each number:** every
limit below is the agent's proposal unless marked "owner". The wording of O4 ("exact redeemable backing") and the 10%
game share in O8 come from the owner's earlier decisions. The owner signs with their own key; no approval block is
added here.

Regimes: Q quiet, L limits_at_max, I max_then_idle, Z zero_demand, W large_win, G gas_spike, R randomness_not_delivered,
C closeout_pending, F restock_in_flight. "–" means the outcome is not checked in that regime.

| # | Outcome (plain words) | Limit (who set it) | Q | L | I | Z | W | G | R | C | F | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| O1 | **Reworded.** Keepers get their gas, a 50,000-gas overhead and 0.0001 ETH per useful call; the storage refunds they keep add at most a small amount | ≤ 0.002 ETH per 180 draws (agent; the 0.0001 ETH and 50,000 are provisional, owner to approve) | 0 | 0.00148 | 0.00148 | 0 | 0 | 0.00005 | 0 | 0.00076 | 0.00161 | pass |
| O2 | Restocking fees inside prizes still listed never exceed one board at the 5 gwei cap | ≤ 0.26 ETH (agent) | 0.038 | 0.038 | 0.038 | 0.038 | 0.038 | 0.074 | 0.038 | 0 | 0.038 | pass |
| O3 | Right after closing, every wei in the Balancer is claimable | 0 ETH unclaimable (agent) | – | – | – | – | – | – | – | 0 | – | pass |
| O4 | Every prize unlisted redeems for exactly its backing | 0 wei gap (owner goal; agent number) | – | – | – | – | – | – | – | 0 | – | pass |
| O5 | After keepers finish, no prize is missing from the board for lack of ETH | 0 keeper passes (agent) | 0 | 0 | 0 | 0 | **119** | 0 | 0 | 0 | 0 | **fail: E9 above** |
| O6 | After closeout, the Balancer, its listed backing and its uncollected FWA proceeds hold nothing | 0 ETH (agent) | – | – | – | – | – | – | – | 0 | – | pass |
| O7 | No draw is refused for low inventory while gas is within the 5 gwei cap | 0 draws (agent) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | pass |
| O8 | The first 10% of Shape markup goes to the game: the creator's profit share of proceeds stays under the markup above 10% | ≤ 12.00% of proceeds at a 25% markup (owner's 10%; agent's 12% at 25% markup) | 10.70% | 10.70% | 10.70% | 0 | 10.59% | 10.23% | 10.70% | 10.47% | 10.71% | pass |
| O9 | **New.** The creator's profit follows the board each draw was priced on, with restocks listed while draws are in flight | ≤ 0.001 ETH booked beyond that split per 180 draws (agent) | – | – | – | – | – | – | – | – | 0.00030 | pass |

O9 detail (`restock_in_flight`): 180 collections checked. FWA's owner proceeds match the price computed from its board
to the wei. The split was computed independently from FWA's active listings at each purchase. The Balancer booked
0.424535 ETH against 0.424234 ETH expected, overbooked by 0.000301 ETH (0.07%), at most 2.12% in one collection, never
underbooked. Why: restocks staged while a draw is pending join the Balancer's tracked set before that draw's proceeds
are collected. Supporting evidence: `limits_at_max`, which restocks in flight less often before collecting, booked
exactly the expected 0.424234 ETH.

O5 will pass for the Balanced mix only if E9's option is part of the design that is signed. Otherwise the owner signs
it as a known exception with its number (119 keeper passes, 20 days without the top prize).

## Things that don't make sense

- O1's worst case moved by 35,750,000,000 wei (65 gas at 0.55 gwei) between two runs of identical code. Gas measured
  around a call is not fully deterministic in this harness. It's too small to matter, but it means O1 cannot have a
  zero-tolerance limit.
- The independent audit's top-heavy stall is the more serious E9 case, and none of the regimes reaches it.
