# Operations and recovery

Status codes come from `admissionStatus()`; the dashboard shows them as text.

| Code | Name | Meaning | Action |
| --- | --- | --- | --- |
| 0 | OK | Open: the Balancer admits purchases (FWA can still refuse one, e.g. when its VRF service lacks capacity) | none |
| 1 | CLOSED | Closed by creator | `open()` |
| 2 | SETTING_UP | A creator action (configure, open, unlist) started restocking work | call `performUpkeep()` (keeper, creator or anyone) until the target is restored; deposit ETH first if the reserve is short |
| 3 | NO_CURATED | No curated NFT is listed | list a curated NFT, then upkeep |
| 4 | BUSY | 5 draws are unsettled on FWA | wait for VRF and FWA processing; anyone may call FWA `processAcquisitions(5)` |
| 5 | MINT_FEE_ROSE | The Shapes mint fee is above the one the creator accepted | run `configure(markupBps, target)` again to accept the new fee (the reserve must cover it), then upkeep |
| 6 | LOW_INVENTORY | Listed prize weight is below 70% of the target's | call `performUpkeep()` to restock; if it stays at 6, `depositETH()` and upkeep again |

## Keeper down

New purchases pause once prize weight falls below 70% of the target (status 6) or 5 draws are unsettled (status 4).
Outstanding draws, refunds and NFT claims are unaffected: FWA settles them itself. Anyone, including the creator from the
dashboard, can call `performUpkeep()`. Run a second keeper with the same factory address; duplicate submissions just
revert `NoUpkeepNeeded` in simulation and are never sent.

## Keeper service

```bash
FACTORY=<factory> FROM_BLOCK=<deploy block> KEEPER_PRIVATE_KEY=<from your secret store> \
RPC_URL=https://mainnet.gateway.tenderly.co STATE_FILE=keeper/state.json MAX_LOSS_WEI=200000000000000 npm run keeper
```

- Each tick the keeper simulates `performUpkeep` for every Balancer at the price it would bid (basefee + 0.05 gwei,
  `PRIORITY_GWEI`). The simulation returns the contract's reward. `NoUpkeepNeeded` means nothing to do, and
  `KeeperNotApproved` that the factory's keeper admin has restricted upkeep to other keepers; both are skipped quietly. Any
  other revert is reported as that pool's error. It sends only when reward + `MAX_LOSS_WEI` ≥ estimated gas × price. An estimate above the
  3.2M gas the reward pays for is sent when the capped reward still covers it (a five-Shape opening stockup estimates
  about 3.28M).
- Gas limit: 30% over the estimate and never below 4M, because draws that settle between estimate and inclusion add
  their work to the call (one such draw added 536k gas on a fork; a 30% limit ran out of gas). Only gas used is billed,
  but the keeper address must hold the limit × max fee (0.02 ETH at 5 gwei) to send.
- `MAX_LOSS_WEI` (default 0.0002 ETH) is the subsidy the operator accepts per call, measured against the gas estimate
  at the current basefee. A receipt can cost more if basefee rises before inclusion.
  Outside creator-started work a pool pays only from `keeperCredit`: the restocking fees of the prizes each call lists,
  at that block's basefee, so one draw covers its restock up to 5 gwei whatever gas was before. Calls that reconcile
  only refunded or curated draws are paid from credit left over, if any; the default allowance covers them at low gas,
  and the next restock reconciles them anyway. Set 0 for a strictly profitable keeper.
- Refunded NFTs and prizes are recovered by the creator with `recoverRefunded(listingId, to)`, not by the keeper.

- Health: `GET http://localhost:8787/health` (503 if no tick for 2 minutes). Per-pool errors are listed and do not stop
  other pools.
- State: `STATE_FILE` holds discovered Balancers, the last scanned block and in-flight transactions. Deleting it is safe:
  the keeper rescans from `FROM_BLOCK`.
