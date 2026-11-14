# Simplification review of e36e9ba (Shapes Pool Balancer)

Branch `simplify-review-e36e9ba`, cut from `e36e9ba`. Report only; nothing in `src/`, `keeper/`, `shared/`, `app/` or `test/` is changed on this branch.

## Read this first

- **No forge test was run, including the money baseline.** The review environment's network policy refuses `mainnet.gateway.tenderly.co` (HTTP 403 at the egress proxy). Every test file in the repository forks mainnet, so none can run here. `docs/receipts/flow/` is git-ignored and absent from the commit, so there was no committed baseline to compare against either.
- Consequence: every `src/` finding is **reasoned**, with runtime bytes **measured** by building the cut. None is "checked" in the sense the brief asked for. The commands that would promote each one are listed under "To promote to checked".
- Keeper, shared and app findings are **checked** with the TypeScript suite, which needs no RPC.
- Independence: I did not open `docs/DECISIONS.md`, `docs/LAUNCH-AUDIT-TRIAGE.md`, `docs/AUDIT-*.md`, `docs/RC-*.md`, anything under `audit/`, or anything under `test/audit/`, before or after writing the findings. `forge build` compiled `test/audit/` without my reading it, and my greps over tests excluded it. Requirements came from `OWNER-REQUIREMENTS.md` and `asset-flow.json` only.
- Setup: `lib/` was empty; `git submodule update --init --recursive` populated it (no `forge install`). Forge 1.7.1 came from the npm package `@foundry-rs/forge`, solc 0.8.28 from the Solidity GitHub release. Unmodified build reproduces `PoolBalancer` runtime 21,315 bytes.

Commands used:

- Bytes: `forge build --offline --sizes src script` with the cut applied, then `git checkout -- src script`.
- TypeScript: `npx tsc --noEmit -p tsconfig.json` and `npx vitest run` (baseline: 5 files, 53 tests pass).
- FWA behaviour: read from the vendored source in `external/fwa-poolsv2/` (`StandardPool.sol`, `PoolFactory.sol`).

Byte savings are per cut, measured alone. They do not add up: with `via_ir` the optimizer re-inlines, so combinations save less or more than the sum. Measured combinations:

| Set | PoolBalancer runtime |
| --- | --- |
| Unmodified | 21,315 |
| Findings 4, 5, 7, 8, 13, 14, 15, plus the test-only getters and `denominationAmount` (see "Needs owner decision") | 20,536 (−779) |
| Above plus 3, 6, 9, 11 and `collectProceeds` | 19,977 (−1,338) |
| Above plus 1 (all 18 events) and the post-create check | 18,424 (−2,891) |

Any cut inside `performUpkeep` or listing changes measured gas, so keeper pay and the gas-denominated facts move with it. The signed outcome thresholds are maxima and these cuts only lower gas, but outcome texts quote measured numbers (O1: 31,105 gas per draw), so the baseline must be rerun and the text re-measured before any of them ships.

## Findings

Format: `path:line | cut | replace with | saves (lines, runtime bytes, gas per call) | checked or reasoned | risk`

### src/

