# Functional specification

Status: implemented at the commit that contains this file. Supersedes earlier designs (spare Shapes, on-chain capital
limit, `needsUpkeep`, uncapped keeper priority fees, the exact checkpoint, pre-approved fallback plans, the draw-price
ceiling, the NFT odds floor, the worst-batch reserve, repricing, `unwind` and the 100-listing cap).

## What it is

A creator runs an FWA standard pool whose inventory is their curated NFTs plus ETH-backed prizes (Shapes and Draw Packs).
A `PoolBalancer` contract creates and permanently owns the FWA pool. Players buy on FWA's site exactly as for any other
pool. As prizes are won, anyone may call `performUpkeep` to restock toward the target mix from the Balancer's own ETH.

## Contracts

| Contract | Role |
| --- | --- |
| `BalancerFactory` | Deploys one EIP-1167 clone of `PoolBalancer` per call (`createBalancer(salt)`), forwards any ETH as a deposit, emits `BalancerCreated(creator, balancer, pool, salt)`. Holds the keeper list every clone reads; its keeper admin can only restrict upkeep to approved keepers or open it to anyone (the default). No other authority over clones, their pools or assets. |
| `PoolBalancer` | Non-upgradeable logic shared by all clones. Immutables pin the FWA factory, the reviewed FWA implementation and its runtime code hash, Shapes, this system's Draw Packs instance and the ENS registry. |
| `PoolPage` | External library (pure) that builds the FWA pool-page message digest; kept outside `PoolBalancer` for the 24 KB limit. |
| Draw Packs | `ShapePacks` from ripe0x/shape-packs `draw-packs` at `3a463f7` (vendored, unmodified, the code ape-Ball deploys), deployed once per system by `script/Deploy.s.sol` with a 2-unit (0.02 ETH) minimum. An ERC-721 holding Shapes in custody; `redeem` pays exactly their backing. Its admin controls presentation only (renderer, description). |

`initialize` (called by the factory in the same transaction) verifies the FWA implementation code hash and the 5-purchase
batch limit, calls `PoolFactory.createPool(0, reviewedImplementation)` so the Balancer becomes the FWA owner (FWA allows
one pool per owner address, so one pool per Balancer), installs itself as the FWA purchase operator, and approves the pool
for its Shapes and Draw Packs. Nothing can ever change the operator, enable token offers or execute arbitrary calls.

## Roles

| Actor | Can |
| --- | --- |
| Creator | configure, open/close, list/update/withdraw curated NFTs, recover a refunded NFT or prize, return untracked NFTs, claim surplus, unlist prizes, retire, set ENS name, approve or revoke FWA pool-page publications, start creator transfer, always run its own pool's upkeep |
| Pending creator | accept the creator role |
| Keeper admin (factory) | restrict upkeep on every pool to approved keepers or open it to anyone, approve or remove keepers, start keeper-admin transfer (the pending admin accepts) |
| Anyone (keeper) | `performUpkeep` (while the factory's list is open, the default; when restricted, approved keepers and each pool's creator), `collectProceeds`, `depositETH` |
| FWA pool | calls `canPurchase` (view) |

The keeper's only payout is a bounded reward to `msg.sender` of `performUpkeep`. Curated and untracked NFTs go only to a
creator-chosen address; prizes go only to the FWA pool or are redeemed into the Balancer. ETH deposited or sent to the
Balancer by anyone, and NFTs sent to it directly, belong to the creator; there is no contributor refund.

## Configuration

`configure(markupBps, target)`:

- `markupBps`: a fixed operating markup (10% to 100%), the creator's to keep. It is the only profit in a price, so it
  is what refills the reserve after a big win. A curated NFT lists at its value ×
  (1 + markup). A prize (Shape or Draw Pack) lists at its backing + one Shapes mint fee per Shape inside + backing ×
  markup + one restocking fee per Shape inside: players pay the mint fee and keepers on top of the markup. The
  restocking fee is `restockFee()` = 900k gas × min(basefee + 0.05 gwei, 5 gwei) + 0.0002 ETH, at the basefee of the
  listing block; it pays the keeper call that lists the prize. Prices are set when a listing is made. Existing listings keep their prices; nothing is repriced.
