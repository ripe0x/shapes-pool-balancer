# Gas benchmarks and keeper bounds

Measured on a mainnet fork at block 26,382,349 (real FWA StandardPoolBuyback and Shapes) with
`forge test --match-contract GasBench --isolate -vv`. `--isolate` runs each call as its own transaction: cold storage,
intrinsic gas, and EIP-3529 refunds applied, so "billed" is what the sender pays for. Every keeper benchmark asserts
reimbursed gas ≤ billed gas. The keeper e2e (`npm run keeper:e2e`) asserts the same against real anvil receipts.

| Operation | Billed gas | Reimbursed gas | Ratio |
| --- | ---: | ---: | ---: |
| `performUpkeep`: reconcile + replace 1 Shape + checkpoint | 842,897 | 687,016 | 82% |
| `performUpkeep`: reconcile + replace 5 Shapes (one denomination) | 2,151,856 | 1,768,743 | 82% |
| `performUpkeep`: reconcile + replace 5 Shapes (four denominations) | 2,611,488 | 2,154,688 | 83% |
| `performUpkeep`: plan switch, withdraw + redeem 6 Shapes | 1,004,800 | 970,547 | 97% |
| `performUpkeep`: plan switch, withdraw + redeem 2 Shapes + checkpoint | 591,177 | 538,121 | 91% |
| 8 `performUpkeep` calls in one transaction (contract keeper), redeem 35 Shapes | 4,704,186 | 4,474,237 | 95% |
| `recoverRefundedShape`: recover + redeem | 145,855 | 114,598 | 79% |
| `performUpkeep`: reconcile 1 curated draw + checkpoint | 229,930 | 171,764 | 75% |
| `performUpkeep`: reconcile a refund-only batch + checkpoint | 194,763 | 129,512 | 66% |
| `performUpkeep`: reprice 6 of 100 listings (full scan) | 598,525 | 460,240 | 77% |
| `performUpkeep`: fill step, 6 Shapes (mint + list) | 2.90M–3.01M | 2.30M–2.39M | 79–80% |
| `unwind(20)`: withdraw + redeem 20 Shapes (creator, unpaid) | 2,407,321 | – | – |
| FWA `acquireBatch(5)` including the Balancer operator check | 1,661,074 | – | – |
| `BalancerFactory.createBalancer` (clone, FWA pool, operator, Shapes approval) | 776,162 | – | – |

Real receipts from the keeper e2e at the release candidate (`7fcdbe4`, anvil fork): fill steps 2,208,949 and
3,029,258 billed / 1,753,673 and 2,409,738 reimbursed (79–80%); 1–5 draw replacements 847,103–939,643 / 675,939–757,651
(80–81%); `recoverRefundedShape` 155,443 / 114,616 (74%). No keeper transaction was reimbursed more gas than billed.

Other measurements: 100 listings take 17 repricing upkeeps after a markup change; routine Shape upkeep gas is unchanged
after 200 refunded curated deliveries (847k before, 836k after); `canPurchase` stays under FWA's 100k stipend.

FWA listing dominates: each listing writes the listing struct and updates a 32-level segment tree. Shapes mint gas varies
with each block's seed, so the keeper and dashboard send upkeep with a 30% gas-limit margin over the estimate. The margin
is a limit only: the contract reimburses measured gas, never the limit.

## Why 4/5

In-transaction measurement (`gasStart - gasleft()`) runs before EIP-3529 refunds, which can cut the billed gas by up to
1/5 of the gas used. Measured refunds on these paths ranged from about 1% (fill steps) to the full 20% (plan switches
and unwind, which clear many slots in FWA and Shapes). Paying 4/5 of the measured span, a lower bound on the
transaction's pre-refund gas, can never exceed billed gas, whatever refunds FWA or Shapes produce. The `KeeperPaid`
event's `gasUsed` is this reimbursed gas.

## Keeper liveness from measured profitability

A purchase batch closes admission until upkeep restores inventory, so an upkeep that is unprofitable for keepers keeps
the pool closed even when it is funded. The 4/5 rule leaves a keeper short by at most `measured/5 + 21k intrinsic` gas
at the reimbursed price, which grows with gas price; the fixed 0.0005 ETH incentive covered it only up to ~0.76 gwei
(fill steps) and ~1.1 gwei (5-Shape replacements).

Mainnet basefee, 90 days to block 26,385,025 (184,320 blocks sampled with `eth_feeHistory`):