- Stuck transaction: the keeper replaces it after 3 blocks with +25% fees, up to 5 times, only while the bid stays under
  `MAX_GAS_PRICE_GWEI` (default 5, the contract's reimbursement cap) and the simulated reward still covers the cost.
  Otherwise it waits. During a basefee spike above 5 gwei (~0.9% of blocks over the last 90 days; longest measured
  episode ~42 min) pools pause new purchases until gas falls; existing draws are unaffected. A creator can always run upkeep from the dashboard and pay the gas themself.
- Reorgs: the last 64 blocks are rescanned every tick; Balancers whose creation was reorged out are dropped.
- Fund the keeper address with ETH for gas; rewards come back from each pool to the address that sent the call. Use
  a plain account: an account with code that forwards incoming ETH (for example an EIP-7702 delegation to a sweeper,
  as the public Hardhat test keys carry on mainnet) passes rewards on instead of keeping them.

## Failed NFT delivery

FWA quarantines a drawn NFT that cannot be transferred (status `DeliveryPending`). Anyone may retry via FWA
`retryNFTDelivery(listingId)` for 7 days. After that the purchaser may `refundFailedDelivery`. The dashboard lists failed
deliveries from `ItemDrawn` events. The creator recovers a refunded item with `recoverRefunded(listingId, to)`: a curated
NFT goes to `to`, and a drawn prize is redeemed here for its backing. Upkeep never calls curated collections, so a hostile
collection cannot tax keepers. If the collection blocks the transfer, retry later. If the purchaser never refunds, the NFT
stays in FWA's delivery escrow (FWA behavior). The gate refuses the Balancer, the Shapes contract, the Draw Packs contract
and the pool as purchasers, so prize deliveries cannot fail with mainnet Shapes or Draw Packs. Do not list collections
that refuse transfers to contracts: a purchaser contract that never refunds can lock such an NFT in FWA escrow (the
dashboard warns before listing). List only collections you trust: one whose contract can move, burn or freeze tokens can
take a listed NFT out of FWA or block its withdrawal; the dashboard says so beside the listing form.

## NFT sent to the Balancer directly

`recoverUntrackedNFT(collection, tokenId, to)` (creator) returns any NFT the Balancer owns outside FWA. Listed NFTs and
pending deliveries are owned by the FWA pool and cannot be taken this way.

## Shapes mint fee change

The Shapes admin can change `mintFee` up to 0.01 ETH. A rise pauses purchases and restocking (status 5) until the creator
runs `configure(markupBps, target)` again to accept the new fee, with the reserve funded for it. Planner and simulation
show when a fee makes the configuration uneconomic.

## FWA changes

- The Balancer only creates pools on the reviewed implementation and code hash. If FWA rotates its implementation, new
  Balancer creation reverts; existing pools are unaffected (FWA clones keep their implementation).
- FWA `globalWithdrawOnly` or retirement: FWA refuses new purchases and listings, so upkeep stops restocking; proceeds
  collection, `unlistShapes` and withdrawals still work.

## Recover all capital

1. `close()`.
2. Wait for FWA to settle any unsettled draws, then run `performUpkeep()` once to reconcile them.
3. `unlistShapes(listingIds)` until no prizes are listed (prize listing ids come from `getActiveIds` /
   `getActiveShapes`; it withdraws and redeems each prize for exact backing, up to 20 per call).
4. `withdrawCurated(listingId, to)` for each curated NFT; `recoverRefunded(listingId, to)` for any refunded one.
5. `claimSurplus(balance, to)`; while closed the full balance is claimable.
6. Optional and permanent: `retire()`.

## FWA pool page

On mainnet the dashboard's "FWA pool page" form approves FWA's exact publication message on the Balancer
(`approvePoolPage`) and then submits the page to `pools.fwa.fun/api/fwa/profile` with a placeholder signature; FWA's
server is expected to verify it through ERC-1271 (`isValidSignature`). This is unconfirmed with FWA. If FWA rejects it,
ask FWA to support contract owners or to add the creator as an editor for the pool. Purchases do not depend on the page.

## Creator key change

`transferCreator(new)` then `acceptCreator()` from the new address. Setting `new` to zero cancels.
