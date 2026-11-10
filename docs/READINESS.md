# Mainnet deployment readiness

**Not deployed. Mainnet deployment needs your explicit authorization.** This report covers the frozen candidate named
below; it does not establish that the contracts are safe.

## Candidate

Commit `7fcdbe4` (contracts, keeper, planner, dashboard, simulation). Later commits change documentation only. Run once
with `CANDIDATE_RUN=1` on 2026-11-10, mainnet fork pinned at block 26,382,349 via `https://mainnet.gateway.tenderly.co`.

| Check | Command | Result |
| --- | --- | --- |
| Build and sizes | `forge build --sizes` | pass; PoolBalancer runtime 23,680 B (limit 24,576, margin 896), BalancerFactory 1,212 B |
| Foundry suites (fork) | `forge test --no-match-path test/Gas.t.sol` | 61 passed, 0 failed (6 suites: scenario 11, behavior 31, hardening 15, parity 1, invariants 2 suites at 64 runs × 64 calls) |
| Gas benchmarks, refund-checked | `forge test --match-path test/Gas.t.sol --isolate -vv` | 13 passed; every keeper path reimbursed ≤ billed gas |
| Planner parity and keeper policy | `npx vitest run` | 21 passed (5 exact-parity cases vs on-chain FWA) |
| Typecheck | `npm run typecheck` | pass |
| Dashboard build | `npm run build:app` | pass |
| Keeper integration (2 real FWA pools on a fork) | `npm run keeper:e2e` | pass: fill, direct FWA ETH draws incl. a 5-draw batch, receipt audit (reimbursed ≤ billed on all keeper txs), restart, replacement, reorg, downtime, basefee spike wait, refunded-Shape recovery, pool-page ERC-1271 verification, per-pool error isolation |
| Economic simulation | `npm run sim -- --runs 60` | completed; `docs/simulation-results.md` unchanged (deterministic) |
| Deploy rehearsal | `forge script script/Deploy.s.sol` on a chain-id 31337 fork | pass (inside keeper e2e) |
| Dashboard in a browser | dev server against a chain-id 31337 fork | fill, reprice, decoded errors, pool-page approval, stray-NFT error, 375 px width; re-checked against the candidate contracts (fill to open, Economics panel, reserve 0.3662 ETH incl. the re-checkpoint reward) |
| Independent review | two clean-context AI reviewers + three repair re-review rounds | 1 Medium and 6 Low/Info fixed; 5 Info/Low accepted; see SECURITY.md |

No mainnet contracts were deployed and no mainnet transactions were sent.

## Requirement status (simplification and hardening pass)

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
- **Real wallet extension.** The dashboard was exercised with a dev connector.
- **External professional audit and formal verification.** None performed.
- **Long invariant campaigns.** 64 runs × 64 calls per suite.

## Remaining risks

See `docs/SECURITY.md`. In short: FWA and Shapes admin powers; purchaser-naming griefing at roughly the attacker's own
cost (L-1, I-1, I-2); keepers wait above a 2 gwei basefee and skip fill steps above ~0.76 gwei (creators can run them);
pools with very cheap curated NFTs give keepers little incentive for purchase-caused work; economics (losses at low
markup, small denominations, high mint fee); the FWA page template could change; no professional audit.

## Your actions to deploy

1. Review and merge [PR #1](https://github.com/ripe0x/shapes-pool-balancer/pull/1).
2. Decide whether to commission an external audit first.
3. Optional: ask FWA to confirm ERC-1271 support for pool pages, or to allow a creator editor address.
4. Create or choose a deployer keystore (no keys on the command line) and fund it for about 5.3M gas.
5. Deploy and verify (the script re-checks the FWA implementation and code hash and aborts if FWA changed):

   ```bash
   forge script script/Deploy.s.sol --rpc-url https://mainnet.gateway.tenderly.co --account <keystore-name> --broadcast --verify
   ```

   `ETHERSCAN_API_KEY` must be set in the environment for `--verify`. The script writes `deployments/1.json`.
6. Start the keeper with a funded keeper key from your secret store (`docs/OPERATIONS.md`), `FROM_BLOCK` = deployment
   block, and a `MAX_LOSS_WEI` allowance if it should also run unpaid re-checkpoints.
7. Build the dashboard with `VITE_CHAIN_ID=1`, `VITE_FACTORY=<factory>`, `VITE_FROM_BLOCK=<block>` and host it.
8. Create a first pool with a small deposit and a conservative markup, and watch one full draw-and-upkeep cycle.
