# Bounded local gate implementation review

Scope: the new local-only branch in `script/deploy.sh`, `scripts/local-rehearsal-gate.ts`, its pure tests, the rehearsal-driver integration, and the frozen plan/document. This is not a contract audit or a continuation of the interrupted whole-candidate reviews. No production-contract investigation, broadcast, funding, mining, wallet use, source edit, commit or review seal was performed.

**No concrete must-fix finding identified within this scope.** The owner-authorized local gate change and the still-unapproved transaction batch remain separate decisions.

## Frozen inputs

Reviewed HEAD: `ff70a1550f233f3601454380d72612b0143e944b`.

Computed and saved plan hash: `7b18522f49bd0809180bc7643969ffcc32d07d4d44e259053d926112f244a236`.

| File | SHA-256 |
| --- | --- |
| `script/deploy.sh` | `0d65a4310fc94c4f55f58d81c2a08132b7b4e2a1d0a4ad28111a4b807c89f139` |
| `scripts/local-rehearsal-gate.ts` | `ad95d585a0d46002d1aa4aff897e69150be79d8d9f7d149ff8c7fcdefee3e209` |
| `scripts/run-local-rehearsal.ts` | `5ad52e2736809e316380e6f3466fc40be94e731b63c604831e8df24748b30edb` |
| `scripts/local-rehearsal-gate.test.ts` | `72c61ee88cbb21f80ddbdc64ca8b8ff1dc46b7e0eca7a1e6736fe2a01cd29894` |
| `docs/RELEASE-REHEARSAL.md` | `efb14a690b4f4ccb02a1cadaba9d1f9a63b378b225427f48e8eb6f9050cce5f3` |

The full plan material hashes are preserved in `material-hashes.json`. The original archive fingerprint remains `ca02fb070a2a839cccc9fced15b3116613f6d7727d4e50133693dd63a4c92eda`; the new wrapper is an explicitly bound local overlay with its own fingerprint, not a reissued production review.

## Guard assessment

- **Production route remains intact.** The wrapper's bytes from `GATE=` through its final Forge invocation are identical to `04bc760`. The owner-signature/outcome/exact-review gate and marker behavior are unchanged on ordinary invocations. Misplaced local approval flags are rejected rather than forwarded as Forge options.
- **Local route is explicit.** The leading local-plan flags invoke the verifier before Forge. Exact argument-array comparison excludes another RPC, signer, account, resume, relay or script. The branch unsets an inherited `ASSET_GATE_PASSED` before Forge and never creates that production marker.
- **Plan/material checks fail closed.** The verifier checks the approved SHA-256 against the exact packet serialization, route, canonical repository/plan path, archive revision, candidate fingerprint, exact material allowlist/current hashes and executed verifier bytes. Protected source/evidence/keeper/shared/dependency changes and untracked protected inputs are rejected. Archive and executed local-overlay fingerprints are distinct and both checked.
- **Owned fork identity is pinned.** The verifier requires `http://127.0.0.1:18556`, chain 31337, the recorded Tenderly fork/block/hash, the sole listener PID, exact Anvil process arguments and repeated process ownership readback. Prepare requires fresh code-free, nonce-zero, unfunded synthetic actors and vacant deployment predictions. Deploy requires the same fresh nonce/code state and exact one-time funding amounts.
- **Prepare is read-only.** It uses the public client, process inspection and file/Git reads. The driver calls prepare verification before seeding actors. The later wrapper calls deploy verification before the unchanged `Deploy.s.sol`. Exact-hash batch authorization remains an external owner decision; computing a hash or passing read-only preflight does not grant it.
- **Scratch dependency repair is scoped.** The driver resolves the actual installed ancestor dependency tree through `tsx` and `viem`, requires both to share that tree and links that tree into scratch. It no longer points scratch at the worktree's cache-only `node_modules`. The archived source is checked before copying the material-bound wrapper/verifier overlay, which is checked separately afterwards.
- **Existing execution limits remain explicit.** Forge owns the complete eight-action `--slow` child batch; the parent imports semantic receipt checks after it returns. Controlled production-Keeper ticks are not a CLI/HTTP service rehearsal. UI writes, real-wallet signing and real randomness remain uncompleted/separately scoped. No contract source was audited to expand those claims.

## Economic and authority scorecard

No monetary coefficients, reserve formula, markup allocation or asset-handling implementation change was part of this local routing review.

| Boundary | Retained scope |
| --- | --- |
| Creator pool deposits | 6 synthetic ETH combined; independent of wallet funding and fee budgets |
| All actor transaction gas | 1 synthetic ETH, with 0.1 ETH held for closeout until closing |
| Buyer submitted native payments | 40 synthetic ETH, including separately checked edge/VRF components |
| Protocol edge / VRF | 1 / 5 synthetic ETH sub-caps; expected edge is distinguished from gross acquisition price |
| One-time external actor funding | 47.43 synthetic ETH across the eight named addresses; no replenishment or protocol balance fabrication |
| Purchases | 152 planned draws, 252 absolute cap, 50 rounds; remaining cap creates no UI authorization |
| Curated contributions | Four initial synthetic NFTs, 1.5 ETH total stated listing value; at most 252 replacements at 0.25 ETH stated value each, 63 ETH additional stated value; no real market valuation or net-profit claim |
| Authority | Owned local fork only; no real funds, production credentials, mainnet/testnet send or publication authority |

The verifier independently pins these plan caps and the exact synthetic roles. Existing driver budget, nonce, receipt, custody/refund and journal checks remain the actual runtime enforcement. This review did not execute them or establish that the full lifecycle fits the budget. The local route intentionally no longer requires production SSH approval/review acceptance, as explicitly authorized by the owner; those requirements remain on the production route.

## Evidence and limits

Pure commands: the focused Vitest file passed **12/12**; driver `--self-check` and default plan exited **0**; deliberately wrong plan hash exited **1** before RPC. Saved/current packet equality and the exact expected final plan hash were checked. Scoped whitespace checks passed. `checks.json` records commands/status/hashes; raw outputs are retained alongside it.

Reused root-provided read-only evidence in `audit/local-gate-change/dependency-fixed-root-readonly-preflight.log` and `dependency-fixed-scratch-readonly-preflight.log`: both report prepare-phase success for PID 50886, chain 31337, fork block 26438875 and hash `0x57c5f1ece4c6f289ccf4e58f26f64ed83fb7402220ef3f61b54d74628e27f157`, with zero transactions sent and `releaseApproval:false`. This reviewer read those logs and made no node calls. The funded deploy phase and valid-hash driver execution were not exercised.

These bounded results establish local-routing and pure guard behavior, not successful deployment, actual runtime code, realized economics, complete custody/closeout, whole-candidate security, mainnet readiness or future compliance. No `SOURCE_HASH`, signature or release seal is supplied.

Things that don't make sense: none beyond the documented eight-action child-batch, frozen historical fork, diagnostic randomness, controlled-Keeper and unexecuted UI/runtime limitations.
