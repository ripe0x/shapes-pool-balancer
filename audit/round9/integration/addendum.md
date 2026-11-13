# Integration lane — post-seal addendum

The original seal (`discovery-seal.md`) stands and its files are unchanged. This is NEW work added after that seal,
deploying the full stack via `new` from source (the coordinator's plumbing note: `fs_permissions` blocks
`vm.deployCode` on the lane out dir). No mocks: real FWA factory/pool, real Shapes, our own real Draw Packs, and real
Chainlink VRF 2.5 fulfilment. Fork pinned block 26,382,349, RPC `https://mainnet.gateway.tenderly.co` only.

New files: `FullCycle.t.sol` (8 tests, all PASS); logs `logs/fullcycle-*.log`.
Time: addendum start **2026-11-13T11:45Z**, end **2026-11-13T11:54Z** (~9 min). Original lane ~12 min. Total ~21 min of
the 120-min ceiling. No excluded-file access (read only src/, lib/, allowed shared/off-chain, chain state). No anvil
started; no sealed file or production code/test modified.

## VRF route verified once (real coordinator path)
- Chainlink VRF 2.5 **Coordinator = `0xD7f86b4b8Cae7D942340FF628F82735b7a20893a`** (emits `RandomWordsRequested`,
  topic0 `0xeb0e3652…`).
- FWA **VRF consumer (service) = `0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d`** (the `sender` in that event).
- Fulfilment driven by `vm.prank(coordinator); consumer.rawFulfillRandomWords(chainlinkRequestId, words)` — the real
  `VRFConsumerBaseV2Plus` path (gated on `msg.sender == coordinator`). Decoded `chainlinkRequestId` from the event data.

## Results (all real-path, no mocks)

| Priority | Test | Result | Evidence |
|----------|------|--------|----------|
| P5 — Deploy postflight | `test_postflight_readbacks` | **PASS** — every `script/Deploy.s.sol` readback holds on a real fork deploy: factory wiring, keeper admin set + open, implementation locked (`creator==address(1)`), impl FWA/SHAPES/ENS/PACKS wiring, `packs.shapes()==SHAPES`, `MIN_PACK_VALUE==0.02 ETH`, code present. Pool opens and admits. | `logs/fullcycle-all.log` |
| P1 — full draw cycle | `test_full_draw_cycle` | **PASS** — deploy→configure→list curated+restock→open→**real player acquire**→**real VRF fulfilment**→settlement→**prize delivered to winner** (Shape #307 `ownerOf==player`)→keeper reconcile+restock→admission reopens. Player paid 0.021194 ETH (fee 0.018854 + VRF 0.002340). `ownerProceeds` settled 0.017957 ETH. Keeper reward 0.001145 ETH for ~804k gas @1 gwei → **net +0.000340 ETH** (the incentive). Pool balance delta +0.005812 ETH; keeperCredit and profit net to 0; inventory restored (4 active). | `logs/fullcycle-draw.log` |
| P2 — gas-price-0 purchase | `test_gasZeroQuote_underfunds_purchase` | **PASS** — `vrfServiceFee`=0 at gas price 0, so a quote taken at gas price 0 (0.018854) under-funds the real inclusion total (0.021194 @1 gwei) by the full VRF fee; the acquire sent with the gas-price-0 total **reverts at inclusion**. Affects only clients that quote at gas price 0 and forward it; this repo's `tx.ts` always simulates at real fees and sends no `acquire`. | `logs/fullcycle-timing.log` |
| P2 — gas-price-0 upkeep | `test_gasZeroSim_underreports_upkeep_reward` | **PASS** — `performUpkeep` simulated at gas price 0 returns reward 0.0005 ETH (incentive only) vs 0.001145 @1 gwei → under-reports. Confirms why `keeper.ts` and `App.tsx` must (and do) simulate at real fees. | `logs/fullcycle-timing.log` |
| P4 — restock vs pending draw | `test_staleInventoryVersion_reverts_draw` | **PASS** — a listing (what a keeper restock does) bumps `inventoryVersion` 2→3; an `acquire` pinning the old version **reverts**, the same `acquire` pinning the current version **succeeds**. Strict version pinning is real: a player draw whose pin is invalidated by a keeper restock reverts (FWA then refunds — no principal loss). | `logs/fullcycle-timing.log` |
| P3 — estimate vs inclusion gas | `test_upkeep_gas_vs_keeper_floor`, `test_worstcase_5draw_upkeep_gas` | **PASS** — single draw reconcile+restock ~797k gas; **true 5-draw burst reconciled + restocked in one upkeep = 2,526,347 gas** (test frame). Both under the keeper bot's `UPKEEP_GAS_FLOOR` 4,000,000 (keeper.ts), leaving ~1.5M margin, and consistent with the code's cited ~3.13–3.19M worst case. So work landing between estimate and inclusion is absorbed by the 4M floor. | `logs/fullcycle-worstgas.log` |

## Findings update
- No new high/critical finding. The full real cycle (including VRF fulfilment and prize delivery) completes correctly.
- **F2 (from the seal) now has direct revert evidence:** a stale `inventoryVersion` draw reverts on the real FWA path
  (`test_staleInventoryVersion_reverts_draw`). Still a liveness/UX matter (FWA refunds; no principal loss); the
  real-world *frequency* depends on FWA's frontend version-pinning, which remains out of scope.
- **P2 (gas-price-0) confirmed as a client-side hazard, not reachable in this repo:** the contract forwards no VRF fee
  and `tx.ts`/`keeper.ts`/`App.tsx` simulate at real fees. Flagged for any future code that forwards `vrfServiceFee`.
- **P3 keeper headroom confirmed adequate:** measured worst-case upkeep 2.53M < 4M floor.

## Still untested (reduced)
- Multi-draw bursts larger than 5, retries/refund (`retryNFTDelivery`/`refundFailedDelivery`) and the 7-day
  `recoverRefunded` path on the real FWA path (delivery-failure branch not driven; the happy delivery path is verified).
- Launch-scale keeper bot process (`keeper.ts` orchestration under reorgs/replacements) — logic reviewed statically.
- FWA frontend's exact `expectedInventoryVersion` policy (sets the P4/F2 real-world frequency).
