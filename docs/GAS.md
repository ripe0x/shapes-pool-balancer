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
with each block's seed, so the keeper sends upkeep, and the dashboard sends every transaction, with a 30% gas-limit margin over the estimate. The margin
is a limit only: the contract reimburses measured gas, never the limit.

## Why 4/5

In-transaction measurement (`gasStart - gasleft()`) runs before EIP-3529 refunds, which can cut the billed gas by up to
1/5 of the gas used. Measured refunds on these paths ranged from about 1% (fill steps) to the full 20% (plan switches
and unwind, which clear many slots in FWA and Shapes). Paying 4/5 of the measured span, a lower bound on the
transaction's pre-refund gas, can never exceed billed gas, whatever refunds FWA or Shapes produce. The `KeeperPaid`
event's `gasUsed` is this reimbursed gas.

## Keeper reward

```
price     = min(tx.gasprice, basefee + 0.05 gwei, 5 gwei)
measured  = min(gasStart - gasleft(), 3.2M)
reward    = measured × 4/5 × price                                   (gas, never above billed)
          + incentive                                                (inventory work)
incentive = measured × 1/5 × price + 0.0005 ETH
            creator-caused work: in full
            purchase-caused work: up to the remaining edge credit (FWA's edge on delivered draws of the batch)
gas-only calls (refund-only batch, recoverRefundedShape): the 4/5 part only
MAX_KEEPER_REWARD = 3.2M × 5 gwei + 0.0005 ETH = 0.0165 ETH
```

The 4/5 part alone can never exceed billed gas (EIP-3529). The incentive returns the other fifth and adds 0.0005 ETH,
which covers what a keeper cannot see in the measured span (21k intrinsic, calldata, the first touch of the Balancer)
and the gap between `eth_estimateGas` and billed gas that rational keepers cost work with. Purchase-caused incentives
are paid from the batch's edge credit, so a buyer who is also the keeper never receives more than the edge it paid FWA.

### Why the fixed part is 0.0005 ETH, not a margin over the shortfall

The launch rehearsal at 4.9 gwei found the previous rule (`max(0.0005, shortfall + 0.0001)`) stalled: the bundled
keeper prices work with `eth_estimateGas`, which exceeded billed gas by 71k–295k gas (median 78k, 25 keeper
transactions), i.e. ~0.0004 ETH at 5 gwei, so it skipped profitable fill steps and the pool stayed closed. With
0.0005 ETH on top of the full measured gas, the median estimate gap is covered up to the cap.

### Keeper PnL by operation and basefee (final rule)

Reward − billed gas × price, keeper bidding 0.05 gwei priority, real receipts on the fork:
`forge test --match-path test/Gas.t.sol --match-test breakEven --isolate -vv`.

| Upkeep | Billed gas | Incentive source | PnL at 0.08 gwei | at 2 gwei | at 4.95 gwei (cap) | Profitable to |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| replace 1 Shape, typical pool | 848,846 | edge credit | +0.00050 | +0.00054 | +0.00060 | cap (full) |
| replace 1 Shape, 0.01-ETH-only pool | 841,636 | edge credit, binds | +0.00050 | +0.00038 | −0.00007 | 4.2 gwei (limited) |
| replace 5 Shapes, one denomination | 2,154,065 | edge credit | +0.00051 | +0.00063 | +0.00081 | cap (full) |
| replace 5 Shapes, four denominations | 2,613,847 | edge credit | +0.00051 | +0.00067 | +0.00093 | cap (full) |
| reconcile 1 curated draw | 231,450 | edge credit | +0.00050 | +0.00048 | +0.00042 | cap (full) |
| plan switch after a curated draw | 1,084,211 | edge credit | +0.00053 | +0.00087 | +0.00078 | cap (full) |
| fill step (6 mints) | 2,194,477 | creator, full | +0.00050 | +0.00049 | +0.00047 | cap (full) |
| plan switch after a configure | 1,001,750 | creator, full | +0.00053 | +0.00093 | +0.00156 | cap (full) |
| reprice 6 listings | 594,709 | creator, full | +0.00050 | +0.00046 | +0.00040 | cap (full) |
| refund-only batch | 197,008 | gas only (4/5) | −0.000009 | −0.00013 | −0.00033 | never (gas-only) |
| re-checkpoint after a creator edit | 155,096 | unpaid | −0.00002 | −0.00032 | −0.00078 | never (unpaid) |

PnL above uses billed gas. A keeper that costs work with `eth_estimateGas` sees ~78k gas × price less (−0.0004 ETH
at the cap), so at the cap the thinnest paid rows (reconcile, reprice, fill step) clear the median estimate gap by
~0.00002–0.0001 ETH and the rest by more. Plan switches earn more at high gas because they produce large refunds,
which raise the measured span above billed gas; the excess is bounded by the 1/5 refund cap and `MAX_KEEPER_REWARD`,
and is paid only for creator-caused work or from the edge credit.

## Priority allowance

