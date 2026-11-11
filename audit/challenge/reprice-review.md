# Informed challenge: FWA `updatePrice` callback reachability

Reviewed 2026-11-11 11:09–11:12 UTC against frozen Balancer revision `0f017843ec333f499809f751e19017be325448e3` and the supplied pinned FWA source record `audit/integrations/fwa-pool-source.json` (SHA-256 `7eaed3e798816cefe33c53bacf417307f39c559a469345975e3a75d3201763d3`). Balancer source SHA-256 is `bc2cf8d26848bf17f919d8fe0187057d9f7f720770ac38acc49904ef28e2c94d`. The source record is Blockscout's `StandardPoolBuyback` plus inherited `StandardPool`, marked **partially verified**, not fully verified. No source, existing test, or other audit file was edited; no fork test, RPC call, or broadcast was made for this challenge.

## Question and bounded disposition

Slither alerts `34b80f0a56cf8776d5260146d68779d3c2ea1a76bf76e451e0e1439851b3c7fe` and `87db156f04b140bff2935eeea27e4075fb499fc9ba988f8c0cafea29b0f48173` correctly identify **Balancer's local price write after an external FWA call** at `PoolBalancer.sol:373-374` and `:736-737`. Under the inspected pinned `StandardPool.updatePrice` source, that call **cannot reach a state-changing callback into Balancer** that invokes unguarded `configure`, creator transfer, or another authority-changing entry. Its sole external call is `FACTORY.globalWithdrawOnly()` at `StandardPool.sol:1040`, declared `external view` in `IFWACloneFactory.sol:55`; it occurs **before** FWA changes its listing price. Solidity invokes that interface through `STATICCALL`, and static context propagates through nested calls. A factory that is also the Balancer creator could inspect state or grief/revert, but it could not mutate Balancer config or authority from that call.

**Disposition:** source-level mutable reentrancy is ruled out for these two `updatePrice` call sites under the supplied FWA implementation. This does not rule out the already demonstrated creator-NFT callback during `listCurated`/`listCuratedBatch`, which is a different external-call path. The FWA source is partially verified; supplied `deployed_bytecode` hashes to the runtime code hash observed at pinned mainnet block `26382349`, but no independent full source-to-bytecode reproduction was performed. Therefore this is a bounded reachability argument, not a universal assertion about replacement implementations, future factory behavior, or a schema-2 gate acceptance.

## Exact FWA call graph

The main `StandardPoolBuyback.sol` defines only constructor and `payoutProtocolFees` beyond inheritance. It does not override `updatePrice`; inherited `StandardPool.sol:1036-1064` is the relevant body.

1. FWA's `nonReentrant` modifier runs, then storage checks reject retirement and `_activeOwned(listingId)` (`:966-970`) requires `Active` and `listing.depositor == msg.sender`. `_requireExitUnlocked()` (`:960-962`) later checks that unsettled acquisitions equal zero. These helpers perform storage reads/reverts only.
2. `IFWACloneFactory(FACTORY).globalWithdrawOnly()` (`:1040`) is the **only external call in this function or its called helpers**. The interface marks it `view`. It reads withdrawal policy; a true result reverts before the reprice. Static context prevents any nested mutation, even if the factory itself is adversarial or calls another contract.
3. FWA computes `newWeight = 1e36/newPrice`, updates segment-tree nodes through `_addTreeWeight` (`:1900-1913`) or `_removeTreeWeight` (`:1919-1929`), updates `totalWeight`/`weightedBackingTotal`, then writes `listing.price` and `listing.weight` (`:1046-1060`). `_recordInventoryChange()` (`:811-817`) increments version/timestamp and emits an event. `PriceUpdated` is an event. There is **no later external call**, NFT transfer, ETH transfer, purchase notifier, recipient hook, or creator callback after the FWA writes and before Balancer resumes.

The FWA source checks are substantive: the factory view is before the FWA writes; the tree and version routines are internal storage/event operations; and `updatePrice` does not call an NFT collection. A hostile curated ERC-721 therefore cannot inject a transfer/approval hook into this specific repricing call.

## Asset and authority ledger

