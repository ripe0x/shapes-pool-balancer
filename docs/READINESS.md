# Mainnet deployment readiness

**Not deployed. Mainnet deployment needs your explicit authorization.** This report does not establish that the contracts
are safe.

## Rewrite status (2026-11-11)

The contract was rewritten: simplified gate, markup applied at listing, `unlistShapes`, creator-only `recoverRefunded`,
keepers paid only from a restocking fee priced into prizes and a withdrawal-only reserve (SPEC.md, DECISIONS 43-56). **This rewrite is a verified
slice, not a frozen release candidate:** every fork test file passes when run one at a time, the invariants pass at 64
runs × 4,096 calls, and one independent AI review (round 7) is resolved. The verification under "Earlier verification" below ran
against the previous design (commit `3f1735f`); its suite results, gas numbers and rehearsals do not carry over to the
rewrite and must be re-run against it before release.

Open before release:

1. **Review of the round 7 repairs and the keeper-pay changes** (per-call limits, reserve fee, setup checks; keepers
   paid from `keeperCredit`, funded by the basefee-indexed restocking fees of the prizes each call lists), made after
   the independent review. The fee-at-draw version had one independent AI review; crediting at listing (DECISIONS 57)
   has not been independently reviewed.
2. **Re-run the fork suites, keeper e2e and both launch rehearsals** against the rewrite, then freeze a release
   candidate. The keeper e2e and rehearsals start their own anvil fork on port 18546 and need that port's approval.
3. **Gas finding resolved (DECISIONS 51-56):** outside creator-started work keepers are paid only from restocking fees
   players pay in prize prices, so keepers never touch the creator's markup; when gas rises after listing, restocking
   waits and purchases pause instead. Opening the pool (stocking it) is still paid from the creator's ETH. Players pay
   about 16% more per Balanced draw at 1 gwei; whether that changes demand is untested.
4. **Gas jump after listing: resolved (DECISIONS 57-58).** At `6fc2b9b` the 50-round rehearsal stalled at its 3 gwei
   step. With fees credited when the keeper lists a prize: keeper e2e passes (12 txs, 0 reverted, 0 skipped); the
   50-round rehearsal passed on its second run (48/48 buyers found the pool open; 3 and 4.9 gwei batches serviced;
   above 8 gwei the keeper waited 4/4 and resumed; 59 keeper txs, 0 reverted). Its first run had one reverted keeper
   transaction whose cause was not captured; the harness now prints reverted transactions. 300 rounds: 288/288 buyers
   found the pool open, 24 batches each at 3 and 4.9 gwei serviced, above 8 gwei the keeper waited 24/24 and resumed,
   keeper balance reconciled to the wei; **3 of 340 keeper transactions reverted** after ~1.9M gas each, and one mined
   call billed 291k gas more than its estimate. A second 300-round run at `8c8d0e9` passed with 0 reverted (288/288
   open; billed exceeded the estimate by up to 218k gas). Suspected, not confirmed: the bundled keeper's 30% gas-limit
   headroom is exceeded when work grows between estimate and inclusion; the keeper now logs the gas limit on every
   receipt.
5. **Real wallet extension test** of the dashboard writes (carried over; see "Checks that could not be executed").
6. **FWA pool-page server answer:** whether `pools.fwa.fun` accepts ERC-1271 from a contract owner (carried over).
6. **Draw Packs deploy values and audit status (DECISIONS 36):** the name "Pool Prize Packs", symbol "PRIZEPACK" and the
   presentation admin `PACKS_ADMIN` are your call; Draw Packs' own audit status as used in ape-Ball is not confirmed
   here.
7. **Your explicit deployment authorization** and the release-candidate checks below, re-run on the frozen rewrite.

## Earlier verification (previous design, commit `3f1735f`)

The checks in this section ran against the pre-rewrite design and are kept as a record of the verification method. They
must be re-run against the rewrite before release.

Commit `3f1735f`. Contracts, keeper service, planner and dashboard are identical to `13a61ed`, where the suites
ran; later commits change only the e2e and rehearsal harnesses, which were re-run at `b6ffee9` (e2e) and `3f1735f`
(rehearsals). Later commits change documentation, the audit record (`audit/`) and the dashboard only (30% gas-limit
margin; round-5 fixes S1–S3), re-checked with the app tests, typecheck, build and a fork browser check. Run with `CANDIDATE_RUN=1` on
2026-11-10, mainnet fork pinned at block 26,382,349 via `https://mainnet.gateway.tenderly.co`.

