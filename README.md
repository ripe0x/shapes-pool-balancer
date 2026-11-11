# Shapes Pool Balancer

Creator-operated [FWA](https://pools.fwa.fun) community pools that use ETH-backed
[Shapes](https://shapes.ripe.wtf) as automatically replenished inventory.

A creator deploys a `PoolBalancer`, which creates and permanently owns an FWA standard pool. The creator lists curated
NFTs and approves a Shapes plan; players buy on FWA's own site with ETH; a permissionless keeper restores Shapes after
draws from the Balancer's ETH and settled proceeds. Surplus above the funded reserve belongs to the creator.

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
forge build && npm run abi
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

Keeper integration (starts its own anvil fork on port 18546, deploys, runs two real FWA pools):

```bash
npm run keeper:e2e
```

Economic simulation (writes docs/simulation-results.md):

```bash
npm run sim -- --runs 60
```

## Local fork rehearsal and dashboard

The dev fork uses anvil's standard port, 8545. If a mainnet fork with `--chain-id 31337` already runs there, deploy onto
it; otherwise start one:

```bash
anvil --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 --chain-id 31337 --port 8545
```

```bash
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --broadcast
```

```bash
FACTORY=$(jq -r .balancerFactory deployments/31337.json) forge script script/DevSetup.s.sol --tc DevSetup --rpc-url http://127.0.0.1:8545 --unlocked --sender 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 --broadcast
```

Copy `app/.env.example` to `app/.env.local`, set `VITE_FACTORY` and, for the fork only, `VITE_DEV_ACCOUNT` (an unlocked
anvil account), then:

```bash
npm run dev
```

## Keeper

```bash
FACTORY=<factory> FROM_BLOCK=<block> KEEPER_PRIVATE_KEY=<from your secret store> MAX_LOSS_WEI=100000000000000 npm run keeper
```

See [docs/OPERATIONS.md](docs/OPERATIONS.md). The pool keeps working for existing players if the keeper stops; anyone can
call `performUpkeep()`.
