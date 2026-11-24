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
70,000 bps backing ratio, fresh replacement mode, one renewal float and 25 bps unresolved-uplift
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
initial keeper compensation, maintenance reserve and the separately funded renewal float.
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

The focused manager acceptance exercised the actual local page with no vault address: creation,
pause/resume, zero keeper capacities/refills, a one-wei cap refusal, a genuine pending request,
owner-paid queue progress after its real expiry and complete withdrawal. The manager's ETH,
inventory, receipts and fee credit all ended at zero. Raw receipts and limitations are in the
main repository's `docs/receipts/manager-ui.json` and `manager-closeout.json`.

The app currently requires its quoted opening funding for creation. That is a UI restriction;
the contract and unsigned CLI template permit smaller idle accounts. Hardware signing,
recovery-only oversized inventory and a standalone credited harvest were not reached in this
new UI run. The latter contract paths retain their separate real-fork coverage. Both public
launch switches remain false. No live application cutover is included.
