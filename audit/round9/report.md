# Shapes Pool Balancer: round 9 adversarial audit

**No high or medium severity finding was confirmed. One low economic finding breaks the owner's M9 rule. This is
scoped evidence, not a safety proof or a release decision.** Frozen source: `fork-tests` commit
`c686534669562e78fd33f7297c13f12e68fe3066` (production source identical to `7b32497`, and to `9fd5f83`).

## Erratum (2026-11-13, after the report): gas context of the audit harnesses

The independent audit found that Foundry runs test transactions at gas price 0, and at basefee 0 inside calls,
unless a test sets them. Checked for this round (`controller/probe/`): the repository's fork tests, the release-
candidate runs and `docs/fork-economics.md` use `ForkBase`, which sets basefee 0.5 gwei and gas price 1 gwei for every
call (now guarded by `test/ForkContext.t.sol`). Lane B's economic and keeper tests and the integration lane's
full-cycle and VRF tests set their own fees. **These audit harnesses did not, and ran at gas price 0 and basefee 0
inside calls:** lane A (including the addendum), the challenger's tests, the focused tests and the controller tests.
Effect: their restocking fees, keeper rewards and VRF fees are the zero-gas values (for example the refund test's
VRF fee of 0, already disclosed). Their logic results (M9 levers and their direction, refunds, retirement, mint-fee
gate, reentrancy, closeout to zero) do not depend on gas and stand; their ETH amounts are at zero gas, so the R9-E1
per-event sizes are approximate. R9-E1 is fixed (DECISIONS 69), so the sizes were not re-measured.

## Status

| Dimension | Result |
| --- | --- |
| Examination | Scheduled examination completed within the stated limits: the acceptance checkpoint, structural gate and agent evidence review are recorded; every known open item has a continue/stop decision below. Says nothing about undiscovered properties |
| Execution capability | All three discovery lanes passed their own compile, local, 256-run fuzz and fork preflights before reading source (`*/preflight/record.md`) |
| Findings | 1 economic finding (Low, M9); 1 carried round 8 finding still open (E3, simulation); informational items; no security finding confirmed |
| Structural gate | **Passed** (exit 0, run 3) for `gate/audit-gate.json`: 57 entrypoints (18 compiler getters), 67 external calls, 40 High/Medium Slither IDs mapped; 7 critical paths (P3 violation, six held); every postcondition independently reviewed. Runs 1 and 2 failed honestly and are kept (`gate/gate-run1.*`, `gate/gate-run2.*`). Structural only |
| Evidence control | Advisory: hashes and raw logs on a shared writable filesystem |
| Discovery separation | Prompt-level only (no runtime boundary). Three fresh agents, sealed before any informed work; each later continued blind with route or plumbing corrections only, recorded as post-seal addenda |
| Blindness | Procedural; no excluded-file access reported by any lane; training exposure unknown |
| Calibration | Uncalibrated |
| Review | Independent agent evidence challenge (two passes) and manifest review; **no human review** |

## Scope

Primary: `src/PoolBalancer.sol`, `src/BalancerFactory.sol`, `src/PoolPage.sol`, `src/interfaces/External.sol`,
`script/Deploy.s.sol`; Draw Packs where minted, held, listed and redeemed; FWA factory/implementation (codehash
verified), FWA VRF service and Chainlink coordinator, Shapes, ENS on mainnet forks at block 26,382,349 and recent
blocks 26,405,755 to 26,405,845. Second priority: `keeper/keeper.ts`, `shared/planner.ts`, `shared/design.ts`,
`app/src/App.tsx`, `app/src/tx.ts`. Rules tested: the owner's M1 to M9 and product goal (`docs/AUDIT-PROMPT.md` §2).
Adversaries: creator, players, keepers, outsiders, hostile NFT collections and receivers, creator contracts. FWA and
Shapes are trusted systems with admin powers. Undeployed target: source-to-runtime match not applicable. No mainnet
transaction, deployment or production-code change.

VRF route: every outcome claim below that depends on fulfilment was delivered as the real Chainlink coordinator
(`0xD7f8…893a`) calling FWA's VRF service (`0x7D93…d65d`) `rawFulfillRandomWords`, the only accepted exception to the
no-mocks rule. Two lanes first used a shortcut (calling the pool as the service); their affected results were re-run
on the real route.

## Economic findings

### R9-E1. The profit split uses the listing set at collection, not the set the draw was priced on (Low; breaks M9)

**Rule broken:** M9, "No creator action (... listing or withdrawing NFTs ... timing of collection ...) may move fund
money into profit."

