# Functional specification

Status: implemented at the commit that contains this file. Supersedes earlier exploratory designs.

## What it is

A creator runs an FWA standard pool whose inventory is their curated NFTs plus ETH-backed Shapes. A `PoolBalancer`
contract creates and permanently owns the FWA pool. Players buy on FWA's site exactly as for any other pool. When Shapes
leave the pool, anyone may call `performUpkeep` to restore the configured Shapes inventory from the Balancer's own ETH.

## Contracts

| Contract | Role |
| --- | --- |
| `BalancerFactory` | Ownerless. Deploys one EIP-1167 clone of `PoolBalancer` per call (`createBalancer(salt)`), forwards any ETH as a deposit, emits `BalancerCreated(creator, balancer, pool, salt)`. Keeps no authority over clones. |
| `PoolBalancer` | Non-upgradeable logic shared by all clones. Immutables pin the FWA factory, the reviewed FWA implementation and its runtime code hash, Shapes and the ENS registry. |

`initialize` (called by the factory in the same transaction) verifies the FWA implementation code hash and the 5-purchase
batch limit, calls `PoolFactory.createPool(0, reviewedImplementation)` so the Balancer becomes the FWA owner (FWA allows
one pool per owner address, so one pool per Balancer), installs itself as the FWA purchase operator, and approves the pool
for its Shapes. Nothing can ever change the operator, enable token offers or execute arbitrary calls.

## Roles

| Actor | Can |
| --- | --- |
| Creator | configure, open/close, list/reprice/withdraw/recover curated NFTs, claim surplus, unwind, retire, set ENS name, start creator transfer |
| Pending creator | accept the creator role |
| Anyone (keeper) | `performUpkeep`, `collectProceeds`, `depositETH` |
| FWA pool | calls `canPurchase` (view) |

The keeper's only payout is a bounded reward to `msg.sender`. Curated NFTs go only to a creator-chosen address; Shapes
are never sent anywhere except the FWA pool and, via redemption, become ETH in the Balancer.

## Configuration

`configure(Config, plans[])`:

- `maxDrawPrice`: ceiling on FWA `acquisitionFee()` (includes FWA's 5% edge, excludes the VRF fee).
- `minCuratedOddsBps`: floor on the combined probability that a draw selects a curated NFT.
- `maxShapeCapital`: maximum Shapes backing in any approved plan (checked at configure time).
- `markupBps`: fixed operating markup (0–100%). Every FWA listing price is `base × (1 + markup)`: the creator's value for
  curated NFTs, the backing for Shapes. A change sets `repricing`; upkeep reprices every listing before reopening.
- `plans`: 1–4 approved Shape inventories, each nine 16-bit counts (denomination 0 = 0.01 ETH … 8 = 100 ETH), at most 40
  Shapes. The first is preferred.

Upkeep keeps the active plan while it satisfies all limits with the current curated set; otherwise it activates the first
feasible approved plan. Shapes above a new target are unlisted into spares; deficits use spares first, then mint
like-for-like. There is no on-chain solver and no splitting or composing of Shapes. If no plan is feasible, purchases close.

Feasibility uses FWA's exact integer formulas: listing weight `1e36 / price`, fee `(Σw·p / Σw) × (1 + edge)`.

## Admission gate (`canPurchase`)

FWA calls the purchase operator once per `acquire`/`acquireBatch` (up to 5 draws) with a 100k gas stipend and only the
purchaser address. The Balancer therefore admits at most one batch per checkpoint:

1. creator has opened purchases;
2. the last checkpoint is valid and FWA's `lastIssuedSequence` and `inventoryVersion` still equal it (any purchase advances
   the sequence, so the next buyer is refused until upkeep reconciles);
3. FWA token offers are disabled;
4. Shapes `mintFee()` is not above the fee the reserve was funded for;
5. liquid ETH ≥ the checkpoint reserve;
6. FWA `acquisitionFee()` ≤ `maxDrawPrice`.

