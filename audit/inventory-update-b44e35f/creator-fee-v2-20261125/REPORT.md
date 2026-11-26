# Focused independent V2 creator-fee review

What this change does: V2 reserves an automatic creator allocation from actual collected FWA owner proceeds, separately from bankroll profit. The creator can move only an approved maximum of those fees into a live refill gap; deposits remain capital and open withdrawals retain the operating reserve.

## Target, method and bounded result

- Initial candidate: `c887bc7c21518b896a3027e44cff060d14139421`; contract feature revision: `213a6abe69fb293a4bec7c5f871fa1601cff35e0`. Git comparison found no contract-source change between these revisions. The final gate/UI/fixture preparation is at `e47fdefee28e85bdfed6e40570603ccda09ca7ad`.
- Final source hash supplied by the lead and corroborated in all three current focused scorecards: **`58c252dd452c6c54b2b91694ed6c25e52f65eb9face0725d6ba1b88461c0596b`**. The adjacent `SOURCE_HASH` records that exact reviewed input hash.
- Focused configuration approval digest: `5acc93973dcad11c81c9945851f85ddd62ea24a1ebea2f55264e7528331f4d3f`. Outcome texts I1–I6 remain unchanged; the selected tests, command and bound evidence expand. The approval signature remains empty. A source review marker is not that signature or a deployment approval.
- Scope: OWNER-REQUIREMENTS R111–R129; fee allocation epochs, cash/capital/backing conservation, optional reinvestment, claims, creator authority, affected V0/V1/V2 UI, existing inventory/ERC20 recovery and factory-pause compatibility. This is an **informed, timeboxed focused economic/security review**, with a 20-active-minute ceiling. It is not a blind or whole-system audit; prior task history and local diagnostic findings were already known.
- Applied the adversarial-security-audit standard, holistic-verification guidance and Ponytail focused-review guidance. Independent work consisted of source/caller/dependency reading, counterexample reasoning and saved-evidence examination. No tests, builds, RPC calls, broadcasts or delegation were performed by this reviewer. Only this report and its source marker were written.

**Result:** one actionable UI accounting-display finding was raised and repaired. No additional actionable contract security or economic defect was established in the examined paths. This does not establish that defects are absent, that every critical property has execution evidence, or that the candidate is mainnet-ready. Transactional browser-wallet acceptance of the new fee/reinvestment flow remains pending; the preview below is not a substitute.

## Finding and repair

**Resolved P2: negative bankroll results were displayed as zero profit.** The original Overview displayed `bankrollProfit()`, which deliberately clips losses to zero. Its separate lifetime operating result excludes a different set of items, including setup, and does not subtract reserved creator fees. It therefore did not fulfill R120's distinct bankroll profit/loss display. A pool with a recorded bankroll loss could show positive creator fees and “Bankroll profit: 0.”

The repaired UI uses `balance + listed/staged automatic backing - reserved fees - operatingCapital`, only after unsettled requests, unreconciled sequences and uncollected owner proceeds are all zero; otherwise it says “Pending settlement.” Its new helper and caller were reviewed. Under the trusted Shapes/Packs/FWA custody path, active plus staged automatic prizes match the contract's backing bucket. The capital view includes unsynchronized native gifts, so subtracting it is algebraically equivalent to clamping cash to accounted cash and subtracting recorded capital. Deposits do not manufacture income, and equal fee reduction/capital increase on reinvestment cancels exactly. The repair changes display, not asset rights or withdrawals.

Lead evidence: seven focused profit tests pass and final typecheck passes. The actual React preview shows a signed **−0.98 ETH** illustrative result from `0.06 cash + 0.01 backing - 0.05 fees - 1 capital`. It also exercises deposit-zero, exact/partial top-up, closed-pool and V1 displays. Static props and disabled transaction callbacks make these **UI rendering/interactions only**, not successful service answers, wallet confirmations or transaction receipts.

## Independent asset and authority map

