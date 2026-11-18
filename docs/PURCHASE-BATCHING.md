# Batch slippage and the small-board recommendation

**Offer fresh single draws as an advisory choice for small boards. Keep FWA's price protection and concurrent admission.** The Balancer purchase hook cannot enforce a single-request limit: FWA calls `canPurchase(purchaser)` once before a batch and passes no count. A strict per-pool limit needs an FWA interface/configuration change; no such change or external publication is made here.

## Observed local batch

The approved historical local diagnostic used the unchanged `9b45f91` implementation at fork block 26,437,802. All 50 first requests fulfilled. All 87 slippage refunds occurred at positions 2–5 of a batch. This table groups the actual 152 journaled requests, not hypothetical demand:

| Requested batch size | Batches | Prizes delivered | Slippage refunds |
|---|---:|---:|---:|
| 1 | 12 | 12 | 0 |
| 2 | 9 | 12 | 6 |
| 3 | 8 | 11 | 13 |
| 4 | 7 | 9 | 19 |
| 5 | 14 | 21 | 49 |

FWA escrowed the same initial fee for each request, then checked each against the canonical live price at its ordered turn. Removing cheap prizes raised the harmonic-mean board price. Actual refunded-request positive drift was 10.1813%–25.035%, median 10.3031%, exceeding the unchanged 10% limit. Later restocks cannot be inserted into an already-issued request's immutable activation batch. Increasing the buyer's **negative** tolerance does not change this **positive** bound.

Refunded acquisition principal remains buyer-owned, but refunds are not economically harmless. Actual `VrfServiceFeePaid` receipts total 0.574938 test ETH across all 152 requests; the 87 refunded requests consumed **0.375102 test ETH** of nonrefundable randomness service charges. Those service charges are separate from the previously reported 0.203466407875872872 ETH transaction gas. The refunded-request VRF costs were 0.011232 ETH at 0.08 gwei, 0.06318 at 3 gwei, 0.05733 at 4.9 gwei and 0.24336 at 8 gwei. These are synthetic stress regimes, not observed market demand or EIP-1559 reachability evidence.

## Controlled fork comparison

`test/BatchSlippage.t.sol` restores the identical board and actor/protocol state between two paths, using the same five deterministic words through the authorized real-coordinator exception. Real FWA and Shapes run at fork block 26,382,349, with 0.08 gwei basefee/bid asserted inside a state-changing witness. The board has ten Shapes (5×0.01, 3×0.05, 2×0.1 ETH), two creator-issued NFTs valued at 0.25/0.5 ETH, 15% markup and a single initial 3 ETH deposit; there are no later pool deposits.

| Same five words | Prizes delivered | Refunds | Total VRF fees | VRF fees on refunded draws |
|---|---:|---:|---:|---:|
| One batch of five | 1 | 4 | 0.000936 ETH | 0.0007488 ETH |
| Five single draws, freshly quoted and fully restocked | 5 | 0 | 0.000936 ETH | 0 |

The test verifies actual buyer ownership, exact real refund withdrawal, paid keeper work, full 0.4 ETH backing restoration and unchanged 10% slippage protection. This is a reached controlled counterfactual, not an assertion that every possible single draw must fulfill or a signed-node receipt comparison. It uses an overfunded board and does not establish minimum-capital resilience, mainnet timing, guaranteed keeper availability or market demand.

## Recommendations and limits

1. Offer sequential single requests with fresh quotes in the purchase interface for small pools; the controlled zero-refund comparison also included full restocking. This is not a mandatory keeper-maintenance barrier for all purchases. The FWA purchase interface owns those transactions; the creator dashboard warning cannot force its behavior.
2. Preserve the existing slippage protection. Do not charge players for retries automatically, raise negative tolerance as a purported fix, or assume a full acquisition refund returns the VRF charge.
3. Expose selectable and staged inventory separately. Activate unreserved staging through FWA's existing permissionless route once requests settle; do not represent it as already selectable.
4. Do not require a larger board merely to make a batching metric look better. Extra inventory consumes creator capital. Board-specific batch risk and VRF cost should inform an explicit buyer choice if bulk purchase remains offered.
5. The owner has decided to preserve concurrent purchases and bounded approximate creator allocation (R55–R58). `_collect` is retained; measured allocation drift and the outstanding numerical outcome decision are recorded in `AUDIT-REMEDIATION.md`. Resolving batching UX does not make E1 drift disappear, and no serialized snapshot design is adopted.

## Things that don't make sense

Treating refunded draws as harmless ignores their randomness service cost. Entitlement conservation alone does not establish an acceptable purchase experience.
