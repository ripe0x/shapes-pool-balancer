# Evidence challenge — pass 2 (addendum)

Start (UTC): 2026-11-13T12:28:42Z. End (UTC): 2026-11-13T12:43Z (active ~14 min; 45-min ceiling). Builds on pass 1
(`evidence-challenge.md`, `challenge-seal.md`), which is **unchanged**. Only new files added; one test file per forge
run; no `forge clean`; no sealed/production/test file modified; nothing committed/pushed/broadcast.

## 1. C12 dispute — decided (detail in `manifest-review.md`)

Re-ran the controller's `audit/round9/controller/UpkeepOrder.t.sol` (RUN9, `runs2/run9-upkeeporder.log`,
`FOUNDRY_TEST=audit/round9 FOUNDRY_OUT=audit/round9/lane_a/out FOUNDRY_CACHE_PATH=audit/round9/lane_a/cache`, 3/3 PASS)
and checked its assertions (only `assertGt(profit,0)` — the over-booking is log-only, as the controller flagged).

- **My pass-1 C12 (collect-before-reconcile = NFT-money leak): REJECTED as a standalone leak.** The 0.001985 ETH is the
  designed EV split (equals a Shape draw's baseline, RUN9 test 2), and the shortfall was only the transient
  unreconciled-draw reserve term — after reconcile fund 0.0609 > reserve 0.044 and the whole payment is withdrawable
  surplus regardless. Controller argument accepted. (`AutoCuratedLeak.t.sol` from pass 1 therefore over-claimed.)
- **Controller's variant (performUpkeep reconcile-before-collect over-books ×n/(n-1) on a curated draw in a GENUINE
  shortfall): ACCEPTED and now ASSERTED.** `UpkeepOrderAsserted.t.sol` (RUN10, `runs2/run10-upkeeporder-asserted.log`,
  PASS): genuine shortfall (balance 0.064 < reserve 0.534 after a 0.5 win), curated drawn; booked 0.002188 → 0.002553
  (×7/6), claimable 0.004283 → 0.004647 → **0.000365 ETH extra withdrawable, no creator action**, from the keeper's
  default order. Asserts `bookedUpkeep > bookedCollectFirst` and `claimUpkeep > claimCollectFirst`, closing the test's
  weak spot. This is the real automatic M9 instance; the overall M9 finding stands and is strengthened.

## 2. Manifest review

`manifest-review.json` + `manifest-review.md`: all 10 postconditions assessed — **7 accepted, 3 challenged**
(P3/pc_m9_extent: automatic variant uncited; P4/pc_delivery_reentrancy: reward-callback reentrancy guarded-not-executed;
P8/pc_refund_player: "automatic PoC not built" is stale — now built, player-refund-amount still open). Manifest not
edited.

## Runs (pass 2)
- RUN9 `runs2/run9-upkeeporder.log` — controller UpkeepOrder.t.sol, 3/3 PASS, numbers reproduce.
- RUN10 `runs2/run10-upkeeporder-asserted.log` — `UpkeepOrderAsserted.t.sol`, PASS, over-booking asserted.