| Path | Before | During FWA `updatePrice` | After successful return |
| --- | --- | --- | --- |
| Creator `updateCuratedPrice` (`PoolBalancer.sol:365-377`) | The same curated NFT remains owned by FWA; `items[lid]` has old base/price, and the old checkpoint may be valid. The caller must be current creator, and `_requireIdle` checks no unsettled or unreconciled FWA batch. | Balancer invalidates checkpoint and marks `creatorWork`, computes price and writes new `it.base` before line 373. FWA checks listing owner/status, makes the single factory `STATICCALL` while FWA listing price is still old, then changes FWA tree/price/version internally. Balancer `it.price` remains old until line 374. No ETH/NFT/approval moves; no mutable callback can change config/creator in this span under the inspected source. | Balancer writes `it.price` to the same value FWA stored and emits `CuratedRepriced`. Checkpoint remains invalid until upkeep. Creator/pending creator, page epoch, NFT custody and ETH balances are unchanged by the reprice. An FWA revert atomically restores `it.base`, checkpoint and FWA storage. |
| Keeper `_reprice` in `performUpkeep` (`:728-742`) | Upkeep is under Balancer `nonReentrant`; `_sync` has already invalidated checkpoint. `it.base` remains creator-set, `it.price` and FWA price reflect the prior markup; current `config.markupBps` determines the new price. | Each FWA call has the same single pre-write factory `STATICCALL` and internal reweight/version writes. Balancer's tracked price stays old until line 737, but this intermediate state is not exposed to a mutable callback by `updatePrice`. This `updatePrice` substep transfers no assets or authority. | Balancer writes each new tracked price, increments operations and emits `ListingRepriced`. It may continue scanning and later checkpoint if the rest of upkeep succeeds. Other `_sync`/upkeep calls can collect proceeds, mint/redeem Shapes or pay the keeper; those separate call sites are outside these two Slither alerts. Any revert rolls back the whole upkeep transaction. |

A static factory callback could make a read-only observation while Balancer's `it.base` is new and `it.price` old in the direct creator path. It cannot make that transient pair persistent. In both paths, checkpoint invalidation precedes the FWA reprice, so the same transaction does not leave a valid admission checkpoint merely because Balancer writes its local price afterward.

## Evidence and limits

Exact read-only reproduction from the repository root:

```sh
shasum -a 256 audit/integrations/fwa-pool-source.json src/PoolBalancer.sol audit/slither.json
python3 - <<'PY'
import json
from Crypto.Hash import keccak
x=json.load(open('audit/integrations/fwa-pool-source.json'))
s=next(a['source_code'] for a in x['additional_sources'] if a['file_path']=='src/poolsV2/StandardPool.sol')
for n in (966,967,968,969,1036,1038,1040,1044,1046,1051,1052,1054,1056,1057,1059,1060,1061,1063,811,812,813,814,815,816,1900,1907,1919,1923):
    print(f'{n}: {s.splitlines()[n-1].strip()}')
b=bytes.fromhex(x['deployed_bytecode'][2:]); h=keccak.new(digest_bits=256); h.update(b)
print('supplied deployed bytes',len(b),'keccak256','0x'+h.hexdigest())
print('partially verified',x['is_partially_verified'],'fully verified',x['is_fully_verified'])
PY
```

Both commands exited **0**. The reported hashes were FWA source record `7eaed3e798816cefe33c53bacf417307f39c559a469345975e3a75d3201763d3`, Balancer `bc2cf8d26848bf17f919d8fe0187057d9f7f720770ac38acc49904ef28e2c94d`, and Slither JSON `ae003b6bfc0c727c9630559039f24756e274c0d9305d4fb8e89671f3f95099b6`. The second command printed the selected source lines described above and `supplied deployed bytes 24280 keccak256 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02`, `partially verified True fully verified False`. The existing integration record independently reports that same runtime hash from the public Tenderly fork at block `26382349`; this challenge did not repeat the RPC read.

The bytecode hash match establishes that the JSON's supplied deployed bytecode matches the previously observed pinned runtime hash. It does **not** establish that every line of partially verified source compiled to those bytes. A full independent source/runtime reproduction or bytecode-level trace of `updatePrice` would be needed to remove that provenance condition. Likewise, this result covers the two `updatePrice` call sites only, not every callback during upkeep or curated listing.
