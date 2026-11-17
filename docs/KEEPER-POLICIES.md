# Replaceable keeper policies

Policy architecture began at `origin/main` `a29af3a`; current reserve redesign starts from `a8fb321`, branch `codex/replaceable-keeper-policies`, 2026-11-17.
No mainnet deployment or real spending is authorized. Verification and independent review are recorded separately;
this specification does not establish release readiness.

## Authority and immutable boundaries

`IKeeperPolicy` interface version 1 quotes rewards from actual completed `Work` and quotes a surcharge for one
Shape or Draw Pack prize. `KeeperPolicyV1` is stateless. Policies receive no assets, approvals, arbitrary transaction
capability, purchase-operator authority, or authority to decide useful work. Calls are `staticcall`, limited to
100,000 gas with a fixed output buffer and exact return-length checks. The pool validates work and enforces all caps.
An interface-compatible contract need not be honest or stateless; all financial protection assumes it may be malicious.

Each clone snapshots its factory's default policy at initialization. The keeper eligibility admin only manages
eligibility. A separate `policyAdmin` proposes a new factory recommendation; anyone activates after two days.
This changes future clones only. Both admin roles transfer by two-step acceptance.

The creator calls `proposeKeeperPolicy(address)`. Anyone may call `activateKeeperPolicy()` after two days, with
funding rechecked in the activation transaction. `cancelKeeperPolicy()` removes the proposal. A transfer of creator
ownership cancels the old creator's proposal. `setPaidUpkeepEnabled(false)` disables payments and cancels any pending replacement immediately;
reenabling requires delayed activation, even for the same policy. Events expose every proposal, cancellation and switch.

Pool immutability means an already deployed OLD PoolBalancer implementation cannot gain this feature. Pools deployed
with this implementation can change economics without redeployment. No existing production pool is migrated or changed.

## Initial quotes

```text
referencePrice = min(tx.gasprice, block.basefee + 0.05 gwei, 5 gwei)
reward = (min(measuredGas, 3,200,000) + 50,000) * referencePrice
       + (finalizedDrawsReconciled + ShapeUnitsSuccessfullyListed) * 0.00002 ETH
restockingSurchargeForPrize = ShapeUnits * (
    900,000 * min(block.basefee + 0.05 gwei, 5 gwei) + 0.0002 ETH
)
```

A pack contributes its two or three underlying Shapes only after its FWA listing succeeds. Processing a draw and
reconciling it do not earn two service fees. Empty upkeep, unsuccessful processing, collection alone, and repeated
claims earn no fee. Setup listings are useful work. A caller splitting a batch earns the same service total but may
still earn extra overhead/refund surplus; receipt-based economics must include direct FWA processing expenses.

The initial work fee comes from historical 388 calls / 832 draws: the previous call incentive averaged about
0.0000466 ETH per draw. Reconciliation plus one single-Shape replacement now earns 0.00004 ETH, independent of whether
it takes one or two calls. This is a calibration hypothesis, not evidence about future competition or inclusion.
The default maximum is 0.01645 ETH, including up to ten service units. The 50,000 overhead allowance is retained. Receipt calibration below measures its practical margin; it is not a guarantee of keeper profit.

Markup remains separate. Shapes list at backing plus mint fees plus markup on backing plus restocking surcharge;
curated NFTs list at their creator-assigned price with no markup or surcharge. Old `Item.price`, `Item.base`, original
markup share and FWA listing prices never change merely because a policy changes.

## Financial limits and operating capital

The current reserve/payment kernel is specified in [RESERVES.md](RESERVES.md). It supersedes the capital-intensive `a8fb321` board-cycle bridge. The selected maximum remains cached, with an immutable 0.311 ETH per-call ceiling, but a tighter operation-sensitive gas/work envelope constrains actual proposals. Policy code still cannot change custody, useful-work validation, creator ownership or any enforcement bound.

At 0.5 gwei basefee, twenty small Shapes need 0.2356 ETH to open for paid setup, including 0.22 ETH backing/mint expense, 0.01192 ETH bounded initial listing work and a 0.00368 ETH working buffer. Once stocked, only that buffer remains in the liquid reserve. There is no duplicate largest-prize backing and no full-board future keeper payment hold. Actual missing inventory and its current listing work, plus issued-but-unreconciled draws, restrict withdrawals as they arise. Expected surcharges inside unsold prizes are displayed but never treated as cash or subtracted from the new reserve.

