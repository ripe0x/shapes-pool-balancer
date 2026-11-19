# Operations and recovery

Current operations, 2026-11-18. See [SPEC.md](SPEC.md), [KEEPER-POLICIES.md](KEEPER-POLICIES.md) and
[focused audit repairs](AUDIT-FOLLOWUP-RESULTS.md). Historical reports validate only their named revisions.

Status codes come from `admissionStatus()`; the dashboard shows them as text.

| Code | Name | Meaning | Action |
| --- | --- | --- | --- |
| 0 | OK | Open: the Balancer admits purchases (FWA can still refuse one, e.g. when its VRF service lacks capacity) | none |
| 1 | CLOSED | Closed by creator | `open()` |
| 2 | SETTING_UP | Initial stocking or reopening setup is unfinished | call `performUpkeepUnpaid()` (keeper, creator or anyone) until the target is restored; deposit ETH first if the reserve is short |
| 3 | NO_CURATED | No curated listing remains in local tracking | list a curated NFT, then complete any stocking |
| 4 | BUSY | 5 draws are unsettled on FWA | wait for VRF and FWA processing; anyone may call FWA `processAcquisitions(5)` |
| 5 | MINT_FEE_ROSE | The Shapes mint fee is above the one the creator accepted | run `configure(markupBps, target)` again to accept the new fee (the reserve must cover it), then upkeep |
| 6 | LOW_INVENTORY | Prospective Shape-weight lower bound is below 70% of target | process/reconcile existing draws; inspect actual staging and liquidity before adding ETH |
| 7 | CURATED_PROOF_REQUIRED | An active curated listing has not been proven | activate staged curated inventory if necessary, then anyone calls `refreshCuratedWitness(listingId)` |

## Keeper down

New purchases pause once prize weight falls below 70% of the target (status 6) or 5 draws are unsettled (status 4).
Outstanding draws, refunds and NFT claims retain FWA's rules. Ready or expired draws can require explicit processing; upkeep processes the queue. Anyone, including the creator from the dashboard, can call `performUpkeepUnpaid()`, even if the factory restricts paid keepers. Run a second keeper with the same factory address; duplicate submissions just
revert `NoUpkeepNeeded` in simulation and are never sent.

Shape admission uses the [operation-aware bound](SPEC.md): the old unreconciled allowance and actual nonselectable count receive credit only for FWA's previously reserved prefix plus the next six guaranteed activations. It preserves the existing busy threshold and permits purchases without keeper maintenance between every batch. A single bounded Shape/Pack staging-count estimate prevents unrelated curated staging from being charged as missing Shapes; its zero fast path preserves the original allowance.

Curated presence is checked separately against current FWA inventory. A cached listing ID and slot are only a candidate: each purchase checks that FWA's slot still maps to that tracked curated listing. An active count greater than all tracked Shape prizes also proves curated presence. Otherwise status 7 pauses purchases, including when every curated item is staged. The dashboard's **Refresh curated proof** action is permissionless and verifies one actually active curated listing. It transfers no assets and pays no reward; the caller pays gas. A still-valid cached witness cannot be replaced. When the witness exits but another curated NFT remains, one refresh transaction can restore this gate. This bounded ambiguity pause is owner-approved R72; it is not a maintenance requirement after every batch. Earlier pending draws can still win the last curated item before a later draw selects; the gate establishes presence at admission, not a guaranteed prize mix for all future selections.

If actual staging remains after all draws settle, the dashboard's bounded activation action calls the existing public FWA `activateListings(20)`; repeat while needed. This creates no Balancer compensation and spends only caller gas. Inspect actual active/staged records: a tracked count is not a proof that all records are selectable or that the target is complete. An operating deficit may instead need existing proceeds, Add ETH, a smaller target or closing. Do not add capital to cure a mere activation backlog.

If no curated item is active, let pending requests become ready or expire and process FWA's queue, activate the FIFO prefix through a curated item, then refresh its proof. The prefix can include arbitrarily many curated listings, so there is no fixed global activation-call bound. Anyone can perform these recovery calls; neither the keeper nor an automatic browser job is assumed to do so. Refresh alone does not cure a separate low-Shape-weight or funding condition.

## Dashboard results and transaction confirmation

**Pool lifetime operating ETH result** is owner proceeds less Shape/Pack backing won, Shapes mint fees and keeper pay. It includes previous creators' activity and excludes capital transfers, wallet gas and curated NFT valuations. Deposits and withdrawal recipients are listed by address for attribution only. All `depositETH()` and plain ETH contributions are irrevocable pool capital: the sender gets no protocol recovery or withdrawal claim, and the current creator may withdraw available surplus under the reserve rules without a holding period. Holdings and unattributed reconciliation are separate; an eventless ETH transfer is not inferred to be personal profit or a refundable donor balance.

