# Independent review: swappable `BalancerFactory.implementation` (new pools only)

**Verdict: PASS — no blocking (High/Critical) finding. Existing clones cannot change behaviour, the creation race is closed by `creationSettingsHash`, no economic value changes.**

## Scope

Immutable diff `git diff b39fd00 ab60c4b` (base already contains `PoolBalancer.owner()`, reviewed separately in `audit/owner-bd73485`; not re-examined).

The change makes `BalancerFactory.implementation` mutable storage (was `immutable`):
- `setImplementation(address next)` — policy-admin only, rejects `next.code.length == 0` (`InvalidImplementation`), emits `ImplementationChanged(previous, next)`.
- `implementation` is now encoded into `creationSettingsHash()`.
- Test `test_factory_setImplementation_newPoolsOnly` (Balancer.t.sol), hash-formula update in KeeperEconomics.t.sol, independent hash formula + `impl` argument in scripts/verify-deployment.ts, regenerated shared/abi.ts, docs.

Owner requirement ("B"): the implementation is swappable so a future PoolBalancer change needs only a new implementation, not a new factory. New pools only; existing pools never change code. Upgradeable pools were explicitly rejected. The policy admin (trusted owner key) holds the power.

## Method

- Read the full `BalancerFactory.sol` (storage block, constructor, `setImplementation`, `creationSettingsHash`, `createBalancer`, `predictBalancer`, `_salt`, both admin two-step transfers).
- Grepped every runtime reader of the factory from the clones (`src/PoolBalancer.sol`, `PoolInventory.sol`, `KeeperPolicyCalls.sol`, `PoolPage.sol`) and inspected the `IBalancerFactory` interface the clones use.
- Grepped off-chain consumers (`app/src`, `keeper`, `shared`) for `implementation` / `predictBalancer` / `creationSettingsHash` assumptions.
- Compared the hash formula byte-for-byte across src, verify-deployment.ts and KeeperEconomics.t.sol.
- `forge build --sizes` (EIP-170), `forge test --match-path test/Balancer.t.sol`, `forge test --match-path test/KeeperEconomics.t.sol` (fork tests, Tenderly RPC in foundry.toml), `npm run typecheck`.
- Economic framing per `/Users/dd/.agents/guidance/holistic-verification.md`.

## Findings

### C1 — Authorization. PASS.
`setImplementation` gates on `msg.sender != policyAdmin` (same guard as `setEconomics`, `setDefaultBucket`, `setProductLimits`). The policy-admin two-step transfer (`transferPolicyAdmin` / `acceptPolicyAdmin`) is untouched by this diff, so the authority set is unchanged. The test asserts a stranger reverts with `Unauthorized`. Keeper-admin powers are unaffected (separate authority). No new path grants the power.

### C2 — No existing clone can change behaviour. PASS (core requirement).
Clones are Solady EIP-1167 proxies with the implementation address baked into their bytecode, so a clone's code is physically fixed at creation. The switch could only leak into an old pool if some runtime path read `factory.implementation()` — it does not:
- The clones' view of the factory is the `IBalancerFactory` interface (PoolBalancer.sol:13), which exposes only `canKeep`, `economics`, `defaultBucketCapacity`, `defaultBucketRefill`, `productLimits`. **`implementation()` is not in the interface**, so no clone can even call it.
- The only factory reads at runtime are `factory.economics()`, `factory.productLimits()`, `factory.canKeep()`, and (at `initialize` only) `factory.defaultBucketCapacity()` / `defaultBucketRefill()`. None touches implementation.
- The test reads the delegate target out of each clone's bytecode (`_cloneTarget`) and asserts the pre-existing pool still points at `oldImpl` after a switch, while a new pool points at `next`. Direct on-chain confirmation.

### C3 — Creation-race safety. PASS.
A creator approves NFTs to `predictBalancer(creator, salt)`, whose result depends on the implementation (the EIP-1167 init code embeds it, so the CREATE2 address moves when implementation changes — asserted by the test). After a switch:
- The reviewed `config.settingsHash` was bound to the old implementation; `createBalancer` recomputes `creationSettingsHash()` with the new implementation, the hashes differ, and creation reverts with `StaleSettings` (asserted). It never mints a pool at an unexpected address.
- The pool is always cloned from the same `implementation` whose hash the creator matched (both the gate and `cloneDeterministic` read the single storage `implementation` in one call), so a minted pool's code is exactly what was reviewed.
- Approvals to the old predicted address cannot be used by anyone: `_salt = keccak256(creator, salt)` binds the deploy address to the creator as `msg.sender`, and the old address is only reachable while the old implementation is active. No third party can deploy there to consume the approval; the creator's NFTs stay in their wallet (an approval to a code-less address is inert). The creator re-reads the fresh hash and predicted address and creates normally. No stranding.

### C4 — `creationSettingsHash` reads `SHAPES()` from the current implementation. PASS.
`PoolBalancer(payable(implementation)).SHAPES().mintFee()` reads from the live `implementation` storage value, so after a switch it reflects the new implementation's `SHAPES`. The `@dev` note and DECISIONS.md record the trust assumption that a replacement must keep `initialize`, `SHAPES()` and `pool()`. If a policy admin sets a code-bearing but incompatible implementation, `creationSettingsHash()` would revert and block `createBalancer` until corrected — a recoverable admin error, existing pools unaffected. Acceptable under the stated trust model (see I1).

### C5 — Discovery across mixed implementations. PASS.
`isBalancer[balancer] = true` and `BalancerCreated` are emitted for every clone regardless of which implementation it copied, so enumeration and membership checks are implementation-agnostic. Pools created before and after a switch coexist under one factory and are all discoverable.

