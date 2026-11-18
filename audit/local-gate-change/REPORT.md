# Local rehearsal gate implementation

**Implemented and prepared; batch approval pending. No funding or broadcasts.** Base `ff70a1550f233f3601454380d72612b0143e944b`. Owner R60 authorizes a local-only gate change, preserves production gates and requests a concrete batch for later approval.

Proposed batch SHA-256: `7b18522f49bd0809180bc7643969ffcc32d07d4d44e259053d926112f244a236`. Canonical payload: `docs/receipts/rehearsal-04bc760-preparation/bounded-plan.json`. Full roles, decoded deployment, scenarios and limits: `docs/RELEASE-REHEARSAL.md`.

## Controls and verification

- `script/deploy.sh` retains the complete production gate/Forge tail from `GATE=` onward byte-for-byte against `04bc760`, including the owner-signature asset gate and `--require-review`. Its explicit local-plan branch uses the same `Deploy.s.sol`, strips only the local routing arguments, calls a read-only verifier, clears inherited `ASSET_GATE_PASSED` and permits only the exact planned Forge arguments.
- The local verifier checks canonical plan/hash/material files, archived inputs and the separate wrapper overlay. It checks the actual `127.0.0.1:18556` listener PID/Anvil command, chain31337, Tenderly fork metadata and unchanged tip, synthetic account code/nonces/balances and vacant creation destinations. A chain ID or loopback URL alone does not establish ownership. Prepare runs before any actor funding; deploy requires exact approved wallet funding and still-fresh nonces/tip. It contains no signing, send, mining, balance-setting or impersonation API.
- Default and exact-hash guarded driver routes retain shared spending counters, simulation, receipts, nonce persistence, actual backing/ownership readbacks and closeout. This plan is not an owner signature or completed production review. A read-only CLI probe with its proposed hash is not approval to execute the driver.
- Twelve focused tests pass: genuine current material/arguments, stale approval, mainnet/testnet/remote/other-local endpoints, changed sender, expanded budget, changed material, extra/altered Forge arguments, incomplete/misplaced local wrapper flags and byte-identical production tail. Typecheck and shell syntax pass. Exact commands/statuses/timings are in `checks.json`.
- Actual read-only preflight passes from both the original root and repaired scratch: PID50886, fork block26,438,875 and original hash, all eight actors zero balance/nonce/code, all eight deployment destinations absent. `readonly-preflight.json` retains the commands and outcomes. No real local transaction receipt exists yet.

## Economic and authority scorecard

| Flow or authority | Before approval, actual | Proposed bounded run and recipient |
| --- | --- | --- |
| Real assets / public-network authority | 0 moved; no new authority | None. Only the owned local fork and named synthetic actors. Production release gates remain required. |
| Synthetic wallet setup | All eight actors unfunded | One-time 47.43 test ETH across roles; no replenishment. Protocol/coordinator balances are not fabricated. |
| Creator inventory/operating funding | 0 deposited | At most6 test ETH combined into two pools. Opening previews0.2265738789135/0.4141091002704ETH at fork basefee0.115909741gwei and Shapes mint fee0.001ETH; actual inclusion amounts remain unexecuted. No hidden top-ups. |
| Transaction gas | 0 spent | At most1 test ETH across every actor, including coordinator exception;20gwei max fee,0.05gwei priority,16,777,216gas per transaction. System deployment reserve0.44366602ETH plus0.1ETH closeout reserve fits that cap. |
| Buyer / FWA / randomness | No requests or payments | At most40 test ETH buyer submissions, including at most1ETH actual EDGE and5ETH VRF. Actual draw proceeds, buyer refunds and backing are reconciled separately after execution. |
| Work and contributed NFTs | No new pools or NFTs | Two pools;50rounds/152planned draws under252hardcap. Four initial synthetic curated NFTs with1.5ETH stated listing value; at most252 replacements at0.25ETH stated value each. These are not real market costs/profit. |
| Final recovery | Not executed | Close, reconcile, unlist/redeem, return remaining NFTs, collect proceeds/surplus and withdraw player refunds. Booked counters do not substitute for actual custody readbacks. |

No keeper coefficient, restocking charge, reserve formula, creator allocation, purchaser right, policy authority or deployed contract bytecode changes. The sole removed prerequisite is production release acceptance before this isolated diagnostic. Each local money flow remains bounded by the approved hash/materials, synthetic roles, shared caps and receipt/custody checks. Production monetary outcomes remain unsigned. Historical25-regime results/501Foundry/125TypeScript evidence are not regenerated or restamped by this change.

## Failures, review and limits

Preserved setup failures: initial test discovery found zero tests (exit1), then Vitest discovery was extended to include the new script tests. The first scratch preflight could not import `tsx` (exit1 before RPC): the worktree's node_modules held only Vite caches. Stage now resolves the real installed ancestor tree from both `tsx` and `viem`; no installation, cache deletion or dependency update occurred. Original failure logs/packets and successful new stage/CLI proof remain preserved.

The independent [routing review](review/REPORT.md) reports no concrete must-fix within this implementation scope. It is not the previously interrupted contract audit, a whole-candidate audit, a release seal or batch approval. The production reader's `--no-run --require-review` remains exit2: missing owner approval/current review plus stale full-source stamps after the wrapper change. Local archive fingerprint `ca02fb…` and overlay fingerprint `f248d6…` are separately identified; no `SOURCE_HASH` or signature is minted.

Unexecuted: funded deploy-phase success, actual deployment/receipts, lifecycle/budget sufficiency and player/creator/keeper closeout. Forge controls the whole eight-deployment `--slow` child batch; parent semantic checks occur after its return. The driver uses controlled production Keeper ticks, not a CLI/HTTP-service rehearsal, and no UI transaction or real browser-wallet signature. The retained coordinator exception is not live oracle delivery. The preserved fork is pinned to its preparation block, not current mainnet at later approval time.

## Things that don't make sense

- A read-only gate pass cannot prove an unexecuted transaction lifecycle.
- Pinned dependencies, synthetic NFT valuations and coordinator impersonation cannot establish live market profitability or oracle/wallet availability.
