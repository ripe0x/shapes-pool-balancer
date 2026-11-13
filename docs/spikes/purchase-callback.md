# Spike: prize wrapper with FWA's purchase callback

Status: exploration, not for release. Code on branch `spike/purchase-callback`: `PoolBalancer.onPrizeWon` and
`test/spike/PurchaseCallback.t.sol` (`SpikePrizeWrapper`). Source read from `external/fwa-poolsv2` (Sourcify).

Run: `forge test --match-path test/spike/PurchaseCallback.t.sol --isolate -vv` (mainnet fork block 26,382,349, basefee
0.5 gwei and gas price 1 gwei asserted inside a transaction, real FWA pool, notifier, randomness service and BAYC; the
randomness delivery is its own transaction, so storage is cold).

## What FWA does (source, `PoolPurchaseNotifier.sol`, `StandardPool.sol`)

- After a draw is **fulfilled and delivered**, and final accounting is done, the pool calls the notifier (300,000 gas),
  which calls the won listing's collection with `onPoolPurchase(Purchase)` and **100,000 gas** if the collection
  answers true to `supportsInterface(0x43beda8c)`.
- A failing or out-of-gas receiver is ignored and **never retried**. FWA's interface says: "A receiver must not depend
  on a notification for correctness."
- Expired or timed-out draws are never notified.
- The pool's reentrancy lock is held, so the receiver cannot call `withdrawOwnerProceeds` or any other guarded pool
  function. Views work.

## Answers to the six questions from PR #3

| # | Question | Answer | Evidence |
| --- | --- | --- | --- |
| 1 | Does the Balancer's per-win bookkeeping fit in 100,000 gas? | **Yes for the bookkeeping alone: 57,471 gas** used by the wrapper body (authenticate notifier and pool, Balancer reads FWA's listing status, `_onDrawn` on a curated win). About 40k headroom. A Shape win also writes `activeShapes` and `prizeWeight`: not measured, estimated 5k-10k. | `test_forwardFitsAndReconcileSkips` |
| 2 | What happens when a callback is missed? | Reconciliation handles it unchanged. When the callback did run, reconciliation skips the item (`_onDrawn` ignores inactive items) and still advances the sequence. Reconcile cannot be removed: timeouts are never notified and notifications are never retried. The fill gate still subtracts one 0.01 prize per unreconciled draw, so a win the callback already removed is counted twice (stricter than needed) unless the gate learns which sequences were handled. | `test_missedCallbackFallsBackToReconcile`, `test_forwardFitsAndReconcileSkips` |
| 3 | Wrapper or underlying to the winner? | **Underlying does not fit for BAYC**: the unwrap alone fails inside 100,000 gas, with or without the Balancer call; a manual unwrap costs 118,279 gas. The winner receives the wrapper and needs one more transaction. Collections with cheaper transfers may fit; it cannot be relied on per collection. | `test_unwrapInsideCallback`, `test_unwrapOnlyInsideCallback` |
| 4 | Metadata and FWA display | Not tested. A wrapper can return the underlying `tokenURI`, but FWA's site, wallets and marketplaces show the wrapper's collection. Only FWA can say how their site lists it. | gap |
| 5 | Draw Packs with a native callback, wrapping only curated NFTs | Covers Pack prizes only. Small Shape prizes are listed as Shapes and get no callback; curated NFTs still need the wrapper; timeouts still need reconcile. It also needs a Draw Packs change in its own repository and its own audit. | analysis |
| 6 | Restocking | Still its own transaction: mint and list is far above 100,000 gas. Reconcile already runs in that same call. | analysis |

## New finding: the callback undoes the profit-split fix

DECISIONS 69 collects proceeds before a won listing leaves the tracked set, because the creator's share is
`proceeds × profitShareSum / (n × 1e18)` over the listings the draw was priced on. The callback removes the listing at
settlement, and it cannot collect first (the pool is locked). Same NFT draw, fund below the reserve:

| Path | Profit booked to the creator |
| --- | --- |
| No callback (reconcile after collect) | 0.000497147884203450 ETH |
| Callback before collect | 0.000546862672623795 ETH (+10.0%, the 11/10 skew from one of 11 listings removed) |

Fixing it would mean booking each draw's split inside the callback from `Purchase.amountPaid` before removal, while
draws without a callback keep the current path: two accounting paths for one quantity. (`test_profitSplitWithAndWithoutCallback`)

## What it would buy

- The Balancer's prize state is exact at settlement, so the fill gate is exact between upkeeps (only if the gate is
  also changed, see question 2).
- An NFT win no longer needs a prompt reconcile-only call; the next restock call can advance the sequence. Saving: one
  paid call per NFT win: (measured gas + 50,000) × price + 0.0001 ETH, about 0.0002 ETH at 0.5 gwei for a
  reconcile-only call (measured 100k-164k gas).
- Shape wins save nothing: restocking needs its own call, which reconciles in the same transaction.

## What it would cost

- A new asset-holding wrapper contract (custody of every curated NFT), plus a Balancer entry point, a split
  redesign and a gate change, all needing audit.
- Winners of curated NFTs receive a wrapper and pay about 118k gas to unwrap (BAYC).
- A second state-changing path that can silently not run.

## Recommendation

Do not build it for the first release. Reconciliation must stay either way, and the saving is about 0.0002 ETH per NFT
win. Revisit if FWA notifies expiries and timeouts, or if reconcile-only keeper pay becomes a measurable cost in
the live data.

## Things that don't make sense

- FWA's public docs say standard pools do not dispatch callbacks; the deployed source does. The source wins, but FWA
  should confirm whether this is supported for third-party collections.
- The spike measured one curated collection (BAYC). Gas for other collections' transfers varies widely.