1. `src/PoolBalancer.sol:217-239` | 13 events that no app, keeper, script or test reads: `Initialized`, `PurchasesOpened`, `PurchasesClosed`, `CuratedListed`, `CuratedRepriced`, `CuratedWithdrawn`, `UntrackedNFTRecovered`, `ShapesMinted`, `ShapeListed`, `PoolRetired`, `ENSNameSet`, `PoolPageApproved`, `PoolPagesRevoked` | nothing; FWA already emits its own listing, withdrawal and retirement events for the same actions | −30 lines, −1,051 bytes, about 1.5k to 3.5k gas per restocked prize (`ShapeListed`, `ShapesMinted`) | reasoned; bytes measured; tests read only `KeeperPaid` and `ProceedsCollected` (no `expectEmit` anywhere outside `test/audit/`) | low; anyone indexing these off-chain loses them. Dropping the five money and authority events too (`SurplusClaimed`, `ShapesUnlisted`, `RefundedRecovered`, `Configured`, `CreatorTransferStarted`) reaches −1,106 bytes; the extra 55 bytes are not worth the lost record
2. `src/PoolBalancer.sol:203-204, 851-853, 916-939` | `activeIds` array, `activeIndexPlusOne` mapping, swap-and-pop, `getActiveIds()`; on-chain code only ever reads the length | one `activeCount` counter; app and tests enumerate with FWA's `nextListingId` and `listings(id)` plus `items(id)`, the walk `test/utils/ForkBase.sol:162` already does | −12 lines, −458 bytes, about 40k gas per listed prize (two fresh storage slots), roughly 9% of a one-Shape restock | reasoned; bytes measured | high; the app's `useBalancer` and 15 test files call `getActiveIds`; storage refunds on draws fall, so O1's measured refund figure drops. Apply finding 7 first: today the `idx == 0` revert in `_removeActive` is what rejects a duplicate id in `unlistShapes`
3. `src/PoolBalancer.sol:391-402` | `listCurated` (single) | `listCuratedBatch` with one element; the app only ever calls the batch form | −12 lines, −203 bytes, 0 gas | reasoned; bytes measured | low; `script/DevSetup.s.sol:43`, `keeper/rehearsal.ts:210` and the `listCurated` helper in `test/utils/ForkBase.sol:84` switch to a one-element batch
4. `src/PoolBalancer.sol:377` | `if (!pool.retired())` before `setBool` in `close()` | unconditional `setBool`; `retire()` requires the pool closed and FWA's `setBool` reverts once retired, so a retired pool is always already closed | −119 bytes, one external call per `close()` | reasoned; bytes measured | low; `close()` after `retire()` would revert instead of emitting a no-op event. No non-audit test calls it in that order
5. `src/PoolBalancer.sol:659` | `!p.retired()` in the restock condition | drop it; `enabled` cannot be true on a retired pool (`open()` calls FWA `setBool`, which reverts `PoolAlreadyRetired`; only this contract can retire) | −108 bytes, one external call (about 1k to 3k gas) per open upkeep that did not process | reasoned; bytes measured | low; keep the `globalWithdrawOnly` check beside it
6. `src/PoolBalancer.sol:156, 268, 271, 297` | `FWA_IMPLEMENTATION_CODEHASH` immutable, its getter, the constructor argument and the per-`initialize` codehash comparison | the deploy-time check `script/Deploy.s.sol:45` already makes; deployed code cannot change after Cancun (EIP-6780), so comparing it on every clone repeats a check the chain enforces | −5 lines, −113 bytes, about 2.6k gas per `createBalancer` | reasoned; bytes measured | medium; touches a trust-boundary check and the constructor signature (`Deploy.s.sol:54`, `ForkBase.sol:54`). Only valid if the FWA implementation is not itself a proxy
7. `src/PoolBalancer.sol:511-522, 692-712` | `_withdrawAndRedeem` (one caller), the calldata-to-memory copy and the separate validation loop in `unlistShapes` | one loop in `unlistShapes` that validates and untracks each id, after `_collect()` | −7 lines, −105 bytes | reasoned; bytes measured | low; validation moves after `_collect()`, which a revert undoes
8. `src/PoolBalancer.sol:630-631` | second `p.nextSequenceToProcess()` call to learn whether anything was processed | `try p.processAcquisitions(MAX_PROCESS) returns (uint256 n) { processed = n != 0; }`; FWA increments `processed` and `nextSequenceToProcess` together (`StandardPool.sol:1569-1607`) | −91 bytes, about 1k gas per upkeep with a waiting draw | reasoned; bytes measured | low
9. `src/PoolBalancer.sol:904` | `ownerOf(tokenId) != address(this)` after pulling a curated NFT | nothing; FWA's `_listNFT` transfers the token on and reverts unless the pool then owns it (`StandardPool.sol:769-771`) | −1 line, −119 bytes, one external call per curated listing | reasoned; bytes measured | medium; a trust-boundary check, redundant only because FWA repeats it
10. `src/BalancerFactory.sol:15-16, 79-80, 89-91` | `allBalancers`, `isBalancer`, `balancerCount()`; app and keeper both discover pools from `BalancerCreated` | nothing | −8 lines, −320 bytes in the factory (not size-constrained), about 45k gas per `createBalancer` | reasoned; bytes measured | low; `test/Fork.t.sol` and `test/Balancer.t.sol` each assert one of them once
11. `src/PoolBalancer.sol:233, 311, 488-490` | `depositETH()` and `Deposited`; `receive()` already accepts ETH without the event, so the event is not a complete record and nothing reads it | plain ETH transfer from the app (3 call sites in `App.tsx`) | −5 lines, −70 bytes | reasoned; bytes measured | low; 12 test call sites switch to a plain transfer
12. `src/PoolBalancer.sol:261, 411, 513` | `InvalidBatch` and both `n == 0 || n > 20` checks | nothing; FWA `listNFTs` and `withdrawListingsTo` both revert outside 1 to 20 (`MAX_INVENTORY_BATCH`, `StandardPool.sol:747`) | −3 lines, −76 bytes | reasoned; bytes measured | low; the error name changes to FWA's. One test asserts `InvalidBatch.selector`: over-specified
13. `src/PoolBalancer.sol:329`, `src/BalancerFactory.sol:69` | `|| msg.sender == address(0)` | nothing; `msg.sender` is never zero | −16 bytes each | reasoned; bytes measured | none
14. `src/PoolBalancer.sol:889` | `if (mine > amount) mine = amount;` | nothing; the comment at 196-201 already proves the share is at most half | −1 line, −15 bytes | reasoned; bytes measured | low; it is a clamp, not a revert
15. `src/PoolBalancer.sol:83, 965-968` | `MAX_MARKUP_BPS` (equals `BPS`) and `_rewardBound` (one caller, same formula as `_payKeeper` and `MAX_KEEPER_REWARD`) | `BPS`; inline the expression | −6 lines, 0 bytes | reasoned; bytes measured | none
16. `src/PoolBalancer.sol:93-113, 617-625, 810-815` | comments that narrate audit rounds and finding numbers ("audit rc-ec5259c finding 6", "D16 re-attacks 2 and 3", "launch audit B, S1") | the rule each one states, one or two lines | about −25 lines, 0 bytes | reasoned | none

