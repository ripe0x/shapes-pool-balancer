# Keeper policy implementation and evidence

> **Historical `a8fb321` evidence.** The capital-intensive reserve and related bounds below are superseded by [RESERVES.md](RESERVES.md) and the current reserve redesign results. Preserve these numbers as history; they do not describe the current implementation.
2026-11-17. Based on current main `a29af3a`, branch `codex/replaceable-keeper-policies`. **Implemented locally; no mainnet deployment or real funds used.** This is an implementation verification record, not a professional audit or release approval. The final Git commit contains this record; source correspondence for the asset-flow evidence is recorded below.

## Contracts and authority

Introduced `IKeeperPolicy` core interface version 1, stateless `KeeperPolicyV1`, permanently linked `KeeperPolicyCalls`, and permanently linked `PoolInventory`. Updated `PoolBalancer`, `BalancerFactory` and informational `Settings`. Existing `PoolPage` remains permanently linked. Extracting inventory and enforcement code was necessary to fit EIP-170; none of these library addresses can be replaced. Only the economic policy is selected dynamically, through bounded **staticcall**, never delegatecall. No policy holds assets, approvals, arbitrary execution, ownership, FWA operator authority, or work-validation authority.

Each new clone snapshots the current factory recommendation. A creator proposes a compatible replacement, waits **two days**, deposits the exposed shortfall, then anyone may activate. Activation revalidates compatibility and funding in that transaction. Cancellation is immediate. Emergency payment disable also cancels mature pending proposals; reenabling needs a fresh proposal and delay. Ownership acceptance cancels the previous creator's proposal.

A distinct, two-step-transferable **policy admin** proposes the factory default with its own two-day delay and public activation. Keeper eligibility remains under the separate keeper admin. A new factory default affects future clones only. Old implementations already deployed without this feature cannot acquire it; pools created with this implementation need no later asset migration.

Future compatible policies may change formulas, operation-specific gas allowances, work fees, denomination/pack surcharges and gas response within immutable bounds. Core work inputs are measured gas, actual bid/basefee, reconciled draws, successfully listed Shape units/prizes and processed draws. A future formula cannot introduce a new definition of payable work, alter existing listing records, bypass reserves/caps, modify integration code or redirect assets. Optional `settings()` is display metadata, not authority. Truly new work classes require a new pool implementation, not an arbitrary execution framework.

## V1 economics and immutable enforcement

```text
reference = min(tx.gasprice, block.basefee + 0.05 gwei, 5 gwei)
reward = (min(measuredGas, 3,200,000) + 50,000) * reference
       + 0.00002 ETH * (finalized draws reconciled + Shape units created AND listed)
surcharge per prize = contained Shape units * (
    900,000 * min(block.basefee + 0.05 gwei, 5 gwei) + 0.0002 ETH)
```

V1 declares **0.01645 ETH** maximum, including ten possible service units. A Pack counts underlying Shapes only after its actual FWA listing succeeds. Processing and reconciliation do not duplicate a service fee. Empty upkeep and repeated claims earn nothing. Creator markup remains distinct from restocking charges; curated NFTs retain creator-assigned prices without either surcharge or Shape markup.

The 0.00002 ETH work fee is a calibration choice: the prior 388-call/832-draw rehearsal's 0.0001 ETH per call averaged about 0.0000466 ETH per draw. A reconciliation plus one replacement now earns 0.00004 ETH of service fees regardless of splitting. This does not establish market-clearing compensation or competition.

The pool enforces the cached selected maximum, **0.311 ETH hard maximum per call**, and this independent envelope:

```text
(min(measuredGas, 6,000,000) + 200,000)
  * min(tx.gasprice, block.basefee + 2 gwei, 50 gwei)
+ 0.001 ETH * (reconciled draws + successfully listed Shape units)
```