**Mechanism.** `_collect` (`src/PoolBalancer.sol:830-842`) books `amount × profitShareSum / n` as profit while the fund
(balance − profit) is below `requiredReserve()`. FWA charges every draw the same expected-value price, so this is the
correct expected markup above 10% only when `n` and `profitShareSum` describe the listings the draw was priced on.
Two paths change the set first:
1. **Creator, `withdrawCurated` before collection** (no `_collect` first). A curated listing has share 0, so removing
   `k` of `n` raises the booked share by `n / (n − k)`.
2. **Automatic, `performUpkeep`** reconciles draws (removing the won listing from the set, `:597-601`) before
   `_collect` (`:604`). On an NFT draw the share rises by `n / (n − 1)`; on a Shape draw it can fall.

**Evidence (all real fork, real coordinator route, exit 0):**
- Creator path: same proceeds book 0.001985 ETH honestly and 0.002383 ETH after one NFT withdrawal (×6/5)
  (`lane_a/FullCycle.t.sol`, reproduced by the challenger, `challenge/runs/run1`, `run2`). Worst case on a contrived
  board (100% markup, 10 Shapes, 10 NFTs): honest collection books 0, withdrawing all NFTs then collecting books
  0.017384 ETH and the fund falls from 0.085 to 0.0677 ETH (`lane_a/addendum/M9Scale.t.sol`, `challenge/runs/run7`).
- Automatic path: after a 0.5 ETH win (balance 0.064 vs reserve 0.534), an NFT draw books 0.002188 ETH on the draw-time
  set and 0.002553 ETH through upkeep (×7/6); claimable rises by 0.000365 ETH with no creator action
  (`controller/UpkeepOrder.t.sol` `upkeep-order-short.log`; asserted in `challenge/UpkeepOrderAsserted.t.sol`).
- Launch scale (Balanced mix, 15% markup, one 0.3 ETH NFT, n 41, genuine shortfall): creator path +0.0000198 ETH per
  event at a cost of 293,280 gas (about 0.00147 ETH) to withdraw and relist; automatic path per event: NFT draw
  +0.0000198, 0.01 Shape +0.00000007, 0.5 Shape −0.0000020 ETH; expected value over FWA's draw weights −59 gwei per
  draw (fund-favourable) (`focused/record.md` item 1).

**Not levers** (tested): `unlistShapes` (challenger's general argument: admission needs a curated listing, whose zero
share keeps the average below every Shape's share, so removing a Shape never raises it; heterogeneous board tested,
`challenge/runs/run3`), `listCurated`, `configure` (markup change books 0, lane B and `challenge/runs/run5`), creator
transfer, collection timing (changes when, not the lifetime total).

**Impact at launch scale:** negligible ETH; the creator path costs more gas than it gains. It is a rule violation and
grows with many NFTs at high markup. **Severity: Low** (lane A proposed Medium; narrowed on the launch-scale sizes).

**Suggested fix (suggestion only):** call `_collect()` before reconciling in `performUpkeep` and at the start of
`withdrawCurated`, `unlistShapes` and `listCurated*`. Residual: a keeper restock that lists while a draw is pending
still adds listings the pending draw was not priced on; exact attribution would need the split recorded per draw.

### R8-E3 (carried). The simulation still fixes the VRF fee (Medium, decision support; still applies)

`sim/flows.ts:15` fixes `VRF = 0.0003 ETH`; FWA charges 2,340,000 gas × gas price (0.00234 ETH at 1 gwei, measured on
the real pool, `integration/FwaVrfTiming.t.sol`). Projections from `sim/flows.ts` understate player cost. The fork
economics matrix (`docs/fork-economics.md`) and `sim/fund.ts` do not use this constant.

### Informational and requirement challenges

- **R9-I1. Thin keeper margin on single-Shape restocks at low basefee** (lane B L1): the reward is capped by the
  restocking fee credit; keepers stay positive in tested cases (+0.000340 ETH at 1 gwei, integration full cycle).
