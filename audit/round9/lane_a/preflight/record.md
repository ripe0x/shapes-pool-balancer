# Lane A capability preflight

Start time (UTC): 2026-11-13T11:30:35Z

| Step | Command | Exit | Output / log |
|------|---------|------|--------------|
| forge version | `forge --version` | 0 | forge 1.8.1 (982849d). logs/forge-version.log |
| solc check | foundry.toml `solc = "0.8.28"`, via_ir, optimizer 50 (packs 20), cancun | 0 | solc 0.8.28 binary `/Users/dd/.svm/0.8.28/solc-0.8.28`, SHA-256 `81515b0e53deaa266d549545ccaac0a5a96e6d4e8201c77f673b2c710976d9ea` |
| build | `FOUNDRY_OUT=audit/round9/lane_a/out FOUNDRY_CACHE_PATH=audit/round9/lane_a/cache forge build src/PoolBalancer.sol` | 0 | Compiler run successful, Solc 0.8.28. logs/build.log |
| local+fuzz | `FOUNDRY_TEST=audit/round9/preflight ... forge test --match-path audit/round9/preflight/Sentinel.t.sol --fuzz-runs 256` | 0 | 3 passed. logs/sentinel-local.log |
| fork read | `SENTINEL_FORK=1 FOUNDRY_TEST=audit/round9/preflight ... forge test --match-path .../Sentinel.t.sol --fuzz-runs 256` | 0 | 3 passed, fork at block 26382349 via tenderly RPC; DNS not blocked, no sandbox escape needed. logs/sentinel-fork.log |

Sandbox DNS did NOT block the RPC; a single run sufficed for the fork step.

Lib commits (from build warnings): forge-std dc647cc, shape-packs 3a463f7, solady acd959a.
