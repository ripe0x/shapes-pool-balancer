# Community replacement deployment plan (unsigned)

**Status: unsigned plan, nothing broadcast.** This replaces the 2026-11-22 community factory
(`0x91C31Ad620555DE24e62290906aD1aA14C4CE281`, now legacy) with a new BalancerFactory, PoolBalancer implementation
and any changed linked libraries, while **reusing** the existing Shapes, Draw Packs, renderer and FWA contracts. There
is **no keeper policy contract** (owner decision R95, 2026-11-23): the payment formula is in the `KeeperPolicyCalls`
library. Contract-dependent parts are filled in against the audit-repair candidate `f549bf9` (section 7a). Recheck
sizes, library addresses and section 7 against the commit you sign: any later source change to a created contract or
library moves them.

A generated `deployments/1.json` or a successful simulation is not a deployment. Only step 7's
`DEPLOYMENT VERIFIED` against mined receipts establishes one.

## 1. What is created and what is reused

| Contract | Mode | How it is established |
| --- | --- | --- |
| KeeperPolicyCalls, PoolPage, PoolInventory libraries | created by CREATE2 if their init code changed; otherwise Forge skips them and links the address already on chain | receipt (created) or code at the linked CREATE2 address (skipped) |
| PoolBalancer implementation | created (CREATE, deployer nonce) | receipt + readbacks |
| ~~KeeperPolicyV1~~ | not created since R95 (the 2026-11-22 policy `0x27c56f36…88Db` stays only for legacy pools) | — |
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
- Mainnet nonce read 2026-11-23 at block 26,480,612: **4158**; balance 0.052298546834342702 ETH. Any transaction from this account
  before step 6 shifts every CREATE address, so step 4 rereads the nonce and step 5's dry run is the address source of
  truth. The plan does not depend on a specific nonce; the verifier matches the broadcast to the reviewed dry run
  transaction for transaction (sender, nonce, kind, address, calldata).
- CREATE2 library addresses depend only on init code (salt 0 via `0x4e59b44847b379578588920cA78FbF26c0B4956C`). A
  library whose code did not change keeps its 2026-11-22 address and is not sent. At `f549bf9` (fork rehearsal
  2026-11-23, section 7a; earlier addresses superseded):
  - PoolPage unchanged: reused at `0x67C828Ad820490C02CDCBbCCc3A303c64207fBcf` (already on mainnet, 1,194 bytes, not sent).
  - KeeperPolicyCalls changed: new `0x5c6322442650A1177b4aFbF5f95166A59Ef7e7f7` (old `0x1601A841…B8fb` stays for
    legacy pools).
  - PoolInventory changed: new `0xb89B48F0b574BC84d513fC3C2962a6A2dE7Cc9f7` (old `0xD6e89D45…9fD0` stays).
  Neither new address has code on mainnet at block 26,481,996.
- Every transaction, CREATE2 libraries included, is sent by the deployer and uses one nonce. Order: KeeperPolicyCalls
  (N), PoolInventory (N+1), PoolBalancer (N+2), BalancerFactory (N+3): 4 transactions, 11,129,506 gas on the fork.
- Mainnet nonce read 2026-11-23 at block 26,481,996: **4158** (unchanged); balance 0.052298546834342702 ETH. With
  N = 4158 (`cast compute-address`): PoolBalancer `0x43d08cC10e6F441D5DF2DDF2650eB03A5eaA2445`, BalancerFactory
  `0x526FbD402624B50861f54c081B592cdCeE322929` (the address the former plan gave KeeperPolicyV1, one nonce earlier).
  Illustrative: step 5's dry run is the address source of truth.

## 3. Administrators and initial settings

| Role | Address | Source |
| --- | --- | --- |
| keeperAdmin (keeper eligibility) | `0xCB43078C32423F5348Cab5885911C3B5faE217F9` | `KEEPER_ADMIN` env, factory constructor |
| policyAdmin (factory economics, default bucket and product limits; trusted, R97) | `0xCB43078C32423F5348Cab5885911C3B5faE217F9` | `POLICY_ADMIN` env, factory constructor |
| Draw Packs presentation admin (reused, unchanged) | `0xCB43078C32423F5348Cab5885911C3B5faE217F9` | readback only; `PACKS_ADMIN` env is the expected value |

