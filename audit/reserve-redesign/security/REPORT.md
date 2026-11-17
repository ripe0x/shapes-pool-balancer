# Reserve redesign: independent focused security review

**Result:** 11 focused tests pass. No new security defect was confirmed in the examined cases. This is bounded evidence, not a clean bill, an exhaustive audit, or release approval. Public unpaid upkeep can consume booked creator profit for real restocking; the exact behavior and amount are recorded below. The lead confirmed that this preserves the previously accepted game-first rule.

## Target, method and limits

- Base revision: `a8fb321`, with the frozen reserve redesign identified by `/private/tmp/reserve-review-target-mtk_bq5d/MANIFEST.json`, SHA-256 `2291b07ab2278d26c5bc8b8e841956aa5298b05a8cbabeef53aeb6ee5ca9331a`.
- All 12 manifest entries, including source, requirements and Foundry configuration, matched the worktree before execution and again at sealing. The immutable target, rather than the dirty worktree's base commit alone, identifies the reviewed implementation.
- Fresh-context independent discovery. Prior audit reports, builder notes, reserve design documents and the economic lane's output were not consulted. The assigned scope supplied attack topics, so this is not a blind review. Method calibration and competent human review were not established.
- Release-candidate scope: reserve/payment redesign and affected custody, accounting, policy, withdrawal, work-validation and recovery paths. Read `PoolBalancer`, `PoolInventory`, `KeeperPolicyCalls`, `KeeperPolicyV1`, `BalancerFactory`, interfaces, real FWA processing/delivery/withdrawal paths and Packs mint/redemption paths.
- Budget: 45 minutes including reporting, with a 10-minute material-repair allowance. No production repair was made or requested. First clock sample was 20:53:45 UTC; final test log closed at 21:01:52 UTC; discovery sealed at 21:02:42 UTC. Initial reading before the first clock sample was not instrumented. Test preparation/execution occupied approximately 20:54–21:02 UTC; reporting followed. The lead requested sealing rather than additional cases after these results.

Real FWA/Shapes mainnet fork, block **26,382,349**, and locally deployed production Draw Packs were used. ForkBase's freely creatable NFT is an untrusted collection accepted by the product, not a protocol substitute. Hostile quote policies and recipients likewise exercise caller-selected collaborators. No protocol balances/state were fabricated, no mock calls were used, and no protocol caller was impersonated except the expressly retained deterministic Chainlink coordinator route. External actor wallet funding is setup. No mainnet broadcasts or real spending occurred.

Both `vm.fee` and `vm.txGasPrice` are set, and a state-changing witness checks their values. Normal probes use basefee **0.5 gwei**, bid **1 gwei**. Low-gas probes explicitly use basefee **0.01 gwei**, bid **0.02 gwei**. The payout-receiver callback independently records normal fee context. The hostile policy also checks the actual quote's fee fields against its executing frame.

Dependency correspondence: the FWA implementation codehash is asserted in each test. Public Sourcify metadata was refreshed independently during this review: StandardPoolBuyback and Factory report partial runtime/creation matches; all **15** and **9** locally vendored source files respectively match the returned contents. Shapes reports a partial runtime/creation match, and its returned `src/Shapes.sol` exactly matches the vendored source. Partial match means metadata can differ. Packs is deployed from the repository's production artifact, not an existing mainnet deployment. The mainnet VRF service was executed, but its complete source/runtime correspondence was not independently established here.

## Independently derived asset and authority map

| Bucket | Contributor / controller | Destination and recovery |
| --- | --- | --- |
| Balancer operating ETH | Creator deposits; accepted FWA owner proceeds; redeemed prizes | Actual mint/listing work and bounded keeper compensation; creator claims subject to current reserve |
| Booked `profit` | Creator markup above the first 10%, computed from tracked listing shares | Creator claims; excluded from policy activation and paid mint affordability; unpaid game-first restocking may consume it |
| Listed Shape backing | Creator funds real Shapes mint | Shapes holds backing; FWA holds the NFT; winner obtains exact redemption right, or creator unlists and redeems |
| Pack backing | Creator funds its underlying Shapes and mint fees | Packs holds Shapes, FWA holds the Pack NFT; winner or recovering creator redeems exact aggregate backing |
| Curated NFT | Creator supplies collection/token | FWA custody, then purchaser delivery; creator recovery only after actual delivery refund, or ordinary unlisting |
| FWA acquisition / delivery escrow | Purchaser pays | FWA alone settles into owner proceeds/protocol fees or purchaser refund credit; Balancer withdrawals cannot access it |
| Purchaser refund credit | Expiry, slippage/no-listing, or failed-delivery refund | Immutable purchaser pulls the principal; neither creator nor keeper receives it |
| Listed surcharge counter | Price expectation, not a cash inflow | Removed when a listing leaves tracked inventory; never netted against the cash reserve |
| Shapes mint fee / VRF / FWA edge | Creator fronts mint fee; purchasers pay price and VRF | One-way external costs; not creator-recoverable capital |
| Keeper payout / allowance | Operating ETH only for paid work | Actual caller receives bounded reward; token bucket limits repeated spend and refills with time |