### C6 — Hash formula identical in all three sources. PASS.
- src/BalancerFactory.sol: `keccak256(abi.encode(poolHash, defaultBucketCapacity /*uint128*/, defaultBucketRefill /*uint96*/, implementation /*address*/))`.
- scripts/verify-deployment.ts: `keccak256(encodeAbiParameters('bytes32, uint128, uint96, address', [pool, cap, refill, impl]))`.
- test/KeeperEconomics.t.sol: `keccak256(abi.encode(settingsHash(), keeperBucketCapacity() /*uint128*/, keeperBucketRefill() /*uint96*/, implementation() /*address*/))`.

Same four types, same order -> identical 32-byte-padded ABI encoding -> identical digest. verify-deployment.ts additionally reads the live `creationSettingsHash` and compares to its own independent computation, so on-chain/off-chain drift is caught at deploy time.

### C7 — Events. PASS.
`ImplementationChanged(previous, next)` is emitted before the storage write, so `previous` is the outgoing value and `next` the incoming — correct. The constructor emits `ImplementationChanged(address(0), implementation_)`, giving a complete on-chain history from genesis. Both topics indexed. The test checks the emit.

### C8 — Storage layout. PASS.
The factory is a directly deployed contract, not a proxy (confirmed: fresh deployment per scope). `implementation` moves from `immutable` (bytecode) to storage slot 0; all other state follows. With no proxy and no pre-existing factory state to preserve, layout ordering is immaterial. No clone reads factory storage by slot.

### C9 — Size (EIP-170). PASS.
`forge build --sizes`: BalancerFactory runtime 5,354, PoolBalancer runtime 23,535 (margin 1,041); both under 24,576. Matches the scope's stated figures.

## Economic pass

**No asset, fee, payment or reserve behaviour changes for existing or new pools in this diff. Confirmed.**

What I checked, by bucket:
- **Existing pools (owner proceeds, keeper bucket, reserve, prize/restock flows):** unreachable from this change — clone bytecode fixed, and no runtime read of `factory.implementation()`. Economics continue to come from `factory.economics()` via the unchanged `FOLLOW` path; the initial bucket and `settingsHash` stored at init are not recomputed. Zero delta.
- **New pools:** the initial economics, default bucket (0.622 ETH / floor(0.05 ETH /12) per sec), product limits and Shapes mint fee are all unchanged in this diff; the deployed `implementation` here is the same PoolBalancer code (identical runtime size 23,535), so a pool created now behaves exactly as before. The implementation is simply now named in the review hash.
- **The only new capability** is the policy admin selecting the code future pools run — a one-way-per-switch choice already vested in the owner key, and precisely owner requirement B. Each future implementation carries its own economic surface and must be economically re-reviewed when it is deployed; that is out of scope for this diff, which changes no number.
- **No value that only ratchets:** `setImplementation` is freely reversible (admin can set any code-bearing address, including a prior one), so it introduces no monotonic state.

## Off-chain consumers (report only, not fixed)

- **app/src/App.tsx, keeper/community-acceptance.ts, keeper/reserve-economics.ts, keeper/rehearsal.ts:** all read `predictBalancer` and `creationSettingsHash` *fresh* at creation time rather than caching a single implementation. App.tsx:1467 re-reads `creationSettingsHash` and refuses to submit if it changed since review — the correct guard against a mid-flight switch. No change needed.
- **shared/abi.ts:** regenerated to include `setImplementation`, `ImplementationChanged` and `InvalidImplementation`. Current.
- **Future-switch caveat to flag (not a today-bug):** app and keeper decode every pool with a single PoolBalancer ABI resolved from the pool's `factory()`. Today all clones under this factory share one ABI, so this is correct. If a *future* `setImplementation` ships a PoolBalancer with a changed ABI, off-chain decoders would need to branch per-implementation (e.g. resolve ABI by `implementation` or by clone bytecode, not just by factory). DECISIONS.md already records the intended convention ("the app and keeper treat functions an older pool lacks as absent"), which covers additive changes but not removals/renames. Recommend, at the time such an implementation is prepared, adding per-implementation ABI resolution. No action required for this diff.

## Info

### I1 — `InvalidImplementation` validates code presence only.
`setImplementation` rejects only `next.code.length == 0`; it does not verify `next` exposes `initialize`/`SHAPES()`/`pool()`. This is by design — a full interface check is impractical and the policy admin is trusted. A bad-but-code-bearing implementation is a recoverable admin error (block creation, re-set to a good one), never affecting existing pools. Documented in the `@dev` note and DECISIONS.md.

## Limitations

- Reviewed the single diff `b39fd00..ab60c4b` only; did not re-audit base behaviour or the `owner()` change.
- Ran the two named focused test files plus build-sizes and typecheck; did not run whole suites, fork lifecycles or invariant campaigns (per scope — those belong to a frozen candidate).
- The correctness of any *future* implementation set via `setImplementation` is explicitly a trust assumption on the policy admin; this review covers the switching mechanism, not unknown future code.
- Deployment-path specifics (the DEPLOY doc's CREATE2 redeploy of PoolInventory due to a metadata-hash difference) are documentation outside the src diff and were not independently reproduced.

## Things that don't make sense

None. The `_salt` deliberately excludes `implementation` (the address already moves via the EIP-1167 init code, and the `creationSettingsHash` gate forces re-review), which is consistent, not a gap.

## Checks run

| Check | Result |
|---|---|
| `forge build --sizes` | BalancerFactory 5,354; PoolBalancer 23,535; both < 24,576 |
| `forge test --match-path test/Balancer.t.sol` | 30 passed, 0 failed |
| `forge test --match-path test/KeeperEconomics.t.sol` | 8 passed, 0 failed |
| `npm run typecheck` | clean |

Revision `ab60c4bb405450d9d31c351bac26e4215c15f596`.
