# Round 8 integration post-seal validation

Target production revision: `2ac7a7e7b965d1798729068566c026128a4ba4b9`; fork block `26382349`; public upstream `https://mainnet.gateway.tenderly.co`. This separate post-seal check wrote only under `audit/round8/integration/validation/`. The sealed informed report stayed SHA-256 `1deb2bfb1343fc5520fa84168ec2141b4c817a5ad7fe6298ba11beb7b876befe`. No production or existing-test edits, protocol mocks, protocol balance/state fakes, secrets, or mainnet broadcasts were used.

## VRF service/router path

`RouterFork.t.sol` deploys the real Balancer/Factory/Draw Packs on a fork with live FWA, Shapes and BAYC #1. It asserts the live VRF service's `coordinator()` is `0xD7f86b4b8Cae7D942340FF628F82735b7a20893a`. A funded player EOA buys an FWA draw at `tx.gasprice = 1 gwei`; the live service emits `RequestFeesReceived` for **0.00234 ETH** and FWA emits `VrfServiceFeePaid` to that player. The only protocol-address impersonation is the permitted coordinator delivery: `vm.prank(COORDINATOR)` then `VRF_SERVICE.rawFulfillRandomWords(requestId, words)`. The trace shows service → FWA pool `rawFulfillRandomWords` → FWA `processAcquisitions`, real Shape delivery, and service `RandomnessDelivered`. The acquisition becomes status 2 and unsettled count falls from 1 to 0 before any manual processing call. A duplicate coordinator delivery is a service-level no-op: it emits one service log, no FWA log, and leaves status 2. After Balancer upkeep, a **second player-paid purchase succeeds** and unsettled count rises to 1. This proves the allowed word delivery can pass through the service's live request bookkeeping and leave the next purchase usable at the pinned block. It does not prove actual Chainlink automation, future fee settings, or a failed delivery/refund path.

The first attempt (`router_pinned.*`) failed because the test assumed Chainlink request IDs increase numerically; they are distinct hashes. The next attempt (`router_pinned_v2.*`) failed because the test assumed duplicate delivery reverts; the service actually handles it without reverting. `router_fee_pinned.*` and `router_fee_origin.*` passed the service route, but an inline `pool.inventoryVersion()` read consumed the Foundry `vm.prank`, so the test contract paid the purchase. The **final** `router_player_final.*` precomputes both versions before pranking and asserts the funded player's ETH falls on each purchase; its trace confirms the player as FWA's fee payer. Earlier attempts are not payer evidence.

## Creator-work gas cap and code-free keeper P&L

`cap_reward.ts` deploys the exact `Deploy.s.sol` path on a private Anvil fork and sends one initial upkeep for five 0.01 ETH Shapes from a **code-free external EOA** with a 30% limit above `eth_estimateGas`. Only this private `127.0.0.1` fork receives transactions. The first attempt (`cap_reward.*`) failed because its isolated `deployments/` output directory did not exist; the corrected runs passed. Event decoding filters receipt logs by the Balancer address and verifies the `KeeperPaid` recipient. Wallet balance change equals reward minus billed gas exactly.

| Inclusion case | Estimate | Billed gas | `KeeperPaid.gasUsed` | Reward | Gas cost | Keeper net |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Local basefee, effective price 0.079882303 gwei | 3,269,365 | 3,193,714 | 3,150,818 | 0.000751694598173854 ETH | 0.000255121229443342 ETH | **+0.000496573368730512 ETH** |
| 4.95 gwei basefee, 5 gwei effective price | 3,269,299 | 3,193,708 | 3,150,812 | 0.01625406 ETH | 0.01596854 ETH | **+0.00028552 ETH** |

Neither observed **measured** gas span reaches the contract's 3,200,000 cap. The incentive covers the 42,896–42,896 gas outside the measured span in these receipts, and the code-free keeper gains ETH even at the 5 gwei bid. Thus these cases do **not** refute the owner's “creator-started work paid in full” economic goal, interpreted as no keeper loss. They do not establish that all creator-work shapes/mixed-size paths fit the measured cap. The bundled bot's separate policy rejects each observed **estimate** over 3,200,000 before profitability (`keeper/keeper.ts:37-40`); changing `maxLossWei` cannot bypass that gate, as the sealed informed policy probe shows. This remains an opening liveness concern, even though a manually sent keeper call is profitable in these two cases.

## Exact commands and evidence

Every final command below exited **0**. Each run has its exact command, full output and status in matching `.command`, `.output`, `.status` files. The private fork used values-only local actors and was stopped after each run. No mainnet transaction was broadcast.

```sh
FOUNDRY_TEST=audit/round8/integration/validation forge test --match-path audit/round8/integration/validation/RouterFork.t.sol --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 --out audit/round8/integration/validation/out --cache-path audit/round8/integration/validation/cache -vvvv
node --import tsx audit/round8/integration/validation/cap_reward.ts
CAP_BASEFEE_WEI=4950000000 node --import tsx audit/round8/integration/validation/cap_reward.ts
```

Final run prefixes: `router_player_final`, `cap_reward_v2`, `cap_reward_highfee`. SHA-256: `RouterFork.t.sol` `82dee994c7d53b7f4f870253e834e125a196b4d13e2ca59af7041357941376d9`; router final output `769d434eeaabe4831c86208fcd2669c594d78a62be44d0d8f4ebde63b9cab982`; `cap_reward.ts` `c0ef39552577ed03af4bc9736096e7a69eaee5e44daadb1107a156fcfb90e266`; local-fee output `7ef0c14c72f88d44fb44f9ff850cf163c75a421bebe8d3ee68a5a5a9365128a3`; high-fee output `620f12dda443999e8afc70a8811edafb212c3d1da93d1d496fb4d779db944c6a`.

The original lane clock began at 2026-11-12 15:39:50 UTC; validation ended 2026-11-12 17:08:15 UTC, **1 hour 28 minutes 25 seconds** total elapsed, below the 2 auditor-hour ceiling. These results establish only the stated fork paths and price cases, not general safety or release readiness.
