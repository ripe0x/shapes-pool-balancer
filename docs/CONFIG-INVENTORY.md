# Community release — configuration inventory and economics design

Status: 2026-11-23. Authoritative inventory and implementation design for the community pool release
(spec `community-release-spec.md`, Part B overrides Part A). This is deliverable #2/#6 of the spec.

This document separates **what is implemented on `claude/community-release`** from **what is designed and
remains to be implemented**, because the full keeper-economics rework is a large, fork-verified change that
one implementation pass cannot land and verify to mainnet-candidate quality. Each row/section is marked.

Legend: ✅ implemented + compiles · ◻︎ designed, not yet implemented · ⚠︎ decision/risk.

---

## 1. Configuration inventory

Every economic or product value in the production contracts, its authority, scope, getter, update path,
initial value, bounds, derived values and consumers. "Consumers" lists on-chain + off-chain readers.

### 1a. Creator pool settings (per `PoolBalancer` clone)

| Setting | Status | Authority | Getter | Update path | Initial | Bounds | Consumers |
|---|---|---|---|---|---|---|---|
| `markupBps` | existing | creator | `markupBps()` | `configure(markup,target)` | creation | factory min/max markup (see 1b); today hardcoded 1000..10000 in `PoolInventory.validateTarget` | FWA listing price (`_prizeBase`), app sliders/preview |
| `target` | existing | creator | `target()` | `configure` | creation | prizes 1..`maxPrizes` (hardcoded 1000 today) | fill gate, reserve, `fill`, app |
| `mintFeeCap` (accepted fee) | existing; binding ◻︎ | creator | `mintFeeCap()` | `configure` (binds live fee at exec) | creation fee | `<= type(uint256)` | upkeep mint gate, reserve, app "accept fee" |
| `creatorRevenueBps` | existing | creator | `creatorRevenueBps()` | `setCreatorRevenueBps` | creation | `<= 10000` | `_collect` credit split |
| `curatedRequired` | existing | creator | `curatedRequired()` | `setCuratedRequired` | creation | bool | admission (status 3/7), app |
| **`fillGateBps`** | ✅ | creator | `fillGateBps()` | `setFillGateBps` | **7000** | `0..10000` (0 drops target-fill req, keeps `prizeWeight<lost` check) | `PoolInventory.admission`, app preview (Phase B) |
| **`backlogThreshold`** | ✅ | creator | `backlogThreshold()` | `setBacklogThreshold` | **5 (=MAX_BATCH)** | `>= 1`; no factory max this release | `PoolInventory.admission` (status 4), app |
| `fillGateBps`/`backlog` at creation | ◻︎ Phase B | creator | — | add to `CreationConfig` + app creation flow | defaults above | — | creation UI |
| bucket capacity | ◻︎ | creator | `keeperBucketCapacity()` (new) | `setKeeperBucket` (new) | 0.622 ETH | `>=0`; see §4 accrual | `pay`/`available` |
| bucket refill/s | ◻︎ | creator | `keeperBucketRefill()` (new) | `setKeeperBucket` | `floor(0.05 ether/12)` | `>=0` (0 = no refill) | `pay`/`available` |
| follow vs local | ◻︎ | creator | `economicsSource()` (new) | `followFactory()` / `setLocalEcon()` / `pinEconomics()` | follow | — | resolver §3 |
| paid upkeep enabled | existing; immediate ◻︎ | creator | `paidUpkeepEnabled()` | `setPaidUpkeepEnabled` (make immediate, no delay) | true | bool; emergency-disable survives factory updates | `_performUpkeep` |
| keeper policy (algorithm) | existing; immediate ◻︎ | creator | `keeperPolicy()` | `setKeeperPolicy` (immediate, replaces propose/activate) | factory default @ creation | `KeeperPolicyCalls.validate` | quote/pay/restock |

### 1b. Factory settings (`BalancerFactory`, `policyAdmin` unless noted)

