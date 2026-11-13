# Lane B new-creator capital continuation

Frozen target `2ac7a7e7b965d1798729068566c026128a4ba4b9`, pinned mainnet block `26382349` sourced only from `https://mainnet.gateway.tenderly.co`; local Anvil chain ID `31337`, port `18547` (retained PID `46925`). This stage owns only `audit/round8/lane_b/validation/new_creator/` and leaves all earlier seals unchanged. Local transactions were reverted to the opening snapshot. No live mainnet transaction, production edit, FWA/Shapes mock, or protocol balance/storage fake occurred. External wallets were checked code-free and funded as test setup. Word delivery used only the actual coordinator calling the real FWA VRF service.

## Exact commands and status

From repository root:

```sh
FOUNDRY_OUT=audit/round8/lane_b/validation/new_creator/out FOUNDRY_CACHE_PATH=audit/round8/lane_b/validation/new_creator/cache forge build --contracts audit/round8/lane_b/validation/new_creator --out audit/round8/lane_b/validation/new_creator/out --cache-path audit/round8/lane_b/validation/new_creator/cache
# first attempt exit 1: relative import used four rather than five parent directories; hostile-build.log
# corrected retry exit 0: hostile-build-retry.log

node audit/round8/lane_b/validation/new_creator/new-creator-credit.mjs > audit/round8/lane_b/validation/new_creator/new-creator-credit.json 2> audit/round8/lane_b/validation/new_creator/new-creator-credit.err
# exit 0, also retained in new-creator-credit.exit
```

The build command compiled 60 files, including dependencies and existing tests, despite the single `--contracts` directory; **no test suite ran**. No cache was cleared. The deployable `HostileCreator.sol` was an audit-only adversarial ERC721 that misreported custody while forwarding its legitimate Balancer creator calls. It did not replace FWA or Shapes. It was deployed from artifact `out/HostileCreator.sol/HostileCreator.json`.

Key SHA-256: `HostileCreator.sol` `c45e95416174a69f21c8fbc65d9413c7a95c873eff06ff138e4ef1f58d63a6ea`; deployed artifact `f933530dfb80a0cf717dee305b8085000aab81f7063cbad8b1bec2433f8f6700`; failed build log `a5349d1a149401935519bf2b115226a084499afe7e744094275b115bd4ec7c09`; passing build log `bb7599ed18354a3c680e0e9e8f953098a81c468e994c167c13eb24f089f1bcbd`; script `ccdbfbf13291787d19f36c288ad16789e96569ae314537c83c33b60b2f3f15b7`; result JSON `fd44d735ba21469e9c6726f2ae1a77887097d3b8615f45a3af3d23fc38a7d109`; empty stderr `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`; exit file `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa`.

## Real creator-handoff sequence

1. The hostile collection was the original Balancer creator. A code-free player bought a Shape draw, which the actual coordinator delivered through the real VRF service and FWA pool. An outside code-free keeper restocked at base fee 4.9 gwei. KeeperPaid measured `803,101` gas, receipt billed `793,181 × 4.95 gwei = 0.00392624595` ETH, reward was `0.00447534995` ETH, and the keeper wallet gained `0.000549104` ETH. The replacement Shape left `keeperCredit = 0.00017965005` ETH.
2. A second real coordinator → service draw selected the hostile curated NFT. Its actual ERC721 transfer failed, FWA recorded acquisition status `7` and listing status `6`, and **owner proceeds were zero**. The old creator closed, unlisted the unwon fee-bearing replacement Shape, claimed **all `1.003833199286457265` ETH** in Balancer, and left Balancer balance exactly **zero**. The keeper credit remained `0.00017965005` ETH.
3. The old creator contract called `Balancer.transferCreator(newCreator)` through its own `handoff` method. The pending creator was asserted to be the new code-free EOA `0x00000000000000000000000000000000c0dec0dd`. That EOA called `Balancer.acceptCreator()`, after which `creator()` equaled it and `pendingCreator()` was zero. This used the real two-step role-transfer path; no creator impersonation occurred.
4. The new creator deposited `0.001` ETH. An outside code-free keeper then reconciled only the pending failed draw. KeeperPaid measured `62,270` gas and paid the entire **old** credit, `0.00017965005` ETH. The receipt billed `93,873 × 1.05 gwei = 0.00009856665` ETH, and the keeper wallet gained exactly **`0.0000810834` ETH**. Balancer balance fell from `0.001` to `0.00082034995` ETH, exactly the reward, while credit fell to zero. No FWA owner proceeds appeared.
5. The new creator claimed the remaining `0.00082034995` ETH, leaving Balancer zero again. Its **principal loss** on the deposit/reclaim round trip was exactly **`0.00017965005` ETH**, equal to the old keeper credit paid. Deposit plus claim gas cost `0.0000809844` ETH; observed round-trip wallet loss was **`0.00026063445` ETH**. Acceptance gas was `0.00005577705` ETH; observed wallet loss including role acceptance was **`0.0003164115` ETH**. The wallet equations and the Balancer balance equation were asserted in the script.
6. After seven local days, the player successfully refunded the failed delivery and withdrew its acquisition fee. Its loss including billed purchase/process/refund/withdraw gas was `0.0032231409` ETH, exactly the `0.002457` ETH VRF fee plus `0.0007661409` ETH gas. The refunded listing reached status `7`.

This is a **capital-source and role-transfer result**, not proof of an unbounded drain or a broken nominal keeper-credit cap. The outside keeper did useful pending-draw reconciliation. The new creator voluntarily accepted the role and deposited funds; whether preexisting keeper credit should bind a successor is an owner-policy decision. The sequence proves that the fee-bearing Shape can be unlisted and all old capital withdrawn while its credit persists into a new creator's deposit and pays an outside keeper. The FWA failure requires a creator-controlled dishonest ERC721, and controlled coordinator words demonstrate reachability rather than mainnet player control. No refund-heavy multi-draw batch was tested.

## Time

This continuation began at about `2026-11-12 17:44 UTC` and sealed at about `17:51 UTC`, about **7 minutes** of active work, under its 35-minute limit. Prior cumulative Lane B time was about **1 hour 58 minutes 20 seconds**; cumulative with this stage was about **2 hours 5 minutes 20 seconds**, below the three-hour ceiling. Both local Anvil services were preserved.
