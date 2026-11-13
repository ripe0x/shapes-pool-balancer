# Round 9 — Independent evidence challenge (informed)

Challenger: independent evidence-challenge lane (reads the sealed lane outputs and controller records; does not perform
blind discovery). Target frozen at `c686534` (production source identical to `7b32497`). Fork mainnet block 26,382,349
via `https://mainnet.gateway.tenderly.co` only. No protocol contract mocked in any challenge test; VRF delivered only
through the real Chainlink coordinator `0xD7f86b4b8Cae7D942340FF628F82735b7a20893a` → FWA VRF service
`0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d` `rawFulfillRandomWords` route.

- Start (UTC): **2026-11-13T12:13:40Z**. End (UTC): **2026-11-13T12:27Z** (active ~13 min; well under the 75-min ceiling).
- All my files are under `audit/round9/challenge/`. No sealed file, production file or existing test modified. Nothing
  committed, pushed or broadcast. No process killed.

## 0. Seal integrity (all verified, recomputed SHA-256)

| Sealed artifact | Seal file | Match |
|---|---|---|
| lane_a `sealed-inventory.md`, `FullCycle.t.sol`, `KeeperReentrancy.t.sol` | `lane_a/discovery-seal.md` | **match** |
| lane_a addendum `M9Extent/M9Scale/StatefulCycle.t.sol` | `lane_a/addendum/addendum-seal.md` | **match** |
| lane_b `sealed-inventory.md` | `lane_b/discovery-seal.md` | **match** |
| lane_b addendum `AddendumBelowReserve/AddendumScale.t.sol` | `lane_b/addendum-seal.md` | **match** |
| integration `sealed-inventory.md`, `FullCycle.t.sol` | `integration/discovery-seal.md` / `addendum-seal.md` | **match** |

Target commit still `c686534…`, tracked tree clean except untracked `audit/` artifacts.

---

## 1. Claim-by-claim domain table

Decision key: **AWB** = accepted within stated bounds; **N** = narrowed (narrowed wording given); **ROQ** = rejected,
question open. Evidence IDs `RUNn` = `audit/round9/challenge/runs/runN-*.log`; lane logs cited by path.

| # | Claim (source) | Claimed domain | Exercised / proved domain | Evidence | Decision | Narrowed wording |
|---|---|---|---|---|---|---|
| C1 | **M9 withdrawCurated-before-collect books more profit** (lane A Finding 1; informed-retests M9) | any game-first collect with ≥1 curated | 5×0.01+1 curated short regime, honest 0.001985 vs acted 0.002383 (×6/5); real route identical | RUN1, RUN2(T1), lane_a `logs/m9.log` | **AWB** — reproduced both routes | — |
| C2 | **M9 worst case = 0.01738 ETH net extraction** (lane A addendum; 100% markup,10sh+10cur) | launch-scale worst board | honest profit 0 → acted 0.017384 ETH withdrawn; fund 0.085→0.0677 | RUN7 | **AWB** | — |
| C3 | **M9 collection-timing is timing-only, not lifetime** (lane A T2) | keeper-reconcile-first path books 0 | reproduced: collect-first 0.001985 vs keeper-first 0 | RUN2(T2) | **AWB** | — |
| C4 | **unlistShapes is neutral / fund-favourable for every subset** (lane A T3, addendum §1) | all boards | lane A tested only HOMOGENEOUS 5×0.01 (all shares equal → trivially neutral). I tested HETEROGENEOUS 4×0.01+1×0.5: unlisting a 0.01 (below-average-looking) shape LOWERED profit 0.002510→0.002421 | RUN3; `UnlistShareLever.t.sol` | **AWB — basis strengthened** | Holds for ALL boards, and I give the general reason: admission requires ≥1 curated (share 0), which drags the blended average `profitShareSum/n` below every shape's share, so Σshares ≥ n_shapes·s_min ⇒ s_min ≥ Σshares/(n_shapes+1); no shape is ever below the average while any curated is listed, so removing a shape never raises the ratio. |
| C5 | **listCurated / configure / creator-transfer are neutral or fund-favourable** (lane A T4–T6) | game-first regime | reproduced T4 (0.001985→0.001702), T5/T6 unchanged | RUN2 | **AWB** | — |
| C6 | **"fund keeps all NFT sale money" holds; no counterexample** (lane B H9) | lane B says "exercised domain" | lane B only reached the **above-reserve** domain (its H9 note + gap G3). BELOW reserve a curated draw books its NFT money as profit (C12) | RUN8; `AutoCuratedLeak.t.sol` | **N** | No counterexample **only above the reserve**; below the reserve the claim is false (see C12). |
| C7 | **Markup-change timing books 0 while short** (lane B addendum §1; C2) | sole-keeper below-reserve | lane B's own file not re-runnable (harness hardcodes `deployCode("out/…")`, a transient root-out artifact; sandbox denied copying it in). Reproduced the CLAIM on lane A's harness: 10%-markup proceeds, configure→100%, collect = 0 booked | RUN5; `MarkupChangeBelowReserve.t.sol`; code: `_share` reads `it.markupBps`, `configure` never rewrites items, `performUpkeep` collects (step 2) before restock (step 3) | **AWB** (claim), lane-B-file reproduction **blocked** | — |
| C8 | **M1/M2: lifetime keeper pay ≤ restock fees credited** (lane B H1/H4, addendum §2; integration) | ≤4.9 gwei, 16–40 draws | lane B real receipts 1/3/4.9 gwei equal-or-under; priority overbid neutral; reward capped at `keeperCredit` | lane_b `logs/addendum-gas.log`; code `_payKeeper` cap | **AWB** | Within ≤5 gwei; >5 gwei keepers rationally wait (reward capped at 5 gwei). |
| C9 | **Creator net positive at launch scale** (lane B addendum §3) | 3 mixes | Balanced +0.4147, 0.01-only +0.2680, bigger +1.1105 ETH | lane_b `logs/final-AddendumScale.log` | **N** | Single realised run per mix, **not a distribution**; sign consistent, loss-share not measured. |
| C10 | **Integration full cycle to delivery + restock is correct** (integration addendum P1) | one cycle, 1 gwei | reproduced: player 0.021194, keeper net +0.000340, balance Δ +0.005812 | RUN6 | **AWB** | — |
| C11 | **Access/authority, reentrancy, impl-lock, epochs, recover guards all hold** (lane A §1, lane B H10–H16) | real-fork unit paths | not re-run (read); consistent, no mocks, bounded; reentrancy callback path itself untested (slither-triage) | lanes' logs | **AWB** | Reward-callback reentrancy remains read-only (not executed). |
| C12 | **Automatic curated-draw NFT-money leak is reachable** (NEW; lane A "related, not PoC'd"; lane B G3/H9 open) | — | **CONFIRMED:** no creator action — draw the curated NFT while short (fund 0.044<res 0.0715); collect books 0.001985 ETH of its 0.01697 ETH sale money (~11.7%) as withdrawable profit | RUN8; `AutoCuratedLeak.t.sol` | **ROQ → now confirmed finding** | — |

