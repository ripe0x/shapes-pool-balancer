# Independent review: PoolBalancer `owner()` + cutover wiring

**Verdict: PASS — no blocking (High/Critical) finding and no stranding risk for the existing pool.**

## Scope

Two immutable diffs, reviewed against the currently deployed source `858eb21` (identical to `origin/main` for `src/`):

1. **Contract change** `git diff 858eb21 bd73485 -- src test shared/abi.ts`: adds an ERC-173 `owner()` view and an `OwnershipTransferred` event to `PoolBalancer`. New implementation + new factory; already-deployed clones are immutable and unchanged.
2. **Cutover wiring** `git diff bd73485 277c8a3`: keeps the existing pool on factory `0x526FbD402624B50861f54c081B592cdCeE322929` (its only pool, `0xB4A519F2EC35AbEF476C63E0Bb3246fB83CACC33`) discovered, managed and serviced after a new factory becomes the creation target. Adds a `community-v2` entry to `deployments/1.legacy.json` and touches `shared/legacy.ts`, `app/src/App.tsx`, `keeper/keeper.ts`, `scripts/deployment-preflight.ts`, `docs/DEPLOY-COMMUNITY-REPLACEMENT.md` section 0.

Owner requirement: `owner()` must return the pool's creator (view-only; control still moves only through two-step `transferCreator` then `acceptCreator`).

## Method

- Read `PoolBalancer.sol` around every `creator` write, the constructor lock, `initialize`, `transferCreator`/`acceptCreator`, `owner()`, `isValidSignature`, and the storage-variable block.
- Searched every `creator =` write and every `.owner()` call site across `src/` (grep).
- `forge build --sizes` for EIP-170 and selector-clash (a clash is a compile error).
- Traced the wiring end to end: `shared/legacy.ts` (`LEGACY_FACTORIES`, `legacyFactory`, `selectLegacyFactories`), the app's discovery / ABI / rule paths, the keeper's `resolveAbi`/`readContext`, and the preflight ABI check. Parsed `deployments/1.legacy.json` to confirm each packaged ABI's function set.
- Read-only RPC against `https://mainnet.gateway.tenderly.co`: counted `BalancerCreated` logs for `0x91C3...` (community-v1) and `0x526F...` (community-v2).
- Ran the focused checks: `forge test --match-path test/Balancer.t.sol`, `npx vitest run app/src/limits.test.ts keeper/keeper.test.ts scripts/deployment-preflight.test.ts`, `npm run typecheck`.

## Findings

### Contract change (bd73485)

**C1 — `owner()` correctness against every creator-write path. PASS (no issue).**
`creator` is written in exactly three places:
- `initialize` (line 263) sets `creator = creator_`, then emits `OwnershipTransferred(address(0), creator_)` — the canonical "mint ownership from zero" pattern. Correct.
- `acceptCreator` (line 315) emits `OwnershipTransferred(creator, msg.sender)` **before** overwriting `creator`, so `previousOwner` is the old creator. Correct ordering.
- Constructor (line 243) sets `creator = address(1)` to lock the implementation (no emit — see Info I1).

`transferCreator` only emits `CreatorTransferStarted` and sets `pendingCreator`; it does **not** emit `OwnershipTransferred`, which is correct for a two-step scheme (ownership moves on accept, not on the pending start). `owner()` simply returns `creator`, so it tracks the role through all transitions. No other write path exists (libraries receive `creator_` as an argument in `_listCurated`; they never touch the `creator` storage slot).

**C2 — Storage layout. PASS.** The change adds no state variable (`owner()` is a function, `OwnershipTransferred` an event). The storage block (`creator`, `pendingCreator`, `pool`, `enabled`, `creatorWork`, `curatedRequired`, `_inventory`, `pageApprovedEpoch`, `factory`, `_keeper`) is byte-for-byte unchanged, so there is no layout shift. New clones start fresh regardless; existing clones are untouched.

**C3 — Runtime size (EIP-170). PASS.** `forge build --sizes`: **PoolBalancer runtime = 23,535 bytes**, under the 24,576 limit (margin 1,041). BalancerFactory 5,290. See Info I2 on the tightness.

**C4 — Selector clash. PASS.** The build compiles, which an `owner()` selector collision (`0x8da5cb5b`) would prevent. No clash.

