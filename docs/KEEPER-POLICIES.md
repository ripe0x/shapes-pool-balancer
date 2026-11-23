# Replaceable keeper policies

Current specification, 2026-11-18. Protected credit, metadata removal, one paid entry point and maintenance-only
activation replace earlier policy documentation. [Implementation evidence](PROTECTED-REVENUE-RESULTS.md) records
verification separately. No mainnet deployment or real spending is authorized.

## Authority and immutable boundaries

`IKeeperPolicy` interface version 1 quotes rewards from actual completed `Work` and quotes a surcharge for one
Shape or Draw Pack prize. `KeeperPolicyV1` is stateless. Policies receive no assets, approvals, arbitrary transaction
capability, purchase-operator authority, or authority to decide useful work. Calls are `staticcall`, limited to
100,000 gas with a fixed output buffer and exact return-length checks. The pool validates work and enforces all caps.
An interface-compatible contract need not be honest or stateless; all financial protection assumes it may be malicious.

Each clone snapshots its factory's default policy at initialization. The keeper eligibility admin only manages
eligibility. A separate `policyAdmin` sets a new factory recommendation with `setDefaultKeeperPolicy(address)`,
immediately. This changes future clones only. Both admin roles transfer by two-step acceptance.

**Changes are immediate (decision 103, superseding the two-day delay of R41/R51).** The creator calls
`setKeeperPolicy(address)`: the switch applies at once, with funding rechecked in the same transaction.
`setPaidUpkeepEnabled(false)` disables payments immediately (emergency stop); `setPaidUpkeepEnabled(true)` re-enables
immediately with the same funding check. Setting a policy also re-enables paid upkeep. There is no proposal, pending
state, activation window or `generation`; `settingsHash` hashes the policy, its maximum and whether paid upkeep is
enabled, so a disable/re-enable or same-policy re-set returns to identical terms and a stale keeper offer still
reverts `StaleSettings`. Events expose every switch and enable/disable.

**Factory settings (decision 103).** The `policyAdmin` also holds the adjustable behaviour-shaping settings
(`IBalancerFactory.Settings`: `maxPrizes`, `fillGateBps`, `minMarkupBps`, `maxMarkupBps`, `maxOps`, `maxReconcile`,
`maxProcess`, `maxRestockSizes`, `curatedBatch`), each set immediately with a `SettingChanged(key, value)` event and
fixed sanity bounds; defaults equal the former constants. Pools read them live, except the fill gate, which each pool
caches (`fillGateBps`) for FWA's 100k admission hook and refreshes at creation, on `configure`, on every upkeep and via
the permissionless `syncSettings()`. A settings change never invalidates an already-configured target.

**Restock quote cap (decision 103).** The per-Shape surcharge a selected policy may quote is capped at
`units * (1_800_000 * referencePrice(baseFee) + 0.0004 ether)` (2x V1's 900k gas and 0.0002 ETH flat at the reference
price), replacing the former flat `units * 0.102 ether`. V1 always passes; a policy quoting materially above a
reasonable gas cost is refused on the paid path and falls back to the immutable V1 recovery surcharge on the unpaid path.

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
curated NFTs list at their creator-assigned price with no markup or surcharge. Old `Item.price`, `Item.base`, FWA listing prices never change merely because a policy changes.

## Financial limits and operating capital

The current reserve/payment kernel is specified in [RESERVES.md](RESERVES.md). It supersedes the capital-intensive `a8fb321` board-cycle bridge. The selected maximum remains cached, with an immutable 0.311 ETH per-call ceiling, but a tighter operation-sensitive gas/work envelope constrains actual proposals. Policy code still cannot change custody, useful-work validation, creator ownership or any enforcement bound.

At 0.5 gwei basefee, twenty small Shapes need 0.2356 ETH to open for paid setup, including 0.22 ETH backing/mint expense, 0.01192 ETH bounded initial listing work and a 0.00368 ETH working buffer. Once stocked, only that buffer remains in the liquid reserve. There is no duplicate largest-prize backing and no full-board future keeper payment hold. Actual missing inventory and its current listing work, plus issued-but-unreconciled draws, restrict withdrawals as they arise. Expected surcharges inside unsold prizes are displayed but never treated as cash or subtracted from the new reserve.

Reference price for security budgets is `min(basefee + 0.1 gwei, 50 gwei)`. Actual payout also respects the actual bid and measured work. The service envelope is 0.00005 ETH per verified draw/Shape unit. Operation coefficients and all remaining components are immutable and exported for planner parity. They are payment bounds, not universal execution-gas claims. V1's own quote and surcharge formulas above remain unchanged.

The per-pool burst/refill allowance was removed (decision 103): the old 0.622 ETH burst and `floor(0.05 ETH / 12)`
wei/second refill allowed about 360 ETH/day, so it bounded nothing. Each paid call is bounded by current validated
work, the selected maximum, the immutable `HARD_MAX_REWARD` (0.311 ETH) and creator-owned operating liquidity; there
is no cumulative per-pool budget.

A policy switch validates the candidate and compares its current maintenance budget with the old effective budget from
the same snapshot. The old paid maximum is zero when disabled. No-greater maintenance exposure needs no additional
funding, even with missing expensive inventory. Increased exposure requires operating cash covering the entire
candidate maintenance budget. Missing inventory restoration is excluded here and remains in full withdrawal/opening
reserves. Creator credit, uncollected proceeds, listed backing and future fees cannot fund activation. A smaller
permitted maximum need not quote a smaller reward on each job. Existing prices stay unchanged; there is no per-pool spending allowance.

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

The creator dashboard uses bounded pool-context quotes, preserves existing listing prices,
shows proposed activation and shortfall, permits top-ups and cancellation, and exposes emergency disable and unpaid
maintenance. There is no `settings()` metadata decoding or linear-policy compatibility getter in contracts or clients. The keeper
uses its operator bidding configuration independently of policy reimbursement and simulates the complete transaction.
Unknown costs must remain visibly unknown. Historical gas and simulation reports do not validate this implementation.

The only paid entry point is `performUpkeep(expectedPolicyHash, minimumFixed, minimumGas)`. The atomic floor is
`minimumFixed + minimumGas * tx.gasprice`; zero gas means a fixed floor and both zero accept the offered compensation.
`performUpkeepUnpaid()` remains permissionless. The generation hash is exposed as `settingsHash()` for existing keeper
journal terminology; it encodes policy address, cached maximum, generation and payment state, with no settings metadata.
There are no paid overloads or arbitrary selected-policy delegatecalls. Linked immutable libraries remain fixed.

## Verification status

See [PROTECTED-REVENUE-RESULTS.md](PROTECTED-REVENUE-RESULTS.md). Real-dependency tests use the existing controlled
coordinator delivery infrastructure; this does not establish real Chainlink timing or availability. Earlier reports,
source seals and signed outcomes remain historical and do not validate the new implementation. Production release
controls and the sealed historical local rehearsal are preserved.

Things that don't make sense: a 100% creator share supplies no new operating revenue. It is permitted explicitly,
so demand alone cannot fund further mint/keeper costs at that setting.
