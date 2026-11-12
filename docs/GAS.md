# Gas benchmarks and keeper bounds

Measured with `forge test --match-contract GasBench --isolate -vv` on a mainnet fork at block 26,382,349 (real FWA
StandardPoolBuyback and Shapes). `--isolate` runs each call as its own transaction: cold storage, intrinsic gas, and
EIP-3529 refunds applied, so "billed" is what the sender pays for. Every keeper benchmark asserts reimbursed gas ≤ billed
gas, and the keeper e2e (`npm run keeper:e2e`) asserts the same against real anvil receipts.

Measured on the 2026-11-11 rewrite (`forge test --match-path test/Gas.t.sol -vv`, mainnet fork block 26,382,349). The
heaviest upkeep measured uses 2,756,732 gas in total, 14% under the 3.2M reimbursement cap; that is why one call restocks
at most 5 Shape units in 4 sizes and reconciles at most 5 draws.

| Operation | Billed gas | Reimbursed gas | Ratio |
| --- | ---: | ---: | ---: |
| `performUpkeep`: reconcile 5 settled draws + restock 5 Shapes in 4 sizes (heaviest measured) | 2,624,171 | 2,167,694 | 0.83 |
| `performUpkeep`: reconcile 5 + 4 Shapes in 4 sizes | 2,158,709 | 1,788,604 | 0.83 |
| `performUpkeep`: reconcile 1 draw + replace 1 Shape | 763,379 | 626,260 | 0.82 |
| `performUpkeep`: reconcile 5 + replace 5 Shapes in 4 sizes | 2,526,701 | 2,089,718 | 0.83 |
| `performUpkeep`: reconcile 1 curated draw (no restock) | 138,667 | 99,366 | 0.72 |
| `performUpkeep`: reconcile a refund-only draw | 105,783 | 55,443 | 0.52 |
| `performUpkeep`: fill step, 5 Shapes (mint + list) | 2,428,589 to 2,513,124 | 1,934,455 to 2,002,083 | 0.80 |
| `performUpkeep`: fill step, 1 three-Shape pack | 1,248,382 to 1,368,081 | 999,249 to 1,095,008 | 0.80 |
| `unlistShapes(20)`: withdraw + redeem 20 prizes (creator, unpaid) | 2,617,435 | – | – |
| `recoverRefunded`: recover + redeem a Shape (creator, unpaid) | 140,130 | – | – |
| `canPurchase` (admission gate, under FWA's 100k stipend) | 57,152 (call) | – | – |
| FWA `acquireBatch(5)` including the Balancer operator check | 1,661,430 | – | – |
| `BalancerFactory.createBalancer` (clone, FWA pool, operator, Shapes + Packs approval) | 806,548 | – | – |

Delivery failures are resolved per item and never scanned, so routine upkeep gas does not grow with refund history or
hostile collections (`test_historicalRefundsDoNotGrowUpkeepGas`: 200 refunded deliveries leave upkeep gas unchanged).

FWA listing dominates: each listing writes the listing struct and updates a 32-level segment tree. Shapes mint gas varies
with each block's seed, so the keeper sends upkeep, and the dashboard sends every transaction, with a 30% gas-limit margin
over the estimate. The margin is a limit only: the contract reimburses measured gas, never the limit.

## Keeper reward

```
price     = min(tx.gasprice, basefee + 0.05 gwei, 5 gwei)
measured  = min(gasStart - gasleft(), 3.2M)
reward    = measured × price + 0.0005 ETH        (any call that reconciles draws or restocks)
            creator-started work: in full, from the creator's ETH
            otherwise: at most keeperCredit, the markup earned on reconciled delivered draws, which it spends
MAX_KEEPER_REWARD = 3.2M × 5 gwei + 0.0005 ETH = 0.0165 ETH
```

The fixed 0.0005 ETH covers what a keeper cannot see in the measured span (21k intrinsic, calldata, the first touch of
the Balancer) and the gap between `eth_estimateGas` and billed gas that rational keepers cost work with. The `KeeperPaid`
event's `gasUsed` is the measured gas.

Lifetime keeper pay outside creator work never exceeds the markup earned (`invariant_keeperPayWithinMarkupEarned`).
Measured gas is taken before EIP-3529 refunds, so a call can be paid up to 1/5 more gas than billed (refund-heavy
redeems on unlisting are creator work); that surplus also comes out of the credit. A keeper's profit per call is the
0.0005 ETH plus any refund gap, and every call needs draws, each costing a buyer FWA's edge and the VRF fee on top of the
markup, so buying one's own draws to earn credit loses money (`KeeperAdversarial.t.sol`).

### Why the fixed part is 0.0005 ETH, not a margin over the shortfall

The launch rehearsal at 4.9 gwei found the previous rule (`max(0.0005, shortfall + 0.0001)`) stalled: the bundled
keeper prices work with `eth_estimateGas`, which exceeded billed gas by 71k–295k gas (median 78k, 25 keeper
transactions), i.e. ~0.0004 ETH at 5 gwei, so it skipped profitable fill steps and the pool stayed closed. With
0.0005 ETH on top of the full measured gas, the median estimate gap is covered up to the cap.

### Keeper PnL by operation and basefee

Reward − billed gas × price, keeper bidding 0.05 gwei priority, from real receipts on the fork
(`forge test --match-path test/Gas.t.sol --match-test "breakEven|profitAtCap" -vv`), measured on the rewrite.

Pools at 15% markup; curated NFTs at 0.3 and 0.5 ETH.

| Upkeep | Paid from | PnL at 4.95 gwei | Profitable up to |
| --- | --- | --- | --- |
| replace 1 Shape, typical pool | markup earned | +0.00060 ETH | 4.95 gwei (all tested) |
| replace 5 Shapes in 4 sizes | markup earned | +0.00093 ETH | – |
| replace 1 Shape, 0.01-ETH-only pool | markup earned, binds (0.0005 ETH per draw) | −0.0033 ETH | 0.5 gwei |
| reconcile 1 curated draw (no restock) | markup earned (0.045 ETH) | +0.00043 ETH | – |
| fill step (5 Shape units) | creator, full | +0.00045 ETH | 4.95 gwei (all tested) |
| reconcile a refund-only draw | nothing earned | unpaid unless credit remains | – |

Where the markup earned does not cover a call, the keeper waits for more draws (or lower gas) instead of the pool paying
the difference; with only 0.01 Shapes at 15%, one draw's 0.0005 ETH covers a restock to about 0.5 gwei.

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

History, superseded by DECISIONS 51: the 4/5 split bounded the part of a reward paid whatever the markup earned. No such
part remains (every reward outside creator work comes from the credit), so the reward is measured gas × price + 0.0005
ETH. The comparison is kept for the record.

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

The credit was first FWA's edge on delivered draws and paid only the incentive; the gas part came from the creator's ETH
whatever the markup, so pools lost money above about 2 gwei. It is now the markup earned and pays the whole reward
(DECISIONS 51). A creator who prices a curated NFT below market gives a winner that difference either way; the credit
adds only the per-call keeper profit above, which each draw's edge and VRF fee outweigh.

## Work no rational keeper runs

A call that only reconciles refunded draws earns nothing and is unpaid once the credit is spent; the bundled keeper's
`MAX_LOSS_WEI` allowance (default 0.0002 ETH, judged against the gas estimate) covers these at low gas, the next paid
call reconciles them anyway, and the creator can run upkeep from the dashboard.

## Keeper reserve audit

`requiredReserve()` is a withdrawal bound only; it is not spent while the pool is open. Components, while open:

| Component of `requiredReserve()` while open | Protects | Sized at |
| --- | --- | --- |
| deficit: missing prizes × (backing + mint fee per Shape inside) | restoring the target from the prizes currently listed | exact |
| (unreconciled draws + 1) × the most expensive prize in the target (its backing + the mint fee for each Shape inside it) | one largest prize per unreconciled draw and one spare, so a big win is restocked | upper bound: a draw can remove at most the most expensive prize |
| one maximum keeper reward per 6-Shape-unit restocking call needed (rounded up), plus one; each unreconciled draw and the spare counted as 3 Shape units | paying the upkeep calls that restock, at any price up to the cap | 0.0165 ETH each (the hard guarantee) |

Each reward uses the fixed maximum (0.0165 ETH), so the bound does not move with the current gas price. A restore paid at
the cap spends held ETH; if the balance then falls below `requiredReserve()`, the gate can read LOW_INVENTORY (status 6)
until the creator deposits `requiredReserve() − balance`. Reserve sizes for representative inventories are **to be
measured on the rewrite** (the previous design's `test_reserveSizes` numbers do not carry over).

## Keeper bounds (constants in `PoolBalancer`)

| Constant | Value | Basis |
| --- | --- | --- |
| `MAX_SHAPES_PER_PLAN` | 80 prizes in the target | bounds the target's prize count; no listing-scan loop remains |
| `MAX_RECONCILE` | 5 settled sequences reconciled per call | ~33k gas each; a drawn listing is read and cleared, never scanned again |
| `MAX_RESTOCK_SIZES` | 4 prize sizes restocked per call | each size is its own mint call (~0.5M gas with its listing); 6 sizes measured 3.19M |
| `MAX_OPS` | 5 Shape units restocked per call; a pack counts the Shapes it holds (2 or 3) | ~425k gas per Shape with its listing, ~870k per three-Shape pack; 6 units with 5 reconciles measured 3.13M |
| `KEEPER_MAX_GAS` | 3,200,000 | worst measured upkeep plus headroom for mint-seed variance |
| `KEEPER_PRIORITY_CAP` | 0.05 gwei over basefee | a keeper's priority bid above this is its own cost (collection-games#23) |
| `KEEPER_MAX_GAS_PRICE` | 5 gwei | covers ~99% of measured blocks; above it keepers wait and new purchases pause (longest measured episode ~42 min) |
| `KEEPER_INCENTIVE` | 0.0005 ETH | fixed part of every reward; covers gas outside the measured span and the `eth_estimateGas` gap |
| `MAX_KEEPER_REWARD` | 0.0165 ETH | `3.2M × 5 gwei + 0.0005`; `requiredReserve` holds one per restocking call plus one |

The reserve cost of the 5 gwei cap is idle capital, not spending; see the reserve audit above.

Creating work is not profitable for a keeper: work comes from purchases, which cost the buyer FWA's 5% edge plus the
markup plus the VRF fee on top of the expected value received, while a call's profit is at most the 0.0005 ETH plus any
refund gap, out of markup already earned.
