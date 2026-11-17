# Launch preparation alongside the independent audit

**Audit target stays at `9b45f915fcaa27bc24d6125cf4a0062117ef576c`.** This preparation lives on `codex/launch-preparation` in a separate worktree. No audited source, contract, keeper, dashboard, deployment script or economic outcome is changed. The owner reports that the independent audit is running; no result has been received or inferred. Nothing is deployed or published, and no real funds are authorized.

## Current-block deployment simulation

Pinned source: Ethereum block **26,437,802**, hash `0x37f8bdf22d14892ebe9634fa5c020e4c4b0d90b38067760868002d4713e03e4f`, retrieved from https://mainnet.gateway.tenderly.co. Owned Anvil endpoint **http://127.0.0.1:18554**, chain **31337**, client anvil/v1.8.1. The node reports that exact fork URL/block. Current FWA factory implementation and pinned implementation codehash match the deployment preflight.

The unchanged `script/Deploy.s.sol` was simulated, without --broadcast, using a fresh local-only deployer and distinct role addresses below. Its constructor/wiring/postflight assertions passed. Eight planned transactions have zero native creation value; the largest individual submitted gas limit is **7,023,660**, below16,777,216. Total estimated script gas is21,648,362 across eight transactions, not one transaction. Estimated amount at the simulated fee envelope is **0.006045247092538202 test ETH**; this is an estimate, not billed gas or a future mainnet quote.

Decoded constructors, targets/nonces and limits are in [deployment-actions.json](receipts/launch-preparation/deployment-actions.json). These are predicted local addresses only. The node has not mined these deployments; dry-run deployment JSON must not be mistaken for actual deployed code. No review seal or signature is produced by a simulation.

A warm Deploy artifact contained ABI only, causing "Could not find target contract". A private separate output/cache rebuilt the simulation successfully, preserving existing caches and source. Initial sandbox loopback calls failed EPERM; approved read/simulation execution succeeded. Failures and the final log are retained, with the actual command and exit statuses in the receipt manifest.

## Mainnet launch values

| Value / role | Responsibility and recommendation | Current state |
|---|---|---|
| PACKS_ADMIN | Renderer/description/presentation administration; use an owner-controlled address | Owner must supply address; local test binding is not a recommendation of a live address |
| KEEPER_ADMIN | Eligibility list and restriction switch; use an operations-controlled address | Owner must supply address |
| POLICY_ADMIN | Delayed recommended default for future pools; use separately controlled authority from keeper eligibility | Owner must supply address; no automatic changes to existing pools |
| Deployment signer | Funds deployment only, with correct keystore/hardware signer and chain checks | Not selected; no secret requested |
| Packs name/symbol | Retain existing `Pool Prize Packs` / `PRIZEPACK` | Existing deployment literals, no new product change proposed |
| Packs minimum | Retain2units /0.02ETH minimum | Existing constructor value |
| FWA / implementation / Shapes / ENS | Retain exact reviewed addresses/codehash asserted by Deploy.s.sol | Fresh fork preflight matches; independent integration audit remains separate |
| Keeper account / state / RPC | Dedicated keeper account, persisted state, receipt reconciliation and monitored per-pool errors | Live configuration remains unset; no production service launched |

Deploy.s.sol remains the single contract deployment implementation. Mainnet uses script/deploy.sh and its existing unsigned-outcome/current-review gate. No alternative production deploy path or values loader was added.

## Proposed local-only rehearsal batch

**Awaiting the explicit local-batch authorization required by the owner's chain-operations guidance.** This is a concrete proposal, not authority to broadcast. No mainnet/testnet endpoint or production signer is included.