The creator controls configuration, claims and policy proposals; public activation only executes a matured, funded proposal. Emergency disable cancels the proposal. A factory default change does not alter existing pools. Quote policies receive only static calls with bounded gas and returndata; they receive no asset approval or delegated execution authority. Inventory's delegatecall target is compiler-linked, not policy-selected.

Listed NFT identities, purchaser principal and creator money were checked separately. Aggregate conservation alone was not used to establish purchaser rights.

## One-screen economic scorecard

| Regime / flow | Absolute observed outcome | What remains / exception |
| --- | --- | --- |
| Quiet, full 20 × 0.01 ETH plus one 0.5 ETH board | Creator can withdraw to **0.00368 ETH** liquid operating capital | **0.7 ETH** backing remains external in real prizes; future surcharges are not liquid |
| Large 0.5 ETH win, then ordinary maintenance | Remaining **20 × 0.01 ETH** Shapes retain exact backing; large denomination is absent; reserve requirement exceeds **0.501 ETH** | Actual remaining weight still admits purchases; **0.6 ETH** Add ETH restores the large prize |
| One real Shape, hostile maximum quote, normal gas | Payout **0.0005998088 ETH**, billed **842,701 gas**; real mint costs **0.011 ETH** | Caller floor can reject the operation atomically; this payout is not a promise to cover every bid |
| One expired draw, low gas, hostile maximum quote | Payout **0.00005506216 ETH**, billed **190,012 gas** | No owner proceeds; purchaser principal remains refundable. This is a keeper-side observation, not coalition ROI |
| Expiry → disable → close → withdraw → retire → unpaid processing → refund → unlist | Purchaser receives **0.013972184380207416 ETH**; VRF cost **0.0000468 ETH**; creator recovers **0.2 ETH** backing | Final Balancer and FWA balances are zero; curated NFT returns to creator |
| Hostile curated delivery → retirement → seven-day refund → recovery | Purchaser receives **0.01504174912035689 ETH** principal | Creator gets NFT only after purchaser refund; pending delivery escrow reaches zero |
| Real Pack won by contract lacking ERC721 receiver | Purchaser redeems **0.02 ETH** after retirement | FWA uses `transferFrom`; rejecting a safe-transfer callback cannot manufacture failed Pack delivery |
| Policy activation boundary with real booked profit | Profit **0.008903420149923702 ETH**; requirement **11.36776 ETH** | Cash covers requirement but operating cash does not: activation rejects until exact excluded-profit shortfall is added |
| Paid versus public unpaid recovery | Paid mint refuses to consume profit; unpaid caller consumes **0.000379273672380286 ETH** booked profit for real 1 ETH prize mint/listing | Profit is not always liquid or protected from unpaid game-first inventory spending |

**Separate economic observations:** no new economic defect is asserted by this lane. The unpaid-profit behavior is confirmed and must stay explicit in user-facing economics. The low-gas payout is useful work compensated from creator funds even though an expiry generates no owner income. Full creator/buyer/keeper coalition acquisition, refund, gas and closeout economics belong to the independent economic lane and were not inferred from the keeper payout alone.

Round trips were exercised for expired purchaser escrow, failed curated delivery, creator deposits/listed backing through wind-down, depletion/Add ETH/replacement, and winner Pack backing. Shape mint fees and VRF charges do not reverse; the test checks the VRF amount independently as `2,340,000 × 0.02 gwei`. Unpaid mint checks **0.01 ETH backing + 0.001 ETH live mint fee**. Sequence counters, policy generation and page epochs ratchet to prevent replay; their growth does not itself trap creator value. Allowance replenishes with time rather than configuration or policy activation. Listed fees, active counts, booked profit and liquid reserves can decrease.

