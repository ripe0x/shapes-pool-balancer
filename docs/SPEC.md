# Functional specification

Current specification, 2026-11-18. The protected collected-revenue decisions in
[OWNER-REQUIREMENTS.md](../OWNER-REQUIREMENTS.md) supersede historical listing-markup attribution, allocation drift
criteria, unpaid credit consumption and separate creation/configuration/listing transactions. Historical reports
remain evidence for their named revisions only. [Implementation evidence](PROTECTED-REVENUE-RESULTS.md) records checks
and remaining limits; no deployment or real spending is authorized.

## What it is

A creator runs an FWA standard pool whose inventory is their curated NFTs plus ETH-backed prizes (Shapes and Draw Packs).
A `PoolBalancer` contract creates and permanently owns the FWA pool. Players buy on FWA's site exactly as for any other
pool. As prizes are won, anyone may call `performUpkeep` to restock toward the target mix from the Balancer's own ETH.

## Contracts

| Contract | Role |
| --- | --- |
| `BalancerFactory` | Deploys one EIP-1167 clone of `PoolBalancer` per call (`createBalancer(salt, config, curated)`), forwards any ETH as a deposit, emits `BalancerCreated(creator, balancer, pool, salt)`. Holds the keeper list and a recommended default policy snapshotted by future clones. Its keeper admin manages eligibility only; a separate policy admin changes the default immediately (future clones only) and holds the adjustable factory settings. No authority over prize backing, FWA pools or assets. |
| `PoolBalancer` | Non-upgradeable logic shared by all clones. Immutables pin the FWA factory, the reviewed FWA implementation and its runtime code hash, Shapes, this system's Draw Packs instance and the ENS registry. |
| `IKeeperPolicy` / `KeeperPolicyV1` | Stable read-only economic interface and initial stateless implementation; active policy selected separately by each pool. |
| `KeeperPolicyCalls` | Permanently linked selection, reserve and payout enforcement. Selected policies are invoked only through bounded static calls. |
| `PoolInventory` | Permanently linked inventory implementation, extracted to fit EIP-170; its address cannot be changed by a policy or administrator. |
| `PoolPage` | External library (pure) that builds the FWA pool-page message digest; kept outside `PoolBalancer` for the 24 KB limit. |
| Draw Packs | `ShapePacks` from ripe0x/shape-packs `draw-packs` at `3a463f7` (vendored, unmodified, the code ape-Ball deploys), deployed once per system by `script/Deploy.s.sol` with a 2-unit (0.02 ETH) minimum. An ERC-721 holding Shapes in custody; `redeem` pays exactly their backing. Its admin controls presentation only (renderer, description). |

The implementation constructor verifies the FWA runtime code hash and denomination/Packs compatibility.
`initialize` (called by the factory in the same transaction) verifies the FWA 5-purchase
batch limit, unlimited staging and six activations per acquisition, calls `PoolFactory.createPool(0, reviewedImplementation)` so the Balancer becomes the FWA owner (FWA allows
one pool per owner address, so one pool per Balancer), installs itself as the FWA purchase operator, and approves the pool
for its Shapes and Draw Packs. Nothing can ever change the operator, enable token offers or execute arbitrary calls.

## Roles

| Actor | Can |
| --- | --- |
| Creator | configure, open/close, list/update/withdraw curated NFTs, recover a refunded NFT or prize, return untracked NFTs, claim surplus, unlist prizes, retire, set ENS name, approve or revoke FWA pool-page publications, start creator transfer, explicitly change the revenue share, always run its own pool's upkeep, set a payment policy immediately, and immediately disable or re-enable payments |
| Pending creator | accept the creator role |
| Keeper admin (factory) | restrict upkeep on every pool to approved keepers or open it to anyone, approve or remove keepers, start keeper-admin transfer (the pending admin accepts) |
| Policy admin (factory) | set a recommended policy for future pools (immediate) and the adjustable factory settings, transfer this separate role |
| Anyone (keeper) | `performUpkeep` (while the factory's list is open, the default; when restricted, approved keepers and each pool's creator), `performUpkeepUnpaid` regardless of keeper restrictions, execute matured pool/factory policy proposals, `collectProceeds`, `depositETH`, `refreshCuratedWitness(listingId)` |
| FWA pool | calls `canPurchase` (view) |