### keeper/ and shared/

17. `keeper/keeper.ts:37, 94, 102, 216-261, 304-311` | the `Fn` type and `fn`/`args` plumbing; `fn` is always `performUpkeep` and `args` always `[]` | the literal | −6 lines | checked: `tsc` clean, `npx vitest run` 53/53 | low; `keeper/e2e.ts:291` drops `fn` from its table. Keeper behaviour against a chain is covered only by `keeper/e2e.ts`, which needs a fork and was not run
18. `keeper/keeper.ts:22, 52-55` | five keeper constants redefined | import from `shared/planner.ts`, which already exports all five | −5 lines | checked: same run | none
19. `keeper/keeper.ts:14, 17, 394` | unused `fwaPoolAbi` import, `GWEI` constant and its export | nothing | −3 lines | checked: same run | none
20. `keeper/keeper.ts:94, 306` | optional `estimate` with the `gas * 10 / 13` fallback for state files from before the field existed; nothing is deployed | required `estimate` | −0 lines, one branch | checked: same run | none
21. `shared/planner.ts:73-81` | `GAS` table; nothing imports it and its comment describes a reward rule that no longer exists | nothing | −10 lines | checked: `tsc` clean, vitest 53/53 | none
22. `shared/planner.ts:21, 245, 265` | unused `rewardBound`; `KEEPER_FLAT` (duplicates `KEEPER_INCENTIVE`); literal `900_000n` (duplicates `RESTOCK_FEE_GAS`) | the existing constants | −3 lines | checked: same run | none
23. `shared/planner.ts:189, 233` | `initialMintFees` on `Evaluation`; nothing reads it | nothing | −2 lines | checked: same run | none
24. `shared/design.ts:14-17, 40, 100-101` | `shapeTotal` (same as `planner.shapeCount`), `describe` (a rename of `evaluate`), `const value = t.value` | re-export the planner functions | −8 lines | checked: same run | none

