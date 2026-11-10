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
2. **Keeper reimbursement: price `min(bid, basefee + 0.05 gwei, 2 gwei)`; gas `min(measured, 3.2M) × 4/5`.**
   The 0.05 gwei priority cap was **(your call)**. I chose the 2 gwei absolute cap (was 10) and the 4/5 refund rule.
   4/5 is the only in-transaction rule that provably never pays more gas than billed after EIP-3529 refunds; it
   under-reimburses refund-light calls by up to ~20%, which the incentive covers at normal gas. Above 2 gwei basefee
   keepers wait and new purchases pause (existing draws unaffected). Max reward 0.00562 ETH (was 0.0325). Alternative:
   a per-operation gas schedule, which needs re-measuring whenever FWA or Shapes gas changes. `docs/GAS.md`.
3. **Keeper incentive is 0.0005 ETH per upkeep that did inventory work**, on top of gas, from two sources. Work a
   creator action started pays it in full until the next checkpoint (the creator is paying for their own change).
   Work purchases caused pays it from a credit equal to FWA's 5% edge on the last batch's fees, so self-dealing can
   never earn more than it paid FWA. The credit only limits pools with draw prices below ~0.0105 ETH per draw or
   draw-caused multi-call plan switches. Kept at 0.0005 because it makes the 4/5 rule profitable for keepers up to the
   2 gwei cap on replacement upkeeps. The initial fill counts
   as inventory work (about 6 Shapes per upkeep), so the creator's ETH pays several incentives while filling; fill
   steps are unprofitable for keepers above ~0.75 gwei and the creator can run them. Re-checkpoints after a creator
   edit or deposit pay nothing, per the brief; the bundled keeper does them only within its `MAX_LOSS_WEI` allowance.
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
    Shapes; a pool caps at 100 listings (curated plus Shapes).
18. **Markup range 0–100%.** Planner suggests 15% and shows a projected minimum per configuration.
19. **Mint fee rise closes admission** until upkeep re-checkpoints with a reserve funded at the new fee. A fall needs
    no action.
20. **Upkeep work is chunked**: at most 6 Shape operations and 6 repricings per call, measured to stay under the
    3.2M gas reward cap. A 40-Shape fill takes about 7 upkeeps; repricing 100 listings takes 17. Repricing rescans all
    listings each call instead of keeping a cursor (up to ~0.4M extra gas per repricing step) so it cannot skip one.
21. **Unwind is chunked at 20 Shapes per call** (withdraw and redeem together). Redemption returns exact backing; mint
    fees paid are not recoverable.
22. **ENS: reverse record only.** The Balancer sets its own reverse name; the forward `addr` record is set by the
    name's owner. The dashboard checks both and shows when they disagree.
23. **Creator transfer is two-step**; `transferCreator(address(0))` cancels a pending transfer.

## Off-chain

24. **One keeper key from an environment variable** (`KEEPER_PRIVATE_KEY`), never written to disk. The keeper
    simulates each call, bids basefee + 0.05 gwei, and sends only when the simulated reward + `MAX_LOSS_WEI` (default
    0) covers estimated gas × price. Gas limit = estimate × 1.3 (Shapes mint gas varies by block); the contract never
    reimburses the limit. Stuck transactions are replaced after 3 blocks at +25%, up to 5 times, only while under 2 gwei
    and still profitable.
25. **Dashboard is not hosted.** Vite + React + wagmi, injected wallet only. A mock connector exists only on chain
    31337 with `VITE_DEV_ACCOUNT` set.
26. **Simulation assumptions**: 40 draws/day baseline, 30 days, 0.2 gwei median basefee, keeper bids 0.05 gwei
    priority and polls every 2 minutes, curated restocked at the next upkeep (switching scenarios: after 2–12 hours).
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
    helpers). `via_ir` was needed to fit the 24 KB limit (runtime 23,208 B of 24,576).
33. **A buyer can name any purchaser on FWA**, including the Balancer or the Shapes contract. Naming the Balancer delivers
    the drawn NFT to it (creator recovers it with `recoverUntrackedNFT`); if that delivery fails, only the Balancer could
    refund and it has no function for that, so a curated NFT from a transfer-restricted collection would stay in FWA.
    Naming the Shapes contract makes a drawn Shape undeliverable and unrefundable. Both cost the attacker the full draw
    price for roughly equal damage; accepted and documented rather than adding an FWA refund path.
34. **Keeper bids exactly the 0.05 gwei reimbursable priority.** In a congested block that bid may lose to other
    transactions; the keeper then waits rather than overbid, because the excess would not be reimbursed.
