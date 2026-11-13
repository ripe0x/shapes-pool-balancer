# Round 9 informed focused testing — record

- **Start:** 2026-11-13 12:29 UTC. **End:** 2026-11-13 12:48 UTC. **Active:** ~19 min (ceiling 75).
- Frozen commit c686534. Writes confined to `audit/round9/focused/`. Real coordinator->VRF route via `AddendumBase`
  (imported unmodified). Fork `https://mainnet.gateway.tenderly.co` @26382349; sandbox DNS reached it, no escape needed.
- Run template: `FOUNDRY_TEST=audit/round9 FOUNDRY_OUT=audit/round9/lane_a/out FOUNDRY_CACHE_PATH=audit/round9/lane_a/cache forge test --match-path audit/round9/focused/<File>.t.sol -vv`.
- No `vm.mockCall/etch/store` on protocol contracts. Item 2 acts as the real Shapes admin (0xCB43…17F9) via the real
  `setMintFee` setter, recorded as such. Funding wallets = setup.

---

## Item 1 — M9 split leak at launch scale (`M9LaunchScale.t.sol`, exit 0, `run-M9LaunchScale.log`)

**Claim:** `_collect` books `amount*profitShareSum/(n*1e18)` as profit while fund<reserve; the set at collection can
differ from the set draws were priced on (variants a/b), misbooking fund money (incl. NFT money) as profit.

**Board:** Balanced mix 20×0.01, 10×0.05, 2×0.1, 1×0.5 Shape, 7×0.02 packs, one 0.3 NFT, 15% markup. Fully stocked,
claimed to reserve, one real draw settled-not-reconciled. **n=41, profitShareSum S=1.61422, amount=0.0201383 ETH
(EV draw price), fund 0.534 < reserve 1.0515 (genuine shortfall).**

- **`amount` is the EV draw price, NOT the won listing's price** — observed a real NFT draw crediting 0.0201 ETH while
  the NFT was priced 0.345. So the proceeds split is over a blended payment, independent of outcome.
- **Core split validated exactly on fork:** collect-first books **792,865,821,236,785 wei (0.00079287 ETH)** =
  `amount*S/(n*1e18)` to the last wei. That is **3.94% of every collected payment booked as creator profit while
  short**, regardless of which listing was drawn (incl. the observed NFT draw → the C12 automatic NFT-money leak,
  reproduced at launch scale).
- **Variant (b)** (performUpkeep reconciles drawn listing first): per-event misbooking vs collect-first, holding
  short, = `amount*(S−n·s_d)/(n(n−1)·1e18)`, computed from the board's real listed prices:
  - NFT drawn (s=0): **+0.0000198 ETH** (over-books).
  - 0.01 Shape (s high): **+7.05e−11 ETH** (≈ +70 gwei, negligible).
  - 0.5 Shape (s mid): **−2.02e−12 ETH** (≈ −0.0000020 ETH, under-books, fund-favourable).
  - **E[variant(b)] over FWA's 1/price draw weighting = −5.92e−11 ETH (≈ −59 gwei): essentially unbiased, marginally
    fund-favourable.** It over-books low-share draws, under-books high-share draws, netting ≈0.
  - At launch scale a **single** draw's reconcile also drops that draw's reserve term, clearing the shortfall, so
    performUpkeep booked **0** vs the 0.00079287 collect-first baseline (fund-favourable at this depth). The run-record
    ×7/6 over-booking needs a shortfall that persists after reconcile (deep big-win depletion), which is not reachable
    on a launch board by random VRF.
- **Variant (a)** (creator withdrawCurated before collecting, NFT share 0): leak = `amount*S/(n(n−1)·1e18)` =
  **measured 19,821,645,530,920 wei vs formula 19,821,645,530,919 wei (0.0000198 ETH/event)**. **Creator gas for
  withdrawCurated = 293,280** (~0.00147 ETH at 5 gwei, plus a later re-list), so the lever is economically marginal.

**Result:** M9 split misbooks ~3.94% of each short-regime payment as profit (baseline), confirmed exactly; variant (a)
adds +0.0000198 ETH/event at a gas cost that often exceeds it; variant (b) order-effect is unbiased in expectation
(E≈−59 gwei) and, for a single launch-scale draw, fund-favourable. **Limit:** 0.5/NFT draw outcomes computed from the
formula with real on-chain prices (forcing them at launch weighting is <1.5%/draw, infeasible); core split, the NFT-draw
automatic leak, and variant (a) validated directly on the fork.

## Item 2 — MINT_FEE_ROSE gate (`MintFeeRoseGate.t.sol`, exit 0, `item2-mintfeerose.log`)

**Test:** stock 3×0.01+NFT@15%; real Shapes admin raises live mintFee 0.001→0.002 (cap stays 0.001).
- admissionStatus → **MINT_FEE_ROSE (5)**, `canPurchase`=false.
- **requiredReserve rose 0.044→0.045** (uses max(liveFee,cap) for restock cost).
- Restocking stops: after unlisting a shape, performUpkeep mints nothing, `creatorWork` stuck true.
- Creator `configure` re-accepts (cap→0.002); upkeep restocks to target; admission → OK.
- M7: close + unlist + withdrawCurated + claimSurplus → **balancer balance 0, no listings left**.

**Result:** held as designed. **Limit:** single fee step; FWA pause interaction not exercised.

## Item 3 — retire() closeout (`RetireCloseout.t.sol`, exit 0, `run-RetireCloseout.log`)

**Test:** board 3×0.01+0.5+NFT; acquire a draw in flight; close; retire (pool.retired=true); the in-flight draw settles
through the real route and performUpkeep reconciles it after retire; unlist all shapes (exact backing redeemed);
withdraw curated; claimSurplus everything.

