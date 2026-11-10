# Decisions made on your behalf

The build brief said to make reasonable decisions without asking. These are the choices that change money, authority,
behavior a creator or player will notice, or what you are trusting. Each one says what was chosen, the alternative,
and where it lives. Routine tooling choices are at the end.

Review the **Money and authority** section first.

## Money and authority

1. **Markup applies to Shapes too, not only curated NFTs.** Every FWA listing is priced `base × (1 + markup)`; a
   0.1 ETH Shape lists at 0.115 ETH at 15%. This keeps odds unchanged by the markup and is where the operating margin
   comes from. Alternative: list Shapes at backing and mark up curated only, which shifts odds toward Shapes and
   earns nothing on Shape draws. `configure`, `_reprice`, `docs/SPEC.md`.
2. **Keeper gas price capped at 10 gwei, priority at 2 gwei, gas at 3.2M per call.** Max reward 0.0325 ETH. Above
   10 gwei base fee, keepers are paid below cost and the bundled keeper waits, so pools stay closed to new purchases
   until gas falls. Alternative: a higher cap, which needs a larger reserve per pool. Constants in
   `src/PoolBalancer.sol`.
3. **Keeper incentive is 0.0005 ETH per upkeep that did inventory work**, on top of gas. The initial fill of a pool
   counts as inventory work (about 6 Shapes per upkeep), so the creator's ETH pays several incentives while filling. The
   creator can run upkeep themselves to avoid that. Re-checkpoints after a creator edit or deposit pay nothing,
   per the brief, so the bundled keeper absorbs that gas.
4. **Reserve covers one keeper reward, not five.** The worst-5 Shape replacements are fully funded; keeper payment is
   funded once. If restoring a batch takes several upkeeps, a top-up may be needed and the pool fails closed until
   then (R-7 in `docs/SECURITY.md`).
5. **Capital limit applies to each approved plan, not to spares.** When upkeep switches plans, surplus Shapes are
   unlisted and kept as spares (not redeemed) so they can be reused. Total Shapes backing (listed plus spares) can
   therefore exceed `maxShapeCapital` after a switch. Spares are redeemed only by `unwind` after closing. Alternative:
   redeem surplus on switch, which loses the mint fee each time.
6. **Closing makes the whole liquid balance claimable.** `requiredReserve` is 0 while closed. A batch admitted just
   before `close()` still settles on FWA (player escrow is FWA's), but its upkeep reward may go unfunded if the
   creator claims everything first (R-13, accepted).
7. **Purchase operator is permanent, not just locked while open.** The brief asked that the creator cannot remove it
   while purchases are enabled; it cannot be removed at all. No setter exists.
8. **No ERC-1271 contract signatures.** FWA's "Edit page" (pool name, images) needs an owner signature, and the
   Balancer is the owner. Adding signing would widen authority for an unconfirmed benefit. Result: the pool page may
   show no custom metadata. Purchases are unaffected.
9. **Refunded curated NFTs are recovered by the creator, not by upkeep.** Upkeep never calls a curated collection,
   so a hostile collection cannot block or tax keepers. The creator calls `recoverCuratedNFT` after a buyer refunds.
   Refunded Shapes are recovered by upkeep automatically.
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
    3.2M gas reward cap. A 40-Shape fill takes about 7 upkeeps.
21. **Unwind is chunked at 20 listings and 20 redemptions per call.** Redemption returns exact backing; mint fees
    paid are not recoverable.
22. **ENS: reverse record only.** The Balancer sets its own reverse name; the forward `addr` record is set by the
    name's owner. The dashboard checks both and shows when they disagree.
23. **Creator transfer is two-step**; `transferCreator(address(0))` cancels a pending transfer.

## Off-chain

24. **One keeper key from an environment variable** (`KEEPER_PRIVATE_KEY`), never written to disk. Gas estimate ×1.3
    (Shapes mint gas varies by block). Stuck transactions replaced after 3 blocks at +25%, up to 5 times, never above
    10 gwei.
25. **Dashboard is not hosted.** Vite + React + wagmi, injected wallet only. A mock connector exists only on chain
    31337 with `VITE_DEV_ACCOUNT` set.
26. **Simulation assumptions**: 40 draws/day baseline, 30 days, keeper bids 0.1 gwei priority, keeper polls every
    2 minutes, curated restocked when drawn. Results depend heavily on these; see `docs/simulation-results.md`.

## Repository and process

27. **Repo is public under `ripe0x`** with MIT SPDX headers in source files but **no LICENSE file**. Add one or change
    the license before publicizing.
28. **`main` holds an unverified checkpoint commit** (`959e64f`, contracts only) pushed directly before the PR
    existed. Everything after is in PR #1. Consequence: GitHub's PR diff for `src/` shows changes since that
    checkpoint, not the full contracts. Review full files.
29. **One large PR** rather than a stack, because pieces depend on each other and CI needed the whole tree.
30. **Security review was by AI agents only**, two blind reviewers plus a repair re-review. No human or professional
    audit.
31. **Fork tests pin block 26,382,349** for reproducibility. They prove behavior against FWA and Shapes as deployed
    at that block.
32. **Solidity 0.8.28, `via_ir`, Solady** (clones, safe ETH transfers, reentrancy guard). `via_ir` was needed to fit
    the 24 KB limit (runtime 22,536 B).