The keeper's only payout is a bounded reward to `msg.sender` of `performUpkeep`. Curated and untracked NFTs go only to a
creator-chosen address; prizes go only to the FWA pool or are redeemed into the Balancer. ETH sent to a deployed
Balancer through `depositETH()` or a plain transfer by anyone is irrevocable pool capital. A predeployment transfer
to its predicted address becomes pool capital if the clone is later deployed there; until then it is not spendable by
the pool, and deployment is not guaranteed. The sender receives no refund, recovery or withdrawal claim, contributor
share or creator revenue credit. The current creator may claim available surplus under the existing reserve rules,
immediately if available. NFTs sent directly to the Balancer belong to the creator.

## Atomic creation

Before submitting, the creator reviews the target, markup, creator revenue share, mint-fee cap, funding and initial
curated batch. The factory predicts the Balancer address using a creator-scoped salt. Approve that address for the
initial NFTs. Then one payable `createBalancer(salt, config, curated)` transaction deploys the clone/FWA pool,
stores the configuration, deposits ETH, transfers/lists 1 to 20 initial curated NFTs and opens in initial stocking mode.
`CreationConfig` fields are `uint16 markupBps`, `uint16 creatorRevenueBps`, `uint256 target`, `uint256 mintFeeCap`,
`bool curatedRequired`.
The authenticated factory caller is the creator and NFT source. No `tx.origin`, public arbitrary-source transfer,
generic multicall or external self-call is used. Initialization is guarded against reentrancy and establishes creator
and factory state before external NFT interactions. A failed configuration, transfer, listing or funding check reverts
the clone, FWA pool, deposit and every NFT movement. The supplied cap is stored exactly; a live mint fee above it reverts.

Creation mints no Shape inventory. Ordinary maintenance stocks at most five underlying Shape units per call,
across at most four sizes. Purchases wait until the initial target is stocked. The initial batch limit is a per-call
bound, not a total curated-inventory limit; later creator listings use normal bounded batches. The dashboard retains
pre-submission drafts and stocking progress; there is no partial-creation recovery or unsaved post-creation design.

## Configuration

`configure(markupBps, target)`:

- `markupBps`: 1,000 to 10,000 bps for new Shape/Pack listings. A prize lists at backing plus one Shapes mint fee
  per underlying Shape plus `floor(backing * markupBps / 10000)` plus the selected policy's bounded restocking surcharge.
  Curated NFTs list at their creator-assigned value, with no markup. Existing prices remain fixed. Markup and target
  changes never change the stored creator revenue share.
- `target`: the prize mix, sixteen 16-bit counts packed into one uint256, 1 to 1,000 prizes in total (immutable limit). Sizes 0 to 8 are the
  Shapes denominations (0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100 ETH), each prize one Shape. Sizes 9 to 15 are 0.02, 0.03,
  0.2, 0.25, 2, 2.5 and 25 ETH, each prize one Draw Pack holding the fewest Shapes that sum to it (2 or 3; e.g.
  0.25 = 2×0.1 + 0.05). A target set with only the first nine sizes decodes unchanged.

`configure` also records the current Shapes `mintFee()` as `mintFeeCap`, the accepted fee: upkeep (paid and unpaid)
mints nothing while the live fee is above it, and listed prizes keep selling. The withdrawal reserve prices missing
prizes at `mintFeeCap`, never at a higher live fee. Configuring again accepts the live fee and the reserve follows. There is one target: no fallback plans, no on-chain solver, no separate capital limit (the target fixes its own
capital; the dashboard planner shows the total ETH committed). A smaller target leaves the extra prizes listed until the
creator unlists them with `unlistShapes`. Upkeep restocks toward the target; it never changes the target.