---

## 2. Findings reproduced (one file per run, lane settings, real route)

| Finding | Command (env prefix `FOUNDRY_OUT`/`FOUNDRY_CACHE_PATH` per lane) | Exit | Result |
|---|---|---|---|
| M9 (lane A, original direct route) | `forge test --match-path audit/round9/lane_a/FullCycle.t.sol --match-test testM9WithdrawCuratedInflatesProfit` | 0 | PASS; 0.001985→0.002383 (RUN1) |
| M9 extent (lane A, real coordinator route) | `--match-path audit/round9/lane_a/addendum/M9Extent.t.sol` | 0 | 6 PASS; levers reproduced (RUN2) |
| M9 worst case (lane A) | `--match-path audit/round9/lane_a/addendum/M9Scale.t.sol` | 0 | 2 PASS; 0.017384 ETH net extraction (RUN7) |
| Lane B markup-change (reproduced on lane A harness) | `--match-path audit/round9/challenge/MarkupChangeBelowReserve.t.sol` | 0 | PASS; 0→0 booked (RUN5) |
| Integration full draw cycle | `--match-path audit/round9/integration/FullCycle.t.sol --match-test test_full_draw_cycle` | 0 | PASS; figures match (RUN6) |
| **Automatic curated leak (NEW)** | `--match-path audit/round9/challenge/AutoCuratedLeak.t.sol` | 1 (assert) | **Demonstrates leak**: booked 0.001985 ETH of NFT money while short (RUN8). The non-zero assertion failure IS the finding. |
| Challenge: unlist heterogeneous | `--match-path audit/round9/challenge/UnlistShareLever.t.sol` | 0 | PASS; my hypothesis refuted, lane A confirmed (RUN3) |

Lane B's own `AddendumBelowReserve.t.sol` returned `vm.getCode: no matching artifact found` (RUN4): its harness deploys
packs via `deployCode("out/ShapePacks.sol/ShapePacks.json")`, a literal root-`out/` path populated transiently during
the lane's run and absent now; the identical artifact exists in `lane_b/out/` but copying it into root `out/` was denied
by the sandbox. I reproduced the substantive claim on lane A's harness instead (RUN5) plus a code trace.

---

## 3. M9 root cause decision (task item 3)

**Mechanism (confirmed from code `src/PoolBalancer.sol`):** `_collect` (830-842) books
`mine = amount * profitShareSum / (n * 1e18)` with `n = activeIds.length`, and while `fund < requiredReserve()` books
`mine` as withdrawable `profit`. `profitShareSum = Σ _share(lid)`; `_share` (872-877) is 0 for curated and
`amount·(it.markupBps−1000)·1e18/(BPS·it.price)` for a shape, reading each item's **stored** markup. Removing a listing
with share `s_j` changes the ratio: it **rises iff `s_j < profitShareSum/n`** (the blended average).

**Can the split set differ from the set the draws were priced on, per creator function?**

