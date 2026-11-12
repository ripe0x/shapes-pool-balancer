# Decisions made on your behalf

The build brief said to make reasonable decisions without asking. These are the choices that change money, authority,
behavior a creator or player will notice, or what you are trusting. Each one says what was chosen, the alternative,
and where it lives. Routine tooling choices are at the end. Updated for the simplification and hardening pass:
items you decided in that brief are marked **(your call)**.

Review the **Money and authority** section first.

## Money and authority

1. **Markup applies to Shapes too, not only curated NFTs.** Every FWA listing is priced `base × (1 + markup)`; a
   0.1 ETH Shape lists at 0.115 ETH at 15%. This keeps odds unchanged by the markup and is where the operating margin
   comes from. Alternative: list Shapes at backing and mark up curated only, which shifts odds toward Shapes and
   earns nothing on Shape draws. `configure`, `_reprice`, `docs/SPEC.md`.
2. **Keeper reimbursement: price `min(bid, basefee + 0.05 gwei, 5 gwei)`; gas `min(measured, 3.2M) × 4/5`.**
   The 0.05 gwei priority cap was **(your call)**. I chose the 4/5 refund rule (provably never above billed gas) and,
   after your liveness review, a 5 gwei absolute cap from measured mainnet basefee (above 5 gwei ~0.9% of blocks; longest
   measured episode ~42 min). Above the cap keepers wait and new purchases pause; existing draws are unaffected. Max
   reward 0.0165 ETH. Re-evaluated against FWA V2's sponsored rule (1 gwei over `min(basefee, 5)`, no incentive):
   kept 0.05 gwei, because competing permissionless keepers bid the reimbursed priority and 90-day inclusion data
   shows 0.05 gwei clears the cheapest included transactions in ~99% of normal blocks; at 1 gwei the simulation shows
   +91% keeper spend for no faster inclusion. `docs/GAS.md`, `docs/simulation-results.md`.
3. **Keeper incentive: the withheld 1/5 of measured gas + 0.0005 ETH** for inventory work. Replaced
   `max(0.0005, shortfall + 0.0001)` after the launch rehearsal: keepers price work with `eth_estimateGas` (78k gas
   median above billed), so near the cap the old 0.0001 margin made them skip profitable fill steps and the pool stayed
   closed. Total creator cost per upkeep is now measured gas × price + 0.0005 ETH. Creator-started
   work pays it in full; purchase-caused work pays it from a credit equal to FWA's 5% edge on the last batch's fees, so
   self-dealing can never earn more than it paid FWA (delivered draws only). Consequences: pools whose draws all cost
   ~0.01 ETH pause from ~4.2 gwei; creator-caused work at high gas pays keepers its refunds as well. Unpaid
   re-checkpoints stay unpaid (per the brief); the bundled keeper's 0.0002 ETH `MAX_LOSS_WEI` default covers gas-only
   paths.
4. **Reserve covers one keeper reward, not five.** The worst-5 Shape replacements are fully funded; keeper payment is
   funded once. If restoring a batch takes several upkeeps, a top-up may be needed and the pool fails closed until
   then (R-7 in `docs/SECURITY.md`).
5. **Surplus Shapes are redeemed, not kept as spares; no on-chain capital limit** **(your call)**. Each approved plan
   fixes its capital, and the Balancer never holds Shapes between transactions. Simulation cost: 0.02–0.11 ETH per
   30 days in re-mint fees when plans switch 10–42 times; closed time unchanged; no effect without plan switches.
   A refunded Shape is always redeemed (by the 7-day refund window, upkeep has long since replaced it).