Initial factory settings, all set by the `BalancerFactory` constructor (no setup transaction) and listed in
`docs/CONFIG-INVENTORY.md` §0:

| Getter | Initial value |
| --- | --- |
| `economics()` | workFee 0.00002 ETH; maxGas 3,200,000; overheadGas **60,000**; gasPriceCeiling 5 gwei; priorityAllowance 0.05 gwei; restockGas **910,000**; restockFlat 0.0002 ETH; baseGas 200,000; processGas 1,800,000; reconcileGas 150,000; shapeGas 700,000; prizeGas 150,000; processGraceBlocks **50**; pausedProcessGraceBlocks **10** |
| `defaultBucketCapacity()` / `defaultBucketRefill()` | 0.622 ETH / 4,166,666,666,666,666 wei per second (`floor(0.05 ether / 12)`) |
| `productLimits()` | maxPrizes 1,000; minMarkupBps 1,000; maxMarkupBps 10,000 |
| `creationSettingsHash()` | `keccak256(abi.encode(poolHash, defaultBucketCapacity(), defaultBucketRefill()))` with `poolHash = keccak256(abi.encode(economics(), 0 follow, 0 generation, true, SHAPES.mintFee()))`; no address enters it since R95, so at mint fee 0.001 ETH it is `0x2b71d8007106d084bb50b843220eae92fcf61c12fb542ff011835be449ec70ae` on the fork and on mainnet alike |
| `keepersRestricted()` / `pendingKeeperAdmin()` / `pendingPolicyAdmin()` | false / zero / zero |

