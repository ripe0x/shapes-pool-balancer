# Release candidate `ce4b699` (main), 2026-11-13

Verification of the implementation, plus triage of the second Codex audit (`audit/rc-122de71/REPORT.md`; its
candidate `122de71` has the same tree as `ce4b699`). Not product acceptance or release readiness. Mainnet fork pinned at
block 26,382,349 through `https://mainnet.gateway.tenderly.co`; fork tests run at basefee 0.5 gwei and gas price
1 gwei, asserted inside a transaction (`test/ForkContext.t.sol`).

## Evidence on the frozen candidate

Frozen in its own worktree at `ce4b699` (tracked tree clean). One environment step was needed (RC-1 below): create the
untracked `deployments/` folder.

| Check | Command | Result |
| --- | --- | --- |
| Build and sizes | `forge build --sizes` | exit 0; PoolBalancer runtime 20,859 B (3,717 under the limit), ShapePacks 17,768 B, BalancerFactory 2,117 B |
| Solidity suite | `CANDIDATE_RUN=1 forge test --gas-limit 100000000000` | 148 tests in 19 files passed, exit 0 (396 s) |
| TypeScript | `npm run test:ts`, `npm run typecheck`, `npm run build:app` | 50 tests in 5 files passed; typecheck and build exit 0 |
| Fork economics matrix | `test/EconFork.t.sol`, 8 scenarios (table below) | all passed; 13,328 draws sold, none refused; every run ends with the full closeout |
| Asset gate | `asset_gate.py` | 9 regimes balance to the wei; INCOMPLETE (outcomes unsigned); O5 fails (`large_win`, D9 below) |
| Keeper end to end | `npm run keeper:e2e` | passed (160 s) |
| Launch rehearsal | `npm run rehearsal -- --rounds 300` | passed (1,003 s): buyers found pools open 288/288 times, 832 draws, 12 markup changes, 7 creator edits; the keeper sent 336 transactions, 335 mined, 0 reverted, waited all 24 above-cap periods and resumed without help, survived 2 restarts, net +0.0492 ETH (rewards 0.2915 less gas 0.2424) |
| Dashboard, reserve after a mint-fee drop | candidate deployed on the 8545 fork; Shapes fee 0.001 → 0.0005 ETH | pass: "Kept in the pool while open" 0.134 ETH = `requiredReserve()` 0.1337; "Not used" 2.456 = `withdrawableSurplus()` |
| Dashboard, prices after a markup change | 15% → 18.75%, saved | FWA's draw price unchanged (0.027054 ETH: listed prizes keep their price), the preview says new prices apply as prizes restock, purchases stay open; findings RC-2 and RC-3. Not exercised: a draw and restock after the change |

Fork economics matrix (Balanced board, one 0.2 ETH NFT relisted when won, creator claims after every draw, full
closeout; random seeds plus two forced 0.5 ETH wins):

| Scenario | ETH in | Random runs | Creator result, mean | After NFTs given away: mean (min to max) | Forced-win runs, after NFTs | Draws refused |
| --- | --- | --- | --- | --- | --- | --- |
| ape-ball curve, 10% markup, 12 small | 1.67 | 6 | 0.49 | 0.39 (0.00 to 0.76) | −0.56 / −0.45 | 0 |
| ape-ball, 10%, 10 small | 0.67 | 6 | 0.37 | 0.21 (−0.26 to 0.59) | 0.12 / 0.38 | 0 |
| ape-ball, 25%, 12 small | 1.67 | 6 | 1.07 | 0.97 (0.78 to 1.16) | 0.62 / 0.66 | 0 |
| ape-ball, 25%, 10 small | 0.67 | 6 | 0.86 | 0.62 (0.08 to 1.08) | 0.08 / 0.69 | 0 |
| ape-ball, 50%, 12 small | 1.67 | 6 | 1.58 | 1.38 (0.57 to 1.72) | 0.70 / 0.96 | 0 |
| ape-ball, 50%, 10 small | 0.67 | 6 | 1.68 | 1.55 (1.28 to 1.82) | 1.82 / 1.28 | 0 |
| 40 a day, 10%, 12 small | 1.67 | 3 | 3.39 | 2.46 (2.13 to 2.84) | 1.41 / 1.42 | 0 |
| 40 a day, 25%, 12 small | 1.67 | 3 | 6.73 | 5.60 (5.07 to 6.28) | 5.64 / 5.20 | 0 |

