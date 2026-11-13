# Round 9 — Lane A (blind, obligation-derived) sealed inventory

Target: `/Users/dd/CascadeProjects/fwa-pool-balancer` @ `c686534`. Fork: mainnet block 26382349 (drift: 26405845),
RPC `https://mainnet.gateway.tenderly.co`. No protocol contract mocked anywhere. VRF delivered by acting as the real
VRF service (`0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d`, whose coordinator is
`0xD7f86b4b8Cae7D942340FF628F82735b7a20893a`) calling `pool.rawFulfillRandomWords`.

Test command (per file): `FOUNDRY_TEST=audit/round9/lane_a FOUNDRY_OUT=audit/round9/lane_a/out
FOUNDRY_CACHE_PATH=audit/round9/lane_a/cache forge test --match-path <file>`.

Helpers: `helpers/MockCollections.sol` (`SimpleNFT`, `ReentrantNFT`) — adversary-written NFT collections, legitimate
attackers, not stand-ins for any protocol contract.

---

## 1. Obligation inventory (claim / attempts / evidence / result)

### Money goals

| ID | Destination invariant (derived) | Attempt & evidence | Result |
|----|----|----|----|
| **M1** | Lifetime keeper pay outside creator work ≤ restocking fees of prizes keepers listed; markup/fund never pay keepers. | `KeeperReentrancy.t.sol::testM1PriorityBidCapped` (100 gwei priority bid, basefee 2 gwei): reward=0.002045 ETH < bid-price value 0.081 ETH and ≤ capped-price value; reward bound by `keeperCredit` (which grows only by `ops*restockFee`). `testM1ReconcileOnlyBoundedByCredit`: after `close`, `keeperCredit==0` and a post-close upkeep pays keeper 0. exit 0, `logs/keeper-reentrancy.log`. | **Held** (priority-bid exploit blocked by `_rewardPrice`; reward capped at `keeperCredit` in `_payKeeper`). Domain: single pool, one draw, one restock call. |
| **M2** | Restock fee = 900k·min(basefee+0.05gwei,5gwei)+0.0002 at listing block, credited in the listing call; pool fronts, winner repays. | Code: `restockFee()`, `_fillDeficit` adds `ops*restockFee()` to `keeperCredit` in the same call that lists; price = `_prizeBase + w*restock`. Observed credit growth in M1 test. | **Held** (within tested domain). |
| **M4** | Prize backing sits in prize tokens; returns at exactly its value on unlist / refund recovery. | `FullCycle.t.sol::testFullCycleConservation`: open→5 draws→restock→close→unlist→withdraw leaves balancer balance 0, 0 active listings, pool `ownerProceeds` 0. exit 0, `logs/fullcycle1.log`. | **Held** for Shapes prizes over a full cycle. Packs/refund-recovery redemption **untested** (see §4). |
| **M6** | `requiredReserve` in ETH to open; creator cannot withdraw below it while open with a healthy fund. | `EconProps.t.sol::testM6CannotWithdrawBelowReserve`: claim of exactly `balance-reserve` OK; +1 wei reverts `InsufficientSurplus`; balance stays ≥ reserve. `SecurityIntegration::testOpenRequiresReserve`: `open` reverts `ReserveNotFunded` until funded. exit 0. | **Held** for the fund-healthy regime. |
| **M7** | After close+unlist+withdraw nothing is stranded or owed to anyone but the creator. | `testFullCycleConservation` (above): residual ETH 0, no tracked listings, no stranded proceeds. | **Held** over the exercised cycle. |
| **M9** | Fund = balance − profit. While fund < reserve, creator share = Shapes' markup>10% weighted by 1/price; the fund keeps the rest incl. all NFT-sale money. **No creator action may move fund money into profit.** | `FullCycle.t.sol::testM9WithdrawCuratedInflatesProfit`. See Finding 1. exit 0, `logs/m9.log`. | **VIOLATED** — a creator action (withdrawCurated timed before collectProceeds) books more profit on identical proceeds. |
| M3/M5/M8 | Mint fees repaid in price; creator loss bounded; fill gate at 70%. | Code review only; M8 gate logic exercised indirectly (admission `LOW_INVENTORY`/`SETTING_UP`/`NO_CURATED`/`BUSY` all reached in tests). | **Not falsified**; not independently PoC'd (see §4). |

### Security / authority properties

