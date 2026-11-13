# Owner requirements

The owner's requirements for the Shapes Pool Balancer, in the owner's words where we have them. Each points at the
outcome in `asset-flow.json` that measures it. Later decisions are appended, never rewritten. Audit and review requests
point here instead of restating requirements.

**Status: DRAFT for the owner to confirm (2026-11-13).** Marked lines:
- *(relayed)*: the owner's decision reached us through another session, not in the owner's own words here.
- *(agent wording)*: written by an agent from the owner's words; the owner has not approved the wording itself.

## Authority and safety (2026-11-10, owner)

- R1. "You do not have authority to deploy to Ethereum mainnet, spend real funds, access production secrets, alter
  existing production contracts, or publish a live application under my accounts."
- R2. "Do not deploy to Ethereum mainnet until I authorize it."
- R3. "Always use Tenderly's public RPC URL for Ethereum mainnet: `https://mainnet.gateway.tenderly.co`."

## The system (rounds 1 to 8, `docs/AUDIT-PROMPT.md`)

- R4. "we need to make this so it never loses money with keepers"; "The markup is where they make money"; "obviously
  we need this thing to function"; "the gas at listing time != gas at draw time".
- R5. The keeper list is "on the factory", "open at default", and no creator should have to update their pool
  individually.
- R6. "this needs to be like a self-sustaining system"; the revenue restocks the prizes "and then the creator gets the
  profit"; "protect the game first, profit after" but "not always have the game eating the profit for the creator".
- R7. The minimum markup is the game's share: "if the min for a setup is 10%, and they choose 30%, then shouldn't it be
  1/3 - 2/3?" → O8.
- R8. Product goal *(agent wording)*: the pool stays open through ordinary mainnet gas up to 5 gwei, funds itself from
  sales, is profitable for the creator in expectation, at a draw price players will accept → O7, O10.
- R9. Exact redeemable backing *(agent wording, money goal M4)*: every prize holds its backing and returns to the pool
  at exactly that value when unlisted or recovered → O4.

## Keeper pay (2026-11-13)

- R10. Option B *(relayed)*: keepers are paid for every useful upkeep (one that reconciles a draw or lists a prize)
  from the creator's ETH, at gas plus a small flat reward; a call that does nothing is paid nothing. The 0.0001 ETH
  reward and 50,000-gas overhead are provisional. Replaces M1 ("the markup is never spent on keepers") → O1.
- R11. D2: "D2 yes: accept, limit 0.002 ETH per 180 draws": keepers keep the storage refunds on top of gas → O1.
- R12. D4: "D4 yes: accept and budget one paid call per processed draw; fix the comment." → O1 (budget), no gate
  outcome for the split itself.
- R13. D3: "D3 yes: repair it. Hold back keeper pay owed for unreconciled draws while closed." → O3.

## Fees, reserve and prizes (2026-11-13)

- R14. D5: "D5 yes: reword to 'all buyers fund restocking fees'." Replaces "the player who wins that prize repays it"
  (M2) → O2.
- R15. D1: "D1 yes: dashboard offers Add ETH and Continue without the prize." D9: "Yes, all four" (O5 measures the
  board after either response) → O5.
- R16. D8: "Yes, all four": keep the fill gate; boards with little prize weight pause while draws are unsettled; the
  planner warns; a top-heavy regime measures it → O7.
- R17. D10: "Yes, all four": accept the profit-split drift with restocks in flight → O9.
- R18. D11: "Yes, all four": the earnings figure is labelled an estimate after a markup change (no outcome; app only).

## Players (2026-11-13)

- R19. D6: "D6: option a. At most 1.5x at normal gas (0.1 gwei or below); show the 1 gwei and 5 gwei ratios as
  information. Do not implement a lower restocking-fee gas cap; keep 5 gwei." → O10, measured outside the gate
  (`test/scenario/PriceCaps.t.sol`, `test/audit/NormalGasBoundary.t.sol`: 1.46× to 1.47×), because no gate regime runs
  at 0.1 gwei.

## Curated NFTs (2026-11-13)

- R20. D7 *(relayed, then confirmed)*: "i'd defer to do whatever FWA already does, since we're a passhtrough for them for
  this sort of thing." Confirmed: "D7: stays as decided, follow FWA's rules, no allowlist." Failed deliveries follow
  FWA's verified rules; no allowlist → O6 (exception).
- R21. Collection label: "lets just drop that for now." No verified/unverified label in the app.

## Process (2026-11-13)

- R22. "Go ahead with the D3 repair. No push until it has been independently re-attacked."
- R23. Merges: PR #3, PR #2 and PR #1 were each merged on the owner's word ("merge", "Yes, merge PR #2", "Yes, merge PR #1").

## To confirm

1. The whole file, in particular R8, R9 and R10 (agent wording or relayed).
2. Whether the money goals M1 to M9 in `docs/AUDIT-PROMPT.md` should be restated here line by line, or stay there with
   this file taking precedence where they differ.
