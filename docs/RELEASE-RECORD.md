# Mainnet release record: `e7e3558` contracts, 2026-11-19

**Status: BLOCKED only on owner actions.** Code, evidence, review record and deployment procedure are prepared. The
production gate returns PASS once the owner's signature is added (step 1 below). Deployment then still needs the owner to
choose four addresses and authorize the broadcast. Nothing has been broadcast.

| Item | Value |
| --- | --- |
| Contracts and deployment scripts | `e7e3558f4d0de3e30d24f92f3b0e2dbdde664028`, unchanged since PR #15 (`ef32a48`) |
| Release tree | this branch: `e7e3558` + test-only fix `b294de0` + this record |
| Gate source hash | `341db26a17447a8e789a33726da6cbb4bc18d25df8615a67869492df1e984deb` |
| Outcome payload hash to sign | **`231b42ba36053a85a31131fcdfa0d77f5bf2e8e60d9a24fdb0484e0ffb6eaa74`** |
| Review record | [audit/rc-e7e3558/REPORT.md](../audit/rc-e7e3558/REPORT.md) with `SOURCE_HASH` |
| Verifier | `~/.agents/guidance/asset-flow-kit/asset_gate.py`, sha256 `c9c20205…4607c0` (the recorded nullable-patched version) |

Earlier signatures (`f085518e`, 2026-11-13) and seals belong to superseded revisions and are not reused.

## Gate result

`python3 ~/.agents/guidance/asset-flow-kit/asset_gate.py . --require-review` on `b294de0`: 25/25 regimes regenerated
on the real-dependency fork (block 26,382,349, gas set inside transactions), all outcomes within bounds, zero drift
failures, zero counter/holding mismatches. Exit 2, INCOMPLETE, for: unsigned approval; no review record (now added).
Full campaign: 518/519 Foundry tests passed on `e7e3558`; the one failure was a stale test, fixed and passing (details in
the review record). TypeScript 205 passed, typecheck passed. Main CI passed on `e7e3558`.

## 1. Owner approval: what you sign

You approve 15 outcomes (O1–O8, O10–O16; O9 was removed with historical markup attribution) and the gate settings that
check them: 25 regimes, the pinned test command (Foundry 1.8.1, block 26,382,349), source/evidence paths, the 5% drift
limit across `quiet`/`limits_at_max`/`max_then_idle`, and the review folder. **Your signature binds each outcome's checked
number in its named regimes.** Prose beyond that number (for example O1's 0.311 ETH and 0.622 ETH caps, O8's
"claims remain available during depletion") is code behavior reviewed by the lanes, not separately gated.

| Outcome | Promise (checked number) | Bound | Worst measured |
| --- | --- | ---: | ---: |
| O1 | Keeper compensation above billed gas and stated allowances | ≤ 80,000 gas/draw | 60,371 (burst) |
| O2 | Restocking surcharge still listed, launch board | ≤ 0.26 ETH | 0.2585 ETH (no_processor_5_gwei) |
| O3 | Unclaimable after close beyond held keeper pay | 0 | 0 |
| O4 | Unlisted prize redeems for its exact backing | 0 gap | 0 |
| O5 | Add ETH / continue without top prize ends with admission open | status 0 | 0 |
| O6 | Closeout leaves nothing in Balancer, backing or FWA proceeds (failed-delivery NFTs excepted) | 0 | 0 |
| O7 | No low-inventory refusals in ordinary regimes within the 5 gwei cap | 0 | 0 |
| O8 | Creator credit = floor(collected × stored bps / 10,000), once; error | 0 wei, all 25 | 0 |
| O10 | Player all-in price vs expected Shape backing at 0.1 gwei | ≤ 1.5x | 1.4717x |
| O11 | Surcharge covers play keeper pay, 14 named regimes | 0 shortfall | 0 |
| O12 | Creator ends ahead after 180 draws at 0.1/0.5/2/5 gwei | 0 loss | 0 (gains 0.52–1.19 ETH on 5 ETH) |
| O13 | No draw unsettled at day end with an available keeper | 0 | 0 |
| O14 | Policy replacement reprices no existing listing | 0 | 0 |
| O15 | Twenty-Shape opening deposit at 0.5 gwei / 0.001 ETH mint fee | exactly 0.2356 ETH | 0.2356 ETH |
| O16 | Creator ETH top-ups after opening, minimum regimes | 0 | 0 |

### Losses and exposure that remain possible