| Actor / bucket | Inflow, control and final destination |
|---|---|
| Player / FWA | Player payments enter actual FWA acquisition escrow and the VRF service. Successful delivery allocates the request's owner base to owner proceeds and its edge to protocol fees. Failed/expired/slippage paths retain purchaser refund rights at FWA; Balancer does not own that escrow. |
| Balancer native cash B | Creation value, native gifts/deposits, real owner-proceeds withdrawals and actual redeemed backing. Unattributed ETH becomes capital; receipt/redemption code records cash so these are not contributions. |
| Protected creator fees C | `floor(actualCollectedOwnerReceipts × effectiveRate / 10,000)`. Only claims or explicit creator reinvestment reduce this bucket. Maintenance sees **B − C**, including when paid upkeep is enabled. |
| Automatic backing A | Actual Shapes/Packs minted and listed, including staged custody. Delivered or quarantined inventory is written off during reconciliation. Actual unlisting/redemption or refunded recovery restores native cash. Curated asking prices do not enter this ETH bucket. |
| Capital K | Creation funding, deposits/gifts and reinvested fees. Capital is not revenue. Closed capital recovery reduces the hurdle only beyond fee/profit claims; prior unrecovered losses persist across reopening. |
| Creator / recipient | Only the accepted current creator can configure, reinvest, claim and recover assets. Claims can name a recipient; ERC20 recovery pays the current creator. Depositors and prior/pending creators receive no separate claim under the accepted rules. |
| Keeper | Eligible useful paid work receives the bounded reward from B − C, subject to settings identity, allowance and caller floors. Public unpaid maintenance remains available. Reinvestment adds no keeper authority over C. |
| Factory policy admin | Controls future-clone implementation and following-pool economics under existing trusted-admin rules. New factories start publicly paused, with only the policy admin's own creation exception. An existing immutable factory cannot acquire that pause by switching implementations. |

The independent equations are:

- `operatingCash = B − C`.
- `bankrollProfit = max(min(B, accountedCash) + A − C − recordedCapital, 0)`, exposed after reconciliation.
- Open claim: **0** while requests are unsettled/unreconciled or operating cash is below reserve; otherwise **C + min(bankrollProfit, operatingCash − reserve)**.
- Closed claim: available native cash less actual outstanding-work reserve, after settlement checks. Claims consume fees first, then profit, then capital. Curated return prices establish no capital entitlement.
- Reinvestment: **min(approvedMaximum, C, max(refillReserve − operatingCash, 0))**. It reduces C and increases K equally; B does not move and signed bankroll P/L is unchanged. Closed pools use the reopening reserve; retired pools have zero allowance.

## Economic scorecard and round trips

These are distinct evidence contexts, not a combined profitability forecast. Saved test logs were read, not regenerated by this reviewer.

