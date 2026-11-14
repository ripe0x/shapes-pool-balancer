# Launch audit (section 0b) on `05e6b60`: triage

Step A (informed, Codex) and step B (uninformed, stripped copy) audited `main` at `05e6b60`, source hash `d4a80a3f…`;
step C compared them (coordinating session). Reports and kept tests: `audit/launch-05e6b60-A/` with
`test/audit/launch-A/` (2 files, 3 tests, pass here), and `audit/launch-05e6b60-B/` with `test/audit/LaunchB.t.sol`. No contract code has changed; nothing below is repaired in contracts until the
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
| A1 | Accepted hostile-collection loss (R20): a creator's own collection can take back a delivered NFT; the player keeps nothing (0.0175 ETH measured) | A | executed | known, owner-accepted | no change; the app should not imply every NFT win is durable |
| A2 | Creators need a per-board forecast: O10 and O11 hold for the launch board, while NFT-dominated boards lose up to 0.035 ETH of keeper pay per 180 draws | A | reasoned | the planner shows draw price, odds and estimated earnings per design; it does not forecast keeper cost per board | information; candidate for the planner |
| A3 | App tests feed in made-up successful answers from external services (`app/src/wallet.test.ts` line 69, a fake Alchemy reply; `app/src/tx.test.ts`, a fake node and wallet provider). The owner's rule allows a failing service only | A | reasoned | confirmed | repair, no decision: run `tx.test.ts` against a real local node; keep only failing-service fakes; read Alchemy live behind an opt-in flag |
| B4 | The deploy gate accepts any `SOURCE_HASH` beside a `REPORT.md`, and a hand-set environment variable defeats `Deploy.s.sol`'s check | B | reasoned | confirmed; documented in `docs/ASSET-FLOW-GATE.md` | information |

### Step C: what each audit found that the other missed

| Only A | Only B |
| --- | --- |
| A2 per-board forecast (reasoned); A3 fabricated service answers in app tests (reasoned) | **S1 nothing processes FWA's queue (executed)**; E1 O10's scope (executed); E2 the game's 10% above the reserve (executed); B4 gate and environment-variable bypass (reasoned) |

Both: the How it works copy (C1), "DRAFT" in signed text (C2), the public factory (C3), regimes at 0.5 gwei (C4), lost
races (C5), the untested wallet-connected app (C6). Neither executed: the wallet-connected app, live randomness timing,
mined receipts on mainnet, a production keeper restart against a real node. Those belong to the rehearsal (step D).

### The harness was doing a job nobody does in production

Every call the fork harness makes that is not a player, an attacker or an external service acting as it really does:

| Harness call | Production component | Status |
| --- | --- | --- |
| `pool.processAcquisitions` (`ForkBase.settle`, `FlowBreakdown._process`, `keeper/e2e.ts`, `keeper/rehearsal.ts`) | **none** before D16; `performUpkeep` after it | S1, repaired (D16): removed from every regime, the e2e run and the rehearsal; `ForkBase.settle` stays in unit tests as the permissionless call anyone may make |
| randomness delivered as the coordinator (impersonation) | Chainlink VRF through FWA's service | stand-in; real timing untested |
| `performUpkeep` after every draw | the keeper service (`keeper/keeper.ts`) | covered; the rehearsal runs the real service |
| creator claims, relists, closes, unlists | the creator through the app | covered for the paths clicked on the fork |
| `collectProceeds` before upkeep (split check) | `performUpkeep` collects first anyway | equivalent |

After D16 every regime runs with only players, the randomness service, keepers and the creator acting. Moving the
other 19 regimes off harness processing changed their facts by at most 2 upkeeps and 0.00045 ETH of keeper pay; it
also exposed that the split check booked draws after upkeep had already collected their proceeds (a harness pairing
error: profit booked was identical before and after), now booked at every collection.

## Decisions for the owner