- `target`: the prize mix, sixteen 16-bit counts packed into one uint256, 1 to 80 prizes in total. Sizes 0 to 8 are the
  Shapes denominations (0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100 ETH), each prize one Shape. Sizes 9 to 15 are 0.02, 0.03,
  0.2, 0.25, 2, 2.5 and 25 ETH, each prize one Draw Pack holding the fewest Shapes that sum to it (2 or 3; e.g.
  0.25 = 2×0.1 + 0.05). A target set with only the first nine sizes decodes unchanged.

`configure` also records the current Shapes `mintFee()` as `mintFeeCap`: purchases and restocking stop while the fee is
above it. There is one target: no fallback plans, no on-chain solver, no separate capital limit (the target fixes its own
capital; the dashboard planner shows the total ETH committed). A smaller target leaves the extra prizes listed until the
creator unlists them with `unlistShapes`. Upkeep restocks toward the target; it never changes the target.

FWA weighs each listing `1e36 / price`. For the fill check the Balancer weighs a prize at its price less its
restocking fees (`base`: backing, mint fees and markup), so fill does not move with gas: `configure` sums that weight
over the target as `targetWeight` (at the current mint fee), and `prizeWeight` tracks it for the prizes actually
listed.

## Admission gate (`canPurchase`)

FWA calls the purchase operator once per `acquire`/`acquireBatch` (up to 5 draws) with a 100k gas stipend and only the
purchaser address. `canPurchase` returns false if the purchaser FWA will deliver to is the Balancer, the Shapes contract,
the Draw Packs contract or the FWA pool (a draw delivered to them could never be refunded or tracked), then returns
`admissionStatus() == 0`.

`admissionStatus()` returns one code:

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | OK | the Balancer admits a purchase |
| 1 | CLOSED | the creator has not opened purchases, or has closed them |
| 2 | SETTING_UP | a creator action started restocking work that upkeep has not finished |
| 3 | NO_CURATED | no curated NFT is listed (every active listing is a prize) |
| 4 | BUSY | 5 draws are unsettled on FWA |
| 5 | MINT_FEE_ROSE | the Shapes mint fee is above the one the creator accepted |
| 6 | LOW_INVENTORY | listed prize weight (1 / backing per prize), less the unreconciled-draw allowance, is below 70% of the target's weight |

FWA prices every draw on live inventory and refunds a draw whose price moved past the player's tolerance, so the gate does
not need an exact inventory. It is not one batch per admission: several batches may be admitted between upkeeps, and FWA
pauses the pool itself once 5 draws are unsettled. The fill check (code 6) uses tracked prize weight, which includes
staged restocks, because FWA calls the hook before it activates staged listings. The unreconciled-draw allowance charges
each issued-but-unreconciled draw the weight of the smallest prize (0.01 ETH at zero markup), the heaviest weight any
prize can have, so the check assumes every such draw removed the heaviest possible prize.

Purchases do not wait for ETH (DECISIONS 66). Each prize's price covers replacing it, and the markup (at least 10%)
is profit on top, so sales keep the pool funded on average. The reserve's spare restocks a big win at once; sales then
refill the reserve while `claimSurplus` releases nothing. If prizes are won faster than the spare and sales cover
(back-to-back big wins, or a batch of up to five), the missing prizes are restocked smallest first as sales add ETH,
and purchases continue on what is listed; the fill check still pauses a pool whose board falls below 70%. `open()`
reverts `ReserveNotFunded` unless ETH plus settled proceeds covers `requiredReserve()`, so a pool never opens, or
reopens after its ETH was claimed, without the ETH to stock its target and restock a big win (round 8 E2).