- **R9-I2. Reserve keeper term sized at the 5 gwei cap** (lane B C3): idle capital while open; owner-accepted.
- **R9-I3. M9 wording.** "The fund keeps ... all NFT sale money" is implemented as an expected-value rule (curated
  listings carry share 0 in each draw's split), not outcome attribution; above the reserve, NFT draw money is
  withdrawable surplus. Suggest rewording M9 to say so.

## Security and liveness findings

No security violation was confirmed. Informational:
- **R9-S1. FWA configuration dependency** (integration F1): if FWA changes `maxAcquisitionsPerTx` from 5 or
  `maxStagedListings` from 0, `createBalancer` reverts `UnsupportedFWAConfig` for new pools (fail-closed).
- **R9-S2. A restock invalidates a player's pending draw quote** (integration F2, confirmed): each FWA listing bumps
  `inventoryVersion`; a draw pinned to the old version reverts (player loses gas only). Frequency depends on FWA's
  frontend; untested.
- **R9-S3. FWA's VRF fee is 0 at gas price 0** (integration F3): a purchase simulated at gas price 0 under-funds and
  reverts at inclusion. No caller in this repository simulates at 0 (dashboard and keeper set fees).
- **R9-S4. Unguarded creator functions run re-entrantly from the keeper reward** (focused item 5): a creator contract
  running upkeep receives the reward with a 100k stipend and can call `transferCreator`, `close`, `configure`;
  guarded functions revert; profit ≤ balance held. No authority gain (the caller is the creator).
- **R9-T1. Three repository tests mock a protocol contract** (`test/Packs.t.sol`, `test/Gas.t.sol`,
  `test/Balancer.t.sol`, `vm.mockCallRevert` on Shapes/Draw Packs `transferFrom` from the pool). FWA delivers Shapes and
  packs with plain `transferFrom` (lane A), so the mocked failure is unreachable on the real path: the tests exercise
  defensive code, and that branch has no real test. Suggest deleting or relabelling them.

## Property map

| Property | Attempts | Evidence | Result and bounds |
| --- | --- | --- | --- |
| M1 markup never pays keepers | overbid 100 gwei priority, inflated gas limit, 1/3/4.9 gwei, 5 cycles, bursts | lane B `Keeper.t.sol`, `AddendumGas.t.sol`; lane A; focused item 4 | Held: non-creator keeper pay equals restocking fees credited, to the wei, ≤ 4.9 gwei, 16 to 40 draws |
| M2 restocking fee priced and repaid | full cycle at 1 gwei | integration `FullCycle.t.sol` | Held for the cycles run; fee 900k gas covers the measured ~804k one-draw upkeep |
| M3 mint fees | open/close round trip; mint fee raised to 0.002 | lane B `Econ.t.sol`; focused item 2 | Held: deposit returned exactly; gate pauses and resumes |
| M4 prize backing | Shape and pack unlist and redeem | lane A `PackLifecycle.t.sol`, `FullCycle.t.sol` | Held: exact 0.02 ETH pack; Shapes exact |
| M5 creator exposure | launch mixes, fork matrix | lane B `AddendumScale.t.sol`; `docs/fork-economics.md` | Held in runs: losses only at the 10% minimum with big wins (−0.51 ETH worst, ape-ball volume) |
| M6 reserve | open without reserve, big win, refill | lane A, lane B `AddendumBelowReserve.t.sol` | Held: open needs the reserve; claims stay at 0 while short with no profit |
| M7 nothing stranded | full closeouts, retire, refund path | lane A, lane B, focused items 3 and 6, controller refund test | Held: Balancer ends at 0 ETH, no listings |
| M8 fill gate | bursts | lane A `StatefulCycle.t.sol`; focused item 4 | Held: purchases paused at 3 unsettled draws on lane B's board and refused the 6th on the focused board, by board weight |
| M9 game first | every creator action, timing, automatic order | see R9-E1 | **Violated** (Low): `withdrawCurated` before collection; upkeep order |
| Authority (creator, keeper admin two-step, factory, clones, locked implementation, ERC-1271 epochs) | handovers, outside clones, reinit, replay | lane A `SecurityIntegration.t.sol`; lane B `Security.t.sol` | Held for the tested calls |
| Reentrancy | hostile collection; reward callback | lane A `KeeperReentrancy.t.sol`; focused item 5 | Held: guarded paths revert; unguarded ones are creator-only (R9-S4) |
| Failed delivery and refunds | hostile curated collection, below and above reserve | `focused/CuratedRefundLedger.t.sol`; `controller/CuratedRefundWithdraw.t.sol` | Held: Balancer books nothing; the player withdraws exactly the acquisition fee (0.630139 ETH); NFT recovered. Bound: run at gas price 0, so the VRF fee was 0; the VRF fee is not refunded (round 8), so the player is not made whole |
| Integration drift | 12 live parameters at two blocks | integration `FwaVrfTiming.t.sol` | No drift |

### ApeBall misses (§5)

| Item | Result |
| --- | --- |
| 1 keeper paid at bid | Does not apply up to the 5 gwei cap: reward price capped at basefee + 0.05 gwei; overbidding gains nothing (lane B, ≤ 4.9 gwei); above the cap keepers wait |
| 2 gas measured before refunds | Bounded: reward capped by restocking credit (M1 held to the wei); measured-vs-billed gap not separately quantified this round |
| 3 config drift | Does not apply: no drift across source, deploy script, planner, keeper, dashboard and live values (integration) |
| 4 money in the wrong bucket with draws in flight | Applies in small form: R9-E1; invariants held with 1 and 5 draws in flight |
| 5 mocks hiding behaviour | Applies to tests: R9-T1 (unreachable branch, not a hidden real path) |
| 6 fees at gas price 0 | Does not apply to repository callers (R9-S3) |
| 7 out of gas between estimate and inclusion | Bounded: heaviest burst upkeep 2,526,724 gas vs 4,000,000 floor; same-block growth not re-measured |
| 8 price or inventory moving under a draw | Applies (R9-S2), refund-free revert; frequency untested |
| 9 event consumers | Reading only: dashboard replay treats on-chain state as authoritative (integration) |
| 10 fork-block drift | Does not apply: recent-block runs matched |

Project misses after rounds 7 and 8: keepers paid from markup (held, M1); listing-time fee vs later gas (held: rewards
capped, keepers wait above 5 gwei); one-draw fee calibration (held: ~804k measured vs 900k priced); NFT odds drift
(held, M8); restricted keeper list liveness (held: the creator can always run upkeep, lane A); funding check pausing
pools (removed; lane B 100% liveness); profit stalls during refill (fork matrix: 0 dry draws above 10% markup);
curated padding of the split (fixed for listing; withdrawal is R9-E1).

## Round 8 findings

From `informed-retests.md`: **fixed** E2, E4 (reading), E5 (on close), E6, E7, E8 (within the measured bound), S4,
curated padding on listing; **accepted** E1 (owner), S1, S2, S3, S5 (curated-collection trust); **still applies** E3.

## Economic tables

Fork economics on the current source (`docs/fork-economics.md`, controller-authored, informed; same production
source): ape-ball's volume (184 draws over 30 days) and 40 draws a day; every run sold every draw, closed out to 0 ETH,
realized = estimate to the wei.

| Scenario | Creator result after NFTs, mean (min to max) | Draws with nothing to claim | Top prize off board |
| --- | --- | --- | --- |
| ape-ball, 10%, 12 small | 0.21 (−0.51 to 0.92) | 67% | 2.4% |
| ape-ball, 25%, 12 small | 0.91 (0.77 to 1.15) | 0% | 0% |
| ape-ball, 50%, 12 small | 1.29 (0.50 to 1.64) | 0% | 0.1% |
| 40 a day, 25%, 12 small | 5.15 (4.63 to 6.11) | 0% | 4.0% |

Lane B single runs on the packet's launch mixes (15% markup): Balanced +0.4147, 0.01-only +0.2680, bigger-prize
+1.1105 ETH, 100% liveness, nothing stranded. Simulation comparison: `sim/fund.ts` top-prize-off-board 3.4% median at
40 a day vs 4.0% fork mean (consistent); `sim/flows.ts` was not re-compared this round (E3 open).

## Not tested

- Measured-vs-billed gas gap for the largest upkeep, and same-block estimate growth beyond one draw.
- Player-facing revert rate from restocks under real FWA frontend timing.
- The keeper process under reorgs, RPC failures and restarts (read only); the dashboard and planner were read, and
  executed only through the release-candidate unit tests.
- Lane B's own below-reserve file could not be re-run by the challenger (hardcoded root `out/` artifact); its claim was
  reproduced on lane A's harness.
- Hostile Shapes or FWA admins beyond the mint-fee change; Solady assembly alerts (not re-reviewed).
- Property completeness is unknown.

## Open items: continue or stop

| Item | Decision | Reason and next action |
| --- | --- | --- |
| Measured-vs-billed keeper gas gap | Stop (cannot change a consequential conclusion) | M1 holds to the wei because rewards are capped by restocking credit; the gap moves only keeper margin. Next: measure on the heaviest upkeep if keeper margins matter |
| Restock-vs-pending-draw revert rate | Blocked | Needs FWA's frontend quoting behaviour (out of scope). Players lose gas only |
| Keeper process under reorgs, RPC failures, restarts | Stop (second priority, owner decision) | Read only this round; the 300-round rehearsal on `7b32497` passed with 0 reverts. Next: a fault-injection rehearsal if wanted |
| Lane B's own below-reserve file re-run | Blocked | Needs a write to the root `out/` (sandbox denied); the claim was reproduced on lane A's harness |
| `sim/flows.ts` comparison (E3) | Stop (known open finding) | Fix the VRF fee formula first, then compare |
| Hostile FWA or Shapes admins beyond the mint fee | Out of scope | Trusted systems per the owner's scope |

## Process record

- Budget: 12 auditor-hours authorized. Used about 5h10m (lanes A 38 min, B 40 min, integration 21 min,
  challenger 39 min (three passes), manifest 25 min, focused 30 min, controller about 1h55m); wall clock 11:28 to
  13:15 UTC. Measured from agent records and controller clock, not a meter.
- Isolation: prompt-level; evidence integrity advisory; calibration uncalibrated; human review none.
- Full process detail: `run-record.md`. Slither: `slither-triage.md`. Retests: `informed-retests.md`. Challenge:
  `challenge/`. Manifest and gate: `gate/`.
