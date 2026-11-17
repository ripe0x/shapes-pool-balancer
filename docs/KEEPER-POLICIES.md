# Replaceable keeper policies

Implementation is based on `origin/main` `a29af3a`, branch `codex/replaceable-keeper-policies`, 2026-11-17.
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

The immutable 0.311 ETH per-call ceiling preserves current main's security ceiling (decision 88), rather than the
older 0.01635 ETH default quoted in the request. Pool enforcement additionally limits proposed compensation to actual
validated work and the fixed measured-gas envelope: at most 6M measured gas plus 200k overhead, at the lesser of the
actual bid, basefee + 2 gwei, and 50 gwei, plus 0.001 ETH per verified draw or listed Shape unit. The selected policy's
cached declared maximum is another cap, not a trusted quote. A policy cannot increase that cached maximum itself.

An immutable listing-surcharge ceiling of 0.102 ETH per contained Shape also bounds quoted prices.

The per-pool token bucket starts at 3.11 ETH (ten hard maximum calls) and refills at floor(0.311 ETH / 12 seconds). Ten calls budget separate reconciliation and replacement for a five-draw burst; refill budgets one hard-maximum call per 12 seconds. Normal V1 calls consume much less, so the 1,000-prize initial fill and measured high-volume rehearsal remain below this allowance. This is a conservative exposure choice, not a measured optimal risk budget.
Worst permitted expenditure is 2,242.3099999999999424 ETH in 24 hours and 817,311.109999999978976 ETH in 365 days, including the initial burst. These deliberately generous absolute bounds are further restricted by real work and creator-owned liquid funds. Over elapsed time T, expenditure is at most `3.11 ETH + T * refillPerSecond`, further bounded by completed work,
liquid creator operating capital and the per-call caps. Inactivity saturates at the burst. Closing, reopening,
reconfiguration, ownership transfer and policy replacement never reset it. This generous limit allows launch-scale
and stressed traffic, but does not guarantee unrestricted future paid throughput. It bounds exposure, not profitability.
Payments are atomic: insufficient allowance, available operating ETH, quote failure, or failure to satisfy the caller's
minimum payment reverts all work. The three-argument paid entry point enforces `reward >= minimumFixed + minimumGas * tx.gasprice`, so the caller's expense floor follows the mined fee. The one- and two-argument compatibility entry points remain. Caller minimums and the policy-generation hash protect pending transactions.

Activation checks `balance - profit`, because already booked creator profit is withdrawable. Required reserves use
cached bounds without calling a policy. Closing holds one maximum payment per unreconciled draw, including split work.
Open reserves cover missing inventory, the largest prize per unreconciled draw plus a spare, and worst split work.

An additional board-cycle reserve covers fixed old fee contributions:

```text
boardCycleGap = max(
    2 * max(targetPrizeCount, activeShapePrizeCount) * cachedPolicyMaximum
    - sum(activeShapeListing.price - activeShapeListing.base), 0
)
```

This holds actual ETH against a future income shortfall; the recorded unsold fees are never counted as received ETH.
The aggregate fee sum updates on listing and removal using existing item records. No per-listing policy address or
policy generation is needed. Missing future prizes count with zero fee, so initial setup cannot create an unfunded
reserve increase. This deliberately conservative assumption budgets one separate reconcile and one restock per prize.
At 1,000 single-Shape prizes it can hold nearly 32.9 ETH before fee offsets, a substantial capital cost. Closing
releases this board-cycle hold while preserving unreconciled-draw obligations. Withdrawals retain the current reserve;
withdrawals after proposing can increase the shortfall and cannot bypass activation's final funding check.

No reserve can guarantee an arbitrary policy remains self-funding over unlimited draws. A higher payment schedule
or lower future surcharge can consume creator capital. Purchasers' draw escrow, refunds, prize backing and FWA's
entitlements remain in the real dependency contracts and are outside the keeper payout path.

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
