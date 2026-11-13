# Fork economics (real contracts)

`test/EconFork.t.sol` on a mainnet fork at block 26,382,349 with the real FWA pool, VRF service, Shapes and Draw Packs,
at commit `9fd5f83` (DECISIONS 66-68). Each run: the Balanced board at 10 or 12 small Shapes (12 includes one 0.5 ETH
Shape), one 0.2 ETH NFT relisted when won, gas at 1 gwei, upkeep after every draw, the creator claiming everything
claimable after every draw. Every run ends with the full closeout (close, unlist every prize, withdraw the NFT, claim
everything): the result below is realized ETH, the Balancer ends with 0 ETH and no listings, and the realized result
equals the pre-closeout estimate to the wei (asserted). Per draw the run also asserts that unclaimed profit is held
and that a claim never takes the fund below where it was or below the reserve.

Volumes: ape-ball's observed curve (184 draws over 30 days: 43, 44, 54, 18, 0, then 1 a day; read from its FWA pool
`0xAACB94216eB83e62D9f1160A38f35A9bE9C778F7` on mainnet) and a steady 40 draws a day for 30 days (1,200 draws).

| Scenario | ETH in | Random runs | Creator result, mean | After NFTs given away: mean (min to max) | Draws with nothing to claim | Top prize off the board | Draws refused |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ape-ball, 10% markup, 12 small | 1.67 | 6 | 0.24 | 0.21 (-0.51 to 0.92) | 67% | 2.4% | 0 |
| ape-ball, 10% markup, 10 small | 0.67 | 6 | 0.25 | -0.05 (-0.40 to 0.28) | 74% | 0% | 0 |
| ape-ball, 25% markup, 12 small | 1.67 | 6 | 1.05 | 0.91 (0.77 to 1.15) | 0% | 0% | 0 |
| ape-ball, 25% markup, 10 small | 0.67 | 6 | 0.82 | 0.75 (0.50 to 1.00) | 0% | 0% | 0 |
| ape-ball, 50% markup, 12 small | 1.67 | 6 | 1.46 | 1.29 (0.50 to 1.64) | 0% | 0.1% | 0 |
| ape-ball, 50% markup, 10 small | 0.67 | 6 | 1.73 | 1.53 (1.16 to 1.75) | 0% | 0% | 0 |
| 40 a day, 10% markup, 12 small | 1.67 | 3 | 2.32 | 1.19 (1.01 to 1.41) | 74% | 5.2% | 0 |
| 40 a day, 25% markup, 12 small | 1.67 | 3 | 5.81 | 5.15 (4.63 to 6.11) | 0% | 4.0% | 0 |

Forced 0.5 ETH wins (12 small; result after NFTs): at 10% markup 0.09 (draw 60) and 0.06 (draw 165) on the ape-ball
curve; at 25% 0.22 and 0.52; at 50% 1.34 and 0.68; at 40 a day, 25%: 5.05 and 4.87.

Reading:
- Every draw sold in every run; no purchase was refused, and no winner went unpaid.
- Above the 10% minimum the creator had something to claim after every draw. At the minimum, the whole markup refills
  the reserve after a win, so 67% to 74% of draws paid the creator nothing (DECISIONS 68), and at ape-ball's volume a
  month at 10% markup can lose money after the NFTs given away (one run with two 0.5 ETH wins lost 0.51 ETH).
- The top prize was off the board 0% to 5.2% of draws, in line with the model (`sim/fund.ts`: 3.4% median at 40 a day
  over 180 days).

Commands (one scenario per process; `ECON_RUNS` random seeds plus the two forced runs):

```bash
ECON_RUNS=6 ECON_MARKUP=2500 ECON_SMALL=12 forge test --match-path test/EconFork.t.sol -vv --gas-limit 100000000000
```

```bash
ECON_RUNS=3 ECON_MARKUP=2500 ECON_SMALL=12 ECON_PER_DAY=40 ECON_DAYS=30 forge test --match-path test/EconFork.t.sol -vv --gas-limit 100000000000
```

Limits: one gas price (1 gwei), keepers that always restock at once, a creator who relists the NFT at once, single
draws rather than batches, and no slippage refunds. Six or three seeds per scenario show the spread, not tail odds;
`sim/fund.ts` covers tails with thousands of runs.
