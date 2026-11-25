# Shapes Pool Balancer

Creator-operated [FWA](https://pools.fwa.fun) community pools that use ETH-backed
[Shapes](https://shapes.ripe.wtf) as automatically replenished inventory.

A creator deploys a `PoolBalancer`, which creates and permanently owns an FWA standard pool. The creator lists curated
NFTs and sets a target mix of ETH-backed prizes (Shapes and Draw Packs); players buy on FWA's own site with ETH; a
permissionless keeper restocks prizes after draws from the Balancer's ETH and settled proceeds. New implementations use cost-first creator proceeds: deposits are capital, and actual game costs and reserve needs come before withdrawals. See [cost-first accounting](docs/COST-FIRST-PROCEEDS.md). Historical fixed-share clones retain their original accounting. Legacy credit remains
claimable during depletion; operating capital above the full reserve is separately withdrawable.

**Not deployed to mainnet.** See [docs/READINESS.md](docs/READINESS.md).

| Doc | Contents |
| --- | --- |
| [docs/SPEC.md](docs/SPEC.md) | Functional specification and design decisions |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Decisions made during the build that the owner should review |
| [docs/SECURITY.md](docs/SECURITY.md) | Security review report and residual risks |
| [docs/GAS.md](docs/GAS.md) | Gas benchmarks and keeper reward bounds |
| [docs/simulation-results.md](docs/simulation-results.md) | Economic simulation results |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Status codes, keeper operation, recovery procedures |
| [docs/READINESS.md](docs/READINESS.md) | Mainnet deployment readiness report |

Historical fixed-share evidence: [protected-revenue implementation evidence](docs/PROTECTED-REVENUE-RESULTS.md), [current reserve design](docs/RESERVES.md) and [before/after evidence](docs/reserve-redesign-results.md) for capital requirements, partial depletion, keeper economics and launch blockers. The [policy architecture](docs/KEEPER-POLICIES.md) remains replaceable through delayed creator adoption.

The [focused audit follow-up](docs/AUDIT-FOLLOWUP-RESULTS.md) covers current curated-presence proofs, generic transaction confirmation and pool-lifetime dashboard reporting. Curated proof loss can pause purchases until a permissionless refresh; concurrent draws and asset rights remain unchanged.

## Layout

```
src/            PoolBalancer, BalancerFactory, external interfaces (FWA, Shapes, ENS)
test/           Foundry tests on a mainnet fork (scenario, behavior/adversarial, invariants, gas, planner parity)
script/         Deploy.s.sol (mainnet and fork rehearsal), DevSetup.s.sol (local demo pools)
shared/         planner.ts (exact plan math), abi.ts (generated)
sim/            Monte Carlo economic simulation
keeper/         keeper service and its fork integration test
app/            creator dashboard (Vite + React + wagmi)
```

## Setup

Requires Foundry, Node 22, and network access to `https://mainnet.gateway.tenderly.co` (fork tests pin block
26,382,349; Foundry caches fetched state).

```bash
git clone --recurse-submodules https://github.com/ripe0x/shapes-pool-balancer && cd shapes-pool-balancer
```

```bash
npm install
```

```bash
forge build --sizes && npm run abi
```

## Tests

Contracts (mainnet fork):

```bash
forge test --match-path test/Fork.t.sol
```

```bash
forge test --match-path test/Balancer.t.sol
```

```bash
forge test --match-path test/Hardening.t.sol
```

```bash
forge test --match-path test/Invariant.t.sol
```

Gas benchmarks (isolated: each call is a real transaction, so EVM refunds are applied):

```bash
forge test --match-contract GasBench --isolate -vv
```

Planner parity and keeper policy (regenerate the fork fixture with `forge test --match-contract ParityFixture` first if
contracts change):

```bash
npx vitest run shared/planner.test.ts keeper/keeper.test.ts
```

Keeper integration (historical since R95: its policy section calls removed functions and fails there; starts its own
anvil fork on port 18546, deploys, runs two real FWA pools):

```bash
npm run keeper:e2e
```

Economic simulation (writes docs/simulation-results.md):

```bash
npm run sim -- --runs 60
```

## Local fork rehearsal and dashboard

The canonical owner-approved, hash-bound local rehearsal route is documented in
[docs/RELEASE-REHEARSAL.md](docs/RELEASE-REHEARSAL.md). Its old interrupted batch is historical; it must not be replayed
for new bytecode. Prepare/review candidate-specific local material before executing that guarded rehearsal. Production
always uses `script/deploy.sh` with the required exact-source review and outcome approval. Use
`https://mainnet.gateway.tenderly.co` for every Ethereum mainnet RPC command; no deployment is authorized here.

For the existing isolated keeper integration diagnostic, `npm run keeper:e2e` starts its own local fork and runs the
production deployment implementation under synthetic actors. It is not the sealed full production-path rehearsal.
Creation now requires predicted-address NFT approvals followed by one
`createBalancer(salt, {markupBps, creatorRevenueBps, target, mintFeeCap}, curated)` transaction with the reviewed funding.
`script/DevSetup.s.sol` uses that path. Initial stocking is bounded maintenance, not part of creation.

Copy `app/.env.example` to `app/.env.local`, set `VITE_FACTORY` and, for the fork only, `VITE_DEV_ACCOUNT` (an unlocked
anvil account), then:

```bash
npm run dev
```

## Keeper

```bash
FACTORY=<factory> FROM_BLOCK=<block> MAX_LOSS_WEI=100000000000000 npm run keeper
```

See [docs/OPERATIONS.md](docs/OPERATIONS.md). The pool keeps working for existing players if the keeper stops; anyone can
call `performUpkeep(settingsHash(), 0, 0)` when paid upkeep is available, or `performUpkeepUnpaid()` for recovery.
The keeper signing identity belongs in the existing secret store, never in a command literal or a new file.