This preserves current HEAD's decision-88 ceiling, which changed since reviewed commit `05e6b60`; the older request's 0.01635 ETH was not current HEAD's immutable bound. Current main also includes canonical FWA queue processing, starvation checks, keeper replacement/eviction recovery, 1,000-prize capacity and curated-NFT pricing changes. Those paths were retained and affected tests updated. Factory/creator mutable settings were intentionally superseded by selected immutable policy contracts, not silently retained as a second economic authority.

Each pool has a **3.11 ETH burst** and refill `floor(0.311 ETH / 12)` wei/second. The burst permits separate reconciliation/replacement for five outstanding draws at the hard maximum; refill permits one maximum call per 12 seconds. Ordinary V1 work consumes far less. This sizes a conservative workload allowance, not an empirically optimized risk budget. Nothing resets it on policy changes, configuration, opening, ownership or inactivity; idle refill saturates. The calculable upper bound, including the burst, is **2,242.3099999999999424 ETH per 24 hours** and **817,311.109999999978976 ETH per 365 days**, further restricted by genuine work and creator-owned liquidity. These are deliberately generous bounds, not small expected expenditure. An unrelated pool has its own allowance. Surcharges cannot exceed **0.102 ETH per contained Shape**.

Paid callers use an atomic minimum: `minimumFixed + minimumGas * tx.gasprice`. Quote failure, stale policy generation, insufficient capital/allowance or an unmet minimum reverts all work. The keeper simulates the real offered payment; executable gas limits use estimateGas with headroom while optional transaction traces estimate expense. Received rewards, billed expense, failed attempts and operating costs remain separate.

## Reserves, old listings and recovery

Old `Item.price`, `Item.base`, original markup shares and real FWA prices stay fixed. The aggregate old surcharge record is future-income information, **never cash**. No per-listing policy address is needed.

Activation requires `balance - bookedProfit >= candidateReserve`. Closed pools hold one cached maximum per unreconciled draw, including split settlement. Open pools also hold actual inventory deficits, largest-prize exposure and split upkeep exposure, plus:

```text
max(2 * max(target prizes, active Shape prizes) * cached maximum
    - sum(active Shape/Pack Item.price - Item.base), 0)
```

Missing future listings contribute zero fees. This conservative board-cycle bridge funds a new policy's exposure despite old lower-priced inventory. Claiming booked profit leaves operating funds unchanged; surplus claims cannot reduce operating funds below the active reserve. Claims after a proposal may increase the candidate shortfall but cannot defeat activation's final check.

Independent real-fork example, 20 small Shapes, 15% markup and one 0.2 ETH NFT, base/bid 0.5/0.55 gwei: initial reserve **1.2838 ETH**, stocked reserve **0.7209 ETH**, backing **0.2 ETH**, uncollected listed fees **0.0139 ETH**. Switching to a 0.03 ETH maximum requires **1.3171 ETH**, an exact **0.5962 ETH** top-up after old surplus is claimed. Complete zero-demand closeout balances **5.5962 ETH deposits = 5.570126244 creator recovery + 0.006073756 keeper receipts + 0.02 mint fees**; all original NFT/backing custody reverses.

Reserves restrict withdrawals and policy activation; they do not guarantee perpetual self-funding after gas changes, adverse prize luck or repeated discretionary maintenance. Curated-NFT turnover has no surcharge and is not part of the Shape/Pack board-cycle bridge. More expensive policies can consume creator capital. FWA escrow, purchaser refunds, prize backing and FWA entitlements remain outside keeper payouts. Paid maintenance excludes booked profit; unpaid inventory recovery retains the prior game-first behavior and can clip unclaimed profit when needed, an explicit compatibility distinction.

`performUpkeepUnpaid()` remains public under keeper restrictions. It retains healthy selected-policy pricing and falls back to the immutable V1 surcharge if quotes revert, exhaust their stipend, return malformed data or exceed the bound. Full reconciliation, new listing prices, closing, redemption and retirement were exercised under policy failure. The caller still pays gas and inventory still requires funding. Dependency pauses and delivery restrictions are not overridden.

## Measured keeper profitability and splitting