Generic wallet actions confirm only when the included successful transaction matches the reviewed chain, sender, destination, calldata and value. Fee-only repricing is accepted. Cancellation, changed intent, revert and unavailable confirmation stop dependent steps. A failed lookup is unverified, not a successful action. Atomic creation retains its separate persisted, factory-and-pool-verified recovery path.

## Keeper service

Configure `FACTORY`, `FROM_BLOCK`, `RPC_URL=https://mainnet.gateway.tenderly.co`, `STATE_FILE`, and the keeper's signing identity through the existing environment/secret store, then run `npm run keeper`. Never place a private key in a command literal, file, or log. `KEEPER_ADDRESS` selects an unlocked account for isolated local forks only.

- Each tick discovers all pools created by the factory and reads each pool's selected policy, payment state, and generation hash. It simulates the actual offered reward with fee fields and the same executable gas limit it would send. Core-compatible new policies need no keeper code change. Bidding caps are operator configuration; policy economics are learned only through bounded quotes and complete transaction simulation. No settings metadata is read.
- The send condition budgets execution expense, `OPERATING_COST_WEI`, and the configured `MAX_LOSS_WEI` (default 0.0002 ETH per attempted successful call). Setting the loss allowance to zero requests no modeled loss; it does not guarantee inclusion or profit. Failed attempts remain operator costs and are included in receipt stats.
- `eth_estimateGas` sets the executable limit with 30% headroom and a 4M floor, bounded by EIP-7825's 16,777,216. It is not the gas ultimately billed. An optional top-level `debug_traceCall` estimates billed expense; receipt comparisons report its calibration. If tracing is unavailable, estimation is conservative and may skip profitable work. No formula is recovered by dividing compensation or listing fees.
- Paid calls use `performUpkeep(settingsHash, minimumFixed, minimumGas)`: minimumFixed budgets operating costs, while minimumGas budgets traced/estimated billed gas less a conservative conversion of the configured loss allowance. The atomic floor follows the transaction's actual included gas price, avoiding false fixed-wei reverts when basefee falls. Quote failure, stale policy generation, disabled payments, insufficient operating funds/allowance, or reward below the minimum reverts all work. Another caller can change work between simulation and inclusion, so atomic checks protect the minimum, not the operator's spent gas.
- Pending nonce state is saved before broadcast. Every replacement refreshes policy/hash, simulation, expense and gas limit, raises fees by 25%, and uses the same nonce only while the offer remains acceptable. Each hash keeps its own offered policy/payment for receipt attribution. Lost responses and node eviction recover without allocating a duplicate nonce. Do not delete pending state as a normal recovery step.
- Health: `GET http://localhost:8787/health`; per-pool errors do not stop unrelated pools. Discovery rescans a 64-block window and drops creations absent after a reorg. Receipt stats reconcile actual gas costs and received compensation.
- The persisted receipt journal covers 64 blocks and at most 1,000 entries. Recent orphaned receipts reverse their gas/reward counters; pending accounting survives a pool disappearing from discovery. Lost response hashes are recovered by the sender nonce using historical account reads and the actual canonical transaction. Historical-RPC failure retains the accounting entry and exposes an error. Reward events must originate from the tracked pool and name this keeper.
- `health.accounting` reports retry nonces, errors, coverage and `journalPrunedThrough`. `legacy-unverified` means pre-journal counters were not reconstructed; `history-unverified` means pruned/deep history requires external reconciliation. A normal `journal` status does not promise unbounded historical finality. If a genuinely different operator transaction consumes a tracked nonce, that external transaction is outside service financial totals. A later reorg of that external cancellation followed by original-upkeep reinclusion requires manual canonical reconciliation; there is no retained external-consumption tombstone. Do not clear state to conceal these limits.
- The accounting retry queue never broadcasts. If a reorg removes a pool and the node does not reinsert its orphaned transaction, an unconsumed nonce can block later sends. After the grace period health reports operator rebroadcast/cancellation required and `ok=false`. Inspect the chain, nonce and original decoded transaction before authorized recovery; no automatic cancellation spend is assumed. A node or peer may reinsert it, but that is not guaranteed service behavior.
- `MAX_GAS_PRICE_GWEI` is the operator's bid cap, `PRIORITY_GWEI` the requested tip. V1 reimburses at most 5 gwei including its 0.05 gwei priority allowance. At basefee exactly 5 gwei a positive tip exceeds that ceiling; zero priority can execute at the ceiling if included. Inclusion and competition are not proven by fork tests.
- Use an account that retains its received ETH. A forwarding EIP-7702 delegation can pass keeper rewards elsewhere. Fund the sender for its transaction's gas limit times maximum bid; simulation does not supply this ETH.

## Working capital and depleted inventory

