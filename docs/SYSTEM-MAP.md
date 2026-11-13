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
| FWA pool (owned by the Balancer) | custody of listings, draw escrow | 5% edge on each draw price, kept inside the FWA pool |
| FWA randomness service | random words | 2,340,000 gas x gas price per draw, taken when the draw is bought |
| Shapes / Draw Packs | ETH-backed prize tokens | 0.001 ETH mint fee per Shape (fork block 26,382,349) |

## Buckets

| Bucket | Where | Whose | Its own stated need |
| --- | --- | --- | --- |
| Creator profit (unclaimed) | Balancer ETH, `profit` | creator | none |
| Keeper credit | Balancer ETH, `keeperCredit` | keepers until `close`, then creator | none |
| Creator reserve | Balancer ETH up to `requiredReserve()` | creator, locked while open | restore the board + one largest prize per unreconciled draw + one spare + keeper rewards for that work |
| Fund above the reserve | Balancer ETH above `requiredReserve()` | creator, claimable | none |
| Shape and Pack backing | Shapes contract, tokens held by the FWA pool | creator (redeemable only by unlisting) | the target board |
| Owner proceeds | FWA pool, `ownerProceeds` | creator (anyone may collect into the Balancer) | none |
| Pending draws, refund credit, FWA edge | FWA pool | players and FWA | none |
| Curated NFTs | FWA pool | creator until won | at least one listed, or purchases stop |

Keeper credit and the reserve are not separate ETH: credit is owed out of the balance `requiredReserve()` counts.

## Flows

| # | Flow | Trigger | Reverses? |
| --- | --- | --- | --- |
| 1 | Creator -> Balancer: deposit | creator (`createBalancer`, `depositETH`, plain send) | yes, by `claimSurplus` down to the reserve while open; fully after `close` |
| 2 | Player -> FWA pool: draw price | player buys on FWA; the Balancer's gate must admit it | only if the draw times out (30 blocks without a word): refund credit for the price |
| 3 | Player -> FWA randomness service: fee | same purchase | no, also not on timeout |
| 4 | FWA pool escrow -> owner proceeds (price / 1.05) and FWA edge (5%) | the random word is delivered and the draw processed | no |
| 5 | FWA pool -> winner: prize token | same | no (a failed delivery can be refunded after 7 days and recovered by the creator) |
| 6 | Owner proceeds -> Balancer | anyone (`collectProceeds`), every upkeep and creator action | no |
| 7 | Proceeds -> creator profit: the markup above the game's first 10% | at collection, only while the fund is below the reserve | spent first by the next claim; restocking may spend it when the fund is empty |
| 8 | Balancer -> Shapes / Packs: backing + mint fee, token listed on FWA | keeper upkeep while open, smallest prize first, at most 5 Shapes per call | backing yes (creator `unlistShapes`, only while no draw is unsettled); mint fee no |
| 9 | Balancer -> keeper: reward paid from keeper credit | upkeep that reconciles or restocks; credit grows by the restocking fee of each prize that call lists | fronted by the pool; comes back inside the price of that prize when it is won |
| 10 | Balancer -> keeper: reward for creator-started work | upkeep after `open`, `configure` or unlisting, until the board is restored | no (creator's cost) |
| 11 | Keeper credit -> creator | `close` zeroes the credit | no |
| 12 | Balancer -> creator: claim | creator `claimSurplus` | deposit again |
| 13 | FWA pool -> player: refund credit withdrawn | player | no |

## One-way ratchets and stuck states to watch

- `reconciledSequence` only moves when someone runs upkeep. Draws that timed out or won an NFT add no keeper credit, so
  a profit-only keeper is not paid to reconcile them. Each unreconciled draw counts against the fill gate.
- Listed prices are never repriced: a prize listed at high gas keeps its higher restocking fee until it is won or unlisted.
- `retire` is irreversible. `mintFeeCap` moves only when the creator configures.
- Unlisting and NFT withdrawal wait for every pending draw (FWA rule); ETH does not.
