# System map: where assets sit and how they move

One page. Rules live in `docs/SPEC.md`; measured numbers per regime in `docs/receipts/flow/` (written by
`test/scenario/FlowBreakdown.t.sol`); the gate in `docs/ASSET-FLOW-GATE.md`.

## Actors

| Actor | Brings | Takes |
| --- | --- | --- |
| Creator | ETH deposits, curated NFTs | claims (`claimSurplus`), NFTs back, everything at closeout |
| Other ETH contributor | ETH by `depositETH()` or plain transfer; a predicted-address pre-fund enters the pool only if the clone deploys there | no protocol refund, recovery or withdrawal claim; recorded address is attribution only |
| Players | draw price + FWA randomness fee, paid to the FWA pool | a prize or the applicable timeout, slippage or failed-delivery refund entitlement |
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
| Pending draws, refund credit, FWA edge | FWA pool | players and FWA | the actual escrow/refund/protocol totals; fully encumbered |
| Curated NFTs | FWA pool | creator until won | at least one listed, or purchases stop |

Keeper pay has no custodial bucket of its own: it spends the creator operating fund, excluding booked withdrawable profit. The persistent per-pool burst/refill allowance is an authorization ceiling, not ETH custody. The old board-cycle gap is removed. Unsold surcharge expectations are not liquid ETH. Policies hold nothing.

## Flows

| # | Flow | Trigger | Reverses? |
| --- | --- | --- | --- |
| 1 | Any sender -> Balancer: capital contribution | creator (`createBalancer`) or anyone (`depositETH`, plain send, including to a predicted address if the clone later deploys there) | no sender claim after funding enters the pool; the current creator may claim available surplus under the reserve, immediately if available |
| 2 | Player -> FWA pool: draw price | player buys on FWA; the Balancer's gate must admit it | applicable expiry/slippage refund credit, or failed-delivery refund under FWA timing |
| 3 | Player -> FWA randomness service: fee | same purchase | no, including refunded acquisitions |
| 4 | FWA escrow -> fixed request-board owner base and protocol edge | successful actual prize delivery | no; surcharge is a component of that owner base, not the selected prize fee |
| 5 | FWA pool -> winner: prize token | same | no (a failed delivery can be refunded after 7 days and recovered by the creator) |
| 6 | Owner proceeds -> Balancer | anyone (`collectProceeds`), every upkeep and creator action | no |
| 7 | Proceeds -> creator profit: current tracked above-10% share | at collection while open, booked before reconciliation and paid inventory work | claims spend it first; public unpaid recovery may consume it |
| 8 | Balancer -> Shapes / Packs: backing + mint fee, token listed on FWA | keeper upkeep while open, smallest prize first, at most 5 Shapes per call | backing yes (creator `unlistShapes`, only while no draw is unsettled); mint fee no |
| 9 | Balancer -> keeper: selected read-only quote, bounded by immutable work, per-call and rate limits | successful paid upkeep with validated progress and caller minimum met | successful purchases replenish through their request-board surcharge component; payments themselves do not reverse |
| 10 | Balancer -> creator: claim | creator `claimSurplus` | deposit again |
| 11 | FWA pool -> player: refund credit withdrawn | player | no |

The owner retains approximate current-board profit attribution to preserve concurrent purchases and downtime recovery. Gas/policy changes can reclassify the same creator's operating cash as booked profit; the historical 0.001 ETH O9 bound has counterexamples. No new party receives those amounts, and no purchaser bucket enters the Balancer's payout path. Admission uses actual FWA counts and the guaranteed prior reserved prefix plus the next six activations, with one conservative Shape-staging count, without a per-listing synchronization queue. The count is capped on restock and can clear, so it is not a lifetime ratchet or spending authority. See [AUDIT-REMEDIATION.md](AUDIT-REMEDIATION.md) for the one-screen scorecard, remaining numerical decision and tested claim/closeout cycles.

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
