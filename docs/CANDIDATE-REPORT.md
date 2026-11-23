# Community release candidate report (2026-11-23)

**Tested commit: `08be33f`** (contracts, tests, app, keeper, docs). The commit after it adds only this report and
the deployment plan refresh. **Nothing was deployed or broadcast on mainnet.**

## 1. What the candidate is

The community replacement release (PR #33) plus the owner's processing decision of 2026-11-23: upkeep processes FWA's
queue only for stuck draws (Ready, requested at least `processGraceBlocks` = 50 blocks ago, 10 while sales are paused
BUSY or LOW_INVENTORY, at most two per call), paid as gas plus one work fee per processed draw. Full rule, abuse
bounds and test changes: docs/DECISIONS.md "Owner decision: paid processing of stuck draws only".

## 2. Toolchain and sizes

Forge 1.8.1, solc 0.8.28 (via-IR, 50 runs), Node 22.19.0. Runtime bytes (limit 24,576):

| Contract | Bytes | Spare |
| --- | --- | --- |
| PoolBalancer | 24,275 | 301 (24,027 before this change) |
| PoolInventory | 12,210 | |
| KeeperPolicyCalls | 8,883 | |
| BalancerFactory | 5,387 | |
| PoolPage | 1,194 | |
| KeeperPolicyV1 | 743 | |

## 3. Test results

This batch, on the final code (mainnet fork block 26,382,349 for fork tests):

| Command | Result |
| --- | --- |
| `forge build --force --sizes` | pass, sizes above |
| `npm run abi` | `shared/abi.ts` changed (Economics gains two uint16 fields); committed |
| `npm run typecheck`, `npm run build:app` | pass |
| `forge test` CommunityConfigAcceptance, KeeperEconomics, Settings, ProcessQueue, Hardening, ConcurrentRecovery, PolicyModelParity, PolicyPreview, PolicyLifecycle, Reserve, ReserveCapital, ReserveCapitalMatrix, BatchSlippage, ProductLimits, MintFeeChange, Balancer | 133 / 133 |
| `forge test` Gas, KeeperPay `--isolate` | 34 / 34 |
| `forge test` FlowBreakdown `--gas-limit 100000000000 --isolate` | 30 / 30 |
| `forge test --match-contract ParityFixture` | pass |
| `vitest` on the touched files (policy, planner, money path, quotes, simulation, reserve capital, design, keeper, deployment preflight) | 129 passed, 2 skipped (opt-in mainnet reads) |

The first run of the batch found 13 failures. All but two came from the rule change (expired draws are no longer
processed by upkeep; one more work fee per owed draw); the two contract findings are in section 6. Failing tests were
fixed and rerun, then the main forge list and ParityFixture were rerun once on the final code. Earlier full batch on
`84abccc`: 237/238 Solidity (BatchSlippage stale literal, since fixed), 235 TS, Gas/KeeperPay 34, FlowBreakdown 30,
ParityFixture pass. The whole TS suite was not rerun (the repository guard reserves it for `CANDIDATE_RUN=1`).

## 4. Fork redeploy rehearsal

Fresh anvil on port 18950 (`--fork-url https://mainnet.gateway.tenderly.co --chain-id 31337`), fork block
**26,480,609**, hash `0x1006c87388f1e4711e0e1469e891247052f5822e73c8546f1138603bfaf3f16e` (equal to mainnet's).
Random fresh deployer `0x69BDEC4e903a6e588075Db6D6Ae646085A357444`, keeperAdmin `0x9CAcA492…9C9b`, policyAdmin
`0x8FB9bA13…B10c`, keeper `0xe22Bbf22…B7a3` (no code, nonce 0, balance 0; funded by `anvil_setBalance`, unlocked).
Canonical `script/Deploy.s.sol`, `REUSE_DEPENDENCIES=true`. Anvil stopped at the end.

| Contract | Mode | Fork address | Gas |
| --- | --- | --- | --- |
| KeeperPolicyCalls | created (CREATE2, mainnet address) | `0x8d1e84409f65415455d0Ec1Ad891002BC8DE442f` | 1,977,225 |
| PoolInventory | created (CREATE2, mainnet address) | `0x6b7e1D309798b1A9e8aB408D5436b3946B1B54FF` | 2,698,027 |
| PoolBalancer | created | `0xB872975cb68e3e116B0a5F46303a0c9370A54661` | 5,366,349 |
| KeeperPolicyV1 | created | `0xA460b8aC458d5e2ac692C356242166036230c7Fe` | 213,748 |
| BalancerFactory | created | `0xA5B257E9E08b83CeA9E5e27A37C3226bcDDfDFBc` | 1,418,303 |
| PoolPage | reused library | `0x67C828Ad820490C02CDCBbCCc3A303c64207fBcf` | not sent |
| Shapes, Draw Packs, renderer, FWA factory, FWA implementation | reused | recorded code hashes matched | |

Total 11,673,652 gas. `verify-deployment.ts`: `DEPLOYMENT VERIFIED`. `deployment-preflight.ts` on the fork: `ok`,
no problems, 0 legacy pools.

Config readbacks (fork, block 26,480,614): economics = policy `0xA460…c7Fe`, workFee 0.00002 ETH, maxGas 3,200,000,
overheadGas 60,000, gasPriceCeiling 5 gwei, priorityAllowance 0.05 gwei, restockGas 910,000, restockFlat 0.0002 ETH,
baseGas 200,000, processGas 1,800,000, reconcileGas 150,000, shapeGas 700,000, prizeGas 150,000,
processGraceBlocks 50, pausedProcessGraceBlocks 10; bucket 0.622 ETH and 4,166,666,666,666,666 wei per second;
product limits 1,000 prizes, markup 1,000 to 10,000 bps; `creationSettingsHash`
`0x19cf24ebc5cd16f9dd574a973f614d3c58e8ff8e18e5060389007c745780730c` at mint fee 0.001 ETH (recomputed from a
new pool's own hash and bucket: equal).

Operational pass (production `keeper/keeper.ts` as a separate process, basefee pinned at 1 gwei):
1. Two following pools (A, B) and one pinned pool (P) through the new factory; one pool (L) on the old factory
   `0x91C31Ad6…E281` with its `community-v1` ABI (`isBalancer` true there, false on the new factory). The keeper
   stocked all four and replenished after three rounds of draws.
2. **Stuck draw** on A: two draws, randomness last to first; FWA's callback processed the head only. 46 blocks after
   the request the keeper had not touched the stuck draw; after the 50-block grace it processed and was paid for it,
   while a fresh draw (Ready, 4 blocks old, behind it) stayed untouched; that one was processed after its own grace.
3. Live factory update (workFee 0.00002 → 0.00003 ETH, 50,372 gas): A and B hashes moved
   `0x2fb30e3b…` → `0x78b904bc…`, pinned P kept `0x8aaaf1c9…`, creation hash `0x19cf24eb…` → `0xc82a4b23…`, a
   creation bound to the old hash was refused.
4. Local update on B (workFee 0.000025, restockFlat 0.00025 ETH; maintenance shortfall 0): B hash `0x588ad06a…`,
   source local, generation 1; restocking fee B 0.0012055 vs A 0.0011555 ETH per Shape.
5. Complete exit of B: one draw without randomness at the queue head and two Ready behind it, then close. Upkeep did
   not process the expired head; a third party's direct `processAcquisitions(5)` settled all three
   (**561,353 gas**; the expired buyer holds 0.028047 ETH refund credit); the keeper reconciled; 9 Shape listings
   unlisted, 2 curated NFTs returned to the creator, 3.045603 ETH claimed; Balancer balance, creator credit and
   required reserve all 0.

Paid upkeeps that processed draws (keeper receipts; measured = `KeeperPaid.gasUsed`; each paid amount equals
(measured + 60,000) × price + one processed and one reconciled work fee):

| Block | Measured gas | processAcquisitions call gas | Billed gas | Price | Paid (ETH) |
| --- | --- | --- | --- | --- | --- |
| 26,480,869 | 179,502 | 76,748 | 229,279 | 1.05 gwei | 0.0002914771 |
| 26,480,920 | 783,269 | 624,879 | 683,437 | 0.925 gwei | 0.000820023825 |
| 26,480,712 (first run) | 179,502 | 76,748 | 229,279 | 1.05 gwei | 0.0002914771 |
| 26,480,766 (first run) | 788,069 | 629,679 | 688,237 | 1.05 gwei | 0.00093047245 |

All 39 keeper transactions succeeded: 61,786,104 billed gas, 0.0566431 ETH paid, no settings hash changed inside an
upkeep (per-transaction measured, billed, paid and hash before/after are in the rehearsal record). A first driver run
stopped at the exit step (a harness basefee artifact, then a refused purchase after draws won B's curated NFTs); its
pools and receipts are included above, and the exit was completed by a continuation on the same fork.

Gas measurements in tests: docs/GAS.md "Paid processing of stuck draws".

## 5. Mainnet

- Read-only preflight (Tenderly), pinned block **26,480,644**, hash
  `0x46f7265de968703b7dcb30760a370d192ba6310ee9b4ce24ce37bd3ebf809f3a`: `ok: true`, no problems; **0 pools** on
  `0x91C31Ad6…E281` (scanned from 26,475,448) and 0 on `0xA57de1a6…7ece` (from 26,453,686); no missing ABI selectors.
- Deployer `0xCB43078C32423F5348Cab5885911C3B5faE217F9` at block 26,480,612: nonce **4158**, balance
  **0.052298546834342702 ETH**. Deployment needs about 11.7M gas: 0.0117 ETH at 1 gwei; the balance covers about
  4.4 gwei (4.0 with a 10% margin). Basefee was about 0.13 gwei.
- Predicted mainnet addresses for 0xCB43 at nonce 4158 (5 transactions; the CREATE2 libraries have no mainnet code):
  KeeperPolicyCalls `0x8d1e84409f65415455d0Ec1Ad891002BC8DE442f` (4158), PoolInventory
  `0x6b7e1D309798b1A9e8aB408D5436b3946B1B54FF` (4159), PoolBalancer `0x43d08cC10e6F441D5DF2DDF2650eB03A5eaA2445`
  (4160), KeeperPolicyV1 `0x526FbD402624B50861f54c081B592cdCeE322929` (4161), BalancerFactory
  `0x1abD8bF61c05be3efDDa7F3e34a11417036ddED4` (4162). The step 5 dry run in the deployment plan is the source of truth.

## 6. Review and findings

- Independent review of the release: contracts met the spec; the app gaps found at `7bf0517` are fixed. Owner
  decisions recorded: the factory admin is trusted and the bucket defaults are kept; processing is paid only for stuck
  draws after the grace (this change).
- Found and fixed during this batch: (1) excluding the stuck check's gas from pay underpaid every ordinary reconcile by
  the cold FWA reads it moved (KeeperPay at 5 gwei: −0.00002075 ETH); the check is now ordinary paid upkeep work.
  (2) The first layout exceeded the size limit by 87 bytes; the scan and the processing call moved into
  `KeeperPolicyCalls`.
- Not independently reviewed: this processing change itself (no separate reviewer ran on `08be33f`).

## 7. Remaining blockers (owner)

1. New asset-flow gate run (`ASSET FLOW GATE: PASS`) and the owner's signature on the new source hash of this commit.
2. Merge to `main`, then the deployment plan's runbook from the main checkout.
3. Deployer gas: 0.0523 ETH covers the deployment up to about 4 gwei; top up if fees are higher at signing time.
4. Mainnet broadcast by the owner only (`--account ripe0x`), then verification, the post-cutover legacy scan and the
   dashboard switch.
