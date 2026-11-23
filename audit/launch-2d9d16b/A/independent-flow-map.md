# Informed step A: independent flow derivation

Derived from `src/PoolBalancer.sol`, `src/PoolInventory.sol`, and `src/KeeperPolicyCalls.sol` before reading the builder's flow breakdown or running the asset gate. This is a hypothesis to test, not an accepted outcome.

| Trigger | Source | Destination | Reversal or claim |
| --- | --- | --- | --- |
| Creation, `depositETH`, plain ETH transfer | creator or donor | Balancer liquid ETH | Creator may claim credit and operating surplus; on close remaining cash belongs to creator, including donations. |
| Curated listing | creator's ERC721 wallet | FWA pool custody | Creator withdraws if no unsettled draw; winner receives it, or creator recovers after a failed delivery and player refund. |
| Shape/Pack restock | Balancer liquid ETH | Shapes mint fee recipient and redeemable backing in minted NFT, then FWA custody | Fee is one-way. Backing redeems at the denomination when unlisted or recovered; prize ownership transfers to winner on a successful draw. |
| Purchase | buyer | FWA draw proceeds and randomness fee/edge | FWA refunds failed delivery according to its rules; spent randomness fee and FWA edge are one-way. |
| Proceeds collection | FWA pool owner proceeds | Balancer cash and `creatorCredit` at stored `creatorRevenueBps` | Creator may claim credit immediately; remaining cash supports work and inventory. |
| Paid upkeep | Balancer uncredited operating cash | caller/keeper | Only verified work earns a quote, bounded by gas/service envelope, liquidity and rate allowance. No return transfer. |
| Unpaid upkeep | caller's gas | pool continuity | No compensation; may still list Shapes, spending Balancer cash for backing and mint fees. |
| Close, unlist, claim | FWA Shape/Pack custody and Balancer cash | Balancer redeemed backing, then creator | Pending draws and refund claims remain; held keeper compensation for unreconciled draws stays until settled or payment disabled. |

Admission mode changes only the purchase gate. Standard mode permits a Shapes-only board and continues after the last curated NFT is won. Curated-required mode needs a provably active curated NFT; losing the witness may require a public paid-gas proof refresh, and staged-only curated inventory must activate first. Both modes retain the 70% Shape weight gate, pending-draw cap and initial-setup gate. A pool can move between modes by creator action; existing listing prices and ownership do not change. A Shapes-only board has no NFT relisting cost; a curated-required board needs creator NFT replenishment after the last curated win. All modes charge purchases through FWA and pay keeper work from Balancer cash.

Potential economic asymmetries to test: (1) curated-required zero-curated pool cannot admit even with funded Shapes; (2) standard zero-curated pool must still admit; (3) switching modes with pending draws must not move or reprice assets; (4) curator NFT relisting consumes creator gas and NFT opportunity cost but no Shape mint fee, and after the last curated win liveness depends on creator relisting or mode switch; (5) a buyer may pay randomness fees on expired or failed-delivery draws while refund rights remain in FWA; (6) a creator may book up to 100% of collected proceeds even with inventory depleted, so liquidity for later refill may come only from new ETH or further sales; (7) policy quotes and reward bounds may leave an unprofitable keeper at high gas despite a successful pool operation.