| Exposure | Measured or bounding amount |
| --- | --- |
| No demand after opening (setup mint and keeper costs) | −0.0716 ETH on 5 ETH (zero_demand) |
| Large win, creator declines to restock top prize | −0.2022 ETH (whatif_large_win_drop_top) |
| Keeper play pay above surcharge, boards outside O11 | 0.0234 ETH (extreme_top_heavy), 0.0164 ETH (largest_board); 0.0184 ETH on an adverse 60/60/60 gas path |
| Purchases refused while inventory is low after a gas spike | 35 of 180 (gas_spike) |
| Days ending with a target prize missing | up to 22 of 30 (minimum_large_win), 20 (large_win) |
| Keeper payment ceilings per pool | 0.311 ETH per call; 0.622 ETH burst + 0.05 ETH per 12 s refill (arithmetic ceiling ~360.6 ETH/day before work, envelope and liquidity limits) |
| Hostile curated NFT clawback after delivery (accepted R20) | player loses that prize; reachable by any public creator |
| ETH contributions | irrevocable pool capital (R73); no protocol refund to the sender |
| System-wide size | no global pool or asset cap; anyone may create pools on the deployed factory |

### Conditional outcomes

| Depends on | Outcomes | Condition |
| --- | --- | --- |
| Demand | O11, O12 | 180-draw benchmarks, not forecasts; zero or low demand loses setup cost |
| Gas | O1, O2, O7, O10, O15 | V1 reimburses at most 5 gwei; above it restocking waits and purchases can pause. O15's 0.2356 ETH holds only at 0.5 gwei / 0.001 ETH mint fee |
| Keepers | O13, O7 | A paid keeper on the open list, or anyone calling `performUpkeepUnpaid()` |
| FWA and its VRF service | O4, O6, O13 | FWA 5% edge and refund rules; FWA factory owner `0x0198…E8Cb` controls factory settings. Live VRF coverage: subscription 3.03 ETH, buffer 0.35 ETH, 0.45 ETH per outstanding request, about 6 outstanding requests across all 13 FWA pools before new purchases revert until callbacks arrive |

### Signing (one action)

Run from the repository root of the final merged commit:

```bash
H=231b42ba36053a85a31131fcdfa0d77f5bf2e8e60d9a24fdb0484e0ffb6eaa74; printf %s "$H" > /tmp/af.txt && rm -f /tmp/af.txt.sig && ssh-keygen -Y sign -f ~/.ssh/asset_flow_owner -n asset-flow /tmp/af.txt && python3 -c "import json;p='asset-flow.json';c=json.load(open(p));c['approval']={'outcomes_sha256':'$H','date':'2026-11-19','signature':open('/tmp/af.txt.sig').read()};open(p,'w').write(json.dumps(c,indent=2)+'\n')" && python3 ~/.agents/guidance/asset-flow-kit/asset_gate.py . --require-review
```

`~/.ssh/asset_flow_owner.pub` matches the `owner` entry in `~/.agents/guidance/asset-flow-kit/allowed_signers`. The last
command reruns the 25 regimes (about one minute) and must print `ASSET FLOW GATE: PASS`. Then commit `asset-flow.json`.
Changing any outcome or gate setting voids the hash.

## 2. Deployment

### Decisions left to the owner

| Value | Role | Status |
| --- | --- | --- |
| `DEPLOYER` | Ledger or keystore account that pays deployment gas | **owner to choose** |
| `PACKS_ADMIN` | Draw Packs renderer/description admin | **owner to choose** |
| `KEEPER_ADMIN` | Keeper eligibility list and restriction switch | **owner to choose** |
| `POLICY_ADMIN` | Delayed default policy for future pools; keep separate from `KEEPER_ADMIN` | **owner to choose** |

No intended live addresses are recorded in this repository, so none are filled in.

### Verified against mainnet (block ~26,450,425)

FWA factory `0x8919…477C` serves implementation `0x85Fa…BfEe7`, codehash `0x0af01fc1…ce02` and batch limit 5, as
`Deploy.s.sol` requires. Edge 500 bps, 6 activations per acquisition and Shapes mint fee 0.001 ETH equal the pinned
evidence block. Shapes, ENS and the CREATE2 deployer `0x4e59…956C` have code. The three library addresses below are empty.

### Transactions (simulated, no broadcast)

| # | Contract | Address | Gas limit |
| ---: | --- | --- | ---: |
| 1 | KeeperPolicyCalls library (CREATE2) | `0x1601A841C2C86f6AC574279b87F1168ff284B8fb` | 1,608,471 |
| 2 | PoolPage library (CREATE2) | `0x67C828Ad820490C02CDCBbCCc3A303c64207fBcf` | 431,388 |
| 3 | PoolInventory library (CREATE2) | `0x9154504fB111544725bBb593b813fa106FdcFF9E` | 3,536,364 |
| 4 | ShapePackRenderer | `cast compute-address $DEPLOYER --nonce $((N+3))` | 2,703,828 |
| 5 | ShapePacks | nonce N+4 | 5,562,551 |
| 6 | PoolBalancer implementation | nonce N+5 | 5,912,115 |
| 7 | KeeperPolicyV1 | nonce N+6 | 301,901 |
| 8 | BalancerFactory | nonce N+7 | 1,167,028 |