| Check | Command | Result |
| --- | --- | --- |
| Build and sizes | `forge build --sizes` | pass after the round 6 repair; 50 optimizer runs; PoolBalancer runtime 24,412 B (limit 24,576, margin 164), PoolPage 1,194 B, ShapePacks 17,768 B (its own 20-run via-IR build), BalancerFactory 1,207 B. Mainnet deploy: Etherscan verification must cover the `PoolPage` library (deployed by forge through the CREATE2 deployer and linked into PoolBalancer; confirmed on the 8545 fork) and the Draw Packs pair |
| Foundry suites (fork) | `forge test --no-match-path test/Gas.t.sol` | 78 passed, 0 failed (7 suites incl. `KeeperAdversarial` 9, hardening 22, behavior 32, scenario 11, parity 1, invariants at 64 runs × 64 calls) |
| Gas benchmarks and break-even, refund-checked | `forge test --match-path test/Gas.t.sol --isolate -vv` | 32 passed; every keeper path reimbursed ≤ billed gas; PnL table in GAS.md |
| Planner parity and keeper policy | `npx vitest run` | 25 passed |
| Typecheck | `npm run typecheck` | pass (also at `3f1735f`) |
| Dashboard build | `npm run build:app` | pass |
| Keeper integration (2 real FWA pools on a fork) | `npm run keeper:e2e` | pass at `b6ffee9` (failed at `13a61ed`: stale refunded-Shape step, see below): fill, direct FWA draws incl. a 5-draw batch, receipt audit on 8 keeper txs, restart, replacement, reorg, downtime, spike wait, purchaser gate, pool-page ERC-1271, per-pool error isolation |
| Economic simulation | `npm run sim -- --runs 60` | completed; `docs/simulation-results.md` unchanged (deterministic) |
| Launch rehearsal, short | `npm run rehearsal -- --rounds 50` | **pass** at `3f1735f` (also at `13a61ed`): 48/48 arrivals found the pool open; 4 batches each at 3 gwei and 4.9 gwei serviced; above 8 gwei the keeper waited 4/4 and resumed unaided; 2 purchase-caused and 2 creator-caused plan switches; 2 keeper restarts; 57 keeper txs, 0 reverted, 0 skipped as unprofitable; reopen median 58 ms, max 1.5 s |
| Launch rehearsal, sustained | `npm run rehearsal -- --rounds 300` | **pass** at `3f1735f`, 15 min: 288/288 arrivals found the pool open; 832 draws; 24 batches each at 3 gwei and 4.9 gwei serviced; above 8 gwei the keeper waited 24/24 and resumed unaided; 12 purchase-caused and 12 creator-caused plan switches; 7 creator edits (2 at 4.9 gwei, where the unpaid re-checkpoint is beyond the keeper allowance, run by the creator); 3 curated restocks; 2 keeper restarts; 324 keeper txs, 0 reverted; reopen median 64 ms, max 1.2 s; estimate − billed 7k–295k gas (median 75.5k) |
| Keeper ETH reconciliation | inside both rehearsals | exact to the wei: Δbalance = Σ`KeeperPaid` − Σ(receipt gas × effective price) + other value (300 rounds: 0.375721938518941543 − 0.215830965555422905 = 0.159890972963518638 ETH over 317 reward events and 324 receipts; 50 rounds: 0.067842415288632562 − 0.039510238693974763 = 0.028332176594657799 ETH; no other transfers) |
| Deploy rehearsal | `forge script script/Deploy.s.sol` on a chain-id 31337 fork | pass (inside keeper e2e and both rehearsals) |
| Independent review of the final financial logic | clean-context AI reviewer at `0a48e84` | no extraction found; 1 Low/Info fixed (`31edef6`), 2 Info accepted; SECURITY.md round 4 |

No mainnet contracts were deployed and no mainnet transactions were sent. The dashboard was built, not re-exercised
in a browser this round (its code is unchanged; only planner constants changed, covered by parity tests).

Failures found during this verification, and what changed:
- First short rehearsal (`0a48e84`): the purchase-caused plan switch was scheduled inside the 8 gwei window, where the
  keeper correctly waits. Driver fixed (`13a61ed`); rerun passed.