A checkpoint is written only when the Shapes inventory equals the active plan, FWA's `totalWeight` and
`weightedBackingTotal` equal curated + plan exactly, the plan satisfies price/odds/capital, and liquid ETH covers the
reserve. Measured cost: ~30k gas.

Outstanding FWA draws, refunds, deliveries and claims never depend on the Balancer or the keeper.

## Reserve

`requiredReserve` (0 while closed):

- cost to restore the active plan from current listed + spare Shapes (backing + current mint fee each), plus
- the worst 5 Shape replacements from a full plan, where each spare not needed for a deficit covers one draw of its
  denomination, plus
- one maximum keeper reward (`3.2M gas × 10 gwei + 0.0005 ETH = 0.0325 ETH`).

ETH inside Shapes and unsettled draw payments are never counted as liquid. `claimSurplus` releases only
`balance − requiredReserve`. `unwind` (closed only) withdraws listed Shapes and redeems all spares for their exact
backing.

## Upkeep

`performUpkeep` (permissionless, reverts `PoolBusy` while FWA has an unresolved acquisition, `NoUpkeepNeeded` when it
would change nothing):

1. reconcile every FWA sequence issued since the last reconciliation (≤ 5): drawn listings leave the tracked set; failed
   deliveries are tracked as pending;
2. pending deliveries: settled → forgotten; refunded → `recoverRefundedNFT` (Shapes become spares, curated NFTs are held
   for the creator);
3. collect FWA owner proceeds;
4. if open: reprice (≤ 6 listings per call), select a feasible plan, rebalance (≤ 6 Shape operations per call), verify FWA
   totals, checkpoint if funded.

Keeper reward: `min(gasUsed + 45k, 3.2M) × min(tx.gasprice, basefee + 2 gwei, 10 gwei)`, plus `0.0005 ETH` when inventory
work was done (draw reconciled, Shape listed/unlisted, listing repriced, refunded NFT recovered). A reconciled batch with
only refunds earns gas reimbursement without the incentive. Pure re-checkpoints (after creator changes or deposits) pay
nothing. The reward is force-sent, so a reverting keeper cannot block upkeep.

## Curated NFTs

`listCurated` / `listCuratedBatch` pull from the creator (approve the Balancer first) and list on FWA. Shapes cannot be
listed as curated. All curated edits require FWA idle and reconciled (`PoolBusy` otherwise) and invalidate the checkpoint.
If FWA cannot deliver a drawn NFT, the purchaser may refund after FWA's 7-day window; the NFT is then recovered by upkeep
or directly by the creator (`recoverCuratedNFT`).

## Lifecycle

`close` → `unwind` (repeat) → `withdrawCurated` → `claimSurplus`. `retire` (closed only) calls FWA `retirePool`, which is
permanent; withdrawals and recovery keep working.

## ENS

`setENSName` / `clearENSName` call `setName` on whichever contract owns `addr.reverse` in the ENS registry. A primary name
also needs the name's ETH address record set to the Balancer (dashboard checks both). Optional.

## Off-chain

- `shared/planner.ts`: plan evaluation and bounded enumeration with the contract's exact arithmetic (fork parity test).
- `keeper/`: one service for all Balancers of a factory.
- `app/`: creator dashboard. No player interface.
- `sim/`: Monte Carlo economics.

## Design decisions

| Decision | Reason |
| --- | --- |
| Checkpoint = FWA sequence + inventory version | Cheap (2 SLOADs) and exact: any purchase or inventory change invalidates it. |
| Pre-approved fallback plans instead of an on-chain search | Bounded, auditable; the keeper only applies creator-approved inventories. |
| Never list while FWA has an unresolved acquisition | Nothing is ever staged, so FWA's active totals equal the tracked set. |
| Clone factory, `via_ir` | Cheap deployment per creator; runtime 22.4 KB under EIP-170. |
| Hard-coded denomination ladder, checked against `Shapes.denominationAt` at deployment | Avoids external calls in hot paths. |
| No ERC-1271 signing | FWA's off-chain pool-page edits need an owner signature; adding contract signatures widens the authority surface for an unconfirmed benefit. See READINESS.md. |
