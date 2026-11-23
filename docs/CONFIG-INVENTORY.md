# Community release — configuration inventory and economics design

Status: 2026-11-23, updated by slice A3 (keeper economics). Authoritative inventory for the community pool release
(spec `community-release-spec.md`, Part B overrides Part A). This is deliverable #2/#6 of the spec.
Slice A3 implemented §1d, §2 and §3 below; the "as built" section (§0) is current and supersedes the ◻︎ design text
kept further down as history.

This document separates **what is implemented on `claude/community-release`** from **what is designed and
remains to be implemented**, because the full keeper-economics rework is a large, fork-verified change that
one implementation pass cannot land and verify to mainnet-candidate quality. Each row/section is marked.

Legend: ✅ implemented + compiles · ◻︎ designed, not yet implemented · ⚠︎ decision/risk.

---

## 0. Keeper economics as built (slice A3) ✅

### 0a. `IKeeperPolicy.Economics` (one struct; factory default, pool local or pinned copy)

Set whole by `BalancerFactory.setEconomics(Economics)` (policyAdmin, immediate, O(1), `EconomicsChanged(e)`), or per
pool by `setLocalEconomics(e)` (creator). Getters: `factory.economics()`, `pool.effectiveEconomics()`,
`pool.economicsSource()`. Field widths are the only numeric bounds (they keep every product far below uint256 and
every surcharge < 2^98, inside a listing's uint104 price record); only `policy` is validated (code +
`interfaceVersion() == 3`).

| Field | Type | Initial | Was | Meaning / consumers |
|---|---|---|---|---|
| `policy` | address | KeeperPolicyV1 (ctor arg) | per-pool snapshot of `defaultKeeperPolicy` | pricing algorithm; receives the struct with every quote (`quoteReward(w, e)`, `quoteRestock(d, units, baseFee, e)`) |
| `workFee` | uint64 wei | 0.00002 ETH | V1 constant; envelope 0.00005 | per processed stuck draw, per reconciled draw sequence and per listed Shape unit |
| `maxGas` | uint32 | 3,200,000 | V1 constant; envelope 6M | reimbursable measured gas per call; caps the operation bounds |
| `overheadGas` | uint32 | **60,000** (recalibrated) | V1 50k; envelope 100k | gas outside the measured span |
| `gasPriceCeiling` | uint64 wei | 5 gwei | V1; envelope 50 gwei | reimbursed price cap |
| `priorityAllowance` | uint64 wei | 0.05 gwei | V1; envelope 0.1 gwei | reimbursed price = min(basefee + allowance, ceiling, tx gas price) |
| `restockGas` | uint32 | **910,000** (recalibrated) | V1 900k | surcharge gas per Shape; also the fallback schedule |
| `restockFlat` | uint64 wei | 0.0002 ETH | V1 | surcharge flat per Shape; also the fallback |
| `baseGas` / `processGas` / `reconcileGas` / `shapeGas` / `prizeGas` | uint32 | 200k / 1.8M / 150k / 700k / 150k | library constants | per-operation gas bounds: paid gas = min(measured, Σ bounds, maxGas); maintenance and reserve budgets |
| `processGraceBlocks` | uint16 blocks | 50 (~10 min) | new 2026-11-23 | upkeep processes a Ready draw only once `block.number >= requestBlock + grace` (FWA stores no fulfillment time) |
| `pausedProcessGraceBlocks` | uint16 blocks | 10 (~2 min) | new 2026-11-23 | the same while `admissionStatus()` is BUSY or LOW_INVENTORY |

Derived, not stored (getters on the pool, from the effective economics):
- maximum keeper payment `policyMaxReward() = (maxGas + overheadGas) * gasPriceCeiling + 10 * workFee` = **0.0165 ETH**
  (V1 at 50k: 0.01645, asserted in `test/KeeperEconomics.t.sol`). 10 = MAX_RECONCILE + MAX_OPS.
- maximum restocking surcharge `maxRestockSurchargePerShape() = restockGas * gasPriceCeiling + restockFlat` =
  **0.00475 ETH** (V1 at 900k: 0.0047). A policy quote above `units *` this is refused (paid) or replaced by the fallback.
- fallback restocking price = the same schedule at the current basefee (explicit, bounded, from the selected economics).

