# Mainnet deployment approval packet

**Prepared for owner approval. No mainnet transaction has been broadcast.** Code revision `cf4dccdb43ba362284ed68c0c908e93331bdb1aa` is the merged candidate; subsequent evidence-only documentation does not change its bytecode. This packet requests approval for the four deployments below. The later factory setup and public opening remain separate actions.

## Decision to approve

| Item | Exact proposed action |
| --- | --- |
| Network | Ethereum mainnet, chain **1** |
| Expected signer | RIPE, `0xCB43078C32423F5348Cab5885911C3B5faE217F9`, existing encrypted keystore `ripe0x` |
| Proposed broadcast provider | Alchemy using the existing stored credential, only if the owner explicitly approves these broadcasts; credential remains outside arguments, logs and files |
| Transactions | Four sequential deployments using the canonical `script/deploy.sh` / `Deploy.s.sol` path, `--slow` for the delegated signer |
| Native value | **0 ETH** on every transaction |
| Deployment max fee / priority fee | **0.25 / 0.05 gwei** |
| Total transaction gas limits | **15,720,734 gas** |
| Maximum deployment gas commitment | **0.0039301835 ETH** |
| Result | Two linked libraries, v2 PoolBalancer implementation, and a new **publicly paused** factory |
| Existing contracts and assets | No existing factory pointer, pool, NFT, balance, or live service configuration is changed |

| Contract | Signer nonce | Created address | Gas limit |
| --- | ---: | --- | ---: |
| PoolPage | 4251 | `0x8Ca9E6CfE4A4F4F10cEF1d2EfF6954e476bd890C` | 614,344 |
| PoolInventory | 4252 | `0xe64f685C24056e41C30e4cf35C8Cb28381F1EAa5` | 6,156,029 |
| PoolBalancer | 4253 | `0x45754494B606f9E3AebfB9984330eC788A87eF76` | 7,021,362 |
| BalancerFactory | 4254 | `0x96fd7B2e83E04Ea2e78be415e0BC82A1332e7671` | 1,928,999 |