Results are higher than the earlier table in `docs/fork-economics.md` (commit `9fd5f83`, before option B), which fits
the restocking fee now being the creator's income.

## Findings from the release-candidate run

| # | Finding | Status |
| --- | --- | --- |
| RC-1 | `Deploy.s.sol` writes `deployments/<chain>.json`, but the folder is not tracked, so a deploy from a fresh clone fails (in simulation, before any broadcast) | fixed on `rc-ce4b699-followups` (`vm.createDir`), dry-run checked from a checkout without the folder |
| RC-2 | The pool page said "Draw price … at 18.75% markup" while listed prizes keep their earlier markup | fixed: the note no longer names the markup |
| RC-3 | Creator earnings use the current markup for every listing, so after a markup change they are off until the board restocks (`items()` does not return each listing's markup) | open, decision D11 |
| RC-4 | How it works still said the restocking fee pays the keeper who lists the prize and the winner pays it back (pre-option B) | fixed |

## Second Codex audit (`122de71`), triage

Codex disclosed that it read our re-attack test before writing its own, so its D3 retest is informed, not independent.

| # | Finding | Known? | Basis | Our check | Disposition |
| --- | --- | --- | --- | --- | --- |
| E1 | O5 still fails: the outcome does not encode the owner's chosen response (Add ETH or Continue) | known | executed | the gate run above | **D9** |
| E2 | On a top-heavy board (one 0.01 ETH Shape, one 25 ETH Pack, one NFT) the fill gate refuses a second sale while one draw is pending, with all inventory listed | new | executed | **reproduced**: `admissionStatus` 6 with prize weight = target, second FWA purchase reverts, reopens after expiry and upkeep. Measured FWA draw odds: 0.01 Shape 94.6%, NFT 5.4%, 25 ETH Pack 0.04% | **D8** |
| E3 | A failed randomness-fee read showed as 0, so "Players pay" could omit 0.000351 to 0.0117 ETH | new | reasoned | confirmed in code | fixed: unknown fee → "Draw price" only, with a note |
| E4 | In-flight restocks shift creator profit by 0.0003 ETH per 180 draws | known (O9) | measured | `restock_in_flight` | **D10** |
| — | Copy says the creator keeps all markup, while the first 10% refills the reserve while it is short | new | reasoned | confirmed | fixed |

Also confirmed by Codex: the "Continue without the prize" path on a board whose only Shape prize is a 25 ETH Pack:
after two top wins, saving the design with a 0.01 ETH Shape instead reopens sales and the next purchase succeeds.

### Why the E2 refusal protects the creator

The gate allows one 0.01 ETH prize's weight per unreconciled draw, the heaviest a draw can remove. On this board the
lone 0.01 ETH Shape carries 94.6% of FWA's draw odds, so a pending draw almost certainly takes it. A second buyer
admitted meanwhile pays 0.0436 ETH, priced on the full board, but draws from what is left, where the NFT has 99.2% of
the odds. Expected cost to the creator of each such sale: about 0.33 ETH (arithmetic from the measured odds and prices,
not executed). The refusal lasts until the pending draw settles or expires and upkeep runs.

When it bites: a board pauses after k unsettled draws once k × 1e20 > 30% of its prize weight. Weight per prize is
1e36 / backing, so a 0.01 ETH Shape is 1e20. A board with less than about 17 × 0.01 ETH Shapes' worth of weight
(1.67e21) pauses before FWA's limit of 5 unsettled draws. The launch board (3.06e21) never does: it would need 10.

## Decisions for the owner

**Owner's answer (2026-11-13): D8 a, D9 a, D10 a, D11 a ("Yes, all four").** Done on `rc-ce4b699-followups`, no contract
change:
- D8: `pendingDrawsAdmitted` in the planner predicts the gate (tested at the boundary: 16 × 0.01 ETH Shapes admit 4
  pending draws, 17 admit 5; the E2 board admits 0) and the design page warns "With this mix, purchases pause while N
  draws are unsettled" (checked in the browser: shown for the 10-small default, gone at 24 small). New flow regime
  `top_heavy` on the E2 board: 180 second buyers arrived while a draw was unsettled and all 180 were refused by FWA's
  `PurchaseNotAllowed()` (the Balancer's gate), 0 buyers were refused with every draw reconciled. O7 reworded.
- D9: O5 now measures days ending with a prize missing after the creator's response: 0 in both what-if regimes (Add
  ETH, Continue); `large_win` without a response shows 20 days as information.
- D10: O9 accepted as worded (0.0003 ETH measured against 0.001 per 180 draws).
- D11: the earnings figure says it is an estimate at today's markup and that earlier listings keep theirs until they
  restock (checked in the browser).

Gate after these changes: 12 required regimes, all nine outcomes pass; INCOMPLETE only for the missing signature.

**Audit-process follow-ups (shared guidance, 2026-11-13):**
- Regimes for the extremes `configure` allows, quiet play, 180 draws each: `extreme_top_heavy` (one 100 ETH Shape),
  `extreme_bottom_heavy` (80 × 0.01), `smallest_board` (one 0.01), `largest_board` (80 × 100 ETH, 8,000 ETH backing).
  All nine outcomes hold in all four. The largest board shows the E9 pattern at scale: 30 of 180 draws won a 100 ETH
  prize (13.8% expected), the reserve was up to 585 ETH short and 23 days ended with a prize missing: the case the Add
  ETH / Continue buttons answer. 16 required regimes now.
- `review_dir: "audit"` in `asset-flow.json` and `--require-review` in `script/deploy.sh`: deploying needs a review
  record (`audit/**/SOURCE_HASH`) for the exact source. Set before signing, because it changes the approval hash.
- Codex's kept tests are permanent under `test/audit/` (OwnHoldChallenge, LowBalanceHoldProbe, NormalGasBoundary,
  TopHeavyGateChallenge): all pass.
