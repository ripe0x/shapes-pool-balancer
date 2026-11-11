# Functional specification

Status: implemented at the commit that contains this file. Supersedes earlier designs (spare Shapes, on-chain capital
limit, `needsUpkeep`, uncapped keeper priority fees).

## What it is

A creator runs an FWA standard pool whose inventory is their curated NFTs plus ETH-backed Shapes. A `PoolBalancer`
contract creates and permanently owns the FWA pool. Players buy on FWA's site exactly as for any other pool. When Shapes
leave the pool, anyone may call `performUpkeep` to restore the configured Shapes inventory from the Balancer's own ETH.

## Contracts

| Contract | Role |
| --- | --- |
| `BalancerFactory` | Ownerless. Deploys one EIP-1167 clone of `PoolBalancer` per call (`createBalancer(salt)`), forwards any ETH as a deposit, emits `BalancerCreated(creator, balancer, pool, salt)`. Keeps no authority over clones. |
| `PoolBalancer` | Non-upgradeable logic shared by all clones. Immutables pin the FWA factory, the reviewed FWA implementation and its runtime code hash, Shapes, this system's Draw Packs instance and the ENS registry. |
| `PoolPage` | External library (pure) that builds the FWA pool-page message digest; kept outside `PoolBalancer` for the 24 KB limit. |
| Draw Packs | `ShapePacks` from ripe0x/shape-packs `draw-packs` at `3a463f7` (vendored, unmodified, the code ape-Ball deploys), deployed once per system by `script/Deploy.s.sol` with a 2-unit (0.02 ETH) minimum. An ERC-721 holding Shapes in custody; `redeem` pays exactly their backing. Its admin controls presentation only (renderer, description). |

`initialize` (called by the factory in the same transaction) verifies the FWA implementation code hash and the 5-purchase
batch limit, calls `PoolFactory.createPool(0, reviewedImplementation)` so the Balancer becomes the FWA owner (FWA allows
one pool per owner address, so one pool per Balancer), installs itself as the FWA purchase operator, and approves the pool
for its Shapes. Nothing can ever change the operator, enable token offers or execute arbitrary calls.

## Roles

| Actor | Can |
| --- | --- |
| Creator | configure, open/close, list/reprice/withdraw/recover curated NFTs, return untracked NFTs, claim surplus, unwind, retire, set ENS name, approve or revoke FWA pool-page publications, start creator transfer |
| Pending creator | accept the creator role |
| Anyone (keeper) | `performUpkeep`, `recoverRefundedShape`, `collectProceeds`, `depositETH` |
| FWA pool | calls `canPurchase` (view) |

The keeper's only payout is a bounded reward to `msg.sender`. Curated and untracked NFTs go only to a creator-chosen
address; Shapes go only to the FWA pool or are redeemed into the Balancer. ETH deposited or sent to the Balancer by
anyone, and NFTs sent to it directly, belong to the creator; there is no contributor refund.

## Configuration

`configure(Config, plans[])`:

- `maxDrawPrice`: ceiling on FWA `acquisitionFee()` (includes FWA's 5% edge, excludes the VRF fee).
- `minCuratedOddsBps`: floor on the combined probability that the first draw after a checkpoint selects a curated NFT.
  Later draws in the same batch see the inventory the earlier ones left.
- `markupBps`: fixed operating markup (0–100%). Every FWA listing price is `base × (1 + markup)`: the creator's value for
  curated NFTs, the backing for Shapes. A change sets `repricing`; upkeep reprices every listing before reopening.
- `plans`: 1–4 approved prize inventories, each sixteen 16-bit counts, 1–40 prizes. Sizes 0–8 are the Shapes
  denominations (0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100 ETH), each prize one Shape. Sizes 9–15 are 0.02, 0.03, 0.2,
  0.25, 2, 2.5 and 25 ETH, each prize one Draw Pack holding the fewest Shapes that sum to it (2 or 3; e.g.
  0.25 = 2×0.1 + 0.05). Plans saved with only the first nine sizes decode unchanged. The first is preferred. Each plan fixes its own capital, so there is no separate on-chain capital limit; the
  dashboard planner filters plans by a capital preference and shows the total ETH committed.

Upkeep keeps the active plan while it satisfies the price and odds limits with the current curated set; otherwise it
activates the first feasible approved plan. Shapes above a new target are withdrawn from FWA and redeemed for their backing
in the same call; deficits are minted like-for-like (a pack prize is a new pack whose Shapes are minted inside it). No
on-chain solver and no new plans; packs are only created whole and redeemed whole.
If no plan is feasible, purchases close (status 5).

Feasibility uses FWA's exact integer formulas: listing weight `1e36 / price`, fee `(Σw·p / Σw) × (1 + edge)`.

## Admission gate (`canPurchase`)

FWA calls the purchase operator once per `acquire`/`acquireBatch` (up to 5 draws) with a 100k gas stipend and only the
purchaser address. The Balancer therefore admits at most one batch per checkpoint:

1. the purchaser FWA will deliver to is not the Balancer, the Shapes contract or the FWA pool (deliveries to them
   could never be refunded or tracked);
2. creator has opened purchases;
3. the last checkpoint is valid and FWA's `lastIssuedSequence` and `inventoryVersion` still equal it (any purchase advances
   the sequence, so the next buyer is refused until upkeep reconciles);
4. FWA token offers are disabled;
5. Shapes `mintFee()` is not above the fee the reserve was funded for;
6. liquid ETH ≥ the checkpoint reserve;
7. FWA `acquisitionFee()` ≤ `maxDrawPrice`.

A checkpoint is written only when the Shapes inventory equals the active plan, FWA's `activeListingCount`, `totalWeight`
and `weightedBackingTotal` equal curated + plan exactly, the plan satisfies price and odds, and liquid ETH covers the
reserve. Measured cost: ~47–49k gas under the real 100k stipend.

Status 0 means the Balancer admits a purchase. FWA can still refuse one on its own state (pause, cooldown, VRF service
capacity). Within a batch, FWA can refund a draw's acquisition fee instead of delivering when earlier draws moved the
price; the VRF fee is not refunded.

Outstanding FWA draws, refunds, deliveries and claims never depend on the Balancer or the keeper.

## Reserve

`requiredReserve` (0 while closed):

- cost to restore the active plan from the prizes currently listed (backing + current mint fee per Shape inside), plus
- the worst 5 prize replacements from a full plan: the 5 largest values, each charged backing + 3 mint fees (the most
  Shapes any prize holds), an upper bound on any 5 prizes' true cost whatever the mint fee, plus
- one maximum keeper reward (`3.2M × 5 gwei + 0.0005 ETH = 0.0165 ETH`) held for each upkeep call that restores
  an admitted batch, at any price up to the cap: the Shape units of the 5 prizes holding the most Shapes over 6,
  rounded up (1 for single Shapes, up to 3 when five three-Shape packs are drawn), plus
- one reward for the call that writes the next checkpoint and one per refill step still needed (6 Shape units per
  step, a pack counting its Shapes), each
  `3.2M × current reimbursable price + 0.0005 ETH`. `_checkpoint` re-checks this at its own transaction's price,
  so a later gas spike only delays reopening. Funding exactly `requiredReserve()` opens a new pool (fork tests at 0.08,
  0.5 and 4.95 gwei).

ETH inside Shapes and unsettled draw payments are never counted as liquid. The Balancer keeps no managed Shapes
between transactions, so there is no spare credit (a Shape delivered to it because a buyer named it as purchaser is
untracked and creator-recoverable). `claimSurplus` releases only `balance − requiredReserve` and, while open, only
when every FWA draw has been reconciled. This holds for the plan and mint fee in force: configuring a costlier plan, or a
mint-fee rise, raises `requiredReserve` and closes admission until funded. `unwind` (closed only) withdraws up to 20 listed Shapes per call and redeems them
for their exact backing.

## Upkeep