### app/src

25. `app/src/App.tsx:37, 647`, `app/src/chain.ts:22` | unused `pct`, `nftGroup`, `ETHERSCAN` | nothing | −3 lines | checked: `tsc --noUnusedLocals` clean for these, vitest 53/53, `vite build` succeeds | none
26. `keeper/rehearsal.ts:103` | unused `wordFor` | nothing | a few lines | reasoned (`tsc --noUnusedLocals` reports it; not removed and re-run) | none

### test/utils and test/scenario

27. `test/scenario/FlowBreakdown.t.sol:1441-1451` | `_backingListed()` counts backing by walking `balancer.getActiveIds()`, the contract's own list, so a prize the Balancer lost track of would not appear in the O4 and O6 facts | walk FWA's listings by id instead (`ForkBase.lastListingId` already does) | same size | reasoned | this is an evidence-trust point, not a size one
28. `test/scenario/FlowBreakdown.t.sol:1427-1439` | copies of `SHAPES_IN` and `_missingUnits` from the contract | nothing to cut cheaply; noted because a copied constant cannot disagree with its source | 0 | reasoned | none
29. `test/utils/ForkBase.sol:70-82` | `plan` (nine counts) beside `plan16` | `plan16` | −6 lines | reasoned | none

## To promote to checked

Run one file at a time with `forge test --match-path <file>`, then the money baseline, on a machine that can reach the RPC.

- 1: `test/Hardening.t.sol`, `test/Gas.t.sol`, baseline
- 2: every file under `test/` that calls `getActiveIds` (15), baseline
- 3, 9, 12: `test/Balancer.t.sol`, `test/Hardening.t.sol`, `test/HostileCollection.t.sol`
- 4, 5: `test/Balancer.t.sol`, `test/Fork.t.sol`, `test/Gas.t.sol`, baseline
- 6: `test/Fork.t.sol`, `test/Balancer.t.sol`
- 7: `test/Balancer.t.sol`, `test/Reserve.t.sol`, `test/Packs.t.sol`, baseline (`closeout_pending`)
- 8: `test/ProcessQueue.t.sol`, `test/KeeperPay.t.sol`, `test/KeeperAdversarial.t.sol`, `test/Gas.t.sol`, baseline (`no_processor`, `no_processor_5_gwei`, `burst`)
- 10: `test/Fork.t.sol`, `test/Balancer.t.sol`, `test/KeeperList.t.sol`
- 11, 14: `test/Reserve.t.sol`, `test/Invariant.t.sol`, baseline
- 17 to 20: `npm run keeper:e2e`

## Needs owner decision

- `setENSName`, the `ENS` immutable and `IENS`/`IReverseRegistrar` (`src/PoolBalancer.sol:159, 531-539`): −587 bytes. A creator power with a dashboard control, not named in `OWNER-REQUIREMENTS.md`.
- Pool-page approval (`approvePoolPage`, `revokePoolPages`, `isValidSignature`, `pageEpoch`, `src/PoolBalancer.sol:541-571`) and the linked `PoolPage` library (1,194 bytes, its own deployment): −795 bytes in the Balancer. It lets the contract sign FWA page publications; not named in the requirements.
- `collectProceeds()` (`src/PoolBalancer.sol:492-495`): −67 bytes. Upkeep and every creator action already collect, but removing it changes who can trigger a collection, and the profit split is taken at collection time.
- Post-create check `poolImplementation(p) != FWA_IMPLEMENTATION || owner() != address(this)` (`src/PoolBalancer.sol:302-304`): −242 bytes, about 5k gas per pool. FWA's `createPool(salt, expectedImplementation)` already reverts on a different implementation and initialises the pool with the caller as owner (`PoolFactory.sol:384-413`). It is validation at a trust boundary, so it is the owner's call whether FWA enforcing it is enough.
- Getters read only by tests (`creatorWork`, `prizeWeight`, `targetWeight`, `profitShareSum`) and `denominationAmount`: −41 and −42 bytes. They are how the invariant tests and the baseline see inside; cutting them trades evidence for bytes.

