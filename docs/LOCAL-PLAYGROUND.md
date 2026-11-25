# Local pool playground

Use the preserved Anvil fork at http://127.0.0.1:8545, chain 31337. Setup is controlled by the owner-approved
local-playground packet; no production deployment/signature approval is inherited. Do not restart or reset this node.
The normal Anvil example addresses on this fork have inherited EIP-7702 code, so the playground uses clean synthetic
accounts instead. No private keys are needed or should be imported.

## App

Setup completed on November 25, 2026. Open http://127.0.0.1:5280/ and click **Local dev account** if it is not already connected.

- Creator/admin: `0x000000000000000000000000000000000001e004`, funded with 100 test ETH.
- Buyer: `0x000000000000000000000000000000000001e008`, funded with 100 test ETH.
- Factory: `0xbe49677a403f77136e81498e5681f8dc22aa1181`.
- Demo NFT collection: `0x8B4087D01443ba7619BB3A6E2a8668C5AF0d1955`, tokens 1 and 2 belong to the creator.

These addresses are confirmed by bootstrap receipts and onchain readbacks. Public creation
stays paused. The connected policy-admin creator can create its own canary pools while paused.

1. Create a pool using the design page. Curated NFTs are optional. For the local demo tokens, click **Choose from your wallet**, then **Enter a contract and token ID instead**. Enter the demo collection above and token ID `1` or `2`; the app checks ownership on the fork. Wallet discovery can take time, so manual entry is the direct local path.
2. Confirm each local approval/creation step. Once created, use **List Shapes** / maintenance until the initial mix
   is stocked and purchases are admitted. No background keeper is automatically started by bootstrap.
3. Copy the **Balancer address** from the app. The commands below resolve its underlying FWA pool automatically.
   The external “Pool on FWA” link points to the public website, not this local chain.
4. To withdraw, close purchases first. Withdraw selected curated NFTs; unlist Shapes to redeem their backing.
   Alternatively retire the test pool and use **Take everything back**. Pending draws must settle or expire before
   affected inventory can be withdrawn. Retirement is permanent for that local pool.

## Draws

Fresh local requests cannot receive live Chainlink replies. These commands perform real FWA purchases; they never
invent randomness or impersonate the coordinator. Timeout/refund mode awards no NFTs. The genuine historical-proof
Foundry tests are a separate successful-delivery test, not draws on your new UI pool.

Preview the first batch without sending transactions or mining:

```sh
cd /Users/dd/CascadeProjects/fwa-pool-balancer
export LOCAL_FACTORY=0xbe49677a403f77136e81498e5681f8dc22aa1181
export BALANCER=0xPASTE_THE_BALANCER_ADDRESS_FROM_THE_APP

node --import tsx scripts/local-draws.ts \
  --balancer "$BALANCER" \
  --buyer 0x000000000000000000000000000000000001e008 \
  --count 20 --max-spend-eth 1
```

Run up to 20 actual purchases in batches of at most 5, wait through the real expiry rules, process and withdraw actual
buyer refunds, then reconcile the pool:

```sh
node --import tsx scripts/local-draws.ts \
  --balancer "$BALANCER" \
  --buyer 0x000000000000000000000000000000000001e008 \
  --count 20 --max-spend-eth 1 --execute --timeout-refund
```

The 1 test ETH limit counts all forward purchase payments even after refunds. Another 1 test ETH gas ceiling applies.
VRF fees are retained by the real service; purchaser refunds do not return them. Count is bounded at 100. Execution
stops on insufficient capital, admission/coverage refusal, pending draws or failed simulation. Oracle liabilities can
remain pending at the actual coordinator after local buyer expiry; there is no guarantee arbitrarily many timeout
batches will remain admitted. Timeout mining advances this SHARED local chain and may expire other pending draws.
Begin the timeout sequence with no pending draws; do not first submit an independent pending-only batch.

To submit only a pending batch, use count 5 and --execute without --timeout-refund. It deliberately stops after that
batch. To clear such a batch manually (the helper checks selectionTimeoutBlocks <= 4096), use actual pool methods:

```sh
export LOCAL_RPC=http://127.0.0.1:8545
export LOCAL_BUYER=0x000000000000000000000000000000000001e008
export FWA_POOL=$(cast call "$BALANCER" 'pool()(address)' --rpc-url "$LOCAL_RPC")
cast call "$FWA_POOL" 'selectionTimeoutBlocks()(uint256)' --rpc-url "$LOCAL_RPC"
# Only when the returned timeout is at most 4096; advances every pool on this local node.
cast rpc --rpc-url "$LOCAL_RPC" anvil_mine 0x1001
cast send "$FWA_POOL" 'processAcquisitions(uint256)' 5 --unlocked --from "$LOCAL_BUYER" --rpc-url "$LOCAL_RPC"
cast send "$FWA_POOL" 'withdrawAcquisitionRefund()' --unlocked --from "$LOCAL_BUYER" --rpc-url "$LOCAL_RPC"
cast send "$BALANCER" 'performUpkeepUnpaid()' --unlocked --from "$LOCAL_BUYER" --rpc-url "$LOCAL_RPC"
```

Additional demo NFTs, if needed for another pool, may be minted by the creator locally using a fresh token ID:

```sh
cast send 0x8B4087D01443ba7619BB3A6E2a8668C5AF0d1955 'mint(address,uint256)' \
  0x000000000000000000000000000000000001e004 3 \
  --unlocked --from 0x000000000000000000000000000000000001e004 \
  --rpc-url http://127.0.0.1:8545
```

Run already-implemented genuine historical delivery and recovery tests separately, without touching 8545:

```sh
CANDIDATE_RUN=1 forge test --match-contract '^(AuthenticSequenceTest|AuthenticRefundRecoveryTest)$' -vv
```

## Evidence and limits

Bootstrap uses the unchanged canonical Deploy.s.sol through script/deploy.sh's exact-hash local-only route. Preparation
has no node mutation. The initial local guard review found environment-only deployment overrides could pass the
wrapper; it was repaired before approval/broadcast. The final guard binds exact admins/reuse mode, rejects setter/
compiler override variables and hidden staged environment files, and requires the verified owned 8545 Anvil process.
Typechecking and four focused boundary tests pass; the two existing production-wrapper binding tests pass. The default
signed focused production gate tail remains byte-for-byte unchanged. No protocol runtime, compiler settings or ABI
was modified by this playground tooling. Existing mainnet review/scorecards refer to their frozen earlier candidate;
new tooling is not an automatic production release approval.

The draw command was typechecked and its help/argument handling exercised. It cannot be honestly exercised against
a new UI pool until you create that pool; preview is the first real-contract check and execution remains explicit.

Things that don't make sense: presenting timeout refunds as winning draws, or using the inherited delegated default
accounts as clean local wallets. This playground does neither.