FWA weighs each listing `floor(1e36 / price)`. The admission gate instead weighs Shape/Pack backing at
`floor(1e36 / backing)`; mint fees, markup and policy surcharges cannot move the target's admission weight.

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
| 2 | SETTING_UP | initial stocking or reopening setup is unfinished |
| 3 | NO_CURATED | `curatedRequired` and no curated listing remains in local tracking |
| 4 | BUSY | 5 draws are unsettled on FWA |
| 5 | (retired) | not returned; a mint fee above `mintFeeCap` stops minting in upkeep, not purchases |
| 6 | LOW_INVENTORY | the conservative Shape-weight bound at the first new selection is below 70% of target |
| 7 | CURATED_PROOF_REQUIRED | `curatedRequired` and no current active curated witness or aggregate proof is available |

FWA prices every draw on live inventory and refunds a draw whose price moved past its tolerance. Several batches may be admitted between upkeeps; no serialized cohort is introduced. The curated-proof ambiguity pause below may require one permissionless refresh. The existing busy check rejects a new transaction when at least five draws are already unsettled. FWA checks the operator once per batch, so four outstanding requests plus a new batch of five can produce nine actual requests if external service capacity permits.

For tracked listing count `T`, FWA active count `A`, issued-minus-reconciled `q`, unsettled `u` and FWA reserved-staging count `K`, define `C = max(T - A, 0)` and `unavailable = min(max(q, max(C - (K + 6), 0) + u), q + S)`, where `S` is a conservative upper bound on staged Shape/Pack prize count. Subtract `unavailable × (1e36 / 0.01 ETH)` from tracked Shape inverse-backing weight, then require at least 70% of target weight. The maximum retains the old unreconciled-draw allowance without counting the same nonselectable win twice. FWA guarantees all previously reserved records activate before the first new selection, followed by up to six records reserved/idle-activated for that request. Creation verifies the real factory's six-record per-request activation budget. Only these guaranteed prefixes receive credit; reserved listings cannot be withdrawn while committed. A single scalar records possible Shape staging, increasing by actual new prize count and capped at the then-listed Shape-prize count on each restock. It clears only with proof that all tracked records are active, including before adding curated listings. It may overestimate, but does not accumulate for the lifetime of the pool. When zero, the gate uses the original `q` bound directly. Both loss estimates are conservative; their minimum avoids charging known curated-only staging as missing Shapes. No per-listing Shape staging flag or queue is introduced. This weight bound is for the first new selection, not full restoration or every later selection in the batch.

Curated presence requires a fresh FWA proof at admission. The cached tracked-curated listing must still occupy its saved FWA slot, or active FWA listings must exceed all tracked Shape prizes. The latter is a one-sided count proof: tracked Shape count may overestimate active Shapes. Otherwise status 7 requires `refreshCuratedWitness(listingId)` with a locally tracked curated listing whose FWA status is active and whose slot is nonzero. Anyone may refresh; there is no payment, capital requirement or asset transfer. A valid witness is preserved. Listing seeds a witness when the newly listed item is actually active. Every purchase rechecks the slot mapping, so selection, withdrawal and slot reuse invalidate stale proofs even before reconciliation. This intentionally refuses staged-only curated inventory until actual public activation; possible future activation does not authorize a purchase. R72 approves a one-transaction proof refresh when the witness exits but another active curated NFT remains. There is no total curated cap or scan inside the 100,000-gas hook. Pending earlier selections can consume curated inventory after admission; this is not a guarantee that a curated NFT survives to every later selection in a concurrent queue.

Purchases do not require the exact target to be restored after each win. The 70% inverse-backing-weight gate uses the prospective bound above and worst-case unreconciled removals. A missing expensive prize may leave trading open while proceeds accumulate. FWA prices the actual listed inventory; its price and odds change with inventory. Enough missing small prizes, the last curated NFT being won, busy state or an unaccepted mint-fee rise can pause sales. A paused pool cannot recover from hypothetical future demand alone: collect existing proceeds, add ETH, reduce the target or wind down.

`open()` requires initial inventory, its current bounded listing work, actual outstanding reconciliation and one maintenance-call buffer, excluding creator credit. Initial setup completes the target before sales begin. Ordinary later configuration/depletion does not restart that initial-setup flag; the inventory gate remains authoritative. Reopening a closed incomplete design still requires its current opening funding.