`performUpkeep` (permissionless; returns the reward; reverts `PoolBusy` while FWA has an unresolved acquisition and
`NoUpkeepNeeded` when it would change nothing — simulating it is how keepers learn whether work exists):

1. reconcile every FWA sequence issued since the last reconciliation (≤ 5): drawn listings leave the tracked set; a failed
   delivery marks the item `PENDING` (never scanned again by upkeep);
2. collect FWA owner proceeds;
3. if open: reprice, select a feasible plan, rebalance, verify FWA totals, checkpoint if funded. Repricing and
   rebalancing share one budget of 6 operations per call. Repricing rescans all ≤ 100 listings each call, so a removal
   cannot skip one and an interrupted run resumes. A plan that would not fit beside the curated listings within the
   100-listing limit is infeasible. A checkpoint also requires one extra maximum keeper reward, so admission still
   holds after the checkpointing call pays its keeper.

No upkeep loop depends on history: refunded or stuck deliveries cost nothing per upkeep (fork test: 200 refunded curated
deliveries, routine upkeep gas 847k before vs 836k after).

`recoverRefundedShape(listingId)` (permissionless): for a Shape whose FWA delivery was refunded, recovers it from FWA and
redeems it for its backing; pays gas only. FWA delivers with `transferFrom`, and Shapes rejects only transfers to itself,
so a Shape delivery fails only when the purchaser named is the Shapes contract.

Keeper reward:

- price = `min(tx.gasprice, basefee + 0.05 gwei, 5 gwei)`: a keeper that bids more priority pays the excess itself;
- gas = `min(measured, 3.2M) × 4/5`: EIP-3529 refunds cut billed gas by at most 1/5 of the gas used, so 4/5 of any
  measured span is always billed, even when one transaction makes several paid calls;
- incentive for inventory work (draw reconciled, Shape listed/withdrawn, listing repriced) =
  `min(measured, 3.2M) × 1/5 × price + 0.0005 ETH`: the withheld fifth plus a fixed part that covers gas outside the
  measured span (intrinsic, calldata) and the `eth_estimateGas` gap keepers cost work with, so paid work stays
  profitable up to the 5 gwei cap. No per-call intrinsic credit (it multiplied when one transaction made several
  calls). Work started by a creator action (configure, opening a closed pool, curated edits,
  unwind) pays it in full until the next checkpoint; each of those closes admission first. This includes actions that
  change nothing and the reconciliation and refill of a batch issued before the action (bounded by one creator's own
  incentives). Work caused by purchases
  pays it from `incentiveCredit`, which each reconciled batch resets to FWA's edge on that batch's escrowed fees and
  every following paid call spends, so buying one's own draws earns at most the edge paid to FWA. The credit limits a
  payment from the Balancer's ETH; FWA's edge itself goes to FWA. Only delivered
  draws count: a failed delivery's fee can be refunded in full, edge included. A batch with only refunds earns the 4/5
  gas part only; `recoverRefundedShape` the same (paying the withheld fifth there would rest on fixed overhead, which
  a transaction making several such calls pays once). Pure re-checkpoints (after creator
  changes or deposits) pay nothing. The reward is force-sent, so a reverting keeper cannot block upkeep.

## Curated NFTs

`listCurated` / `listCuratedBatch` pull from the creator (approve the Balancer first) and list on FWA. Shapes cannot be
listed as curated. All curated edits require FWA idle and reconciled (`PoolBusy` otherwise) and invalidate the checkpoint
before any external call. If FWA cannot deliver a drawn NFT, the purchaser may refund after FWA's 7-day window; the creator
then recovers it with `recoverCuratedNFT`. Upkeep never calls a curated collection.

Custody depends on the collection: one whose contract can move, burn or freeze listed tokens can take or strand a
curated NFT, and FWA keeps such a listing drawable until its delivery fails and is refunded. A listing's price uses the
markup at the start of the listing call; a creator's own collection that reconfigures during that call is not repriced.

