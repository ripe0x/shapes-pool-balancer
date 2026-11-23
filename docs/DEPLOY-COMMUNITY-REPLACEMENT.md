# Community replacement deployment plan (unsigned)

**Status: unsigned plan, nothing broadcast.** This replaces the 2026-11-22 community factory
(`0x91C31Ad620555DE24e62290906aD1aA14C4CE281`, now legacy) with a new BalancerFactory, PoolBalancer implementation,
KeeperPolicyV1 and any changed linked libraries, while **reusing** the existing Shapes, Draw Packs, renderer and FWA
contracts. Parts marked **[contract slice]** depend on constructor and initial-setting changes still landing on
`claude/community-release`; finalize them against the frozen candidate before signing.

A generated `deployments/1.json` or a successful simulation is not a deployment. Only step 7's
`DEPLOYMENT VERIFIED` against mined receipts establishes one.

## 1. What is created and what is reused

| Contract | Mode | How it is established |
| --- | --- | --- |
| KeeperPolicyCalls, PoolPage, PoolInventory libraries | created by CREATE2 if their init code changed; otherwise Forge skips them and links the address already on chain | receipt (created) or code at the linked CREATE2 address (skipped) |
| PoolBalancer implementation | created (CREATE, deployer nonce) | receipt + readbacks |
| KeeperPolicyV1 | created (CREATE) **[contract slice: drop if the policy is unchanged and the new factory takes the existing one]** | receipt + readbacks |
| BalancerFactory | created (CREATE) | receipt + readbacks |
| Shapes `0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0` | reused | code hash `0x5128789a…87d7`, 22,460 bytes |
| Draw Packs `0xfE11c0E794475fd86801fb3020d779bd7887cB2D` | reused | code hash `0xf8239826…3a7c`, 17,768 bytes; equals local `lib/shape-packs` build; `shapes()`, `renderer()`, `MIN_PACK_VALUE() = 0.02 ETH` |
| Renderer `0xA998bE44f1f06E119523C33Bb0d65f45728Ea65A` | reused | code hash `0x4315f1dd…66fe`, 9,354 bytes; equals local build; `shapes()` |
| FWA community factory `0x8919814D825a5Af238cC04DE06b1C18c9eaA477C` | reused | code hash `0xb998454c…e36e`, 18,856 bytes; `implementation()`, `maxAcquisitionsPerTx() = 5` |
| FWA implementation `0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7` | reused | code hash `0x0af01fc1…ce02`, 24,280 bytes |

`script/Deploy.s.sol` refuses chain 1 unless `REUSE_DEPENDENCIES=true`, and in reuse mode checks every row above
(code hash and relationships) before and after the broadcast. The full mode (creates its own Packs and renderer)
remains for local forks and historical tests. `scripts/verify-deployment.ts` records created contracts under
`transactions` (each matched to its creation receipt) and reused ones under `reusedDependencies` (code hash, size and
getter readbacks at the checked block; no receipts).

## 2. Nonce and address assumptions

- Deployer and signer: `0xCB43078C32423F5348Cab5885911C3B5faE217F9`, `--account ripe0x`. It is an EIP-7702 account
  (Calibur), so nodes accept one in-flight transaction from it: every broadcast uses `--slow`.
- Mainnet nonce read 2026-11-23 at block 26,479,596: **4158**; balance 0.0523 ETH. Any transaction from this account
  before step 6 shifts every CREATE address, so step 4 rereads the nonce and step 5's dry run is the address source of
  truth. The plan does not depend on a specific nonce; the verifier matches the broadcast to the reviewed dry run
  transaction for transaction (sender, nonce, kind, address, calldata).
- CREATE2 library addresses depend only on init code (salt 0 via `0x4e59b44847b379578588920cA78FbF26c0B4956C`). A
  library whose code did not change keeps its 2026-11-22 address and is not sent. At the current branch head
  KeeperPolicyCalls (`0x1601A841…B8fb`) and PoolPage (`0x67C828Ad…fBcf`) are unchanged; PoolInventory changed.
  **[contract slice: recheck after the final source.]**
- Expected order of created contracts: changed libraries, then PoolBalancer, KeeperPolicyV1, BalancerFactory.
  With 1 changed library that is 4 transactions at nonces N..N+3. Fork evidence in section 7.

## 3. Administrators and initial settings

| Role | Address | Source |
| --- | --- | --- |
| keeperAdmin (keeper eligibility) | `0xCB43078C32423F5348Cab5885911C3B5faE217F9` | `KEEPER_ADMIN` env, factory constructor |
| policyAdmin (default policy, factory economics and product limits) | `0xCB43078C32423F5348Cab5885911C3B5faE217F9` | `POLICY_ADMIN` env, factory constructor |
| Draw Packs presentation admin (reused, unchanged) | `0xCB43078C32423F5348Cab5885911C3B5faE217F9` | readback only; `PACKS_ADMIN` env is the expected value |

