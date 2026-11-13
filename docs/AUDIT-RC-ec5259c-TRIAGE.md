# Triage: Codex release-candidate audit of `ec5259c`

The report is `audit/rc-ec5259c/REPORT.md` (copied from the audit worktree, unchanged). The audit ran 20.65 minutes,
read-only, on the pinned mainnet fork. These are triage notes for the owner; no contract source has changed. All
numbers are from the mainnet fork at block 26,382,349, with basefee 0.5 gwei and bid 0.55 gwei asserted inside a
transaction, unless stated otherwise. "Repro" is what I ran on branch `test/flow-restock-in-flight`.

## Findings

| # | Finding | Known? | Codex basis | Repro | ETH at launch scale | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Two 0.5 ETH wins leave the top prize unstocked (119 keeper passes) | Known: O5 / E9 | executed | yes: `large_win`, 119 passes, 20 of 30 days without it, 1.052 ETH peak shortfall, 0 draws refused | 0.963 ETH to restore it at once | **Owner decision D1** |
| 2 | Keepers are paid on gas before refunds; the test measures gas after them | Known: O1 | executed | yes: 0.00148 to 0.00161 ETH in total per 180 draws, worst `restock_in_flight` | ≤ 0.002 ETH per 180 draws | **Owner decision D2** |
| 3 | After `close`, the creator can claim every wei, so a later useful reconcile is paid 0 | **New** | executed | **yes**: `test_postCloseReconcileAfterFullClaimIsUnpaid`, which reconciled 5 expired draws using 143,691 gas and was paid 0. The rule would pay about 0.000207 ETH at 0.55 gwei, 0.00107 ETH at 5 gwei | Unpaid work up to 0.016 ETH per call. No assets lost: the creator can run it | **Repair (D3)** |
| 4 | Restocking fees are paid by every buyer through FWA's single pre-draw price, not by the winner of that prize | **New** (wording) | reasoned, with independent arithmetic | not run; follows from FWA's pricing (`weightedBackingTotal / totalWeight`, confirmed to the wei in `restock_in_flight`) | about 0.000999 ETH of every draw's price, including NFT wins | **Owner decision D5** (outcome wording) |
| 5 | At 5 gwei, a draw on a freshly listed board costs 0.0407 ETH including the randomness fee, for about 0.0170 ETH of expected backing | **New** (economics) | reasoned and partly price-tested | not run | 2.46× the expected Shape backing at 5 gwei, 1.55× at 0.5 gwei (0.0244 ETH); measured in `docs/OWNER-DECISIONS-D6-D7.md` | **Owner decision D6** |
| 6 | Anyone can split one ready batch into five paid reconciliations | **New** | executed (shipped test) | **yes, exactly**: one call 0.000202295 ETH, five split calls 0.000824099 ETH | +0.000124 ETH per draw at 0.55 gwei. Estimated from the measured gas: +0.00048 per draw at 5 gwei, or 0.087 ETH per 180 draws if every batch is split | **Owner decision D4** |
| 7 | The app shows a price without the randomness fee as "Players pay"; creator earnings are shown before keeper pay; the VRF gas is hardcoded | **New** (partly known) | reasoned | yes, at the branch tip (lines below) | understates the player's price by 0.001287 ETH at 0.55 gwei, 0.0117 at 5 gwei | **Repair (app only)** |
| 8 | A curated collection that refuses transfers can leave an NFT and one draw's escrow at FWA after closeout | **New** | reasoned | **not reproduced**: no real refusing collection was identified, and a mock is not allowed | at most the NFT's own value plus one draw's escrow (one 0.2 ETH NFT at launch) | **Accept with an outcome line (D7)** |

### Finding 7: exact lines at the branch tip

- `app/src/App.tsx:667-668`: the design page's "Players pay" headline shows `ev.drawPrice`, without the randomness fee.
- `app/src/App.tsx:1087` and `:1123`: the change-preview "Players pay" uses `ev.drawPrice`, without the fee.
- `app/src/App.tsx:1168` and `:1188-1190`: the pool page's "Players pay" is `d.fee` (without the fee). A note says
  the fee is added at draw time.
- `app/src/App.tsx:740`: this one includes the fee (`playerView` adds `vrfFee`), so the app is inconsistent with
  itself.
- `app/src/App.tsx:46-48`: `VRF_GAS = 2_340_000n` is hardcoded. The live service computes 1,800,000 gas × (1 + 30%)
  plus a flat amount, and its settings can change.
- `app/src/App.tsx:976` ("You keep per draw") and `:1159` and `:1246` (the 30-day figure) use `markupPerDraw`, gross
  of keeper pay.
- The "paid by players to keepers" wording Codex cites was already corrected in `fbc6cef`.

Proposed repair: for an existing pool, show FWA's own `quoteAcquisitionPrice(1)` total, split into the draw price and
the randomness fee. For a design not yet created, read the service's settings instead of the constant. Show the
creator's earnings net of an estimated keeper cost per draw at current gas. No contract change.

### Closeout: what FWA still holds

`closeout_pending` now splits FWA's leftover by FWA's own public totals, and asserts every wei is named:

