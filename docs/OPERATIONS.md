# Operations and recovery

Status codes come from `admissionStatus()`; the dashboard shows them as text.

| Code | Meaning | Action |
| --- | --- | --- |
| 0 | Open | none |
| 1 | Closed by creator | `open()` |
| 2 | Needs upkeep | call `performUpkeep()` (keeper, creator or anyone); repeat while a fill or repricing is in progress |
| 3 | FWA batch unresolved | wait for VRF and FWA processing; anyone may call FWA `processAcquisitions(5)` |
| 4 | No curated NFTs | list a curated NFT, then upkeep |
| 5 | No approved plan feasible | add curated value, raise the price ceiling, lower the odds floor, or approve another plan |
| 6 | Reserve not covered | `depositETH()`, then upkeep. The shown reserve includes keeper rewards for any refill steps |
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
RPC_URL=https://mainnet.gateway.tenderly.co STATE_FILE=keeper/state.json MAX_LOSS_WEI=100000000000000 npm run keeper
```

- Each tick the keeper simulates `performUpkeep` for every Balancer at the price it would bid (basefee + 0.05 gwei,
  `PRIORITY_GWEI`). The simulation returns the contract's reward. `NoUpkeepNeeded` and `PoolBusy` mean nothing to do;
  any other revert is reported as that pool's error. It sends only when reward + `MAX_LOSS_WEI` ≥ estimated gas × price,
  and never when the estimate exceeds the 3.2M reimbursable maximum.
- `MAX_LOSS_WEI` (default 0.0001 ETH) is the subsidy the operator accepts per call. Paid work is profitable up to the
  5 gwei cap by design; gas-only paid calls lose at most ~0.00006 ETH at the cap; unpaid re-checkpoints (after creator
  edits, deposits or a mint-fee change) cost ~155k gas, covered up to ~0.6 gwei. Set 0 for a strictly profitable keeper.
- The keeper also watches `ItemDrawn` events for failed Shape deliveries and calls `recoverRefundedShape` once FWA marks
  them refunded.

- Health: `GET http://localhost:8787/health` (503 if no tick for 2 minutes). Per-pool errors are listed and do not stop
  other pools.
- State: `STATE_FILE` holds discovered Balancers, the last scanned block and in-flight transactions. Deleting it is safe:
  the keeper rescans from `FROM_BLOCK`.
- Stuck transaction: the keeper replaces it after 3 blocks with +25% fees, up to 5 times, only while the bid stays under
  `MAX_GAS_PRICE_GWEI` (default 5, the contract's reimbursement cap) and the simulated reward still covers the cost.
  Otherwise it waits. During a basefee spike above 5 gwei (~0.9% of blocks over the last 90 days; longest measured
  episode ~42 min) pools pause new purchases until gas falls; existing draws are unaffected. Pools whose draws cost
  less than ~0.012 ETH pause from ~2.9 gwei, because one draw's FWA edge caps the keeper's incentive.
- Reorgs: the last 64 blocks are rescanned every tick; Balancers whose creation was reorged out are dropped.
- Fund the keeper address with ETH for gas; rewards come back from each pool to the address that sent the call. Use
  a plain account: an account with code that forwards incoming ETH (for example an EIP-7702 delegation to a sweeper,
  as the public Hardhat test keys carry on mainnet) passes rewards on instead of keeping them.

## Failed NFT delivery

FWA quarantines a drawn NFT that cannot be transferred (status `DeliveryPending`). Anyone may retry via FWA
`retryNFTDelivery(listingId)` for 7 days. After that the purchaser may `refundFailedDelivery`. The dashboard lists failed
deliveries from `ItemDrawn` events. A refunded Shape is recovered and redeemed by anyone with
`recoverRefundedShape(listingId)` (the keeper does this). A refunded curated NFT is recovered by the creator with
`recoverCuratedNFT(listingId, to)`; upkeep never calls curated collections, so a hostile collection cannot tax keepers. If
the collection blocks the transfer, retry later. If the purchaser never refunds, the NFT stays in FWA's delivery escrow
(FWA behavior). The gate refuses the Balancer, the Shapes contract and the pool as purchasers, so Shape deliveries cannot
fail with mainnet Shapes. Do not list collections that refuse transfers to contracts: a purchaser contract that never
refunds can lock such an NFT in FWA escrow (the dashboard warns before listing).

## NFT sent to the Balancer directly

`recoverUntrackedNFT(collection, tokenId, to)` (creator) returns any NFT the Balancer owns outside FWA. Listed NFTs and
pending deliveries are owned by the FWA pool and cannot be taken this way.

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
3. `unwind(20)` until no Shapes are listed (withdraws and redeems Shapes for exact backing).
4. `withdrawCurated(listingId, to)` for each curated NFT; `recoverCuratedNFT` for any refunded one.
5. `claimSurplus(balance, to)`; while closed the full balance is claimable.
6. Optional and permanent: `retire()`.

## FWA pool page

On mainnet the dashboard's "FWA pool page" form approves FWA's exact publication message on the Balancer
(`approvePoolPage`) and then submits the page to `pools.fwa.fun/api/fwa/profile` with a placeholder signature; FWA's
server is expected to verify it through ERC-1271 (`isValidSignature`). This is unconfirmed with FWA. If FWA rejects it,
ask FWA to support contract owners or to add the creator as an editor for the pool. Purchases do not depend on the page.

## Creator key change

`transferCreator(new)` then `acceptCreator()` from the new address. Setting `new` to zero cancels.
