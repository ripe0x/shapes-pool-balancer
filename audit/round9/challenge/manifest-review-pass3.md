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
