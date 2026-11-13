# Round 9 structural gate record

Active window (UTC): start 2026-11-13T12:13:41Z, end 2026-11-13T12:24Z (~70 min, under the 90-min ceiling).
Target: `src/PoolBalancer.sol` (`PoolBalancer`) at `fork-tests` commit
`c686534669562e78fd33f7297c13f12e68fe3066`; production source identical to `7b32497`. Frozen; no production code or
existing test was modified. All new files live under `audit/round9/gate/` only.

## 1. Source inventory

Command (repo root, exit 0, first attempt — no remapping retries needed; `--remapping` entries taken from
`foundry.toml`):

```
python3 /Users/dd/.agents/skills/adversarial-audit/scripts/source_inventory.py src/PoolBalancer.sol PoolBalancer \
  --root . \
  --remapping "forge-std/=lib/forge-std/src/" --remapping "solady/=lib/solady/src/" \
  --remapping "packs/=lib/shape-packs/src/" --remapping "shapes/=lib/shape-packs/lib/shapes/src/" \
  --remapping "@openzeppelin/contracts/=lib/shape-packs/lib/shapes/lib/openzeppelin-contracts/contracts/" \
  --output audit/round9/gate/source-inventory.json
```

Counts: **57 entrypoints, 67 external calls, 143 paths; 8 compiler source hashes** (PoolBalancer + 7 Solady/PoolPage
units).

- Entrypoints include **18 compiler-generated public getters** (immutables and public state: `pool`, `creator`,
  `profit`, `keeperCredit`, `pageEpoch`, etc.). These are pure reads mapped to the accessors path (P1); they are a
  blind spot only in that the gate cannot tell a getter returns storage faithfully — treated as read-only.
- External calls include **internal-function call sites** (`_collect`, `_fillDeficit`, `_payKeeper`, `_pullCurated`,
  `_redeem`, `_withdrawAndRedeem`, `PoolPage.digest`) and the constructor; all 67 are mapped.
- Dynamic-dispatch blind spots: every FWA/Shapes/Packs call carries `target_origin:
  unknown_until_data_dependency_review` and `conservative_all_assets_exposed: true` in the inventory. Dispositions treat
  FWA pool/factory, Shapes, Draw Packs, VRF and ENS as **trusted externals per the round-9 scope**; curated ERC721
  collections are creator-chosen and modelled as attacker-shaped (hostile/reverting collections exercised).

## 2. Manifest (`audit-gate.json`, schema 2)

Every entrypoint ID (57/57), every external-call ID (67/67) and every High/Medium Slither detector ID (40/40 — 16 in
`src/PoolBalancer.sol`, 24 in Solady) are mapped. Six critical paths; 19 evidence objects, each a passing (exit 0) lane
test log copied byte-for-byte into `evidence/` for hashing.

| Path | Outcome | Basis |
|---|---|---|
| P1_accessors | **held** | Getters/views are pure reads; invariants read at rest hold (lane A stateful/security/econprops). |
| P2_authorization_admin | **held** | Creator/keeper gates, two-step transfers, pool-page epoch + ERC-1271, clone/init lock (lane A security, 12 passed). |
| P3_split_m9_violation | **violation** | M9: withdrawing curated NFTs before `_collect` over-books profit (×n/(n−k)) while the fund is short. Worst case extracts **0.01738 ETH** net of fund money (lane A `m9extent` 6 passed, `m9scale-worst` 1 passed). |
| P4_keeper_restock_delivery | **held** | Keeper pay ≤ credited fees at 1/3/4.9 gwei; 5-draw burst 2.53M gas < 4M floor; real VRF delivery nets to 0; reentrancy blocked (lane B gas/scale, integration draw/worstgas, lane A keeper-reentrancy). |
| P5_reserve_protection | **held** | `open()` requires the reserve; below reserve `withdrawableSurplus`=0, markup-change attack moved 0 wei (lane B below-reserve, lane A security). |
| P8_refund_open_questions | **unresolved** | recoverRefunded returns the NFT to the creator with no double-credit (verified), but the **purchaser refund ETH amount is FWA-internal (measured 0 here)** and the automatic no-creator-action curated-draw-books-NFT-money PoC was not built. Honestly nonpassing. |

**M9 is encoded as a `violation`, not `held`.** No path with an untested postcondition is encoded as `held`: the
genuinely open items sit in P8 (`unresolved`).

## 3. Gate result

Command (run from `audit/round9/gate/`), stdout+stderr in `gate.output`, exit code in `gate.status`:

```
python3 /Users/dd/.agents/skills/adversarial-audit/scripts/audit_gate.py audit-gate.json \
  --inventory source-inventory.json --slither-json ../slither-pool.json
```

**Exit code 1 (FAIL).** Three failure lines, all honest and expected:

1. `path P8_refund_open_questions: unresolved outcome` — the retained open path (schema convention: `unresolved` is
   intentionally nonpassing; not pruned to obtain PASS).
2. `independent review: missing or outside manifest directory` — the manifest references
   `../challenge/evidence-challenge.md`, **which does not exist yet** (a separate challenger is writing it; the
   `audit/round9/challenge/` directory is currently empty). Left unaccepted on purpose so the gate reports it.
3. `independent reviewer must assess every postcondition` — `postcondition_review` is empty pending that challenge.

No coverage, hash, evidence-binding or detector-triage failures: all 57/67/40 IDs, the Slither source/compiler-input
match, the 8 compiler source hashes, the 19 evidence hashes and the inventory/Slither artifact hashes verified. The M9
`violation` path passed structurally (a valid completed outcome with bound evidence); **a structural pass for the other
paths is not a security conclusion.**

