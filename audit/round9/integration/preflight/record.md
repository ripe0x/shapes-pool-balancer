# Integration lane — capability preflight record

Start time (UTC): **2026-11-13T11:30:35Z** (first action).
Lane: audit/round9/integration/ — write only here. Ceiling: 2h active time.

| Step | Command | Exit | Output / log |
|------|---------|------|--------------|
| forge version | `forge --version` | 0 | forge 1.8.1 (982849d) — logs/forge-version.log |
| cast version | `cast --version` | 0 | cast 1.8.1 (982849d) — logs/cast-version.log |
| node version | `node --version` | 0 | v22.19.0 — logs/node-version.log |
| solc confirm | foundry.toml `solc = "0.8.28"`, via_ir, optimizer 50 (packs 20), cancun | — | matches build log "Solc 0.8.28" |
| build | `FOUNDRY_OUT=audit/round9/integration/out FOUNDRY_CACHE_PATH=audit/round9/integration/cache forge build src/PoolBalancer.sol` | 0 | "Compiler run successful!" 8 files, Solc 0.8.28 — logs/build-poolbalancer.log |
| sentinel local+fuzz | `FOUNDRY_TEST=audit/round9/preflight ... forge test --match-path audit/round9/preflight/Sentinel.t.sol --fuzz-runs 256` | 0 | 3 passed (fuzz 256) — logs/sentinel-local.log |
| sentinel fork | same with `SENTINEL_FORK=1` | 0 | 3 passed, fork read block 26382349 OK — logs/sentinel-fork.log |
| recent block | `cast block-number --rpc-url https://mainnet.gateway.tenderly.co` | 0 | **26405755** (recent block) — logs/recent-block.log |

- Sandbox DNS did NOT block the RPC; fork read succeeded on first run. No sandbox-disabled rerun needed.
- Lib commits in build warnings: forge-std dc647cc, shape-packs 3a463f7, solady acd959a.
- Pinned fork block: 26,382,349. Recent fork block for drift: 26,405,755.
- No target source read before this point.