| Measure | Value |
| --- | --- |
| median / p90 / p99 / p99.9 / max | 0.078 / 0.33 / 4.6 / 29.9 / 51 gwei |
| blocks above 0.76 / 1 / 2 / 5 gwei | 4.1% / 3.1% / 2.0% / ~0.9% |
| episodes above 2 gwei (per sampled 13.6 h/day) | 52; median 5 blocks (1 min), p90 262 blocks (~52 min), longest 510 blocks (~1.7 h) |
| episodes above 5 gwei | 49; median 5 blocks, p90 73 blocks (~15 min), longest 208 blocks (~42 min) |

Options compared (`docs/simulation-results.md`, keeper-liveness table, rational keepers on that distribution): a fixed
0.0013 ETH incentive (enough for the worst measured shortfall at 2 gwei) costs 25–70% of creator net for no
measurable uptime, because it overpays on every upkeep at normal gas. Chosen: the incentive is
`max(0.0005 ETH, shortfall at the reimbursed price + 0.0001 ETH)`. At normal gas it is the same 0.0005 ETH; it rises
only when gas does. Purchase-caused work stays capped by the edge credit. The cap was raised to 5 gwei, which halves
skipped upkeeps in the simulation for ~1–4% more keeper spend. Intrinsic gas is credited once per transaction.

Keeper PnL at 4.95 gwei basefee with a 0.05 gwei bid (price 5 gwei, the cap), `forge test --match-path test/Gas.t.sol
--match-test profitAtCap --isolate -vv`:

| Upkeep | Keeper PnL |
| --- | ---: |
| replace 1 Shape (typical pool) | +0.00030 ETH |
| replace 5 Shapes, 4 denominations | +0.00063 ETH |
| fill step (×7) | +0.00015 to +0.00018 ETH |
| plan switch, redeem 6 (creator-caused) | +0.00126 ETH (margin + refunds) |
| reconcile 1 curated draw | +0.00022 ETH |
| refund-only batch (gas only) | −0.00006 ETH (covered by the keeper's 0.0001 ETH default allowance) |
| replace 1 Shape, cheapest pool shape (0.01 ETH Shapes) | +0.00021 at 2.8 gwei; −0.00007 at 4.95 gwei (credit-limited: one draw pays FWA ~0.00057 ETH of edge) |
| 6 paid upkeeps in one transaction | rewards 0.0012 ETH below billed + refunds + margins |

Accepted costs of this rule: for creator-caused work at high gas the keeper earns the margin plus the call's refunds
(up to ~0.0013 ETH per call at the cap); the reserve holds larger keeper rewards (below).

## Keeper bounds (constants in `PoolBalancer`)

| Constant | Value | Basis |
| --- | --- | --- |
| `MAX_OPS` | 6, shared by repricing and rebalancing in one call | keeps a fill step under ~3.05M billed gas; worst bounded upkeep (5 reconciles + 6 mints in 6 denominations) 3.10M |
| `KEEPER_MAX_GAS` | 3,200,000 | worst measured upkeep plus headroom for mint-seed variance |
| refund factor | 4/5 of the measured span | EIP-3529 refund bound (above) |
| `KEEPER_PRIORITY_CAP` | 0.05 gwei over basefee | a keeper's priority bid above this is its own cost (collection-games#23) |
| `KEEPER_MAX_GAS_PRICE` | 5 gwei | covers ~99% of measured blocks; above it keepers wait and new purchases pause (longest measured episode ~42 min) |
| `KEEPER_INCENTIVE` | 0.0005 ETH floor | paid only with inventory work; creator-started work in full, purchase-caused work from the edge credit |
| `KEEPER_MARGIN` | 0.0001 ETH | profit over the measured shortfall when gas is high; covers gas outside the measured span |
| `MAX_KEEPER_REWARD` | 0.016205 ETH | `(3.2M + 21k) × 5 gwei + 0.0001`; the open reserve holds two plus one per refill step still needed (previously 0.0325 ETH, then 0.00562) |

The reserve cost of the 5 gwei cap is idle capital, not spending: a pool with ten 0.01 ETH Shapes needs 0.2298 ETH
liquid when empty (of which ~0.113 ETH is keeper allowance for 2 refill steps and 2 held rewards) and 0.0874 ETH when
full.

Creating work is not profitable for a keeper: work comes from purchases, which cost the buyer FWA's 5% edge plus the
markup plus the VRF fee on top of the expected value received, and the incentives that batch can fund never exceed
FWA's edge on it.
