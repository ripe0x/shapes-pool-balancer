# Schema-2 manifest review (independent evidence challenger, pass 2)

Reviews `audit/round9/gate/audit-gate.json` (not modified). Per-postcondition decisions in `manifest-review.json`
(keys `<path_id>/<postcondition_id>`, `evidence_ids` echo the postcondition's). Gate status was 1 (FAIL) for:
P8 unresolved outcome (intentional, an open question), independent review missing, "reviewer must assess every
postcondition" — this review supplies that assessment. 10 postconditions: **7 accepted, 3 challenged**.

| path / postcondition | status | one-line reason |
|---|---|---|
| P1_accessors / pc_nomutate | accepted | getters are view (compiler); stateful invariants at rest cross-check independent sums |
| P2_authorization_admin / pc_authz | accepted | creator matrix + two-step reverts, both lanes, real fork |
| P2_authorization_admin / pc_page_epoch | accepted | epoch bump re-checks the exact approved digest |
| P3_split_m9_violation / pc_m9_extent | **challenged** | assertion solid (reproduced RUN1/2, unlist-neutral proved RUN3) but its own "automatic curated draw" variant is not in the cited evidence; now demonstrated via upkeep order (RUN10), uncited |
| P3_split_m9_violation / pc_m9_net | accepted | 0.01738 ETH extraction is claimed and fund read strictly lower (RUN7) |
| P4_keeper_restock_delivery / pc_keeper_pay | accepted | M1/M2 within the measured 1–4.9 gwei / burst bound; row flags the rest honestly |
| P4_keeper_restock_delivery / pc_delivery_reentrancy | **challenged** | reward-callback reentrancy asserted "blocked" but only guarded in code, never executed (slither-triage: untested); EV_keeperreent tests collection re-entry, not the reward recipient |
| P5_reserve_protection / pc_open_reserve | accepted | funded/under-funded boundary; at-open-only gate is correct scope |
| P5_reserve_protection / pc_below_reserve | accepted | literal assertion holds (markup-change=0 reproduced RUN5); automatic over-booking tracked under P3 |
| P8_refund_open_questions / pc_refund_player | **challenged** | pool-side verified and player-amount genuinely open (accept), but the "automatic PoC was not built" clause is now stale — it IS built (RUN10) |

## The C12 dispute — decided on evidence (controller's UpkeepOrder.t.sol, re-run RUN9; my assertion RUN10)

The controller is **right** that my pass-1 C12 framing over-claimed, and **also right** that a genuine automatic
variant exists — but it is a different mechanism than I named:

→ **My C12 "collect-before-reconcile books 0.001985 ETH of NFT money = leak": REJECTED as a standalone leak.**
RUN9 test 1 (5×0.01 + 1 curated, no big win): collect-first books 0.001985 ETH, which equals a *Shape* draw's baseline
(RUN9 test 2) — it is the **designed EV split** (`amount·profitShareSum/n` = expected markup-above-10% for a draw
priced on that set; FWA charges every draw the same EV price, and the curated's zero share is the expectation, not an
outcome attribution). The "shortfall" there was **transient** — only the unreconciled-draw term in `requiredReserve`
(`lastIssuedSequence − reconciledSequence + 1`). After reconcile the reserve drops to 0.044 ETH, fund 0.0609 > 0.044,
and the whole 0.01697 ETH payment is withdrawable surplus either way: collect-first and upkeep-only both end with
claimable 0.01697. **No net leak.** My pass-1 `AutoCuratedLeak.t.sol` asserted `booked==0` and read a non-zero figure,
but that figure is the EV split, so the "leak" conclusion does not follow.

→ **Controller's variant — performUpkeep (reconcile-before-collect) over-books on a curated draw in a GENUINE
shortfall: ACCEPTED, and now asserted (not just logged).** RUN9 test 3 and my `UpkeepOrderAsserted.t.sol` (RUN10): after
a real 0.5 ETH win spends the spare (balance 0.064 **< reserve 0.534** — a true shortfall, not the unreconciled term),
drawing the curated NFT and then running the keeper's normal `performUpkeep` reconciles the share-0 curated **out**
before `_collect`, splitting the same proceeds over `n−1` instead of the draw-time `n`: booked **0.002188 → 0.002553
ETH (×7/6)**, and claimable **0.004283 → 0.004647 ETH** — **0.000365 ETH of fund money made withdrawable with no
creator action**, purely from the keeper's reconcile-first order, while the fund is below the reserve. Same root cause
as `withdrawCurated` (removing a share-0 listing before collect), but triggered automatically by the default keeper
path. This confirms lane A's stated root cause ("`performUpkeep` reconciles before `_collect`") as a genuine automatic
M9 instance.

**Net effect on the overall M9 finding:** it stands and is *strengthened* — M9 is not only creator-gameable via
`withdrawCurated`; the keeper's ordinary upkeep over-books on any curated draw while genuinely short. The controller's
own test only asserts `profit>0`; `UpkeepOrderAsserted.t.sol` (RUN10) asserts the over-booking and the strictly-larger
withdrawal, closing the test's weak spot. A fix must reorder/attribute `_collect` relative to reconcile, not only add a
`_collect()` to the creator listing-set functions.


---

# Pass-3 manifest re-review + draft-report scan

Start (UTC): 2026-11-13T13:03:50Z. End: 2026-11-13T13:16Z (active ~12 min; 25-min ceiling). New files only under
`audit/round9/challenge/`; pass-1/pass-2 files unchanged; one test file per forge run; no `forge clean`; no
sealed/production/test file modified; manifest not edited; nothing committed.

## Six re-reviewed postconditions — all ACCEPTED (each re-run, each executes its stated variant)

| path / postcondition | re-run | decision | basis |
|---|---|---|---|
| P3/pc_m9_extent | RUN1/2/7/10 | accepted | pass-2 challenge resolved: now cites EV_upkeeporder + EV_upkeeporder_asserted; creator lever (×6/5) and automatic upkeep-order variant (0.000365 ETH in a genuine shortfall) both reproduced |
| P4/pc_delivery_reentrancy | RUN11 | accepted | reward callback now EXECUTED: transferCreator/close/configure persist re-entrantly, guarded collect reverts, profit≤balance; no privilege gain (caller is creator) |
| P4/pc_burst_gas | run-BurstUpkeepGas | accepted | 5 unsettled, 6th reverts, BUSY; heaviest upkeep 2,526,724 gas < 4M; M1 0.0005 ≤ 0.001225 credited; profit 0, target restored |
| P6/pc_mintfeerose | run-MintFeeRoseGate | accepted | real admin raises live fee; MINT_FEE_ROSE, canPurchase false, reserve 0.044→0.045, restock blocked, re-accept resumes, M7 clean |
| P6/pc_retire_closeout | run-RetireCloseout | accepted | close→retire with draw in flight; settles+reconciles after retire; M7 ends 0 ETH, 0 listings. Minor: "exact backing" verified via aggregate M7, not per-item |
| P8/pc_refund_player | RUN16 | accepted | pass-2 challenge resolved: EV_refundwithdraw executes refundFailedDelivery THEN withdrawAcquisitionRefund; player recovers exactly 0.630139131231725739 ETH (net loss 0); failed draw books 0 proceeds/profit; below-reserve 0 profit |

Full per-key reasons and evidence_ids in `manifest-review-pass3.json`. These convert the gate's outstanding
"independent reviewer must assess every postcondition" for the six withheld rows into an assessment; the only remaining
intentional gate failure is P8's `unresolved` outcome (the player-refund-AMOUNT was an open question — now established,
so the controller can flip that outcome if it chooses).