6. **Closing makes the whole liquid balance claimable.** `requiredReserve` is 0 while closed. A batch admitted just
   before `close()` still settles on FWA (player escrow is FWA's), but its upkeep reward may go unfunded if the
   creator claims everything first (R-13, accepted).
7. **Purchase operator is permanent, not just locked while open.** The brief asked that the creator cannot remove it
   while purchases are enabled; it cannot be removed at all. No setter exists.
8. **ERC-1271 for FWA pool-page messages only** **(your call to investigate)**. FWA's site personal_signs a fixed
   plain-text template. `approvePoolPage` rebuilds that exact text for this pool and approves its digest;
   `isValidSignature` accepts nothing else and ignores signature bytes. Approvals are voided by `revokePoolPages` and
   by every creator transfer. `issuedAt` is checked for format, not for a plausible date (FWA's server judges freshness). The dashboard submits a 66-byte placeholder
   signature (viem-style verifiers reject 1-byte signatures before asking the contract). Unverified: FWA's server
   (not public) may not check ERC-1271; its client allows long contract signatures. Format verified from FWA's client
   bundle on 2026-11-10; if FWA changes the template, approvals stop matching and a contract upgrade is impossible,
   so pages would again need FWA's help.
9. **Failed deliveries are resolved per item, never scanned by upkeep.** Refunded curated NFTs: creator
   `recoverCuratedNFT`. Refunded Shapes: anyone `recoverRefundedShape` (keeper does it, gas-only reward). Upkeep gas is
   independent of refund history. **Untracked NFTs** sent to the Balancer: creator `recoverUntrackedNFT`, which only
   releases NFTs the Balancer itself owns (listed and pending NFTs are owned by the FWA pool).
10. **Factory is ownerless, charges nothing and lets one creator deploy many Balancers** (each with its own salt and
    pool). FWA allows one pool per owner address, so a retired Balancer cannot make a second pool; the creator deploys
    a new Balancer.
11. **FWA implementation is pinned in the Balancer bytecode** (address and runtime code hash as immutables). If FWA
    rotates its implementation, new Balancer creation reverts until a new factory is deployed. Existing pools keep
    working.

## Product behavior

12. **Fallback plans instead of an on-chain search.** The brief said to "calculate a new feasible target inventory"
    when curated changes break the current one. The creator pre-approves up to 4 plans in preference order; upkeep
    keeps the active plan while feasible, else activates the first feasible one. No solver runs on-chain or as a
    service. If none fits, purchases close (status 5).
13. **Nothing is ever staged.** The Balancer never lists while FWA has an unresolved acquisition, so FWA staging is
    never used and the dashboard shows no staged Shapes. Curated edits and upkeep revert `PoolBusy` during that window
    and succeed once the draw settles.
14. **Any curated edit closes purchases until the next upkeep** (checkpoint invalidated first). The bundled keeper
    re-checkpoints within one poll; the creator can also click upkeep in the dashboard.
15. **Odds floor is the combined probability of drawing any curated NFT**, checked with FWA's exact weights. Per-item
    odds are shown in the planner but not enforced.
16. **Price ceiling includes FWA's 5% edge, excludes the VRF fee**, as the brief specified. The dashboard labels prices "excl. VRF fee"; the VRF fee is not shown.
17. **All 9 Shapes denominations are allowed** (0.01 to 100 ETH). Planner enumeration is bounded; plans cap at 40
    Shapes (80 since decision 42); a pool caps at 100 listings (curated plus Shapes).
18. **Markup range 0–100%.** Planner suggests 15% and shows a projected minimum per configuration.
19. **Mint fee rise closes admission** until upkeep re-checkpoints with a reserve funded at the new fee. A fall needs
    no action.
20. **Upkeep work is chunked**: at most 6 Shape operations and 6 repricings per call, measured to stay under the
    3.2M gas reward cap. A 40-Shape fill takes about 7 upkeeps (80 Shapes with 18 new NFTs: 17); repricing 100
    listings takes 17. Repricing rescans all
    listings each call instead of keeping a cursor (up to ~0.4M extra gas per repricing step) so it cannot skip one.
21. **Unwind is chunked at 20 Shapes per call** (withdraw and redeem together). Redemption returns exact backing; mint
    fees paid are not recoverable.
22. **ENS: reverse record only.** The Balancer sets its own reverse name; the forward `addr` record is set by the
    name's owner. The dashboard checks both and shows when they disagree.
23. **Creator transfer is two-step**; `transferCreator(address(0))` cancels a pending transfer.

## Off-chain

24. **One keeper key from an environment variable** (`KEEPER_PRIVATE_KEY`), never written to disk. The keeper
    simulates each call, bids basefee + 0.05 gwei, and sends only when the simulated reward + `MAX_LOSS_WEI` (default
    0.0002 ETH) covers estimated gas × price. Gas limit = estimate × 1.3 (Shapes mint gas varies by block); the contract never
    reimburses the limit. Stuck transactions are replaced after 3 blocks at +25%, up to 5 times, only while under 5 gwei
    and still profitable.
25. **Dashboard is not hosted.** Vite + React + wagmi, injected wallet only. A mock connector exists only on chain
    31337 with `VITE_DEV_ACCOUNT` set.
26. **Simulation assumptions**: 40 draws/day baseline, 30 days, basefee sampled from the measured 90-day mainnet
    distribution (independently per check, so spikes are shorter than real ones), rational keepers bidding 0.05 gwei
    priority and polling every 2 minutes, curated restocked at the next upkeep (switching scenarios: after 2–12 hours).
    Results depend heavily on these; see `docs/simulation-results.md`.

## Repository and process

27. **Repo is public under `ripe0x`** with MIT SPDX headers in source files but **no LICENSE file**. Add one or change
    the license before publicizing.
28. **`main` holds an unverified checkpoint commit** (`959e64f`, contracts only) pushed directly before the PR
    existed. Everything after is in PR #1. Consequence: GitHub's PR diff for `src/` shows changes since that
    checkpoint, not the full contracts. Review full files.
29. **One large PR** rather than a stack, because pieces depend on each other and CI needed the whole tree.
30. **Security review was by AI agents only**: two independent reviewers per round (two rounds) plus repair reviews.
    No human or professional audit. Reviewers had clean context but the repository contains earlier reports, so the
    reviews are independent, not process-blind.
31. **Fork tests pin block 26,382,349** for reproducibility. They prove behavior against FWA and Shapes as deployed
    at that block.
32. **Solidity 0.8.28, `via_ir`, Solady** (clones, safe ETH transfers, reentrancy guard, string and signature
    helpers). `via_ir` was needed to fit the 24 KB limit (runtime 23,208 B of 24,576; 24,315 B after pack prizes,
    with the pool-page message builder moved to the `PoolPage` library).
33. **The gate refuses four purchasers**: the Balancer, the Shapes contract, the Draw Packs contract and the FWA pool
    (FWA passes the named purchaser to `canPurchase`). Deliveries to them could never be refunded or tracked. **Remaining griefing:** a
    purchaser contract that never refunds can lock a curated NFT from a collection that refuses transfers to contracts.
    Expected attacker cost to lock one = (VRF fee + FWA edge on the fee) / the NFT's draw odds: ~1.06 ETH for a 0.5 ETH
    NFT in a typical pool, ~0.18 ETH in a thin pool; worst case uses the creator's odds floor; repeatable once per such
    NFT. Mitigation: the dashboard warns before listing such a collection. Closing it fully would mean refusing all
    contract purchasers (smart wallets, EIP-7702 accounts) **(your call)**.
34. **Keeper bids exactly the 0.05 gwei reimbursable priority.** In a congested block that bid may lose to other
    transactions; the keeper then waits rather than overbid, because the excess would not be reimbursed.

## Pack prizes (2026-11-11)

35. **Prize sizes between the Shapes denominations use Draw Packs** (owner request: more flexible ETH denominations).
    Sizes 9–15 (0.02, 0.03, 0.2, 0.25, 2, 2.5, 25 ETH) are appended after the nine Shapes sizes, so existing plans,
    tests and fixtures keep their indices. A fixed menu, not arbitrary values: it keeps plans, counts, reserve and
    weight checks structurally unchanged.
36. **This system deploys its own Draw Packs instance** (ripe0x/shape-packs `draw-packs` at `3a463f7`, unmodified,
    the code ape-Ball deploys) with a 2-unit minimum, not the mainnet Shape Packs contract (3-unit minimum, no audit,
    unverified on Etherscan). Name "Pool Prize Packs", symbol "PRIZEPACK", and the presentation admin (`PACKS_ADMIN`,
    renderer and description only) are deploy values **(your call)**. Draw Packs' own audit status as used in ape-Ball
    is not confirmed here.
37. **Single-Shape sizes stay plain Shapes**, not one-Shape packs: a pack's wrapper roughly doubles mint+list gas
    (~870k for a three-Shape pack against ~380k per Shape), which would land on the most frequent replacements, and
    winners of ordinary prizes keep receiving Shapes.
38. **Upkeep work is budgeted in Shape units**: a pack counts the Shapes it holds against `MAX_OPS` (6). Without it,
    six pack mints billed 5.8M gas against the 3.2M reimbursement cap, so keepers would lose money after pack draws.
    Consequence: refilling several drawn packs takes more upkeep calls, so a pool with packs reopens a little later.
39. **Worst-batch reserve charges every prize three mint fees**, an upper bound on any five prizes' cost whatever the
    mint fee. Simpler than an exact search; costs +0.01 ETH of reserve at the current 0.001 ETH fee. It also holds one
    maximum keeper reward per upkeep call the worst batch needs (round 6 review): up to 3 when five three-Shape packs
    can be drawn, so +0.033 ETH for such plans.
41. **50 optimizer runs** (was 200) to keep PoolBalancer under the 24 KB limit with headroom after pack prizes; at 200
    the margin was 8 bytes. Worst Shape fill step bills 3.04M gas (was 3.03M), under the 3.2M reimbursement cap.
40. **Withdrawal redeems prizes one at a time** through `redeem(uint256)`, which Shapes and Draw Packs share, instead of
    one Shapes batch: smaller code; a little more gas on unwind and plan switches (unwind of 20 Shapes: 2.62M, creator-paid).
42. **Plans hold up to 80 prizes** (was 40), owner request: more small Shapes allow rarer NFT odds and cheaper draws.
    With up to 20 curated NFTs this fills the existing 100-listing cap. Upkeep gas per call is unchanged (bounded by
    the 6-unit work budget and the 100-listing loops): at 100 listings the highest measured upkeep billed 3.00M against
    the 3.2M reimbursement cap (`test_gas_fullPoolAtLimits`: fill, 5-draw replacement, repricing). Costs: a full fill
    takes about twice as many upkeeps (paid from the pool as keeper rewards), and plan switches and repricing touch more
    listings.

## Simplified gate and markup at listing (2026-11-11)

Owner decisions: markup applies at listing (option A), no repricing, no listing cap, simplify the contract. The money
flows pass (`sim/flows.ts`, `docs/simulation-results.md`) set the details. This section supersedes entries 1 (repricing
part), 39, 42 (listing cap) and every rule about checkpoints, approved fallback plans, the draw-price ceiling, the NFT
odds floor, the worst-batch reserve and `unwind`.

43. **Markup applies when a listing is made.** Listed prizes and NFTs keep their price; restocks and new NFTs use the
    markup in force. Nothing is repriced, so `updatePrice` gas (FWA has no batch update) is never spent on markup changes.
44. **Purchases are not one batch at a time.** FWA prices every draw on live inventory and refunds draws whose price moved
    past the player's tolerance, so the gate keeps the game near its design instead of exact. Purchases pause while
    upkeep finishes creator-started work, while 5 draws are unsettled, while the mint fee is above the one the creator
    accepted, or while prize weight (less the heaviest prize per unreconciled draw) is below 70% of the target's.
    Evidence: no unsettled limit refunded ~20% of draws in bursts; a count-based fill let NFT odds reach ×2.2 design.
45. **One target mix**, no fallback plans, ceiling or odds floor. A smaller target leaves extra prizes listed until the
    creator unlists them (`unlistShapes`, which also replaces `unwind`).
46. **Withdrawal reserve while open**: restoring the target, one largest prize per unreconciled draw plus one spare,
    and a maximum keeper reward per upkeep call that work takes plus one. It limits withdrawals only; it never closes
    purchases. Evidence: without the spare, a creator withdrawing everything left the top prize missing half the time.
    The reserve and restocking use the higher of the live mint fee and the accepted one. Review round 7 noted that one
    gate check admits a batch of five draws while the reserve holds one spare top prize; kept at one: two top-prize wins
    in one batch is about 1 in 6,000 for Balanced, a shortfall only delays that restock (proceeds or a deposit cover it),
    and holding five would lock about 2.5 ETH more per Balanced pool.
47. **Upkeep reconciles settled FWA sequences, 5 per call, and restocks while draws are pending** (FWA stages those
    listings). The gate uses tracked prize weight because FWA calls it before activating staged listings. Per call:
    at most 5 Shape units (was 6) and 4 prize sizes, because 5 reconciles + 6 Shapes in 4 sizes measured 3.13M and
    6 sizes 3.19M against the 3.2M reimbursement cap. Pools take a few more upkeep calls to fill.
    `initialize` requires FWA's staging cap to be off (a cap would make restocking revert while draws settle), and the
    constructor checks Shapes has nine sizes (Draw Packs takes one count per size).
    Known and accepted: the keeper credit backs FWA's edge out at today's `edgeBps`, so it can differ from the edge a
    draw paid if FWA changes its edge before reconciliation; a draw still awaiting delivery at reconciliation is treated
    as undelivered (no credit) and its record stays if a later retry delivers it.
48. **Removed:** the token-offer check (only the owner can enable one, and this contract never does), the permissionless
    `recoverRefundedShape` (merged into creator-only `recoverRefunded`), `clearENSName` (`setENSName("")`), and the
    100-listing cap (FWA's tree holds 2^32 listings; no contract loop scans listings).
49. **Kept:** keeper reimbursement (4/5 measured gas, 0.05 gwei priority cap, 5 gwei cap), full incentive only for
    creator-started work while purchases are refused, otherwise capped by the FWA edge players paid (now accumulated).
50. **Open for the owner:** the creator pays keeper gas up to 5 gwei, and a Balanced pool at 15% loses money above about
    2 gwei with 3 draws per upkeep. Options: a creator-set gas ceiling that pauses restocking, or keepers restocking after
    several draws. Not changed here.

## Keepers paid from markup (2026-11-12)

Owner decision: "make this so it never loses money with keepers". Supersedes 49, 50 and the `edgeBps` note in 47.

51. **Keepers are paid only from markup the pool has earned.** Each reconciled delivered draw adds its listed price less
    `base` (a curated NFT's creator value, or what a prize cost: backing plus mint fees) to `keeperCredit`. Outside
    creator-started work, a call's reward (measured gas × capped price + 0.0005 ETH) is capped by that credit and spends
    it, so lifetime keeper pay never exceeds the markup earned. At high gas keepers wait, inventory runs down and
    purchases pause at LOW_INVENTORY; they resume when gas falls or credit builds. The 4/5 gas split is gone: it bounded
    the part paid regardless of credit, and no such part remains.
52. **`configure` requires every target prize's markup to cover its mint fees** (`MarkupBelowMintFee`), so no listing
    has a negative margin and the credit never counts a loss as markup. At a 0.001 ETH fee the floor is 10% when the mix
    has 0.01 Shapes; a fee rise to 0.005 needs 50%. The dashboard shows the floor and blocks saving below it.
53. **Kept:** creator-started work (open, configure, unlisting) is paid in full from the creator's ETH, so a pool can
    stock up before it has earned anything. Opening a Balanced pool costs about 0.027 ETH of keeper gas at 1 gwei.
    Evidence (`npm run sim`): keepers were paid at most the markup earned in every scenario; with gas rising to 12 gwei
    they took 0.167 of 0.172 ETH markup and purchases were admitted 11% of the time instead of the pool paying more.
    The creator can still end below zero when keepers take nearly all the markup, because the opening stock-up gas and
    the mint fees of prizes still listed at close are fixed costs the markup must recover.

## Restocking fee in prize prices (2026-11-12)

Owner decisions: taking 50% of the markup for keepers "is a lot. The markup is where they make money"; after the
simulated comparison (docs/keeper-funding-results.md), "Yes, build it" for the gas-indexed restocking fee. Supersedes
52 and the funding source in 51.

54. **Keepers are paid only from a restocking fee priced into each prize, never from the creator's markup.** A prize
    lists at backing + one mint fee per Shape inside + backing × markup + one restocking fee per Shape inside;
    `restockFee()` = 750k gas × min(basefee + 0.05 gwei, 5 gwei) + 0.0002 ETH, fixed at the listing block's basefee
    (not the caller's bid, which a keeper chooses). Each delivered prize adds its restocking fees to `keeperCredit`;
    curated NFTs carry no fee and add nothing. Fees keepers never claim stay in the pool's ETH, the creator's.
    Why: keeper work is a fixed cost per Shape (about 763k gas for a one-draw restock) while the markup is a share of
    value, and about 3 in 4 Balanced draws are 0.01 Shapes, so the markup could not fund keepers (they took 61% of it
    at 1 gwei) and a share cap stopped the pool at normal gas. Indexing to basefee keeps restocking going as gas rises
    (gas rising to 12 gwei: purchases open 38% of the time, against 11%).
    Cost: players pay more, about 22.3 mETH per Balanced draw at 1 gwei against 19.2 (+16%), more on mixes of small
    prizes; the creator keeps about 2.6 mETH a draw. The sim holds demand fixed, so it does not show lost purchases.
55. **The mint fee is passed through to the price, so `configure` accepts any markup** (`MarkupBelowMintFee` removed;
    the dashboard floor removed). A mint fee rise still stops restocking until the creator saves again; listings after
    that carry the new fee.
56. **The fill check weighs prizes at their price less the restocking fee** (`base`), so a full inventory listed at high
    gas still reads as full. A mint fee below the configured one makes prizes slightly heavier; restocking stops above
    it, so the configured fee bounds the other way.
    Known and accepted: a curated-only or refund-only reconcile is unpaid when no credit is left; keepers reconcile it
    with later prize draws. Prizes listed during a basefee spike keep the higher fee until drawn; unused fees return to
    the creator, not to players. Lowering the markup raises `targetWeight` while listed prizes keep their old `base`,
    so the gate can read LOW_INVENTORY until old listings are drawn and relisted (as before, when weight used price).

## Restocking fee pays the call that lists the prize (2026-11-12)

Owner: "but the gas at listing time != gas at draw time"; after a first-principles review (with an independent design
from a Fable model), "Yes, build it". Supersedes when the credit is earned in 54.

57. **A prize's restocking fee is credited to keepers when the keeper lists it, not when a player wins it.** The cost
    of restocking is incurred, and known, in the call that lists the replacement, and that same block prices the
    replacement's fee; crediting then makes the fee pay for the work it was priced for. The pool's ETH fronts the fee
    and the player who wins the prize repays it. Creator work (open, configure, unlisting) still earns no credit and is
    paid in full; those listings' fees repay the creator's stock-up gas as they are won.
    Evidence: the 50-round rehearsal at `6fc2b9b` stalled at its 3 gwei step (prizes stocked at 0.08 gwei, fees too
    small to restock at 3 gwei); with this rule it passed (48/48 buyers found the pool open, 3 and 4.9 gwei batches
    serviced). Simulation, fresh pool with gas jumping 0.08 → 3 gwei: 99% of purchases admitted, against 8%.
    Creator exposure: the fees of prizes never won (unlisted, refunded after a failed delivery, or listed at close).
    At any moment at most the listed Shapes × `restockFee()` (Balanced, 47 Shapes: about 0.016 ETH at 0.1 gwei,
    0.054 ETH at 1 gwei, 0.22 ETH at the cap); over a pool's life, plus each prize unlisted or refunded earlier.
    Credit is never reversed; once the pool is closed, unspent credit is ordinary pool ETH the creator withdraws.
58. **`RESTOCK_FEE_GAS` is 900k (was 750k).** One-draw restock calls measured 763k-864k gas across pools and blocks
    (Shapes mint gas varies with the block); 750k + 0.0002 ETH covered them only to about 1.75 gwei. 900k covers the
    keeper's gas to the 5 gwei cap; at the cap the heaviest one-draw call gets slightly less than the full 0.0005 ETH
    incentive (independent review). Players pay about 0.00015 ETH more per Shape at 1 gwei; batches over-collect, and unused credit pays
    later reconcile-only calls or stays with the creator.