Real transaction receipts from the mixed-policy keeper E2E, one replacement operation at each effective bid, with 0.05 gwei tip:

| Effective bid | Basefee | Keeper receipt less billed gas |
|---|---|---:|
| 0.15 gwei | 0.10 gwei | +0.00004859755 ETH |
| 0.50 gwei | 0.45 gwei | +0.00006865850 ETH |
| 5.00 gwei | 4.95 gwei | +0.00032658500 ETH |

These are reached operations, not average business profit: no allocated hosting/competition overhead is deducted. A real timeout-only call at 5 gwei paid 0.000950055 ETH, billed 170,416 gas costing 0.00085208 ETH, net **0.000097975 ETH**. At basefee exactly 5 gwei, a positive tip exceeds V1's cap; the default service waits, while zero-tip inclusion is uncertain.

The isolated fork split test includes FWA processing expense: two batched calls pay **0.0003266398 ETH** and net **0.0000983172 ETH**; four split calls pay **0.00048546275 ETH** and net **0.0000981566 ETH** at base/bid 0.5/0.55. Service fees total **0.00008 ETH** both ways. The caller did not profit more in this reached schedule, but the creator paid more. This is not a universal no-splitting-incentive proof; gas refunds and other work composition can change margins.

The 300-round local-fork rehearsal reached **832 draws, 288 buyer arrivals, all 288 open**, 24 above-cap waits/resumes, 12 markup edits, seven creator restocks and two keeper restarts. Chain scanning found **361 keeper transactions, 361 reward events, zero unexpected reverts**: rewards **0.284256453057387152 ETH**, billed gas **0.243994943965387940 ETH**, wallet net **0.040261509091999212 ETH**. Local reopen latency median 64 ms, p90 914 ms, max 3,070 ms is not mainnet timing evidence. Trace expense error ranged from −270,574 to +6,406 gas; estimation is not a guaranteed billed-cost bound.

That scan exposed incomplete old service statistics, repaired separately with focused lost-response/reorg tests. The canonical chain totals above supersede the earlier health totals. The rehearsal is not repeated for accounting-only changes. A further focused before/after regression reproduced a peer mining at the eviction boundary and verifies retained accounting; the four-line-family recovery repair was independently source-reviewed. Receipt-accounting recovery and its bounded journal are described in OPERATIONS; an orphaned nonce may require explicit operator rebroadcast/cancellation if the node does not reinsert it.

## Representative player and creator economics

The following are **model estimates**, 30 days, 1,200 desired draws, 25% Shape markup, base/bid 0.5/0.55 gwei and 0.001 ETH mint fee. The stochastic gas, demand and timing assumptions are not fork-validated forecasts. A separate 23-step real-fork ledger matches TypeScript money branches exactly; that does not validate those stochastic assumptions.

| Design | Player draw price | Initial operating ETH | Stocked reserve | Creator net after 30 days |
|---|---:|---:|---:|---:|
| 17 small Shapes + 0.2 ETH NFT | 0.01572 | 1.1027 | 0.6243 | +2.5085 ETH |
| 47 mixed Shape/Pack prizes + 0.2 ETH NFT | 0.02310 | 4.7729 | 2.0749 | +3.7927 ETH |
| 17 small Shapes + 20 NFTs at 0.05 ETH | 0.02432 | 1.1027 | 0.6243 | +1.8113 ETH |
| 1,000 prizes including expensive Packs + 2 ETH NFT | 0.01586 | 73.9128 | 33.2162 | +1.3801 ETH |

Amounts are ETH. Draw prices exclude randomness and player gas; at the stated bid the modeled VRF request adds **0.001287 ETH** per draw. Creator net includes contributed NFT value and ongoing replacements; contributed operating capital is wealth, not earnings. At 5 gwei zero-tip execution, the same fixed-demand small/NFT-heavy/large cases lose **0.9733 / 1.3206 / 4.2202 ETH** respectively. The mixed case remains +2.2933 ETH in that model. A modeled V1→V2 switch needs 1.5639 ETH extra capital. These results challenge any assumption that higher fees are harmless: a hypothetical 20% higher draw price at elasticity 2 reduces demand to 69.4%. Actual elasticity, curator replacement willingness and FWA admission downtime remain unmeasured. See [all 23 scenarios](keeper-policy-simulation-results.md).