| Setting | Status | Authority | Getter | Update path | Initial | Bounds | Consumers |
|---|---|---|---|---|---|---|---|
| `defaultKeeperPolicy` | existing; delay to be removed ◻︎ | policyAdmin | `defaultKeeperPolicy()` | `setDefaultKeeperPolicy` (immediate) | ctor arg | `validate` | new clones only |
| `maxPrizes` | ◻︎ (reuse branch) | policyAdmin | `getSettings().maxPrizes` | `setMaxPrizes` | **1000** | `1..1000` | `validateTarget`, design-change rule §5 |
| `minMarkupBps` | ◻︎ | policyAdmin | settings | `setMinMarkupBps` | **1000** | `1..maxMarkupBps` | `validateTarget` / markup range |
| `maxMarkupBps` | ◻︎ | policyAdmin | settings | `setMaxMarkupBps` | **10000** | `minMarkupBps..10000` | `validateTarget` |
| factory **EconConfig** (whole struct) | ◻︎ | policyAdmin | `econConfig()` | `setEconConfig` (validated whole-struct) | V1 values (§2) | per-field arithmetic bounds §2 | resolver §3 → every money path |
| keeperAdmin / restricted / approved | existing | keeperAdmin | getters | setters (two-step admin) | — | — | `canKeep` |

⚠︎ The reusable branch `claude/pool-settings-rework` put **work-per-upkeep (maxOps/maxReconcile/maxProcess/
maxRestockSizes/curatedBatch) and the fill gate on the factory**. The new spec reverses both: work-per-upkeep
stays FIXED (§2) and the fill gate is a **creator** pool setting (now implemented, 1a). Do **not** carry those
factory setters over.

### 1c. Fixed execution limits (immutable; spec §5 / Part B §1 — justification required, not business preference)

| Constant | Value | Why immutable (arithmetic/gas-safety, not preference) |
|---|---|---|
| `MAX_OPS` (shape units/upkeep) | 5 | 6 units + 5 reconciles measured 3.13M vs the 3.2M lowest allowed `maxGas`; 5 keeps margin. Raising it risks exceeding the reimbursable-gas envelope and underpaying keepers. |
| `MAX_RESTOCK_SIZES` | 4 | each size is its own mint call (~0.5M); 6 sizes measured 3.19M vs 3.2M cap. |
| `MAX_PROCESS` | 2 | `PROCESS_STARVED_GAS` (400k) griefing bound was derived for 2 processed draws + FWA's 6-listing reservations (~3.3M). Changing it invalidates the starvation proof. |
| `MAX_RECONCILE` | 5 | one FWA batch (~33k each); keeps worst upkeep under the pay cap. |
| curated batch | 20 | bounds the 100k-gas purchase-hook witness scan and `listNFTs` gas. |
| `MAX_BATCH` | 5 | FWA `maxAcquisitionsPerTx`, verified against the FWA factory at creation. Protocol identity, not tunable. |

### 1d. Immutable monetary ceilings to REMOVE (spec §4.6 — "arbitrary obstacles")

| Current literal | Where | Replacement |
|---|---|---|
| `HARD_MAX_REWARD = 0.311 ether` | `KeeperPolicyCalls` `_bound`/`validate` | derived `maxReward = (maxGas+overhead)*ceiling + 10*workFee` (0.01645 at V1) in EconConfig; keep only an absolute anti-overflow sanity bound |
| `units * 0.102 ether` restock-quote cap | `KeeperPolicyCalls.restock` | derived `maxRestockSurcharge = restockGas*ceiling + restockFlat` (0.0047/shape at V1) in EconConfig |
| `50 gwei` ceiling, `0.1 gwei` priority, `0.00005` fee (envelope) | `KeeperPolicyCalls` | EconConfig fields; reconcile with the V1 pricing numbers (see §2 ⚠︎) |
| V1 fallback `900k / 0.0002 / 5 gwei` literals | `KeeperPolicyCalls.restock` fallback | EconConfig fallback fields |

---

## 2. EconConfig initial values (spec §4 "start with V1", verify derived maxima)

