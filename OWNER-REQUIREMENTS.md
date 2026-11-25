# Owner requirements

The owner's requirements for the Shapes Pool Balancer, in the owner's words where we have them. Each points at what
measures it: an outcome in `asset-flow.json` (checked by the asset gate in every regime it names), or a named test.
This is the single source for builders and auditors; the older money goals (M1 to M9 in the round 8 and 9 audit
prompts, now under `audit/history/`) are restated below and marked where today's decisions replaced them. Later
decisions are appended, never rewritten.

Markers: *(relayed)* the decision reached us through another session; *(agent wording)* an agent's words for the
owner's intent; *(proposed)* an outcome or number the owner has not yet chosen.

**Status (2026-11-13): confirmed by the owner** ("gtg" for R1 to R23; "Yes, confirm it" for this restructured version
with R24 to R28). D12 to D15 (O11, O12, the keeper constants, no caps) were decided by the owner on
2026-11-13: "Yes, all four".

## Authority and safety (owner, 2026-11-10)

- R1. "You do not have authority to deploy to Ethereum mainnet, spend real funds, access production secrets, alter
  existing production contracts, or publish a live application under my accounts."
- R2. "Do not deploy to Ethereum mainnet until I authorize it." Guarded at deploy by `script/deploy.sh` (asset gate,
  signed outcomes, review record for the exact source); it cannot stop a deploy that bypasses the script.
- R3. "Always use Tenderly's public RPC URL for Ethereum mainnet: `https://mainnet.gateway.tenderly.co`."

## Keepers

- R4. "we need to make this so it never loses money with keepers"; "The markup is where they make money"; "the gas at
  listing time != gas at draw time". Under option B the creator pays keepers and the restocking fee in each price is the
  creator's income, so this is the balance of two flows → **O11** (D12, "Yes, all four"): restocking fees repaid in won prizes
  cover keeper pay for play on the launch board at 0.1 to 5 gwei. Measured, 180 draws: +0.019 to +0.12 ETH; with the
  creator's own setup work counted, −0.020 ETH at 5 gwei (setup 0.14 ETH); NFT-dominated boards lose on play (an NFT
  win brings no fee): up to −0.0371 ETH measured on the current source, which O11 states as up to 0.038 ETH.
- R5. The keeper list is "on the factory", "open at default", and no creator should have to update their pool
  individually → `test/KeeperList.t.sol` (open by default; restricted list; creator always allowed; admin reopens).
- R10. Option B *(relayed)*: every useful upkeep (one that reconciles a draw or lists a prize) is paid from the
  creator's ETH at gas plus a small flat reward; a call that does nothing is paid nothing. Replaces M1 ("the markup is
  never spent on keepers") → **O1**. The flat reward (0.0001 ETH) and overhead (50,000 gas) are final (D14, "Yes, all
  four").
- R11. D2: "D2 yes: accept, limit 0.002 ETH per 180 draws": keepers keep storage refunds on top of gas → **O1**.
  Superseded by R32 (D19): the limit is now in gas per draw.
- R12. D4: "D4 yes: accept and budget one paid call per processed draw; fix the comment." → budgeted inside O11's net.
- R13. D3: "D3 yes: repair it. Hold back keeper pay owed for unreconciled draws while closed." → **O3**. Since D16
  the hold is one maximum keeper reward per 2 such draws (was per 5): upkeep processes at most 2 draws per call, and
  the per-5 hold left a keeper 0.0054 ETH short at 5 gwei (D16 re-attack F2).

## The game and the creator's money

- R6. "this needs to be like a self-sustaining system"; the revenue restocks the prizes "and then the creator gets the
  profit"; "protect the game first, profit after" but "not always have the game eating the profit for the creator".
  Game first → **O5** (prizes restored after the creator's response) and **O7** (sales that refill prizes are not
  blocked); profit after → **O8** (the creator's share is the markup above 10%) and **O9** (it follows each draw's
  priced board).
- R7. The minimum markup is the game's share: "if the min for a setup is 10%, and they choose 30%, then shouldn't it be
  1/3 - 2/3?" → **O8**.
- R8. Product goal *(agent wording)*: the pool stays open through ordinary mainnet gas up to 5 gwei, funds itself from
  sales, is profitable for the creator in expectation, at a draw price players will accept → **O7** (open), **O10**
  (price), **O12** (D13, "Yes, all four") (the creator ends ahead in quiet operation at 0.1 to 5 gwei: measured +0.34 to +1.28 ETH
  per 180 draws on a 5 ETH deposit).
- R9. Exact redeemable backing *(agent wording, M4)*: every prize holds its backing and returns to the pool at exactly
  that value when unlisted or recovered → **O4**.
- R14. D5: "D5 yes: reword to 'all buyers fund restocking fees'." The pool fronts each prize's restocking fee and FWA's
  single draw price spreads it over all buyers (replaces M2's "the player who wins that prize repays it"). Fees inside
  prizes still listed never exceed one board at the 5 gwei cap → **O2**.
- R24 *(agent wording, M2/M7)*. Unused restocking fees are the creator's: right after closing, everything in the
  Balancer is claimable except the keeper pay held for unreconciled draws (R13) → **O3**.
- R25 *(agent wording, M3)*. Shapes mint fees go to Shapes when a prize is minted and are part of the prize's price →
  checked to the wei in every regime (`FlowBreakdown._done`: mint fees = Shapes minted × 0.001 ETH); no outcome.
- R26 *(agent wording, M6)*. The reserve: a pool cannot open without the cost to restore its design, one largest prize
  per unrecorded draw plus a spare, and keeper pay at the 5 gwei cap, in ETH. No winner is ever unpaid: every listed
  prize holds its own backing → **O4**, **O5**; `test/Reserve.t.sol`.
- R27 *(agent wording, M7)*. Closeout returns everything: after closing, unlisting and withdrawing, the Balancer, its
  listed backing and its FWA proceeds hold nothing; FWA's edge, the randomness fee and Shapes mint fees are one-way;
  refunds FWA owes players stay players' → **O6** (exception: R20).
- R15. D1: "D1 yes: dashboard offers Add ETH and Continue without the prize." D9 ("Yes, all four"): **O5** measures the
  board after either response: no day ends with a prize missing.
- R16. D8 ("Yes, all four"): the fill gate stays; a board with less than 17 × 0.01 ETH Shapes' prize weight pauses
  sales while draws are unsettled, and the planner warns the creator → **O7** (no refusal once draws are reconciled);
  `top_heavy` regime. How long a pause lasts: until the pending draw's randomness arrives and it settles (about 3 blocks
  on the fork), at worst FWA's selection timeout of 30 blocks plus one (about 6 minutes), then anyone processes the
  expired draw and the keeper's next upkeep reopens sales (`top_heavy` fact `pause_worst_case_blocks_before_processing`
  = 31, information).
