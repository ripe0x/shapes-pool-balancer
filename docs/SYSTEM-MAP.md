# System map: where assets sit and how they move

One page. Rules live in `docs/SPEC.md`; measured numbers per regime in `docs/receipts/flow/` (written by
`test/scenario/FlowBreakdown.t.sol`); the gate in `docs/ASSET-FLOW-GATE.md`.

## Actors

| Actor | Brings | Takes |
| --- | --- | --- |
| Creator | ETH deposits, curated NFTs | claims (`claimSurplus`), NFTs back, everything at closeout |
| Other ETH contributor | ETH by `depositETH()` or plain transfer; a predicted-address pre-fund enters the pool only if the clone deploys there | no protocol refund, recovery or withdrawal claim; recorded address is attribution only |
| Players | draw price + FWA randomness fee, paid to the FWA pool | a prize or the applicable timeout, slippage or failed-delivery refund entitlement |
| Keepers (anyone, or the factory's approved list) | gas for `performUpkeep` | the in-library formula payment for the verified work of each call |
| Keeper admin | nothing | nothing (controls the keeper list only) |
| Factory admin (`policyAdmin`, trusted, R97) | nothing | nothing (sets the factory economics, which following pools adopt immediately, the default bucket for new pools and the product limits on new designs) |
| FWA pool (owned by the Balancer) | custody of listings, draw escrow | 5% edge on each draw price, kept inside the FWA pool |
| FWA randomness service | random words | 2,340,000 gas x gas price per draw, taken when the draw is bought |
| Shapes / Draw Packs | ETH-backed prize tokens | 0.001 ETH mint fee per Shape (fork block 26,382,349) |

## Buckets

| Bucket | Where | Whose | Its own stated need |
| --- | --- | --- | --- |
| Creator credit (unclaimed) | Balancer ETH, `creatorCredit` | creator, protected from all keeper pay and maintenance | none |
| Creator reserve | Balancer ETH up to `requiredReserve()` | creator, locked while open | actual missing inventory and its canonical paid setup work + actual outstanding draw budgets + one working-call buffer; no duplicate backing or future-board cycle |
| Fund above the reserve | Balancer ETH above `requiredReserve()` | creator, claimable | none |
| Shape and Pack backing | Shapes contract, tokens held by the FWA pool | creator (redeemable only by unlisting) | the target board |
| Owner proceeds | FWA pool, `ownerProceeds` | creator (anyone may collect into the Balancer) | none |
| Pending draws, refund credit, FWA edge | FWA pool | players and FWA | the actual escrow/refund/protocol totals; fully encumbered |
| Curated NFTs | FWA pool | creator until won | at least one listed, or purchases stop |

Keeper pay has no custodial bucket of its own: it spends the creator operating fund, excluding protected `creatorCredit`. The per-pool spending bucket (creator setting, default 0.622 ETH refilling floor(0.05 ETH / 12) wei per second) is an authorization ceiling, not ETH custody. The old board-cycle gap is removed. Unsold surcharge expectations are not liquid ETH. There is no keeper policy contract (R95).

## Flows

| # | Flow | Trigger | Reverses? |
| --- | --- | --- | --- |
| 1 | Any sender -> Balancer: capital contribution | creator (`createBalancer`) or anyone (`depositETH`, plain send, including to a predicted address if the clone later deploys there) | no sender claim after funding enters the pool; the current creator may claim available surplus under the reserve, immediately if available |
| 2 | Player -> FWA pool: draw price | player buys on FWA; the Balancer's gate must admit it | applicable expiry/slippage refund credit, or failed-delivery refund under FWA timing |
| 3 | Player -> FWA randomness service: fee | same purchase | no, including refunded acquisitions |
| 4 | FWA escrow -> fixed request-board owner base and protocol edge | successful actual prize delivery | no; surcharge is a component of that owner base, not the selected prize fee |
| 5 | FWA pool -> winner: prize token | same | no (a failed delivery can be refunded after 7 days and recovered by the creator) |
| 6 | Owner proceeds -> Balancer | anyone (`collectProceeds`), every upkeep and creator action | no |
| 7 | Proceeds -> `creatorCredit`: floor(collected x stored `creatorRevenueBps` / 10,000) | every collection, including after closing | claims spend it first; paid and unpaid upkeep never spend it |
| 8 | Balancer -> Shapes / Packs: backing + mint fee, token listed on FWA | keeper upkeep while open, smallest prize first, at most 5 Shapes per call | backing yes (creator `unlistShapes`, only while no draw is unsettled); mint fee no |
| 9 | Balancer -> keeper: (min(measured, operation gas bound, maxGas) + overhead) x min(tx gas price, basefee + allowance, ceiling) + work fee per processed draw, reconciled draw and listed Shape unit | successful paid upkeep with verified progress, the reviewed `settingsHash`, cash, the bucket and the caller minimum | successful purchases replenish through their request-board surcharge component; payments themselves do not reverse |
| 10 | Balancer -> creator: claim | creator `claimSurplus` | deposit again |
| 11 | FWA pool -> player: refund credit withdrawn | player | no |

The owner retains approximate current-board profit attribution to preserve concurrent purchases and downtime recovery. Gas/policy changes can reclassify the same creator's operating cash as booked profit; the historical 0.001 ETH O9 bound has counterexamples. No new party receives those amounts, and no purchaser bucket enters the Balancer's payout path. Admission uses actual FWA counts and the guaranteed prior reserved prefix plus the next six activations, with one conservative Shape-staging count, without a per-listing synchronization queue. The count is capped on restock and can clear, so it is not a lifetime ratchet or spending authority. See [AUDIT-REMEDIATION.md](AUDIT-REMEDIATION.md) for the one-screen scorecard, remaining numerical decision and tested claim/closeout cycles.

## One-way ratchets and stuck states to watch

- `reconciledSequence` only moves when someone runs upkeep, and each unreconciled draw counts against the fill gate.
  Reconciling is paid, so a profit-only keeper does it up to the 5 gwei cap; above the cap keepers wait.
- Listed prices are never repriced: a prize listed at high gas keeps its higher restocking fee until it is won or unlisted.
- `retire` is irreversible. `mintFeeCap` moves only when the creator configures.
- Unlisting and NFT withdrawal wait for every pending draw (FWA rule); ETH does not.

## Keeper economics as built (community release, 2026-11-23, R95-R99)

- One `Economics` struct of numbers (work fee, gas limits and bounds, price ceiling and allowance, restocking gas and flat
  charge, processing graces). The payment and restocking formulas are code in `KeeperPolicyCalls`; changing them is a
  new release.
- Two modes per pool: **follow** the factory (default; a factory change applies at the pool's next operation, constant
  work, no follower inspected) or **local** values set by the creator. The app's "Pin current factory values" saves the
  factory's current values as local economics in one `setLocalEconomics` transaction.
- `settingsHash` = economics + source + generation + paid state + live Shapes mint fee. Paid upkeep and creation bind it.
- A local change that raises the maintenance exposure needs that exposure funded from operating cash; missing prizes
  never enter the check. The creator's paid-upkeep stop survives every factory change. No change refills the bucket.
- Upkeep processes FWA's queue only for stuck head draws (Ready, TimedOut, or Pending past `wordDeadlineBlock`), at
  most two per call, after 50 blocks from the request (10 while purchases are paused BUSY or LOW_INVENTORY), paid as gas
  plus a work fee per processed draw.

## Policy replacement and recovery (2026-11-17, superseded by R95/R96)

Historical: this section describes the replaceable-policy design. Since R95 there is no policy contract, quote or
fallback schedule: paid and unpaid upkeep price restocking with the same formula.

No asset changes custodian when a policy changes. Activation changes the selected quote address and cached maximum
only, immediately (slice A2) after the operating-capital check. Uncollected listing surcharges are tracked as future income
but never offset the current liquid reserve or become ETH already collected. Funding is checked in the
changing transaction itself. Existing listing price and markup records stay fixed.

Unpaid upkeep follows the same mint, listing, proceeds and reconciliation paths with zero keeper transfer, healthy active-policy listing surcharges and an immutable V1 recovery surcharge only when quoting fails. It is available even if the policy fails and paid eligibility is restricted.
Closing releases inventory/setup/buffer requirements, keeps one current reconciliation budget per actual outstanding draw while paid upkeep is enabled, and never moves player
refund credits or FWA edge to the Balancer. Retirement still requires the existing real settlement conditions.

Ratchets: economics generation (`policyGeneration`), finalized reconciliation sequence and cumulative keeper spending increase; generation
prevents stale offers replaying, reconciliation prevents repeated service fees, and bucket time never resets on
configuration/policy/ownership changes. The bucket itself refills only to its immutable burst ceiling. These are
engineering decisions under the owner's autonomous-implementation request, subject to reported economic review. Disabling paid upkeep releases payment budgets; immediate re-enabling rechecks funding. See [RESERVES.md](RESERVES.md) for the current kernel.