```
workFee            = 0.00002 ether
maxGas             = 3_200_000      // reimbursable gas limit
overheadGas        = 50_000
gasPriceCeiling    = 5 gwei
priorityAllowance  = 0.05 gwei
restockGas         = 900_000        // per actual shape
restockFlat        = 0.0002 ether   // per actual shape
// per-operation gas coefficients (reserve/maintenance math):
baseGas=200_000 processGas=1_800_000 reconcileGas=150_000 shapeGas=700_000 prizeGas=150_000
// derived bounds (NOT per-call charges):
maxReward          = (maxGas+overheadGas)*gasPriceCeiling + 10*workFee = 0.01645 ether   ✓ verified
maxRestockSurcharge= restockGas*gasPriceCeiling + restockFlat          = 0.0047 ether/shape ✓ verified
// fallback (policy fails):
fallbackGas=900_000 fallbackFlat=0.0002 ether fallbackCeiling=5 gwei fallbackPriority=0.05 gwei
// bucket defaults (creator-overridable):
bucketCapacity=0.622 ether  bucketRefill=floor(0.05 ether/12)=4_166_666_666_666 wei/s
```

Derivation check (at V1): `(3_200_000+50_000)*5e9 + 10*2e13 = 1.625e16 + 2e14 = 1.645e16 = 0.01645 ETH` ✓.
`900_000*5e9 + 2e14 = 4.5e15 + 2e14 = 4.7e15 = 0.0047 ETH` ✓.

⚠︎ **Two gas schedules exist today and must be classified (spec §4.6).** `KeeperPolicyV1` prices with
3.2M/50k/5gwei/0.05gwei/0.00002. `KeeperPolicyCalls` envelope enforces with a *looser* schedule
(6M MAX_GAS, 100k overhead, 50gwei, 0.1gwei, 0.00005 fee) and the BASE/PROCESS/RECONCILE/SHAPE/PRIZE
coefficients, then clamps to `min(cachedV1maxReward≈0.01645, HARD 0.311)`. The HARD cap and the 6M/50gwei
envelope never bind at V1 numbers, so they are the removable outer ceilings. Decision for the rework: the
**EconConfig is the single source**; the policy contract becomes the *algorithm* and receives the config
(or the V1 arithmetic is computed in-library from the config). Keep the per-operation coefficients in
EconConfig because the reserve/maintenance math (`KeeperPolicyCalls.reserve`/`maintenanceBudget`) needs them.
The outer clamp becomes `config.maxReward` only; retain one absolute anti-overflow bound (e.g. `maxReward <=
1 ether`, `maxGas <= block-safe`) documented as arithmetic safety.

---

## 3. Config / resolver / pin / bucket / hash design (◻︎ core rework)

Follows Part B §4 ("one factory config, optional local snapshot/override, one bucket, one resolver").

- **Factory** holds one authoritative `EconConfig _econConfig` (whole-struct validated `setEconConfig` by
  policyAdmin, O(1), immediate). Followers read it through the resolver — no iteration, no per-follower
  balance check.
- **Pool** stores: `enum Source {Follow, Local}` + `bool pinned`, an optional `EconConfig _localEcon`
  snapshot, the bucket (`capacity`, `refill`, `allowance`, `allowanceTime`), `bool paidEnabled`, and the
  policy address (inside the resolved config).
- **Resolver** `_effectiveEcon() → EconConfig`: `Follow` → `factory.econConfig()`; `Local`/pinned →
  `_localEcon`. Resolve **once per operation** and pass the struct through `quote`, `pay`, envelope `_bound`,
  `maintenanceBudget`/`reserve`, `restock` price and fallback, and previews. A single transaction never works
  under one config and pays under another (spec §6).
- **Pin** (`pinEconomics`): copy `factory.econConfig()` into `_localEcon`, `Source=Local`, `pinned=true`.
  Freezes the *complete* effective config (policy, envelope, restocking, fallback, bucket rates). A policy
  that re-reads mutable factory values would break pinning, so the policy must be pure-from-config.
- **Local override** (`setLocalEcon(EconConfig)`): validated whole-struct, `Source=Local`, `pinned=false`.
- **Resume follow** (`followFactory`): clear snapshot, `Source=Follow`. Adopts current factory config
  immediately (spec case 2).
- **Emergency disable** (`setPaidUpkeepEnabled(false)`): pool flag, survives every factory update; only
  creator re-enables (spec §2).
- **Local-transition funding**: pin / setLocal / followFactory / re-enable keep the **maintenance-funding**
  check (`maintenanceBudget`), NOT the full inventory reserve (spec §2, Part B §4). A fee change must not
  require funding a whole missing prize.