Removed (no longer exist anywhere): `HARD_MAX_REWARD` 0.311 ETH, `MAX_RESTOCK_SURCHARGE` 0.102 ETH, the 50 gwei /
0.1 gwei / 6M / 100k / 0.00005 ETH enforcement schedule, the fallback literals, `IKeeperPolicy.maxReward()`, the
per-pool `maxReward` snapshot, `policyFunding(address)`, `hardMaxKeeperReward()`, `setDefaultKeeperPolicy`,
`DefaultPolicyChanged`/`KeeperPolicyChanged`. One schedule enforces and prices; a different algorithm can only charge
within it, and the owner raises the schedule by setter, never by redeploy.

Recalibrations (fresh measurement, `docs/GAS.md` "Slice A3"): `overheadGas` 50k → 60k because isolated receipts at
5 gwei billed up to 56,724 gas outside the measured span; `restockGas` 900k → 910k because at 60k overhead the
single-Shape reconcile-and-replace call's pay (874,586 + 60,000 gas + two work fees) needs ≥ 902,586 for the
surcharge to cover it at the ceiling (V1's 7,414-gas margin kept).

### 0b. Per-pool keeper state (creator authority, all immediate)

| Setting | Getter | Setter | Initial | Rules |
|---|---|---|---|---|
| source | `economicsSource()` 0 follow / 1 local / 2 pinned | `followFactoryEconomics()`, `setLocalEconomics(e)`, `pinEconomics()`, `setKeeperPolicy(p)` (= local with the effective numbers and `p`) | 0 follow | pin copies the complete effective struct; follow resumes with the latest factory struct |
| paid upkeep | `paidUpkeepEnabled()` | `setPaidUpkeepEnabled(bool)` | true | only this setter re-enables; no source/policy change or factory update touches it |
| bucket capacity / refill | `keeperBucketCapacity()`, `keeperBucketRefill()`, `availableKeeperAllowance()`, `keeperAllowance()`, `keeperAllowanceTime()` | `setKeeperBucket(uint128 capacity, uint96 refillPerSecond)` | factory defaults at creation: 0.622 ETH, floor(0.05 ETH / 12) = 4,166,666,666,666,666 wei/s | accrue at old rate, keep spent, clamp on decrease, no fill on increase, new rate from now; zero refill allowed; nothing else resets it |
| generation | `policyGeneration()` | advances on every source, economics or paid-state change | 0 | part of `settingsHash` |

Factory bucket defaults: `defaultBucketCapacity()`, `defaultBucketRefill()`, `setDefaultBucket(capacity, refill)`
(policyAdmin, new pools only).

### 0c. Resolver, hash, funding

- Resolver `_econ()`: follow → `factory.economics()`, else the pool's copy. `_performUpkeep` resolves once and passes
  the struct to the hash check, `PoolInventory.fill` (listing payment bounds + restocking price) and
  `KeeperPolicyCalls.pay` (policy quote + envelope + bucket). Views (`requiredReserve`, `quoteKeeperReward`,
  `restockFee*`, `maintenanceFunding`) resolve once each. Paid upkeep off = zero economics in the reserve.
- `settingsHash() = keccak256(abi.encode(economics, source, generation, paidEnabled, SHAPES.mintFee()))`. Moves on any
  factory change for followers, on any local change, on the live mint fee; a pinned or local pool's does not move on
  factory updates. `performUpkeep(expected, …)` checks it before any work; creation requires
  `CreationConfig.settingsHash == factory.creationSettingsHash()` before the clone is deployed.
- `creationSettingsHash() = keccak256(abi.encode(newPoolSettingsHash, defaultBucketCapacity, defaultBucketRefill))`,
  so a `setDefaultBucket` after the creator's review also refuses creation (review S3, 2026-11-23). The pool's own
  `settingsHash` leaves the bucket out: it is the creator's spending limit, not economics a keeper prices.
- Funding: local transitions (local, pin, follow, policy switch, re-enable) need `maintenanceBudget(next)` in operating
  cash only when it exceeds the current paid exposure (zero while stopped); never missing inventory. Factory updates
  check nothing per pool; `maintenanceFunding(e)` exposes `(required, shortfall)`, and a short follower's paid
  upkeep reverts `PaymentUnavailable` beyond cash or bucket while unpaid upkeep, claims and recovery stay usable.
- Mint fee cap: `configure`/creation reject an accepted fee above `type(uint96).max` (reserve and uint104 price safety).

### 0d. Remaining immutable technical limits (not business preferences)

| Limit | Value | Why |
|---|---|---|
| policy call gas | 100,000 | bounds an untrusted static call |
| policy returndata | 32 bytes | returndata-bomb bound |
| service units per call | 10 | MAX_RECONCILE + MAX_OPS; derives the maximum payment |
| field widths | see §0a | arithmetic and price-record safety |
| work per call | 5 / 4 / 2 / 5 / 20 | §1c, unchanged |

---

## 1. Configuration inventory

Every economic or product value in the production contracts, its authority, scope, getter, update path,
initial value, bounds, derived values and consumers. "Consumers" lists on-chain + off-chain readers.

### 1a. Creator pool settings (per `PoolBalancer` clone)

| Setting | Status | Authority | Getter | Update path | Initial | Bounds | Consumers |
|---|---|---|---|---|---|---|---|
| `markupBps` | ✅ A2 | creator | `markupBps()` | `configure(markup,target,acceptedMintFee)` | creation | factory `productLimits` min..max, or unchanged (§1b rule) | FWA listing price (`_prizeBase`), app sliders/preview |
| `target` | ✅ A2 | creator | `target()` | `configure` | creation | prizes 1..`max(current count, maxPrizes)` (§1b rule) | fill gate, reserve, `fill`, app |
| `mintFeeCap` (accepted fee) | ✅ A2 binding | creator | `mintFeeCap()` | `configure(..., acceptedMintFee)`: reverts if live fee > accepted; lower accepted fee allowed with the same design | creation `CreationConfig.mintFeeCap` | `>= live fee` at save | upkeep mint gate (mints at live fee while live <= cap), reserve (priced at cap), app "accept fee" when live != cap |
| `creatorRevenueBps` | existing | creator | `creatorRevenueBps()` | `setCreatorRevenueBps` | creation | `<= 10000` | `_collect` credit split |
| `curatedRequired` | existing | creator | `curatedRequired()` | `setCuratedRequired` | creation | bool | admission (status 3/7), app |
| **`fillGateBps`** | ✅ | creator | `fillGateBps()` | `setFillGateBps` | **7000** | `0..10000` (0 drops target-fill req, keeps `prizeWeight<lost` check) | `PoolInventory.admission`, app Settings "Purchase pauses" + Design pause preview |
| **`backlogThreshold`** | ✅ | creator | `backlogThreshold()` | `setBacklogThreshold` | **5 (=MAX_BATCH)** | `>= 1`; no factory max this release | `PoolInventory.admission` (status 4), app Settings "Purchase pauses" |
| `fillGateBps`/`backlog` at creation | ◻︎ Phase B | creator | — | add to `CreationConfig` + app creation flow | defaults above | — | creation UI |
| bucket capacity | ✅ A3 | creator | `keeperBucketCapacity()` | `setKeeperBucket(capacity, refill)` | factory default 0.622 ETH | uint128; see §0b | `pay`/`available` |
| bucket refill/s | ✅ A3 | creator | `keeperBucketRefill()` | `setKeeperBucket` | factory default `floor(0.05 ether/12)` | uint96 (0 = no refill) | `pay`/`available` |
| follow vs local | ✅ A3 | creator | `economicsSource()` | `followFactoryEconomics()` / `setLocalEconomics(e)` / `pinEconomics()` | follow | — | resolver §0c |
| paid upkeep enabled | ✅ A2 immediate | creator | `paidUpkeepEnabled()`, `policyGeneration()` | `setPaidUpkeepEnabled(bool)`; re-enable checks maintenance budget vs zero paid exposure | true | bool; stop survives factory updates and creator transfer; only the creator re-enables | `_performUpkeep`, `settingsHash` |
| keeper policy (algorithm) | ✅ A3 | creator | `keeperPolicy()` (effective), `policyMaxReward()` (derived) | `setKeeperPolicy(address)`: local economics with the effective numbers and this algorithm; funding check on larger maintenance exposure only; **no longer enables paid upkeep** (A3 fix) | follows the factory | `KeeperPolicyCalls.validate` | quote/pay/restock |
| former library value getters | ✅ A3 | — (views) | `keeperBucketCapacity()`/`keeperBucketRefill()` now the pool's own bucket; `maxRestockSurchargePerShape()` derived from effective economics (0.00475); `hardMaxKeeperReward()` **removed** (no outer ceiling); `policyMaxReward()` derived (0.0165) | — | — | — | `keeper/e2e.ts` reads `policyMaxReward` |

### 1b. Factory settings (`BalancerFactory`, `policyAdmin` unless noted)

| Setting | Status | Authority | Getter | Update path | Initial | Bounds | Consumers |
|---|---|---|---|---|---|---|---|
| `defaultKeeperPolicy` | ✅ A3: field of `economics()` | policyAdmin | `defaultKeeperPolicy()` (= `economics().policy`) | `setEconomics` (A2's `setDefaultKeeperPolicy` removed) | ctor arg | `validate` | every follower, immediately |
| `maxPrizes` | ✅ A2 | policyAdmin | `productLimits().maxPrizes` | `setProductLimits(maxPrizes,min,max)` (immediate, `ProductLimitsChanged`) | **1000** | `1..65535` (uint16 width) | `validateTarget` at creation/configure only |
| `minMarkupBps` | ✅ A2 | policyAdmin | `productLimits().minMarkupBps` | `setProductLimits` | **1000** | `1..maxMarkupBps` (0 marks an unconfigured pool) | `validateTarget` |
| `maxMarkupBps` | ✅ A2 | policyAdmin | `productLimits().maxMarkupBps` | `setProductLimits` | **10000** | `minMarkupBps..65535` (uint16 width) | `validateTarget` |

**Rule for designs above a lowered limit (A2, tested in `test/ProductLimits.t.sol`):** a newly submitted design may
have at most `max(current target prize count, maxPrizes)` Shape/Draw Pack prizes, and may keep the pool's current
markup even if it is now outside the range; any other markup must be in range. So a creator can keep, shrink or
re-save (e.g. to accept a mint fee) an existing design, but cannot grow past `max(current, maxPrizes)`; once the
markup is changed the old out-of-range value is no longer "current". Creation always uses the current limits.
Upkeep, recovery, withdrawals and existing listing prices never consult the limits.
| factory **Economics** (whole struct) | ✅ A3 | policyAdmin | `economics()` | `setEconomics(e)` (policy validated; widths bound numbers) | §0a | §0a | resolver §0c → every money path |
| factory bucket defaults | ✅ A3 | policyAdmin | `defaultBucketCapacity()`, `defaultBucketRefill()` | `setDefaultBucket` | 0.622 ETH, floor(0.05 ETH/12) | uint128 / uint96 | new pools only |
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
| stuck draws processed per call (`KeeperPolicyCalls.stuck`, was `MAX_PROCESS`) | 2 | `PROCESS_STARVED_GAS` (400k) griefing bound was derived for 2 processed draws + FWA's 6-listing reservations (~3.3M). Changing it invalidates the starvation proof. Only stuck draws (Ready, or expired without randomness) past the processing grace count (owner decision 2026-11-23). |
| `MAX_RECONCILE` | 5 | one FWA batch (~33k each); keeps worst upkeep under the pay cap. |
| curated batch | 20 | bounds the 100k-gas purchase-hook witness scan and `listNFTs` gas. |
| `MAX_BATCH` | 5 | FWA `maxAcquisitionsPerTx`, verified against the FWA factory at creation. Protocol identity, not tunable. |

### 1d. Immutable monetary ceilings to REMOVE (spec §4.6) — ✅ removed in A3, see §0a

| Current literal | Where | Replacement |
|---|---|---|
| `HARD_MAX_REWARD = 0.311 ether` | `KeeperPolicyCalls` `_bound`/`validate` | derived `maxReward = (maxGas+overhead)*ceiling + 10*workFee` (0.01645 at V1) in EconConfig; keep only an absolute anti-overflow sanity bound |
| `units * 0.102 ether` restock-quote cap | `KeeperPolicyCalls.restock` | derived `maxRestockSurcharge = restockGas*ceiling + restockFlat` (0.0047/shape at V1) in EconConfig |
| `50 gwei` ceiling, `0.1 gwei` priority, `0.00005` fee (envelope) | `KeeperPolicyCalls` | EconConfig fields; reconcile with the V1 pricing numbers (see §2 ⚠︎) |
| V1 fallback `900k / 0.0002 / 5 gwei` literals | `KeeperPolicyCalls.restock` fallback | EconConfig fallback fields |

---

## 2. EconConfig initial values (A1 design, history; as built in §0a with 60k overhead and 910k restocking gas)

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
bucketCapacity=0.622 ether  bucketRefill=floor(0.05 ether/12)=4_166_666_666_666_666 wei/s
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

## 3. Config / resolver / pin / bucket / hash design (A1 design, history; as built in §0b-§0c)

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

- **§3 remove delays** ✅ A2: `POLICY_DELAY`, `pending`/`activationTime` and the propose/cancel/activate
  functions are gone from `BalancerFactory`, `KeeperPolicyCalls` and `PoolBalancer` (no `2 days` literal
  remains). Immediate `setDefaultKeeperPolicy`, `setKeeperPolicy`, `setPaidUpkeepEnabled(true)`. The bucket is
  KEPT unchanged and `generation` is KEPT (advances on every policy/paid change) so a disable→re-enable cycle
  changes `settingsHash`; A3's new hash must keep that property. Two-step creator/keeperAdmin/policyAdmin
  transfers are unchanged. App Keeper pay panel: immediate "Use this policy" and "Enable paid upkeep".
- **§7 accepted-cap binding** ✅ A2: `configure(uint16 markup, uint256 target, uint256 acceptedMintFee)` reverts
  `InvalidConfig` when `SHAPES.mintFee() > acceptedMintFee` and sets `mintFeeCap = acceptedMintFee`; a lower cap
  can be accepted with the same design. `App.tsx` offers the save when `d.mintFee !== d.mintFeeCap` ("accept the
  X ETH Shapes mint fee" when only the fee differs) and passes the shown fee. All call sites updated (Solidity
  tests, `keeper/rehearsal.ts`, `scripts/run-local-rehearsal.ts`, `scripts/approved-local-rehearsal.ts`,
  `shared/abi.ts`). Fork test `test/MintFeeChange.t.sol` (0.001 → 0.0005 → 0.001 via the real Shapes admin).
- **§11 deploy reuse path** ✅ `Deploy.s.sol` `REUSE_DEPENDENCIES=true` (required on chain 1) reuses Shapes, Draw
  Packs, renderer, FWA factory and FWA implementation, checked by code hash and getter readbacks before and after the
  broadcast; it creates only changed CREATE2 libraries, PoolBalancer, the interface-2 KeeperPolicyV1 and
  BalancerFactory. `_postflight` and `scripts/verify-deployment.ts` read back every §0 initial setting
  (`economics()`, default bucket, `productLimits()`, `creationSettingsHash()`, policy `interfaceVersion() == 3`).
  The verified record separates `transactions` (receipts), `preexistingLibraries` and `reusedDependencies` (no
  receipts); `prepare-local-rehearsal.ts` and `current-local-rehearsal.ts` accept the reuse plan. Fork rehearsal at
  block 26,480,077 and the unsigned runbook: `docs/DEPLOY-COMMUNITY-REPLACEMENT.md`. The keeper integration scripts
  (`keeper/e2e.ts`, `keeper/rehearsal.ts`) keep the full mode on their pre-Packs fork block, as the spec allows.
- **§11/Part B §6 legacy factory** ✅ `deployments/1.legacy.json` lists the 2026-11-22 factory `0x91C3…E281`
  (block 26475448) with its `community-v1` ABIs (byte-identical to `shared/abi.ts` at `40ad9dd`) and the superseded
  `0xA57d…7ece`. `scripts/deployment-preflight.ts` scans their `BalancerCreated` logs to a pinned block, checks each
  legacy ABI's selectors against the deployed code and records the block and pools in `deployments/1.preflight.json`
  (mainnet 26,479,663: 0 pools). Rerun at cutover (runbook steps 3 and 9). App/keeper consumption of the legacy
  route is Phase B. The permanent fork acceptance case (§5 row L) is ◻︎ with the acceptance suite.
- **§9 CI** ✅ (`afbd981`): CI runs the acceptance suite, the regressions below, `test:ts` and `build:app`, and the
  markdown shortcut no longer skips protected requirement docs, tests, scripts, deployments or the workflow.
  `test/CommunityConfigAcceptance.t.sol` is not on this branch yet, so that CI step fails until it lands. History:
  `.github/workflows/ci.yml` only ran `Fork.t.sol` + one FlowBreakdown case, and its markdown
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