## Not worth it

- `if (reward == 0) return 0;` in `_payKeeper`: removing it grows the runtime by 249 bytes.
- Deriving `prizeWeight` from `activeShapes` instead of storing it: −35 bytes, and it moves about 2.5k gas onto every purchase hook call.
- `to == address(0)` in `withdrawCurated` (FWA rejects it too): −3 bytes.
- `ownerProceeds() == 0` pre-check in `_collect`: needed, FWA reverts `NoProceeds` on zero.
- `globalWithdrawOnly()` in the restock condition: needed, or a paused FWA factory would make `listNFTs` revert the whole upkeep and stop reconciliation.
- `nonReentrant` on functions that only write storage (`transferCreator`, `acceptCreator`, `revokePoolPages`): guards stay.
- `creator_ == address(0)` in `initialize`, `ownerOf` in `recoverUntrackedNFT`: reverts that stop an impossible state.
- `Item.base` for Shape prizes: nothing on-chain or in the app reads it, but the baseline's restocking-fee fact does.
- `curatedOddsBps` in `shared/planner.ts`: removing it fails 7 planner parity cases. The test guards a real parity check against the fork fixture; the app shows only the ppm figure, so the fixture could compare that instead, but it is two lines.
- Replacing the app's `liveRestockFee` and `liveVrfFee` with `restockFee()` and `quoteAcquisitionPrice()`: the new-pool preview runs before any pool exists to ask.
- `decide()` recovering paid gas from the simulated reward: the simulation returns only the reward.
- Unused members of `src/interfaces/External.sol`: they are the ABI the app, keeper and tests are generated from.
- Splitting `app/src/App.tsx` (1,609 lines, 119 KB): easier to read, not less code.

## Things that don't make sense

- The brief's `cd keeper && npm test`: `keeper/` has no `package.json`. The suite runs from the root with `npx vitest run`.
- CI (`.github/workflows`) runs 2 of the 5 vitest files and 1 forge file; `design.test.ts`, `tx.test.ts` and `wallet.test.ts` never run there.
- `MAX_RESTOCK_SIZES = 4` (`src/PoolBalancer.sol:80-82`) is justified by a six-size measurement, but `MAX_OPS = 5` already rules out six sizes. It binds only when exactly five single-Shape sizes are short.
- `src/PoolBalancer.sol:975`: the `@dev` line for `_prizeBase` sits on `_weight`, eight lines above the function it describes.
- `items()` returns `uint112` for fields stored as `uint104` (`src/PoolBalancer.sol:846`).
- `recoverRefunded` requires a non-zero `to` and logs it even for a Shape, where nothing is sent to `to`.
- `app/src/App.tsx:191`: `ZERO` is `Array(9)` while `Counts` is documented as length 16. It works because every consumer iterates, but it predates pack sizes.
- `keeper/keeper.ts:98`: the comment on `State.pending` describes failed Shape deliveries; the field holds in-flight transactions.
- The app hardcodes the Shapes, FWA factory, FWA implementation and VRF service addresses while the Balancer exposes `SHAPES()`, `FWA_FACTORY()` and `FWA_IMPLEMENTATION()`, which only the deploy script's postflight reads.
- `test/utils/Mocks.sol` under a "no mocks" rule: the contents are hostile NFT collections, not stand-ins for the system. The name invites the wrong reading.
- ENS naming, pool-page signing and untracked-NFT recovery have code, tests and UI but no line in `OWNER-REQUIREMENTS.md`.

## Correctness, seen in passing (for the security audit)

- `app/src/App.tsx:121`: the `WithdrawLocked` message can never match, because FWA's errors are not in `poolBalancerAbi`; a creator who withdraws while draws are settling sees a raw selector.
- `keeper/keeper.ts:109, 281`: `audit` grows by one entry per mined transaction for the life of `runForever` and is read only by the e2e script.
