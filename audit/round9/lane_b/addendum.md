# Round 9 — Lane B post-seal addendum

This addendum extends `sealed-inventory.md` (do not modify sealed files). It applies the coordinator's route
correction and drives, on real fork draws, the regimes the original seal had only reasoned about. Original seal still
stands; where this supersedes a gap it is stated.

- Addendum start (UTC): 2026-11-13T11:57:16Z. Addendum end (UTC): 2026-11-13T12:10Z. Total active time (incl. the
  original ~25 min): ~40 minutes, under the 3-hour ceiling.
- Access rules unchanged (still blind): only `src/`, `script/`, `foundry.toml`, the named `shared/`/`keeper/`/
  `app/src/` files, public on-chain state, and my own lane. No excluded files read.
- New files only: `Harness2.sol`, `ProbeRoute.t.sol`, `AddendumGas.t.sol`, `AddendumBelowReserve.t.sol`,
  `AddendumScale.t.sol`, and `logs/addendum-*.log`, `logs/proberoute.log`, `logs/final-{ProbeRoute,AddendumGas,
  AddendumBelowReserve,AddendumScale}.log`. All sealed files are byte-for-byte unchanged.

## 0. Route correction verified (supersedes original gaps G1, G2)

`0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d` is FWA's VRF **service**; its Chainlink **coordinator** is
`service.coordinator()` = `0xD7f86b4b8Cae7D942340FF628F82735b7a20893a`. The correct settlement route is: player
`acquire` → read the Chainlink requestId from the coordinator's request event (topic0
`0xeb0e3652e0f44f417695e6e90f2f42c99b65cd7169074c5a654b16b9748c3a4e`, first data word) → prank the **coordinator** and
call `service.rawFulfillRandomWords(reqId, words)` so the service does its own accounting and forwards to the pool →
`processAcquisitions`. Evidence: `ProbeRoute.t.sol`, `logs/final-ProbeRoute.log`; `Harness2.sol::_tryDraw`.

My original method (prank the service, call `pool.rawFulfillRandomWords` directly) bypassed the service's bookkeeping,
which was the cause of `InsufficientVrfCoverage()` after a few draws (original seal G1/G2). With the corrected route the
coverage ceiling is gone: I drove **16 draws per gas level and 40-draw launch-scale runs** with no coverage failure.
The original harness/results (which used the direct route at 0–0.5 gwei) are not invalidated — fulfilment delivered the
same words to the pool — but anything that depended on *post-fulfilment state at higher gas or many draws* is re-run
here with the correct route and confirms the same invariants.

## 1. Below-reserve regime (coordinator priority 1) — driven, no violation found

Setup: two 0.5 ETH Shapes (dominant draw weight) + two expensive curated NFTs (low weight, open the gate), 1.7 ETH
deposit (just above the ~1.53 ETH open reserve). A word-targeted 0.5 ETH win (snapshot/revert word search in
`Harness2._drawTargeting`) tips the fund below the reserve. Evidence: `AddendumBelowReserve.t.sol`,
`logs/addendum-below.log`.

- **Entered the regime:** after the targeted big win, balance 0.6975 ETH, `requiredReserve()` 1.0515 ETH,
  fund (balance − profit) 0.6975 < 1.0515 → **below reserve = yes**, profit 0.
- **The fund is fully protected while short.** With profit 0 and fund < reserve, `withdrawableSurplus()` = 0, so the
  creator cannot withdraw anything. No claim can push the balance below the reserve.
- **Safety invariants hold:** `profit ≤ balance` at every step; a claim (when any is permitted) leaves the balance
  above the live reserve or is pure profit (fund = balance − profit preserved).
- **Markup-change over-booking attack (the M9 concern) — defended, measured 0 ETH moved.** Restricted keepers (creator
  is sole keeper, full timing control): win a 0.5 ETH prize at **10% markup** (creator's true profit share = 0;
  uncollected proceeds **0.9447 ETH**), then reconfigure to **100% markup**, restock, and collect — all while **below
  the reserve**. Profit booked from those 10%-markup proceeds = **0 wei** (`OVER-BOOKED fund→profit = 0`). Mechanism:
  `performUpkeep` runs `_collect` in step 2 *before* the step-3 high-markup restock, so the proceeds are always
  collected at the pre-restock (0-share) ratio; the creator cannot interpose a high-markup listing set between earning
  and collecting because restocking itself forces the collect. **No creator action moved fund money into profit.**
- **Refill works:** after keeper reconcile+restock the pool returns to `admissionStatus = 0` (healthy) and keeps
  paying winners (every listed prize holds its own backing). No stall beyond the owner-accepted "prizes off the board
  until sales restock" window.

## 2. Gas regimes 1 / 3 / 4.9 / >5 gwei (coordinator priority 2) — M1 holds, keeper viable to 5 gwei

16 real draws per level, non-setup keeper work only (creator work excluded, paid in full by design).
Evidence: `AddendumGas.t.sol`, `logs/addendum-gas.log`.