Competing permissionless keepers bid whatever priority is reimbursed, so the priority cap is a per-gas surcharge on
every upkeep. The useful priority is the one that gets an upkeep into the next block. Measured on the same 90-day
sample (`eth_feeHistory` reward percentiles), the 10th-percentile priority of included transactions per block:

| Basefee regime | median | p90 | p99 |
| --- | ---: | ---: | ---: |
| < 0.3 gwei | 0 | 0.001 | 0.05 |
| 0.3–1 gwei | 0.0001 | 0.021 | 0.23 |
| 1–2 gwei | 0.0013 | 0.10 | 0.99 |
| 2–5 gwei | 0.01 | 0.14 | 1.54 |
| > 5 gwei | 0.0003 | 0.15 | 1.56 |

0.05 gwei clears the block's p10 in ~99% of blocks below 0.3 gwei (where ~90% of blocks sit) and in the median
block of every regime; during spikes above 1 gwei, 10% of blocks need 0.10–0.15 gwei. Bidding more buys almost no
latency: in the simulation the median inclusion delay is ~12 s for every cap from 0.05 to 1 gwei, while keeper spend
rises 91% (baseline) to 142% (0.01-ETH-only pool) at 1 gwei. Above the cap a keeper may still bid more; the excess is
its own cost and the contract pays `basefee + 0.05 gwei`. FWA V2's sponsored processing reimburses up to
`min(basefee, 5) + 1 gwei` with no incentive; that works for its allowlisted operators but not for permissionless
competition (`docs/simulation-results.md`). A basefee-indexed priority schedule was not added: it would only change
the latency, which is already one block.

## Reimbursement model comparison

Question: does the universal 4/5 haircut plus the price-linked incentive cost creators more than an operation-aware
model (full reimbursement for mint/list work, which produces ~1% refunds; 4/5 only for refund-heavy redeem and
reconcile work)?

| Criterion | 4/5 gas + (1/5 gas + 0.0005 ETH) incentive (kept) | Operation-aware haircut | Per-operation gas allowances |
| --- | --- | --- | --- |
| Reimbursed gas ≤ billed gas, any composition | yes: refunds are capped at 1/5 of the whole transaction's gas | **no**: a keeper can batch a refund-heavy upkeep (pool X redeems) with a mint-heavy one (pool Y) in one transaction; the shared refund lowers Y's billed gas below its 0.99 reimbursement | **no** for the same reason, unless each allowance is ≤ 4/5 of that operation's minimum, which is the 4/5 rule again |
| Creator ETH per 1-Shape replacement at 0.08 gwei | ~859k measured × 0.13 gwei + 0.0005 = 0.000612 ETH | ~843k × 0.13 + 0.0005 = 0.000610 ETH | similar |
| Creator ETH at 4.95 gwei | measured × 5 gwei + 0.0005 ≈ 0.0048 ETH | ≈ billed × 5 gwei + 0.0005 ≈ 0.0047 ETH | similar |
| Keeper profitable to | the 5 gwei cap for every paid type (below) | same, with a fixed incentive | same |
| Worst-case reward | `MAX_KEEPER_REWARD` 0.0165 ETH | same order | same order |
| Bytecode / gas overhead | a few hundred gas per call (+ one SSTORE when credit is spent) | segment measurement around mint/list and redeem code paths, more state | per-operation constants that need re-measuring when FWA or Shapes gas changes |
| Strategic bidding / refund manipulation | bid capped at basefee + 0.05 gwei; reward independent of the caller's own refunds (fork test) | adds a refund-composition surface | adds a calibration surface |

Result: the operation-aware variants are not safer, not simpler and not cheaper for creators. Once the incentive returns
the withheld fifth, the 4/5 split decides only who carries refund risk, not how much creators pay: on inventory work
the total is measured gas × price + 0.0005 ETH either way. A separate ETH payout cap was not added: the gas cap × the
price cap already bound every reward at 0.0165 ETH, and FWA V2's 0.02 ETH cap plays the same role for its 2.1M gas.

The FWA edge credit was also compared with a budget based on the Balancer's own markup. A self-dealer always loses the
FWA edge (paid to FWA whatever the NFT is worth), but recovers the markup if the NFT drawn is worth more than its
creator-set base, so a markup-based budget is only safe when creators price curated NFTs at or above market. The edge
credit binds only for pools with draws under ~0.012 ETH and only above ~4.2 gwei (below), so it is kept.

## Work no rational keeper runs

Refund-only batches (4/5 of measured gas: −0.00033 ETH at the cap)
and unpaid re-checkpoints after creator edits, deposits or mint-fee changes (155k billed gas,
`test_gas_unpaidRecheckpoint`). They cannot be batched with paid work in the same pool (a re-checkpoint is what reopens
admission, so no purchase-caused work exists until it runs). The bundled keeper's `MAX_LOSS_WEI` allowance (default
0.0002 ETH, judged against the gas estimate) covers refund-only batches to ~1.3 gwei and re-checkpoints to ~0.85 gwei
when the estimate runs 78k gas above billed (~3 gwei and ~1.2 gwei at billed gas); above that the creator runs
them. Paying them would create work an outsider can trigger (refund-only batches) or a payment for checkpointing that
the brief excludes; neither is added.

