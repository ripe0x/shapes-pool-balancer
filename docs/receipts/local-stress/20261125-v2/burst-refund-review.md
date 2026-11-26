# Bounded review of five-draw burst refunds

**Conclusion:** the recorded balanced and topheavy burst refunds are consistent with FWA's positive price-drift protection. They are not evidence of an empty board, invalid random-word selection or unpaid winners. The buyer's `10000` argument controls negative drift only; it does not disable FWA's separate 10% positive tolerance.

This is a read-only diagnosis of the two recorded scenarios and their executed source paths, not a broader audit or release decision. No additional RPC calls, tests, broadcasts or campaign changes were performed for this review.

## Evidence and scope

The continuation [results](../20261125-v2-continuation/results.json) record:

| Scenario | Acquisitions | NFT deliveries | Status-3 expiries | Status-4 refunds | Buyer refund credit |
| --- | ---: | ---: | ---: | ---: | ---: |
| balanced-86400 | 120 | 106 | 0 | 14 | 0.273934114552315056 ETH |
| topheavy-86400 | 120 | 30, including one curated NFT | 0 | 90 | 2.166290063981270572 ETH |

Every recorded settled-cycle snapshot has the full automatic target and zero operating reserve shortfall. Balanced has 19 automatic prizes; topheavy has seven, plus its initial curated NFT. Each batch contains five acquisitions. Even after four NFT deliveries within one batch, both designs still have automatic prizes available. Consequently, the empty-pool status-4 branch cannot explain these particular refunds under the recorded execution path.

The lead separately recorded [a current view read](positive-slippage-live-read.json) at **2026-11-26T00:59:45.753913Z**, while **zeroFee-10** occupied the reused pool address `0xd8969c55724a9346c0940a9fa215089e4e054078`. It returned `selectionSlippageBps = 1000`. This is a current shared-address observation, **not a historical reconstruction of balanced or topheavy refund transactions**.

## Exact mechanism

Source references below are repository paths and one-based line numbers:

- **FWA:** `external/fwa-poolsv2/StandardPoolBuyback-0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7/src/poolsV2/StandardPool.sol`.
- **FWA factory:** `external/fwa-poolsv2/PoolFactory-0x8919814D825a5Af238cC04DE06b1C18c9eaA477C/src/poolsV2/PoolFactory.sol`.
- **Runner:** `scripts/local-stress-campaign.ts`.

1. **All five requests commit one initial acquisition fee.** FWA computes the fee once at lines 1213–1216 and opens the requests using it at lines 1224–1226. Each request separately snapshots the factory's positive tolerance and the purchaser's negative tolerance at lines 1408–1414. The factory fixes positive tolerance to `1000` at line 83 and passes it during initialization at line 251. Runner line 413 supplies `10000` as `maxNegativeSlippageBps`.

2. **Earlier deliveries change the remaining board's price.** FWA weights listings inversely to their listing prices at line 756. `acquisitionFee()` derives its current expected-value price from `weightedBackingTotal / totalWeight`, then adds the factory edge at lines 1080–1083. Removing a cheap listing commonly raises that harmonic-mean price. Runner lines 418–423 submit the batch's callbacks before keeper maintenance at line 447, so a cheap prize is not restocked between those callbacks.

3. **FWA checks drift before selecting the next prize.** At lines 1665–1679, the request refunds when either condition holds:

   ```text
   liveFee > escrowed && liveFee - escrowed > floor(escrowed × positiveBps / 10000)
   liveFee < escrowed && escrowed - liveFee > floor(escrowed × negativeBps / 10000)
   ```

   With positive tolerance `1000`, an increase strictly greater than 10% refunds. With negative tolerance `10000`, a decrease cannot exceed the permitted full original fee. A refunded request leaves the would-be selected NFT active, so later requests in the same batch can encounter the same excessive price and also refund.

