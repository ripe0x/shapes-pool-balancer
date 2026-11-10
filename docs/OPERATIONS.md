# Operations and recovery

Status codes come from `admissionStatus()`; the dashboard shows them as text.

| Code | Meaning | Action |
| --- | --- | --- |
| 0 | Open | none |
| 1 | Closed by creator | `open()` |
| 2 | Needs upkeep | call `performUpkeep()` (keeper, creator or anyone); repeat while a fill or repricing is in progress |
| 3 | FWA batch unresolved | wait for VRF and FWA processing; anyone may call FWA `processAcquisitions(5)` |
| 4 | No curated NFTs | list a curated NFT, then upkeep |
| 5 | No approved plan feasible | add curated value, raise the price ceiling or capital limit, lower the odds floor, or approve another plan |
| 6 | Reserve not covered | `depositETH()`, then upkeep |
| 7 | Mint fee rose | upkeep re-checkpoints at the new fee if funded |
| 8 | Price above ceiling | reconfigure |
| 10 | Repricing | upkeep until done |
| 11 | FWA retired or withdraw-only | unwind and withdraw |
| 12 | FWA totals differ from plan | should not occur; close the pool and report |

## Keeper down

New purchases stop after the next batch (status 2). Outstanding draws, refunds and NFT claims are unaffected: FWA
settles them itself. Anyone, including the creator from the dashboard, can call `performUpkeep()`. Run a second keeper with
the same factory address; duplicate submissions just revert `NoUpkeepNeeded` in simulation and are never sent.

## Keeper service

```bash
FACTORY=<factory> FROM_BLOCK=<deploy block> KEEPER_PRIVATE_KEY=<from your secret store> \
RPC_URL=https://mainnet.gateway.tenderly.co STATE_FILE=keeper/state.json npm run keeper
```

- Health: `GET http://localhost:8787/health` (503 if no tick for 2 minutes). Per-pool errors are listed and do not stop
  other pools.
- State: `STATE_FILE` holds discovered Balancers, the last scanned block and in-flight transactions. Deleting it is safe:
  the keeper rescans from `FROM_BLOCK`.
- Stuck transaction: the keeper replaces it after 3 blocks with +25% fees, up to 5 times, never above 10 gwei. Above
  that cap it waits.
- Reorgs: the last 64 blocks are rescanned every tick; Balancers whose creation was reorged out are dropped.
- Fund the keeper address with ETH for gas; rewards come back from each pool.

## Failed NFT delivery

FWA quarantines a drawn NFT that cannot be transferred (status `DeliveryPending`). Anyone may retry via FWA
`retryNFTDelivery(listingId)` for 7 days. After that the purchaser may `refundFailedDelivery`. Refunded Shapes are recovered into spares by
upkeep; a refunded curated NFT is recovered by the creator with `recoverCuratedNFT(listingId, to)` (upkeep never calls
curated collections, so a hostile collection cannot tax keepers). If the collection blocks the transfer, retry later. If
the purchaser never refunds, the NFT stays in FWA's delivery escrow (FWA behavior).

## Shapes mint fee change

The Shapes admin can change `mintFee` up to 0.01 ETH. A rise closes admission (status 7) until upkeep re-checkpoints with
a reserve funded at the new fee. Planner and simulation show when a fee makes the configuration uneconomic.

## FWA changes

- The Balancer only creates pools on the reviewed implementation and code hash. If FWA rotates its implementation, new
  Balancer creation reverts; existing pools are unaffected (FWA clones keep their implementation).
- FWA `globalWithdrawOnly` or retirement: upkeep reports status 11; unwind and withdraw still work.

## Recover all capital

1. `close()`.
2. Wait for status 3 to clear (FWA batch settled), run upkeep once to reconcile.
3. `unwind(20)` until no Shapes are listed (redeems Shapes for exact backing).
4. `withdrawCurated(listingId, to)` for each curated NFT; `recoverCuratedNFT` for any refunded one.
5. `claimSurplus(balance, to)`; while closed the full balance is claimable.
6. Optional and permanent: `retire()`.

## Creator key change

`transferCreator(new)` then `acceptCreator()` from the new address. Setting `new` to zero cancels.