| Reached flow / regime | Numbers and implication | Evidence limit |
|---|---|---|
| Genuine launch-board receipts and fees | **0.066278634547026369 ETH** actual owner receipts; **1,067 bps** automatic rate; `floor(receipts × 1067 / 10000)` = **0.007071930306167713 ETH** fee credit. Actual recorded bankroll loss is **0.097190194207004119 ETH**. Gross fees coexist with losses, as R118 permits. | Three genuine historical proofs; launch board holds 47 automatic NFTs with 1.7 ETH backing. Historical request/fulfillment blocks 26442752/26442757, explicitly set nonzero gas contexts, not current market demand. |
| Fee claim while bankroll is negative | The funded-pool test pays that exact **0.007071930306167713 ETH** credit to the creator, decreases cash/fees equally and leaves contributed capital and clipped bankroll profit unchanged. | Reserve-funded state; not a claim that fees are always liquid. |
| Partial then exact gap top-up | Test deliberately supplies an explicit contribution leaving `gap = credit / 2`: **0.003535965153083856 ETH**. Partial maximum is **0.001767982576541928 ETH**; a later maximum-sized request uses only the remaining gap. Fees left are **0.003535965153083857 ETH**. Cash never moves; capital rises only by used fees. | Setup engineers an exact boundary through actual contributions and a larger target. It is not automatic production replenishment. Other tests cover fee-limited residual gaps and stale maxima after a real contribution. |
| Trigger and reversal | Increasing the target blocks claims; decreasing it restores reserve-gated availability without changing earned profit. Closed reinvestment funds reopening; after retirement, further reinvestment reverts and unused fees remain protected. | Examined test bodies and passing lead logs; not every setting permutation. |
| Positive native proceeds from curated sales | Three actual **0.2 ETH** NFT sales produce **0.6 ETH** owner proceeds. Setup costs **0.001578589821236817 ETH**, restock mint cost **0.001 ETH**, separate bankroll profit **0.581701410178763183 ETH** after fee allocation. Claims reach the creator wallet without withdrawing the **5 ETH** contributed capital while open. | Curated NFT acquisition cost is unmeasured and intentionally absent. This is native bankroll accounting, not personal investment return. |
| Authentic launch-board wind-down | From **5 ETH** initial capital, actual closed return is **4.913643653057350512 ETH**; active inventory, cash, owner proceeds, unsettled count and fee credit finish at zero. Remaining capital hurdle preserves losses. | The same three-proof cohort is inherited by more than one test; these are not independent economic samples. |
| Existing inventory/ERC20/pause reference cycles | Two curated NFTs return; **1 WETH** reaches the current creator; **1 ETH** native principal returns in the inventory/ERC20 cases; paused policy-admin canary returns **0.1 ETH**. Three current scorecards have no mismatches and the final source hash. | No-draw reference cycles establish I1–I6 in their declared domain, not creator-fee profitability or a monthly campaign. |
| Separate local diagnostics, reused bounded evidence | All **24** frozen local cases reconcile NAV and fee ledgers; actual fee reinvestment **0.045804724551318473 ETH**, fee withdrawal **0.083261062844880520 ETH**, and zero-demand wind-down were reached. | Synthetic coordinator callbacks, one seed, 2,360 settled requests and serial maintenance. Separate report: `docs/receipts/local-stress/20261125-v2/final-economic-review.md`. These are not authentic proof or release-gate results. |

R126 explicitly accepts continued sales with a missing jackpot and replacement gap. R127 explicitly accepts burst slippage refunds and unreturned VRF charges. Their measured costs remain disclosed in the diagnostic report; they are **accepted behavior, not unresolved defects or new purchase-pause requirements** in this review.

### Ratchets and running costs

- Capital is **not strictly increasing**: contributions/reinvestment increase it and closed principal returns reduce it. Its residual loss hurdle survives complete withdrawal and reopening; this intentionally prevents resetting a past loss into new profit. Reinvestment changes fee-versus-capital classification rather than creating wealth.
- Cumulative receipt, fee-accrual, fee-reinvestment and withdrawal event totals increase by design as history. The actual fee bucket, cash and backing can increase or decrease; no irreversible fee escrow was identified. Closed claims and the existing unlist/recovery routes provide exits subject to player obligations.
- Issued, processed and reconciled sequence counters increase to preserve canonical request history. Page/policy generations invalidate stale authority/settings. These are existing identity ratchets, not added payment entitlements.
- The new fee calculation adds work to collection/configuration and sometimes maintenance. Creator transactions pay their own gas; paid maintenance charges operating cash, never C. The focused logs establish actual costs and rewards for reached paths, but **no independent before/after incremental-gas comparison at launch gas and the 5 gwei cap** was performed here. No universal keeper-margin guarantee follows.

## Security examination and counterexamples

