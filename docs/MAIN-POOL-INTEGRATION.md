# Main pool app integration

The main pool uses the contracts and defaults exported from `ripe0x/shapes-fwa-pool`.
Community contracts, keeper behavior, current factory selection and legacy handling are unchanged.
The shared-vault production switch remains `MAIN_POOL_OPEN = false`. Personal managers have a separate
`MAIN_MANAGER_OPEN = false` switch; neither is enabled by this implementation.

## Updating the contract interface

Build the intended main candidate first, then run from this repository:

```sh
SHAPES_FWA_POOL=../shapes-fwa-pool-completion node scripts/export-main-pool-abi.mjs
```

This updates `shared/main-pool-abi.ts` and `shared/main-pool-defaults.ts` together. The exporter
refuses an ABI with the retired main external policy or without the named gas schedule and
required recovery/holder/refund views. Deployment integers are preserved exactly. The defaults
record the SHA-256 of their source manager configuration. Node 22 or later is required.

The selected local candidate is a 0.03 ETH pack with three paid 0.01 ETH primary mints. Its
70,000 bps backing ratio and 25 bps unresolved-uplift
limit are evaluation values, not approved production settings. Account views determine active
quotes and settings; existing inventory is not assumed to have the current fresh recipe.

## Local preview

Use the main candidate's isolated fork deployment, fresh checked rehearsal wallet and local RPC.
Set `VITE_CHAIN_ID=31337`, the fork's `VITE_VAULT`, `VITE_MANAGER_FACTORY` and deployment block,
and `VITE_MAIN_POOL_PREVIEW=true`, then run `npm run dev`. For a manager-only preview, leave
`VITE_VAULT` unset and `VITE_MAIN_POOL_PREVIEW=false`; set `VITE_MAIN_MANAGER_PREVIEW=true`
and the manager factory/deployment block. Wallet balance, discovery and manager reads do not use the vault.
The preview flag has no effect on mainnet. Do not change the community factory, its deployment
selection or production application configuration to preview the main pool.

## Reads and estimates

Each account refresh checks one page of at most 32 inventory entries plus its cached witness.
Each history source checks one 2,000-block range per refresh. History resumes incrementally with a 64-block overlap. Incomplete history is labelled while it
loads. Account aggregates are authoritative; exact NAV additionally requires a valid bounded
witness. Until that proof succeeds, the UI labels the displayed amount booked principal.

Factory creation funding estimates are conditional on FWA admission and live economics. They include principal, separate FWA backing, actual live mint fees,
an upper estimate for initial keeper work and the maintenance reserve. Returned packs are reused; no renewal float is reserved.
Creation starts idle. Wallet creation gas is additional. Account-specific quotes replace the old fixed 0.1248 ETH
charge reference and the use of vault charges to price personal managers.

Gross pending deposit escrow remains cancellable before commitment. Its construction allowance
is an estimate using current settings and the live fee; the committing checkpoint sets actual
issuance. Checkpoint sponsorship is separate. Contributions are discovered by indexed payer
events, read in pages of 16, and unused amounts are claimed from their original contribution eras.

Owners can review and apply economic settings and every named gas allowance. Mint fee acceptance
is a separate action. Configuration hashes reject changed settings or live fees before guarded
spending; claims, refunds and necessary caller-funded recovery remain unconditional.

## Caller-funded withdrawal

The shared vault provides an explicit complete-exit panel. The holder chooses a total wallet
debit limit and reviews one bounded transaction at a time. Steps cover cancelling uncommitted
escrow, requesting redemption, required settlement recovery, unlisting, pack redemption,
redemption pricing, partial fills and claims. A quiet checkpoint window or FWA settlement
can require waiting. Recovery is never suppressed by keeper profitability after the holder
accepts its wallet gas cost.

