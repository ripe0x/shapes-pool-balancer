# Simplification review of `e36e9ba` (branch `launch-audit-triage` at `59afb42`)

Setup: `git submodule update --init --recursive` (lib/ was empty; forge-std, solady, shape-packs and its nested shapes and
openzeppelin). Toolchain: forge 1.5.1-stable (no version pinned in the repository). Baseline on the unmodified branch:
`forge build --sizes` PoolBalancer 21,315 B, BalancerFactory 2,117 B; flow breakdown 22/22 passed (230 s), receipts kept
as the comparison copy. Every cut was made in a scratch copy and reverted; nothing here is applied.

How the contract cuts were proven. Bytes: each cut alone on the baseline (`forge build src/PoolBalancer.sol
src/BalancerFactory.sol --sizes`). Behaviour: two stacked patches, each with its covering test files run one at a time,
then the flow breakdown (`--gas-limit 100000000000`), facts compared one by one with the baseline copy and every
`asset-flow.json` outcome evaluated in the regimes it names.
- Patch A (C1 C2 C3 C4 C5 C6 C8 F1; 21,315 → 20,512 B, factory 2,117 → 1,898 B): Balancer 29/29, Hardening 13/13,
  HostileCollection 6/6, KeeperList 3/3, Reserve 14/14, Packs 9/9, Parity 1/1, Fork 9/9, KeeperPay 7/8 (the one failure
  also fails on the unmodified branch, see last line). Flow 22/22; 1,463 of 1,507 facts identical; the other 44 are
  `keeper_gas_cost_wei` and `keeper_profit_wei` in every regime: the keeper's transaction is ~44 gas cheaper per call
  (shorter selector dispatch, outside the measured span); every reward, payment and balance is identical.
- Patch B on top (C9 C10 C11; 20,150 B with a `prizeWeight()` view kept for the tests): ProcessQueue 1/1, Gas 23/23,
  KeeperAdversarial 8/8, Fork 9/9, Balancer 29/29, Reserve 14/14, KeeperPay 7/8 (same pre-existing failure), Invariant: all
  7 invariants pass at 64 runs x 64 calls (two runs plus one rerun; the other attempts died on Tenderly 429s at setup). Flow 22/22, all 13 outcomes pass in every named regime (as on the baseline). 204 facts move, all gas-driven: keeper
  pay falls by the gas no longer spent (≈6.6k gas per paid upkeep in the launch-board regimes, 1.4k to 25.8k across
  regimes), keeper cost falls by the same, `keeper_loss_wei` stays 0, every creator figure improves (creator_net_gain up
  in 18 regimes, 7 creator loss facts lower). No count changes (draws, refusals, unsettled, prizes missing, reconciles).
- Test changes the cuts needed: a one-line test shim for C6 (`listCurated` → batch of one); four
  `expectRevert(InvalidItem)` before `recoverRefunded` became FWA's `DeliveryNotRefunded` for C3 (over-specified: the
  requirement, no recovery before the player's refund, still holds); `balancerCount()` assertion replaced for F1
  (over-specified: a view nothing reads).

## Findings, most payoff first

`path:line | cut | replace with | saves (lines, runtime bytes, gas per call) | checked or reasoned | risk`