Status 0 means the Balancer admits a purchase. FWA can still refuse one on its own state (pause, cooldown, VRF service
capacity). Within a batch, FWA can refund a draw's acquisition fee instead of delivering when earlier draws moved the
price; the VRF fee is not refunded.

FWA holds draw escrow, deliveries and refunds. Draw finalization may require a keeper to process its canonical queue; unpaid upkeep remains available if payments fail.

## Money flows and creator credit

FWA holds purchaser escrow, delivery escrow, refunds and protocol fees. Shapes/Packs hold redeemable prize backing.
Only ETH actually collected from settled FWA owner proceeds creates creator credit:

```text
creditAdded = floor(collectedProceeds * creatorRevenueBps / 10000)
B = actual Balancer ETH balance
C = creatorCredit
O = B - C
B >= C
withdrawableSurplus = C + max(O - requiredReserve, 0)
```

The stored rate is 0 to 10,000 bps, inclusive. Rounding residue stays operating cash; there is no fractional carry.
At 100%, collections add no new operating revenue. Deposits, direct sends, unsold Shape/Pack redemptions, recovered
backing, expected fees, uncollected proceeds and purchaser escrow/refunds create no credit, whether open or closed.
Contributor addresses in deposit events and the dashboard are attribution only. Contributions remain capital transfers
outside the pool-lifetime operating result and create no holding period before surplus becomes claimable by the current
creator. The creator may voluntarily return available funds to a sender; the protocol gives the sender no return claim.
Both paid and unpaid inventory work and keeper payments spend only operating cash. Credit is never clipped to cover
spending. Collection remains a separate permissionless transaction, independent of maintenance affordability.

`claimSurplus(amount, to)` spends existing credit first. A claim covered by existing credit makes no external reads,
including no collection, policy, mint-fee, reserve or inventory read. It reduces balance and credit by the same amount,
leaving operating cash unchanged. Any capital beyond credit must leave the full operating reserve. For balance 0.20 ETH,
credit 0.02 ETH and reserve 0.10 ETH, operating cash is 0.18 ETH and total withdrawable is **0.10 ETH**.
Collect first in a separate transaction when new FWA earnings should be included. A failed surplus quote must not
block the dashboard's separate accrued-earnings action.

`setCreatorRevenueBps(newBps)` is an explicit creator action: validate, collect currently available proceeds using the
old rate, then store the new rate. Pending purchases that settle/become collectible afterward use the new rate.
Existing credit is unchanged. There are no cohorts, purchase snapshots or historical listing allocation mappings.
Inventory, gas, markup, target and policy changes never implicitly recompute the rate.

The shared planner suggests an initial rate from expected intended Shape markup above the first 10%, divided by
expected actual FWA owner proceeds. It uses integer FWA prices, inverse weights, per-prize Shape/Pack backing and
underlying mint fees. Curated listings contribute zero intended allocation. Owner proceeds exclude FWA edge and VRF
charges. The suggestion is rounded down to bps; the exact creator-reviewed rate is stored. The UI separately shows
expected creator allocation, retained revenue, replacement/mint costs, estimated keeper costs and margin/shortfall.
Unknown policy costs remain unknown. These are demand-conditional expectations, not overall realized profit.

FWA charges and Shapes mint fees are one-way costs. Keeper compensation pays actual completed work and is one-way.
Prize backing returns on unlisting/redemption or eligible refund recovery. A selected listing's surcharge is pricing,
not evidence that that surcharge was earned in a draw. FWA credits the request-board average owner price on successful
ETH delivery; token-payment draws produce no Balancer ETH credit. Creator overall results also depend on capital
contributions, NFT market costs, prize luck and demand.

## Reserves and shutdown

[RESERVES.md](RESERVES.md) defines a shared maintenance budget: bounded processing/reconciliation for actual
issued-but-unreconciled requests plus one bounded operating call while enabled. The full opening/withdrawal reserve
adds missing backing, mint costs and bounded listing work. Disabled paid upkeep makes payment terms zero, retaining
missing inventory expense while enabled. No duplicate-largest-prize or full-board hypothetical keeper insurance returns.