## One-screen actual asset-flow scorecard

Real FWA/Shapes/production Packs on pinned block 26,382,349. Base/bid 0.5/0.55 gwei unless named. Creator wealth counts remaining assets and contributions; keeper net deducts billed transaction gas. Reserve shortfall is the maximum observed, not a lost purchaser entitlement.

| Regime | Draws / refused arrivals | Creator wealth net | Keeper net | Max reserve shortfall |
|---|---:|---:|---:|---:|
| Quiet | 180 / 0 | +0.743079 ETH | +0.015588 ETH | 0.090181 ETH |
| Normal gas, 0.1/0.15 gwei | 180 / 0 | +1.213473 ETH | +0.010560 ETH | 0.032219 ETH |
| At cap, 4.95/5 gwei | 180 / 0 | +0.816678 ETH | +0.070349 ETH | 0.096917 ETH |
| Zero demand | 0 / 0 | −0.071650 ETH | +0.001328 ETH | See zero-demand ledger |
| Forced large wins | 180 / 0 | −0.236916 ETH | See full ledger | 1.070175 ETH |
| Gas spike | 145 / 35 | +0.321201 ETH | +0.025295 ETH | 5.528678 ETH |
| Bursty settlement | 161 / 0 | +0.311825 ETH | +0.017805 ETH | 0.380745 ETH |
| V1→V2 with outstanding draw | 19 / 0 | +0.036113 ETH | +0.002679 ETH | 0.002594 ETH |

All **23 regimes** conserve ETH/NFT destinations to the wei and meet their configured outcome bounds. Policy switching requires an actual **1.951433005 ETH** transition deposit in this launch-board scenario; one switch, zero repriced old listings, one outstanding draw at the switch. This deposit differs from the other boards above because liabilities and composition differ. Purchaser refund round trips were tested separately through complete creator retirement and actual buyer withdrawal, including **0.028999313514543896 ETH** preserved in the hostile-policy case.

## Verification record and limitations

All fork/RPC commands use `https://mainnet.gateway.tenderly.co`. The owner retained the existing coordinator-impersonation exception for deterministic VRF delivery. No other protocol success answers or state/balances were mocked. This exception does not test real Chainlink timing or availability. Test actor wallets are funded as setup. Production-path local broadcasts use chain 31337/test ETH only.