- **Underfunded follower**: factory update is O(1) and never inspects follower balances. At paid upkeep,
  `pay` pays only within `min(cash-creditProtected, bucket)`; shortfall is exposed via `policyFunding`-style
  view; unpaid maintenance/recovery/`performUpkeepUnpaid` stay usable (spec case 6).
- **Hash / identity** `settingsHash()` = `keccak256(abi.encode(effectiveEcon, SHAPES.mintFee(), paidEnabled))`.
  Changes when the live fee changes at the same policy address (fee is in the hash). A pinned pool's snapshot
  does not change on unrelated factory default updates, so its hash is stable except for genuine fee moves
  (spec §6). `performUpkeep(expected,…)` and creation bind to this hash and revert `StaleSettings` before any
  side effect; the keeper's `minimumFixed/minimumGas` floor is preserved.

### Bucket accrual rules (spec §5 — restore the bucket the reuse branch deleted)

`available(now)` = `min(capacity, allowance + (now-allowanceTime)*refill)`. On any creator bucket change,
`_syncBucket` first: `allowance = available(now)` (accrue elapsed at the **old** rate), `allowanceTime = now`,
then set new `capacity`/`refill`; if capacity decreased, clamp `allowance` down to new capacity. Raising
capacity does **not** instantly fill the new headroom (allowance unchanged). Switching policy / follow mode /
paid state / open-closed / creator ownership must not reset a depleted bucket; ownership transfer preserves
economics + disabled state. Test zero refill, capacity up/down, elapsed boundaries, rounding (spec case 11).

---

## 4. Other spec items — status and location

- **§3 remove delays** ◻︎: delete `POLICY_DELAY`, `pending`/`activationTime`/`generation` machinery and the
  propose/cancel/activate functions in `BalancerFactory` + `KeeperPolicyCalls` + `PoolBalancer`
  (`proposeKeeperPolicy`/`activateKeeperPolicy`/`pendingKeeperPolicy`/`policyActivationTime`). Replace with
  immediate `setKeeperPolicy` / `setDefaultKeeperPolicy` / immediate `setPaidUpkeepEnabled`. The reuse branch
  already did this shape (`setPolicy`/`enable`/`disable`) — reuse it, but KEEP the bucket (it removed it).
  Keep the two-step creator/keeperAdmin/policyAdmin ownership transfers. ⚠︎ Removing `generation` changes
  `settingsHash`; the new hash (§3) must still distinguish disable→re-enable cycles — include `paidEnabled`
  and resolved config so a re-enable after a fee move produces a distinct hash.
- **§7 accepted-cap binding** ◻︎: `configure(uint16 markup, uint256 target, uint256 acceptedCap)` — `require
  SHAPES.mintFee() <= acceptedCap`; set `mintFeeCap = acceptedCap`. Allows explicitly accepting a **lower**
  cap. App `App.tsx:946` must treat `d.mintFee !== d.mintFeeCap` (not only `>`) as a config change so a lower
  fee can be accepted without a mix/markup edit. ⚠︎ Blast radius: ~60 `.configure(` call sites in 32 (mostly
  fork) test files + TS (`app`, `keeper`, `scripts`, `shared/abi.ts`). Land with a repo-wide call-site update
  in the same commit or the tree will not compile.
- **§11 deploy reuse path** ◻︎: `Deploy.s.sol:49-52` unconditionally deploys renderer+packs. Add an explicit
  reuse branch gated on env (reuse addresses: shapes `0x6fE9…FAf0`, packs `0xfE11…cB2D`, renderer `0xA998…a65A`,
  FWA factory `0x8919…477C`, FWA impl `0x85Fa…Fee7`). Verify reused deps by code hash + getter readbacks
  (packs.shapes()==shapes, renderer, 0.02 ETH min, FWA compatibility) rather than minting new receipts. Update
  `scripts/verify-deployment.ts`, `current-local-rehearsal.ts`, `prepare-local-rehearsal.ts` and the keeper
  path so the manifest distinguishes NEW deployments from REUSED deps (not the old "eight deployments"
  assumption). Use a fresh fork where the reused addresses have code (current ForkBase block predates the
  packs).
