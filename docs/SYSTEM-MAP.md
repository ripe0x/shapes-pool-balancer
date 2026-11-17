# System map: where assets sit and how they move

One page. Rules live in `docs/SPEC.md`; measured numbers per regime in `docs/receipts/flow/` (written by
`test/scenario/FlowBreakdown.t.sol`); the gate in `docs/ASSET-FLOW-GATE.md`.

## Actors

| Actor | Brings | Takes |
| --- | --- | --- |
| Creator | ETH deposits, curated NFTs | claims (`claimSurplus`), NFTs back, everything at closeout |
| Players | draw price + FWA randomness fee, paid to the FWA pool | a prize (Shape, Draw Pack or NFT), or refund credit if the draw times out |
| Keepers (anyone, or the factory's approved list) | gas for `performUpkeep` | a bounded reward per call |
| Keeper admin | nothing | nothing (controls the keeper list only) |
| Policy admin | nothing | nothing (recommends a default for future pools after two days) |
| Selected keeper policy | read-only validated work context | nothing (returns bounded economic quotes) |
| FWA pool (owned by the Balancer) | custody of listings, draw escrow | 5% edge on each draw price, kept inside the FWA pool |
| FWA randomness service | random words | 2,340,000 gas x gas price per draw, taken when the draw is bought |
| Shapes / Draw Packs | ETH-backed prize tokens | 0.001 ETH mint fee per Shape (fork block 26,382,349) |

## Buckets

| Bucket | Where | Whose | Its own stated need |
| --- | --- | --- | --- |
| Creator profit (unclaimed) | Balancer ETH, `profit` | creator | none |
| Creator reserve | Balancer ETH up to `requiredReserve()` | creator, locked while open | actual missing inventory and its canonical paid setup work + actual outstanding draw budgets + one working-call buffer; no duplicate backing or future-board cycle |
| Fund above the reserve | Balancer ETH above `requiredReserve()` | creator, claimable | none |
| Shape and Pack backing | Shapes contract, tokens held by the FWA pool | creator (redeemable only by unlisting) | the target board |
| Owner proceeds | FWA pool, `ownerProceeds` | creator (anyone may collect into the Balancer) | none |
| Pending draws, refund credit, FWA edge | FWA pool | players and FWA | none |
| Curated NFTs | FWA pool | creator until won | at least one listed, or purchases stop |

Keeper pay has no custodial bucket of its own: it spends the creator operating fund, excluding booked withdrawable profit. The persistent per-pool burst/refill allowance is an authorization ceiling, not ETH custody. The board-cycle gap is locked creator operating capital, not income already collected. Policies hold nothing.

## Flows

| # | Flow | Trigger | Reverses? |
| --- | --- | --- | --- |
| 1 | Creator -> Balancer: deposit | creator (`createBalancer`, `depositETH`, plain send) | yes, by `claimSurplus` down to the reserve while open; fully after `close` |
| 2 | Player -> FWA pool: draw price | player buys on FWA; the Balancer's gate must admit it | only if the draw times out (30 blocks without a word): refund credit for the price |
| 3 | Player -> FWA randomness service: fee | same purchase | no, also not on timeout |
| 4 | FWA pool escrow -> owner proceeds (price / 1.05) and FWA edge (5%) | the random word is delivered and the draw processed | no |
| 5 | FWA pool -> winner: prize token | same | no (a failed delivery can be refunded after 7 days and recovered by the creator) |
| 6 | Owner proceeds -> Balancer | anyone (`collectProceeds`), every upkeep and creator action | no |
| 7 | Proceeds -> creator profit: the markup above the game's first 10% | at collection while open, booked before reconciliation and paid inventory work | spent first by the next claim; restocking may spend it when the fund is empty |
| 8 | Balancer -> Shapes / Packs: backing + mint fee, token listed on FWA | keeper upkeep while open, smallest prize first, at most 5 Shapes per call | backing yes (creator `unlistShapes`, only while no draw is unsettled); mint fee no |
| 9 | Balancer -> keeper: selected read-only quote, bounded by immutable work, per-call and rate limits | successful paid upkeep with validated progress and caller minimum met | future purchases replenish the creator via listing-time fees; payments themselves do not reverse |
| 10 | Balancer -> creator: claim | creator `claimSurplus` | deposit again |
| 11 | FWA pool -> player: refund credit withdrawn | player | no |

## One-way ratchets and stuck states to watch

- `reconciledSequence` only moves when someone runs upkeep, and each unreconciled draw counts against the fill gate.
  Reconciling is paid, so a profit-only keeper does it up to the 5 gwei cap; above the cap keepers wait.
- Listed prices are never repriced: a prize listed at high gas keeps its higher restocking fee until it is won or unlisted.
- `retire` is irreversible. `mintFeeCap` moves only when the creator configures.
- Unlisting and NFT withdrawal wait for every pending draw (FWA rule); ETH does not.

## Policy replacement and recovery (2026-11-17)

No asset changes custodian when a policy changes. Activation changes the selected quote address and cached maximum
only, after the two-day delay and operating-capital check. Uncollected listing surcharges are tracked as future income
but never offset the current liquid reserve or become ETH already collected. A pending proposal reserves no
right to withdraw: funding is checked again when activated. Existing listing price and markup records stay fixed.

Unpaid upkeep follows the same mint, listing, proceeds and reconciliation paths with zero keeper transfer, healthy active-policy listing surcharges and an immutable V1 recovery surcharge only when quoting fails. It is available even if the policy fails and paid eligibility is restricted.
Closing releases inventory/setup/buffer requirements, keeps one current reconciliation budget per actual outstanding draw while paid upkeep is enabled, and never moves player
refund credits or FWA edge to the Balancer. Retirement still requires the existing real settlement conditions.

Ratchets: policy generation, finalized reconciliation sequence and cumulative keeper spending increase; generation
prevents stale offers replaying, reconciliation prevents repeated service fees, and bucket time never resets on
configuration/policy/ownership changes. The bucket itself refills only to its immutable burst ceiling. These are
engineering decisions under the owner's autonomous-implementation request, subject to reported economic review. Disabling paid upkeep releases payment budgets; delayed reenabling rechecks candidate funding. See [RESERVES.md](RESERVES.md) for the current kernel.