Status 0 means the Balancer admits a purchase. FWA can still refuse one on its own state (pause, cooldown, VRF service
capacity). Within a batch, FWA can refund a draw's acquisition fee instead of delivering when earlier draws moved the
price; the VRF fee is not refunded.

Outstanding FWA draws, refunds, deliveries and claims never depend on the Balancer or the keeper.

## Money flows

FWA settles payments; the Balancer only holds the creator's ETH, mints and lists prizes, and pays keepers. The simulation
ledger (`docs/simulation-results.md`) reconciles every scenario to the wei and finds 0 ETH stranded after closing and
unlisting. These are model estimates, not guarantees.

Who puts value in:

- the creator deposits ETH (at creation, `depositETH`, or a direct send) and lists NFTs;
- each player pays FWA the draw fee (expected value + FWA's 5% edge + the operating markup) plus a VRF fee.

Who is owed value:

- winners hold prizes (Shapes and Draw Packs) redeemable for their backing, and won NFTs;
- a player whose draw FWA refunds is owed that acquisition fee by FWA until the refund is taken;
- FWA is owed its 5% edge on delivered draws, and the VRF service its fee;
- the Shapes contract (and Draw Packs, which pays Shapes) receives the mint fee for each Shape minted;
- keepers are owed the bounded reward for each call that reconciles draws or restocks, from the creator's ETH
  (`docs/DECISIONS.md` 73).

Who can take value out:

- while open, the creator can withdraw with `claimSurplus` everything above `requiredReserve`, or, while the fund is
  below it, their unclaimed `profit` (see Reserve);
- after closing and unlisting, the creator can withdraw everything except the keeper pay held for draws not yet
  reconciled: while closed, `requiredReserve` is one `MAX_KEEPER_REWARD` (0.01635 ETH) per 5 such draws (owner decision
  D3, 2026-11-13). Upkeep that reconciles those draws is paid from it, and what it does not spend becomes claimable once
  everything is reconciled. Closing stops purchases, so the held amount only falls.

One-way transfers (value that leaves and never returns): the Shapes mint fee, FWA's edge, the VRF fee and keeper rewards.
Mint fees and a restocking fee are priced into Shape prizes. The pool's ETH pays a prize's mint fees and the keeper who
lists it when the prize is made. Both are built into the prize's price, and FWA's single draw price spreads them over all buyers, whatever each wins (owner decision D5). The restocking fee is the
creator's income toward keeper pay, not a limit on it: draws that win an NFT or time out bring no fee, so the keeper
calls that reconcile them are the creator's cost, as are the fees of prizes never won (unlisted, refunded after a failed
delivery, or still listed at close). At any moment the fronted restocking fees are at most the listed Shapes ×
`restockFee()` (0.0047 ETH per Shape at the cap).
Backing is not one-way: a prize is redeemed for exactly its backing on unlisting, a target shrink, or refund recovery.

The reserve is the creator's own ETH held inside the Balancer. The creator cannot withdraw it while the pool is open;
upkeep draws on it to mint the prizes that restock won inventory, and player payments collected as proceeds refill it.
It bounds withdrawals so upkeep can always restock what an admitted draw removes.

## Reserve

`requiredReserve` (while closed: only the keeper pay for unreconciled draws, see above) holds, while open:

- the cost to restore the target from the prizes currently listed: for each short size, the missing count × (backing +
  the current mint fee per Shape inside); plus
- one largest prize for each unreconciled draw and one spare, so a big win is restocked: (unreconciled draws + 1) × the
  most expensive prize in the target (its backing plus the mint fee for each Shape inside it); plus
- keeper rewards: one maximum reward (`(3.2M + 50,000) × 5 gwei + 0.0001 ETH = 0.01635 ETH`) per 5-Shape-unit restocking call needed,
  rounded up, plus one (the missing Shape units, plus 3 units for each unreconciled draw and the spare).

