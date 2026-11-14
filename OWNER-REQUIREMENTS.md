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
  creator's own setup work counted, −0.020 ETH at 5 gwei (setup 0.14 ETH); NFT-dominated boards −0.025 to −0.035 ETH for play
  (an NFT win brings no fee).
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
  With keeper transactions measured fully cold (DECISIONS 83): 31,105 gas per draw at the cap (31,039 at 0.55 gwei),
  0.084 ETH over 540 draws, 4.2% of the creator's net; in bursts that leave five draws waiting (`burst`) 51,591 per
  draw, worst single call 182,980 gas.

## Decisions log (history, not requirements)

- 2026-11-13. "Go ahead with the D3 repair. No push until it has been independently re-attacked."
- 2026-11-13. Merges on the owner's word: PR #3 ("merge"), PR #2 ("Yes, merge PR #2"), PR #1 ("Yes, merge PR #1"),
  PR #4 ("merge").
- 2026-11-13. This file confirmed ("gtg"), then restructured on the audit-process review above.
- 2026-11-13. Restructured version confirmed: "Yes, confirm it".
- 2026-11-13. D12 to D15 decided: "Yes, all four" (O11, O12, keeper constants final, no contract caps; canary is the
  owner's own small first pool).