| Property | Evidence (`SecurityIntegration.t.sol` unless noted) | Result |
|----|----|----|
| Implementation locked (`creator==address(1)`, `initialize` reverts) | `testImplementationLocked` | Held |
| Real clone initializes against real FWA factory; single-shot; `factory` set to deployer at initialize | `testRealInitialize` | Held |
| Only factory-made clones registered (`isBalancer`) | `testCloneOutsideFactory` | Held (note: an out-of-factory clone would get `factory=msg.sender`, so its keeper gate is attacker-chosen — but it owns only its own FWA pool; no cross-pool authority) |
| Creator-only matrix (14 entry points) reverts `Unauthorized` for a stranger | `testOnlyCreatorMatrix` | Held |
| Keeper gating: open-by-default anyone; restricted → only approved + creator | `testKeeperGating` | Held |
| Keeper-admin two-step handover; wrong acceptor reverts; admin power scoped to the keeper list only | `testKeeperAdminTwoStepAndScope` | Held (no factory path reaches a balancer/pool/assets) |
| Creator two-step transfer; only `pendingCreator` accepts; epoch bumps; old creator loses authority | `testCreatorTransferTwoStep` | Held |
| ERC-1271 `isValidSignature` only for an approved digest, only in its epoch; revoke & creator-transfer invalidate prior approvals (no replay) | `testPoolPageEpochReplay` | Held |
| `recoverUntrackedNFT` guards: not pool, not FWA factory, only an NFT actually owned by the balancer | `testRecoverUntrackedGuards` | Held |
| `listCurated` rejects Shapes/Packs as curated | `testListCuratedRejectsProtocolTokens` | Held |
| `configure` bounds (markup∈[1000,10000]; non-empty/≤80 plan) | `testConfigureBounds` | Held |
| `canPurchase` refuses balancer, Shapes, Packs, pool | `EconProps::testCanPurchaseRefusals` | Held |
| Admission SETTING_UP while creator work pending | `EconProps::testAdmissionDuringSetup` | Held |
| Reentrancy: hostile curated collection reentering a guarded fn during `listCurated` / `recoverUntrackedNFT` is blocked | `KeeperReentrancy::testReentrancyHostileCollectionOnList`, `testReentrancyRecoverUntracked` (ReentrantNFT reenters `claimSurplus`; whole tx reverts) | Held (`ReentrancyGuard`) |
| Recent-block drift: FWA impl/codehash/maxAcq unchanged; initialize still works @ 26405845 | `Drift.t.sol::testRecentBlockInitialize`; `cast` readbacks `logs/recent-block.txt` | Held (no drift) |

---

## 2. Candidate findings

### Finding 1 — M9: a creator action (withdrawing a curated listing, timed before `collectProceeds`) moves fund money into withdrawable profit. Severity: Medium.

- **Site:** `src/PoolBalancer.sol` `_collect()` lines 830-842, specifically
  `uint256 mine = amount * profitShareSum / (n * 1e18);` with `n = activeIds.length` (line 835-837); enabled because
  `withdrawCurated`/`unlistShapes`/`listCurated` do **not** call `_collect()` before mutating the active set.
- **Root cause:** `_collect` splits *all* accrued `ownerProceeds` by the *current* active-listing set
  (`profitShareSum / activeIds.length`), decoupled from the listing composition at the time each draw's proceeds were
  generated. Removing a curated listing (whose `_share` is 0) shrinks the denominator `n` without changing the
  numerator `profitShareSum`, so the same proceeds book strictly more `profit`. While the fund is below
  `requiredReserve`, that increment is withdrawable `profit` taken out of the fund.
- **Transaction sequence (PoC `testM9WithdrawCuratedInflatesProfit`):**
  1. Pool: five 0.01-ETH Shapes + one 0.3-ETH curated NFT, 30% markup, balance pulled to the reserve.
  2. One real player draw, settled via the VRF service, **not reconciled** → `requiredReserve` inflated by the
     draws-in-flight term, so fund (0.044 ETH) < reserve (0.0715 ETH): the game-first regime. `ownerProceeds` holds the
     draw's proceeds.
  3. A/B under one `vm.snapshotState()`, identical proceeds:
     - Honest `collectProceeds()` → `profit = 0.001985495699365404 ETH`.
     - `withdrawCurated(curatedId)` then `collectProceeds()` → `profit = 0.002382594839238485 ETH` (exactly ×6/5).