| Holder | ETH |
| --- | --- |
| FWA protocol fee accrued (`accruedProtocolFees`) | 0.101245503168401864 |
| Player escrow and refund credit | 0 |
| Owner proceeds | 0 |
| Not named | 0 |

All of it is FWA's 5% edge on the 92 fulfilled draws. Plausibility check: 92 × about 0.0011 ETH ≈ 0.10 ETH. None of it
is the creator's or a player's.

## Decisions for the owner

| # | Decision | Options and what each costs | Recommendation and why |
| --- | --- | --- | --- |
| D1 | Top prize missing after a run of top wins (findings 1 and O5) | **a) Dashboard: "Add 0.96 ETH" and "Continue without the 0.5 ETH prize"**, creator's choice. No contract change. Restores the board at once either way (`docs/OWNER-DECISIONS-RC.md`). **b) A bigger reserve: two largest prizes spare instead of one.** About +0.5 ETH locked on this board at all times, a contract change and a re-audit. **c) Accept it**: the board can run without its top prize until sales refill the reserve, not within 30 days in this run. | **a.** It fixes the outcome with no contract change and no capital locked by default. b charges every creator 0.5 ETH of idle capital for a rare event. |
| D2 | Keepers keep storage refunds on top of gas (finding 2) | **a) Accept** and sign O1 as reworded: ≤ 0.002 ETH per 180 draws, measured worst 0.00161. **b) Lower the 50,000-gas overhead allowance.** Under-reimburses honest keepers, whose real overhead is 24k to 46k gas, so they skip calls near the cap. | **a.** The slack is about 0.00001 ETH per draw, and the contract cannot see refunds. |
| D3 | Post-close reconciliation unpaid (finding 3) | **a) Repair:** while closed, `requiredReserve()` keeps one `MAX_KEEPER_REWARD` (0.01635 ETH) per 5 unreconciled draws. It is released as soon as keepers reconcile. Cost: at most about 0.016 ETH held per 5 pending draws until reconciled. Actual pay is about 0.0002 ETH at 0.55 gwei. It cannot delay the exit: unlisting already waits for those draws to settle. O3 ("right after closing, every wei is claimable") then becomes "every wei except the reconcile pay still owed". **b) Accept as an exception:** keepers may skip post-close reconciliation, and the creator runs it from the dashboard. | **a.** It is a small change to an existing function and makes "every useful call is paid" true. Re-attack it after the repair. |
| D4 | Splitting a batch into paid calls (finding 6) | **a) Accept and budget one paid call per processed draw:** +0.000124 ETH per draw at 0.55 gwei, about +0.00048 at 5 gwei, only when someone splits. The splitter earns about 0.0001 ETH per extra call. **b) Pay the flat 0.0001 ETH per draw reconciled or Shape listed instead of per call.** Splitting stops paying, but a lone reconcile-only call earns 0.00002 ETH and keepers skip it near the cap: the stall option B fixed. **c) Pay reconcile-only calls only once the oldest draw has waited N blocks.** Honest keepers batch naturally; adds a delay and complexity. | **a.** The worst case is about 0.087 ETH per 180 draws at 5 gwei; b brings back the stall option B was made to fix; c adds code for little gain. The test name and comment are already corrected. The contract comment ("work cannot be split into smaller paid calls") needs the same correction in the repair batch. |
| D5 | Who pays restocking fees (finding 4) | **a) Reword O2:** "restocking fees are built into the draw price; all buyers fund them, about 0.001 ETH per draw at 0.5 gwei". **b) Keep the per-winner wording.** Not achievable through FWA's pricing. | **a.** It is how FWA works; the creator's total is the same. |
| D6 | Player price at high gas (finding 5) | Set a ceiling, for example "all-in price ≤ 2× expected backing up to basefee X". Measured: 1.43× at 0.55 gwei, 2.4× at 5 gwei on a fresh board. To meet a lower ceiling: **a) lower the keeper and purchase gas cap** (purchases pause sooner), **b) a cheaper restocking fee** (keeper pay no longer covered at high gas), **c) accept** the 5 gwei cap with the ratio shown to players. | **c for launch, with the number in the outcome list:** 5 gwei is about the 99th percentile of measured blocks. The owner states the ceiling. |
| D7 | NFTs from collections that refuse transfers (finding 8) | **a) Outcome exception:** the closeout guarantee covers collections that transfer normally; a refusing collection can hold the creator's NFT and one draw's escrow at FWA until the player claims the refund. **b) Allowlist curated collections.** Cuts what creators can list. | **a.** The exposure is the creator's own NFT. The player's escrow stays claimable by the player under FWA's rules. |

Repairs needing no decision: finding 7 (app only), and the contract comment correction from D4. The finding 3 repair
waits for D3.

## Things that don't make sense

- The flat reward was cut to 0.0001 ETH partly because splitting was believed impossible. With splitting possible, the
  flat reward is the splitter's whole margin. Even so, a: accepting it is cheaper than redesigning.
- Finding 5's 0.0170 ETH expected backing is Codex's figure. I did not recompute it.