1. `src/PoolBalancer.sol:229,750,760` (C10) | `ShapesMinted` event | nothing: `ShapeListed` (listing id, size, token id, price) and the Shapes/Packs mint events in the same transaction carry it; no keeper, app, script or test reads it | 3 lines, 259 B alone (276 B on top of A), one LOG3 per restocked size (part of B's ≈6.6k/upkeep) | checked (size; patch B tests + flow) | low: indexers lose a convenience event
2. `src/PoolBalancer.sol:302-304` (C1) | `poolImplementation(p)` and `owner()` re-checks after `createPool` | nothing: FWA's `createPool(salt, expected)` reverts unless its implementation is `expected`, records exactly that, and initializes the pool with the caller as owner (PoolFactory.sol:384-413, not upgradeable); the code comment on line 300 already says so | 3 lines, 242 B, 2 external calls per createBalancer (part of −4.8k) | checked (patch A) | low
3. `src/PoolBalancer.sol:391-402` (C6) | `listCurated` | `listCuratedBatch` with one entry (the app already uses only the batch) | 12 lines, 203 B, creator pays the array encoding on single listings | checked (patch A with a test shim; `script/DevSetup.s.sol:43` and `keeper/rehearsal.ts:210` need the same one-line change) | low
4. `src/BalancerFactory.sol:15,80,89-91` (F1) | `allBalancers` array and `balancerCount()` | nothing: keeper and app enumerate from `BalancerCreated`; `isBalancer` stays as the on-chain provenance check | 6 lines, 219 B (factory), ≈44.5k gas per createBalancer (createBalancer median 854,043 → 804,693 with C1/C2/C8) | checked (patch A) | low
5. `src/PoolBalancer.sol:192,600,682,704,773-783,941-946` (C11) | `prizeWeight` storage, kept in step on every reconcile, restock and unlist | derive it in `_listedShapes()`, which `admissionStatus` already calls: `activeShapes` is one slot, so the gate pays ~16 multiply-adds instead of upkeep paying a cold SLOAD + SSTORE | 5 lines, 36 B (a public `prizeWeight()` view kept for tests costs 67 B, net +31 B), ≈5k gas per upkeep that reconciles a Shape or restocks; moves ~1k gas into `canPurchase` (inside FWA's 100k stipend; Gas.t 23/23, all buys in the flow succeed) | checked (patch B, prizeWeight view kept) | low; tests reading `prizeWeight()` need the view or a local sum
6. `src/PoolBalancer.sol:511-522,692-712` (C5) | separate pre-check loop in `unlistShapes` and the single-caller `_withdrawAndRedeem` | one loop: kind check inline, `_removeActive` first (it already reverts `InvalidItem` for anything not active) | 7 lines, 129 B, ≈9.8k gas on a 20-prize unlist | checked (patch A; flow closeout regimes unchanged) | low: `_collect` now runs before the kind check, which only matters on a call that reverts anyway
7. `src/PoolBalancer.sol:156,271,297` (C2) | `FWA_IMPLEMENTATION_CODEHASH` immutable and the per-clone EXTCODEHASH | check `fwaImplementation.codehash == fwaCodehash` once in the constructor (post-Cancun the implementation's code cannot change; the factory clones one implementation) | 2 lines, 113 B, part of initialize's −4.8k | checked (patch A) | low: getter disappears (nothing reads it)
8. `src/PoolBalancer.sol:659` (C9) | `!p.retired()` in upkeep's restock condition | nothing: `enabled` implies not retired (only `retire()` retires the pool and it requires closed; `open()` calls FWA `setBool`, which reverts once retired, StandardPool.sol:2001) | 0 lines, 108 B alone but +134 B on top of A (via-IR layout noise; count it for gas only), ≈2.2k gas per restocking upkeep (cold `retired` read in the pool) | checked (patch B) | low
9. `src/PoolBalancer.sol:442` (C4) | `it.state != ACTIVE` in `withdrawCurated` | `kind != CURATED` only: `_removeActive` reverts `InvalidItem` for any non-active listing | 0 lines, 29 B | checked (patch A) | low
10. `src/PoolBalancer.sol:217,310` (C8) | `Initialized` event | nothing: the factory's `BalancerCreated(creator, balancer, pool, salt)` is emitted in the same transaction, the only path to `initialize` | 2 lines, 26 B, ~1.5k gas per createBalancer (reasoned) | checked (patch A) | low
11. `src/PoolBalancer.sol:132,457-458` (C3) | `status != L_DELIVERY_REFUNDED` check in `recoverRefunded` | nothing: FWA's `recoverRefundedNFT` reverts `DeliveryNotRefunded` (StandardPool.sol:1771) | 2 lines, 22 B | checked (patch A; 4 error-selector expectations updated, over-specified) | low: the app shows FWA's error name instead of "not available"
12. `keeper/keeper.ts:37,94,102,220-261,304-311` | `Fn` type and `fn`/`args` threaded through `attempt`, `send`, `Pending`, `AuditEntry` for the one argument-less function | call `performUpkeep` directly | 10 lines net (46 touched) | checked (`npx tsc --noEmit`, `npx vitest run` 53/53; e2e's audit row drops `fn`) | none (old state files with extra fields load fine)
13. `keeper/keeper.ts:21-22,52-55` | keeper's own copies of KEEPER_MAX_GAS, overhead, incentive, gas-price cap and priority cap | import them from `shared/planner.ts:12-16` (keeper already imports `shared/abi`) | 6 lines, one source for the TS side | checked (same run) | none
14. `keeper/keeper.ts:17,394` | `GWEI` constant and export | delete: unused in keeper.ts; tests and rehearsal define their own | 2 lines | checked (same run) | none
15. `keeper/keeper.ts:94,306` | optional `estimate` and the `gas * 10/13` fallback | make `estimate` required: `attempt` always records it, and no keeper state predates it on mainnet | 0 lines, one branch | checked (same run) | none
16. `shared/planner.ts:73-81` | `GAS` table | delete: nothing imports it | 9 lines | checked (tsc, vitest 53/53, `vite build` ok) | none
17. `shared/planner.ts:20-21` | `rewardBound` | delete: nothing imports it | 2 lines | checked (same) | none
18. `shared/design.ts:101` | `describe`, an alias of `evaluate` (and a name that collides with vitest's) | import `evaluate` from planner in App.tsx, HowItWorks.tsx, design.test.ts | 2 lines | checked (same) | none
19. `shared/design.ts:40` | `shapeTotal`, a copy of `planner.shapeCount` | `shapeCount` | 1 line | checked (same) | none
20. `app/src/App.tsx:532,565,723,1006,1086,1095,1166,1170,1397` | `&& l.state === 1` on `d.listings` | drop: `d.listings` is built from `getActiveIds()`, so every entry is active | 9 conditions | reasoned | none
21. `app/src/App.tsx:564-565,1094-1095,1169-1170` | `livePrices` rebuilt in three components | build once in `useBalancer` and return it with the data | ~4 lines | reasoned | none

Total if all contract cuts land: PoolBalancer 21,315 → 20,150 B (−1,165 B, margin 3,261 → 4,426 B); BalancerFactory
−219 B; createBalancer ≈ −49k gas; paid upkeep ≈ −6.6k gas (creator pays keepers less, keepers' margin unchanged).

## Needs owner decision

- `src/PoolBalancer.sol:203-204,916-939` | `activeIds` array + `activeIndexPlusOne` map, used on chain only for their
  length and as an "is active" flag that `Item.state` already holds | an active-listing counter; the app (`App.tsx:73`)
  and `keeper/rehearsal.ts` enumerate via `getActiveIds()`, so they would read FWA's listings or events instead | ≈40k
  gas per listed prize (two new slots) and the swap-and-pop on every draw, ~60 lines across contract and app | reasoned,
  not run | moves every keeper-pay fact and the storage refunds behind O1 (D19); changes what the dashboard can read.
- `src/PoolBalancer.sol:493-495` | `collectProceeds()` | nothing: upkeep and `claimSurplus` collect | ~40 B | reasoned |
  changes who can trigger collection while upkeep is restricted (today anyone; after, the creator and approved keepers).

## Not worth it

- `denominationAmount` view (`PoolBalancer.sol:859`, 42 B): the flow harness and four test files read it.
- `nonReentrant` on functions with no external call (`transferCreator`, `acceptCreator`, `revokePoolPages`): guards stay.
- `ProtectedAsset` checks for the pool and FWA factory in `recoverUntrackedNFT`: `ownerOf` would revert there today, but this is the trust boundary.
- `depositETH` vs `receive`: the app reads `Deposited`; `receive` must stay event-free for Shapes/Packs/FWA payouts.
- `Item.state` (derivable from `activeIndexPlusOne`) and `Item.base` for Shape prizes (only read for curated): same packed slot, deriving costs an SLOAD.
- `targetWeight` (derivable from `target`): written only by `configure`; caching keeps `canPurchase` cheap under FWA's 100k stipend.
- `close()`'s `!pool.retired()` guard: removing it makes `close` revert after `retire` instead of no-op; nothing saved.
- `_rewardBound` (one caller) and `MAX_KEEPER_REWARD` repeating its formula: the optimizer inlines it; a constant cannot call a function.
- `isBalancer` (nothing reads it): the only on-chain provenance check, 1 SSTORE.
- App `liveRestockFee` re-deriving `restockFee()`: NewPool has no Balancer to ask yet, and the block is already fetched.
- Other events nothing reads (`Configured`, `PurchasesOpened`, `CuratedRepriced`, ...): one per creator action, the audit trail.
- `test/scenario/FlowBreakdown.t.sol` (1,515 lines): its re-derivations (`_shapesIn`, `_missingUnits`) are deliberate independence; 230 s is fine.

## Things that don't make sense

- `src/PoolBalancer.sol:846`: `items()` returns `uint112 base, uint112 price`; storage is `uint104`.
- `src/PoolBalancer.sol:975-976`: `_prizeBase`'s doc line ("A Shape prize's price before restocking fees") sits above `_weight`.
- `keeper/keeper.ts:98`: `State.pending` is documented as "Shape listing ids whose FWA delivery failed"; it holds in-flight upkeep transactions.
- `shared/planner.ts:265`: `900_000n` literal next to the exported `RESTOCK_FEE_GAS`.
- `app/src/App.tsx:121`: `ERRORS` maps `WithdrawLocked`, an FWA error, alongside PoolBalancer's; fine, but undocumented.
- `cd keeper && npm test` (in the review brief) does not exist: keeper/ has no package.json and the root has `test:ts`; used `npx vitest run` and `npx tsc --noEmit`.
- Evidence depends on an unpinned Foundry (`.github/workflows/ci.yml:10`, `foundry-toolchain@v1`): on forge 1.5.1 the unmodified branch reports `keeper_refund_gas_kept_per_draw = 0` in every regime (DECISIONS 83 records 31,105 at the cap), so O1 is not exercised here, and `test/KeeperPay.t.sol:121` fails.

Possible bug (for the security audit): `test/KeeperPay.t.sol` `test_reconcileOnlyCallIsPaid` fails on unmodified `e36e9ba` with forge 1.5.1 (reward 0.000144132 ETH, asserted > 0.00015), so either the bound or the reconcile-only cost moved with the toolchain.