Initial factory settings **[contract slice]**: default KeeperPolicyV1, keeper list open, and the factory economic
configuration and product limits of `docs/CONFIG-INVENTORY.md` §1b and §2 (work fee 0.00002 ETH, reimbursable gas
3,200,000, overhead 50,000, gas price ceiling 5 gwei, priority 0.05 gwei, restock 900,000 gas + 0.0002 ETH per
shape, maxPrizes 1,000, markup 1,000..10,000 bps, bucket 0.622 ETH and `floor(0.05 ether / 12)` wei/s). Their
constructor arguments go in `Deploy.s.sol` `_deploySystem` and their readbacks in `_postflight`, step 8 and
`scripts/verify-deployment.ts`.

## 4. Runbook

Run from the **main checkout on branch `main`** only, after the candidate is merged and `ASSET FLOW GATE: PASS` is
observed for it. Steps 1 to 5 are read-only; step 6 is the only broadcast.

**Setup.**
```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer && export RPC=https://mainnet.gateway.tenderly.co DEPLOYER=0xCB43078C32423F5348Cab5885911C3B5faE217F9 PACKS_ADMIN=0xCB43078C32423F5348Cab5885911C3B5faE217F9 KEEPER_ADMIN=0xCB43078C32423F5348Cab5885911C3B5faE217F9 POLICY_ADMIN=0xCB43078C32423F5348Cab5885911C3B5faE217F9 REUSE_DEPENDENCIES=true
```

**1 → Main is current.** Confirms the checkout is `main`, level with `origin/main`, at the reviewed commit.
```bash
git fetch origin && git status -sb | head -1 && git rev-parse HEAD
```
Check: `## main...origin/main` with no `[ahead`/`[behind` and the reviewed candidate commit **[fill in]**.

**2 → Build.** Compiles with the pinned profiles and prints runtime sizes.
```bash
forge build --sizes 2>&1 | grep -E "^\| (PoolBalancer|BalancerFactory|KeeperPolicyV1|PoolInventory|PoolPage|KeeperPolicyCalls) "
```
Check: every runtime size is below 24,576 bytes and equals the candidate report **[fill in]**.

**3 → Cutover preflight (read-only).** Pins the head block, scans every legacy factory for created pools, verifies
the reused dependencies and writes `deployments/1.preflight.json`.
```bash
node --import tsx scripts/deployment-preflight.ts --rpc-url $RPC --out deployments/1.preflight.json
```
Check: `"ok": true`, `"problems": []`; `legacyPools` lists `0x91C31Ad620555DE24e62290906aD1aA14C4CE281` and
`0xA57de1a6Ad66aB053057Ff7829F65eFe1cD57ece` with their counts. A non-zero count is expected to be possible (the old
factories stay permissionless); each pool is listed in the file and stays managed through `deployments/1.legacy.json`.

**4 → Deployer nonce and balance.**
```bash
cast nonce $DEPLOYER --rpc-url $RPC && cast balance $DEPLOYER --rpc-url $RPC --ether
```
Check: a nonce N (4158 when this plan was drafted) and a balance of at least 0.01 ETH. Send nothing else from this
account until step 7.

**5 → Reviewed dry run (no broadcast).** Runs the asset-flow gate and simulates the deployment against mainnet.
```bash
script/deploy.sh --rpc-url $RPC --account ripe0x --sender $DEPLOYER --slow && cp broadcast/Deploy.s.sol/1/dry-run/run-latest.json deployments/1.replacement.reviewed-dry-run.json && shasum -a 256 deployments/1.replacement.reviewed-dry-run.json
```
Check: `ASSET FLOW GATE: PASS`, then `Packs 0xfE11c0E794475fd86801fb3020d779bd7887cB2D (reused)`; the transaction list
contains no `ShapePacks` or `ShapePackRenderer`, ends with `PoolBalancer`, `KeeperPolicyV1`, `BalancerFactory`, starts
at nonce N; note the printed SHA-256 as `DRY_SHA`.

**6 → Broadcast.** The only step that signs.
```bash
script/deploy.sh --rpc-url $RPC --account ripe0x --sender $DEPLOYER --slow --broadcast && cp broadcast/Deploy.s.sol/1/run-latest.json deployments/1.replacement.broadcast.json
```
Check: `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL.` and the same three addresses printed as in step 5.