| Claim challenged | Concrete counterexample examined and disposition |
|---|---|
| Deposits cannot become fees/profit | Direct and forced native gifts, repeated synchronization, and a keeper returning its real reward during the payment callback. Capital/accounted-cash ordering preserves classification; the cost-first regression bodies exercise these real transfers. The unguarded receive function only accepts ETH. |
| Maintenance cannot spend protected fees | Paid and unpaid paths pass C into fill's retained cash and use B − C for keeper pay. A larger four-prize target can mint only three affordable 1 ETH prizes while C remains cash-backed. Separate authentic paid upkeep and local real-Keeper evidence exercise nonzero fees. |
| Rate changes cannot retroactively reallocate booked proceeds | Configuration and curated edits collect first. A configuration change while three requests remain pending keeps the old rate; collected fees stay unchanged through reconciliation and the subsequent new rate. Markup at 10% makes the new allocation zero without erasing existing fees. |
| Staged inventory cannot prematurely change the epoch | Refresh requires zero unsettled acquisitions, issued equal reconciled, and actual FWA active-listing count equal tracked count. Add/remove/reprice of curated items updates cached weight and dirty state. Only the Balancer owner can add FWA inventory. Source reasoning closes the simple count-mismatch case; a dedicated adversarial fee-epoch test covering every reserved/staged interleaving was not executed in this review. |
| A stale top-up approval cannot drain all fees | Fresh collection and live reserve recomputation precede use of `maximumAmount`. A contribution reducing the gap causes less to be used; fee-limited shortfall leaves an unfunded remainder. Zero maxima and retired/no-gap cases revert atomically. No external transfer occurs during the reclassification. |
| A caller cannot claim through pending work or a reserve gap | Claims reject unsettled/unreconciled states and insufficient operating reserve. A target increase creates a real claim failure; removing the trigger restores only the legitimate amount. Pending/old creator rights do not bypass `onlyCreator`. |
| Reentrant receivers cannot alter fee/capital or other assets | Creator-only state mutations are also `nonReentrant`, including reinvestment, configuration, claims, recovery, handoff and upkeep. ERC20 recovery sends no native value or approvals. The authorized-current-creator callback regression asserts `Reentrancy()`, not merely `Unauthorized`, while preserving actual WETH, native cash and nonzero fee credit. |
| Legacy clones cannot silently acquire V2 semantics | Fixed EIP-1167 implementations remain unchanged when the factory pointer changes. UI reads the accounting marker from each clone, treats RPC transport failure as an error rather than V0, preserves V1's informational earnings treatment and enables reinvestment only for V2. New creation still supplies zero in the legacy manual-rate tuple field; manual setter calls reject. |

External FWA settlement/withdrawal source was read at the referenced reviewed implementation: `0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7`, with configured runtime hash `0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02`. Actual custody and owner-only proceeds distinguish fees from purchaser escrow. Source/build-to-deployed dependency correspondence is supported by the lead's saved canonical preflight; this reviewer did not independently fetch deployed code.

## Verification evidence, failures and gate limits

Lead-owned commands/results read from `docs/receipts/focused-v2-release/`:

1. The initial expanded Forge command completed **12 tests**, but cached ABI-only artifacts silently omitted other selected suites. Its exit 0 is **not** represented as a full pass.
2. Targeted artifact restoration preserved caches. Omitted suites then produced **31 passes / 3 failures**. Failures were stale test creation tuples requesting manual `400` bps, which V2 correctly rejects.
3. The two fixture changes supply `0`, consistent with R117–R121. Affected FactoryPause/FocusedReleaseFlow runs then pass **9 tests**, covering the three failures and six related cases. Combined evidence covers **46 distinct selected test instances**; it does not pretend they all ran in one original command.
4. TypeScript evidence has **73 unique passes / 7 skipped** across the initial focused batch, deployment tests and signed-P/L repair. Final typecheck passes. The production app build also exits 0, with a reported 4.99-second build and dependency annotation/large-chunk warnings. Skipped live-session cases remain skipped, not inferred successful. Exact lead commands, exit statuses, limitations and log paths are consolidated in `docs/receipts/focused-v2-release/verification.json` and its README.
5. Runtime artifacts reported by the lead: PoolBalancer **24,438 bytes**, PoolInventory **19,184 bytes**, factory **5,594 bytes**. PoolBalancer has only **138 bytes** below the 24,576-byte EIP-170 limit. No contract repair was made in this review; source edits require a fresh affected size check.
6. The repaired `scripts/focused-release-check.sh` refuses missing or empty selected test bytecode before invoking the exact 13-contract matcher, pinned to Foundry 1.8.1. It includes both contracts defined in `AuthenticEconomicFlows.t.sol`, notably `AuthenticPositiveProceedsTest`. The script is inside the configuration's bound evidence paths. This is a guard against the observed cache failure, not a guarantee of arbitrary future test execution or a hermetic build.

The three scorecards bind the final source hash and retain I1–I6. These remain narrowly scoped, no-draw inventory/ERC20/pause outcomes. Expanded authentic fee tests provide separate evidence; they do not turn I1–I6 into signed profitability promises. The earlier gate log preserves the missing-signature/missing-review result. After this report was bound, `logs/gate-final-unsigned.log` reports only **missing approval signature**. That structural readback does not close the separate transactional UI gap or authorize production execution.

