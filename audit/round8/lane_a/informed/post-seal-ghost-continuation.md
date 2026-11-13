# Lane A post-seal informed F1 continuation

This addendum follows the immutable informed review `review.md` SHA-256 `3e84e9b9e0ef0a0430e7601f5a7ff9bfc37c59ab6cb5285adf2f135f2a93b2ba` and security surface map SHA-256 `fef283daa3872869823a9fb8fc282a2d5bcc6e777fe6429dc9594d78ad548fe2`. Neither earlier file or its cited test source was changed. New ownership is only `GhostContinuation.t.sol` and its output logs in this directory. Frozen production target remains `2ac7a7e7b965d1798729068566c026128a4ba4b9`.

## Exact fork path and ledger

At mainnet fork block 26,382,349, with 1 gwei basefee and 1.05 gwei bid, an actual locally deployed OpenZeppelin ERC721 counterparty owned its official Balancer clone. The creator listed NFT #1 at creator-declared base **0.1 ETH**, configured one 0.01 ETH Shape and opened/stocked. An unrelated EOA called the collection's public `seize(pool-owned #1, thief)`. `ownerOf` changed to the thief while FWA's active count and Balancer admission stayed unchanged; this is conditional on that hostile collection feature. The declared base is **not** a market-value measurement.

A funded EOA player paid **0.025199431673280128 ETH** to the real FWA pool, consisting of **0.022742431673280128 ETH acquisition fee** and **0.002457 ETH router/VRF fee**. The test precomputed FWA `inventoryVersion` before `vm.prank(PLAYER)` and asserted the EOA's balance fell by the full amount. One candidate coordinator-delivered word selected the ghost listing; this establishes reachability, not player control of mainnet VRF. FWA acquisition status was 7 and listing status 6 (delivery pending); the thief still owned the NFT and `pool.ownerProceeds()==0`. Keeper upkeep reconciled the draw. Because this pool had only one curated NFT, admission then became `NO_CURATED` (3); this continuation does not demonstrate that other curated listings remain purchasable after upkeep.

After seven days, the player called real FWA `refundFailedDelivery` and `withdrawAcquisitionRefund`. Its balance ended exactly **0.002457 ETH** below its pre-purchase value, so the acquisition fee returned in full and the VRF fee did not. Foundry balance arithmetic does not include gas paid by the actor. FWA listing status became 7 (delivery refunded). Creator `recoverRefunded` reverted because the FWA pool no longer owned NFT #1; its ownership remained with the thief. The creator could still close, unlist the remaining Shape (asserted exact **0.01 ETH** backing returned to Balancer), then claim **1.99765196855 ETH** liquid, leaving Balancer at zero. This distinguishes lost curated custody from a whole-pool liquid exit block. The test does not show durable thief profit: the public `seize` power can be called again, and no market sale was executed.

## Command, status and identity

First successful run, before adding explicit zero-owner-proceeds and exact Shape-backing assertions:

```sh
set -o pipefail; FOUNDRY_TEST=audit/round8/lane_a/informed FOUNDRY_OUT=audit/round8/lane_a/informed/out FOUNDRY_CACHE_PATH=audit/round8/lane_a/informed/cache forge test --match-path audit/round8/lane_a/informed/GhostContinuation.t.sol --match-test testGhostDrawRefundAndPartialCreatorExit --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv 2>&1 | tee audit/round8/lane_a/informed/ghost-continuation-attempt1.log
```

Exit **0**, 1/1. Output SHA-256 `42a543231f91a8a20b34be4351f08c7e351dbc686aa93cf9a6dba7849c4f1bc0`.

Final stronger assertion run:

```sh
set -o pipefail; FOUNDRY_TEST=audit/round8/lane_a/informed FOUNDRY_OUT=audit/round8/lane_a/informed/out FOUNDRY_CACHE_PATH=audit/round8/lane_a/informed/cache forge test --match-path audit/round8/lane_a/informed/GhostContinuation.t.sol --match-test testGhostDrawRefundAndPartialCreatorExit --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv 2>&1 | tee audit/round8/lane_a/informed/ghost-continuation-final.log
```

Exit **0**, 1/1. Final source SHA-256 `5512777983454e99acbfb4ff18929a36e7350582a3b81237920ea49f3fbd7dac`; final output SHA-256 `32f872a33cdfa663ce812a3ac533118957d99aff583939924ea4c8c4ed1d6f98`. Read-only RPC escalation permitted fork DNS. No FWA, Shapes, Packs or VRF protocol state/balance was faked; only actual FWA service-word delivery was impersonated under the stated exception. No broadcast occurred.

## Time and bounds correction

The earlier informed `review.md` mistakenly attributed Lane B's 16:18 UTC seal time to Lane A discovery and reported a 39-minute discovery. The actual immutable Lane A discovery seal records **15:39:07–15:58:21 UTC**, about **19 minutes**. Informed work ran approximately **16:19–16:39 UTC**, about **20 minutes**, including the post-seal continuation and surface map. Total substantive Lane A audit time was approximately **39 minutes**, plus the separately recorded preflight, well below the three auditor-hour ceiling. The earlier review stays unchanged so its SHA-256 and citations remain stable; this addendum supersedes only its duration statement and F1 continuation status. No further Lane A tests are planned.