## Draft `report.md` — sentences claiming more than cited evidence

The report is largely accurate and already carries the pass-2 corrections (C12 is NOT framed as a leak; the automatic
path is the upkeep reconcile-order; M9 severity Low). Flags:

1. **Process record (lines ~183-184): unfilled placeholders.** "Used about **BUDGET_USED** (... manifest
   **MANIFEST_TIME** ... controller about **CONTROLLER_TIME**); wall clock 11:28 to **END_TIME**." These template tokens
   assert nothing concrete; the budget-used claim is not yet backed. Fill before finalizing.
2. **Property map, Failed-delivery row: "player withdraws exactly the acquisition fee (0.630139 ETH)."** True, but the
   refund (withdrawAcquisitionRefund) returns only the ACQUISITION fee, and every refund run was at gas price 0 (VRF
   fee 0, as the row's own bound notes). Whether the VRF portion is recoverable at real gas is untested, so this must
   not be read as "the player is made whole at launch gas." Suggest: "recovers the acquisition fee; VRF-fee
   refundability at non-zero gas untested."
3. **ApeBall item 1 "Does not apply" (keeper paid at bid).** Established only up to the tested ≤4.9 gwei region (above
   the 5 gwei cap keepers rationally wait); the one-line verdict omits that bound. Minor — add "up to the cap".
4. **Not an overclaim (checked):** the economic tables' mean (min–max) distributions and loss-share % are genuine
   multi-run real-fork results (`test/EconFork.t.sol`, random runs, realized=estimate-to-the-wei asserted), not a
   model; `sim/flows.ts` is correctly flagged separately (E3 open). Lane B launch-mix figures are correctly labeled
   "single runs."

No sentence asserts safety, exhaustiveness, absence of all vulnerabilities, or release readiness; line 4's disclaimer
("scoped evidence, not a safety proof or a release decision") stands.