ETH inside prizes and unsettled draw payments are never counted as available. The Balancer holds no prize between
transactions, so there is no spare credit (a prize delivered to it because a buyer named it as purchaser is untracked and
creator-recoverable). The reserve is the creator's money; it is not withdrawable while the pool is open. A costlier
target or a mint-fee rise raises `requiredReserve`. Purchases continue while ETH is below it, and `open()` needs it in
ETH.

**Profit and the fund (DECISIONS 67, 68).** The first 10% of markup (`MIN_MARKUP_BPS`) is the game's: it refills the
reserve. The markup above it is the creator's profit. Each collected FWA payment is split by the listed prices. FWA
weights each listing by 1 / price, so the creator's share of a payment is `profitShareSum / (active listings × 1e18)`,
where `profitShareSum` adds, for every active Shape prize, the markup above 10% on its backing (at the markup it was
listed at) divided by its price. Curated NFTs count zero: the split uses the listings at collection, so counting them
would let a creator list NFTs just before a collection to move fund money into profit. A Shape's share is below
markup / (1 + markup), at most 1/2, so the fund keeps at least half of every payment, NFT sale money included. The fund
is the balance less unclaimed `profit`. While the fund is below `requiredReserve`, the creator's share is added to
`profit` and the fund keeps the rest; at or above it, everything over the reserve is claimable. `withdrawableSurplus` is the larger of
`profit` and `balance − requiredReserve`, and a claim spends `profit` first, so a claim never takes the fund below the
reserve or below where it was. Game first: when the fund cannot pay a restock, upkeep spends unclaimed profit (`profit`
is cut to the balance). Closing zeroes `profit`: while closed, the whole balance is claimable except the keeper pay held for unreconciled draws.

`unlistShapes(listingIds)` withdraws up to 20 listed prizes per call and redeems each for its exact backing: the extra
prizes after a smaller target, or everything after closing. FWA allows it only while no draw is unsettled. Prizes
unlisted below the target while open are restocked by upkeep.

## Upkeep

`performUpkeep` (open to anyone by default; returns the reward; reverts `NoUpkeepNeeded` when it would change nothing,
which keepers learn by simulating it). The factory's keeper admin can restrict it, for every pool at once, to the
keepers it approves (`BalancerFactory.setKeepersRestricted`, `setKeeperApproved`; others get `KeeperNotApproved`); each
pool's creator can always run its own. The reward rules are the same either way; while restricted, a pool whose approved
keepers stop is restocked only when its creator runs upkeep.

1. reconcile settled FWA sequences in order, up to 5 per call: a drawn listing leaves the tracked set; a failed delivery
   marks the item `PENDING` (never scanned again by upkeep).
2. collect FWA owner proceeds into the Balancer.
3. while open, not retired, not globally withdraw-only, and the mint fee is at or below `mintFeeCap`: mint the missing
   prizes, smallest value first, within 5 Shape units, 4 prize sizes and the ETH left after this call's keeper reward, and list them in
   one FWA batch. FWA stages the batch while draws are unsettled and activates staged listings in order. When a creator
   action's restocking work finishes (the target is restored), the SETTING_UP flag clears.

Upkeep restocks while draws are still unsettled; it does not wait for the pool to be idle. No upkeep loop depends on
history: refunded or stuck deliveries are `PENDING` and cost nothing per upkeep.

Keeper reward, paid for any call that reconciles draws or restocks (a call that only collects proceeds pays nothing):

- price = `min(tx.gasprice, basefee + 0.05 gwei, 5 gwei)`: a keeper that bids more priority pays the excess itself;
- reward = `(min(measured, 3.2M) + 50,000) × price + 0.0001 ETH`, from the creator's ETH (the fund first, unclaimed
  profit only once the fund is empty), for every call that reconciles a draw or lists a prize, open or closed
  (`docs/DECISIONS.md` 73; both constants provisional). The 50,000 is gas a transaction pays outside the measured span
  (measured 24k-46k); the 0.0001 ETH is the keeper's margin;