- R17. D10 ("Yes, all four"): accept the profit-split drift when restocks are listed while draws are in flight → **O9**.
- R18. D11 ("Yes, all four"): the creator's earnings figure is labelled an estimate after a markup change (app only; no
  outcome).

## Players

- R19. D6: "D6: option a. At most 1.5x at normal gas (0.1 gwei or below); show the 1 gwei and 5 gwei ratios as
  information. Do not implement a lower restocking-fee gas cap; keep 5 gwei." → **O10** (`normal_gas` regime, basefee
  0.1 gwei: worst 1.466× before any of 180 draws; the margin is 2.3%). Information: 1.65× at 1 gwei, 2.46× at 5 gwei
  (`test/scenario/PriceCaps.t.sol`).

## Curated NFTs

- R20. D7 *(relayed, then confirmed)*: "i'd defer to do whatever FWA already does, since we're a passhtrough for them for
  this sort of thing"; "D7: stays as decided, follow FWA's rules, no allowlist." **What this accepts, in plain words:** a
  creator who lists an NFT from a collection the creator controls can let FWA deliver it to the winner and then take it
  back; the player has paid (0.0175 ETH measured, draw price and randomness fee) and keeps nothing, the creator's pool
  keeps the draw's proceeds (0.0144 ETH), and FWA has no remedy because it treats a completed transfer as final. A
  collection that refuses delivery costs the player the randomness fee (0.00234 ETH at 1 gwei) and a 7-day wait for the
  refund, which only the player can claim (`test/HostileCollection.t.sol`). → **O6** exception.
- R21. Collection label: "lets just drop that for now." No verified/unverified label in the app.

## Added on review, 2026-11-13

- R28. Final keeper constants (D14, "Yes, all four"): flat reward 0.0001 ETH and overhead allowance 50,000 gas
  (rehearsal receipts: 336 keeper transactions earned 0.000146 ETH each above their billed gas on average).

## Corrections found by the launch audit (2026-11-13)

- To R16 and O7: "then anyone processes the expired draw" names no one. Nothing in the system calls FWA's
  `processAcquisitions`, and a draw whose request reserved a staged restock skips FWA's randomness fast path, so it and
  every draw behind it wait until someone processes (launch audit B, S1; reproduced: 5 draws unsettled 10,000 blocks
  later, sales stopped). FWA's own sponsored processor processed only 2 pools in the last 50,000 blocks. Decision D16 in
  `docs/LAUNCH-AUDIT-TRIAGE.md`.

## Launch-audit decisions (owner, 2026-11-13: "Yes, all three")

