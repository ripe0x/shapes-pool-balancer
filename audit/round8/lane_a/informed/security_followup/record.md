# Round 8 Lane A informed security follow-up

Frozen target `2ac7a7e7b965d1798729068566c026128a4ba4b9`. New artifacts only in this `security_followup/` directory; prior discovery and informed seals are unchanged. Source/config: Solidity 0.8.28, via IR, optimizer 50, Cancun. Every test deployed a local official Balancer/Factory/Packs against real FWA and Shapes at mainnet block 26,382,349 through `https://mainnet.gateway.tenderly.co`. The Balancer itself remains undeployed. Test-controlled curator and receivers are real actor implementations using OpenZeppelin ERC721 and payable callbacks, not substitutes for FWA/Shapes/Packs. No protocol state/balance was altered with cheatcodes; actor wallet funding and FWA service-word delivery are within the authorized exceptions. No broadcast.

## Actor, state, assertion and outcome

| Path | Pre-state and attacker/actor | Executed assertions | Bounded conclusion and alternatives |
| --- | --- | --- | --- |
| Hostile `listCuratedBatch` callback and rollback | A creator-controlled ERC721 owns tokens #1/#2 and is the Balancer creator. Its first transfer into Balancer calls `configure` to change markup from 0% to 100%. In the failure branch, its second transfer reverts `SecondPullBlocked`. | Failure branch: `listCuratedBatch` reverts; both tokens remain creator-owned, markup remains 0, FWA has zero active listings. Successful branch: FWA owns both; first price is exactly **0.1 ETH** (computed before callback) and second **0.2 ETH** (computed after callback); creator markup is 100%, and after Shape upkeep admission is 0. | **Confirmed stale/mixed listing price condition** for a creator-controlled collection in one successful batch, extending informed F3. Revert atomicity is accepted only for this exact second-pull rejection. A malicious approval callback, more than two tokens, FWA batch failure after all pulls and purchase at these mixed prices remain untested. Creator controls the callback/config; no outsider theft was shown. |
| `updateCuratedPrice` with unsettled FWA draw | Creator listed one curated token and one Shape, opened and stocked. An actual code-free funded EOA player issued one FWA request, leaving `unsettledAcquisitionCount()==1`. Creator attempted to reprice the curated listing from 0.1 to 0.2 ETH. | Repricing reverted; Balancer's `items(lid).base/price` and FWA listing price remained exactly at the pre-call values. An authenticated FWA word then selected the Shape (one candidate); after real FWA processing cleared unsettled count, the same repricing succeeded and both Balancer/FWA price became **0.2 ETH**. | **Accepted within this one-draw state**: the failed FWA price call rolls back Balancer's earlier base write. Exact revert selector was not asserted. Concurrent batches, collection callback in repricing, other prices and FWA admin modes remain open. Player payment went to FWA; this test did not measure the player's net outcome after Shape delivery. |
| Contract keeper reward callback | Creator opened with a missing 0.01 ETH Shape. A real keeper actor contract called `performUpkeep`; reward transfer invoked its payable fallback, which called `performUpkeep` again. | Outer upkeep paid the keeper its returned positive reward, stocked one Shape, and callback was reached. Nested call returned `Reentrancy()` selector **0xab143c06** and made no second upkeep. | Guard held for this exact nested upkeep during a creator-started stock call. Other keeper callback entry points, gas grief, reverted keeper receiver and multi-operation reward arithmetic remain open. |
| Creator ETH claim callback | After stockup, the creator was itself a contract and claimed the exact withdrawable surplus to itself. Its fallback attempted a second `claimSurplus(1 wei)`. | Creator received exactly the outer claim amount; nested call returned `Reentrancy()` **0xab143c06**; Balancer liquid ended at its computed reserve. | Guard held for this exact nested claim. The creator can still call unguarded owner methods during its own callbacks in other flows; hostile receiver revert and reserve-rule sufficiency remain open. F-A1/E-B1 are unaffected. |
| Creator NFT receiver callback | Two curated NFTs were active in real FWA. Creator directed `withdrawCurated(first, creator contract)`; FWA's safe-transfer path reached the creator's ERC721 receiver. Receiver attempted `withdrawCurated(second, creator)`. | Callback attempt flag true; first NFT became creator-owned and its Balancer item cleared; second remained FWA-owned and active; nested call returned `Reentrancy()` **0xab143c06**. | Guard held for this exact safe-transfer receiver reentry. Other collection/recipient callback selectors, refund recovery and adversarial ERC721 approval logic remain open. |
| Two-step creator/factory handovers and restricted keeper | Code-free creator, admin, pending A/B and keeper actors on the fork. Admin nominated A then B; creator nominated zero, then A then a different new creator. Factory restriction denied an unapproved keeper while creator still ran setup upkeep. | A could not use admin rights before acceptance or accept after being overwritten; B accepted, old admin lost rights. Zero pending creator could not accept; overwritten A could not accept, new creator did, old creator could not claim. New admin could not close Balancer. New creator unlisted one Shape; approved keeper restocked and received **0.0019945574 ETH**; new creator closed/claimed **0.9839541474 ETH** liquid, leaving Balancer liquid zero. Creator setup reward was **0.0020512952 ETH**. | **Accepted within this actor/sequence domain**: factory keeper admin can restrict/approve upkeep but not operate creator assets; creator bypasses restriction; pending rights require exact acceptance. Unapproved keeper grief through other contracts, compromised-admin scheduling/liveness, contract role recipients, future asset recoveries and all pending-overwrite combinations remain open. The remaining Shape NFT was still listed when liquid was claimed after close, so this is not a full asset-exit witness. |