## Keeper reserve audit

| Component of `requiredReserve()` while open | Protects | Sized at |
| --- | --- | --- |
| deficit: missing Shapes × (backing + mint fee) | restoring the active plan | exact |
| worst batch: largest 5 Shapes × (backing + mint fee) | replacing what an admitted batch can draw | exact |
| one maximum keeper reward | paying the upkeep that restores an admitted batch, at any price up to the cap | 0.0165 ETH (the hard guarantee) |
| one reward for the call that writes the next checkpoint | admission still holds after that call pays its keeper | 3.2M gas × **current** reimbursable price + 0.0005 ETH |
| one reward per remaining 6-Shape refill step | creator-started refills | same, per step |

Only one batch is ever admitted per checkpoint, so one held maximum reward covers every accepted obligation; the other
allowances are availability, not obligations. Pricing them at the current gas is safe because each is checked again
when used: `_checkpoint` requires `reserve + _rewardBound(this transaction's price)` before admitting anything, so a
spike after a claim can only delay reopening (status 6), never admit an unfunded batch. Fork tests:
`test_exactRequiredReserveOpens*` (0.08, 0.5, 4.95 gwei), `test_maxClaimThenWorstBatchAtCapIsFunded` (surplus claimed
at 0.08 gwei, worst 5 Shapes drawn, restored and keeper paid at 4.95 gwei), `test_claimAllSurplusThenRecheckpointStaysOpen`.

| Inventory (`test_reserveSizes`) | Opening capital at 0.08 / 4.95 gwei | Running reserve at 0.08 / 4.95 gwei | Original PR opening / running (0.08 gwei) |
| --- | --- | --- | --- |
| small: ten 0.01 Shapes | 0.1842 / 0.2310 ETH | 0.0724 / 0.0880 ETH | 0.2298 / 0.0874 ETH |
| medium: 5×0.01, 3×0.05, 2×0.1 | 0.7842 / 0.8310 ETH | 0.3724 / 0.3880 ETH | 0.8298 / 0.3874 ETH |
| large: 4×0.5, 2×1, 1×5 | 17.0312 / 17.0780 ETH | 8.0224 / 8.0380 ETH | 17.078 / 8.038 ETH |

The final rule adds 0.0003 ETH to the held maximum (0.016205 → 0.0165) and 0.0004 ETH per current-price allowance at
0.08 gwei relative to the previous rule (small pool opening 0.1840 → 0.1842 ETH). Opening capital excludes the
curated NFTs. Fork tests `test_exactRequiredReserveOpens*`, `test_maxClaimThenWorstBatchAtCapIsFunded` and
`test_claimSurplusRespectsReserveWhileOpen` and `test_repeatedMaxClaimWorstBatchesAtCap` cover the exact boundary
(claiming `withdrawableSurplus() + 1` reverts; claiming exactly it keeps the pool open), a maximum claim followed by
the worst batch at the cap, and four such cycles in a row. A restore paid at the cap spends the held maximum reward, so
the pool then fails closed (status 6) with inventory complete until the creator deposits `requiredReserve() −
balance`; that exact amount reopens it.

## Keeper bounds (constants in `PoolBalancer`)

| Constant | Value | Basis |
| --- | --- | --- |
| `MAX_OPS` | 6, shared by repricing and rebalancing in one call | keeps a fill step under ~3.05M billed gas; worst bounded upkeep (5 reconciles + 6 mints in 6 denominations) 3.10M |
| `KEEPER_MAX_GAS` | 3,200,000 | worst measured upkeep plus headroom for mint-seed variance |
| refund factor | 4/5 of the measured span | EIP-3529 refund bound (above) |
| `KEEPER_PRIORITY_CAP` | 0.05 gwei over basefee | a keeper's priority bid above this is its own cost (collection-games#23) |
| `KEEPER_MAX_GAS_PRICE` | 5 gwei | covers ~99% of measured blocks; above it keepers wait and new purchases pause (longest measured episode ~42 min) |
| `KEEPER_INCENTIVE` | 0.0005 ETH | fixed part of the incentive (with the withheld 1/5 of gas); covers gas outside the measured span and the `eth_estimateGas` gap; creator-started work in full, purchase-caused work from the edge credit |
| `MAX_KEEPER_REWARD` | 0.0165 ETH | `3.2M × 5 gwei + 0.0005`; the checkpoint holds one; other allowances use the current price (original PR 0.0325 ETH) |

The reserve cost of the 5 gwei cap is idle capital, not spending; see the reserve audit above.

Creating work is not profitable for a keeper: work comes from purchases, which cost the buyer FWA's 5% edge plus the
markup plus the VRF fee on top of the expected value received, and the incentives that batch can fund never exceed
FWA's edge on it.