- R29. D16: upkeep processes FWA's queue and is paid for it: before reconciling, `performUpkeep` calls
  `processAcquisitions(2)` when draws are waiting, so any paid keeper unblocks a pool → **O13**: with only
  players, randomness and keepers acting, no day ends with a draw unsettled (`no_processor` regime: 539 draws, 179 of
  them lost FWA's fast path, none left unsettled). Corrects R16's "then anyone processes".
- R30. D17: O10 is the launch board at steady normal gas; after a spike prices stay higher until the prizes listed during
  it are won again, and a creator's own markup and NFT values can exceed 1.5×: information → **O10** (restated).
- R31. D18: the game's first 10% of markup refills the reserve while the fund is below it; above the reserve the creator
  may claim everything → **O8** (unchanged).
- R32. D19 (owner, 2026-11-13: "O1: option 1. Restate in gas: refunds kept at most 80,000 gas per draw, as a gate
  fact. No contract change."): processing FWA's queue clears storage, and the keeper keeps refunds the Balancer cannot
  see → **O1**: at most 80,000 gas per draw, averaged over a run. Measured with only keepers processing: 67,660 gas per
  draw at 0.55 gwei, 67,072 at the 5 gwei cap; worst single call 295,284 gas. At the 5 gwei cap, 0.181 ETH over 540
  draws, 7.8% of the creator's net (`no_processor_5_gwei`): information. After the D16 re-attack repairs (DECISIONS 77):
  30,404 gas per draw at the cap, worst single call 100,772 gas, 0.082 ETH over 540 draws, 4.1% of the creator's net.
  With keeper transactions measured fully cold (DECISIONS 83) and after the simplification cuts (DECISIONS 84):
  31,118 gas per draw at the cap (31,051 at 0.55 gwei), 0.084 ETH over 540 draws, 4.2% of the creator's net; in
  bursts that leave five draws waiting (`burst`) 51,606 per draw, worst single call 183,010 gas. Measured with
  Foundry 1.8.1, which CI and the gate now require.

## Audit of 8ec98cb decisions (owner, 2026-11-15: "Accept, reword O9")

- R33. E2 accepted: a creator who raises the markup while draws are unsettled can book profit from the new board for
  a draw priced on the old one, taken from their own reserve (0.00276 ETH in one draw at launch scale; no player is
  affected and every prize stays backed) → **O9** restated: the 0.001 ETH bound holds with the markup unchanged.
- R34. O13's conditions stated: settling needs an open keeper list or an active listed keeper; sales continuing needs
  the creator to relist curated NFTs, which the regimes do → **O13** restated. No contract change.

## Curated NFT pricing (owner, 2026-11-16: "Yes, remove it")

- R35. "when people add the NFTs themselves, they can choose the value for that NFT. So we shouldn't be adding like a
  percentage markup on top of that either": a curated NFT lists at the creator's value; the markup applies to Shape
  prizes only (decision 86).

## Pool size (owner, 2026-11-16: "set max to 200")

- R36. A plan holds 1 to 1,000 prizes by default, the factory admin's `maxPrizes` setting, measured before it was set
  (owner, 2026-11-16: "i'd rather measure now and set it higher"; was 200, decisions 87 and 91).

## Adjustable settings (owner, 2026-11-16)

- R37. Keeper pay, the restocking fee and the prize limit are adjustable: the factory admin sets defaults, a creator may
  adjust their own pool's keeper pay, and only within limits that keep the system working (decision 88).
- R38. No limit on curated NFTs per pool ("if not, don't set one"; decision 89).
- R37 holds through settings changes: an upkeep runs only under the settings its caller priced it on, and a prize's
  restocking fee carries a restock-one upkeep's pay under the settings and gas price of its listing. With restockFlat
  at 0 in force (a creator override or the factory default) the fee measured up to 14k gas short; that is a
  measurement, not a bound, and any shortfall is the creator's cost (decision 90).
  Raising pay settings later costs the creator the difference on prizes listed before, until they are won and
  relisted (owner, 2026-11-16, accepting option A of the 67a9e1e review's E1; decision 92).

## Decisions log (history, not requirements)

- 2026-11-13. "Go ahead with the D3 repair. No push until it has been independently re-attacked."
- 2026-11-13. Merges on the owner's word: PR #3 ("merge"), PR #2 ("Yes, merge PR #2"), PR #1 ("Yes, merge PR #1"),
  PR #4 ("merge").
- 2026-11-13. This file confirmed ("gtg"), then restructured on the audit-process review above.
- 2026-11-13. Restructured version confirmed: "Yes, confirm it".
- 2026-11-13. D12 to D15 decided: "Yes, all four" (O11, O12, keeper constants final, no contract caps; canary is the
  owner's own small first pool).


## Replaceable keeper policies (owner request, 2026-11-17)

- R39. "Keeper payment policies can be changed after mainnet launch without redeploying existing PoolBalancer contracts or migrating creator assets." This applies to pools deployed with the new implementation; older immutable deployments cannot acquire new entry points.
- R40. "Each pool must remain immutable in its asset handling, FWA integration, accounting, work validation, and security limits." Economic quotes alone are replaceable and read-only.
- R41. "The factory should provide a default policy for new pools, but changing that default must not automatically change existing pools." Creator replacement and factory-default changes take two days; eligibility and policy administration have separate roles.
- R42. "A creator should be able to cancel a pending change and disable paid keeper compensation immediately as an emergency action." Policy failure must preserve complete unpaid maintenance and recovery.
- R43. "Do not silently subsidize an increased keeper policy by consuming funds that the system has already committed elsewhere." Activation uses operating capital excluding booked profit and exposes the shortfall. Existing listing prices remain fixed.
- R44. "Implement the architecture completely, including Solidity, keeper service, creator dashboard, planner, simulations, deployment scripts, tests, and documentation. Do not deploy to mainnet or spend real funds."
- R45. "Make necessary engineering decisions independently. Complete the work and report decisions that ordinarily would have required owner input." Implementation choices are recorded in `docs/KEEPER-POLICIES.md`; this authorization does not create an owner cryptographic signature over revised release outcomes.

This request supersedes R10/R28's per-call incentive and R37's immediate mutable factory economics and creator overrides. Their historical decisions above remain intact. The new proposed economic numbers and test evidence need explicit review before launch; no previous outcome signature is represented as approval of new text.

## Capital-efficient reserves (owner request, 2026-11-17)

- R46. "We want creators to launch and operate FWA community pools with as little upfront ETH as reasonably possible." "Do not lock creator capital for hypothetical future keeper calls that have no present funding obligation."
- R47. "Every listed shape or pack retains its actual redeemable backing." "FWA purchasers receive the prizes or refunds owed to them." Lower operating liquidity must not reach purchaser escrow, refund rights or someone else's assets.
- R48. "Uncollected restocking fees are future income expectations. They are never liquid ETH." Preserve distinct markup and surcharge accounting, the first 10% funding priority and the creator's share above it.
- R49. "Some temporary inventory depletion may be acceptable." "Do not silently degrade the experience or report the pool as fully funded when it is missing prizes." Define safe admission, partial restocking, actual funding shortfalls and recovery that may require Add ETH or a smaller target.
- R50. "Keepers should receive their quoted compensation for successfully completed paid operations." Reserve current planned setup and outstanding work rather than an entire theoretical future maintenance cycle. Immutable work-sensitive enforcement and atomic caller floors remain authoritative.
- R51. "Keep the two day delay, emergency payment disable, immutable payout safeguards, and public unpaid recovery path." A policy switch preserves old listing prices and rechecks genuinely required current working capital.
- R52. "Calculate the total attacker economics for manufactured work, including the creator, buyer, and keeper under coordinated control." Close the previous low-gas hostile-policy measurement gap through actual dependency paths; distinguish coalition-wide costs from subsidies borne by creator capital.
- R53. "Run the complete Foundry, TypeScript, keeper integration, economic simulation, and asset flow verification suites against the final candidate." Independent security and economic reviews must challenge rights, cash versus expectations, continuity and unrealistic automatic top-ups.
- R54. "Make the best engineering decisions independently, implement them, and verify the outcome." "Do not deploy to mainnet or spend real funds."

This request supersedes R26's duplicate-largest-prize and full-future-board insurance guarantee, and the corresponding reserve mechanism in decision 95. Existing price, custody, player refund, profit allocation and policy authority requirements remain. Changed numeric outcomes remain unsigned until the owner explicitly signs them for release; implementation authority grants no deployment authority.

## Audit response and concurrency (owner direction, 2026-11-17)

- R55. "Do not implement the one batch at a time restriction." "Preserving concurrent purchases and minimizing downtime are more important than achieving perfectly precise purchase time profit attribution."
- R56. "We previously accepted bounded profit allocation drift, and I don't want to reverse that decision just to simplify accounting." "Keep the existing FWA admission behavior and focus on the original objective: reducing the reserve and initial capital requirements as much as safely possible."
- R57. "If exact profit attribution is genuinely necessary for the new reserve design, first demonstrate why the existing bounded approximation is insufficient. Explore a conservative allocation that avoids overcrediting creator profit, or another solution that doesn't restrict purchases."
- R58. "Do not introduce a new purchase bottleneck or make every batch dependent on keeper maintenance. Quantify any remaining accounting drift and prove that the reduced reserve remains safe under the existing concurrency model."

This rejects the proposed serialized-cohort mechanism. It does not sign revised outcomes or make the fixed O9 seed's 0.001 ETH observation a proven bound for all permitted boards and policies. Purchaser custody and refund requirements remain unchanged. Any changed numerical acceptance requires an explicit owner decision against measured results; no larger tolerance is silently substituted.

## Release follow-up (owner, 2026-11-17)

- R59. The owner requested completion of "dashboard/wallet interaction testing, a rehearsal of this revision, current whole-candidate audit evidence and numerical outcome approval" and requested a fix to "treating the old 0.001 ETH drift bound as universal." Scope O9's existing numerical check to its named fixed-input regression; do not present it as a general bound. Prepare the current measured approval proposal for the owner's decision. This request does not supply an outcome signature or authorize a public-network broadcast.

- R60. "Yes, make the local-only gate change, keep production gates intact, and prepare the exact batch for my approval." (2026-11-18.) The prepared isolated local diagnostic may use its own exact-plan/process/chain/budget preflight without production outcome signatures or a completed whole-candidate review. The default production route retains those gates. This authorizes implementation and read-only preparation, not funding or broadcasting the proposed batch.

- R61. The owner requested "make sure everything is merged into main" and replied "yes approved" (2026-11-18). The lead explicitly treated that reply as approval of the pending exact local batch `7b18522f49bd0809180bc7643969ffcc32d07d4d44e259053d926112f244a236` before execution, while completing the separately authorized main integration. That run interrupted after nine successful local transactions. Approval is not transferred to changed material or a replay; no public-network, real-fund or production-outcome approval follows.


## Protected collected revenue and atomic creation (owner request, 2026-11-18)

R62 through R69 are settled implementation requirements from the attached implementation brief. They supersede
conflicting historical text above, particularly R6/R7/R17/R18/R31/R33/R48/R56's historical markup attribution,
allocation drift and game-first unpaid spending. Earlier signatures, source seals and outcome measurements remain
historical. This implementation authority does not sign new release outcomes or authorize mainnet actions.

- R62. Creators receive a stored **0 to 10,000 bps** of actual collected FWA owner proceeds. Each collection adds
  `floor(collected * creatorRevenueBps / 10000)` credit once. Deposits, direct ETH, unlisting/redemption, recovered
  backing, uncollected proceeds and purchaser escrow/refunds create **zero** credit. Rounding stays operating cash.
- R63. **Both paid and unpaid maintenance protect all creator credit**, including when a **1 ETH or 100 ETH** prize
  is missing. Credit-only claims require **zero** policy, reserve, mint-fee, collection or inventory reads.
  `B >= C`, `O=B-C`, withdrawable=`C+max(O-R,0)`. **0.20 ETH balance, 0.02 credit, 0.10 reserve permits 0.10 total**.
  Closing preserves credit and late collections retain the stored split.
- R64. A percentage change is explicit: collect available proceeds at the old percentage, store the chosen new
  percentage, then use it for subsequent collections, including earlier pending purchases. Ordinary inventory,
  markup, target, gas and policy changes never recompute it. No purchase cohorts or rate snapshots are introduced.
- R65. The shared planner suggests the initial rate from intended Shape markup above the first **10%**, divided by
  actual expected owner proceeds, using real prices, weights, fee treatment, packs and integer rounding. Curated
  listings contribute zero intended allocation. Store the exact reviewed bps. Show allocation, retained revenue,
  replacement/mint/keeper costs and margin/shortfall; allocation is not overall realized profit.
- R66. Keeper algorithms remain replaceable through `quoteReward(Work)` and `quoteRestock(denom,units,basefee)`.
  Remove optional Settings metadata and duplicate paid APIs. Retain only paid `(hash, minimumFixed, minimumGas)` and
  unpaid upkeep, bounded static calls, exact data checks, immutable caps, **two-day** delay, cancellation, emergency
  disable, generation invalidation and persistent allowance. Policies cannot move assets or alter credit/rates.
- R67. Activation compares old/candidate maintenance budgets from one current snapshot. Disabled means old paid
  exposure **zero**. No-greater exposure can activate during inventory depletion; increased exposure needs the
  **full candidate** maintenance budget in operating cash. Keep full inventory restoration in the withdrawal reserve.
- R68. After predicted-address NFT approvals, **one transaction** deploys/configures/funds/lists the initial curated
  batch and enters stocking. Derive creator/NFT source from factory caller, protect initialization, revert everything
  on failure. Mint **zero** Shapes at creation; retain **five Shape units/four sizes** per upkeep and **20 curated
  items per batch**, with no new total curated cap. Purchases wait until initial stocking completes.
- R69. Remove inventory attribution, historical allocation markup fields, unsold-fee accumulator and partial-creation
  compatibility states. Current controls load independently of history. Preserve concurrent purchases, staged
  replenishment/admission, actual backing, FWA settlement/refunds, separate collection and creator shutdown/recovery.
  Complete focused implementation, verification, local commits and a draft PR. No public deployment, real expenditure,
  production configuration changes or merge is authorized.

## Focused frontend and candidate rehearsal follow-up (owner, 2026-11-18)

- R70. "Fetch the current PR head first, preserve any subsequent fixes" and "Complete the focused frontend corrections, documentation corrections, and remaining candidate rehearsal" for PR 10, branch `codex/creator-credit-atomic`, reviewed at `51dd7b7`. Preserve the accepted contract accounting, policy, activation and atomic architecture. "Local testing, browser verification, and a fresh bounded rehearsal on an owned isolated fork with synthetic funds are authorized." "Resolve routine choices independently and update the existing PR." Do not merge, deploy publicly, spend real funds or change production configuration. New candidate plans/evidence must retain their own source and action bindings; historical approvals remain limited to their original material.

## Focused independent audit repairs (owner, 2026-11-18)

- R71. "Implement E1, S2 and the dashboard fix in a new PR. Use pool-lifetime operating results, preserve donor and policy rights, and verify admission safety, liveness and gas limits. Don't merge or deploy." E1 and S2 refer to the staged-curated admission and generic wallet-confirmation findings in the supplied independent audit of `cc35dce026d42e5263997f54531015367e98d866`. This is focused implementation authority, not a new release outcome signature or permission for a deployment.
- R72. The owner explicitly selected "Approve bounded proof refresh" after review of the admission tradeoff: retain the **100,000-gas** FWA hook, uncapped curated inventory, direct FWA purchases and concurrent draws. Losing the cached curated witness may pause purchases until any caller proves another active curated listing in **one nonpayable transaction**. Staged-only curated inventory first needs public FWA activation. The caller bears gas; pool funds, keeper rewards, donor rights and policy rights do not change. This narrowly supersedes earlier no-synchronization language for ambiguous curated-presence proof. It does not serialize batches or require keeper maintenance after each batch.

## ETH contributions (owner, 2026-11-19)

- R73. ETH sent to a deployed Balancer through `depositETH()` or a plain transfer, including by a non-creator,
  is an **irrevocable contribution to pool capital**. ETH sent to its predicted address before deployment becomes
  pool capital under the same rule **if the clone is later deployed there**; until then no Balancer holds it, and
  deployment is not guaranteed. The sender receives no creator revenue credit, contributor share, refund entitlement,
  protocol withdrawal or recovery claim, or withdrawal authority. The pool may use the funds under its existing rules.
  The current creator may claim available surplus under the protected-credit and reserve rules, immediately if surplus
  exists; there is no promised holding period. A contributor address in an event or dashboard is attribution only.
  Contributions are capital transfers excluded from the dashboard's operating result. The creator may voluntarily
  return available funds, but the sender cannot require it through the protocol. This clarifies and supersedes any
  suggestion in R71 or R72 that “preserve donor rights” grants a donor refund or withdrawal right; it leaves purchaser
  refunds, creator credit and keeper/policy rights unchanged. No new numerical outcome is approved.

## Optional curated NFTs and creation controls (owner brief, 2026-11-20)

Source: the owner's brief "Complete the Shapes Pool Balancer product design corrections" (merged as PR 24, `28b53ad`).
Player pricing, markup minimums, FWA/VRF fees and expected-return logic are excluded ("item #3") and unchanged. No new
numerical outcome is approved here; the updated outcomes in `asset-flow.json` await the owner's signature.

- R74. Curated NFTs are optional: a pool may be Shapes-only, mixed, or move between the two over its life. "Creating a
  pool with an empty curated array must work." Curated NFTs stay creator-supplied, first-class prizes; no placeholder NFT
  and no automatic purchase of curated NFTs. Curated-only pools are out of scope.
- R75. Two modes, chosen by the creator. **Standard** (the default): after the last curated NFT is won or withdrawn,
  Shapes keep selling under the normal admission checks. **Curated-required**: purchases pause while no active curated
  NFT can be proven; the staged-witness rule (R71, R72) and `refreshCuratedWitness()` still apply. The creator can change
  the mode after creation, and admission reflects it immediately. Narrows R72's curated-presence proof to
  curated-required mode.
- R76. No hidden minimum of the smallest denomination: any valid Shapes/Pack mix with at least one prize, within the
  contract's maximums and funding. Fewer permitted concurrent draws from the 70% weight gate (R16) are shown, not
  prevented.
- R77. Creation takes an explicit `creatorRevenueBps`; the markup-based value is the suggested default. It is set in
  the atomic creation transaction and later changes only through the existing explicit operation.
- R78. A Shapes mint fee above `mintFeeCap` stops minting (paid and unpaid upkeep), not purchases of listed prizes.
  Depletion still pauses sales through the weight gate; the creator may accept a new fee through `configure`.
- R79. Exception to R3 (owner, 2026-11-20: "Keep it", after rc-28b53ad finding 2): the dashboard's mainnet reads may
  fall back to `https://ethereum-rpc.publicnode.com`, then to the connected wallet's own provider, when Tenderly
  refuses. Reads only; tests, scripts, keepers and broadcasts stay on Tenderly per R3.

## Simplification before mainnet (owner brief, 2026-11-20)

- R80. "Withdrawal reserves use the accepted mint fee": `r.mintFee = mintFeeCap`. Minting only at or below the cap
  (paid and unpaid upkeep); listed prizes keep selling under the normal admission checks; the creator accepts a higher
  fee through `configure` and the reserve then updates; backing, protected creator credit and purchaser refunds are
  unchanged; no new fee states, automatic cap changes, funding buckets or options. Supersedes the reserve half of
  DECISIONS 46/70 ("the higher of the live fee and the accepted one").
- R81. The prize designer keeps one 16-size counts array as the only record of the mix. Presets compute a composition;
  hand edits and the pool-size control change the same array; a custom mix may have no 0.01 ETH Shape. Presets keep
  their results. Remove Solidity with no current purpose, without changing ABI, storage, formulas or behavior. Player
  pricing, FWA/VRF fees, markup minimums and expected-return presentation are out of scope.


## Launch audit at 2d9d16b (owner, 2026-11-22: "Accept E1, fix app")

- R82. R67's "full inventory restoration in the withdrawal reserve" applies to reconciled inventory. Between a
  delivered win and the upkeep that reconciles it, the reserve still counts the won prize, so the creator may claim
  that capital (step B measured 100 ETH claimed against a 0.00508 ETH reserve, then a 100.005 ETH reserve). Accepted:
  only the creator's own capital moves, and `close()` or a smaller `configure` target reaches the same claim at any
  time. No contract change. The app and keeper findings of the same audits are fixed.
- R83. No mainnet canary (owner, 2026-11-22: "i don't want to do the canary!!!"). Launch goes from the signed
  outcomes and the recorded review straight to the production deploy through `script/deploy.sh`; no capped first
  deployment or cap-raising plan. Supersedes the canary step of runbook 0b E for this launch.

## Community release (owner brief, 2026-11-23) — Phase A in progress

The community-pool release brief (`scratchpad/community-release-spec.md`, Part B overrides Part A) is the
current product direction and deliberately changes earlier decisions. Authoritative configuration inventory,
economics design and per-requirement status: `docs/CONFIG-INVENTORY.md`.

- R84. **Fill gate is a creator setting** `fillGateBps` (0..10000, default 7000); zero removes the
  target-fill requirement but keeps the conservative unavailable-inventory check (Part B §2). No factory
  minimum. Implemented (`PoolBalancer.setFillGateBps`, `PoolInventory.admission`). Supersedes the fixed 70%
  gate and the earlier proposal to put the gate on the factory.
- R85. **Backlog threshold is a creator setting** `backlogThreshold` (>=1, default 5), independent of FWA's
  per-transaction batch cap `MAX_BATCH` (Part B §3). A threshold `T` can allow up to `T+MAX_BATCH-1`
  outstanding draws. Implemented (`PoolBalancer.setBacklogThreshold`). Clarifies that five was never an
  absolute outstanding-draw cap.
- R86. **maxPrizes initial value is 1000** (new brief §4.1, factory-administered), reaffirming the value in
  the current `validateTarget`. Note: this supersedes the earlier "set max to 200" (2026-11-16) for the
  community release; recorded as a discrepancy to confirm. Implemented in slice A2 (R89).
- R87. The economics rework (factory EconConfig, pin/local/follow, creator-tunable bucket, one resolver,
  fee-sensitive hash), deploy reuse path + legacy preflight, CI fix and the permanent acceptance suite are
  **designed, not yet implemented**. See `docs/CONFIG-INVENTORY.md`. (Delay removal, the accepted-mint-fee
  binding and product limits are implemented: R88-R90.)
  **Status (2026-11-23): implemented** on `claude/community-release` (slice A3 `ede97c4`, deploy reuse path and
  readbacks `505d93d`, CI `afbd981`, acceptance suite `42118c2`; creation hash also binds the default bucket,
  review S3). The text above is the earlier status, kept as history. Release readiness is not implied.
- R88. **No policy delays** (spec §3). `BalancerFactory.setDefaultKeeperPolicy` (policyAdmin), pool
  `setKeeperPolicy` (creator) and `setPaidUpkeepEnabled(true)` (creator) take effect in the authorized
  transaction. Pool changes keep the maintenance-funding check (a larger maintenance exposure than the current
  one must be funded; missing prizes never are). The per-pool spending bucket is kept unchanged and no change
  refills it; `policyGeneration` advances on every policy/paid change so a disable/re-enable cycle changes
  `settingsHash`. Only the creator can re-enable a stopped pool; no factory change does. Supersedes the two-day
  default-policy delay, the two-day pool-policy delay and the delayed re-enable (D42-era timelocks).
- R89. **Factory product limits** (spec §4.1/§4.3): `productLimits() = (maxPrizes 1000, minMarkupBps 1000,
  maxMarkupBps 10000)`, set together by `setProductLimits` (policyAdmin, immediate, `ProductLimitsChanged`).
  `maxPrizes` counts the target's Shape and Draw Pack prizes, never curated NFTs. Limits bind newly submitted
  designs (creation and `configure`) only. **Rule for a pool beyond a lowered limit:** a design may have up to
  `max(current target prize count, maxPrizes)` prizes, and may keep its current markup even if it is now out of
  range; any other markup must be in range. Upkeep, recovery, withdrawals and existing prices never consult the
  limits. Bounds are storage widths (`maxPrizes` 1..65535, `minMarkupBps` 1..`maxMarkupBps`, `maxMarkupBps`
  ..65535), not product preferences.
- R90. **Accepted mint fee binds** (spec §7): `configure(markupBps, target, acceptedMintFee)` reverts
  `InvalidConfig` if the live Shapes fee is above `acceptedMintFee`, and stores it as `mintFeeCap`; creation
  already bound `CreationConfig.mintFeeCap`. A lower fee can be accepted with the same design. Upkeep mints at the
  live fee while it is at most the cap; above it, minting stops and purchases of listed prizes and recovery
  continue; the reserve prices missing prizes at the cap. The app offers the save whenever the live fee differs
  from the cap (higher or lower) and passes the fee it shows.
- R91. **One keeper economic configuration** (slice A3; spec §2, §4-§6, B§1, B§4). Factory `economics()` /
  `setEconomics` (policyAdmin, immediate, constant work) holds the algorithm, the V1 pricing numbers and the
  per-operation gas bounds; the 0.311 ETH, 0.102 ETH, 50 gwei and other enforcement literals are removed. Pools follow
  by default, or the creator sets local economics, pins the complete effective configuration, or resumes following.
  Supersedes R88's "policy" wording: a policy is now an algorithm inside the economics; `setKeeperPolicy` keeps the
  paid-upkeep state (it no longer re-enables).
- R92. **Per-pool spending bucket is a creator setting** (spec §5): `setKeeperBucket(capacity, refill)`, initial
  0.622 ETH and floor(0.05 ETH / 12) wei/s from factory defaults; accrual rules as in the brief; nothing else resets it.
- R93. **Settings hash covers the live Shapes mint fee** and binds creation and paid upkeep (spec §6).
- R94. **Measured recalibration of two V1 numbers** (spec §10): overhead 50k → 60k gas and restocking gas 900k →
  910k per Shape, so a paid call's reimbursement covers its billed gas and a replacement's surcharge covers the call
  that lists it at the 5 gwei ceiling. Derived maxima 0.0165 ETH per payment and 0.00475 ETH per Shape (V1: 0.01645,
  0.0047). **Owner visibility:** these differ from the brief's V1 list; both are factory settings and can be set back.

## Audit repair decisions (owner, 2026-11-23)

Owner decisions D1-D3 after the independent audit of the community candidate `be50aa0`. They supersede R39-R45's
replaceable policy, R66's replaceable `quoteReward`/`quoteRestock` interface, R88/R91's policy wording and R91's pin
mode. Earlier text above is kept as history. No numerical outcome signature follows from them.

- R95. **One payment formula, inside the library (D1).** No external keeper policy in the money path. Pay and restock
  prices come from the pool's effective economics by the V1 formula: reward = (min(measured gas, operation gas bound,
  maxGas) + overheadGas) x min(tx gas price, basefee + priorityAllowance, gasPriceCeiling) + workFee x (processed +
  reconciled draws + listed Shape units); restock price per Shape = restockGas x min(basefee + priorityAllowance,
  gasPriceCeiling) + restockFlat. Unpaid callers use the same formula. Every numeric economics field, the processing
  graces, the bucket, follow/local, `settingsHash`, the paid-upkeep switch and the maintenance-funding checks stay.
  **Changing the payment formula requires a new release** (supersedes R39's policy replacement).
- R96. **No contract pin mode (D2).** Two modes: follow the factory, or local values. "Pin" is an app button that reads
  the factory's current economics at the reviewed block and saves them with `setLocalEconomics` in one transaction,
  labelled "Pin current factory values", explaining that it freezes those numbers. `settingsHash` = economics + source
  + generation + paid state + Shapes mint fee.
- R97. **Trusted factory admin (D3; recorded 2026-11-23 in DECISIONS "trusted factory admin").** Pools that follow the
  factory adopt its economics immediately; no safeguard against admin updates.
- R98. **Default bucket (D3).** 0.622 ETH capacity, `floor(0.05 ether / 12)` wei per second refill (R92 unchanged).
- R99. **Paid processing of stuck draws only (D3; DECISIONS "paid processing of stuck draws only").** Upkeep processes a
  stuck head (Ready, TimedOut, or Pending with `block.number > wordDeadlineBlock`) only 50 blocks after its request
  block, 10 while purchases are paused BUSY or LOW_INVENTORY, at most 2 per call, paid gas plus a work fee per
  processed draw.

## Outcome bounds after the audit repair (owner, 2026-11-23: "approved")

The owner approved three new numerical outcome bounds in `asset-flow.json`. The owner's SSH signature over the new
outcomes hash is still required; this record is not that signature.

- R100. **O1 keeper refund gas kept per draw: at most 100,000** (was 80,000). Cause: paid processing of stuck draws
  (R99) keeps FWA's storage refunds; measured worst 96,590 (`burst`).
- R101. **O2 restock fees still listed: at most 0.2613 ETH** (was 0.26 ETH). Cause: restock gas 910k (R94), 55 Shape
  units x 0.00475 ETH = 0.26125 ETH at the 5 gwei cap.
- R102. **O15 opening requirement: exactly 0.229565 ETH** (was 0.2356 ETH). Cause: one fee schedule (slice A3:
  3.2M gas, 60k overhead gas, 0.00002 ETH work fee).
- R103. **E1 edge (fix, no new rule).** The inventory check refuses only while draws are outstanding
  (`lost != 0 && prizeWeight <= lost`): fill 0 with no outstanding draws and no Shapes listed is admitted, since
  nothing is at risk. The fill-gate percentage check is unchanged.

## Accepted behaviors after the second independent audit (owner, 2026-11-23: "yes go")

Accepted and documented; no contract behavior change and no outcome bound changes.

- R104. **Batch overshoot (A1).** FWA consults the pool's purchase gate once per `acquireBatch` of up to 5 draws
  (MAX_BATCH). On a nearly empty board up to 4 draws of one purchase can find no prize; FWA refunds their draw price
  as pull credit, and the buyer's randomness fee for those draws is not refunded. The `PoolInventory.admission`
  comment states this per-purchase check; the app's purchase-pauses view states it as a fact.
- R105. **Restocking charge outside the markup range (A2).** Economics fields have width-only bounds (R89, R95), so a
  creator's local `restockGas` and `restockFlat` can raise Shape listing prices beyond the markup range; the markup
  limits do not cap the restocking charge. Where local economics are edited, the app shows the resulting charge per
  Shape at the gas price ceiling for the entered values (`restockGas x gasPriceCeiling + restockFlat`).

## Community keeper service (owner, 2026-11-24)

- R106. Host the existing community-pool keeper on **Fly.io**, for factory
  `0x526FbD402624B50861f54c081B592cdCeE322929`, starting at block `26482707`, using
  `https://mainnet.gateway.tenderly.co`. Persist state, restart on failure, expose health checks, and document owner
  operations. This service targets this factory only (`LEGACY_FACTORIES=0`). No contract economics change.
- R107. Use a fresh dedicated, nondelegated EOA, created and funded by the owner. Owner choice: **0.01 ETH funding**.
  The owner puts its key directly in the host's secret store; no key is supplied through chat, files or command arguments.
- R108. **`MAX_LOSS_WEI=0`, `MAX_GAS_PRICE_GWEI=1.5`, no cumulative spending cap.** Owner rejected the proposed
  `CANARY_PLAN`: "don't cap it". Zero modeled subsidy does not eliminate reverted-transaction gas or guarantee profit.
- R109. **Better Stack email alerts** for availability, stale ticks, low keeper balance and repeated stuck pools.
  The implementation uses a 2-minute stale threshold, a 0.007 ETH balance threshold and the existing `STUCK_TICKS=5`.
- R110. Build in a worktree and prepare a PR. Pushes, merges and deploys require the owner's go. Deploys run only
  from `/Users/dd/CascadeProjects/fwa-pool-balancer` on `main`, fast-forwarded to `origin/main`. Funding, setting secrets
  and starting the mainnet service remain owner actions. Fork acceptance reuses port 8545; it must never kill that node.


## ERC20 recovery and creation pause (owner, 2026-11-25)

- R111. Owner annotation "add it" on the excluded ERC20 rescue, following the proposed creator-only recovery rule:
  add recovery of ERC20 balances held by the Balancer to its current creator. Third-party transfers create no
  separate depositor claim; operating ETH, credits and assets held by FWA remain outside this path.
- R112. Owner annotation "add this too" on the missing factory creation pause: add a policy-admin public creation
  pause to new factories. Implementation starts paused and permits the policy admin's own canary while paused;
  existing pool operations and exits continue. The existing factory is immutable, so this requires a replacement
  factory to become available onchain. No broadcast, new spending budget or migration is authorized by this record.


## Focused inventory-update release gate (owner, 2026-11-25)

- R113. "narrow the release gate to the focused checks for this update and do the remaining review and regressions. keep the full economic campaign separate and commit along the way." The inventory/batch/recovery/pause release uses asset-flow-focused.json; asset-flow.json retains the unchanged full economic campaign and its approved outcomes. Focused acceptance does not establish the monthly economic claims. Existing owner-signature, exact-source review, deployment authority and live-canary controls remain.

## Cost-first creator proceeds (owner, 2026-11-25)

- R114. "implement cost-first profit withdrawals. cover restocking, mint fees and keeper costs before creator earnings, and don't count deposits as profit. update the UI and tests and commit it. no mainnet deployment." This supersedes R62–R65 for the new implementation; existing immutable clones retain their accounting.
- R115. Owner approved the game-first creator-proceeds model: a **1 ETH deposit creates 0 earnings**. If **0.02 ETH** of settled receipts leaves **0.015 ETH** after actual game costs, at most **0.015 ETH** can be withdrawn once reserves and contributed native ETH capital are covered. Mint fees, keeper payments, automatic prize backing delivered to players and prior operating losses reduce proceeds before withdrawal. Closing permits separate capital recovery.
- R116. Curated NFT listing prices create **0 ETH debt** to the creator. A curated NFT listed at **1 ETH** does not establish a **1 ETH** acquisition cost or claim; personal NFT investment profit is outside the contract. Repricing, listing and returning a curated NFT do not create earned ETH.
- R117. There is **no manually configured earnings percentage** in new clones. Markup and prize mix determine pricing and a projection of cash margin; only actual settled economics determine earned proceeds. Historical clones remain identified per clone. Local source implementation, focused verification and commits are authorized; no mainnet deployment or switch is authorized.


## Automatic creator fees and optional replenishment (owner, 2026-11-25)

- R118. Owner accepted restoring automatic creator compensation from settled draw receipts, separately from bankroll profit/loss. The share derives from markup and intended automatic prize mix plus active curated mix: markup above the first **10 percentage points** funds the creator allocation. No manually set earnings percentage. This supersedes R114–R115 and R117 only where they previously required every prior bankroll loss to be recovered before any creator fee accrues. Deposits still create **0 earnings**, and R116's no invented curated cost basis remains.
- R119. Owner: "top it off with my profits" and "It shouldn't like dump all the profit in there". Provide **Top up from creator fees**. Reinvest exactly `min(current refill shortfall, accrued creator fees, approved maximum)`: a **0.02 ETH** shortfall with **0.05 ETH** fees uses **0.02 ETH**, retains **0.03 ETH** in fees and transfers **0 ETH** between wallets. These are illustrative arithmetic, not a measured current-pool outcome. Fees stay protected until withdrawal or explicit reinvestment; reinvestment becomes contributed bankroll capital and creates **0 new profit**. Closed pools may fund reopening; retired pools have **0** reinvestment allowance.
- R120. Open-pool withdrawals retain the restocking, accepted mint-fee and keeper reserve. A reserve shortfall permits **0 ETH** withdrawal, even if fees have accrued. Separate accrued creator fees, reserve-gated withdrawals and bankroll profit/loss in the UI. Creator fees are gross compensation, not a promise of positive total investment return.
- R121. Implement, verify affected paths, update the UI and commit. **No deployment** is included in this follow-up. Existing immutable v0/v1 pools retain their code and accounting. Collection epochs preserve settled receipts at the old effective rate before a design change; pending draws or unactivated listings defer rate changes. This is approximate mix allocation, not per-ticket rate attribution.