→ **`withdrawCurated`** (424): does NOT `_collect` first; `_removeActive` drops `n` by 1, curated share is 0 (always
`< average`), so the ratio rises. **Confirmed lever** (C1, C2). Triggerable by **creator only**; the creator then calls
permissionless `collectProceeds` (476) before a keeper does. A keeper's `performUpkeep` auto-collects (step 2) at the
honest ratio, so the creator must win the timing race, in the game-first regime, and re-list curated after (gas cost ≈
0.015 ETH at 5 gwei for 10 NFTs) — bounded, **Medium**, as lane A scored.

→ **`unlistShapes`** (494): does NOT `_collect` first, and the set DOES differ. But every live/admitting pool holds ≥1
curated (admission returns `NO_CURATED` otherwise, line 572), whose share-0 listing drags the blended average below
**every** shape's share (proof in C4). So `s_shape ≥ average` always ⇒ removing a shape only **lowers** the ratio
(fund-favourable). **Lane A's "neutral" claim holds for every subset** — I verified the one case lane A did not (a
heterogeneous board, RUN3) and derived the general reason. Not a lever.

→ **`listCurated`/`listCuratedBatch`/`updateCuratedPrice`/`configure`** (378-420, 323): add a share-0 listing or change
only global/target state; dilute or leave the ratio → fund-favourable or neutral (C5, RUN2). `configure` never rewrites
existing items' markup, so a markup change cannot re-price accrued proceeds (C7, RUN5). Not levers.

**Automatic (no creator action) variant — now CONFIRMED (C12, RUN8).** Reconciliation in `performUpkeep` removes won
listings before `_collect`, but a settled-yet-**unreconciled** curated draw leaves the reserve inflated (`requiredReserve`
counts `lastIssuedSequence − reconciledSequence + 1` draws, 789) so the fund stays below reserve, while the curated's
pure NFT-sale proceeds sit in `ownerProceeds`. Any `collectProceeds` (permissionless — anyone can fire it) then books
`amount·profitShareSum/n` of that NFT money as profit. Measured: 0.001985 ETH booked from 0.01697 ETH of curated sale
money (~11.7%), fund 0.044 < reserve 0.0715, **with no creator action**. This is a direct violation of M9's "the fund
keeps … all NFT sale money" and resolves the path both lanes left open. It elevates M9 from a creator-timing lever to a
split rule that is wrong on its face for NFT-sale money whenever a collect lands below the reserve.

**Root-cause statement:** the profit split is a *time-of-collect snapshot average over the current active set*, not a
*per-settled-draw attribution at the listing that was drawn*. Any divergence between the two — creator-removed curated,
or a curated draw whose NFT money is averaged against shape shares — misbooks fund money as profit while short. Suggested
fix (suggestion only, needs owner approval): attribute each settled draw's proceeds to the listing actually drawn (0 for
curated), and/or `_collect()` at the start of `withdrawCurated`/`unlistShapes`/`listCurated*`/`updateCuratedPrice`/
`configure`. A fix must cover the automatic curated-draw case, which `_collect`-on-creator-action alone does not.

---

## 4. Consequential open questions (each with the next deciding action)

1. **Severity of the automatic curated-draw leak (C12) at launch scale and over many draws.** Confirmed reachable;
   per-event magnitude and whether it compounds across a big-prize board with several unreconciled draws is unmeasured.
   *Next:* parametrise `AutoCuratedLeak.t.sol` over the Balanced/bigger-prize mixes and N unreconciled curated draws;
   sum booked-vs-should-be-0 across a month of short-regime collects.
2. **Player-side refund AMOUNT on a failed curated delivery.** Lane A drove the pool side (`recoverRefunded` returns the
   NFT; `ownerProceeds` stays 0) but the ETH returned to the losing player is FWA-internal and measured 0 in-harness.
   *Next:* read FWA listing/refund source (out of blind scope) or assert the player's balance delta on the real refund.
3. **Loss-share distribution for the creator.** Only one realised run per mix (C9). *Next:* many-seed fork runs or the
   `sim/flows.ts` model validated against fork receipts (E3 still open: sim fixes VRF=0.0003 vs measured 0.00234/gwei).
4. **Off-chain code actually executed.** `keeper.ts`, `planner.ts`, `design.ts`, `tx.ts`, `App.tsx` were read by all
   lanes, run by none; planner↔contract parity is a read, not the generated `test/fixtures/parity.json` fork run.
   *Next:* run the TS keeper/planner against a fork and diff against contract getters.
5. **mint-fee-rise gate (`MINT_FEE_ROSE`), retirement, >5-draw bursts, reward-callback reentrancy.** Untested by all
   lanes. *Next:* focused fork tests raising `Shapes.mintFee()` and driving `retire()` / a 6+ burst.
6. **Lane B file-level reproduction.** Blocked by the harness's hardcoded root-`out/` path. *Next:* rebuild pack
   artifacts into root `out/` (owner-approved write) and re-run `AddendumBelowReserve.t.sol` for a first-party receipt.

A failed/absent reproduction here closes only that attempt; none of these open paths is disposed of by a bounded search.