An immediate policy switch (`setKeeperPolicy`, decision 103) uses the same maintenance snapshot, excluding inventory
restoration. Compare the candidate against the old effective paid maximum, zero when payments are disabled. No-greater
exposure may switch even while depleted. Increased exposure needs the **entire candidate maintenance budget** in
operating cash, not only the difference. Neither creator credit nor unsold backing, expected fees, purchaser escrow or
uncollected proceeds funds that check. There is no two-day delay, generation or persistent allowance; `settingsHash`
hashes policy, maximum and enabled, and every atomic payment check remains intact. A smaller permitted maximum does not
imply a lower policy quote for every job.

Closing preserves credit. Late collections retain the stored split. Only actual outstanding processing/reconciliation
budgets remain in the closed reserve while paid upkeep is enabled; after obligations resolve, remaining operating cash
is claimable. Refunds and recovery retain FWA's locks. Redemption and deposits remain capital movements after closing.
`unlistShapes` withdraws/redeems up to 20 prizes per call, only when FWA permits withdrawal; a target shrink does not
implicitly unlist inventory. Retirement is permanent and preserves withdrawal/recovery routes.

## Upkeep

`performUpkeep(expectedPolicyHash, minimumFixed, minimumGas)` (open to anyone by default; returns the reward; reverts `NoUpkeepNeeded` when it would change nothing,
which keepers learn by simulating it). The factory's keeper admin can restrict it, for every pool at once, to the
keepers it approves (`BalancerFactory.setKeepersRestricted`, `setKeeperApproved`; others get `KeeperNotApproved`); each
pool's creator can always run its own. The reward rules are the same either way; while restricted, a pool whose approved
keepers stop can still be maintained by anyone through unpaid upkeep.

