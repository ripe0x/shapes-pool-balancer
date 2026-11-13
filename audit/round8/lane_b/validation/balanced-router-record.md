# Balanced real-router fork witness

Target: frozen `2ac7a7e7b965d1798729068566c026128a4ba4b9`, mainnet block `26382349`, `src/PoolBalancer.sol` unchanged. Test source: `BalancedRouter.t.sol`, SHA-256 `8e25e140c26680ee6ae71ec49674a0f9e6439e9b0fad1e12be8eb5e5b0c9f75f`.

Command (working directory repository root):

```sh
FOUNDRY_TEST=audit/round8/lane_b/validation FOUNDRY_OUT=audit/round8/lane_b/validation/out FOUNDRY_CACHE_PATH=audit/round8/lane_b/validation/cache forge test --match-path audit/round8/lane_b/validation/BalancedRouter.t.sol --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv
```

First sandbox execution: exit `1` after successful compilation because sandbox DNS could not resolve Tenderly. `balanced-router.log`, SHA-256 `a9ebb9339f7115104c7e8bedd784c193af9a146f806eb0364a953847e2e6ba7d`.

Approved read-only Tenderly RPC execution: exit `0`, one test passed. `balanced-router-escalated.log`, SHA-256 `5f27d09ad7af1b337256134805dcbd8a6d7b14b4053ab8f34c7ca6853ed6bf49`.

Fresh Balanced fork pool, code-free PLAYER payer, pre-read inventory version, and exact payer balance delta. Two FWA purchases were delivered through actual coordinator `0xD7f86b4b8Cae7D942340FF628F82735b7a20893a` → service `0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d` → FWA pool. Search found a 0.5 ETH Shape at word trial 1144 and a 0.1 ETH Shape at trial 206. Post-upkeep Balancer balance was `0.474750884357087310` ETH versus `1.035` ETH required reserve; 0.1 target was restored, 0.5 target remained missing, admission status was `0`. A third actual FWA purchase succeeded after the two router deliveries and upkeep. This upgrades the earlier direct-pool callback E-B1 liveness witness; word search demonstrates an attainable outcome, not attacker control over VRF randomness.