The callback tests all compare protected asset identity and local state, not only the outer return value. A `Reentrancy()` revert does not prove every callback is safe: unguarded creator methods and hostile ERC721 semantics require their own path checks. The batch-price anomaly is a creator-controlled configuration race; whether 100% current markup must apply to the entire transaction is an owner rule, not established by the tests alone.

## EOA and code identity check

`SecurityEdges.t.sol` asserts `PLAYER=0xB0B` has zero code on the pinned fork before funding. `AuthorityEdges.t.sol` asserts zero code for `0xC0`, `0xC1`, `0xAD`, `0xA1`, `0xA2` and `0xBEEF`. A separate read-only RPC check covered addresses used in earlier informed tests, avoiding the EIP-7702 delegated-account pitfall found in another lane. Exact command, exit **0**:

```sh
for addr in 0x0000000000000000000000000000000000000B0B 0x000000000000000000000000000000000000CAFE 0x000000000000000000000000000000000000BEEF; do printf '%s ' "$addr"; cast code "$addr" --rpc-url https://mainnet.gateway.tenderly.co --block 26382349; done
```

Exact output:

```text
0x0000000000000000000000000000000000000B0B 0x
0x000000000000000000000000000000000000CAFE 0x
0x000000000000000000000000000000000000BEEF 0x
```

This checks runtime code at the one pinned block; it does not prove no account delegation at other blocks or after a transaction.

## Commands, statuses, outputs and hashes

All commands ran from `/Users/dd/CascadeProjects/fwa-pool-balancer` under `set -o pipefail`, with one `--match-path` test file each. Sandbox read-only RPC escalation was required for DNS. `FOUNDRY_TEST`, output and cache paths were confined to this follow-up directory. No cache deletion or whole suite.

```sh
set -o pipefail; FOUNDRY_TEST=audit/round8/lane_a/informed/security_followup FOUNDRY_OUT=audit/round8/lane_a/informed/security_followup/out FOUNDRY_CACHE_PATH=audit/round8/lane_a/informed/security_followup/cache forge test --match-path audit/round8/lane_a/informed/security_followup/SecurityEdges.t.sol --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv 2>&1 | tee audit/round8/lane_a/informed/security_followup/security-edges-final.log
```

Exit **0**, 4/4. Source SHA-256 `5f8c9ea9f106a87daf86ff696aeae43083f54ae8b62590e4df172f6105035e6d`; output SHA-256 `fe78a66269ec1e8e0bfca4b77925bb9ac274ba2a1046439166f1e51ce3d57bb8`.

```sh
set -o pipefail; FOUNDRY_TEST=audit/round8/lane_a/informed/security_followup FOUNDRY_OUT=audit/round8/lane_a/informed/security_followup/out FOUNDRY_CACHE_PATH=audit/round8/lane_a/informed/security_followup/cache forge test --match-path audit/round8/lane_a/informed/security_followup/AuthorityEdges.t.sol --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv 2>&1 | tee audit/round8/lane_a/informed/security_followup/authority-edges-attempt1.log
```

Exit **0**, 1/1. Source SHA-256 `d888822acf0870dbafad2e34d3b9f60a25b3eb2542df9b1e87c9f0cbff3f8dad`; output SHA-256 `15dda83a33c378f5851fe355253bdc2f9c39cd275cc38f44a40b150df5f9e189`.

Retained intermediate attempts: `security-edges-attempt1.log` exit **1**, compiler syntax error in test-only tuple declaration (SHA-256 `89508fa0f488cb0f861ed52cc397843755dfa7e837d1877a6ebb93a4f7963d08`); `security-edges-attempt2.log` exit **0**, first 3/3 tests before adding NFT receiver (SHA-256 `115bbe12efbb8a55a016d41c9369e0389959920bfb34782fc691879a7ffdef17`); `nft-receiver-attempt1.log` exit **0**, isolated NFT callback 1/1 (SHA-256 `929a424f770614cb0da4a383f7c8a4f4020736d8589399e8485a265debe087b7`). Their commands used the exact same environment/fork flags as the final SecurityEdges command, with `-vv`, respective `tee` path and, for the isolated NFT run, `--match-test testCreatorNFTReceiverCannotReenterSecondWithdrawal` before the fork flags. No failed protocol path is inferred from the test-only compiler error.

Follow-up work began around 16:39 UTC and this record was sealed around 16:47 UTC, approximately **8 minutes**. Prior Lane A substantive discovery plus informed work was approximately **39 minutes** (corrected in `../post-seal-ghost-continuation.md`); cumulative substantive Lane A time is approximately **47 minutes plus separately recorded preflight**, under the three auditor-hour ceiling. This phase is informed; no new independent-discovery credit is claimed. No human review, recent-block retest, deployed Balancer runtime correspondence or exhaustive adversarial coverage is established by these paths.
