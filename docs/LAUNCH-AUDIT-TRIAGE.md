# Launch audit (section 0b) on `05e6b60`: triage

Step A (informed, Codex) and step B (uninformed, stripped copy) audited `main` at `05e6b60`, source hash `d4a80a3f…`;
step C compared them (coordinating session). Step B's report and its 17 tests are in `audit/launch-05e6b60-B/`. Step A's
report: path to be supplied by the owner. No contract code has changed; nothing below is repaired in contracts until the
owner chooses.

## Findings

| # | Finding | Found by | Basis | Our check | Disposition |
| --- | --- | --- | --- | --- | --- |
| S1 | **Nothing calls FWA's `processAcquisitions`.** A draw whose request reserved a staged restock skips FWA's randomness fast path (`_tryProcessCallbackHead` returns when `reservedListingsBySequence[sequence]` is not empty, and it only ever processes the queue's head), a Ready draw never expires, and the keeper and app only call `performUpkeep`. Ordinary play reaches it: a second buyer arrives while a draw is in flight and a restock is staged | B | executed | **reproduced** (`test/audit/LaunchB.t.sol`): after 4 rounds 5 draws unsettled, sales stopped (BUSY), still stuck 10,000 blocks later; winners unpaid until processed; no ETH lost. Processing the 5 takes 1,598,340 gas, after which upkeep reopens sales. FWA's sponsored processor (`0x1033…fc14` through the randomness service) processed only 2 pools in the last 50,000 blocks | **D16** |
| E1 | O10 holds for the launch board at steady normal gas only: 1.679× after 60 draws restocked at 4.95 gwei then back at 0.1; 1.532× after 30 draws at 2 gwei; 2.271× at 100% markup; 2.068× with 20 NFTs valued at 50 ETH | B | executed | follows from prices fixed at listing (restocking fee at the listing block's gas) and from creator choices | **D17** |
| E2 | The game's first 10% of markup stays only while the fund is below the reserve; above it the creator can claim everything. A creator claiming the maximum after every draw ended at a 0.207 ETH fund against 0.534 ETH required | B | executed | matches the design (DECISIONS 66-68) | **D18** |
| C1 | How it works said keepers are paid "only from the restocking fees", that mint fees and keepers are "never from your markup", and that purchases do not pause after draws | A | reasoned | confirmed | **fixed** (`app/src/HowItWorks.tsx`, checked in the browser) |
| C2 | Signed outcome text still begins "DRAFT" | A, B | reasoned | confirmed | batch with the next signature (any wording change changes the approval hash) |
| C3 | The factory is public from deployment; the owner's small first pool limits only the owner's deposit | A | reasoned | confirmed | **fixed** in the canary plan (`docs/LAUNCH-READINESS.md`) |
| C4 | Regimes run at basefee 0.5 gwei; the fork block's real basefee was 0.058 gwei and today's about 0.155 gwei | A, B | reasoned | `normal_gas` (0.1 gwei) exists; the others stay at 0.5 | information |
| C5 | A keeper that loses a race pays for a reverted call; not modelled | A, B | reasoned | about 50k gas (0.00003 ETH at 0.55 gwei) per lost race; the keeper simulates before sending | gap, information |
| C6 | Not executed by either: the app with a connected wallet (Add ETH, Continue, markup change), live randomness timing, mined keeper receipts, keeper restart | A, B | — | the dashboard paths were clicked on the local fork with the dev account; the 300-round rehearsal has receipts and restarts | rehearsal (step D) |
| B4 | The deploy gate accepts any `SOURCE_HASH` beside a `REPORT.md`, and a hand-set environment variable defeats `Deploy.s.sol`'s check | B | reasoned | confirmed; documented in `docs/ASSET-FLOW-GATE.md` | information |

### The harness was doing a job nobody does in production

Every call the fork harness makes that is not a player, an attacker or an external service acting as it really does:

| Harness call | Production component | Status |
| --- | --- | --- |
| `pool.processAcquisitions` (`ForkBase.settle`, `FlowBreakdown._process`, `keeper/e2e.ts`, `keeper/rehearsal.ts`) | **none** | S1 |
| randomness delivered as the coordinator (impersonation) | Chainlink VRF through FWA's service | stand-in; real timing untested |
| `performUpkeep` after every draw | the keeper service (`keeper/keeper.ts`) | covered; the rehearsal runs the real service |
| creator claims, relists, closes, unlists | the creator through the app | covered for the paths clicked on the fork |
| `collectProceeds` before upkeep (split check) | `performUpkeep` collects first anyway | equivalent |

No regime yet runs with the harness doing only what users do. One is part of D16.

## Decisions for the owner

| # | Decision | Options and measured costs | Recommendation and why |
| --- | --- | --- | --- |
| D16 | Who processes FWA's queue (S1) | **a) Keeper only (off-chain):** the keeper calls `pool.processAcquisitions` when the queue's head is ready or past its deadline. No contract change. Unpaid: about 320k gas per draw processed (0.00018 ETH at 0.55 gwei, 0.0016 at 5 gwei), borne by whoever runs our keeper; other keepers have no reason to do it. **b) `performUpkeep` processes, paid:** before reconciling, upkeep calls `pool.processAcquisitions(2)` in a try/catch when the head is ready or expired, so any keeper is paid for it under the usual reward. Contract change, a focused re-audit and a new review record; 2 per call keeps the worst upkeep near 2.83M gas, under the 3.2M cap (step B's hardest mix measured 2.19M). **c) Both** | **b.** It keeps the system self-sustaining (R6): any paid keeper unblocks a pool, not only ours, and the pay rule already covers it. Add a regime where the harness never processes, and a keeper test |
| D17 | O10's scope (E1) | **a) Restate O10** as the launch board at steady normal gas, with spike recovery and creator choices (markup, NFT values) shown as information. **b) Bound it more widely:** not possible without repricing listed prizes, which the design never does | **a.** The promise holds where it was measured; the rest depends on gas history and the creator's own choices |
| D18 | The game's 10% (E2) | **a) As built:** the first 10% refills the reserve while the fund is short; above the reserve the creator may claim everything. **b) Keep the 10% in the pool always:** a contract change; idle ETH grows with sales | **a.** The 10% exists to refill the reserve; above it there is nothing to refill. O5's Add ETH / Continue covers the case where wins drain the fund |

If D16 b is chosen, the batch for the next signature is: the repair, the no-processor regime, O10 restated (D17), and
"DRAFT" removed from the outcome text. One re-signature covers all of it.

## Things that don't make sense

- Every regime and both rehearsals processed FWA's queue themselves, so none of our evidence could show S1. The same
  shape of error as the zero-gas fork tests: the environment did a job reality does not.