## Security counterexamples and outcomes

All names below are in `test/ReserveSecurityReview.t.sol`.

| Test / attempted counterexample | Demonstrated result |
| --- | --- |
| `atomicKeeperFloorRollsBackRealMintListingBalancesAndAllowance` | Maximum-quoting policy is clipped by actual one-Shape work; rejecting caller floor reverses real mint/list, balances and allowance; a positive affordable floor succeeds |
| `expiredDrawCheapWorkCapProtectsRefundPrincipalAndPaysAtLowGas` | Real expiry cannot claim a theoretical heavy-call maximum; refund principal is unchanged and no owner income is invented |
| `failedDeliveryRefundAndNFTRecoverAfterRetirement` | Frozen creator-selected collection creates actual delivery escrow; premature creator recovery fails; purchaser refund and NFT recovery remain available after retirement |
| `keeperPayoutCallbackCannotCloseClaimOrRunUnpaidEvenAsCreator` | Actual creator/keeper payout callback runs, but nested close, claim and upkeep all fail under the lock |
| `largeWinDepletesOnlyOperatingCapitalAndRecoveryUsesActualBacking` | Operating depletion does not touch remaining prize custody/backing; actual missing denomination and funding need are observable; Add ETH restores it |
| `malformedBurningAndReenteringPolicyPreserveUnpaidRecovery` | Revert, 31-byte return, gas burn and 64-KiB return fail atomically on paid work. Gas-burning policy cannot block actual unpaid mint/list with immutable fallback surcharge; static reentry cannot mutate guarded state |
| `noAllowanceResetByCloseConfigureOrPolicyAndEmergencyCancelsMaturedChange` | Close/configure/open preserve spent allowance; matured activation immediately after work preserves spent allowance; disable cancels matured change; re-enable requires a fresh two days |
| `pendingExpiryRefundSurvivesDisableCloseWithdrawalRetirement` | Zero Balancer ETH does not invade FWA escrow; public unpaid processing and actual purchaser withdrawal survive retirement; backing closeout succeeds |
| `policyFundingExcludesRealBookedProfitAndSwitchKeepsOldPrices` | Activation excludes profit to the wei, rejects the funded-total/unfunded-operating boundary, succeeds after exact deposit, and preserves old listing prices |
| `contractPurchaserCannotRejectFwaPackTransferAndRetainsExactBacking` | Real production Pack transfer succeeds without an ERC721 callback; purchaser custody and exact post-retirement redemption are verified |
| `unpaidRecoveryCanSpendBookedProfitButPaidKeeperCannot` | Confirms the distinct rights/economic behavior of paid and unpaid paths rather than assuming profit is always claimable cash |

## Reproduction and evidence

Foundry **1.8.1**, Solc **0.8.28**, configured optimizer/via-IR/Packs profile. Final command, run from the worktree:

```sh
forge test --isolate --match-path test/ReserveSecurityReview.t.sol --fork-url https://mainnet.gateway.tenderly.co -vvvv > /private/tmp/reserve-security-profits.log 2>&1
```

Exit **0**; **11 passed, 0 failed**; test execution **2.85 seconds**, **11.01 CPU seconds**. Log SHA-256 `55bc18384256237e1a271d867dd1e7f2a81455a52cf85331fcafc29301ca78e7`. Test source SHA-256 `970c7c2b665ab5b07964240d835ba4d06824ac71f2deb937c42d39ac4c322374`. Five-field Foundry `lastCallGas().used` is treated as already-billed gas by the reviewed existing helper; it was not adjusted for refunds again.

Failures were preserved, not hidden: `/private/tmp/reserve-security-first.log` and `reserve-security-debug.log` contain two harness errors, corrected to use `vm.getBlockTimestamp()` across warps and the actual FWA enum/history semantics. FWA retains historical `priceEscrowed` after moving the real escrow counter to refund credit. `/private/tmp/reserve-security-fourth.log` contains the disproved Pack receiver-rejection hypothesis. The final suite asserts the actual `transferFrom` behavior. Intermediate passing logs remain in `/private/tmp/reserve-security-{second,third,fifth,final,complete}.log`.

No production/helper/previous-test files were edited by this lane. Only this report and the new focused test are owned changes. The lead owns final staging/commit and broad candidate verification; no separate commit was made here.

