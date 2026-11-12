# E8 bot-fee challenge, 2026-11-12

This is an informed, bounded follow-up to `record.md`. The original 2 gwei source is preserved as `gas_race_2gwei.ts` (SHA-256 `9a8af30de75fb618f01bceef13e7f26e58ae917183cd2014d97b4e2099cf02a7`). The earlier record remains unchanged (SHA-256 `624babd24982ead57635c6b43657179aad8f0fda191ea70efccce01fb31d553f`).

## Command and result

From repository root, with Tenderly public mainnet RPC as the private Anvil fork upstream:

```sh
set -o pipefail; node --import tsx audit/round8/lane_a/validation/gas_race/gas_race.ts 2>&1 | tee audit/round8/lane_a/validation/gas_race/attempt5.log; exit ${pipestatus[1]}
```

Exit **0**. Source SHA-256 `467a8852bb646e84119f881d8d8a5c0b8020d4c80723ee4e1c0e5d8616cfa259`; raw log SHA-256 `9384d8560987f88f907a7c035a7ce884456a471f7973ffe0915bc7c610b010ee`. Completed by 2026-11-12T18:00:18Z. No production code, protocol balances/state, or prior seals were changed. Actual coordinator → VRF service → FWA delivery was used.

## Same-state fee comparison

Pinned fork block 26382349. Prestate block 26382361; inclusion block 26382362. Basefee was **13,744,707 wei** in both. Keeper EIP-1559 priority was **50,000,000 wei**, max fee **77,489,414 wei**, and actual effective gas price **63,744,707 wei**. Callback and FWA processing bids were higher; their transaction indexes were 0 and 1, followed by upkeep at index 2 in the same block.

The imported production `keeper/keeper.ts::decide` returned `send: true, reason: "ok"` with prestate estimate **674,278 gas**, expected reward **254,495,747,900,000 wei**, expected gas cost **42,981,653,546,546 wei**, and default max loss **200,000,000,000,000 wei**. The decision clears the policy even without using the max-loss allowance.

Baseline one-draw upkeep billed **608,073 gas**. After the second fulfillment and processing, unlimited upkeep billed **1,210,546 gas**: **536,268** above the prestate estimate and **602,473** above the baseline. A replay with 30% estimate headroom (**876,561 gas**) reverted after **850,098 gas**; `debug_traceTransaction` recorded `out of gas` at `upkeep/0/12/0`. The receipt log records hashes, actor/request IDs, selected words, and balances. All balances/status assertions in the script passed.

This supports E8 for **one constructed bot-like keeper state and same-block order**. It does not establish the cause of the historical 3/340 failed keeper transactions or a general failure rate. Lane A cumulative active auditor time is approximately **119 ± 7 minutes**, including preflight and this challenge; this follow-up was within the 10-minute cap and the 3-hour lane ceiling.
