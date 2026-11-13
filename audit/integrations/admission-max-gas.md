# Maximum-inventory purchase-hook gas boundary

## Scope and result

At Ethereum mainnet block **26,382,349**, a fresh Balancer/FWA pool with **100 active listings** (60 curated MockNFTs and a fully filled plan of 40 denomination-0 Shapes) reached `admissionStatus() == 0`. A real one-draw `FWA StandardPool.acquireBatch` purchase succeeded through FWA's fixed **100,000-gas** purchase-operator `staticcall`; `lastIssuedSequence` advanced to 1. The observed direct `canPurchase(buyer)` staticcall needed **47,475 gas requested** in this Foundry test context. A 100,000-gas request succeeded. This is a bounded fork observation, not a claim that all purchase transactions or future chain states admit.

## Reproduction and exact domain

The only new probe is [`AdmissionMaxGas.t.sol`](AdmissionMaxGas.t.sol). It uses `test/utils/ForkBase.sol`, a fresh Balancer clone and FWA pool, `vm.txGasPrice(1 gwei)`, `vm.fee(0.5 gwei)`, a 20 ETH creator deposit, 60 batch-listed curated MockNFTs each with 0.01 ETH base, one 40 × 0.01 ETH Shapes plan, 15% markup, 1 ETH acquisition-fee ceiling and zero curated-odds floor. The test verifies both Balancer and FWA report 100 active listings, and Balancer reports 40 active denomination-0 Shapes. Creator configuration precedes the curated listings; configuring after the 60 listings leaves the Balancer in status 10 (`REPRICING`) after the `ForkBase.fillUp()` helper's initial upkeep, so that setup was discarded.

Command and final result:

```sh
FOUNDRY_TEST=audit/integrations forge test --match-path audit/integrations/AdmissionMaxGas.t.sol --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv
```

Exit **0** on the final run: 1 test passed, 0 failed; test gas **56,691,129**. This is the whole test frame, including setup and instrumented searches, not the gas cost of one purchase. The test creates local state only and broadcasts no transaction.

| Probe | Observation |
| --- | ---: |
| `canPurchase` direct staticcall, 100,000 gas requested | Returned canonical `true` |
| Binary-searched minimum direct staticcall gas requested, after `vm.cool` on discovered read accounts/slots | 47,475 |
| Same search without a `vm.cool` pass | 47,475 |
| Total direct call gas reported with `vm.cool` pass / immediately repeated | 47,338 / 47,211 |
| Forwarder receives 90,000 gas and requests 100,000 for `canPurchase` | Succeeds; 89,604 gas before the inner request |
| Minimum outer gas request to the synthetic forwarder for a successful inner hook and response | 51,236; 50,840 gas before inner request |
| Real `acquireBatch` with 1 draw and the 100,000-gas FWA operator call | Succeeds; one request issued |

The forwarder's 100,000-gas inner request cannot receive 100,000 when only 50,840 gas remains before the call. The EIP-150 63/64 ceiling is at most **50,045 gas** even before call overhead; the successful result shows the hook still returns under this constrained call path. The probe does not expose the exact gas forwarded by EVM or the exact FWA frame gas at its operator call. Its synthetic forwarder omits FWA's other purchase-path work, so **51,236 is not a transaction gas limit for `acquireBatch`**.

`vm.record` observed 7 Balancer, 5 FWA-pool and 1 Shapes read slots in the hook path. The `vm.cool` pass is an instrumented reset within one test transaction; the total call readings differed by only 127 gas and the binary-search thresholds matched. These measurements should not be presented as a stand-alone cold-transaction worst case. The full FWA purchase was likewise run in the same instrumented test transaction after inventory setup and hook probes. It proves the actual FWA operator callback and VRF request succeeded under that state, but not that a separately submitted purchase will have the same access warmth or gas at the hook.

## Mechanism and remaining limit

`PoolBalancer.canPurchase` checks the purchaser against three forbidden addresses and calls `admissionStatus()` (`src/PoolBalancer.sol` 538–566). The latter reads the checkpoint, current FWA sequence/inventory/version/fees and Shapes mint fee; it does not iterate over the 100 active IDs. The plan/listing loops occur during upkeep/checkpoint creation. The inspected [FWA StandardPool source](https://eth.blockscout.com/address/0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7?tab=contract), inherited `src/poolsV2/StandardPool.sol` 1321–1346, makes the operator `staticcall` with a fixed 100,000 gas and requires a canonical ABI `true`. Source is Blockscout partially verified; the implementation runtime hash was matched separately in `assessment.md`.

The measured margin addresses the **inventory-count** concern for this specific valid maximum configuration and an ordinary one-draw purchase. The 56.7-million-gas test frame composes setup calls that would be separate transactions on chain; it is not itself a deployable transaction. This probe does not cover a different Shapes fee implementation, a changed FWA implementation/factory, every possible EIP-150 parent-gas condition, or a new chain state. FWA VRF funding can separately reject an otherwise admitted batch as described in `vrf-boundary.md`.