## Comment-only target addendum, 2026-11-17

After discovery and execution were sealed, the lead corrected stale `PoolBalancer.sol` comments about duplicate-largest-prize reserves, initial setup, unconditional creator profit booking and unpaid profit consumption. This lane independently inspected the complete diff against the immutable target copy. Every changed line is a comment; comment-and-whitespace-stripped source is identical. All other 11 manifest entries still match.

`PoolBalancer.sol` SHA-256 changed from `70f2b32dc898dff56c2798494f2d24a72075995c336829d676bac4937b175bd4` to `e98890d6a5a3a495b988c9c812d4ca5b1b6d1f450a1d1d3d646d640d1651c8d5`. The execution evidence above remains attributed to the original source hash and manifest. The comment-only delta preserves that behavioral evidence; metadata and compiler-linked deployment addresses may change on recompilation. No additional tests or attack cases were run for this documentation correction. The lead's final candidate compilation, full suite and deployment artifacts will use the corrected comments. No canonical `SOURCE_HASH` was written by this lane.

## Post-discovery canonical record and O5 restatement

This is an informed record addendum after independent discovery was sealed. The command `python3 /Users/dd/.agents/guidance/asset-flow-kit/asset_gate.py . --print-source-hash` returned **`c498277954d66f3be2ac2cfbf7f36d8e8944e8815a3c48c0243214fc74e8f63b`**, exit 0. This canonical source inventory includes the final comment-only PoolBalancer delta and added capital/review tests and low-gas script. Its scope differs from the original immutable source manifest. Recording it does not retroactively attribute the earlier 11-test execution to recompilation under this hash or imply an independent audit of every newly inventoried test/script. No production logic changed. `SOURCE_HASH` beside this report records this correspondence for the asset gate.

The changed O5 text and metric were inspected directly in `asset-flow.json`, together with the scenario's explicit creator top-up/drop-top branches and its emitted end-admission and missing-day counters. Previously O5 required zero days ending with any target prize missing. The supplied fresh measurements still report **11** such days after Add ETH and **14** after dropping the top prize; that old guarantee fails. O5 now measures **`facts.admission_status_at_end == 0`** in those two named response regimes, and expressly permits later depletion while preserving backing and purchaser refund rights. This is a weaker, different acceptance condition consistent with the new partial-depletion request; it is not evidence that the old guarantee passed, that every intermediate state admits purchases, or that every chosen design can continue without capital.

The two measurement files share the canonical hash and each report **180 requested, 180 fulfilled, zero refused**, and final admission status **0**. Add ETH contributes **0.482240129070927392 ETH**. The drop-top regime ends with **0.082273561766801972 ETH** liquid against **0.10542 ETH** required reserve, so admission open does not mean fully funded. These are inspected source/measurement records from the lead's run, not new independent executions by this lane. The old missing-day figures remain visible and must not be suppressed by the metric change.

This addendum records the proposed acceptance restatement and its limitations. It grants no owner signature, outcome approval, mainnet authority, financial guarantee, broad-suite pass, or release-readiness conclusion. No new tests or campaign were run for this follow-up.

## Remaining limits and things that don't make sense

- **Confirmed, intentional:** unpaid restocking can consume booked creator profit. Describing that counter as an always-liquid protected claim would contradict the executed path.
- **Open economic question:** expired work pays a service component with no associated owner income. The scoped keeper measurement does not decide coordinated creator/buyer/keeper profitability; transaction-wide evidence is needed from the economic lane.
- The reviewed fork is pinned to block 26,382,349. No recent-block drift check, actual signed-transaction rehearsal, keeper service run, canary, mempool competition, stochastic oracle outage/timing campaign or deployment verification was performed here.
- Full gas-spike, dependency-paused, zero-demand, every-setting-extreme and all-limits regimes were not executed in this lane. The 1,000-prize case exercises reserve/activation arithmetic without minting 1,000 prizes. Full-suite and maximum-board evidence are the lead's separately owned checks.
- Failed Shape/Pack delivery through an invented receiver hook is unreachable under FWA's observed `transferFrom` path. Other failures requiring an actual trusted-token transfer failure remain untested; protocol state was not faked to manufacture one.
- No new security defect was confirmed in these finite cases. Source review and these probes do not close unexamined attack families or establish release readiness.