**Result:** **balancer ends with 0 ETH, no active listings stranded (M7).** **Limit:** EOA winner (delivery succeeds,
no PENDING branch); one draw in flight.

## Item 4 — bursts to the cap + heaviest upkeep gas (`BurstUpkeepGas.t.sol`, exit 0, `run-BurstUpkeepGas.log`)

**Test:** 30×0.01+0.5 board (enough weight that the fill gate does not trip before the cap). Acquired **5** unsettled
draws; a 6th refused; `admissionStatus`=BUSY at 5. Settled all 5, ran upkeeps.
- **Heaviest single upkeep = 2,526,724 gas** (reconcile 5 + restock) — **under KEEPER_MAX_GAS 3.2M and the keeper's
  UPKEEP_GAS_FLOOR 4.0M.**
- **M1:** keeper pay this run 0.0005 ETH ≤ restock fees credited 0.001225 ETH.
- At rest: profit 0 ≤ balance; target restored (30×0.01, 1×0.5); reserve 0.534.

**Result:** held. **Note (M8):** admission-allowed burst depth is board-weight-dependent — on a 3-prize board the fill
gate caps the burst at 1 (each unreconciled draw charged the heaviest prize); the MAX_BATCH cap of 5 is reached only
with sufficient prize weight.

## Item 5 — reward-callback reentrancy (`RewardReentrancy.t.sol`, 4 tests, exit 0, `run-RewardReentrancy.log`)

**Mechanism:** reward is paid by `forceSafeTransferETH` → inner call forwards **GAS_STIPEND_NO_GRIEF = 100,000 gas**.
If that call reverts/OOGs, the ETH is force-delivered via a self-destruct contract and **the entire re-entrant frame is
discarded** — a re-entry persists only if the whole callback completes under 100k. Creator-as-contract runs its own
setup `performUpkeep` (paid in full) and re-enters on receipt.

- **Unguarded functions DO execute within the 100k stipend:** transferCreator (pendingCreator set), close
  (enabled→false), configure (markupBps→2000) — all completed and persisted, even close/configure which make external
  FWA/Shapes calls.
- **Guarded function blocked:** collectProceeds (nonReentrant) reverts inside the frame → discarded (`reentered`=false).
- **profit ≤ balance and keeperCredit ≤ balance held after every upkeep across all four modes.**

**Result / assessment:** reentrancy is reachable but confers **no new authority** — every unguarded function is
`onlyCreator`, so only the creator (who already holds that authority and is paying itself the setup reward from its own
ETH) can trigger them; a keeper-contract hits `Unauthorized`. No money invariant broke. This refines round-8/round-9
C11 ("callback path untested") to "callback executes, no escalation, invariants hold." **Limit:** exercised the setup
(creatorWork) reward path; the non-setup keeper-credit reward path and retire/open/setENSName/approve/revoke re-entries
were not individually driven (transferCreator/close/configure are representative of the cheap-SSTORE and
external-call-bearing cases).

---

## Item 6 (appended) — failed curated delivery + refund wei ledger (`CuratedRefundLedger.t.sol`, 2 tests exit 0, `run-CuratedRefundLedger.log`)

Start 12:50 UTC, end ~13:01 UTC (~11 min, ceiling 20). New file only; reuses lane A's `RevertOnDeliverNFT` and the
real coordinator->VRF route (imported, unmodified). Board: one 1-ETH Shape (heavy, low draw weight) + the hostile 0.3
curated, so the hostile NFT is drawn with high odds; its delivery reverts -> FWA failed delivery -> Balancer PENDING.

**Wei ledger (healthy, fund >= reserve), the drawn hostile curated:**
- Player paid: acquisition fee 0.630139131231725739 ETH, VRF fee 0 (quoted 0 at this block), total 0.630139131231725739.
- After reconcile (item PENDING): **FWA ownerProceeds = 0; Balancer profit = 0; keeperCredit = 0**; balancer balance
  4.9985 ETH (unchanged by the draw); requiredReserve 1.034 ETH.
- After 7-day window, `player.refundFailedDelivery(badLid)`: **returns 0 to the player**; FWA listing status -> 7
  (refunded). Player net recovery over the whole draw = 0; **player net loss = the full 0.630139 ETH**.
- Creator `recoverRefunded(badLid, creator)`: ethOut 0, balancer balance delta 0, **NFT ends at the creator**, item
  state cleared.

**Asserts that held (in-scope, Balancer side):** no FWA proceeds, no profit, no keeper credit from the failed draw;
NFT returned to creator; item cleared; **balancer ETH untouched** (no pool ETH or NFT stranded, M7).

**Below-reserve variant:** reserve inflated by an in-flight draw (fund 1.034 < reserve 2.0515 at draw time); the failed
curated draw still credits **0 proceeds and books 0 profit while short** (M9 holds: no NFT money misbooked). Player
refund identical (FWA-internal).

**Keeper pay:** 0 from this draw (a curated draw creates no shape deficit, no restock; reconcile reward capped at
keeperCredit = 0). Within the rules.

**RESIDUAL (not a Balancer defect, flag for FWA-source review):** `refundFailedDelivery` returns the player **0** in
this harness though it sets FWA status to 7 (refunded). The player's acquisition payment (0.6301 ETH) is refunded
FWA-internally (credited to an FWA balance, not sent; the FWA pool source is not in the repo and is out of blind
scope), so "player gets back exactly the acquisition fee" is **not reachable/observable via this call** — the player's
measured loss is the full amount paid. This reproduces and sharpens lane A open-question 2 with an exact figure. All
Balancer-side money goals are met regardless; the player-refund amount must be confirmed against FWA's own source.