| Boundary | Proposed action / limit |
|---|---|
| Node | Only http://127.0.0.1:18554, verified owned Anvil fork, chain31337; assert node identity/fork before writes |
| Deployer | `0x000000000000000000000000000000000001D001`, fresh code-free local identity; nonce0 at preflight |
| Presentation / eligibility / default-policy admins | Local-only `0x000000000000000000000000000000000001d002` / `0x000000000000000000000000000000000001d003` / `0x000000000000000000000000000000000001D004` |
| Creators | Local-only `0x000000000000000000000000000000000001d005` and `0x000000000000000000000000000000000001d006` |
| Deployment | Execute exactly the eight decoded deployment actions, then verify actual code, linked libraries, roles and immutable wiring |
| Pools / inventory | At most two creator pools,3testETH per pool (6total), original DevSetup target10Shape prizes,1500bps markup and two local creator-issued DemoNFTs each; run the actual shared keeper |
| Exercise | At most50rehearsal rounds /252draws including markup probes, gas below/near/above V1's cap, keeper restarts and receipt reconciliation; no additional pool deposits or policy replacements |
| Test identities and funding | Only verified code-free creator/buyer/keeper identities; synthetic setup funds only, at most10testETH per creator/deployer/buyer identity and1testETH keeper. At most52buyers. No private keys are generated/exported. Do not overwrite protocol balances or storage. Retained deterministic coordinator exception must be disclosed and must not be described as real oracle behavior |
| Expense boundary | No real funds; at most6testETH deposited into pools. Controlled caller transactions stop if total actual gas paid reaches1testETH or a required next transaction's simulated fee would exceed the remaining allowance. Individual transaction limits remain at most16,777,216gas |
| Recovery / stop | Stop dependent actions on wrong chain/code/address/authority/nonce/receipt, unexplained accounting gap or funding limit. Preserve purchaser rights and all existing services. Keep the owned node available for a subsequent wallet check; do not publish or retire outside the stated exercise |

The historical rehearsal driver hardcodes old fork/accounts and needs the proposed values applied in a disposable local harness before execution. Those public accounts have delegated code at the current fork; fresh identities above were verified with zero code/nonce instead. Harness adaptation must preserve the actual deployment and keeper implementations, enforce the batch bounds, and retain exact commands/receipts. No current-block full lifecycle or50-round pass is claimed by this preparation.

This is an overfunded operational plumbing rehearsal:3testETH per pool. It cannot establish minimum-capital behavior. Exact-minimum reserve regimes remain separately measured in the candidate evidence. Existing curated NFT replenishment is an explicit creator contribution, not demand or free real-world inventory.

## Real-wallet check

| Interaction | Required observation |
|---|---|
| Connect existing browser wallet to local app | Actual extension connector, chain31337 and loopback RPC; local unlocked-node connector must be disabled in this preview |
| Approve/list creator NFT and open a pool | Wallet displays correct local contracts, spender/token/value; receipts and actual owner/custody match |
| Add ETH / run maintenance | Exact native amount and restored real inventory or explicit remaining deficit; separate booked profit/operating ETH/backing/unsold fees |
| Claim surplus | Amount agrees with withdrawableSurplus and receipt/readback; no purchaser obligations treated as cash |
| Propose/cancel policy | Correct address and two-day timestamp; cancel/readback; only exercise activation if explicitly included in a later authorized batch |

An existing browser-wallet account and the owner's wallet interaction are needed. Do not request/export a private key, import public test keys into a real wallet, or send mainnet ETH. A previous dev-node UI pass is not a real-extension pass. Funding a supplied public address on this isolated fork is synthetic setup, not mainnet funding.

FWA page publication is a separate external write; the read-only [compatibility investigation](FWA-PAGE-COMPATIBILITY.md) cannot establish server acceptance. Purchases do not depend on the optional page. Confirmation requires authorized server evidence/contact or an owner-authorized real publication. This local rehearsal does not supply either.

## Things that don't make sense

None identified in the proposed boundaries. The old public test identities are unsuitable as unexamined current-block wallet assumptions; their actual code was checked and fresh identities were prepared. Simulation is not a mined deployment or a real-wallet acceptance result.