- Keeper e2e (`13a61ed`): the refunded-Shape step bought a draw naming the Shapes contract as purchaser, which the
  purchaser gate now refuses. Step replaced by a gate assertion (`b6ffee9`); passed. The keeper's refund-watch path
  has no end-to-end exercise any more.
- Sustained rehearsal: anvil did not start within the driver's 10 s wait (wait raised to 60 s, `b6ffee9`); rounds
  took ~18 s because viem polled receipts every 4 s (direct receipt fetch, ~3 s, `5b36729`); then three driver gaps,
  each fixed in `3f1735f`: the creator never restocked curated NFTs, so a pool correctly closed for `NO_CURATED`;
  `listCurated` sent with an exact gas estimate reverted at 63/64 of its limit (driver now adds 30%); failed driver
  transactions now report decoded reasons. No contract or keeper-service change.

## Requirement status (previous design: reimbursement re-evaluated against FWA V2)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Priority allowance from first principles (0.05–1 gwei, fee schedule) | done: kept 0.05 gwei | GAS.md "Priority allowance" (90-day inclusion data); simulation policy table |
| Reimbursement and bonus together; operation-aware; separate ETH cap | done: 4/5 gas + (1/5 gas + 0.0005 ETH); no ETH cap (bounded by gas × price caps) | GAS.md "Keeper reward", "Reimbursement model comparison" |
| Real receipts with refunds | done | isolated gas suite (32), e2e receipt audit, rehearsal receipts |
| Batching protections preserved | done; strengthened (gas-only 4/5, no per-call intrinsic) | `test_gas_multiCallPlanSwitchInOneTx`, `test_profitAtCap_multiCallBound`, SECURITY V-1, V-4 |
| Adversarial competition: bids at/above cap, max reimbursement, self-dealing, multi-call, refund-heavy, spikes | done | `test/KeeperAdversarial.t.sol` (9), spike tests; all self-dealing net negative (−0.0011 to −0.069 ETH) |
| Liveness and capital per policy (executed %, reopen time, max economical gas, 30-day spend, exposure, reserve, creator net) | done | `docs/simulation-results.md` policy table; GAS.md PnL table; rehearsals |
| Reserve reduction without weakening obligations; exact boundary; repeated maintenance | done | `test_exactRequiredReserveOpens*`, `test_claimSurplusRespectsReserveWhileOpen`, `test_repeatedMaxClaimWorstBatchesAtCap` |
| Launch rehearsal: fresh keeper, wei reconciliation, pinned basefee, short + sustained | done (see Candidate) | `keeper/rehearsal.ts` |
| Independent review of final financial logic | done | SECURITY.md round 4 |

## Requirement status (previous design: simplification and hardening pass)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Remove `needsUpkeep`; keeper simulates `performUpkeep` | done | `performUpkeep` returns the reward; keeper classifies `NoUpkeepNeeded`/`PoolBusy`, surfaces other reverts; e2e |
| Remove on-chain `maxShapeCapital`; keep it in the planner; show ETH committed | done | `Config` has three fields; dashboard "Total ETH committed" |
| Keep up to four fallback plans with first-feasible selection | done | `test_switchesToFallbackPlanWhenInfeasible`, `test_planBeyondListingLimitIsInfeasible` |
| Remove spare Shapes; redeem surplus; simplify reserve | done | `test_planShrinkRedeemsAndRegrowthPaysMintFees` (re-growth pays 6 mint fees), invariant `noShapesHeldBetweenCalls` |
| Untracked NFT recovery that cannot release protected assets | done | `test_recoverUntrackedNFTs`, `test_cannotRecoverProtectedAssets`, reviewer tests |
| No pending-delivery accumulation; bounded loops | done | `test_historicalRefundsDoNotGrowUpkeepGas` (200 refunds: 847k → 836k) |
| Configurable markup with bounded, resumable repricing | done | `test_interruptedRepricingAtListingLimit` (100 listings, 17 steps, out-of-gas call and removals mid-run) |
| ApeBall-safe reimbursement: priority cap 0.05 gwei, max gas price, refund-safe gas | done | `test_priorityOverbidIsNotReimbursed`, isolated gas suite, e2e receipt audit, multi-call test |
| Incentive not farmable, not paid for no-ops | done | `test_drawCausedWorkEarnsAtMostEdgePaid`, `test_creatorTopUpWhileOpenKeepsCredit`, reviewer PnL tests (all negative) |
| Keeper profitability policy, waits in spikes, never exceeds reimbursable gas | done | `keeper/keeper.test.ts`, e2e spike step |
| Rebenchmark 8 operations; justify caps | done | `docs/GAS.md` |
| Dashboard economics: Funded / Projected sustainable / Projected loss, 10 figures, markup warning | done | `app/src/App.tsx` Economics panel |
| FWA pool metadata investigation and narrow ERC-1271 | done (server unverified) | client template reconstructed; viem `verifyMessage` on fork; epochs and revocation |
| Simulation: previous vs simplified | done | `docs/simulation-results.md`: redemption costs 0.02–0.11 ETH/30 days in re-mint fees under frequent plan switching, same uptime |

