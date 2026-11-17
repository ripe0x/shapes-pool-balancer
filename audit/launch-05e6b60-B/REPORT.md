# Launch audit step B (uninformed, not blind), candidate 05e6b60

Saved by the coordinating session from the auditor's returned report (the auditor could not write this file itself).
Source hash d4a80a3f0d150bdc00d78e19c70a656a33f8f873f8e2c87c593f20ee35ba6f16. About 23 minutes of a 90-minute cap, no
continuation. 17 attack tests: `AttackB.t.sol.txt`, output `AttackB.out`. No SOURCE_HASH written.

## Findings

S1, medium, liveness, executed (re-run by the coordinator: passes, 5 draws still unsettled 10,000 blocks later).
A draw whose request reserved a staged restock never settles unless someone calls FWA `processAcquisitions`: FWA's
randomness callback skips its fast path for such a request (`_tryProcessCallbackHead`), a Ready draw never expires,
and the shipped keeper and app only call `performUpkeep` (only `keeper/rehearsal.ts` and `keeper/e2e.ts` call
`processAcquisitions`, as does the flow harness). Sequence per round: buyer A buys; keeper upkeep stages a restock;
buyer B buys and reserves the staged batch; randomness delivered for both; nobody processes. After 4 rounds: 5
unsettled, status BUSY, sales stop, winners unpaid, no ETH lost. Smallest fix: the keeper calls
`pool.processAcquisitions(5)` when the head draw is Ready or past its deadline, or `performUpkeep` calls it in a
try/catch before reconciling so the work is paid; add a regime in which the harness never processes.

E1, medium, executed. O10 (player pays at most 1.5x expected backing at normal gas) holds only for the launch board at
a steady 0.1 gwei: 1.679x after 60 draws restocked at 4.95 gwei then back at 0.1 gwei; 1.532x after 30 draws at
2 gwei; 2.271x at the maximum allowed markup (100%); 2.068x with 20 curated NFTs valued at 50 ETH each. Cause: a
prize's price, including the restocking fee at the listing block's base fee, is fixed until that prize is won.

E2, low, question, executed. R7's 90/10 split applies only while the fund is below the required reserve; above it
everything is claimable, including the game's first 10%. A creator claiming the maximum after every draw ended with a
0.207 ETH fund against a 0.534 ETH reserve.

E3, information. A keeper admin who restricts upkeep and approves nobody lets 10 draws sell before LOW_INVENTORY;
the creator's own upkeep reopens sales.

Rejected after execution: forcing a failed Shape delivery by gas limit; farming the reconcile reward with refunded
draws; upkeep gas at the hardest mix (2,194,322 of 3.2M); compromised creator closing with 5 draws in flight; Shapes
mint fee raised to its cap mid-play; deploying without the gate.

## Things that don't make sense
1. Signed outcome text still says DRAFT.
2. Nothing in the system owns calling `processAcquisitions`; the harness does it silently.
3. O10 is a property of one configuration but reads as a promise to players.
4. The deploy gate accepts any SOURCE_HASH beside a REPORT.md; a hand-set environment variable defeats Deploy.s.sol.
5. No test checks the randomness fee formula against a live read.
6. Fork regimes run at base fee 0.5 gwei; the fork block's real base fee was 0.058 gwei, today's 0.155 gwei.
7. A keeper that loses a race pays gas for a reverted call; not modelled.

## Not examined
App transaction flows, keeper beyond its decision rule, sim, planner, ShapePacks beyond authorization, deployed
bytecode of Shapes, O9 drift, keepers racing, fuzz or invariant campaigns, rehearsal and canary.