**C5 — Integrations calling `owner()` on the balancer. PASS (no behaviour change).** The only `.owner()` calls in `src/` are `ENS.owner(node)` (ENS registry) and the `IFWAPool.owner()` interface declaration; the FWA pool's owner is the balancer, not vice-versa. `BalancerFactory` calls only `initialize` on the clone. No FWA pool, PoolPage or factory code calls `balancer.owner()`, and `isValidSignature` keys off `pageApprovedEpoch`/`pageEpoch`, not owner. Before this change a call to the (absent) `owner()` would have reverted; nothing on-chain relied on that revert. The addition is inert for existing integrations and satisfies the off-chain "tooling reads `owner()`" goal.

### Cutover wiring (277c8a3)

**W1 — Existing pool `0xB4A5...CC33` is not stranded. PASS.** Verified each stranding vector:
- *Discovered:* the app enumerates pools from `[FACTORY, ...LEGACY_FACTORIES]` (App.tsx:600) and validates `isBalancer` across the same set (666); `LEGACY_FACTORIES` includes `community-v2`. The keeper iterates `[primary, ...legacyFactories]` (keeper.ts:215) and `selectLegacyFactories` returns `community-v2` (it is not the creation factory). The configured discovery block `26,482,707` precedes the pool's creation block `26,487,264` (RPC-confirmed), so it is found.
- *Right ABI:* the keeper resolves a pool's ABI from its on-chain `factory()` and uses that factory's packaged `poolBalancerAbi` (keeper.ts:307-311); for `0x526F...` that is the exact deployed `858eb21` ABI (no `owner()`), so no `owner()` call is ever made on it. The app uses the current `poolBalancerAbi` for it, which is harmless: viem encodes only the function actually called, and the sole delta vs `858eb21` is `owner()`/`OwnershipTransferred`, neither of which the app invokes or decodes for this pool (the pool emits no `OwnershipTransferred`).
- *Current rules, not community-v1:* `legacyFactory(0x526F...)` returns `undefined` because its packaged ABI contains `effectiveEconomics` (shared/legacy.ts:35-37). The keeper independently keys current-vs-legacy economics on `has('effectiveEconomics')` (keeper.ts:328), also true here. So the pool is managed with current economics/limits/`configure`, not the community-v1 fixed schedule.
- *Keeper keeps servicing:* runbook step 10 sets `LEGACY_FACTORIES="community-v2"` so the keeper services it. Default (unset) would also include it.
- *History not missing:* `POOL_LOGS_FROM = min(FROM_BLOCK, all legacy fromBlocks)` (App.tsx:213), and the creator-transfer lookup uses the same floor (605), so ledger and creation-block reads reach back to the factory's deployment.

**W2 — `LEGACY_FACTORIES` parsing is safe. PASS.** `selectLegacyFactories` (shared/legacy.ts:41-45): `undefined`/empty gives all legacy factories; `"0"` gives `[]` (empty-array `labels` is truthy, so the `labels.includes` branch yields none); a label list gives those labels; an unknown label **throws** (fail-fast, no silent misconfiguration). The creation factory is always excluded by address, so switching `LEGACY_FACTORIES` before `FACTORY`, or naming the creation factory's own label, never double-scans it. Covered by `limits.test.ts` including the throw and the creation-factory-exclusion cases.

**W3 — Preflight `keeperPolicyV1` guard is correct and necessary. PASS.** `if (label === 'keeperPolicyV1' && !address && !items) continue;` skips the check for community-v2 (`keeperPolicy: null`, no `keeperPolicyV1` ABI key — confirmed in the JSON), where without the guard `missingSelectors(undefined, ...)` would throw on `undefined.filter`. community-v1 keeps the check (it has both a `keeperPolicy` address and a `keeperPolicyV1` ABI key).

**W4 — Runbook order and Checks are sound. PASS.** Build, then read-only preflight, nonce/balance, reviewed dry-run (asserts exactly PoolBalancer then BalancerFactory, no library, `ASSET FLOW GATE: PASS`), broadcast+verify, verify-from-receipts, set 1.5 gwei ceiling, readbacks. Step 9 reads `owner()` on the new implementation and expects `0x...01`, which correctly exercises the new view against the locked implementation. Only steps 6 and 8 sign; cutover (step 10) is last. The `1.owner.*` record prefix preserves the `1.replacement.*` records of `0x526F...`.