- what a call does is fixed by state (every processed sequence up to 5, the whole deficit up to 5 Shape units), so work
  cannot be split into more paid calls, and each paid call needs a sequence FWA processed or a deficit. Buying one's own
  draws to create work pays FWA's edge and the VRF fee (2.34M gas at the same gas price) for at most the 0.0001 ETH
  margin per call (`test/KeeperPay.t.sol`). Above 5 gwei keepers wait and purchases pause at LOW_INVENTORY until gas
  falls.

The reward is force-sent, so a reverting keeper cannot block upkeep.

## Curated NFTs

`listCurated` / `listCuratedBatch` pull from the creator (approve the Balancer first) and list on FWA at
`base × (1 + markup)`. Shapes and Draw Packs cannot be listed as curated NFTs. `updateCuratedPrice` sets an NFT's value;
it is listed at that value plus the current markup, and FWA allows the change only while no draw is unsettled.
`withdrawCurated` withdraws an active NFT from FWA to a creator-chosen address, also only while no draw is unsettled.

Failed deliveries follow FWA's rules; the Balancer adds none of its own (owner decision 2026-11-13: the Balancer is a
pass-through for FWA here). From FWA's verified source (`external/fwa-poolsv2`, `StandardPool.sol`):
- at settlement FWA tries to transfer the NFT to the winner with 150,000 gas; if that fails, the listing is
  delivery-pending, the winner's draw price stays in FWA escrow and the pool owner is credited nothing;
- for 7 days (`DELIVERY_WINDOW`) anyone may retry the delivery (`retryNFTDelivery`); a retry that succeeds credits the
  draw normally;
- after the 7 days only the winner can take the refund (`refundFailedDelivery`, then `withdrawAcquisitionRefund`): the
  full draw price, FWA's edge included. The randomness fee is not refunded. There is no later deadline;
- only after that refund can the pool owner recover the NFT; the creator calls `recoverRefunded(listingId, to)`, which
  sends a curated NFT to `to`, or redeems a drawn prize for its backing and returns that ETH. Recovery also needs the
  collection to allow the transfer.

So the closeout returns everything to the creator except an NFT whose delivery failed and whose winner has not taken the
refund, or whose collection refuses the recovery: that NFT, and the winner's escrowed price, stay at FWA under FWA's rules.
Upkeep never calls a curated collection, so a hostile collection cannot burn keeper gas or block upkeep.

Custody depends on the collection: one whose contract can move, burn or freeze listed tokens can take or strand a curated
NFT, and FWA keeps such a listing drawable until its delivery fails and is refunded. FWA treats a delivery that
transferred as final: a collection that lets its owner take tokens back can take a prize from its winner after FWA
credited the draw (`test/HostileCollection.t.sol`, `test_seize_afterDelivery`). Players rely on the collection, as on
any FWA pool. A listing's price uses the markup at
the start of the listing call; a creator's own collection that reconfigures during that call is not repriced.

`recoverUntrackedNFT(collection, tokenId, to)` returns an NFT the Balancer holds outside FWA (sent to it directly).
Tracked inventory is never held by the Balancer between transactions (listings and pending deliveries are owned by the
FWA pool), so `ownerOf == this`, checked under the reentrancy lock, proves the NFT is untracked. It never calls the FWA
pool or factory.

## Lifecycle

`close` → `unlistShapes` (repeat) → `withdrawCurated` → `claimSurplus`. `retire` (closed only) calls FWA `retirePool`,
which is permanent; withdrawals, unlisting and recovery keep working after it.

## ENS

`setENSName(name)` calls `setName` on whichever contract owns `addr.reverse` in the ENS registry; `setENSName("")` clears
the record. A primary name also needs the name's ETH address record set to the Balancer (dashboard checks both). Optional.

## FWA pool page (ERC-1271)