**7 → Verify from canonical receipts.** Matches every mined transaction to the reviewed dry run and reads back the
created and reused contracts.
```bash
node --import tsx scripts/verify-deployment.ts --rpc-url $RPC --reviewed-dry-run deployments/1.replacement.reviewed-dry-run.json --reviewed-dry-run-sha256 $DRY_SHA --broadcast deployments/1.replacement.broadcast.json --out deployments/1.replacement.verified.json
```
Check: `DEPLOYMENT VERIFIED: deployments/1.replacement.verified.json`.

**8 → Postflight readbacks.** Independent `cast` reads of the wiring (set `F`, `I`, `P` from step 7's record:
factory, implementation, keeperPolicy).
```bash
cast call $F "implementation()(address)" --rpc-url $RPC && cast call $F "keeperAdmin()(address)" --rpc-url $RPC && cast call $F "policyAdmin()(address)" --rpc-url $RPC && cast call $F "defaultKeeperPolicy()(address)" --rpc-url $RPC && cast call $F "keepersRestricted()(bool)" --rpc-url $RPC && cast call $I "creator()(address)" --rpc-url $RPC && cast call $I "PACKS()(address)" --rpc-url $RPC && cast call $I "SHAPES()(address)" --rpc-url $RPC && cast call $I "FWA_FACTORY()(address)" --rpc-url $RPC && cast call $I "FWA_IMPLEMENTATION()(address)" --rpc-url $RPC
```
Check, in order: `$I`, `0xCB43078C32423F5348Cab5885911C3B5faE217F9`, `0xCB43078C32423F5348Cab5885911C3B5faE217F9`,
`$P`, `false`, `0x0000000000000000000000000000000000000001`, `0xfE11c0E794475fd86801fb3020d779bd7887cB2D`,
`0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0`, `0x8919814D825a5Af238cC04DE06b1C18c9eaA477C`,
`0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7`. **[contract slice: add the factory economic configuration getters and
their initial values.]**

**9 → Post-cutover legacy scan.** Rescans the old factories at a block after the deployment, so the record covers any
pool created during the cutover.
```bash
node --import tsx scripts/deployment-preflight.ts --rpc-url $RPC --out deployments/1.preflight.json
```
Check: `"ok": true`; `checkedBlock.number` is above the BalancerFactory receipt block from step 7.

**10 → Record.** Commit `deployments/1.replacement.*.json` and `deployments/1.preflight.json` on a branch and open a
PR; switch the dashboard's `VITE_FACTORY`/`VITE_FROM_BLOCK` to the new factory and its block (Phase B).
```bash
git switch -c claude/community-replacement-record && git add deployments/1.replacement.reviewed-dry-run.json deployments/1.replacement.broadcast.json deployments/1.replacement.verified.json deployments/1.preflight.json && git diff --cached --stat
```
Check: exactly those four files staged.

## 5. Legacy factories (old pools stay manageable)

`deployments/1.legacy.json` lists every earlier factory: address, deployment block, implementation, policy,
libraries, source commit and the **ABI name** to manage its pools. `community-v1` (factory `0x91C31Ad6…E281`,
source `40ad9dd`) carries its own BalancerFactory, PoolBalancer, IKeeperPolicy and KeeperPolicyV1 ABIs under
`abis["community-v1"]`; the preflight checks every function selector of those ABIs against the deployed code.
`community-v0` (`0xA57de1a6…7ece`, superseded, never used) is scanned but has no packaged ABI; the preflight fails
if a pool ever appears there.

How the app and keeper should consume it (Phase B, not implemented here):
1. Official creation uses only the replacement factory (`deployments/1.replacement.verified.json`).
2. Pool discovery reads `BalancerCreated` from the replacement factory and from each `legacyFactories[i]` from its
   `deploymentBlock`.
3. A pool's ABI comes from the factory that emitted its `BalancerCreated` (`isBalancer` on that factory confirms it),
   never from the current `shared/abi.ts`. Legacy pools keep their old keeper behaviour: the keeper quotes them with
   the old `previewUpkeep`/policy ABI and never sends new-ABI calls to them.

## 6. Reused dependency checks

Run by `Deploy.s.sol` (before and after the broadcast), `scripts/deployment-preflight.ts` and
`scripts/verify-deployment.ts`, all against the constants in `Deploy.s.sol`:
1. Code present with the recorded code hash at Shapes, Draw Packs, renderer, FWA factory and FWA implementation.
2. `packs.shapes() == Shapes`, `packs.renderer() == renderer`, `packs.MIN_PACK_VALUE() == 0.02 ETH`,
   `renderer.shapes() == Shapes`, `packs.name()/symbol()` = `Pool Prize Packs`/`PRIZEPACK`.