Overhead 60k and restocking 910k are measured recalibrations of V1's 50k and 900k (CONFIG-INVENTORY §0a). Derived
maxima: 0.0165 ETH per keeper payment, 0.00475 ETH restocking surcharge per Shape. `Deploy.s.sol` `_postflight`
(against its own `initialEconomics`) and `scripts/verify-deployment.ts` (against its `INITIAL_SETTINGS`) each state
these values independently of the constructor and require every readback to match.

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
forge build --sizes 2>&1 | grep -E "^\| (PoolBalancer|BalancerFactory|PoolInventory|PoolPage|KeeperPolicyCalls) "
```
Check: every runtime size is below 24,576 bytes. At `f549bf9`: PoolBalancer 23,408 (1,168 to spare), PoolInventory
12,119, KeeperPolicyCalls 8,435, BalancerFactory 5,290, PoolPage 1,194.

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
Check: a nonce N (4158 at block 26,481,996) and a balance of at least 11.2M gas at the intended max fee plus margin
(0.0112 ETH at 1 gwei; 0.0523 ETH held at block 26,481,996 covers up to about 4.7 gwei, 4.3 gwei with a 10% margin). Send nothing else from this
account until step 7.

**5 → Reviewed dry run (no broadcast).** Runs the asset-flow gate and simulates the deployment against mainnet.
```bash
script/deploy.sh --rpc-url $RPC --account ripe0x --sender $DEPLOYER --slow && cp broadcast/Deploy.s.sol/1/dry-run/run-latest.json deployments/1.replacement.reviewed-dry-run.json && shasum -a 256 deployments/1.replacement.reviewed-dry-run.json
```
Check: `ASSET FLOW GATE: PASS`, then `Packs 0xfE11c0E794475fd86801fb3020d779bd7887cB2D (reused)`; the transaction list
is exactly `KeeperPolicyCalls`, `PoolInventory`, `PoolBalancer`, `BalancerFactory` at nonces N..N+3
(no `KeeperPolicyV1`, `ShapePacks`, `ShapePackRenderer` or `PoolPage`); note the printed SHA-256 as `DRY_SHA`.

**6 → Broadcast.** The only step that signs.
```bash
script/deploy.sh --rpc-url $RPC --account ripe0x --sender $DEPLOYER --slow --broadcast && cp broadcast/Deploy.s.sol/1/run-latest.json deployments/1.replacement.broadcast.json
```
Check: `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL.` and the same addresses printed as in step 5.

**7 → Verify from canonical receipts.** Matches every mined transaction to the reviewed dry run and reads back the
created and reused contracts.
```bash
node --import tsx scripts/verify-deployment.ts --rpc-url $RPC --reviewed-dry-run deployments/1.replacement.reviewed-dry-run.json --reviewed-dry-run-sha256 $DRY_SHA --broadcast deployments/1.replacement.broadcast.json --out deployments/1.replacement.verified.json
```
Check: `DEPLOYMENT VERIFIED: deployments/1.replacement.verified.json`.

**8 → Postflight readbacks.** Independent `cast` reads of the wiring (set `F`, `I` from step 7's record: factory,
implementation).
```bash
cast call $F "implementation()(address)" --rpc-url $RPC && cast call $F "keeperAdmin()(address)" --rpc-url $RPC && cast call $F "policyAdmin()(address)" --rpc-url $RPC && cast call $F "keepersRestricted()(bool)" --rpc-url $RPC && cast call $I "creator()(address)" --rpc-url $RPC && cast call $I "PACKS()(address)" --rpc-url $RPC && cast call $I "SHAPES()(address)" --rpc-url $RPC && cast call $I "FWA_FACTORY()(address)" --rpc-url $RPC && cast call $I "FWA_IMPLEMENTATION()(address)" --rpc-url $RPC
```
Check, in order: `$I`, `0xCB43078C32423F5348Cab5885911C3B5faE217F9`, `0xCB43078C32423F5348Cab5885911C3B5faE217F9`,
`false`, `0x0000000000000000000000000000000000000001`, `0xfE11c0E794475fd86801fb3020d779bd7887cB2D`,
`0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0`, `0x8919814D825a5Af238cC04DE06b1C18c9eaA477C`,
`0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7`.

Then the initial settings (section 3):
```bash
cast call $F "economics()((uint64,uint32,uint32,uint64,uint64,uint32,uint64,uint32,uint32,uint32,uint32,uint32,uint16,uint16))" --rpc-url $RPC && cast call $F "defaultBucketCapacity()(uint128)" --rpc-url $RPC && cast call $F "defaultBucketRefill()(uint96)" --rpc-url $RPC && cast call $F "productLimits()(uint16,uint16,uint16)" --rpc-url $RPC && cast call $F "pendingKeeperAdmin()(address)" --rpc-url $RPC && cast call $F "pendingPolicyAdmin()(address)" --rpc-url $RPC && cast call $F "creationSettingsHash()(bytes32)" --rpc-url $RPC
```
Check: `(20000000000000, 3200000, 60000, 5000000000, 50000000, 910000, 200000000000000, 200000, 1800000, 150000,
700000, 150000, 50, 10)`, `622000000000000000`, `4166666666666666`, `1000 1000 10000`, zero address twice, and
`0x2b71d8007106d084bb50b843220eae92fcf61c12fb542ff011835be449ec70ae` while the Shapes mint fee is 0.001 ETH (step 7
also recomputes it).

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

How the app and keeper consume it (`shared/legacy.ts` reads this file; entries without an ABI are skipped):
1. Official creation uses only the replacement factory (`VITE_FACTORY`, from `deployments/1.replacement.verified.json`).
2. Pool discovery reads `BalancerCreated` from the replacement factory and from each `legacyFactories[i]` from its
   `deploymentBlock` (app `loadMine`; keeper `discover`, which tracks the last scanned block per factory and scans a
   factory it has no record for from its own block).
3. A pool's ABI follows its own `factory()`: a legacy factory's pool uses `abis[abiName]`, never the current
   `shared/abi.ts`. The app marks it "Legacy · community-v1", shows its fixed limits and admission, saves designs with
   the two-argument `configure` and changes policy through propose/cancel/activate. The keeper quotes, sends and
   decodes its receipts with the same ABI. `LEGACY_FACTORIES=0` turns legacy servicing off in the keeper.

## 6. Reused dependency checks

Run by `Deploy.s.sol` (before and after the broadcast), `scripts/deployment-preflight.ts` and
`scripts/verify-deployment.ts`, all against the constants in `Deploy.s.sol`:
1. Code present with the recorded code hash at Shapes, Draw Packs, renderer, FWA factory and FWA implementation.
2. `packs.shapes() == Shapes`, `packs.renderer() == renderer`, `packs.MIN_PACK_VALUE() == 0.02 ETH`,
   `renderer.shapes() == Shapes`, `packs.name()/symbol()` = `Pool Prize Packs`/`PRIZEPACK`.
3. `fwaFactory.implementation() == 0x85Faf929…Fee7`, `maxAcquisitionsPerTx() == 5` (the existing FWA checks).
4. Preflight only: the Packs and renderer runtimes equal the local `lib/shape-packs` (3a463f7) build with their
   immutables, so the recorded hashes are the reviewed source and not merely what was on chain.

## 7. Fork rehearsal evidence

### 7a. Current: audit-repair candidate `f549bf9` (2026-11-23)

Own anvil on port 18900, `--fork-url https://mainnet.gateway.tenderly.co --chain-id 31337` at the current head:
fork block **26,481,989**, hash `0x1156e5e51eef688cc11e146016367ac0bef749cec44dfee8dad5cd9f036ca0c0` (equal to
mainnet's). Fresh random impersonated roles (no anvil default keys): deployer `0x5f26fCF6…6eC3`, keeperAdmin
`0xE67e2Bf6…2C84`, policyAdmin `0x99C5bAc7…c8dc`, keeper `0x5c2BF54b…69e8`. Canonical `script/Deploy.s.sol`,
`REUSE_DEPENDENCIES=true`, dry run then broadcast:

| Contract | Address | Runtime bytes | Gas |
| --- | --- | --- | --- |
| KeeperPolicyCalls (CREATE2) | `0x5c6322442650A1177b4aFbF5f95166A59Ef7e7f7` | 8,435 | 1,880,315 |
| PoolInventory (CREATE2) | `0xb89B48F0b574BC84d513fC3C2962a6A2dE7Cc9f7` | 12,119 | 2,677,990 |
| PoolBalancer | `0x48A9A24a92df3De756fa1abfF51a07aDB8B05AFd` | 23,408 | 5,178,924 |
| BalancerFactory | `0x24729ccA7D244739ED1D57CD167486863B1F3e1f` | 5,290 | 1,392,277 |
| PoolPage (reused, not sent) | `0x67C828Ad820490C02CDCBbCCc3A303c64207fBcf` | 1,194 | — |

Total 11,129,506 gas. `verify-deployment.ts`: `DEPLOYMENT VERIFIED` (4 transactions, PoolPage preexisting, reused
dependencies matching, `creationSettingsHash` `0x2b71d800…70ae` at mint fee 0.001 ETH). `deployment-preflight.ts`
on the fork at block 26,481,993: ok, 0 pools on both old factories. Then the production `keeper/keeper.ts` process
(the only upkeep caller) and a driver acting as creators, players, the factory admin and the coordinator
(owner-approved exception); all 14 driver checks passed, none failed:

1. Two following pools (A, B) and one pinned pool P: `setLocalEconomics(factory.economics())` read at the reviewed
   block, source 1, same values and restocking price as the followers.
2. Every keeper payment in every round equals the formula: (measured + 60,000) x min(effective gas price, basefee +
   0.05 gwei, 5 gwei) plus whole work fees (remainder 0).
3. Factory `setEconomics` (work fee 0.00002 -> 0.00003 ETH, restock flat 0.0002 -> 0.0003 ETH; 49,008 gas): A and B
   moved at once (settings hash, work fee, restocking fee +0.0001 ETH); P did not (hash, work fee, restocking fee,
   maximum reward). New listings: A at 910,000 x 1.05 gwei + 0.0003 = 0.0012555 ETH per Shape, P at + 0.0002; payments
   after the change at 0.00003 ETH per unit on A and 0.00002 on P.
4. One draw without randomness on A: request block 26,482,040, word deadline 26,482,070, processable from 26,482,090;
   untouched at 26,482,088; processed in block 26,482,091 and paid 0.00029415315 ETH = (163,003 + 60,000) x 1.05 gwei
   + 2 x 0.00003 ETH (process and reconcile); status Expired, buyer refund credit equal to the quoted 0.028103710218775585 ETH.
5. Complete exit of B with two draws outstanding: close, the keeper reconciled them, 10 Shape listings unlisted and
   redeemed for 0.4 ETH, two curated NFTs back with the creator, proceeds collected, 3.014976515064827093 ETH claimed;
   Balancer 0 ETH, no listings, no owner proceeds left.

Keeper: 13 upkeep transactions mined, 0 reverted. Receipts and the full step log: `drive.json`, `rehearse.log`,
`keeper.log` in the session scratchpad `v5/` folder (not committed). Two earlier attempts of the same rehearsal stopped
in the driver before any pool existed (its file was CommonJS; then `forge script` priced DevSetup below the pinned
1 gwei basefee); both were rerun from a fresh anvil.

### 7a-prior. Release candidate `a609277` (2026-11-23, superseded by `f549bf9`)

Stuck draws without randomness, policy interface 3. Fork block 26,480,830, fresh random impersonated roles, canonical
`Deploy.s.sol` `REUSE_DEPENDENCIES=true`: 5 receipts, 11,771,292 gas; KeeperPolicyCalls
`0x0aB0D6ab1A152456010FC53251eAe6A02914D220`, PoolInventory `0x8A5927A59D05e81314B54F470cd7377128887489` (CREATE2);
`verify-deployment.ts` `DEPLOYMENT VERIFIED`. Full record: docs/CANDIDATE-REPORT.md section 0.

### 7a-prev. Superseded: release candidate `08be33f` (2026-11-23)

Full record: docs/CANDIDATE-REPORT.md. Fresh anvil (`--fork-url https://mainnet.gateway.tenderly.co --chain-id 31337
--port 18950`), fork block **26,480,609**, hash `0x1006c87388f1e4711e0e1469e891247052f5822e73c8546f1138603bfaf3f16e`
(equal to mainnet's), basefee 0.129 gwei. Deployer `0x69BDEC4e…7444`, keeperAdmin `0x9CAcA492…9C9b`, policyAdmin
`0x8FB9bA13…B10c`: random fresh addresses (no code, nonce 0, balance 0), funded 1 ETH by `anvil_setBalance` and
impersonated. Canonical `script/Deploy.s.sol`, `REUSE_DEPENDENCIES=true`, Forge 1.8.1, solc 0.8.28.

| Check | Result |
| --- | --- |
| Reuse dry run | passes, including `_postflight`; SHA-256 `1a2443cb…41a5`; 5 creations |
| Reuse broadcast (`--unlocked --slow`) | 5 receipts, status success, blocks 26,480,610..614 |
| `verify-deployment.ts` | `DEPLOYMENT VERIFIED`; initial settings match section 3 (grace 50/10); `creationSettingsHash` `0x19cf24ebc5cd16f9dd574a973f614d3c58e8ff8e18e5060389007c745780730c`; PoolPage preexisting; 5 reused dependencies with recorded code hashes |
| `deployment-preflight.ts` on the fork | `ok: true`, `problems: []`, 0 pools on both legacy factories at 26,480,614 |

| Contract | Address (fork) | Runtime bytes | Gas used | Effective gas price |
| --- | --- | --- | --- | --- |
| KeeperPolicyCalls (CREATE2) | `0x8d1e84409f65415455d0Ec1Ad891002BC8DE442f` | 8,883 | 1,977,225 | 0.127 gwei |
| PoolInventory (CREATE2) | `0x6b7e1D309798b1A9e8aB408D5436b3946B1B54FF` | 12,210 | 2,698,027 | 0.112 gwei |
| PoolBalancer | `0xB872975cb68e3e116B0a5F46303a0c9370A54661` | 24,275 | 5,366,349 | 0.099 gwei |
| KeeperPolicyV1 | `0xA460b8aC458d5e2ac692C356242166036230c7Fe` | 743 | 213,748 | 0.089 gwei |
| BalancerFactory | `0xA5B257E9E08b83CeA9E5e27A37C3226bcDDfDFBc` | 5,387 | 1,418,303 | 0.078 gwei |

Total 11,673,652 gas (0.0012157 ETH on the fork; 0.0117 ETH at 1 gwei). The CREATE2 library addresses are the mainnet
ones; the CREATE addresses are the fresh deployer's (mainnet predictions in section 2). The operational pass (keeper,
pools on both factories, factory and local updates, stuck draws, complete exit) is in docs/CANDIDATE-REPORT.md.

### 7b. History: A3 contracts with the reconciled tooling (`505d93d`, 2026-11-23)

Superseded by 7a.

Fresh anvil (`--fork-url https://mainnet.gateway.tenderly.co --chain-id 31337 --port 18900`), fork block
**26,480,077**, hash `0x1f799073529f94a4167a89e3b2e128b2811f6ed1b7e8ee9f3f77b1fba2f7df24` (equal to mainnet's),
basefee 0.177 gwei. Deployer `0x7eD53Cd8…b4d7`, keeperAdmin `0x478A6E99…bfc0`, policyAdmin `0x8619fC95…5B7b`:
random fresh addresses (no code, nonce 0, balance 0), deployer funded 1 ETH by `anvil_setBalance` and impersonated.
Canonical `script/Deploy.s.sol` with `REUSE_DEPENDENCIES=true`, Forge 1.8.1, solc 0.8.28, after `forge build --force`.

| Check | Result |
| --- | --- |
| Reuse dry run | passes, including `_postflight` initial-settings readbacks; `Packs 0xfE11…cB2D (reused)`; 5 creations; SHA-256 `bb24a881…d95f` |
| Reuse broadcast (`--unlocked --slow`) | 5 receipts, status success, blocks 26,480,078..082 |
| `verify-deployment.ts` | `DEPLOYMENT VERIFIED`; `transactions` = KeeperPolicyCalls, PoolInventory, PoolBalancer, KeeperPolicyV1, BalancerFactory; `preexistingLibraries` = PoolPage `0x67C828Ad…fBcf`; `initialSettings` match section 3, `creationSettingsHash` `0x9e72aad376473be2b4c861e580d00f8f9281c3fe1d2e87bb5fa3357623892655` at mint fee 0.001 ETH; `reusedDependencies` 5 matching code hashes, `matchesLocalBuild` true for Packs and renderer |
| `deployment-preflight.ts` on the fork | `ok: true`, `problems: []`, 0 pools on both legacy factories at fork block 26,480,082 |
| Live interface-1 policy | `setEconomics` from policyAdmin with policy `0x27c56f36…88Db` reverts `InvalidPolicy()` (`0xd06b96b1`); the same struct with the new policy succeeds |

| Contract | Address (fork) | Runtime bytes | Gas used | Effective gas price |
| --- | --- | --- | --- | --- |
| KeeperPolicyCalls (CREATE2) | `0x924dDC89b64C51759C0b27f9dd044D1A65184731` | 7,529 | 1,683,967 | 0.159 gwei |
| PoolInventory (CREATE2) | `0x930114134C867A62FE8bE0dC7f365cAaDCDcbB85` | 12,110 | 2,676,394 | 0.141 gwei |
| PoolBalancer | `0x880f72551283D0a0B9Ff8eb15BE76D584ac3225C` | 24,027 | 5,312,885 | 0.125 gwei |
| KeeperPolicyV1 | `0x75Fc1dd1c70F627E3568f25762EFB06A284E88C4` | 732 | 211,616 | 0.112 gwei |
| BalancerFactory | `0xfd3831E05Ec64212cA3E73206b60C5E8D62C246F` | 5,122 | 1,358,373 | 0.098 gwei |

Total 11,243,235 gas, 0.001466 ETH on the fork. At 1 gwei that is 0.0112 ETH; the deployer held 0.0523 ETH at block
26,480,080. The CREATE2 library addresses are the mainnet ones; the CREATE addresses are the fresh deployer's.

The legacy-pool operability rows below (7c) were not rerun on `505d93d`: that path depends on the old factory and
the packaged `community-v1` ABI, which this commit does not change. The permanent fork acceptance case is planned as
`test_legacyPoolRemainsOperable` (CONFIG-INVENTORY §5, row L) in `test/CommunityConfigAcceptance.t.sol`, which is
not on this branch yet.

### 7c. History: tooling slice (source at `7ed3335`)

Proved the deployment tooling before the A3 contract changes; its addresses, sizes and gas are superseded by 7a.

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
