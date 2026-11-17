# Review of `8ec98cb..f5c81d6`

**Result:** Contract repair is needed before treating R37 as met. A creator can cut a pending keeper's reimbursement below its gas cost, and the allowed low restocking fee can make repeated wins consume the reserve. The branch also has a 200-versus-1,000 prize requirement conflict. This is a scoped, informed release-candidate review, not a launch audit or a release-readiness claim.

## Target and method

- Reviewed source: `f5c81d6a31c0a03153cff70f6a035587d9713df3`; last reviewed source: `8ec98cb1cb9015befe273a5a72ba5b8e9c497103`. Both were read from the requested `launch-audit-triage` repository. The branch was at `a2ef9f6` during review. Its later `e76b0bc`, `619bc66`, and `a2ef9f6` UI changes are **supplemental scope only**; the lifetime Ledger and withdraw split are absent from `f5c81d6`.
- Requirements: R35–R38 in `OWNER-REQUIREMENTS.md`; decisions 86–89 in `docs/DECISIONS.md`. Source hash at the exact target, computed with the asset-flow kit: `0832f33c4b8ccded66261436cd3a0b08a5d42a3a786af64cfa91a59d5f032be0`.
- Compared changed source and its callers, then used two independent read-only reviews and a fresh-context claim challenge. Economic destinations were derived from the contract paths and compared with the existing flow helper. No production deployment or target runtime was supplied; source-to-deployed-bytecode correspondence is unverified.
- Fork observations use Ethereum mainnet block **26,382,349** through `https://mainnet.gateway.tenderly.co`, Foundry **1.8.1**, real FWA, Shapes, Draw Packs, and, for the saved keeper-race witness, a real BAYC held by an external account. The witness asserts **4 gwei** basefee and transaction gas price from inside a state-changing call. No protocol state or balance was fabricated, and no protocol caller or successful oracle response was impersonated in that witness. Funding the creator and keeper wallets is test setup.

## Findings

### F1 · Keeper reimbursement changes after preflight (high, executed economic finding)

`PoolBalancer.setOverrides` lets the creator lower `maxGasPrice` from 5 to 1 gwei at any time (`src/PoolBalancer.sol:372–390`). `BalancerFactory.setSettings` can do the same for all pools (`src/BalancerFactory.sol:56–62`). The bundled keeper simulates the expected reward and reads the pool settings before it broadcasts (`keeper/keeper.ts:219–247`), while `performUpkeep` reads them again only when executed and pays at the then-current cap (`src/PoolBalancer.sol:648–652,800–807`). There is no minimum-reward argument or delay.

The saved `KeeperRace.t.sol` witness ran a preflight upkeep, reverted that local snapshot, had the creator lower only the cap, and executed the same useful first-fill upkeep on the real fork. At 4 gwei, preflight reward was **0.003680060 ETH**. The included call used **865,479 billed gas**, costing **0.003461916 ETH**, but paid **0.000995058 ETH**. The keeper lost **0.002466858 ETH**, over **12 times** the keeper policy's `0.0002 ETH` maximum loss. A keeper cannot recover it from the creator. The same 1 gwei setting held persistently can make rational keepers decline future work whenever gas exceeds the cap; a creator may still run their own upkeep. This directly challenges R37's “limits that keep the system working.”

**Repair direction:** Keep the setting a creator may choose, but let a keeper bind the minimum reward it will accept in the transaction, or delay decreases long enough to protect pending calls. Check the included transaction's billed gas and fee after the repair; an off-chain preflight alone cannot close this race.

### F2 · Allowed restocking fee can consume the reserve (medium, conditional economic finding)

`SettingsLib.check` accepts `restockGas=500,000` and `restockFlat=0` (`src/Settings.sol:32–38`). The listed price then includes only **0.0025 ETH** of restocking fee per Shape at the supported 5 gwei reimbursement cap (`src/Settings.sol:53–56`). With a 0.01 ETH Shape, 10% minimum markup, and the fork's 0.001 ETH mint fee, its price is **0.0145 ETH**. On a 200-Shape plus one 0.2 ETH NFT board, FWA's weighted owner proceeds are approximately **0.014567219 ETH per draw**. A replacement costs **0.011 ETH** backing plus mint fee; a measured roughly 811k-gas span, 50k overhead, 5 gwei price, and default incentive pay about **0.004305 ETH** to the keeper. That leaves about **−0.000738 ETH per Shape-win cycle** before any unrelated expense. Shape wins dominate this board.

