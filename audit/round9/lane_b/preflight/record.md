# Lane B capability preflight

Start time (UTC): 2026-11-13T11:30:34Z
Repo: /Users/dd/CascadeProjects/fwa-pool-balancer (branch fork-tests)

| Step | Command | Exit | Output / log |
|------|---------|------|--------------|
| forge version | `forge --version` | 0 | forge 1.8.1, commit 982849d. logs/forge-version.log |
| solc check | foundry.toml `solc = "0.8.28"`; build used "Solc 0.8.28" | 0 | confirmed 0.8.28, via_ir, optimizer 50 (packs 20), cancun |
| build | `FOUNDRY_OUT=audit/round9/lane_b/out FOUNDRY_CACHE_PATH=audit/round9/lane_b/cache forge build src/PoolBalancer.sol` | 0 | "Compiler run successful!" logs/build.log |
| sentinel local+fuzz | `FOUNDRY_TEST=audit/round9/preflight ... forge test --match-path audit/round9/preflight/Sentinel.t.sol --fuzz-runs 256` | 0 | 3 passed. logs/sentinel-local.log |
| sentinel fork | same with `SENTINEL_FORK=1` | 0 | 3 passed; fork read of block 26382349 + ENS code ok. logs/sentinel-fork.log |

Fork RPC (https://mainnet.gateway.tenderly.co) reachable WITHOUT sandbox-escape; DNS not blocked. No second (sandbox-disabled) run needed.

Lib commits (from build warnings): forge-std dc647cc, shape-packs 3a463f7, solady acd959a.

No excluded files read during preflight.