Reference price for security budgets is `min(basefee + 0.1 gwei, 50 gwei)`. Actual payout also respects the actual bid and measured work. The service envelope is 0.00005 ETH per verified draw/Shape unit. Operation coefficients and all remaining components are immutable and exported for planner parity. They are payment bounds, not universal execution-gas claims. V1's own quote and surcharge formulas above remain unchanged.

The per-pool allowance has a 0.622 ETH burst and `floor(0.05 ETH / 12)` wei/second refill, never reset by policy/configuration/ownership/open-state changes. It is spending authority, not ETH that must be locked upfront. At most burst plus elapsed-time refill can be paid, additionally bounded by current validated work, the selected maximum and creator-owned operating liquidity. A popular pool uses its own allowance.

Activation checks `balance - bookedProfit >= candidateReserve` at the current gas/mint-fee context. A larger declared maximum only increases funding where it changes present enforced work budgets. Old listings remain fixed. Future higher gas or adverse wins may require additional capital; a finite current reserve does not promise unlimited self-funding. Paid operations may consume their working buffer while respecting booked profit. The caller's mined-price-indexed minimum remains atomic.

Disabling paid upkeep releases payment-related reserve terms, retaining actual missing inventory cost. Delayed reenabling still checks the candidate's positive paid budget. A creator can bootstrap twenty small Shapes unpaid with 0.22 ETH pool funding, paying execution gas separately. Purchaser escrow/refunds remain in FWA regardless of payment state.

## Recovery and clients

`performUpkeepUnpaid()` is permissionless even while the factory restricts paid keepers. It executes the same validated
reconciliation and inventory path with zero compensation. Valid active-policy pricing is retained; failed or invalid price quotes use the immutable V1 recovery surcharge, so essential execution does not depend on a policy succeeding. Policy failure therefore does not require moving assets. Other recovery and retirement actions retain
their existing settlement and ownership checks. Unpaid execution still costs the caller gas and inventory needs capital.

The keeper simulates the actual pool offer with explicit fee fields and a fee-indexed minimum payment. It sets fixed minimum to configured operator costs and gas minimum to traced/estimated expense gas plus guarded-calldata allowance minus floor(configured maximum loss / maximum fee bid), floored at zero. This bounds the modeled accepted loss at any included gas price no greater than the transaction maximum. Changing work or trace error can still cause a revert; actual failed attempts remain costs. Execution gas limits use
`eth_estimateGas` with headroom, capped at EIP-7825's 16,777,216 gas. Expense estimates use optional top-level call
traces when supported and calibrated against receipts, with conservative estimation otherwise. Rewards are never
inverted into an assumed billed cost. Receipt costs, failed attempts, operator overhead and received payments are
separate records. Nonce persistence, replacements, eviction recovery and discovery remain shared across policies.

The creator dashboard uses actual policy quotes, preserves existing listing prices and original fee contributions,
shows proposed activation and shortfall, permits top-ups and cancellation, and exposes emergency disable and unpaid
maintenance. Optional `settings()` metadata describes linear policies; future core-compatible policies need not use it.
Unknown costs must remain visibly unknown. Historical gas and simulation reports do not validate this implementation.

## Verification status

The owner explicitly retained the existing deterministic Chainlink-coordinator impersonation exception on 2026-11-17 for fork/local tests. This does not validate real VRF timing or availability and authorizes no other dependency substitution.

Implementation, real-dependency fork lifecycles, hostile-policy tests, dashboard interactions, candidate checks and
focused independent security/economic reviews are recorded in [keeper-policy-results.md](keeper-policy-results.md). That report preserves failed attempts, repairs and limitations. Existing
signed asset-flow outcomes do not approve this changed payment mechanism; their history must be preserved and the
release gate remains binding. No deployment authorization follows from passing tests.

Things that don't make sense: a small immutable spend cap cannot also promise unlimited future paid throughput;
a full-board worst-case economic guarantee has a large capital cost. Both tradeoffs need owner review before launch.