This is a model using the real FWA price formula and prior fork gas measurements, not an executed adverse draw cycle under the no-mocks rule. The allowed combination can erode the fund until `_fillDeficit` cannot afford a replacement (`src/PoolBalancer.sol:739–795`); the creator then has to add ETH or reduce the target. The outcome conflicts with R37's working-limits condition and with O11 if O11 is meant to cover nondefault settings. Set a lower bound from a real replacement cost or explicitly make the shortfall an owner-approved creator subsidy, with an extreme-settings lifecycle measurement.

### F3 · The prize ceiling has two incompatible meanings (decision required)

R36 and decision 87 say a plan holds **1–200** prizes. Decision 88 later approves an adjustable `maxPrizes` of **1–1,000**; `configure` enforces that current factory value (`src/Settings.sol:38`, `src/PoolBalancer.sol:347–359`). `test/Settings.t.sol:208–224` deliberately configures 1,000. Thus 200 is the **default**, not a hard cap, in `f5c81d6`. The later approved decision may supersede R36, but the owner requirements and specification still state a universal 200 cap. Resolve that outcome wording before acceptance. The 3.2M gas bound was measured at 200 Shapes plus 20 curated NFTs, not at every allowed 1,000-prize and unbounded-curated mix.

### F4 · Existing pools can save the wrong keeper override (medium, UI)

`app/src/App.tsx` reads a pool's deploying factory for keeper restrictions, but `liveSettings(pub)` reads the globally configured `FACTORY` for displayed defaults (`f5c81d6:app/src/App.tsx:91–113`). Transferred pools from other factories can be discovered (`:243–251`). The Settings form compares user entries against the wrong defaults to decide which override bits to clear (`:1339–1355`). For an older pool whose factory default is 5 gwei and a current global factory at 20 gwei, entering 20 gwei clears the bit and leaves the old pool at 5 gwei. Read defaults from that pool's `factory()` address. This was established by caller and state tracing, not a browser transaction.

### F5 · Higher pool caps do not raise the bundled keeper's bid (operational liveness)

The keeper reads each pool's `settings()` for `decide` (`keeper/keeper.ts:231–232`), which is correct for the compensation formula. Its separate global bid cap remains 5 gwei by default (`:113–114,200–215`). At 10 gwei basefee it skips even a pool that raised its reimbursement cap to 20 gwei. An operator can raise its environment setting; changing the pool alone does not restore service. State that coupling in operator guidance or allow per-pool bids within the keeper's risk policy.

### F6 · Inventory display can count a delivered prize (existing affected UI path)

FWA can transfer a Shape or Pack and credit owner proceeds before Balancer upkeep reconciles that draw. Until reconciliation, `getActiveShapes` and `getActiveIds` still include the delivered prize (`src/PoolBalancer.sol:679–725`). The `f5c81d6` Overview and pool list count that backing as still held (`app/src/App.tsx:1199,1266–1281,332–334`), temporarily overstating assets by its face value, up to **100 ETH** for an allowed prize. This state can be reached by ordinary delivery timing. Use FWA listing status or ownership for the displayed asset value. It is a display defect, not proof that contract backing moved incorrectly.

### Supplemental HEAD findings: Ledger and withdraw split

The following code first appears after `f5c81d6`, at branch HEAD `a2ef9f6`. `Ledger` sums `Deposited`, `SurplusClaimed`, `ProceedsCollected`, `ShapesMinted`, `KeeperPaid`, and `ItemDrawn` (`app/src/App.tsx:125–147`). Those event names match the contract, but two state transitions are missing:

1. A failed Shape/Pack delivery is marked `PENDING` by Balancer and is still owed to the player. Ledger counts its backing as creator-held. If FWA later retries successfully, it transfers the token to the player and credits proceeds, but Balancer does not revisit that reconciled item. Ledger **permanently** counts the backing as held and omits the win. A 25 ETH Pack makes a 25 ETH error. FWA retry and Balancer pending behavior are code-reachable; a real-FWA Shape retry-after-upkeep test is still needed.
2. `withdrawSplit` (`app/src/App.tsx:1259–1264`) assigns *current* withdrawable ETH using *lifetime* `earned = takenOut + held − putIn`. After a 1 ETH deposit, 0.1 ETH earned and already claimed, and 1 ETH held against a 0.8 ETH reserve, the 0.2 ETH current surplus is deposit under the contract's profit-first accounting (`src/PoolBalancer.sol:518–525`), but the UI calls 0.1 ETH earnings and 0.1 ETH deposit. The on-chain withdrawal amount remains guarded correctly.

## Economic scorecard and flow breakdown

Actors: creator deposits ETH and curated NFTs; players pay FWA for draws and receive prizes or refunds; FWA retains its edge and randomness charges and makes owner proceeds claimable; Balancer takes those proceeds, mints backed Shapes/Packs, holds a keeper reserve and creator profit, pays keepers for reconciliation/restocking, and returns claimable ETH and unlisted/recovered assets to the creator. The factory admin controls defaults across its pools, while each creator controls four override fields only in its own clone. `settings()` does not directly transfer prize backing or grant one creator access to another pool.