Genuine-proof tests use real coordinator proof verification and intentionally preserve candidate/request/protocol accounts across a historical fork advance, omitting intervening canonical mutations to those preserved accounts. Gas price/basefee are explicitly set and asserted in state-changing probes: request context **565,418,379 / 565,409,872 wei**, fulfillment context **565,418,379 / 548,662,718 wei**; other fork cases use **1 / 0.5 gwei**. The continuation/sequence cases declare their **0.55 / 0.5 gwei** counterfactual context. These are bounded historical cryptographic/accounting checks, not live randomness availability, independent samples or signed-transaction gas-market measurements. Several proof cases explicitly call FWA processing from the harness; they do not establish keeper-only queue liveness.

## Deployment and remaining acceptance boundaries

Saved Tenderly mainnet readback at **block 26496902** identifies current factory `0x6F018fF718Ab5A4287F937e4e4729Aa65610f53b`, implementation `0xfEBaFdbFf526afb2bE2DCCedcb740962B5E91089`, policy/keeper admin `0xCB43078C32423F5348Cab5885911C3B5faE217F9`, **zero pools**, and no supported `creationPaused()` getter. Saved dependency and legacy-ABI preflight passes. This was read from evidence only, not refreshed by this reviewer.

**R112's public creation pause requires a newly deployed factory.** The implementation-only route intentionally preserves the old factory and cannot supply that capability. The single production deployment path separates deployment from pointer activation, binds reviewed implementation/settings/dependencies and keeps new-factory creation paused. Neither this review nor a source marker grants authority for a broadcast, pointer change, publication or service change.

Remaining limits: transactional browser-wallet fee/reinvestment acceptance awaits its authorized batch; the static React preview is not receipt evidence. Maximum-width/mixed-staging fee allocation, all-denomination adversarial sequences, fresh genuine VRF generation, external-dependency pause, production timing/order competition and a new full economic campaign were not established by this focused review. Accepted partial-inventory and FWA refund semantics remain unchanged. The broad campaign stays separate under R113, and existing signatures, deployment and external-action controls remain applicable.

### Production packet follow-up

Read `docs/MAINNET-CREATOR-FEE-V2.md` and `docs/receipts/focused-inventory-update/OWNER-SIGNATURE.md`, including their signing, preflight, dry-run, decoded-confirmation and postflight steps. The packet remains explicitly unsigned; local transactional UI acceptance must be completed or explicitly waived before signing. Outcome signing and any later merge, deployment, funding, unpause and service cutover retain separate owner authority. No broadcast command was executed in this review.

Two preparation issues were raised and repaired: an initially mandatory mainnet-canary step conflicted with the owner's explicit R83 refusal, and pasted prerequisite/dry-run commands could continue after a failed check. The revised packet preserves R83, describes R112's paused-admin exception as a capability rather than a required new canary, and uses `set -eu` subshells with separate branch/origin assertions. Artifact copying and hashing follow only a successful canonical dry run. Current state, delegated signer/nonces, exact fees/gas allowance, decoded addresses/value and recovery after partial receipts still require execution-time confirmation. No new economics, authority or source-hash claim follows from these documentation repairs.

## Things that don't make sense

- Gross creator fees and negative bankroll P/L can coexist. The repaired UI now shows both; presenting fees as overall creator investment profit would still be wrong.
- “Complete” local diagnostic cases may retain missing jackpots or refund most batch requests. R126/R127 explicitly accept those behaviors; they are not new release blockers or reasons to add purchase restrictions.
- A no-draw focused gate can pass while authentic fee/UI acceptance has different evidence gaps. Those domains must remain separate even after the additional contract tests pass.
- An exit-0 Forge run previously omitted selected suites because artifacts were ABI-only. The new precheck addresses that observed condition, while preserved failures and incremental repair evidence remain necessary to understand what actually ran.
- The implementation-only deployment path cannot deliver a factory-level pause. A release proposal promising R112 must choose the new-factory route explicitly.
- A preparation document cannot silently reinstate the mainnet canary the owner rejected in R83. The revised packet now preserves that decision without treating outcome signing as permission to broadcast.