The first two transactions target the existing canonical CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`, with zero salt and the reviewed library init code. The last two are contract creations. All senders, nonces, constructor encodings, linked bytecode and calldata hashes were independently checked. Full unsigned transaction inputs remain in [the reviewed canonical simulation](candidate-reviewed-dry-run.json).

**Exact reviewed dry-run SHA-256:** `b196c10b91293be329970fc6a61d6fc6203be214e6094f3e261311f46d789902`. This is an unsigned simulation artifact, not a transaction receipt or deployment record.

## Current preflight and evidence reuse

- Full dependency/legacy preflight passed at block **26499814**, hash `0x454b06a287fe38ad7c0eb5cb77c09a965042af7a53e3f9d330ed6f6bc10910de`. Three packaged legacy factories contain one known pool; their implementations, packaged ABI selectors and reused dependencies match. Current factory `0x6F018fF718Ab5A4287F937e4e4729Aa65610f53b` has zero pools over blocks 26489613–26499814.
- Latest nonce/fee check: **2026-11-26T14:01:42.974Z**, block **26499838**, hash `0xf09d170303297ca20e9de538912ae3038fff953877ccb6f5f4e36d831c644ff7`. Signer latest and pending nonce are both **4251**; no pending signer transaction was observed. Balance **0.173556986201324617 ETH**. Basefee **91949248 wei (0.091949248 gwei)**, below the proposed 0.25-gwei cap with 0.05-gwei priority.
- All four predicted creation addresses have empty code. Canonical CREATE2 deployer code matches the earlier readback; the reused KeeperPolicyCalls library runtime matches the local artifact including its actual via-IR immutable references. Signer delegation and existing factory code/admin/implementation identities are unchanged.
- Owner explicitly authorized the stored Alchemy credential for this read-only preparation after Tenderly returned 429. **87 upstream RPC reads**, maximum 120, no retries or paid regression campaign, zero broadcasts. No credential was printed or written to evidence. This read authorization does not authorize submitting signed transactions through Alchemy.
- The prior successful canonical simulation is reused because relevant source/configuration/dependencies, all five production init/runtime artifact hashes, signer nonce, canonical deployer and target state still match. `git diff 8db66c2 HEAD -- src script shared app asset-flow-focused.json` was empty. No fresh simulation, build or full test suite was run for unchanged inputs. The signed gate's no-run verification still passes with source digest `58c252dd452c6c54b2b91694ed6c25e52f65eb9face0725d6ba1b88461c0596b` and owner approval digest `5acc93973dcad11c81c9945851f85ddd62ea24a1ebea2f55264e7528331f4d3f`.
- Both final code CI runs passed **175 Solidity cases and 323 TypeScript tests (17 skipped)**. [Verified code run](https://github.com/ripe0x/shapes-pool-balancer/actions/runs/45818321967), [duplicate PR run](https://github.com/ripe0x/shapes-pool-balancer/actions/runs/45818332087).
- Bounded independent offline follow-up found no blocker to reusing the exact simulation; it independently checked addresses, calldata, constructor arguments, nonce order, gas arithmetic and fresh public records. It performed no RPC, tests, builds or edits. This is approval preparation, not a whole-system safety finding.

Before any authorized broadcast: require checkout `main == origin/main`, unchanged source/artifacts, a fresh nonce/pending/fee/code check, secure keystore signer-address confirmation, and the exact decoded owner approval including the proposed Alchemy provider. Any discrepancy stops execution. No keystore was unlocked during this preparation. The current owner authorization covers read-only Alchemy preparation; no Alchemy or Tenderly broadcast is authorized yet. Tenderly remains the repository's general default outside this specifically proposed action.

## Separate paused-factory setup before opening

**The intended launch settings remain restockGas 940000 and gasPriceCeiling 1.5 gwei.** Constructor bytecode is unchanged and initially uses 910000/5 gwei. The factory stays publicly paused while canonical mined deployment verification runs, then the existing policy admin applies the separately confirmed setup call:

- Target: predicted new factory `0x96fd7B2e83E04Ea2e78be415e0BC82A1332e7671`, only after its canonical creation and code/role/pause verification.
- Signer: `0xCB43078C32423F5348Cab5885911C3B5faE217F9`. Function: `setEconomics((uint64,uint32,uint32,uint64,uint64,uint32,uint64,uint32,uint32,uint32,uint32,uint32,uint16,uint16))`. Native value: 0 ETH.
- Tuple: `(20000000000000,3200000,60000,1500000000,50000000,940000,200000000000000,200000,1800000,150000,700000,150000,50,10)`.
- Proposed gas cap 200000 at the same 0.25-gwei max fee: **0.0000500000 ETH** maximum additional gas commitment. Deployment plus this later setup would total **0.0039801835 ETH** maximum under these caps.
- Read back the entire tuple and confirm creation remains paused. Hosted keeper service cap remains 1.5 gwei. Creators retain their existing authority to select higher local pool ceilings; that does not raise the hosted keeper's cap.

Public unpause, mainnet canary, pool funding, live app/keeper cutover and existing-pool migration are excluded. The owner's R83 no-mainnet-canary decision remains in force.

## Constructor arguments

**PoolPage constructor:**
```json
[]
```

**PoolInventory constructor:**
```json
[]
```

**PoolBalancer constructor:**
```json
[
  "0x8919814D825a5Af238cC04DE06b1C18c9eaA477C",
  "0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7",
  "0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02",
  "0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0",
  "0xfE11c0E794475fd86801fb3020d779bd7887cB2D",
  "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e"
]
```

**BalancerFactory constructor:**
```json
[
  "0x45754494B606f9E3AebfB9984330eC788A87eF76",
  "0xCB43078C32423F5348Cab5885911C3B5faE217F9",
  "0xCB43078C32423F5348Cab5885911C3B5faE217F9"
]
```

## Preserved public preflight records

The JSON snapshots below are embedded verbatim to keep this evidence-only commit within the repository's existing Markdown-only CI path. Their hashes identify the captured files; no pipeline or runtime configuration is changed. The first pass's local library-layout assertion failure is retained in the initial budget record. It was corrected with the existing `expectedRuntime` helper, without repeating the 63-read preflight.

### alchemy-preflight.json

SHA-256: `7c05900fa7a779b88a0fc003861d88f54281c3f1e70757265830e35026b47adc`

```json
{
  "schema": "community-deployment-preflight-v1",
  "chainId": 1,
  "checkedBlock": {
    "number": "26499814",
    "hash": "0x454b06a287fe38ad7c0eb5cb77c09a965042af7a53e3f9d330ed6f6bc10910de",
    "timestamp": "1795701407"
  },
  "ok": true,
  "problems": [],
  "legacyFactories": [
    {
      "label": "community-v2",
      "balancerFactory": "0x526FbD402624B50861f54c081B592cdCeE322929",
      "scannedFromBlock": "26482707",
      "scannedToBlock": "26499814",
      "poolCount": 1,
      "pools": [
        {
          "balancer": "0xB4A519F2EC35AbEF476C63E0Bb3246fB83CACC33",
          "creator": "0xCB43078C32423F5348Cab5885911C3B5faE217F9",
          "pool": "0xa942288598628714f058DCc48fc45E3b908B1cA4",
          "salt": "0xb8162f3b0af7aac2ffb935ece16be567f9eded91141b150e2a8fed9c7e742832",
          "blockNumber": "26487776",
          "transactionHash": "0xa8857d99619d98b262c7ac71ea07add81e87ac0c1c358335d7f3d8a433269355",
          "logIndex": 660
        }
      ],
      "abiName": "community-v2",
      "missingAbiSelectors": {
        "balancerFactory": [],
        "poolBalancer": []
      }
    },
    {
      "label": "community-v1",
      "balancerFactory": "0x91C31Ad620555DE24e62290906aD1aA14C4CE281",
      "scannedFromBlock": "26475448",
      "scannedToBlock": "26499814",
      "poolCount": 0,
      "pools": [],
      "abiName": "community-v1",
      "missingAbiSelectors": {
        "balancerFactory": [],
        "poolBalancer": [],
        "keeperPolicyV1": []
      }
    },
    {
      "label": "community-v0",
      "balancerFactory": "0xA57de1a6Ad66aB053057Ff7829F65eFe1cD57ece",
      "scannedFromBlock": "26453686",
      "scannedToBlock": "26499814",
      "poolCount": 0,
      "pools": [],
      "abiName": null,
      "missingAbiSelectors": null
    }
  ],
  "reusedDependencies": {
    "code": {
      "shapes": {
        "address": "0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0",
        "codeHash": "0x5128789aebafbd129f209fc3d84928373b7c9fa07d1721fbc71ee92a412387d7",
        "codeBytes": 22460,
        "recordedCodeHash": "0x5128789aebafbd129f209fc3d84928373b7c9fa07d1721fbc71ee92a412387d7"
      },
      "packs": {
        "address": "0xfE11c0E794475fd86801fb3020d779bd7887cB2D",
        "codeHash": "0xf823982603df82f696e86d255ea1699635890085f4e203e035405dad07d03a7c",
        "codeBytes": 17768,
        "recordedCodeHash": "0xf823982603df82f696e86d255ea1699635890085f4e203e035405dad07d03a7c"
      },
      "renderer": {
        "address": "0xA998bE44f1f06E119523C33Bb0d65f45728Ea65A",
        "codeHash": "0x4315f1dd1c4c69497c28249e5600d8df497786a251bcec610de64977a2b866fe",
        "codeBytes": 9354,
        "recordedCodeHash": "0x4315f1dd1c4c69497c28249e5600d8df497786a251bcec610de64977a2b866fe"
      },
      "fwaFactory": {
        "address": "0x8919814D825a5Af238cC04DE06b1C18c9eaA477C",
        "codeHash": "0xb998454c11b09cf943751b5aa593a2607febac940de51a1a65f41b924369e36e",
        "codeBytes": 18856,
        "recordedCodeHash": "0xb998454c11b09cf943751b5aa593a2607febac940de51a1a65f41b924369e36e"
      },
      "fwaImplementation": {
        "address": "0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7",
        "codeHash": "0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02",
        "codeBytes": 24280,
        "recordedCodeHash": "0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02"
      }
    },
    "readbacks": {
      "packsShapes": "0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0",
      "packsRenderer": "0xA998bE44f1f06E119523C33Bb0d65f45728Ea65A",
      "packsMinimumWei": "20000000000000000",
      "packsAdmin": "0xCB43078C32423F5348Cab5885911C3B5faE217F9",
      "packsPresentationLocked": false,
      "packsName": "Pool Prize Packs",
      "packsSymbol": "PRIZEPACK",
      "rendererShapes": "0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0",
      "fwaFactoryImplementation": "0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7",
      "fwaMaxAcquisitionsPerTx": 5,
      "shapesMintFeeWei": "500000000000000"
    },
    "matchesLocalBuild": {
      "packs": true,
      "renderer": true
    }
  }
}
```

### alchemy-readback.json

SHA-256: `4869562615b69a97936ea91e48242d3eb9aae25189eeb9ce9a4f8190c5720f83`

```json
{
  "revision": "cf4dccdb43ba362284ed68c0c908e93331bdb1aa",
  "provider": "Alchemy, explicitly owner-authorized",
  "chainId": 1,
  "checkedAt": "2026-11-26T13:58:03.850Z",
  "blockNumber": "26499814",
  "blockHash": "0x454b06a287fe38ad7c0eb5cb77c09a965042af7a53e3f9d330ed6f6bc10910de",
  "baseFeePerGas": "95322725",
  "signer": "0xCB43078C32423F5348Cab5885911C3B5faE217F9",
  "balance": "173556986201324617",
  "nonceLatest": 4251,
  "noncePending": 4251,
  "signerCode": "0xef0100612373d7003d694220f7800eeaf8e3924c0951d3",
  "factory": "0x6F018fF718Ab5A4287F937e4e4729Aa65610f53b",
  "implementation": "0xfEBaFdbFf526afb2bE2DCCedcb740962B5E91089",
  "policyAdmin": "0xCB43078C32423F5348Cab5885911C3B5faE217F9",
  "keeperAdmin": "0xCB43078C32423F5348Cab5885911C3B5faE217F9",
  "factoryCodeHash": "0xb767d7a4707a0cc77c5471f30bc943444d8b3940998fed26317f5ce78c06aa70",
  "creationPauseSupported": false,
  "reusedKeeperLibrary": {
    "address": "0x5c6322442650A1177b4aFbF5f95166A59Ef7e7f7",
    "codeHash": "0xbd9ba77a1d0e7a317a91372a4ee493f60d02a11d4927a6d7c4d13a48c78224f6",
    "matchesLocalBuild": true
  },
  "reviewedDryRunSha256": "b196c10b91293be329970fc6a61d6fc6203be214e6094f3e261311f46d789902",
  "matchesPrevious": {
    "nonce": true,
    "signerCode": true,
    "factoryCodeHash": true,
    "implementation": true,
    "policyAdmin": true,
    "keeperAdmin": true
  },
  "broadcasts": 0,
  "pools": {
    "pools": [],
    "bad": []
  },
  "targets": [
    {
      "label": "PoolPage",
      "address": "0x8Ca9E6CfE4A4F4F10cEF1d2EfF6954e476bd890C",
      "codeBytes": 0
    },
    {
      "label": "PoolInventory",
      "address": "0xe64f685C24056e41C30e4cf35C8Cb28381F1EAa5",
      "codeBytes": 0
    },
    {
      "label": "PoolBalancer",
      "address": "0x45754494B606f9E3AebfB9984330eC788A87eF76",
      "codeBytes": 0
    },
    {
      "label": "BalancerFactory",
      "address": "0x96fd7B2e83E04Ea2e78be415e0BC82A1332e7671",
      "codeBytes": 0
    }
  ],
  "canonicalCreate2Deployer": {
    "address": "0x4e59b44847b379578588920cA78FbF26c0B4956C",
    "codeHash": "0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989",
    "unchangedFromBlock": "26497137"
  },
  "currentFactoryScan": {
    "factory": "0x6F018fF718Ab5A4287F937e4e4729Aa65610f53b",
    "event": "BalancerCreated(address indexed creator,address indexed balancer,address indexed pool,bytes32 salt)",
    "fromBlock": "26489613",
    "toBlock": "26499814",
    "chunkBlocks": 5000,
    "poolCount": 0,
    "problems": []
  },
  "finalNonceFeeCheck": {
    "checkedAt": "2026-11-26T14:01:42.974Z",
    "blockNumber": "26499838",
    "blockHash": "0xf09d170303297ca20e9de538912ae3038fff953877ccb6f5f4e36d831c644ff7",
    "baseFeePerGas": "91949248",
    "nonceLatest": 4251,
    "noncePending": 4251,
    "balanceWei": "173556986201324617",
    "maxFeePerGasWei": "250000000",
    "priorityFeePerGasWei": "50000000"
  }
}
```

### alchemy-read-budget-initial.json

SHA-256: `6fae6d0eb000f61418f18f439ff2cdbf4c35131b28fc94c8106c76fc620e5c7a`

```json
{
  "provider": "Alchemy, explicitly owner-authorized",
  "maxUpstreamReads": 120,
  "upstreamReads": 63,
  "cacheHits": 1,
  "methods": {
    "eth_chainId": 1,
    "eth_getBlockByNumber": 2,
    "eth_getCode": 17,
    "eth_call": 18,
    "eth_getLogs": 22,
    "eth_getTransactionCount": 2,
    "eth_getBalance": 1
  },
  "broadcasts": 0,
  "startedAt": "2026-11-26T13:56:51.558Z",
  "finishedAt": "2026-11-26T13:57:00.900Z",
  "result": "Preflight passed; readback interrupted by incorrect assumption about via-IR library immutable layout. Repaired using existing expectedRuntime helper; completed preflight not repeated."
}
```

### alchemy-read-budget.json

SHA-256: `d9dcdeafc181252054d144007991d1b1ca7959e9157c73493a00840b016d5038`

```json
{
  "provider": "Alchemy, explicitly owner-authorized",
  "maxUpstreamReads": 120,
  "upstreamReads": 87,
  "cacheHits": 1,
  "methods": {
    "eth_chainId": 2,
    "eth_getBlockByNumber": 4,
    "eth_getCode": 26,
    "eth_call": 21,
    "eth_getLogs": 25,
    "eth_getTransactionCount": 6,
    "eth_getBalance": 3
  },
  "broadcasts": 0,
  "startedAt": "2026-11-26T13:56:51.558Z",
  "finishedAt": "2026-11-26T14:01:42.976Z",
  "resumedAt": "2026-11-26T13:58:03.344Z",
  "verificationRepair": "Use actual artifact immutable references via expectedRuntime; no repeated full preflight."
}
```

Things that don't make sense: none newly identified. Gas calibration covered the exercised paths, not every possible workload. The separate full economic campaign, authentic live oracle/service operation and production inclusion are not established by this packet.
