# Mainnet deployment readiness

**Not deployed. Mainnet deployment needs your explicit authorization.** This report covers the frozen candidate named
below; it does not establish that the contracts are safe.

## Candidate

CANDIDATE_RESULTS

## Requirement status

| Requirement | Status | Evidence |
| --- | --- | --- |
| One Balancer per FWA pool; Balancer owns the pool permanently | done | fork: `test_ownershipAndOperator`, `test_factory_isolatedBalancersAndPools` |
| FWA standard pools only, reviewed implementation pinned | done | `initialize` checks code hash and passes the expected implementation to `createPool`; deploy script preflight |
| ETH purchases only; token purchases impossible | done | fork: `test_tokenPurchasesImpossible`; no executor, no delegatecall beyond the fixed clone |
| No custom player interface | done | players use pools.fwa.fun; dashboard is creator-only |
| Curated NFTs: list, batch, reprice, withdraw, recover | done | fork tests incl. failed delivery and refund recovery |
| Automatic Shapes replenishment | done | fork: single draw, 5-draw batch, mixed denominations, keeper e2e on two pools |
| Configurable price ceiling, odds floor, capital limit, markup | done | `configure`; fork tests for each gate and fallback plans |
| Dynamic Shapes mint fee | done | fork: real `setMintFee` by the Shapes admin |
| Permissionless upkeep with bounded keeper compensation | done | fork: gas-price manipulation, redundant calls, reverting keeper |
| On-chain admission protection (one batch, assume 5) | done | fork scenario and invariant suite |
| ENS reverse naming | done | fork: reverse and forward resolution |
| No central custody authority | done | factory ownerless; creator-only asset functions |
| Surplus to the creator | done | `claimSurplus` with reserve floor |
| Fixed inventory planner with infeasibility display | done | `shared/planner.ts`, fork parity test, dashboard |
| Keeper service: discovery, reorgs, replacement, restart, health, isolation | done | `npm run keeper:e2e` |
| Creator dashboard | done | exercised in a browser against a fork (fill, plan switch, listing, errors, mobile width) |
| Economic simulation | done | `docs/simulation-results.md` |
| Security review | done (internal, AI agents) | `docs/SECURITY.md` |
| Deployment and verification scripts | done | `script/Deploy.s.sol` rehearsed on a chain-id 31337 fork |

## Checks that could not be executed

- **Real Chainlink VRF fulfillment.** Fork tests deliver randomness through the real FWA VRF service by impersonating its
  Chainlink coordinator. Real oracle timing and billing were not exercised.
- **FWA's website with a Balancer-owned pool.** Not testable without deploying. FWA's "Edit page" (pool name, images)
  needs an owner-wallet signature; the Balancer cannot sign, so the pool page may show without custom metadata unless
  FWA supports contract owners. Purchases do not depend on it.
- **Mainnet Etherscan verification.** `--verify` runs only on a real deployment.
- **Real wallet extension.** Dashboard was exercised with a dev connector that signs via an unlocked anvil account.
- **External professional audit.** None performed. Recommended before holding significant value.
- **Long invariant campaigns.** Runs were short (see candidate).

## Remaining risks

See `docs/SECURITY.md` residual risks: FWA and Shapes admin powers, economics (losses at low markup, small
denominations, high gas or high mint fee), curated delivery escrow when a buyer never refunds, creator-chosen hostile
collections, no professional audit.

Economic guidance from the simulation (30-day, 40 draws/day baseline): 15% markup on a 0.01–0.1 ETH Shapes mix is
marginal (mean +0.71 ETH, p5 −0.97 ETH); 0.01-ETH-only Shapes, the 0.01 ETH mint-fee cap, and 6 gwei gas at 15% are
uneconomic; larger Shapes make gas negligible. Use the planner's projected minimum markup per configuration.

## Your actions to deploy

1. Review and merge [PR #1](https://github.com/ripe0x/shapes-pool-balancer/pull/1).
2. Decide whether to commission an external audit first.
3. Ask FWA whether pool-page metadata can be published for a contract-owned pool (optional).
4. Create or choose a deployer keystore (no keys on the command line), fund it for about 5.3M gas.
5. Deploy and verify (the script re-checks the FWA implementation and code hash and aborts if FWA changed):

   ```bash
   forge script script/Deploy.s.sol --rpc-url https://mainnet.gateway.tenderly.co --account <keystore-name> --broadcast --verify
   ```

   `ETHERSCAN_API_KEY` must be set in the environment for `--verify`. The script writes `deployments/1.json`.
6. Start the keeper with a funded keeper key from your secret store (`docs/OPERATIONS.md`), `FROM_BLOCK` = deployment
   block.
7. Build the dashboard with `VITE_CHAIN_ID=1`, `VITE_FACTORY=<factory>`, `VITE_FROM_BLOCK=<block>` and host it.
8. Create a first pool with a small deposit and a conservative markup, and watch one full draw-and-upkeep cycle.