- **§11/Part B §6 legacy factory** ◻︎: current mainnet factory
  `0x91C31Ad620555DE24e62290906aD1aA14C4CE281` (block 26475448, 0 pools at last check) becomes legacy. Add an
  automated preflight scan of its `BalancerCreated` events to the deploy tooling (record checked block +
  discovered pools; the old factory stays permissionless so re-scan at cutover). Keep an explicit old/new
  deployment config + a named **legacy PoolBalancer ABI** so app/keeper (Phase B) can still run
  upkeep/purchases/withdrawals on old pools. Fork acceptance case: create a pool on the OLD factory on a
  current-block fork, deploy the NEW factory, show the old pool still operates with the legacy ABI.
- **§9 CI** ◻︎: `.github/workflows/ci.yml` only runs `Fork.t.sol` + one FlowBreakdown case, and its markdown
  shortcut (`!filename.endsWith('.md')`) skips `OWNER-REQUIREMENTS.md` + acceptance/requirement changes. Fix:
  run the new acceptance suite + the affected regressions (`Settings`, `Reserve`, `PolicyLifecycle`,
  `PolicyPreview`, `PolicyModelParity`, `ParityFixture`, `GasBench`) + TS tests; and force full checks when
  `OWNER-REQUIREMENTS.md`, `test/CommunityConfigAcceptance.t.sol`, `foundry.toml`, deploy inputs or the
  workflow itself change (don't rely on the `.md` shortcut for protected requirements).

---

## 5. Acceptance suite mapping (spec §9 cases 1–15 + legacy) → test → CI command (◻︎ to build)

One suite `test/CommunityConfigAcceptance.t.sol` on real dependency fork fixtures (no FWA/Shapes/Packs mocks;
test policy implementations allowed). Run: `forge test --match-path test/CommunityConfigAcceptance.t.sol`.

| # | Requirement | Test name (planned) |
|---|---|---|
| 1 | 2 followers + 1 pinned; factory econ change → followers update, pinned frozen | `test_followersUpdate_pinnedFrozen` |
| 2 | change defaults while pinned, then resume follow → adopts latest | `test_resumeFollowAdoptsLatest` |
| 3 | fee change at same policy addr → hashes/previews/payments update | `test_feeChangeMovesHashAndPayments` |
| 4 | disable survives factory change; re-enable + local policy change w/o time | `test_disableSurvives_reenableImmediate` |
| 5 | unauthorized settings changes revert | `test_unauthorizedReverts` |
| 6 | underfunded follower doesn't block factory update; budget/cash respected; unpaid paths usable | `test_underfundedFollower` |
| 7 | adjust prize max, markup range, fill threshold, backlog threshold → behavior changes; existing design preserved after lowering | `test_productLimitsTakeEffect` |
| 8 | raise/lower econ across former hardcoded limits → new values take effect, not clamped | `test_formerCeilingsDontClamp` |
| 9 | quote, payment, reserve, restock, fallback agree for one effective config | `test_onePathOneConfig` |
| 10 | stale creation + upkeep expectations fail before side effects | `test_staleHashReverts` |
| 11 | bucket preserves accrued+spent; policy change/capacity raise can't refill | `test_bucketAccrual` |
| 12 | mint fee 0.001↔0.0005 with existing inventory; UI accepts lower cap w/o edit | `test_mintFeeChangeExactPayments` (impersonate real Shapes admin on fork) |
| 13 | shapes-only (`curatedRequired=false`), curated, creator credit, unpaid recovery | `test_shapesOnlyAndRecovery` |
| 14 | work bounded; repeated/empty calls can't duplicate rewards | `test_noDuplicateRewards` |
| 15 | full lifecycle: create→fund→purchase→process→restock→econ update→close→recover→withdraw | `test_localLifecycle` |
| L | old-factory pool still operable after cutover (legacy ABI) | `test_legacyPoolRemainsOperable` |

Case 12 changes the Shapes mint fee 0.001→0.0005 and back via the real Shapes contract's supported admin
(impersonate on fork only; never touch mainnet) and asserts exact mint payments, new listing prices, reserve
changes and unchanged OLD listing prices.