| # | Decision | Options and measured costs | Recommendation and why |
| --- | --- | --- | --- |
| D16 | Who processes FWA's queue (S1) | **a) Keeper only (off-chain):** the keeper calls `pool.processAcquisitions` when the queue's head is ready or past its deadline. No contract change. Unpaid: about 320k gas per draw processed (0.00018 ETH at 0.55 gwei, 0.0016 at 5 gwei), borne by whoever runs our keeper; other keepers have no reason to do it. **b) `performUpkeep` processes, paid:** before reconciling, upkeep calls `pool.processAcquisitions(2)` in a try/catch when the head is ready or expired, so any keeper is paid for it under the usual reward. Contract change, a focused re-audit and a new review record; 2 per call keeps the worst upkeep near 2.83M gas, under the 3.2M cap (step B's hardest mix measured 2.19M). **c) Both** | **b.** It keeps the system self-sustaining (R6): any paid keeper unblocks a pool, not only ours, and the pay rule already covers it. Add a regime where the harness never processes, and a keeper test |
| D17 | O10's scope (E1) | **a) Restate O10** as the launch board at steady normal gas, with spike recovery and creator choices (markup, NFT values) shown as information. **b) Bound it more widely:** not possible without repricing listed prizes, which the design never does | **a.** The promise holds where it was measured; the rest depends on gas history and the creator's own choices |
| D18 | The game's 10% (E2) | **a) As built:** the first 10% refills the reserve while the fund is short; above the reserve the creator may claim everything. **b) Keep the 10% in the pool always:** a contract change; idle ETH grows with sales | **a.** The 10% exists to refill the reserve; above it there is nothing to refill. O5's Add ETH / Continue covers the case where wins drain the fund |
| D19 | O1 after D16: keepers keep storage refunds from processing, 67,660 gas per draw with nobody else processing | **1) Restate O1 in gas:** at most 80,000 gas per draw. **2) Deduct an estimate in the contract:** saves up to 0.06 ETH per 180 draws at 5 gwei, underpays keepers when the refund is smaller | **Owner chose 1** (2026-11-13). 5 gwei measured: 0.181 ETH over 540 draws, 7.8% of the creator's net, information |

If D16 b is chosen, the batch for the next signature is: the repair, the no-processor regime, O10 restated (D17), and
"DRAFT" removed from the outcome text. One re-signature covers all of it.

## Independent re-attack of the D16 repair (`af1075c`)

Fresh-context agent, informed, 16 minutes, mainnet fork, `--isolate`; its tests were re-run here and turned into
requirement tests (`test/audit/d16/`), each failing on `af1075c` and passing after the repair.

| # | Finding | Basis | Repair |
| --- | --- | --- | --- |
| F1 | Worst upkeep passes the 3.2M pay cap: two processed draws that each reserved six listings (1.87M honest NFTs, 2.30M gas-hog collection) plus reconcile and restock, 3.41M to 4.16M billed; a keeper sending only covered calls skipped every pass, 5 draws unsettled, sales stopped (BUSY) | executed | a call that settles a draw skips restocking: worst 2.98M measured, keeper covered at 0.15, 0.55 and 5 gwei, stall test sells 20 of 20. Cost: split calls add 0.016 ETH of keeper pay per 180 draws at 0.55 gwei, 0.105 at 5 gwei, inside the restocking fees |
| F2 | Closed hold (one maximum reward per 5 draws) left the keeper 0.0054 ETH short at 5 gwei on expired reserved draws | executed | hold one maximum reward per 2 draws (0.049 ETH for 5); worst case, one draw per call, paid 0.0241 ETH in full |
| F3 | A chosen gas limit makes FWA revert processing on purpose; the creator paid 1.42M gas (0.0075 ETH at 5 gwei) for one reconcile | executed | gas of a reverted processing call is not paid for: 79,707 gas paid in the same case |
| F4 | Refunds kept per processed draw (107k to 191k gas) exceed the 80,000 per-draw average O1 states | executed, economic | wording, owner: O1 states the average over all draws and the worst single call (100,772 gas after the repairs) |
| — | Keeper gas limit could fall short when a draw becomes ready after the estimate | reasoned | the keeper's 4M gas floor is above the repaired worst (2.98M); comment updated |
| — | Upkeep pays to process expired draws, which bring no fee | reasoned | intended: their players' refund credit needs processing; the creator's cost |

## Things that don't make sense

- Every regime and both rehearsals processed FWA's queue themselves, so none of our evidence could show S1. The same
  shape of error as the zero-gas fork tests: the environment did a job reality does not.