3. `fwaFactory.implementation() == 0x85Faf929…Fee7`, `maxAcquisitionsPerTx() == 5` (the existing FWA checks).
4. Preflight only: the Packs and renderer runtimes equal the local `lib/shape-packs` (3a463f7) build with their
   immutables, so the recorded hashes are the reviewed source and not merely what was on chain.

## 7. Fork rehearsal evidence (tooling slice, source at `7ed3335`)

This proves the deployment tooling, not the final candidate: the contract slice will change the created contracts,
their addresses, sizes and gas. Rerun it on the frozen candidate.

Fresh anvil (`--fork-url https://mainnet.gateway.tenderly.co --chain-id 31337 --port 18917`), fork block
**26,479,654**, hash `0x38848378e502a3629e42458d879df21596e585075a855ea703e8997fb427319a` (equal to mainnet's),
basefee 0.163 gwei. Deployer `0x…1e001` (fresh: no code, nonce 0, balance 0, then funded 1 ETH by
`anvil_setBalance` and impersonated); keeperAdmin `0x…1e003`, policyAdmin `0x…1e004`. Forge 1.8.1, solc 0.8.28.

| Check | Result |
| --- | --- |
| Full mode dry run (old path) | passes; creates PoolInventory, ShapePackRenderer, ShapePacks, PoolBalancer, KeeperPolicyV1, BalancerFactory (6: KeeperPolicyCalls and PoolPage already on chain) and decodes with `prepare-local-rehearsal.ts --check` |
| Reuse dry run | passes; `Packs 0xfE11…cB2D (reused)`; 4 creations; reviewed dry run SHA-256 `29d9d83b…c153` |
| Reuse broadcast (`--unlocked --slow`) | 4 receipts, all status 1, blocks 26,479,655..658 |
| `verify-deployment.ts` | `DEPLOYMENT VERIFIED`; `transactions` = PoolInventory, PoolBalancer, KeeperPolicyV1, BalancerFactory; `preexistingLibraries` = KeeperPolicyCalls `0x1601A841…B8fb`, PoolPage `0x67C828Ad…fBcf`; `reusedDependencies` with 5 matching code hashes and `matchesLocalBuild` true for Packs and renderer |
| Deployed runtimes | each created contract's code hash equals the hash decoded from the build artifact with links and immutables |
| `deployment-preflight.ts` on the fork | `ok: true`, 0 legacy pools at block 26,479,658 |
| Tampered Packs code (`anvil_setCode`, snapshot reverted after) | `Deploy.s.sol` reverts `Draw Packs code changed`; preflight exits 1 with the code hash, reverted getters and local-build mismatch listed |
| Pool created on the old factory after the new factory exists | preflight lists it (1 pool: balancer `0x299bA8aF…c446`, pool `0xc3603915…8C39`, salt `0x…01`, block 26,479,659); with the `community-v1` ABI from `deployments/1.legacy.json`: `isBalancer` true on the old factory, false on the new one; creator `configure(1600, target)` succeeded and `markupBps` read back 1600 |

Created contracts (fresh deployer, nonces 0..3):

| Contract | Address | Runtime bytes | Gas used | Effective gas price |
| --- | --- | --- | --- | --- |
| PoolInventory (CREATE2) | `0x9d32F6bf3bF99a282ab97aFFF2E22c68E27e7ed6` | 11,484 | 2,540,744 | 0.164 gwei |
| PoolBalancer | `0xbf61048ABffF1e056956679eA34e64a068d37bd5` | 21,045 | 4,667,984 | 0.145 gwei |
| KeeperPolicyV1 | `0x940815eE17aa44E861bEfe77e6812EB0f2da9710` | 829 | 232,232 | 0.130 gwei |
| BalancerFactory | `0xbe49677a403F77136e81498e5681f8DC22Aa1181` | 3,517 | 901,196 | 0.114 gwei |

Total 8,342,156 gas, 0.001226 ETH on the fork. The same dry run sent as `0xCB43…17F9` (fork nonce 4158, no
broadcast) predicts PoolInventory `0x9d32F6bf…7ed6` (nonce 4158), PoolBalancer `0x781266b7…09e6` (4159), KeeperPolicyV1
`0x43d08cc1…2445` (4160), BalancerFactory `0x526fbd40…2929` (4161): illustrative only, superseded by the final source.

Mainnet preflight (`deployments/1.preflight.json`): block **26,479,663**, hash
`0xe18978d1d865892344356116593192141668d6a8222e16806823ff8f993a7573`; `ok: true`; **0 pools** on
`0x91C31Ad6…E281` (scanned from 26,475,448) and 0 on `0xA57de1a6…7ece` (from 26,453,686); a second run pinned to the
same block produced a byte-identical file. Recheck at cutover (step 3 and step 9): the old factories stay permissionless.
