# Round 8 Lane A public-seizure continuation via actual VRF service

Informed validation on frozen target `2ac7a7e7b965d1798729068566c026128a4ba4b9`, Tenderly mainnet fork block **26,382,349**, Solidity 0.8.28 via IR/optimizer 50/Cancun. The new test adapts the prior public-seizure continuation without editing its sealed source. It imports the earlier hostile ERC721 counterparty definition. The collection's `seize` function represents a public hostile-collection power; the test calls it as code-free outsider `0xBAD`. Player `0xB0B`, keeper `0xBEEF`, and closeout recipient `0xCAFE` are also asserted code-free at the pinned block. Actor funding is setup only. No protocol mock, prank, deal or state override is used except **actual coordinator** `0xD7f86b4b8Cae7D942340FF628F82735b7a20893a` delivering words to deployed real FWA VRF service `0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d`, which calls the real pool. The test asserts the service's coordinator address.

## Exact focused command

From repository root, zsh:

```sh
set -o pipefail; FOUNDRY_TEST=audit/round8/lane_a/validation/ghost_router FOUNDRY_OUT=audit/round8/lane_a/validation/ghost_router/out FOUNDRY_CACHE_PATH=audit/round8/lane_a/validation/ghost_router/cache forge test --match-path audit/round8/lane_a/validation/ghost_router/GhostRouterContinuation.t.sol --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv 2>&1 | tee audit/round8/lane_a/validation/ghost_router/coordinator-attempt2.log; exit ${pipestatus[1]}
```

Final exit **0**: **1 passed, 0 failed, 0 skipped**. New test source SHA-256 `c1cb796e67aedc1281f6aa1866d1e36617a92c845295a3aa3de4ae1f7c70bba5`; final output `coordinator-attempt2.log` SHA-256 `814485935ef66d5915c7b68664550341f2a6a1531a278811498b5554581658ff`. The first coordinator-route run before adding an exact recipient-balance assertion also exited 0, 1/1; `coordinator-attempt1.log` SHA-256 `9d1c814b851598c576a91b87aa181a2217dc915b8e9cc18e99da6393454069ac`. It used the identical command with `coordinator-attempt1.log` as the `tee` destination. Only this one test file was selected each run. No cache deletion, whole suite or live broadcast.

## Assertions and ledger

Creator funds its local Balancer with **2 ETH**, lists hostile curated ERC721 #1 for **0.1 ETH**, opens, and a real keeper performs Shape upkeep. Balancer admission is 0. A public outsider calls the hostile collection's `seize` to take #1 from FWA. Its `ownerOf` becomes the thief while FWA active-listing count and Balancer admission remain unchanged. A code-free EOA player pays the real FWA quote: acquisition fee **22,742,431,673,280,128 wei** plus VRF fee **2,457,000,000,000,000 wei**, total **25,199,431,673,280,128 wei**; the test precomputes inventory version before `vm.prank(PLAYER)` and asserts exact payer balance decrease.

Permitted coordinator-word delivery selects the ghost listing (one test candidate trial). FWA acquisition status **7** and listing status **6** establish failed delivery; owner proceeds are zero. The keeper reconciles the issued sequence. After seven days the same player calls real `refundFailedDelivery(ghostId)` and `withdrawAcquisitionRefund()`: listing status becomes **7**, player balance is exactly pre-purchase minus the **2,457,000,000,000,000 wei VRF fee**. Gas paid by the actor is absent from Foundry balance arithmetic. The creator's `recoverRefunded(ghostId, 0xCAFE)` reverts; the thief remains ERC721 owner.

The creator can still close, unlist its one remaining Shape and receive exactly **0.01 ETH** backing into Balancer, then claim **1,997,651,968,550,000,000 wei** liquid to code-free recipient `0xCAFE`. The test asserts recipient balance rises by that exact claim and Balancer ends with zero ETH. This is a partial creator exit despite unrecoverable curated NFT custody, not a whole-pool liquid lock. The public seizure and random selection are reachable test paths; the outsider cannot force coordinator word selection under the demonstrated model. The NFT's market value and transaction gas are not quantified, and the proof is conditional on this hostile collection exposing public seizure.

Work was completed about **17:11–17:14 UTC**, approximately three minutes. Cumulative Lane A substantive effort remains well below its three-hour ceiling; earlier sealed evidence stays unchanged. The earlier direct FWA-service-sender callback is diagnostic only, and this actual coordinator route is the accepted PoC for this continuation.