## Economic pass

**No asset flow, fee, payment or reserve behaviour changes. Confirmed.**

What I checked:
- The contract diff adds only: an event declaration, two `emit` statements (pure log emissions, no storage or value effect), and a `view` returning `creator`. It touches no ETH/NFT transfer, no `markup`/`creatorRevenueBps`/`restockFee`/reserve/surplus/keeper-reward math, and writes no storage slot that any value path reads. `initialize` and `acceptCreator` are otherwise line-for-line unchanged.
- Every buckets / round-trip / ratchet concern from the holistic-verification economic framing is untouched: the diff changes none of the money flows (deposits, proceeds collection, surplus claim, keeper pay, curated/shape listing prices, reserve requirement). "Nothing moved" here is literally true — there is no new or altered flow to trace.
- The wiring diff is entirely off-chain TypeScript/JSON/docs (app, keeper, preflight, legacy config, runbook). It changes which ABI the tooling uses to read/call existing pools; it introduces no new on-chain action and no economic parameter. The `community-v2` pool is driven by its own already-deployed contract economics (`effectiveEconomics`, in-library R95 payment), unchanged by this diff.

## Verification evidence

| Check | Command | Result |
|---|---|---|
| Build + size | `forge build --sizes` | PoolBalancer 23,535 (< 24,576), BalancerFactory 5,290; no selector clash |
| Fork tests | `forge test --match-path test/Balancer.t.sol` | 29 passed, 0 failed (incl. `test_creatorTransferTwoStep`, creation `OwnershipTransferred(0, creator)`) |
| TS unit tests | `npx vitest run app/src/limits.test.ts keeper/keeper.test.ts scripts/deployment-preflight.test.ts` | 36 passed, 0 failed |
| Typecheck | `npm run typecheck` | clean |
| RPC (read-only) | `eth_getLogs BalancerCreated` on `0x91C3...` and `0x526F...` | community-v1: 0 pools; community-v2: 1 pool = `0xB4A5...CC33`, creator `0xCB43...`, block 26,487,264 |

Revision under test: worktree HEAD `277c8a3` (contains the `bd73485` src change; the wiring commit does not touch `src/`). Fork RPC: `https://mainnet.gateway.tenderly.co` (foundry.toml `[rpc_endpoints] mainnet`).

## Informational notes (non-blocking)

- **I1 — Not full ERC-173, by design.** The contract implements `owner()` + `OwnershipTransferred` but not `transferOwnership(address)` or ERC-165 `supportsInterface`, and the constructor lock (`creator = address(1)`) emits no `OwnershipTransferred`. This matches the owner's explicit "view-only addition" requirement (control still moves via `transferCreator`/`acceptCreator`). Tooling that reads `owner()` gets the creator, which is the stated goal. Reading `owner()` on the implementation returns `0x...01` (verified in runbook step 9) — a clear "locked, not a real owner" sentinel. No action needed.
- **I2 — Runtime-size margin is tight (1,041 bytes).** Future `PoolBalancer` additions should re-check `forge build --sizes`.
- **I3 — `LEGACY_FACTORIES=""` behaves as unset (= all legacy factories).** An empty/whitespace env value is treated the same as unset, which could mildly surprise someone expecting empty to mean "none" (that is `"0"`). Documented behaviour; harmless given the current factory set.

## Limitations

- Reviewed only the two named diffs and the files they touch; did not audit unrelated parts of `PoolBalancer` or the wider system.
- The economic conclusion rests on the diff content, not a full re-run of the asset-flow campaign; the change introduces no flow to exercise, so no new economic simulation was warranted.
- On-chain facts (pool counts, blocks) read from `https://mainnet.gateway.tenderly.co` at review time; a later pool created on community-v1 would change the W1/"Things that don't make sense" reasoning (none existed when checked).
- `forge build` prints a `foundry.lock` symlink warning for `lib/forge-std` (expected per the worktree note); compilation and tests are unaffected.

## Things that don't make sense

None. One item worth recording as resolved rather than open: the runbook pins the keeper to `LEGACY_FACTORIES="community-v2"`, which drops community-v1 from service. That initially looked like a potential regression, but on-chain `BalancerCreated` logs show **community-v1 (`0x91C3...`) created zero pools**, so nothing is stranded by omitting it. Confirmed, not a concern.
