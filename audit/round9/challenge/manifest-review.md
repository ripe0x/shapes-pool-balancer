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
