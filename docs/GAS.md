# Gas benchmarks and keeper bounds

Measured with `forge test --match-contract GasBench -vv` on a mainnet fork at block 26,382,349 (real FWA
StandardPoolBuyback and Shapes, cold storage as in a real transaction; figures include test-harness overhead of a few
thousand gas).

| Operation | Gas |
| --- | ---: |
| `performUpkeep`: reconcile + replace 1 Shape + checkpoint | 873,679 |
| `performUpkeep`: reconcile + replace 5 Shapes (one denomination) | 2,182,982 |
| `performUpkeep`: reconcile + replace 5 Shapes (four denominations) | 2,641,229 |
| `performUpkeep`: reconcile a refund-only batch + checkpoint | 224,992 |
| `performUpkeep`: fill step, 6 Shapes (mint + list) | 2.9M–3.05M |
| FWA `acquireBatch(5)` including the Balancer operator check | 1,673,764 |
| `BalancerFactory.createBalancer` (clone, FWA pool, operator, Shapes approval) | 781,269 |
| Deploy `PoolBalancer` implementation / `BalancerFactory` (fork rehearsal) | ~4.96M / ~0.32M |
| `canPurchase` (pranked as the pool) | < 100,000 (asserted); ~30k |
| Shapes `mintBatch` (mainnet estimate) | 162,820 first + ~75,600 each additional |

Upkeep figures were measured before the review repairs (`ac99894`), which add about 2k gas per upkeep (re-measured: 875,550 for one replacement).

FWA listing dominates: each listing writes the listing struct and updates a 32-level segment tree.

Shapes mint gas varies with each block's seed. A transaction sent with a bare `eth_estimateGas` limit ran out of gas on
the fork (3.17M limit, failed at 3.12M), so the keeper and dashboard send upkeep with 30% headroom.

## Keeper bounds (constants in `PoolBalancer`)

| Constant | Value | Basis |
| --- | --- | --- |
| `MAX_OPS` | 6 | keeps a fill step under ~3.1M gas |
| `KEEPER_MAX_GAS` | 3,200,000 | worst measured post-batch upkeep 2.64M plus headroom |
| `KEEPER_GAS_OVERHEAD` | 45,000 | intrinsic 21k, calldata, reentrancy guard and payout outside the measured span |
| `KEEPER_PRIORITY_CAP` | 2 gwei over basefee | limits self-paid priority fees by builder-keepers |
| `KEEPER_MAX_GAS_PRICE` | 10 gwei | above typical 2026 basefees; above it keepers are under-reimbursed and the pool waits |
| `KEEPER_INCENTIVE` | 0.0005 ETH | paid only with inventory work |
| `MAX_KEEPER_REWARD` | 0.0325 ETH | held in every open pool's reserve |

Creating work is not profitable for a keeper: work comes from purchases, which cost the buyer FWA's 5% edge plus the
markup plus the VRF fee on top of the expected value received.
