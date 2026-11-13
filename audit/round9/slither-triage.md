# Round 9 Slither triage (controller, informed)

Command (repo root, after a normal build into a separate output so the main cache is untouched; the main `out/`
holds skeleton build-info files that crytic-compile cannot parse):

```
FOUNDRY_OUT=audit/round9/slither-out FOUNDRY_CACHE_PATH=audit/round9/slither-cache forge build src/PoolBalancer.sol --build-info
slither src/PoolBalancer.sol --ignore-compile --foundry-out-directory audit/round9/slither-out --json audit/round9/slither-pool.json
```

Build exit 0. Slither exit 255 (it exits non-zero when detectors fire); JSON `success: true`, 236 detections, 40
High/Medium: 16 in `src/PoolBalancer.sol`, 24 in Solady. Raw: `slither-pool.json`, `slither-pool.log`,
`slither-run.out`. A first attempt against the main `out/` failed (`KeyError: 'output'`); its log was overwritten by the second run and
the failure is recorded in `run-record.md`. No cache was cleared.

| Detector | Site | Disposition | Basis |
| --- | --- | --- | --- |
| reentrancy-eth | `_fillDeficit`, `performUpkeep` (589-738) | Bounded: no exploit path found by reading | Whole call is `nonReentrant`. External calls go to Shapes, Draw Packs and the FWA pool (trusted per scope), and the reward transfer to `msg.sender` is the last state change except the profit clamp. Unguarded creator-only functions (`configure`, `open`, `close`, `transferCreator`, `retire`, `setENSName`, page approvals) are reachable only if the creator is the keeper contract receiving the reward; each leaves the clamp correct (`close` zeroes profit; `configure` only recomputes target and creator work). Reward-callback reentrancy was not executed: **untested**. |
| reentrancy-no-eth | `claimSurplus` (481-489) | Bounded | `_collect` calls FWA `withdrawOwnerProceeds` (trusted); profit is updated before the ETH transfer to `to`; `nonReentrant`. |
| reentrancy-no-eth | `updateCuratedPrice` (410-420) | Bounded | Calls trusted FWA `updatePrice`; curated items carry no profit share. |
| divide-before-multiply | `configure` (323-342) | Intended | `n * (1e36 / price)` mirrors FWA's per-listing inverse weight; dividing first matches FWA's rounding per listing. |
| incorrect-equality (3) | `performUpkeep`, `_fillDeficit`, `_payKeeper` | False positive | Strict `== 0` checks on counts and amounts, not balances an attacker can nudge to block a branch. |
| uninitialized-local (5) | `requiredReserve`, `configure`, `performUpkeep` | False positive | Zero-initialized accumulators. |
| unused-return (4) | `recoverRefunded`, `_withdrawAndRedeem`, `performUpkeep`, `setENSName` | Intended | Partial tuple destructuring of FWA getters; ENS reverse `setName` returns a node that is not needed. |
| incorrect-shift, incorrect-exp, write-after-write, divide-before-multiply (24) | Solady `LibString`, `LibBytes`, `SignatureCheckerLib`, `SafeTransferLib` | Library assembly idioms, not reviewed line by line | Known Slither false-positive patterns in Solady's audited assembly; not re-audited this round. |

These are reading-based dispositions; they are not executed evidence except where noted.