| Regime / evidence | Creator ETH and asset destination | Keeper / player outcome | Status |
| --- | --- | --- | --- |
| **Zero demand**, 5 ETH deposit, 47-prize launch board, fork block 26,382,349, 0.5 gwei basefee and 0.55 gwei gas price | 2.69475375425 ETH claimed; 0.5337 ETH reserve; 1.7 ETH Shape/Pack backing; 0.055 ETH mint fees; 0 ETH FWA proceeds or buyer refund credit. Sum with keeper pay is exactly 5 ETH; zero mismatch. | 0.01654624575 ETH paid for creator-started filling; no buyer transactions. Creator's net setup cost is 0.07154624575 ETH. | **Executed**, real BAYC/FWA/Shapes; no randomness response. |
| **200 prizes + 20 real curated**, five expired FWA draws reconciled and five Shapes restocked in four sizes | **2,613,339 measured gas**, 2,601,356 billed gas; **586,661 measured-gas headroom** under the 3.2M pay cap. | Real FWA timeout/refund route, no randomness response; useful upkeep paid. | **Executed** no-mock fork path. It does not measure fulfilled-draw processing. |
| **200 prizes + 20 curated**, five fulfilled draws reconciled and five Shapes restocked in four sizes | Existing local gas test reports 2,645,522 measured gas, 2,577,907 billed gas; **554,478 measured-gas headroom**. The printed 2,796,756 figure includes test harness work around the upkeep call. | Local test forces Chainlink coordinator delivery. | **Limited** constructed gas observation; no no-mock fulfilled-draw proof. |
| **Creator cuts cap before inclusion**, 4 gwei basefee and bid | Real fork first-fill call spends 865,479 billed gas. Pool pays 0.000995058 ETH after the cap change. | Keeper cost 0.003461916 ETH, loss 0.002466858 ETH; useful work completed. | **Executed** no-mock witness. |
| **Minimum restocking fee at 5 gwei**, 200 small Shapes + NFT, 10% markup | One Shape-win cycle estimated to drain about 0.000738 ETH from reserve after its fee and markup; backing remains owed to its holder. | Keeper can be paid; creator funds the deficit. | **Model only**; draw lifecycle untested. |
| **Maximum settings and 1,000 small prizes** | Max reward **0.311 ETH/call**. At a 0.001 ETH mint fee, opening before fill would require **73.833 ETH** for 11 ETH of backing plus mint costs and the reward reserve; roughly 62 ETH is temporary keeper capital. | Admin can raise the reserve requirement of every pool; a funded pool at the old reserve can stop selling until topped up or settings are restored. | **Formula only**; no extreme inventory fork lifecycle. |

The raw zero-demand receipt is saved as `zero_demand.json` beside this report. The zero-demand round trip returned 2.69475375425 of the creator's 5 ETH deposit and left 0.5337 ETH liquid reserve plus 1.7 ETH redeemable backing. Backing-to-redemption, player payment-to-prize/refund, NFT listing-to-return, and all closeout round trips were **not executed** under this review's no-mocks constraint. The keeper transfer is one-way; its restocking-fee return path needs a won prize, so it is unmeasured here. `reconciledSequence` and FWA's issued sequence only increase to record processed draws; `pageEpoch` only increases to invalidate old approvals. The creator can claim `profit` and excess reserve, so those balances are not monotone. No owner rationale for 1,000 prizes or unbounded curated inventory at the gas extremes is recorded in the scoped evidence.

The asset-flow gate reported **INCOMPLETE** (exit 2): only `zero_demand` has a current-source scorecard. Quiet, limits-at-max, max-then-idle, large-win, gas-spike, randomness outage, closeout, top/bottom prize mixes, burst, and other required regimes lack no-mock measurements. An initial sandbox attempt to run the flow file failed DNS lookup for the public RPC (exit 1); the authorized RPC rerun of zero demand passed. The default flow harness impersonates the Chainlink coordinator for draw regimes, so its other results cannot satisfy the requested no-mocks rule. These gaps prevent acceptance of negative safety or economic claims for those regimes.

## Security property checks

