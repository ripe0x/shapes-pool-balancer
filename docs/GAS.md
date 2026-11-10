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
and unwind, which clear many slots in FWA and Shapes). Paying 4/5 of the measured span, a lower bound on the transaction's
pre-refund gas, can never exceed billed gas, whatever refunds FWA or Shapes produce, and however many paid calls one
transaction makes (no intrinsic-gas credit, which a multi-call transaction pays only once). The cost is that
keepers are under-reimbursed by up to ~20% of gas on refund-light calls; the fixed incentive covers that at normal gas
prices (at 0.2 gwei a 1-Shape replacement costs ~0.0002 ETH; the incentive is 0.0005 ETH). The previous rule
(measured + 45k at full value) overpaid 1–6% on real receipts and up to 25% on plan switches.

## Keeper bounds (constants in `PoolBalancer`)

| Constant | Value | Basis |
| --- | --- | --- |
| `MAX_OPS` | 6, shared by repricing and rebalancing in one call | keeps a fill step under ~3.05M billed gas; worst bounded upkeep (5 reconciles + 6 mints in 6 denominations) 3.10M |
| `KEEPER_MAX_GAS` | 3,200,000 | worst measured upkeep (fill step, 3.04M on a real receipt) plus headroom for mint-seed variance |
| refund factor | 4/5 of the measured span | EIP-3529 refund bound (above); no intrinsic-gas credit |
| `KEEPER_PRIORITY_CAP` | 0.05 gwei over basefee | a keeper's priority bid above this is its own cost (collection-games#23) |
| `KEEPER_MAX_GAS_PRICE` | 2 gwei | ~30× the 0.06 gwei mainnet basefee on 2026-11-10; above it keepers wait and new purchases pause |
| `KEEPER_INCENTIVE` | 0.0005 ETH | paid only with inventory work; covers the 4/5 shortfall at normal gas. Creator-started work pays it in full; purchase-caused work pays it from a credit equal to FWA's edge on the last batch's fees, so buying one's own draws cannot earn more than it paid FWA |
| `MAX_KEEPER_REWARD` | 0.00562 ETH | held in every open pool's reserve (previously 0.0325 ETH) |

Creating work is not profitable for a keeper: work comes from purchases, which cost the buyer FWA's 5% edge plus the
markup plus the VRF fee on top of the expected value received, and the incentives that batch can fund never exceed
FWA's edge on it.

Keeper profitability by basefee for a 1-Shape replacement (reward vs a 0.05 gwei priority bid; `keeper/keeper.test.ts`):
profitable up to the 2 gwei cap. Fill steps (~3M gas) stop being profitable above a ~0.76 gwei basefee because of the 4/5 factor;
the creator can run fill upkeeps from the dashboard.