## Checks that could not be executed

- **FWA's pool-page server.** Whether `pools.fwa.fun` verifies ERC-1271 for a contract owner, and its freshness policy,
  cannot be tested without a mainnet pool and a live POST. The dashboard submits only on chain 1.
- **Real Chainlink VRF fulfillment.** Randomness is delivered through the real FWA VRF service by impersonating its
  coordinator.
- **Mainnet Etherscan verification.** `--verify` runs only on a real deployment.
- **External professional audit and formal verification.** None performed.
- **Long invariant campaigns.** 64 runs × 64 calls per suite.
- **Real wallet extension.** Every dashboard write (creator calls, pool creation, upkeep) is simulated, then sent
  with a gas limit of its estimate + 30% (`app/src/tx.ts`, after the rehearsal saw an exact `listCurated` estimate
  revert at inclusion). Checked with the dev connector on a fork (upkeep, a creator edit, pool creation: limit =
  estimate × 1.3, applied once; a failing claim reported by name with nothing sent), not with a wallet extension, which
  may replace the supplied limit.

## Remaining risks

See `docs/SECURITY.md`. In short: the rewrite had one AI review (round 7); the gate is approximate and leans on FWA
pricing and slippage refunds; FWA and Shapes admin powers; restricted-collection griefing (G-1); collections that can
move or freeze listed NFTs (F1, F2); FWA's VRF service refusing purchases while status shows 0 (F4); keepers wait above a
5 gwei basefee (~0.9% of blocks) and when gas has risen since prizes were listed; refund-only and curated-only
reconciliation is unpaid once credit is spent and relies on the creator, the keeper allowance or later prize draws; the
creator still pays the opening stock-up gas and the mint fees of prizes listed at close, and prize luck can put short
runs below zero; the restocking fee raises the draw price, most on mixes of small prizes; the FWA page template could change;
no professional audit.

## Your actions to deploy

These follow the rewrite being reviewed and re-verified (see "Rewrite status").

1. Review and merge [PR #1](https://github.com/ripe0x/shapes-pool-balancer/pull/1).
2. Decide whether to commission an external professional audit first. An independent AI audit (round 5,
   `audit/report.md`) found no outsider path to take funds; it is not a professional audit.
3. Optional: ask FWA to confirm ERC-1271 support for pool pages, or to allow a creator editor address.
4. Create or choose a deployer keystore (no keys on the command line) and fund it for about 5.3M gas.
5. Deploy and verify (the script re-checks the FWA implementation and code hash and aborts if FWA changed):

   ```bash
   PACKS_ADMIN=<address> forge script script/Deploy.s.sol --rpc-url https://mainnet.gateway.tenderly.co --account <keystore-name> --broadcast --verify
   ```

   `ETHERSCAN_API_KEY` must be set in the environment for `--verify`. The script writes `deployments/1.json`.
6. Start the keeper with a funded keeper key from your secret store (`docs/OPERATIONS.md`), `FROM_BLOCK` = deployment
   block, and `MAX_LOSS_WEI` (default 0.0002 ETH) for reconcile-only calls.
7. Build the dashboard with `VITE_CHAIN_ID=1`, `VITE_FACTORY=<factory>`, `VITE_FROM_BLOCK=<block>` and host it.
8. Create a first pool with a small deposit and a conservative markup, and watch one full draw-and-upkeep cycle.
