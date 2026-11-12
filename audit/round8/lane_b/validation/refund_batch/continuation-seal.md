# Lane B refund-batch attempt, timed out

Frozen target `2ac7a7e7b965d1798729068566c026128a4ba4b9`; pinned mainnet fork block `26382349` from `https://mainnet.gateway.tenderly.co`; local Anvil chain ID `31337`, port `18547`, PID `46925`. Ownership was only `audit/round8/lane_b/validation/refund_batch/`. No production, existing test, or earlier sealed file was edited. No live mainnet transaction, protocol mock, or protocol balance/storage fake occurred. External actor wallets were funded as setup and callbacks in the script used the actual coordinator → real VRF service route.

## Commands and exit status

From repository root:

```sh
FOUNDRY_OUT=audit/round8/lane_b/validation/refund_batch/out FOUNDRY_CACHE_PATH=audit/round8/lane_b/validation/refund_batch/cache forge build --contracts audit/round8/lane_b/validation/refund_batch --out audit/round8/lane_b/validation/refund_batch/out --cache-path audit/round8/lane_b/validation/refund_batch/cache
# exit 0; multi-build.log

node audit/round8/lane_b/validation/refund_batch/refund-batch.mjs > audit/round8/lane_b/validation/refund_batch/refund-batch.json 2> audit/round8/lane_b/validation/refund_batch/refund-batch.err
# stopped at controller's 18:08 UTC cutoff with SIGINT to this Node client only; exit 130 in refund-batch.exit
```

The build compiled 60 files, including dependencies and existing test sources, despite the selected audit-only `--contracts` directory; it ran **no test suite**. The script deployed a real hostile ERC721 with five distinct token IDs, each capable of falsely reporting escrow while causing actual FWA delivery to fail. Its plan was one real Shape draw/restock to establish keeper credit, then a four-request FWA batch selecting four hostile NFTs through coordinator-delivered words, a single outside keeper reconciliation receipt, and four player refunds. The retained local router had previously accepted four, but not five, requests in a separate state-specific coverage check. The script capped selection search at 400 candidate words per request.

**No batch result was established.** The Node process emitted no terminal JSON or stderr before the cutoff; both output files are empty. Local Anvil was responsive at block `26382395` during the attempt, but without a checkpoint log this does not identify which purchase or candidate stage had completed. There is no asserted FWA status, refund count, keeper receipt, or measured-versus-billed result from this attempt. The blocker was execution time under the owner's deadline, not a demonstrated FWA revert. No retry was made.

SIGINT stopped only the Node client PID `38216` at `18:08 UTC`; Anvil PID `46925` stayed running. The Node `finally` snapshot revert was interrupted and the outer snapshot ID was not logged. **Port 18547 may retain partial local transactions and must not be treated as a clean fork baseline.** No reset or guessed snapshot revert was attempted. The separate Anvil on port `18548` was preserved untouched.

SHA-256: `MultiHostileCreator.sol` `ce412c20c4b26cdcfc9a565e1438d338d75ca6ba3c839f5eb32b98d4c57a8267`; compiled artifact `out/MultiHostileCreator.sol/MultiHostileCreator.json` `35bdf1ec567d14abc27e6acb3e177e7fba34f8c516df7bd0e6300279b5a99479`; build log `739483ab6e4c8323a9208673e4cdfd77ebc7b51eec996dd77470771919425b54`; script `1e330a9842de99cc5357678b6f192eecb70222af5e2691f736873f98cdd665b7`; empty stdout/stderr each `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`; exit file `f5bde7eb9f6c71611dc5726e8aca3eb4eba3e386da49e0a4ed5c295a90a73a0d`.

This stage ran from about `17:51` to `18:08 UTC`, about **17 minutes**. Prior cumulative Lane B active time was about **2 hours 5 minutes 20 seconds**; cumulative was about **2 hours 22 minutes 20 seconds**, leaving about 38 minutes of the three-hour lane ceiling. No further fork test is authorized in this bounded attempt.
