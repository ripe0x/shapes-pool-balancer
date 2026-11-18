# Interrupted whole-candidate review

**Incomplete. No exact-source review seal, owner signature or release clearance is supplied.** Target revision `04bc760d506fd29329a3a819c7f2e4a1480377dd`; source/evidence fingerprint `ca02fb070a2a839cccc9fced15b3116613f6d7727d4e50133693dd63a4c92eda`.

Two independent reviewers started 2026-11-18 at 02:09 UTC with 90-minute caps each and 30 minutes reserved for comparison. B was uninformed, not enforced-blind. A completed only preflight/source reads. B executed the evidence preserved under `b/`; its last recorded evidence timestamp was 02:39:34 UTC. Exact stop times were not recorded. Both reviewer turns were interrupted by platform cybersecurity filtering. The lead stopped investigation rather than retrying it through another agent, runtime or tool. Subsequent worker responses were diagnostic/reporting only. No final whole-audit report was completed by either reviewer, and no `SOURCE_HASH` file is created here.

The copied evidence is byte-preserved, including failed diagnostics, test versions and partial command records. `evidence-manifest.json` lists SHA-256 values. A's private checkout `/private/tmp/shapes-release-a-04bc760` has no executable result or report. B's private checkout was `/private/tmp/shapes-release-b-04bc760`; its original exclusion manifest remains there. This status summarizes existing results; it is not a replacement audit.

## Economic scorecard

| Scope | Actual flow/result | Interpretation |
| --- | --- | --- |
| 47-prize launch board, 180 draws, 60 low / 60 high / 60 low gas, 5 ETH deposit | Buyer payments 5.132146710728350514 ETH; buyer backing 2.88; mint fees 0.257; VRF 0.74412; FWA edge 0.208953652891826106; all keeper payouts 0.3169671705; creator returned 5.725105887336524408 | Whole-cycle ETH identity passed. No NFT win/contribution or operating top-up. Final zero-shortfall assertion failed: play surcharge 0.293190673676236157 versus play keeper 0.31161111325, loss **0.018420439573763843 ETH**. Gross creator return is not market net profit. |
| Same gas sequence, actual minimum opening and maximum permitted claims | Opening 1.76914 ETH; 180/180 fulfilled, zero refusals/paid failures/operating deposits; 181 interim claim calls return 0.635438812038056688; all creator returns 2.336998812038056688; purchaser obligations zero after close | Different liquidity/inventory path. Play surcharge 0.306604108771423091 less keeper 0.3056076791 gives **0.000996429671423091 ETH surplus**. Final open balance and requirement both 0.00156 ETH. The 306 partial-inventory observations count maintenance-stop checkpoints, not days. |
| O1 processing subset, 72 calls / 180 draws at 4.95 gwei basefee and 5 gwei bid | Measured gas 71,269,911; billed 60,389,250; retained-refund metric 60,448 gas/draw | Below reference 80,000 for this subset. Raw EVM refunds 83,873 gas/draw were incorrectly compared; original failure and retraction retained. Full-run setup/restocking aggregation remains unfinished. |
| Large board and allowed high markup | 1,000 small Shapes at 0.1 gwei carry 0.335 ETH uncollected listing surcharges; allowed 100% markup sample books 39.50% of proceeds | O2's 0.26 ETH and O8's 12% checks are reference-scenario quantities, not universal limits. Expected listing income is never liquid cash. |
| Additional concurrency | Nine concurrent requests initially fail actual VRF coverage; test succeeds after an explicitly recorded 1.687338994884955013 ETH voluntary service donation | This path is not a no-top-up continuity result. Five-request operation and minimum-capital results are separately scoped. |

## Security results and limits

Existing B logs include passing 10-test authority/policy/refund/reentrancy checks, four hostile-surface checks, two staged-Pack/receiver checks and a 64-case fork fuzz campaign. Results cover only their executed paths. They do not establish exhaustive security, an independent whole-candidate conclusion or mainnet readiness. FWA, Shapes and locally deployed project contracts were exercised; the accepted real-coordinator impersonation exception remains a randomness limitation. Current-block source checks were partial explorer/source comparisons, not a full independent dependency recompilation.

Unfinished: requirement-by-requirement audit coverage; complete independent reports/comparison; full-run O1 refund aggregation; separate monotonic block/timestamp witnesses at every fee-ramp step; unique end-of-period depletion duration; real extension-wallet signing; current-bytecode production-path rehearsal. Reuse prior final implementation verification (501 Foundry, 125 TypeScript, build/model and 25 numerical regimes) only for its unchanged inputs and stated limits. These checks do not complete the interrupted review.

## Disposition

Correct reporting scopes without changing fees, reserve coefficients, permitted markup or concurrency. Keep the independent O11 failed assertion visible. Recommend accepting conditional working-capital economics rather than promising surcharge-only break-even under every permitted sequence. This proposed outcome change still requires the owner's numerical approval/signature. The deployment wrapper remains blocked by unsigned outcomes and absence of completed exact-source review evidence. No broadcast or bypass was attempted.

## Things that don't make sense

- A positive aggregate creator return does not prove surcharges alone funded maintenance.
- A minimum-capital path and a 5 ETH path can select different inventory, so their cash results are not interchangeable.
- An interrupted audit cannot supply a completed-review seal.
