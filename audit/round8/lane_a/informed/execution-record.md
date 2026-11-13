# Round 8 Lane A informed execution record

Target `2ac7a7e7b965d1798729068566c026128a4ba4b9`; read-only Tenderly fork block 26,382,349; Solc 0.8.28, via IR, optimizer 50, Cancun. All commands ran from `/Users/dd/CascadeProjects/fwa-pool-balancer` on 2026-11-12. `set -o pipefail` preserved Forge exit status through `tee`. The initial hostile test was sandboxed and failed DNS; subsequent fork invocations used approved read-only RPC network escalation. No test broadcast a transaction. The code changed only within `audit/round8/lane_a/informed/` between attempts; earlier outputs remain attached to the code state that produced them.

## Exact successful commands

```sh
set -o pipefail; FOUNDRY_TEST=audit/round8/lane_a/informed FOUNDRY_OUT=audit/round8/lane_a/informed/out FOUNDRY_CACHE_PATH=audit/round8/lane_a/informed/cache forge test --match-path audit/round8/lane_a/informed/BalancedBurst.t.sol --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vvv 2>&1 | tee audit/round8/lane_a/informed/balanced-burst.log
```

Exit 0, 1/1. Output SHA-256 `231a5a4965d8b0f059447df4f3104e7972212ba132b74d7ab516a2492304cc69`.

```sh
set -o pipefail; FOUNDRY_TEST=audit/round8/lane_a/informed FOUNDRY_OUT=audit/round8/lane_a/informed/out FOUNDRY_CACHE_PATH=audit/round8/lane_a/informed/cache forge test --match-path audit/round8/lane_a/informed/HostileCurated.t.sol --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv 2>&1 | tee audit/round8/lane_a/informed/hostile-curated-final.log
```

Exit 0, 3/3 at that test revision. Output SHA-256 `0eda2447435f39d471933325e3bcc7c974750054e60dc2ee2a14dbd815ee154e`.

```sh
set -o pipefail; FOUNDRY_TEST=audit/round8/lane_a/informed FOUNDRY_OUT=audit/round8/lane_a/informed/out FOUNDRY_CACHE_PATH=audit/round8/lane_a/informed/cache forge test --match-path audit/round8/lane_a/informed/HostileCurated.t.sol --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv 2>&1 | tee audit/round8/lane_a/informed/hostile-curated-final4.log
```

Exit 0, 4/4 after adding F1. Output SHA-256 `ff36d86d49f3d1804ba183d44d2be5d9c171f711232acd0e2e8842286f054b0f`.

```sh
set -o pipefail; FOUNDRY_TEST=audit/round8/lane_a/informed FOUNDRY_OUT=audit/round8/lane_a/informed/out FOUNDRY_CACHE_PATH=audit/round8/lane_a/informed/cache forge test --match-path audit/round8/lane_a/informed/BalancedBurst.t.sol --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv 2>&1 | tee audit/round8/lane_a/informed/balanced-burst-f5.log
```

Exit 0, 2/2 after adding F5. Output SHA-256 `7f8a10238d27dc754752fe76c59e54700c3dacb00c3854903ae7a28c3e8e8e24`.

```sh
set -o pipefail; FOUNDRY_TEST=audit/round8/lane_a/informed FOUNDRY_OUT=audit/round8/lane_a/informed/out FOUNDRY_CACHE_PATH=audit/round8/lane_a/informed/cache forge test --match-path audit/round8/lane_a/informed/HostileCurated.t.sol --match-test testExpiredLocalBatchLeavesRouterCoverageRejection --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv 2>&1 | tee audit/round8/lane_a/informed/vrf-expiry-attempt1.log
```

Exit 0, 1/1. Output SHA-256 `a5a7fa1e67d9b81edc4b5c5b59fb66fe0e71a21f8b4e3e94f41a903b47d094fd`.

```sh
set -o pipefail; FOUNDRY_TEST=audit/round8/lane_a/informed FOUNDRY_OUT=audit/round8/lane_a/informed/out FOUNDRY_CACHE_PATH=audit/round8/lane_a/informed/cache forge test --match-path audit/round8/lane_a/informed/BalancedBurst.t.sol --match-test testTargetShrinkLeavesOldPrizesPurchasableUntilUnlisted --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv 2>&1 | tee audit/round8/lane_a/informed/target-shrink.log
```

Exit 0, 1/1. Output SHA-256 `e58d0179fc5d12a3197fbc38d619747e7993e9bd74fbe6b0123f9c09add06371`.

## Failed/corrected commands

For the five retained failed hostile runs, the exact command was the line below with its indicated verbosity and output path substituted. All other bytes and environment assignments were identical. This is a command template, not a new run:

```sh
set -o pipefail; FOUNDRY_TEST=audit/round8/lane_a/informed FOUNDRY_OUT=audit/round8/lane_a/informed/out FOUNDRY_CACHE_PATH=audit/round8/lane_a/informed/cache forge test --match-path audit/round8/lane_a/informed/HostileCurated.t.sol --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 VERBOSITY 2>&1 | tee OUTPUT_PATH
```

| Output path | Verbosity | Exit | Failure observed | SHA-256 |
| --- | --- | --- | --- | --- |
| `hostile-curated-attempt1.log` | `-vvv` | 1 | Sandbox DNS blocked public RPC; compilation succeeded. | `9d7ce3cb26b035c469bd00d0b1943e7b73b1dce65d4ff777bb23742ba8e6f366` |
| `hostile-curated-attempt2.log` | `-vvv` | 1 | Test-only ERC721 approval had wrong caller. | `73c444b64cbab89ecf58146c6fdf2b6936a58944244e804bb6cf2709f24f4fb4` |
| `hostile-curated-attempt3.log` | `-vvv` | 1 | Buyer contract without ERC721 receiver callback did receive token: actual FWA uses `transferFrom`. F2/F3 passed. | `474255873506d5d9a9337e06b426037e7bdc9bd18efc90f37b912f5a0c83da0e` |
| `hostile-curated-attempt4.log` | `-vv` | 1 | Hostile collection rejected delivery, but test expected acquisition status 3 instead of actual 7. F2/F3 passed. | `e2a618a33de24042d50c0fe87ab02885950920358d17450aa0e02d59f0c88902` |
| `hostile-curated-attempt5.log` | `-vv` | 1 | Refund assertions passed; recovery destination was a test contract without ERC721 receiver. F2/F3 passed. | `b5432b1d2e795fc3c6afb34e3179ab7a606dceb4821026e5286a49684c4dbdcc` |

Final source SHA-256: `BalancedBurst.t.sol` `f059cc969c44da9ea1f470a94d6277f328d90d76da94a6e1f5bef714d178758c`; `HostileCurated.t.sol` `88868fd6658896c4f66ae8440309203f91f9da782f1b5644b5712308142471bc`. The saved final source contains the later added tests, so it is not a byte-for-byte identity for early passing/failing revisions. The logs show the executed test names/results; no source snapshot was kept for each intermediate revision. This limits independent reconstruction of intermediate failures but not the final successful run at the listed final source hashes (the later added F4/Q tests do not modify earlier test bodies).
