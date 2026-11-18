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
