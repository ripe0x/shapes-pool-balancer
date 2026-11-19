# Mainnet release record: `e7e3558` contracts

**Status: ready for the owner's signature and the final gate run.** Production execution requires an observed
`ASSET FLOW GATE: PASS` and the owner's approval of one concrete [canary execution plan](CANARY-PLAN.md). Nothing has
been broadcast. Corrected 2026-11-19 after a detailed release review; the previous text is in git history.

| Item | Value |
| --- | --- |
| Contracts and deployment scripts | `e7e3558f4d0de3e30d24f92f3b0e2dbdde664028`; unchanged since PR #15 (`ef32a48`) |
| Gate source hash | `341db26a17447a8e789a33726da6cbb4bc18d25df8615a67869492df1e984deb` (contracts, scripts and evidence; unchanged by later docs, `scripts/` helpers and `keeper/keeper.ts`) |
| Outcome payload hash to sign | **`231b42ba36053a85a31131fcdfa0d77f5bf2e8e60d9a24fdb0484e0ffb6eaa74`** (recomputed from `main` after PR #16 with the verifier's own `outcomes_hash`) |
| Review record | [audit/rc-e7e3558/REPORT.md](../audit/rc-e7e3558/REPORT.md) with `SOURCE_HASH`; authoritative over the lane reports |
| Verifier | `~/.agents/guidance/asset-flow-kit/asset_gate.py`, sha256 `c9c202056960ea00e1f7f1a7e2626c831b74d3526f7722977a322daccb4607c0` |
| Repository commit | the commit that adds this record (reported in its PR); history: PR #16 merge `5f3b75d` |

Earlier signatures (`f085518e`, 2026-11-13) and seals belong to superseded revisions and are not reused.

## Gate result

`asset_gate.py . --require-review` regenerated all 25 regimes on the real-dependency fork (block 26,382,349, gas price
and basefee asserted inside transactions). Every outcome was within bounds, with zero drift failures and zero
counter/holding mismatches. It now reports the review as recorded; the only INCOMPLETE item is the missing signature.
The full Foundry campaign on `e7e3558` was 518/519, and its one stale test was fixed (`b294de0`). TypeScript: 205
passed. Main CI passed.

## 1. Owner approval

**What the signature covers.** `outcomes_sha256` is the SHA-256 of the canonical JSON of every approved key, with the
`approval` field excluded: `outcomes` (each with its complete text), `explained`, `required_regimes` (25), `source_paths`,
`evidence_paths`, `drift_threshold_bps` (500 across `quiet`/`limits_at_max`/`max_then_idle`), `drift_groups`,
`test_command` (Foundry 1.8.1, block 26,382,349), `scorecard_dir` and `review_dir`. You approve the complete outcome text
and the gate configuration. **The automated gate checks each outcome's configured metric in its named regimes.** Other
behaviour stated in the text is supported by focused tests and code review, not by the gate.

**Benchmark assumptions.** All 25 regimes store creator revenue at **400 bps (4%)** and configure **25% Shape markup**.
Each regime uses its specified board, deposit and demand. The default is ape-Ball's 47-prize board (1.7 ETH of backing),
a 5 ETH deposit and 180 draws over 30 days, at basefee 0.5 gwei with a 0.05 gwei tip. A 0.2 ETH curated NFT is relisted
by the creator when won, where the scenario provides it, and the creator claims everything claimable daily. These are
benchmark settings. The canary's own creator percentage and markup are the owner's choices, recorded in the canary plan.

| Outcome | Promise (gated metric) | Bound | Worst measured |
| --- | --- | ---: | ---: |
| O1 | Keeper compensation above billed gas and stated allowances | ≤ 80,000 gas/draw | 60,371 (burst) |
| O2 | Restocking surcharge still listed, launch board | ≤ 0.26 ETH | 0.2585 ETH (no_processor_5_gwei) |
| O3 | Unclaimable after close beyond held keeper pay | 0 | 0 |
| O4 | Unlisted Shape and Pack prizes redeem for exactly their backing. Curated NFTs have no ETH redemption | 0 gap | 0 |
| O5 | Add ETH / continue without top prize ends with admission open | status 0 | 0 |
| O6 | Closeout leaves nothing in Balancer, backing or FWA proceeds (failed-delivery NFTs excepted) | 0 | 0 |
| O7 | No low-inventory refusals in ordinary regimes within the 5 gwei cap | 0 | 0 |
| O8 | Each collection adds its own rounded share, floor(collected × stored bps / 10,000), once. Outstanding credit also reflects earlier claims | 0 wei error, all 25 | 0 |
| O10 | Player all-in price vs expected Shape backing at 0.1 gwei | ≤ 1.5x | 1.4717x |
| O11 | Surcharge covers play keeper pay, 14 named regimes | 0 shortfall | 0 |
| O12 | Total creator value after 180 draws at 0.1/0.5/2/5 gwei: claimed cash + Balancer ETH + listed backing + uncollected proceeds, minus deposits and won curated NFTs at their stated 0.2 ETH. Not all immediately withdrawable cash | 0 loss | 0 (net gains 0.52–1.19 ETH on 5 ETH) |
| O13 | No draw unsettled at day end with an available keeper | 0 | 0 |
| O14 | Policy replacement reprices no existing listing | 0 | 0 |
| O15 | Twenty-Shape opening deposit at 0.5 gwei / 0.001 ETH mint fee | exactly 0.2356 ETH | 0.2356 ETH |
| O16 | Zero additional creator ETH after opening in the minimum regimes. Curated NFT relistings are separate contributions and are not covered | 0 | 0 |

**Keeper payment limits.** V1 pays at most `(3,200,000 + 50,000) gas × 5 gwei + 10 × 0.00002 ETH = 0.01645 ETH` per
call (`KeeperPolicyV1.maxReward`). The immutable 0.311 ETH per call (`KeeperPolicyCalls.HARD_MAX_REWARD`) and the
0.622 ETH burst plus 0.05 ETH per 12 s per-pool allowance bound any permitted replacement policy a creator adopts.
Above V1's 5 gwei reimbursement ceiling, paid restocking may wait; unpaid maintenance (`performUpkeepUnpaid`) remains
available to anyone.

### Losses and exposure that remain possible

| Exposure | Measured or bounding amount |
| --- | --- |
| No demand after opening (setup mint and keeper costs) | −0.0716 ETH on 5 ETH (zero_demand) |
| Large win, creator declines to restock top prize | −0.2022 ETH (whatif_large_win_drop_top) |
| Keeper play pay above surcharge, boards outside O11 | 0.0234 ETH (extreme_top_heavy), 0.0164 ETH (largest_board); 0.0184 ETH on an adverse 60/60/60 gas path |
| Purchases refused while inventory is low after a gas spike | 35 of 180 (gas_spike) |
| Days ending with a target prize missing | up to 22 of 30 (minimum_large_win), 20 (large_win) |
| Creator percentage | a higher chosen percentage leaves less of each collection for operations; claiming credit already protected does not reduce operating cash |
| Hostile curated NFT clawback after delivery (accepted R20) | player loses that prize; reachable by any public creator |
| ETH contributions | irrevocable pool capital (R73); no protocol refund to the sender |
| System-wide size | no global pool or asset cap; canary limits are the owner's pilot only |

### Conditional outcomes

| Depends on | Outcomes | Condition |
| --- | --- | --- |
| Demand | O11, O12 | 180-draw benchmarks, not forecasts; zero or low demand loses setup cost |
| Gas | O1, O2, O7, O10, O15 | V1 reimburses at most 5 gwei; above it paid restocking may wait. O15's 0.2356 ETH holds only at 0.5 gwei and a 0.001 ETH mint fee |
| Keepers | O13, O7 | A paid keeper permitted by the factory list, or anyone calling `performUpkeepUnpaid()` |
| FWA and its VRF service | O4, O6, O13 | Observed at block 26,451,186: FWA implementation `0x85Fa…BfEe7` with codehash `0x0af01fc1…ce02`, batch 5, edge 500 bps, 6 activations, Shapes mint fee 0.001 ETH; VRF subscription 3.0306 ETH, service 0.1868 ETH, 0.35 ETH buffer and 0.45 ETH per outstanding request (about 6 outstanding across all 13 FWA pools), 0 outstanding. Re-read these during execution: `Deploy.s.sol` checks the FWA values at deploy time, and the creation funding check prices current gas |

### Signing (one action)

From the repository root of the merged commit:

```bash
H=231b42ba36053a85a31131fcdfa0d77f5bf2e8e60d9a24fdb0484e0ffb6eaa74; printf %s "$H" > /tmp/af.txt && rm -f /tmp/af.txt.sig && ssh-keygen -Y sign -f ~/.ssh/asset_flow_owner -n asset-flow /tmp/af.txt && python3 -c "import json;p='asset-flow.json';c=json.load(open(p));c['approval']={'outcomes_sha256':'$H','date':'2026-11-19','signature':open('/tmp/af.txt.sig').read()};open(p,'w').write(json.dumps(c,indent=2)+'\n')" && python3 ~/.agents/guidance/asset-flow-kit/asset_gate.py . --require-review
```

`~/.ssh/asset_flow_owner.pub` matches the `owner` entry in `allowed_signers`. The final command reruns all 25 regimes;
proceed only if it prints `ASSET FLOW GATE: PASS`. Then commit `asset-flow.json`. Any change to an approved key voids
the hash.

## 2. Deployment and canary

The single production route is `script/deploy.sh`, which reruns the gate. [CANARY-PLAN.md](CANARY-PLAN.md) is the
complete execution plan: inputs, limits, cumulative gas enforcement (`scripts/canary-guard.ts`), the dry run,
broadcast, mined-deployment verification (`scripts/verify-deployment.ts`), keeper and frontend start-up from the
verified factory receipt block, and closeout.

Corrections to the earlier procedure:

1. `Deploy.s.sol` asserts wiring and writes `deployments/1.json` while forge simulates the script. That file appears
   after a dry run too, and its `block` is the simulation block. It is not proof of a mined deployment.
   `scripts/verify-deployment.ts` reads the canonical receipts and writes `deployments/1.verified.json` only when every
   check passes.
2. A 3 gwei max fee over 21,223,646 gas commits up to 0.063670938 ETH, which alone exceeds the 0.05 ETH canary gas
   limit. The plan uses 1.5 gwei (0.031835 ETH maximum) and checks every send against cumulative gross spend.
3. The perpetual keeper does not cap aggregate spend by itself. With `CANARY_PLAN` set, each send and each fee
   replacement is checked against the same budget.

Simulated deployment (no broadcast; local fork): 8 transactions with a total gas limit of 21,223,646, the largest
5,912,115. Three libraries go through the CREATE2 deployer at `0x1601A841…B8fb`, `0x67C828Ad…fBcf` and
`0x9154504f…FcFF9E` (deterministic for this build; empty on mainnet at review time). Five contracts are created at the
deployer's nonces N+3 through N+7. Expected use is about 16.0M gas (75.4% of the limit, measured on an earlier local
deployment). If Etherscan rejects ShapePacks, verify it alone with
`forge verify-contract <packs> lib/shape-packs/src/ShapePacks.sol:ShapePacks --chain 1 --guess-constructor-args --rpc-url https://mainnet.gateway.tenderly.co --watch`.
With Foundry 1.8.1 this selects the 20-optimizer-run profile through the repository's compilation restrictions.

## Remaining owner inputs

1. Signature over `231b42ba…`, then an observed gate `PASS`.
2. The six canary account addresses, the curated NFT (collection, token id, listing price), `markupBps` and
   `creatorRevenueBps`, filled into `deployments/canary-plan.json`.
3. Approval of the finalized plan file's SHA-256 (after the gate, the dry run and start nonces are recorded), which
   authorizes every action in it. The guard and keeper refuse any other file.

Known open gaps, not blockers for the capped canary: real-wallet extension writes, FWA pool-page ERC-1271 acceptance,
live oracle and keeper inclusion timing, human review.

## Things that don't make sense

1. A stale failing test reached `main` because CI runs only two test targets and the earlier broad local runs were
   killed (exit 137). Fixed; CI scope unchanged.
2. Review lanes overstated their elapsed time about sevenfold; actual times are in the review record.
3. The PR #15 rehearsal evidence is cited but was never committed; it is reported, not re-verified.