0. process FWA's queue, up to 2 draws per call, when draws are waiting (DECISIONS 75): a draw whose request reserved a
   staged restock skips FWA's randomness fast path and is settled here; a failure never blocks the rest of upkeep, and
   the gas it burned is not paid for; if it failed for want of gas (it handed back under 400,000 gas beyond the 1/64
   kept by the caller: FWA's notifier refuses below 290,000, and an out-of-gas hands back nothing), the whole upkeep
   reverts `InsufficientGas`, so no call succeeds with processing starved, at any pool size. A call that settled a draw skips step 3 (restock):
   the worst such call measures 2.98M gas, up to 3.22M with 1,024 listings, and storage refunds keep its billed gas
   under 2.75M, so its keeper is covered; the next call restocks.
2. reconcile settled FWA sequences in order, up to 5 per call: a drawn listing leaves the tracked set; a failed delivery
   marks the item `PENDING` (never scanned again by upkeep).
1. collect actual FWA owner proceeds at the stored creator revenue percentage.
3. while open, not retired, not globally withdraw-only, and the mint fee is at or below `mintFeeCap`: mint the missing
   prizes, smallest value first, within 5 Shape units, 4 prize sizes and the ETH left after this call's keeper reward, and list them in
   one FWA batch. FWA stages the batch while draws are unsettled and activates staged listings in order. When a creator
   action's restocking work finishes (the target is restored), the SETTING_UP flag clears.

Upkeep restocks while draws are still unsettled; it does not wait for the pool to be idle. No upkeep loop depends on
history: refunded or stuck deliveries are `PENDING` and cost nothing per upkeep.

Paid upkeep accepts `(settingsHash(), minimumFixed, minimumGas)` and enforces `reward >= minimumFixed + minimumGas * tx.gasprice`; no other paid overload exists; the hash identifies policy address, cached maximum, generation and payment state. A stale hash fails before work. Work validation remains immutable: only finalized reconciled sequences and successful mint/list operations can authorize a reward. Empty work and collection alone pay zero.

V1 pays `(min(measured, 3.2M) + 50,000) × min(tx.gasprice, basefee + 0.05 gwei, 5 gwei) + 0.00002 ETH × (draws reconciled + Shape units listed)`. Processing and reconciliation earn one service fee together. Splitting does not duplicate service fees, but can increase actual gas, excess overhead and refunds kept. The selected maximum is 0.01645 ETH for V1, with an immutable 0.311 ETH per-call ceiling and a separate immutable gas/work envelope.

Each pool has a persistent 0.622 ETH burst allowance, refilling at floor(0.05 ETH / 12 seconds), independent of other pools. Every interval is bounded by burst plus refill over elapsed seconds. Policy switches, reconfiguration, reopening and ownership changes never reset spending. This is a generous bounded exposure, not an unrestricted-throughput promise. Paid execution reverts atomically on insufficient quote, minimum payment, allowance or operating funds; it never silently clips to liquidity. The recipient remains the caller and cannot redirect pool assets through a policy.

`performUpkeepUnpaid()` executes the same validated work with zero compensation. It retains valid bounded active-policy listing surcharges and falls back to immutable V1 pricing only if the quote fails or exceeds the immutable limit. It is public even when paid keepers are restricted. Creators disable payment immediately (emergency stop) and re-enable it immediately with the same funding check (decision 103); there is no proposal or delay. Both paid and unpaid paths retain external FWA/Shapes restrictions.

## Curated NFTs

`listCuratedBatch` pulls from the creator (approve the Balancer first) and lists on FWA at `base`, the creator's
value, with no markup. Shapes and Draw Packs cannot be listed as curated NFTs. `updateCuratedPrice` sets an NFT's value,
which is its FWA price; FWA allows the change only while no draw is unsettled.
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
any FWA pool. Curated prices are the creator's reviewed values. Listing interactions run under the reentrancy guard.

`recoverUntrackedNFT(collection, tokenId, to)` returns an NFT the Balancer holds outside FWA (sent to it directly).
Tracked inventory is never held by the Balancer between transactions (listings and pending deliveries are owned by the
FWA pool), so `ownerOf == this`, checked under the reentrancy lock, proves the NFT is untracked. It never calls the FWA
pool or factory.

## Lifecycle

`close` → process/reconcile outstanding draws → `unlistShapes` (repeat) → `withdrawCurated` → `collectProceeds` → `claimSurplus`. `retire` (closed only) calls FWA `retirePool`,
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
| Refuse new requests when at least five draws are already unsettled | The operator is checked once per batch; actual outstanding counts can exceed five and reserves use the actual sequence count. |
| Reconcile up to 5 settled sequences per call; restock while draws are unsettled | Upkeep keeps up with bursts, and FWA stages the restock until the draws settle. |
| Redeem prizes for backing instead of keeping spares | Prizes never sit in the Balancer between transactions; one mint fee per Shape re-minted when the target grows again. |
| Delivery failures resolved per item, never scanned | Upkeep gas cannot grow with refund history or hostile collections. |
| Replaceable read-only work-based economics, adopted by each creator after two days (decision 95) | Draws that time out or win an NFT bring no restocking fee; paying their reconcile only from fees left them unreconciled until the fill gate closed (flow regime `randomness_not_delivered`: 55 draws refused before, 0 after). The restocking fee stays in each Shape prize's price as the creator's income toward keeper pay. Competing keepers bid the reimbursed priority, so a higher cap is a surcharge on every upkeep. |
| Current-work reserve with a consumable maintenance buffer (decision 96) | Funds paid initial setup and limits withdrawals against present deficits; avoids a duplicate largest prize or lifetime keeper cycle. Later partial depletion can require creator action. |
| Clone factory, `via_ir`, 50 optimizer runs | Cheap deployment per creator; runtime under EIP-170's 24,576 B limit, with permanently linked `PoolPage`, `PoolInventory` and `KeeperPolicyCalls` libraries. No linked execution address is replaceable. |
| Hard-coded size table (packed constants), Shapes sizes checked against `Shapes.denominationAt` and the Packs instance checked to wrap the same Shapes with a minimum at most 0.02 ETH, at deployment | Avoids external calls in hot paths. |
| A fixed menu of 16 prize sizes instead of arbitrary values | Keeps per-size counts, reserve and weight checks structurally simple; a 1-2-2.5-5 ladder lands within about 25% of any target value. |