N is the deployer's nonce before step 1 (`cast nonce $DEPLOYER --rpc-url https://mainnet.gateway.tenderly.co`). The
library addresses are deterministic for this exact build. Every transaction is under the 16,777,216 cap and sends 0 ETH.

**Cost.** 21,223,646 total gas limit; expected use about 16.0M (75.4% of limit, measured on the earlier local
deployment). At an effective 0.55 gwei that is about **0.009 ETH**; 1 gwei 0.016 ETH; 2 gwei 0.032 ETH. Fund the
deployer with at least gas limit × max fee: **0.07 ETH covers a 3 gwei max fee**.

### Commands

All commands use the canonical wrapper, which reruns the production gate and refuses on anything but PASS.

```bash
export PACKS_ADMIN=<owner-chosen> KEEPER_ADMIN=<owner-chosen> POLICY_ADMIN=<owner-chosen> DEPLOYER=<owner-chosen>
```

Dry run, no signer, no broadcast:

```bash
script/deploy.sh --rpc-url https://mainnet.gateway.tenderly.co --sender "$DEPLOYER"
```

Broadcast and verify (Ledger; for a keystore use `--account <name>` instead of `--ledger`). **Requires the owner's final
authorization.**

```bash
script/deploy.sh --rpc-url https://mainnet.gateway.tenderly.co --ledger --sender "$DEPLOYER" --broadcast --verify --slow --with-gas-price 3000000000 --priority-gas-price 50000000
```

`--verify` uses `ETHERSCAN_API_KEY` from the environment. The script's postflight checks wiring and roles, then writes
`deployments/1.json`. If Etherscan rejects ShapePacks (built with the `packs` compiler profile), verify it alone with
`forge verify-contract <packs> lib/shape-packs/src/ShapePacks.sol:ShapePacks --chain 1 --guess-constructor-args --rpc-url https://mainnet.gateway.tenderly.co --watch`.
The dry run and broadcast both stop at the gate until the signature from step 1 is committed.

### After deployment

1. Frontend: in `app/.env.production.local` (git-ignored) set `VITE_CHAIN_ID=1`,
   `VITE_RPC_URL=https://mainnet.gateway.tenderly.co`, `VITE_FACTORY=<balancerFactory from deployments/1.json>`,
   `VITE_FROM_BLOCK=<deployment block>`, then `npm run build:app`. Hosting is the owner's choice.
2. Canary keeper list ([CANARY-PLAN.md](CANARY-PLAN.md)): `KEEPER_ADMIN` calls
   `cast send <factory> "setKeeperApproved(address,bool)" <keeper> true --ledger --rpc-url https://mainnet.gateway.tenderly.co`,
   then `cast send <factory> "setKeepersRestricted(bool)" true` with the same flags.
3. Keeper: `FACTORY=<factory> FROM_BLOCK=<deployment block> RPC_URL=https://mainnet.gateway.tenderly.co STATE_FILE=keeper/state.json npm run keeper`,
   with `KEEPER_PRIVATE_KEY` supplied by your secret store, never typed or committed. Fund the keeper only for gas.
   Health monitoring must read the `errors` field of `/health`, not only `ok` (review finding L-1).
4. Canary limits from CANARY-PLAN.md apply unchanged: one owner pool, at most 0.25 ETH deposited (O15 measures 0.2356 ETH
   at 0.5 gwei), at most 0.05 ETH total gas, one monitored keeper. Each is a separate owner authorization.

## Remaining blockers

1. Owner signature over `231b42ba…` (step 1).
2. Owner choice of `DEPLOYER`, `PACKS_ADMIN`, `KEEPER_ADMIN`, `POLICY_ADMIN`.
3. Owner authorization of the broadcast and of each canary funding step.

Known open gaps, not blockers for a capped canary: real-wallet extension writes, FWA pool-page ERC-1271 acceptance, live
oracle and keeper inclusion timing, human review.

## Things that don't make sense

1. A stale failing test reached `main` because CI runs only two test targets and the last broad local runs were killed
   (exit 137). Fixed here; CI scope unchanged.
2. Review lanes overstated their elapsed time about sevenfold; actual times are in the review record.
3. The PR #15 rehearsal evidence is cited in the PR body but not committed and not located on this machine.
