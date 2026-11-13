# Round 9 — Integration, timing and off-chain sealed inventory

Lane: **integrations, timing, off-chain surfaces** (blind). Target frozen at `c686534`, branch `fork-tests`.
Pinned fork block **26,382,349**; recent block **26,405,755** (`cast block-number`). RPC `https://mainnet.gateway.tenderly.co` only.
Solc 0.8.28, via_ir, optimizer 50 (packs 20), Cancun. forge/cast 1.8.1, node v22.19.0.
Preflight: `preflight/record.md` (all steps exit 0). No mocks used; all on-chain evidence is the real FWA/Shapes path.

Time: start **2026-11-13T11:30:35Z**, end **2026-11-13T11:43Z** (~12 min active). Ceiling 2h; sealed complete for this scope.
Excluded-file access: **none** (read only allowed paths: src/, script/, lib/, foundry.toml, shared/*.ts, keeper/keeper.ts, app/src/{App.tsx,tx.ts}, preflight/, public chain state).

---

## 1. Integration and drift table

Value assumed in code vs value live at pinned (P) and recent (R) block. Reads: `cast call` (logs/ not separately saved; reproduced below) and fork tests `FwaVrfTiming.t.sol` (asserts P and R), `RestockInventoryVersion.t.sol`.

| # | Item | Assumed in code (file:line) | Live @ P | Live @ R | Impact / drift |
|---|------|------------------------------|----------|----------|----------------|
| 1 | FWA factory `implementation()` | `Deploy.s.sol:37`; `PoolBalancer.initialize:287` | `0x85Faf…bFee7` | same | **no drift** |
| 2 | FWA impl codehash | `Deploy.s.sol:23,38`; `PoolBalancer.sol:140,282` = `0x0af0…ce02` | `0x0af0…ce02` | same | **no drift** |
| 3 | `maxAcquisitionsPerTx` == 5 (MAX_BATCH) | `PoolBalancer.sol:49,284`; `Deploy.s.sol:39` | 5 | 5 | no drift. **Dependency:** any value ≠5 makes every `createBalancer` revert `UnsupportedFWAConfig` (new pools only). |
| 4 | `maxStagedListings` == 0 | `PoolBalancer.initialize:284` | 0 | 0 | no drift. Same hard new-pool-creation dependency as #3. |
| 5 | `edgeBps` == 500 | planner doc `planner.ts:81`; dashboard reads **live** `App.tsx:77,439`; `Deploy`/contract do not pin it | 500 | 500 | no drift; dashboard robust to change (reads live). |
| 6 | `globalWithdrawOnly` == false | restock skipped if true `PoolBalancer.sol:611` | false | false | no drift; graceful degradation if FWA sets it (restocking pauses, draws still settle/refund). |
| 7 | `Shapes.mintFee()` (cap 0.01) | live reads; cap `MINT_FEE_ROSE` gate `admissionStatus:575`, `requiredReserve:774` | 1e15 (0.001) | 1e15 | 10× under cap; no gate triggered. |
| 8 | `Shapes.denominationCount()` == 9 | `constructor:263` | 9 | 9 | match |
| 9 | `Shapes.denominationAt(0..8)` == `_amount(0..8)` ladder | `constructor:264-266` | 0.01,0.05,0.1,0.5,1,5,10,50,100 ETH | same | exact match |
| 10 | Packs `MIN_PACK_VALUE()` ≤ 0.02, `shapes()`==SHAPES | `constructor:267`; `Deploy postflight:57-58` | n/a (our own deploy, undeployed) | — | enforced at construct + Deploy postflight. |
| 11 | Packed tables `AMOUNTS`/`SHAPES_IN`/`BY_VALUE` vs planner `DENOMS`/`SHAPES_IN`/`BY_VALUE` | `PoolBalancer.sol:57,59,61` vs `planner.ts:50-63` | decoded, **exact** all 16 sizes incl. d15=25 ETH pack (2×10+5=3 shapes) | — | parity confirmed (node decode). |
| 12 | FWA `vrfServiceFee()` = 2,340,000 × `tx.gasprice` (linear; **0 at gasprice 0**) | measured on real pool `FwaVrfTiming.t.sol` | 11.7e15 @5gwei, 0 @0 | — | contract forwards **no** VRF fee; dashboard `tx.ts` simulates at real fees → not reachable as under-send here (see F3). |

Reproduce #1-9: `cast call <addr> "<sig>" --rpc-url … --block <P|R>` (FWA factory `0x8919…477C`, Shapes `0x6fE9…FAf0`). Fork-test assertions in `FwaVrfTiming.t.sol::testFactoryParamsLive{Pinned,Recent}` (both PASS).

---

## 2. Timing / liveness and off-chain properties

| Claim | Attempts / evidence | Result | Domain |
|-------|---------------------|--------|--------|
| Live FWA params our init requires are present at both blocks | `FwaVrfTiming.t.sol` testFactoryParamsLive{Pinned,Recent}; `logs/vrf-timing.log`; exit 0 | **held** | integration |
| FWA `vrfServiceFee` rises monotonically with `tx.gasprice`, =0 at 0 | `FwaVrfTiming.t.sol::testVrfFeeMovesWithGasPrice`; linear 2.34M×gasprice; `logs/vrf-timing.log` exit 0 | **measured; within bounds for this repo** (contract forwards no VRF; `tx.ts:22-27` always simulates at real fees) | timing |
| A keeper restock (pool.listNFTs) changes FWA `inventoryVersion`, invalidating a player's pinned in-flight draw | `RestockInventoryVersion.t.sol`: real pool, real Shapes; each listing bumps version by exactly **+1**; `logs/restock-invversion.log` exit 0 | **violation of player-draw liveness under strict version pinning** (FWA refunds; no principal loss). Revert *frequency* untested (FWA acquire semantics out of scope). See F2. | liveness |
| `restockFee()` escrow ≥ keeper reward price, same block | formula: reward price `min(tx.gasprice, basefee+0.05g, 5g)` (`_rewardPrice:907`) ≤ restock price `min(basefee+0.05g,5g)` (`restockFee:919`); credit `ops*restockFee` (`:616`) == total priced into batch (`:701`) | **held** (code inspection + parity) | economic/timing |
| `requiredReserve()` is gas-independent; dashboard `deposit` over-estimates it → `open()` never under-funds | `requiredReserve:770-793` uses constants + mintFee only (no basefee); dashboard `deposit=ceil(requiredReserveAt/0.01)*0.01` `App.tsx:574-576` | **held** | off-chain/economic |
| Dashboard event replay (`ItemDrawn`) is reorg/duplicate/order safe | `App.tsx:69-85`: re-queried from `FROM_BLOCK` each refresh, deduped by `Set`, authoritative `PENDING` state (`state==2`) read on-chain; events are only hints | **held** | off-chain |
| Planner ↔ contract constant & formula parity | `planner.ts` mirrors BPS, MAX_OPS, KEEPER_* , RESTOCK_FEE_* , `requiredReserveAt` ceil-div, `prizeBase/prizeCost/prizePrice`, DENOMS/SHAPES_IN/BY_VALUE (node decode) | **held** (exact) | off-chain |
| Keeper bot: reward bounded on-chain; reorg rescan; replacement under cap; atomic state | `keeper.ts` reviewed: reward capped by `keeperCredit` on-chain (`_payKeeper:745`), rescan `discover:130`, replace `:261-287`, atomic save `:114-118`, gas floor 4M vs reward cap 3.2M | **no defect found**; launch-scale e2e untested (needs keeper harness) | off-chain |

---

## 3. Candidate findings

**F1 — Low / informational (new-deployment liveness).** A single FWA governance change to `maxAcquisitionsPerTx` (≠5) OR `maxStagedListings` (≠0) makes **every** `createBalancer` revert (`initialize` → `UnsupportedFWAConfig`, `PoolBalancer.sol:284`). Existing pools keep working (check is init-time only). Both values satisfied at P and R. No ETH at risk; blocks only new pool creation. Fail-closed is correct. *Suggestion:* none required; document the operational dependency so an FWA param change is diagnosed quickly.

**F2 — Low (player-draw liveness during restock).** Each FWA listing bumps `inventoryVersion` by +1 (measured, `RestockInventoryVersion.t.sol`). A keeper restock (`_fillDeficit` → `pool.listNFTs`, `PoolBalancer.sol:726`) therefore invalidates any player draw that pinned the prior version. Under strict version pinning a player with an in-flight draw during active restocking is reverted/refunded by FWA. Impact: player gas/UX only — **no principal loss** (FWA refunds; the design relies on this). Launch-scale **frequency and whether FWA's own frontend pins the version strictly are untested** (FWA acquire source out of scope). *Suggestion:* confirm the FWA frontend passes a permissive `expectedInventoryVersion`, or document expected refunds in restock windows.

**F3 — Informational (VRF fee gas-price dependence).** `vrfServiceFee()` = 2,340,000 × `tx.gasprice`, =0 at gas price 0 (measured). No code in this repo forwards the VRF fee (players buy on FWA directly; dashboard builds no `acquire`), and `tx.ts::prepareWrite` always simulates at real EIP-1559 fees (`tx.ts:22-27`), so there is **no under-send here**. Flagged so any future path that forwards `vrfServiceFee` under a gas-price-0 simulation is known to under-quote by 2.34M × inclusion gasprice (0.0117 ETH at 5 gwei).

**No high/critical integration finding.** Economic destination invariants M1–M9 and the `sim/flows.ts` comparison belong to other lanes / the informed phase.

---

## 4. Untested paths and why

1. **Full Balancer→FWA→VRF→settlement cycle with a real player `acquire` + VRF fulfillment** (acting as the coordinator): not driven. The Balancer-stack deploy via `vm.deployCode` was blocked by `fs_permissions` plumbing on the lane out dir within the time box; the restock mechanism was measured instead on a raw real FWA pool (`RestockInventoryVersion.t.sol`) and VRF timing on a real pool (`FwaVrfTiming.t.sol`). Real VRF-word delivery not exercised.
2. **FWA `acquire()` exact revert semantics** on stale `expectedInventoryVersion` / `maxNegativeSlippageBps` / price cap: FWA source out of scope; the version-bump *mechanism* is measured, the player-side *revert reachability/frequency* is not driven.
3. **Keeper bot launch-scale e2e** (4M gas floor vs per-block Shapes-mint variance; reorg/replacement under load; restricted pools): `keeper.ts` reviewed statically; the dedicated keeper fork harness (ports 18546/18847) not run.
4. **App.tsx** read at the data layer (36-110), config/deposit (525-585) and all grep anchors; not every line of 1,537.
5. **Packs `MIN_PACK_VALUE`/`shapes()` live** check: target undeployed; enforced by `constructor:267` + `Deploy` postflight only.

---

## 5. Time and excluded access

- Start 2026-11-13T11:30:35Z; end ~2026-11-13T11:43Z. ~12 min active, well under the 2h ceiling.
- Excluded-file access: **none**. No reads of `test/`, `sim/`, other `docs/`, other `audit/` lanes, git history, memory, or sibling sessions.
- No anvil started. No production code or existing tests modified. No commit/push/broadcast.