The limit includes gas and ETH sent as charges or refundable sponsorship. Reviews show estimated
gas expense, sent ETH and maximum debit. First-receipt gas and sent ETH are observations recorded separately; they can change after a reorganization. Every signed maximum remains permanently reserved toward the limit, including a reverted transaction. Incoming claims/refunds and lower observed execution expense do not replenish it. A pending or unknown wallet outcome reserves
the entire reviewed maximum, survives reload and blocks another exit step. A per-account Web Lock serializes durable reads, reservations, submission and reconciliation across tabs, including zero-value recovery calls. A lost response can
be reconciled using the signed transaction hash from the wallet; its sender, destination,
calldata, value, chain, pending-step identity and nonce must match; its receipt is then reconciled. A higher signed fee maximum reserves only the positive increase for that nonce. A lower replacement maximum never releases allowance. An already signed wallet override above the limit blocks further steps until the owner explicitly raises the flow limit. Personal managers retain their distinct owner-funded
withdrawal and exit controls.

## Verification

The focused app batch covers request arithmetic, bounded reads, configuration schema/settings,
fee-change errors, caller spending limits, creation recovery and preserved chain/community flows.
It must also exercise the UI against real candidate contracts on a local fork. Typechecking and
an app build alone do not establish contract integration, keeper liveness or economic returns.

## Owner-paid manager closeout

The manager page offers one reviewed transaction at a time under its own durable wallet spending limit.
It first enables exit mode, then uses unpaid bounded recovery, unlisting and ordinary/oversized pack
redemption. When an outstanding FWA queue blocks required work, the owner can review
`FWA.processAcquisitions(16)` only if real simulation reports positive completed progress. Otherwise
randomness, its actual request deadline or the crown exit delay requires waiting. There is no assumed
unpaid keeper or external queue processor.

The closeout collects remaining FWA fee credit before withdrawing all available ETH to the current owner.
It has no holder shares, pricing checkpoint, deposit contribution, refund or token-burn step. Zero keeper
budgets and unprofitable reimbursement do not hide necessary owner-paid calls. The owner pays wallet gas;
these transactions request no keeper compensation. Vault return measurements do not establish manager returns.

Manager closeout reuses the vault flow's Web Lock and conservative signed-maximum ledger with a separate
manager key. A pending step records its exact target, calldata, owner, value, chain and nonce. Targets are
restricted to the manager's exit selectors or its live immutable FWA dependency with the exact bounded
queue-processing calldata. Unknown wallet outcomes survive reload and block another step. Replacement
transactions can only raise reserved maxima; claims, withdrawals, reverts and reorganizations do not free
previously signed allowance. Owner withdrawal recipient and amount remain part of the signed intent.

Final manager acceptance must include an actual local manager-only page with no vault configured, zero
keeper spending permission, real outstanding queue progress, ordinary/recovery inventory, a refused tiny
wallet cap, explicit bounded steps and a complete final owner withdrawal. Hardware-wallet behavior remains
a separate limitation when an unlocked local wallet bridge is used. Production/community deployment
selection and live routes remain unchanged until separately authorized.

The earlier manager acceptance exercised the actual local page with no vault address: creation,
pause/resume, zero keeper capacities/refills, a one-wei cap refusal, a genuine pending request,
owner-paid queue progress after its real expiry and complete withdrawal. The manager's ETH,
inventory, receipts and fee credit all ended at zero. Raw receipts and limitations are in the
main repository's `docs/receipts/manager-ui.json` and `manager-closeout.json`.

The app permits zero ETH creation for an idle import destination; opening funding remains a conditional estimate.
The new reuse-only measured-payment and migration changes passed the affected app tests, production build and a
local UI pass with actual manager, FWA, Shapes and pack contracts. The UI created two managers, then migrated four
intact packs with seven canonical transactions and an explicit 0.87 ETH wallet transfer under a 0.9 ETH stated cap.
An orphaned receipt was re-included at the same nonce and reconciled without an extra reservation. Hardware signing,
a >30-Shape unsupported recovery pack in the live UI, and a standalone credited harvest were not reached in this
UI pass; focused contract and app tests cover those conditions separately. The main repository retains the raw
local UI receipts. Both public launch switches remain false. No live application cutover is included.


## Reuse-only measured payments and pack-preserving migration

Returned packs retain their actual Shapes and are relisted. New growth still uses paid primary mints.
The owner gas schedule contains operation caps and a per-transaction overhead allowance. Actual
keeper compensation uses bounded measured gas and verified service units. Funding estimates and
quote views are upper bounds, not fixed actual payments.