| Scope | Result and evidence |
|---|---|
| Frozen Foundry candidate, excluding separately gated FlowBreakdown | **423 tests attempted: 356 passed, 67 failed initially.** Raw `/private/tmp/keeper-policy-candidate-foundry.log` retained. All 67 affected cases subsequently passed in 19 suites, `/private/tmp/keeper-policy-candidate-affected.log`. Failures were outdated economics assertions or inherited aggregate test-harness gas exhaustion; unchanged baseline reproduces the latter. Raising the harness budget does not relax actual upkeep gas limits. No clean one-command full-suite pass is claimed. |
| Focused final payment/emergency/economic tests | **25 passed**, `/private/tmp/keeper-policy-final-pay-emergency.log`; earlier repaired price/minimum/recovery cases retained. |
| Real V1→V2 three-pool lifecycle | Passed on pinned dependencies: two V1 pools unchanged by delayed factory default, third starts V2, first switches after delay with an unsettled draw, second stays V1; actual draws/upkeep then closeout. Broken-policy full unpaid restock recovers without migration. End balances, profit, fee records and reserves zero after retirement. Recent-block lifecycle also passed at **26,436,099**. |
| Invariants | Seven properties, **64 runs × 64 depth = 4,096 handler calls**, zero handler reverts. Only three purchases were admitted: weak draw exploration, supplemented by focused lifecycles/rehearsal, not concealed as broad draw coverage. |
| TypeScript | **70/70 tests in nine files** passed before final accounting repair; focused keeper tests and project typecheck repeated for that repair. `/private/tmp/keeper-policy-candidate-typescript-tests.log`. |
| Shared money/pricing parity | Solidity exports V1 parameters and real V1/V2 quotes; TS replays a 23-step actual-fork money ledger. Planner, dashboard and model use those representations or contract quotes. Unknown future policy costs remain unknown. |
| Keeper transaction manager | Final focused E2E10 passed: **27 canonical transactions, 26 successes and one intentional stale-policy revert; persisted gas 0.017892914492693627 ETH and rewards 0.020053850266894209 ETH exactly equal chain totals.** It separately checks mixed policies, stale-policy rejection, restart, replacement, lost response, historical RPC failure, reorg rollback and exact canonical receipt reconciliation. Final eviction-boundary recovery regression also passes (`/private/tmp/keeper-policy-eviction-after.log`), after reproducing the old failure. Earlier failed runs 01–06 and 08 remain in `/private/tmp/keeper-policy-e2e-*.log`; their fixes/assumptions are not erased. |
| Dashboard | Built and exercised in preview against isolated fork: invalid/compatible candidate, increased-cost warning, propose/cancel, chain-time delay, activation, surplus withdrawal, exact shortfall deposit, V1→V2, emergency disable and empty unpaid execution. The reused UI chain predates the final emergency-cancellation repair; that exact delta is covered by independent fork tests. |
| Gas accounting | Pinned Foundry 1.8.1 returns a five-field `lastCallGas` response whose used value already includes intrinsic/refunds. A real storage-clear call bills **22,503 gas**, matching an actual Anvil receipt/call trace; adding the known 4,800 refund gives gross 27,303. Duplicate intrinsic/refund corrections were removed. Earlier intermediate measurements are superseded. |
| Quote boundary overhead | Compared with equal inline arithmetic: **+7,704 cold / +2,677 warm gas**, isolated bounded policy quote/envelope. Excludes transaction intrinsic, transfers, accounting and storage-cap reads; not a complete old-vs-new upkeep benchmark. `/private/tmp/keeper-policy-inline-overhead.log`. |
| Deployment constraints | Runtime: PoolBalancer **24,380 B** (196 B below 24,576), Factory 3,570, V1 1,143, policy library 4,618, inventory library 7,626, PoolPage 1,194, Packs 17,768, renderer 9,354. Actual local production-path deployment max **5,387,856 billed gas**, maximum submitted deployment gas limit **7,004,212** across eight transactions. Service gas limits reject values over **16,777,216**; reached upkeep/deployment paths remain under EIP-7825. These are reached bounds, not a proof every possible configuration is executable. |
| Asset-flow gate | All 23 fresh regimes/outcomes pass, reviewed source hash **`eefd64a9600fc70701db718b521a9dd83a5ced0a2ca11ddee00e828fe47ec524`**. Gate exit **2 INCOMPLETE**, solely because changed outcomes are unsigned. Outcome hash **`7549eb9bf22328cfdbe433208bcdd25e98ebfbfa906f4897d80ff9a6f933a96e`**. No old signature reused. Original run and no-run review-record check retained in `/private/tmp/keeper-policy-candidate-asset-gate*.log`. |

Reproducible commands use `CANDIDATE_RUN=1` for broad checks, pinned Foundry 1.8.1, `forge test --fork-url https://mainnet.gateway.tenderly.co --isolate` with the relevant test filter, `npm run test:ts`, `npm run typecheck`, `npm run sim`, `npm run build:app`, `npm run keeper:e2e`, and `CANDIDATE_RUN=1 npm run rehearsal -- --rounds 300`. The giant historical audit sweeps use `--gas-limit 100000000000` for aggregate fixture construction only. Local E2E/rehearsal requires available isolated Anvil ports; never point broadcasts at chain 1. The exact changed-source boundaries and focused repairs matter when reusing evidence. Exact broad/affected commands, exit statuses and local log SHA-256 values are in [verification.json](../audit/keeper-policies/verification.json). Raw local logs are retained, not claimed as permanently hosted artifacts.

