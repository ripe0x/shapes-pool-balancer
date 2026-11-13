# Factory and page ABI coverage addendum

Target production revision: `2ac7a7e7b965d1798729068566c026128a4ba4b9`. Inventory: compiler ABIs `audit/round8/abi-factory.json` (15 functions) and `audit/round8/abi-page.json` (one function). This classifies **this lane's executed real-fork evidence**, not tests merely present in `test/`. `Tested` is bounded to the stated calls and fork blocks; `source-only` means no lane-executed assertion; `unresolved` identifies the material integration variant left open.

Evidence keys: **F** = `audit/round8/integration/fork_pinned_v2.{command,status,output}` and `fork_recent_v2.{command,status,output}`, both exit 0 at Tenderly blocks 26382349 and 26399837; `IntegrationFork.t.sol:28-39` creates a Factory/Balancer with real FWA and forwards 1 ETH. **R** = `audit/round8/integration/informed/restricted_creator.{command,status,output}`, exit 0 at Tenderly block 26382349; `GasPriceFork.t.sol:54-63` restricts the real Factory, checks unapproved keeper rejection via `canKeep`, and proves creator upkeep still succeeds. **D** = `audit/round8/integration/informed/deploy_script.{command,status,output}`, exit 0 on a local fork of Tenderly block 26382349; exact `Deploy.s.sol:51-59` postflight reads implementation, keeper admin, and unrestricted default. **P** = `audit/round8/integration/validation/cap_reward_v2.{command,status,output}`, exit 0 on a local Tenderly fork; `cap_reward.ts` predicts and uses the created address, an indirect single-salt check. All exact commands and statuses are retained in the cited files. No external mainnet broadcast occurred.

| Callable ABI entry | Status | Exact bound and material untested variants |
|---|---|---|
| `acceptKeeperAdmin()` | Source-only | `BalancerFactory.sol:68-73`; no lane-executed transfer/accept. Pending-admin acceptance, old-admin revocation, zero-pending caller remain unresolved. |
| `allBalancers(uint256)` | Source-only | Getter from array at `BalancerFactory.sol:15,82`; F creates a Balancer but does not read indexed array. Ordering, out-of-bounds revert, and multiple creates unresolved. |
| `approvedKeeper(address)` | Source-only | Getter from mapping at `BalancerFactory.sol:21`; R reads only `canKeep`. True/false approval and revocation unresolved. |
| `balancerCount()` | Source-only | `BalancerFactory.sol:89-91`; F creates once but does not assert count. Multiple creates unresolved. |
| `canKeep(address)` | Tested (R) | Restricted and unapproved keeper, including Balancer's creator override. Open mode and approved keeper under restriction untested; `BalancerFactory.sol:44-48`. |
| `createBalancer(bytes32)` | Tested (F, P) | Real FWA pool creation and payable deposit on pinned/recent forks; one prediction/use in P; `BalancerFactory.sol:75-83`. Duplicate salt collision, multiple creators/salts, array/mapping consistency, and initialization failure rollback unresolved. |
| `implementation()` | Tested (D) | Postflight read equals newly deployed implementation, `Deploy.s.sol:51-59`; no invalid implementation constructor or mutable-code variant. |
| `isBalancer(address)` | Source-only | Getter at `BalancerFactory.sol:16,80`; F deploys but does not query mapping. False address and rollback state unresolved. |
| `keeperAdmin()` | Tested (D) | Postflight read equals configured admin; transfer/accept transition unresolved. |
| `keepersRestricted()` | Tested (D) | False default read. R changes setting to true but asserts via `canKeep`, not direct getter; true→false reopening unresolved. |
| `pendingKeeperAdmin()` | Source-only | Getter at `BalancerFactory.sol:18`; transition and reset after accept unresolved. |
| `predictBalancer(address,bytes32)` | Tested indirectly (P) | Single prediction used for local fork deployment interactions; no explicit predicted/created equality assertion. Cross-creator salt separation and repeated salt unresolved. |
| `setKeeperApproved(address,bool)` | Source-only | `BalancerFactory.sol:56-61`; no lane-executed approval or access-control variant. |
| `setKeepersRestricted(bool)` | Tested (R) | Admin sets `true`, and unapproved keeper loses eligibility while creator can work; `BalancerFactory.sol:50-54`. Setting `false` and unauthorized caller unresolved. |
| `transferKeeperAdmin(address)` | Source-only | `BalancerFactory.sol:63-66`; no lane-executed handover, overwrite, cancel, or unauthorized caller. |
| `PoolPage.digest(address,address,string,bytes32)` | Source-only | `PoolPage.sol:20-45` validates 24-character allowed alphabet and constructs a personal-sign hash. Existing `test/Hardening.t.sol` vectors were not run by this lane. Real FWA site acceptance, malformed-but-allowed timestamps, and live page publish remain unresolved. |

No broad negative claim follows from these calls. This addendum does not change the sealed discovery, informed, or validation reports.

Time accounting: addendum active work 17:38:59–17:39:27 UTC, **28 seconds (0.47 minutes)**. Cumulative lane wall-clock from 15:39:50 UTC: **1 hour 59 minutes 37 seconds**, below the two-hour ceiling. Addendum creation command exited 0; no new tests were run.