[RESERVES.md](RESERVES.md) defines the current target: missing inventory and its current setup work, actual outstanding reconciliation and one maintenance buffer. No whole-board future payment cycle or duplicate largest prize is held. Unsold fees shown in the dashboard are future income, not deposit ETH.

Paid work can consume the buffer, and partial targets may trade while the real weight gate permits. If admission is paused and no proceeds remain, further demand cannot restart it. Use Add ETH, reduce the target or close. A large missing prize may take an unknown number of actual purchases to replenish; do not assume automatic creator deposits or NFT replacement. The dashboard identifies missing prizes and actual withdrawable capital.

Disabling paid upkeep releases keeper-related holds, but setup then requires an unpaid caller paying gas. Reenabling remains delayed and funded. Current gas determines budgets; a later gas or mint-fee increase can require additional working capital. Creator credit is excluded from every paid and unpaid mint/payment affordability check. It stays withdrawable during depletion. Collection uses the stored revenue rate; listing turnover never recomputes that rate.

## Collect and claim earnings

`collectProceeds()` permissionlessly pulls actual FWA owner proceeds and credits the stored creator percentage, even
after closing. `creatorCredit()` is accrued withdrawable earnings, separate from capital surplus. Claim any amount up
to it using `claimSurplus(amount, to)` without collecting or reading a policy/reserve/mint fee. The earnings button
remains available when quotes or historical RPC scans fail. A larger capital withdrawal requires the full reserve.

To change allocation, the creator explicitly calls `setCreatorRevenueBps(newBps)` (0 to 10,000): it collects available
proceeds at the old rate and then saves the new one. Pending purchases collected afterward use the new rate. Inventory,
markup, gas and policy changes never change it. At 100%, all collected revenue is earnings; operations receive none.
History and failed-delivery discovery load separately with their own errors. A historical failure is a gap in that
history view, not a reason to disable current claims, maintenance, closing or policy recovery.

## Adopt a policy

1. Read `keeperPolicy`, `policyMaxReward`, the new policy's version and `policyFunding(candidate)`. Use active Balancer-context views for current estimates; a candidate policy's direct response is unverified and is not a guaranteed pool offer.
2. Creator: `proposeKeeperPolicy(candidate)`. Observe `KeeperPolicyProposed` and `policyActivationTime`.
3. `policyFunding` returns candidate maintenance budget and activation shortfall. A nonincrease has zero shortfall regardless of inventory deficit; an increase needs the full candidate maintenance budget in operating cash. Deposit only the shortfall with `depositETH()`. Restoration shortfall is separate; existing prices and creator credit stay unchanged.
4. After two days, anyone: `activateKeeperPolicy()`. Funding and compatibility are checked again atomically.
5. Creator may `cancelKeeperPolicy()` or `setPaidUpkeepEnabled(false)` immediately. Reenabling requires delayed activation, even with the same policy. Ownership acceptance cancels the former creator's proposal.

Only the separate policy admin may propose/cancel a factory default. `proposeDefaultKeeperPolicy`, a two-day delay and permissionless `activateDefaultKeeperPolicy` affect future pools only. The keeper admin cannot select any pool's policy or change keeper economics.

## Broken policy or unavailable payment

Use `performUpkeepUnpaid()`. It pays zero and retains valid bounded active-policy listing quotes. If a price quote reverts, burns its stipend, is malformed, or exceeds the immutable limit, it uses the immutable V1 recovery surcharge. It remains public under keeper restrictions and pays zero. No assets migrate. Existing listings retain their original prices. Inventory still needs capital, and dependencies' own pause/settlement restrictions remain effective.

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
2. Allow randomness or expiry, then run `performUpkeepUnpaid()` until outstanding draws are processed and reconciled.
3. `unlistShapes(listingIds)` until no prizes are listed (prize listing ids come from `getActiveIds` /
   `getActiveShapes`; it withdraws and redeems each prize for exact backing, up to 20 per call).
4. `withdrawCurated(listingId, to)` for each curated NFT; `recoverRefunded(listingId, to)` for any refunded one.
5. `collectProceeds()` separately, then `claimSurplus(withdrawableSurplus(), to)`; while closed everything is claimable except the current operation-sensitive reconciliation budget for each actual unreconciled draw while paid upkeep remains enabled. Run upkeep (or wait for a keeper), then claim the rest.
6. Optional and permanent: `retire()`.

## FWA pool page

On mainnet the dashboard's "FWA pool page" form approves FWA's exact publication message on the Balancer
(`approvePoolPage`) and then submits the page to `pools.fwa.fun/api/fwa/profile` with a placeholder signature; FWA's
server is expected to verify it through ERC-1271 (`isValidSignature`). This is unconfirmed with FWA. If FWA rejects it,
ask FWA to support contract owners or to add the creator as an editor for the pool. Purchases do not depend on the page.

## Creator key change

`transferCreator(new)` then `acceptCreator()` from the new address. Setting `new` to zero cancels.