The manager-only migration panel uses the configured current official manager factory. It verifies
`isManager`, the exact optimized Solady clone runtime and immutable implementation, both current
owners and the canonical FWA/Shapes/ShapePacks tuple. An arbitrary contract exposing matching getter
names is insufficient. Future factories require an explicit reviewed allowlist and source ABI update;
this release does not implicitly trust the historic factory address in older deployment examples.

Migration refuses exit mode at either endpoint and pauses listings at both endpoints. Each reviewed,
bounded owner-funded step recovers settlement, optionally processes an eligible FWA queue, unlists
without redemption, withdraws intact packs directly to the destination and imports its preheld packs.
Canonical ERC-721 transfer receipts record the actual transferred IDs. Existing held IDs can also be
supplied in batches of 16. Import discovery checks at most 16 recorded IDs per review and advances
incrementally. Unsupported recovery inventory or unsealed packs can block this preserving flow;
it never substitutes liquidation or reminting. Existing owner withdrawal/recovery controls remain.

Only after source inventory and receipts finish does the flow collect remaining credit and withdraw
source ETH to its owner. Any additional wallet ETH transfer is an explicitly entered amount and
recipient, reviewed as a separate step. No growth topup is inferred. Its value and maximum wallet gas
are both reserved against the durable flow limit; receipts, refunds and lower replacement fees never
replenish it. Both owners and clone identities are rechecked before each send. Listing resumption is
an explicit later owner action. The shared vault address may remain unset and both public launch
switches remain false.


Migration effects are derived from a durable nonce-keyed receipt journal. Receipt hash, transaction
intent, nonce, block identity and canonical block hash must match before IDs or successful ETH
funding count. A canonical ancestor anchor preserves prior checks; a reorg invalidates cached effects
and rechecks at most 16 receipts per refresh. An orphaned or replaced transaction reopens its exact
pending nonce without releasing or reserving its signed maximum again. Missing RPC data blocks
progress. Pack import progress additionally reads actual destination custody and book records in
pages of 16, and the selected next step is recomputed before signing. Completion/approval is cleared
when reconciliation fails or invalidates an observation.

There is only one wallet-ETH attempt per migration flow. A canonical reverted ETH attempt does not
count as sent and is not automatically retried at another nonce: both signed transactions could
otherwise succeed after a reorganization. Its amount remains fixed and matching same-nonce
replacement recovery remains available. This conservative failed-flow condition does not move or
redeem any additional assets. The local UI pass exercised this reorganization path with an actual
node snapshot and replacement header.


Sealed recovery inventory is checked in pages of at most 16 entries using a durable round-robin
cursor. Transfer eligibility requires `recoveryUnsealed == false`, no canonical pack claimant and
actual pack ownership by the source manager. Migration selects one checked index and pack ID with
`withdrawRecoveryPack(destination,index,expectedPackId)`; swap-pop changes invalidate stale indices
instead of selecting another token. An unsealed tail does not block a sealed pack elsewhere in the
checked page. Actual canonical transfer logs remain the import-ID source. If this page has no sealed
candidate, the UI explicitly offers another page/recheck and does not report the entire book searched.
After sealed packs leave, a remaining unsealed claim keeps migration waiting for its existing owner
recovery path. No pack is redeemed and no exit mode is enabled by this preserving flow.


Before any source pack transfer, migration checks actual canonical import eligibility. The canonical
collection has no bounded count getter: `contentsOf` copies its storage array. The app uses raw
`eth_call` with gas 150,000, rejects returndata outside 96..1,024 bytes before decoding and accepts
only 1..30 distinct Shape IDs. It checks the actual pack holder/claimant, underlying Shapes collection,
each Shape's holder and `packOf`, positive backing and total backing against canonical pack value.
Ordinary idle withdrawals use only the verified contiguous LIFO prefix (at most 16 packs); a changed
or unsupported tail stays tracked at source and cannot be skipped with the batch withdrawal method.
Recovery discovery skips unimportable candidates within its bounded page and can transfer another
supported sealed pack. Unsupported inventory never counts as migration completion and is never sent
to the destination merely to discover import failure there. RPC outages remain failures, not evidence
that a pack is importable; only explicit canonical execution failure can classify it as unsupported.