4. **Random selection happens after that decision.** Runner line 421 derives ordinary diagnostic words from `keccak256(seed, requestId)`. FWA applies `word % totalWeight` and selects its slot at lines 1688–1692, after the slippage guard. Changing the refunded request's word would not bypass its price-drift refund. Successful earlier words affect which prices leave the board, and therefore affect whether later requests cross the guard.

5. **The full draw charge becomes buyer pull credit.** FWA lines 1609–1620 credit the acquisition's escrowed price to the buyer and the aggregate refund bucket. The runner checks those real buckets at lines 450–451. The separate VRF charge is paid upfront at FWA lines 1219–1222 and is not included in that refund.

FWA's explicit empty-board alternative is at lines 1653–1656. Its status enum at lines 79–88 distinguishes status 3, expiry, from status 4, no-listing/slippage refund. `test/BatchSlippage.t.sol:159–175` also distinguishes genuine status-4 settlement refunds from expiry and missing randomness; no test was rerun for this review.

## Numerical plausibility

A source-based recalculation uses the recorded 0.0005 ETH mint fee, 25% markup, 0.5 gwei basefee and 0.55 gwei transaction bid, together with the repository's restock schedule of 910,000 gas plus 0.0002 ETH per underlying Shape. It produces listing prices of 0.0137005 ETH for a 0.01 ETH Shape, 0.0637005 ETH for a 0.05 ETH Shape, and 0.027401 ETH for a 0.02 ETH Pack. Pricing sources are `src/PoolInventory.sol:524`, `src/PoolInventory.sol:613–616` and `src/KeeperPolicyCalls.sol:320–323`; schedule values are in `test/fixtures/keeper-policy-v1.json` and `test/fixtures/keeper-enforcement.json`.

| Board state | Removal from that state | Increase in harmonic-mean price |
| --- | --- | ---: |
| Balanced, full target | Four 0.01 ETH Shapes | 10.62% |
| Topheavy, initial curated NFT present | One 0.01 ETH Shape | 12.35% |
| Topheavy, after its curated NFT was won | One 0.01 ETH Shape | 10.54% |

The recalculated initial charged draw prices, including FWA's edge, match the first purchase values in the saved [receipts](../20261125-v2-continuation/receipts.json): **0.019566722468022504 ETH** for balanced and **0.025458093551950072 ETH** for topheavy, excluding the separate charged VRF fee. These calculations explain why a full topheavy board can refund much of a five-draw batch after only one cheap win. They do not reconstruct the exact live price of each historical refunded request.

Each acquisition was charged **0.001287 ETH** for VRF at the recorded 0.55 gwei bid. The charges associated with the 14 and 90 refunded acquisitions are therefore **0.018018 ETH** and **0.11583 ETH**, respectively, excluding buyer transaction gas. Both 120-acquisition scenarios record total VRF charges of **0.15444 ETH**. These are **charged VRF fees under simulated callback delivery, not measured authentic-proof costs**. The diagnostic deliberately leaves genuine coordinator proof commitments unconsumed.

## Limits and things that don't make sense

- Individual `AcquisitionRefundedSlippage` live-fee event values were not retained in the receipt summary. This review identifies the source branch and checks its plausibility; it does not claim an exact per-refund historical reconstruction.
- The current `zeroFee-10` positive-tolerance view read supports the present configuration only. It must not be relabeled as a read from either earlier refund scenario.
- The runner's `selectionRefunds` metric groups FWA status-4 no-listing and slippage refunds. Inventory evidence distinguishes them here; that metric alone cannot distinguish them in other scenarios.
- The high nominal rate selects five-request batches. Maintenance is serialized between batches, so this does not establish real-world 86,400-draw/day throughput or future refund percentages.
- **Economic concern:** topheavy players paid nonrefunded VRF charges on 90 of 120 acquisitions that delivered no NFT. This is expected contract behavior in this diagnostic, but remains material player experience and cost information.