## Independent reviews and release blockers

[Security review](../audit/keeper-policies/security/REPORT.md) and [economic review](../audit/keeper-policies/economics/REPORT.md) are independent focused AI reviews, informed by implementation context, not blind professional audits. Material reproduced findings were resolved:

1. Unpaid callers could select fallback pricing despite a healthy more expensive policy. Fixed to retain valid selected quotes; independently retested through actual FWA listing.
2. A public executor could undo emergency disable using an already mature pending proposal. Disable now cancels it; independently retested. Reenabling requires a new delay.
3. Keeper minimums fixed in wei could reject affordable work when fees fell. Added mined-gas-price-indexed floor; real-fork and service tests cover it.
4. Service receipt statistics omitted consumed nonces with lost responses and retained orphaned receipts. Added bounded canonical receipt recovery/accounting, strict event address/recipient matching and explicit operator-action health reporting. It does not silently rebroadcast accounting-only recovery work. The final independent source pass also required retaining accounting when releasing an evicted send slot, retrying an inconclusive nonce search, clearing same-nonce duplicates on canonical receipt, and preserving known per-hash offer metadata. The real peer-mining race fails before and passes after the repair; the reviewer inspected the final source and worker log without claiming another test execution.

**Mainnet remains blocked** by unsigned changed asset-flow outcomes, owner review of the very large capital/spending choices, inherited readiness items, professional security/economic review, and separately authorized real-transaction rehearsal/canary requirements. No permission is requested or inferred to deploy.

The requested full low-gas malicious-policy keeper/buyer manufacturing-profit calculation remains unexecuted; the existing maximum-policy test proves caps/refund custody, not every adversary's net economics. No extra attack execution was undertaken after that scoped review stopped. A voluntarily selected malicious policy may subsidize manufactured work from creator capital within large immutable limits; combined creator/keeper/buyer control creates no demonstrated route to external escrow. This gap must not be presented as an economic safety result. Service journal coverage also excludes the external-operator cancellation → cancellation reorg → original-upkeep reinclusion sequence; that unusual intervention requires manual canonical reconciliation. Reached E2E receipt equality is not a promise of an unbounded financial index.

## Monotonic state and one-way destinations

`reconciledSequence` advances so finalized FWA work cannot be paid twice; dependency-issued sequences/listing IDs likewise identify one operation. Policy generation advances on disable/activation to reject stale pending offers, and `pageEpoch` invalidates old creator approvals on transfer. Allowance timestamps advance with time while the allowance itself refills/debits and never resets. FWA retirement is intentionally irreversible. These ratchets carry replay/custody boundaries, not profit accrual. Creator capital, backing and unsold surcharge records reverse on closeout; actual Shapes mint fees, VRF service fees, FWA edge, keeper execution gas and completed compensation are one-way costs. The reached round trips and absolute destinations above do not assume those costs can be reclaimed.

## Decisions made without owner input

Retain current HEAD's 0.311 ETH hard ceiling; choose 0.00002 ETH service units and unchanged V1 surcharge; reserve two maximum payments per board prize; choose per-pool 3.11 ETH burst/refill rather than a low daily cap; separate default-policy governance from eligibility; two-day creator/default delays; delayed reenabling; healthy-policy pricing plus immutable fallback for unpaid recovery; permanently linked libraries for size; replace mutable settings with bounded policy selection; retain direct quotes rather than mandatory future metadata. These are implemented choices for review, not a new owner signature on economic outcomes.

## Things that don't make sense

A small immutable spending allowance cannot guarantee unlimited paid throughput. This design instead combines a very generous expenditure bound with conservative reserves that can lock tens of ETH. That capital cost may be unattractive for the product even though the accounting checks pass. High gas and weak demand can make creators lose money. The remaining low-gas malicious-policy profitability gap and real demand/availability measurements deserve resolution before mainnet.