- **Impact (ETH at launch scale):** per collect while short, the creator diverts `bookedProfit · k/(n−k)` of fund money
  (k curated removed of n listings) into withdrawable profit — e.g. removing the single curated of a 6-listing board
  adds 20% to that collect's profit; the fund loses exactly that much. It repeats on every collect in the game-first
  regime (the creator re-lists curated between cycles). Bounded and self-limiting (each event is a fraction of one
  collect's markup, and re-listing costs gas and re-triggers a `SETTING_UP` pause), but it is a direct violation of the
  central "game first, profit after" invariant: the creator withdraws game-fund money while the pool is underfunded.
- **PoC command:** `FOUNDRY_TEST=audit/round9/lane_a FOUNDRY_OUT=audit/round9/lane_a/out
  FOUNDRY_CACHE_PATH=audit/round9/lane_a/cache forge test --match-path audit/round9/lane_a/FullCycle.t.sol
  --match-test testM9WithdrawCuratedInflatesProfit -vv`; exit 0; `logs/m9.log`.
- **Related, same root cause (observed, not independently PoC'd):** a *curated-NFT draw's* proceeds are pure NFT-sale
  money, yet `_collect` applies the Shapes' `profitShareSum/n` to them, so some is booked as profit whenever fund <
  reserve — contradicting "the fund keeps ... all NFT sale money" while short. I did not isolate a standalone PoC: in my
  single-curated-draw-via-upkeep run the proceeds pushed the fund back above the reserve so no profit accrued; the
  effect requires the fund to stay short across the collect (reachable with larger boards / draws in flight).
- **Suggested fix (suggestion only):** call `_collect()` at the start of `withdrawCurated`, `unlistShapes`,
  `listCurated`/`listCuratedBatch` and `updateCuratedPrice` (and `configure`), so proceeds are always split against the
  active set that generated them, before the creator changes it. Consider also excluding the just-drawn listing's own
  weight from the split rather than the whole post-reconcile set.

---

## 3. Requirement challenges (rules wrong/harmful even where code matches)

1. **The M9 profit split is a time-of-collect snapshot, not a per-draw attribution.** The rule "the creator's share of
   each collected payment is each Shape's markup above 10% ... weighted by 1/price" is implemented as one blended ratio
   applied to a lump of proceeds. This is inherently gameable by anything that changes the active set between accrual
   and collect (Finding 1) and mis-attributes curated-draw money. Even without a creator acting, the ratio drifts as
   draws deplete/restock inventory between collects. The rule should be stated (and enforced) as a per-settled-draw
   attribution at the listing that was drawn, not a snapshot average.
2. **`requiredReserve` charges the heaviest term for unreconciled draws (`draws * largest` + worst-batch keeper term)
   while simultaneously letting proceeds raise the fund.** This makes the "game-first regime" (fund < reserve)
   transient and timing-dependent, which is exactly the window Finding 1 exploits. The reserve's dependence on
   `lastIssuedSequence - reconciledSequence` means a creator/keeper can choose when to collect relative to reconcile.
3. **An out-of-factory clone sets `factory = msg.sender` at `initialize`.** Harmless for assets (such a clone owns only
   its own FWA pool and has its own creator), but it means "the keeper list is on the factory" is only true for
   factory-made clones; a hand-rolled clone's keeper gate is whatever its initializer passed. Worth stating explicitly
   as a trust boundary rather than an invariant.

---

## 4. Untested paths and why

- **Draw Pack (sizes 9-15) mint/list/redeem and refund-recovery of a pack.** Only Shapes (denom 0) prizes were driven
  end-to-end. `createPackTo`/`redeem` and `recoverRefunded` for packs are code-reviewed only. Reason: time budget;
  focused on the money-split and authority emphasis.
- **`recoverRefunded` failed-delivery path (7-day FWA refund, PENDING state).** Requires forcing an FWA delivery
  failure (a receiver that rejects) and advancing 7 days; not driven. Code-reviewed: guarded by `state==PENDING` and
  FWA `L_DELIVERY_REFUNDED` status.
- **The automatic (no creator action) curated-draw → profit leak.** Mechanism identified (Finding 1 "related"); no
  standalone PoC because my single-draw run returned the fund above the reserve.
- **Multi-draw bursts (5 unreconciled) and settle-in-flight races, VRF fee at gasprice 0, mint-fee rise to
  0.005/0.01.** Not exercised; admission gate blocks >1 unreconciled draw against a thin board, so bursts need a larger
  board than I set up.
- **`setENSName` real reverse-registrar call, `approvePoolPage` digest vs live pools.fwa.fun.** Access control tested;
  the external ENS/registrar effect and the exact message format vs the live site were not driven.
- **Off-chain (`keeper.ts`, `planner.ts`, `design.ts`): planner↔contract numeric parity, keeper gas-headroom/replace/
  reorg behaviour.** Read for scope and cross-checked conceptually against contract constants; not executed.
- **Slither.** Not run (time); the build is clean under solc 0.8.28.

---

## 5. Time and excluded-file access

- Start (UTC): **2026-11-13T11:30:35Z**. End (UTC): **2026-11-13T11:52Z** (active time well under the 3h ceiling;
  wall-clock ~22 min).
- Excluded-file access: **none.** Only allowed paths read (src/, script/, foundry.toml, shared/*, keeper/keeper.ts,
  audit/round9/preflight/, audit/round9/discovery-packet.md) plus public on-chain state. `app/src/App.tsx` and
  `app/src/tx.ts` were in scope but **not read** (time). `forge build` compiled `test/` and `lib/` sources as a build
  dependency; their *contents* were not read.