## 4. Limitations

- **Advisory gate.** The script checks supplied records, coverage and hashes only. It does not execute tests, enforce
  protected storage, establish reviewer independence, validate property semantics, or enforce isolation. Evidence
  `exit_code` and `command` are author-written, not captured execution provenance. A `PASS` line (not reached here)
  would never be a security assurance.
- **No protected storage / integrity.** The auditor can write every record; the integrity label stays advisory.
- **Evidence provenance.** All 19 cited logs are controller/lane Foundry runs copied into `evidence/`; they are
  informed (same-author) artifacts for the repository tests and blind-lane artifacts for the lane tests, per
  `run-record.md`. Isolation is prompt-level only.
- **Completeness unknown.** Structural coverage against the inventory does not establish that every consequential harm
  is represented. A harm absent from all supplied paths produces no gate failure. Property-inventory completeness
  remains an open limitation even though every supplied non-P8 row is structurally consistent.
- **Known open items (continuation, not closed by this gate):** purchaser refund ETH amount (needs FWA source),
  automatic curated-draw auto-book PoC, `MINT_FEE_ROSE` gate with a real fee change, retirement after close, multi-run
  loss-share distribution, same-block growth beyond the 5-draw burst, and all off-chain code (reviewed by reading).
  These belong to the acceptance-checkpoint continue/stop decisions in the run record, and to the pending independent
  evidence challenge.
```

---

## Run 2 (second manifest pass)

Active window (UTC): 2026-11-13T12:49Z → 13:03Z (~14 min, under the 40-min ceiling). Run-1 artifacts preserved:
`audit-gate-run1.json`, `gate-run1.output`, `gate-run1.status`. Eight new evidence logs copied byte-for-byte into
`evidence/` with their exact commands from the `.command` files / records; the pass-2 review `manifest-review.md`
copied into `evidence/` for hashing.

**Changes integrated:**

- **P3 (violation, M9) — automatic variant added.** `pc_m9_extent` now cites the keeper's ordinary `performUpkeep`
  reconcile-before-collect over-booking a share-0 curated draw in a genuine shortfall (balance 0.064 < reserve 0.534):
  **0.000365 ETH of fund money made withdrawable with no creator action** (×7/6). Evidence `EV_upkeeporder`
  (controller `UpkeepOrder.t.sol`, 3 passed) and `EV_upkeeporder_asserted` (challenger `UpkeepOrderAsserted.t.sol`,
  RUN10). The stale "automatic PoC not built" wording is gone; the old C12 collect-before-reconcile *standalone* leak
  was **rejected** (it equals the designed EV split — `challenge-pass2.md`).
- **P4 (held) — reward-callback reentrancy now executed; bursts added.** `pc_delivery_reentrancy` narrowed to the
  executed finding (`EV_rewardreentrancy`, 4 passed): unguarded `onlyCreator` functions (`transferCreator`/`close`/
  `configure`) run re-entrantly and persist, guarded `collectProceeds` reverts, `profit ≤ balance` holds, **no
  authority gain** (caller is the creator; a keeper-contract hits `Unauthorized`). New `pc_burst_gas` (`EV_burst`):
  5-draw burst, heaviest upkeep 2,526,724 gas < the 4M floor, keeper pay ≤ credited fees.
- **New P6 (held) — lifecycle closeout.** `MINT_FEE_ROSE` gate (`EV_mintfeerose`) and `retire()` closeout
  (`EV_retire`), both held with M7 sweep-to-zero.
- **P8 (held, was unresolved) — refund resolved on the pool side.** Failed curated delivery credits 0 proceeds / 0
  profit / 0 keeper credit; after the 7-day window `refundFailedDelivery` + `withdrawAcquisitionRefund` returns the
  purchaser **exactly the acquisition fee 0.630139131231725739 ETH** (`EV_refundwithdraw`); `recoverRefunded` returns
  the NFT; balancer ETH untouched; below-reserve variant still books 0 profit (`EV_refundledger`). **Bound:** VRF fee
  was 0 (gas price 0) in this run, so the "exactly the acquisition fee" claim covers the fee component only.
- **Independent review.** `independent_review` points at `evidence/manifest-review.md` (byte copy of
  `audit/round9/challenge/manifest-review.md`). `postcondition_review` is filled from `manifest-review.json` for the
  **7 accepted** postconditions **only**, each with text and `evidence_ids` byte-identical to the reviewed version.
  The 6 changed/added postconditions are withheld and listed in `gate/rereview-needed.md`:
  `P3/pc_m9_extent`, `P4/pc_delivery_reentrancy`, `P4/pc_burst_gas`, `P6/pc_mintfeerose`, `P6/pc_retire_closeout`,
  `P8/pc_refund_player` (pending a pass-3 review).

**Run-2 gate result.** Same command; `gate.output` / `gate.status` saved. **Exit code 1 (FAIL)**, a single honest
line:

```
FAIL: independent reviewer must assess every postcondition
```

No unresolved-outcome failure (P8 is now held), no independent-review-missing failure (the review artifact hashes),
and no coverage / hash / evidence / detector-triage failures: all 57/67/40 IDs, the 28 evidence hashes, the review
artifact hash and the 7 accepted postcondition evidence sets verified. The one failure is the **deliberate** withholding
of the 6 run-2 postconditions until a pass-3 review covers their new text and evidence. The gate was not pruned to pass.