| Property / counterexample | Evidence and outcome |
| --- | --- |
| Admin or creator chooses an in-range setting that strands upkeep or makes a keeper lose | F1 executed with real fork counterparties. A persistent 1 gwei cap at gas above 1 gwei is also loss-making by `rewardPrice` math. |
| Keeper paid for no useful work | `performUpkeep` pays only when `ops != 0 || reconciled` and reverts if nothing changed; reconciliation of an expired/refunded draw is useful settlement work. No bypass found in the scoped paths. This is source tracing, not an all-callback proof. |
| Settings move prize backing or one creator changes another pool | Override storage belongs to each clone; settings feed keeper reward, reserve, new listing fees, and configure limit, while redeemable Shape/Pack face value is unchanged. `test_backingUntouchedAtTheLimits` passed. The factory admin intentionally changes defaults across pools. No direct cross-creator write found. |
| Curated value gets markup | `_pullCurated` checks the value and lists at `price=base`; `updateCuratedPrice` sends `newBase` to FWA; curated `_share` is zero (`src/PoolBalancer.sol:446–455,915–939`). FWA prices draws from the whole board, so zero curated markup does not mean a curated win produces no pooled Shape markup. Real BAYC was listed at 0.2 ETH in the zero-demand fork path; reprice and a won-NFT profit split were not exercised without an impersonated randomness response. |
| 200-prize cap and unbounded curated NFTs | Default `maxPrizes=200`; admin can set 1,000 and `configure` accepts it (F3). The contract has no total curated count; `listCuratedBatch` and the dashboard's `listSteps` chunk at FWA's 20-per-transaction bound (`app/src/App.tsx:481–491`). More than 20 is code-reachable, but a browser transaction sequence was not run. |

## Verification record

All commands ran at `f5c81d6` in a detached worktree unless marked supplemental. Solidity test files were selected one at a time with `--match-path`.

| Command | Exit / result | Limit |
| --- | --- | --- |
| `forge test --match-path test/Settings.t.sol -vv` | 0; 12 passed | No draw lifecycle; initial setup uses a creator-controlled collection. |
| `forge test --match-path test/Gas.t.sol --gas-limit 100000000000 -vv` | 0; 24 passed | Worst-draw cases impersonate coordinator; 200-prize gas is a local observation. |
| `SOURCE_HASH=0832… forge test --match-path test/scenario/FlowBreakdown.t.sol --gas-limit 100000000000 -vv` | 1; DNS denied at fork setup | No regime executed. |
| `SOURCE_HASH=0832… forge test --match-path test/scenario/FlowBreakdown.t.sol --match-test test_breakdown_zeroDemand --gas-limit 100000000000 -vv` with authorized public RPC access | 0; 1 passed, zero mismatch | Only zero demand; pinned block. |
| `forge test --match-path test/audit/RcSettingsRace.t.sol --gas-limit 100000000000 -vv` with authorized public RPC access | 0; 2 passed; in-call gas fields asserted in both | Saved witness here as `KeeperRace.t.sol`; copy to `test/audit/RcSettingsRace.t.sol` to rerun. The second case tests expired draws, not fulfilled draws. |
| `npm run typecheck` and `npm run test:ts -- --configLoader runner` | 0; typecheck, then 57 tests across 6 files | No wallet/browser preview; no Ledger test at later HEAD. |
| `python3 /Users/dd/.agents/guidance/asset-flow-kit/asset_gate.py . --no-run` | 2; INCOMPLETE | Only zero-demand scorecard current. |

The temporary dependency symlink first made TypeScript types unavailable and Vitest's bundled config unwritable; pointing to the repository's installed dependencies and using Vitest's runner resolved the environment issue. Those failures did not execute product tests. Economic mapping, security tracing, witness execution, and the claim challenge overlapped during this review; separate phase durations were not recorded. The review report and saved witness are documentation/evidence; they do not alter the target contract. No `SOURCE_HASH` review record was created because contract repair is needed.

## Things that don't make sense

1. **Confirmed requirement conflict:** R36 states a hard 200-prize maximum while later D88 authorizes 1,000. The owner needs to clarify which numeric outcome is in force; a passing 1,000-prize test does not settle it.
2. **Confirmed economic tension:** D88 allows zero incentive and a 1 gwei cap even though it says every allowed combination keeps the system working. It also lets a factory admin raise every pool's reserve requirement after a creator has funded and opened.
3. **Open scale question:** D89 has no total curated cap, but the 3.2M pay and 400k processing-starvation bounds were measured at much smaller inventories. The dashboard loads each active listing with separate on-chain reads. A large real inventory gas and UI load test would decide this.
4. **Open security suspicion, inherited UI path:** `loadMine` accepts unfiltered `CreatorTransferred` logs from arbitrary contracts and trusts their `creator()` result. A malicious contract might appear as a pool and draw deposit or NFT approval transactions. A hostile-contract UI transaction test is needed before assigning severity.
5. **Evidence limit:** Any draw result that depends on the existing harness's impersonated Chainlink coordinator would not survive a real randomness/inclusion failure. Zero-demand asset accounting, the keeper race, and the expired-draw gas case do survive that shared-assumption challenge; fulfilled-win and closeout claims do not.