FWA stores pool-page metadata off-chain and asks the pool owner to `personal_sign` a fixed plain-text message
(`Publish FWA Pools page`, site, chain 1, factories, pool, issued-at time, metadata hash), POSTed to
`pools.fwa.fun/api/fwa/profile`. The Balancer is the owner and cannot sign, so `approvePoolPage(issuedAt, metadataHash)`
(creator only) rebuilds that exact message for its own pool and stores its EIP-191 digest; `isValidSignature` returns the
ERC-1271 magic value only for digests approved in the current epoch and ignores the signature bytes. `revokePoolPages`
(creator) and every accepted creator transfer start a new epoch. Approved digests are always pool-page messages naming
this pool. The magic value is returned for any caller and any signature bytes, so another protocol accepts one only if it
treats that exact message as its own authorization. Verified on a fork with viem `verifyMessage`. Not verified: whether
FWA's server checks ERC-1271 (its client allows long contract signatures; server code is not public).

## Off-chain

- `shared/planner.ts`: target evaluation with the contract's exact arithmetic (fork parity test).
- `keeper/`: one service for all Balancers of a factory; simulates `performUpkeep` and sends only when the reward covers
  cost under its policy.
- `app/`: creator dashboard. No player interface.
- `sim/`: Monte Carlo economics and the money-flow ledger.

## Design decisions

| Decision | Reason |
| --- | --- |
| Markup applied when a listing is made, never repriced | Listed prizes and NFTs keep their price, so a markup change costs no `updatePrice` gas (FWA has no batch update). |
| One target mix, no fallback plans, ceiling or odds floor | The creator sets one mix; a smaller target is reached by unlisting extras. FWA prices and refunds each draw, so exact limits are not needed. |
| Gate on prize weight, not an exact inventory | FWA keeps each draw near its design by pricing and refunding on live inventory; the gate only keeps prize weight at or above 70% of the target's, and admits more than one batch between upkeeps. |
| Pause at 5 unsettled draws (MAX_BATCH) | Caps the draws FWA can refund for slippage in a burst (simulation: no cap refunded ~20% of draws in bursts). |
| Reconcile up to 5 settled sequences per call; restock while draws are unsettled | Upkeep keeps up with bursts, and FWA stages the restock until the draws settle. |
| Redeem prizes for backing instead of keeping spares | Prizes never sit in the Balancer between transactions; one mint fee per Shape re-minted when the target grows again. |
| Delivery failures resolved per item, never scanned | Upkeep gas cannot grow with refund history or hostile collections. |
| (Measured gas + 50,000) × price + 0.0001 ETH for every call that reconciles or lists, from the creator's ETH, 0.05 gwei priority cap (DECISIONS 73, constants provisional) | Draws that time out or win an NFT bring no restocking fee; paying their reconcile only from fees left them unreconciled until the fill gate closed (flow regime `randomness_not_delivered`: 55 draws refused before, 0 after). The restocking fee stays in each Shape prize's price as the creator's income toward keeper pay. Competing keepers bid the reimbursed priority, so a higher cap is a surcharge on every upkeep. |
| Withdrawal reserve = restore target + (unreconciled draws + 1) × largest prize + keeper rewards | Limits withdrawals and admits purchases only while held in ETH, so upkeep can always restock an admitted draw (simulation: without the spare, the top prize was missing half the time; round 8 E1, E2). |
| Clone factory, `via_ir`, 50 optimizer runs | Cheap deployment per creator; runtime under EIP-170's 24,576 B limit, with the pool-page message builder in the `PoolPage` library. |
| Hard-coded size table (packed constants), Shapes sizes checked against `Shapes.denominationAt` and the Packs instance checked to wrap the same Shapes with a minimum at most 0.02 ETH, at deployment | Avoids external calls in hot paths. |
| A fixed menu of 16 prize sizes instead of arbitrary values | Keeps per-size counts, reserve and weight checks structurally simple; a 1-2-2.5-5 ladder lands within about 25% of any target value. |