`recoverUntrackedNFT(collection, tokenId, to)` returns an NFT the Balancer holds outside FWA (sent to it directly).
Tracked inventory is never held by the Balancer between transactions (listings and pending deliveries are owned by the
FWA pool), so `ownerOf == this`, checked under the reentrancy lock, proves the NFT is untracked. It never calls the FWA pool
or factory.

## Lifecycle

`close` → `unwind` (repeat) → `withdrawCurated` → `claimSurplus`. `retire` (closed only) calls FWA `retirePool`, which is
permanent; withdrawals and recovery keep working.

## ENS

`setENSName` / `clearENSName` call `setName` on whichever contract owns `addr.reverse` in the ENS registry. A primary name
also needs the name's ETH address record set to the Balancer (dashboard checks both). Optional.

## FWA pool page (ERC-1271)

FWA stores pool-page metadata off-chain and asks the pool owner to `personal_sign` a fixed plain-text message
(`Publish FWA Pools page`, site, chain 1, factories, pool, issued-at time, metadata hash), POSTed to
`pools.fwa.fun/api/fwa/profile`. The Balancer is the owner and cannot sign, so `approvePoolPage(issuedAt, metadataHash)`
(creator only) rebuilds that exact message for its own pool and stores its EIP-191 digest; `isValidSignature` returns the
ERC-1271 magic value only for digests approved in the current epoch and ignores the signature bytes. `revokePoolPages`
(creator) and every accepted creator transfer start a new epoch. Approved digests are always pool-page
messages naming this pool. The magic value is returned for any caller and any signature bytes, so another protocol
accepts one only if it treats that exact message as its own authorization. Verified on a fork with viem `verifyMessage`. Not
verified: whether FWA's server checks ERC-1271 (its client allows long contract signatures; server code is not public).

## Off-chain

- `shared/planner.ts`: plan evaluation and bounded enumeration with the contract's exact arithmetic (fork parity test).
- `keeper/`: one service for all Balancers of a factory; simulates calls, sends only when the reward covers cost under
  its policy, recovers refunded Shapes.
- `app/`: creator dashboard. No player interface.
- `sim/`: Monte Carlo economics, including the previous design for comparison.

## Design decisions

| Decision | Reason |
| --- | --- |
| Checkpoint = FWA sequence + inventory version | Cheap and exact: any purchase or inventory change invalidates it. |
| Pre-approved fallback plans instead of an on-chain search | Bounded, auditable; the keeper only applies creator-approved inventories. |
| Never list while FWA has an unresolved acquisition | Nothing is ever staged, so FWA's active totals equal the tracked set. |
| Redeem surplus Shapes instead of keeping spares | Removes spare storage and spare credit from reserve math; managed Shapes never sit in the Balancer. Costs one mint fee per Shape re-minted when plans switch back (simulation: 0.02–0.11 ETH per 30 days at 10–42 switches; no change in closed time). |
| Delivery failures resolved per item, never scanned | Upkeep gas cannot grow with refund history or hostile collections. |
| 4/5 gas + (1/5 gas + 0.0005 ETH) incentive, 0.05 gwei priority cap | 4/5 is the only in-transaction rule that provably never reimburses more gas than billed; the incentive returns the other fifth only for useful work and within the edge credit, plus 0.0005 ETH that keeps upkeep economical to the 5 gwei cap for keepers pricing with `eth_estimateGas`. Competing keepers bid the reimbursed priority, so a higher cap is a surcharge on every upkeep (1 gwei: +91% keeper spend, no faster inclusion). |
| Clone factory, `via_ir`, 50 optimizer runs | Cheap deployment per creator; runtime 24,412 B under EIP-170 (24,576 B), with the pool-page message builder in the `PoolPage` library. |
| Hard-coded size table (packed constants), Shapes sizes checked against `Shapes.denominationAt` and the Packs instance checked to wrap the same Shapes with a minimum at most 0.02 ETH, at deployment | Avoids external calls in hot paths. |
| A fixed menu of 16 prize sizes instead of arbitrary values | Keeps plans, per-size counts, reserve and weight checks structurally unchanged; a 1–2–2.5–5 ladder lands within about 25% of any target value. |