| basefee | draws / blocked | non-setup keeper reward | restock fees credited | keeper net (reward − cost proxy) |
|---------|-----------------|-------------------------|-----------------------|----------------------------------|
| 1 gwei | 16 / 0 | 0.013740 ETH | 0.013740 ETH | **+0.002979 ETH** |
| 3 gwei | 16 / 0 | 0.029450 ETH | 0.029450 ETH | **+0.003185 ETH** |
| 4.9 gwei | 16 / 0 | 0.046425 ETH | 0.046550 ETH | **+0.001101 ETH** |
| 6 gwei (one call) | — | 0.004557 ETH | 0.004700 ETH | **−0.000353 ETH (underwater)** |

- **M1/M2 at every level:** keeper pay outside creator work ≤ restock fees credited (equal at 1/3 gwei; under at
  4.9 gwei where the cap binds some calls). The pool never overpays.
- **Keeper viable through 5 gwei:** net positive at 1–4.9 gwei (cost proxy = (measured + 30k)·(basefee + 0.05 gwei)).
- **Above 5 gwei (spike to 6 gwei):** reward price is capped at 5 gwei (reward 0.004557 = 811480·5 gwei + 0.0005), so
  an honest keeper is underwater and rationally waits — liveness pauses until gas falls, exactly as designed, and the
  pool still never overpays. This is the "above the cap keepers wait" behaviour, confirmed.

## 3. Launch-scale mixes (coordinator priority 3) — creator profitable, 100% liveness

Deposit 10 ETH, 1 gwei, draws with keeper restock each, then close + full sweep. Creator NET =
(claimed at close + curated NFTs returned at value) − deposit. Evidence: `AddendumScale.t.sol`,
`logs/final-AddendumScale.log`.

| Mix | markup | draws / blocked | player paid (quoted) | **creator net** | stranded |
|-----|--------|-----------------|----------------------|-----------------|----------|
| Balanced (20×0.01, 10×0.05, 2×0.1, 1×0.5 Shapes, 7×0.02 packs, 1×0.3 NFT) | 15% | 40 / 0 | 0.973 ETH | **+0.4147 ETH** | 0 |
| 0.01-only (20×0.01) | 15% | 40 / 0 | 0.703 ETH | **+0.2680 ETH** | 0 |
| Bigger-prize (15×0.01, 4×0.1, 2×0.5, 1×2.0 pack) | 30% | 30 / 0 | 0.788 ETH | **+1.1105 ETH** | 0 |

All three mixes are creator-positive over the run, with 100% liveness (0 blocked) and nothing stranded after sweep
(Balancer residual 0). Spread note: these are single real-draw runs (one realised path each), not a distribution; the
sign is consistent and the magnitudes track accumulated markup. (A full loss-share distribution would need many
independent runs — see remaining gaps.)

## 4. Draws in flight (coordinator priority 4) — fill gate pauses before odds drift

Target 10×0.01 + 2×0.1, burst-acquire without settling. Evidence: `AddendumScale.t.sol::testDrawsInFlightBurst`,
`logs/addendum-flight.log`.

- Reachable in-flight burst depth = **3**, then `admissionStatus = 6` (LOW_INVENTORY) pauses new draws — the fill gate
  charges each unreconciled draw the heaviest prize and trips at 70% of target weight **before** the MAX_BATCH = 5 hard
  cap. `canPurchase` returns false at that point (M8 working).
- After settling the burst + reconcile (in order) + restock: `admissionStatus = 0` (healthy), profit 0,
  `profit ≤ balance` throughout. No winner left unpaid (each prize carries its own backing).

## 5. Findings and status

No confirmed security or economic exploit in any regime driven here. The route correction **strengthens** the original
results by extending them to realistic gas (to 5 gwei) and launch scale, and the two regimes the original seal could
not enter — below-reserve profit booking and the markup-change timing attack — were driven and show **no M9
violation** (0 ETH moved fund→profit; fund fully protected while short). The only earlier observation (L1: thin keeper
margin on single-Shape restocks at low basefee) is unchanged and remains informational; the gas table confirms keeper
net is positive through 4.9 gwei.

## 6. Remaining untested (narrowed from the original)

- Resolved by this addendum: original G1 (draws > 0.5 gwei) and G2 (bounded draw count) — now driven to 4.9 gwei and
  40 draws via the corrected route; G3 (below-reserve regime) — now entered and attacked.
- Still untested: failed-delivery → `recoverRefunded` → backing redemption and `retryNFTDelivery` (original G4); a
  generic hostile `onERC721Received` receiver end to end; a *pack* prize (denoms 9/13) specifically targeted, drawn and
  redeemed for exact backing (packs were present in the Balanced/bigger targets but I did not confirm one was the
  drawn prize); the `MINT_FEE_ROSE` gate with a real Shapes fee change; retirement after close; a multi-run loss-share
  distribution; and all off-chain code execution (keeper.ts / planner.ts / design.ts / tx.ts / App.tsx), reviewed by
  reading only. These are the honest residual gaps.