- `OWNER-REQUIREMENTS.md` drafted at the repository root for the owner to confirm; the audit prompts point at it, and
  their M1, M2 and M5 now match option B and D5.


| # | Decision | Options and what each costs | Recommendation and why |
| --- | --- | --- | --- |
| D8 | Top-heavy boards pause while a draw is pending (E2) | **a) Keep the gate; scope O7 and warn.** O7 states the limit; the planner tells a creator "purchases pause after N unsettled draws" when N < 5; add a top-heavy flow regime. No contract change. **b) Deduct the heaviest prize actually listed.** No help here, since the 0.01 Shape is the heaviest listed. **c) Deduct less, or only when the remaining weight could not cover a draw.** Admits the mispriced sales above: about 0.33 ETH expected creator loss per extra sale on this board. **d) Refuse such designs at `configure`.** Contract change; creators cannot run small top-heavy boards at all | **a.** The pause protects the creator from selling draws priced on a prize that is about to go; it is short (until the draw settles); and only boards far smaller than the launch board hit it |
| D9 | O5 encodes the chosen response (E1) | **a) Reword O5:** "When prizes are missing for lack of ETH, the dashboard offers Add ETH and Continue without them; either restores a full board within one keeper pass." Measured in the two what-if regimes: 0 days missing in both; `large_win` (no action) is shown as information. **b) Keep O5** and sign it as a known exception (119 keeper passes, 20 days without the top prize) | **a.** It measures what you decided: the creator chooses, and either choice works |
| D10 | Profit split while restocks are in flight (E4) | **a) Accept** O9: ≤ 0.001 ETH booked beyond the priced-board split per 180 draws (measured 0.0003, never under-booked). **b) Snapshot the split per draw:** a contract change and a second accounting path | **a.** 0.07% of the creator's profit, and in the creator's favour |
| D11 | Earnings after a markup change (RC-3) | **a) Label the figure "estimate until prizes restock"** (app only). **b) Return each listing's markup from `items()`** so the figure is exact: a small contract change and a re-check | **a for launch.** Prices, odds and the reserve are exact; only this advisory figure lags, and only until prizes restock |

If D8 a and D9 a are chosen, the work is: the O7 and O5 wording in `asset-flow.json`, the planner warning, a top-heavy
regime, and the what-if regimes added to the gate. None of it changes contract code.

## Things that don't make sense

- The fork matrix's random runs at 10% markup now average 0.39 ETH after NFTs, against 0.21 ETH in the older table. That
  fits option B (the restocking fee is now the creator's income), but nobody has reconciled the two tables line by line.
- `ForkBase.buy` still lets the test contract pay instead of the named buyer (noted earlier); no current result depends
  on the buyer's balance.
