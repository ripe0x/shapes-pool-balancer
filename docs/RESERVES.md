# Working-capital reserves

Current specification, 2026-11-18. Supersedes inventory-dependent credit attribution and full-restoration policy
activation funding. [Implementation evidence](PROTECTED-REVENUE-RESULTS.md) is scoped separately; historical approvals
do not approve this implementation. No mainnet deployment or real-fund spending is authorized.

## What is protected

Player prizes remain actually backed by Shapes/Draw Packs and held by FWA. FWA also holds draw escrow, delivery escrow and purchaser-owned refund credits. These never fund keeper payments. Balancer ETH and settled owner proceeds are creator operating capital, excluding protected `creatorCredit` for both paid and unpaid maintenance. Existing listing prices and base values remain fixed under policy/rate changes.

The full reserve restricts operating-capital withdrawals and checks opening funding. Activation uses only its maintenance component. It is not an accrued debt to a keeper before work, an untouched perpetual buffer, or a guarantee of unlimited fully restored inventory. Successful paid operations pay the final bounded quote and caller minimum atomically; unavailable compensation reverts the entire transaction. Legitimate maintenance can consume working capital and leave the pool below its current funding target.

## Chosen formula

For the cached selected policy maximum M and current block basefee:

```text
reserveReference = min(basefee + 0.1 gwei, 50 gwei)
workGas = min(6,000,000,
    200,000 + 1,800,000*processedDraws + 150,000*reconciledDraws
    + 700,000*listedShapeUnits + 150,000*listedPrizes)
workBound = min(M, 0.311 ETH,
    (workGas + 100,000)*reserveReference
    + 0.00005 ETH*(reconciledDraws + listedShapeUnits))
```

While open, required liquid operating capital is:

1. Actual missing target inventory: redeemable backing plus the real accepted/current mint fee per contained Shape.
2. Current missing inventory's canonical listing budgets, grouped by the real five-Shape/four-size/value-order limits. Complete same-size batches are counted arithmetically; the calculation does not loop over every prize.
3. Actual issued-but-unreconciled draws times the single-draw bound (one processed and one reconciled draw).
4. One working-call buffer: the greater bound for two processed/five reconciled draws, or five reconciled draws plus five successfully listed Shape units/prizes.

When closed, only item 3 remains while payments are enabled. When payments are disabled all keeper budget terms are zero; open pools retain only actual missing inventory cost. Delayed activation reenables payment and must fund the positive candidate budget. Current mint fee cannot be understated by an older accepted fee. Old unsold surcharges never offset these ETH requirements. Expected fees may be derived from listing records for information; no fee accumulator is stored.

The largest-prize duplicate backing, implied spare draw, full-board future maintenance cycle, fee-income bridge and multiplication of every missing Shape unit by an unrelated full-call maximum are removed. There is no new tax or player-price increase. V1's quoted formula and restocking surcharge are unchanged.

The reference price is current, not a promise that the initial deposit covers all later gas regimes. Gas growth or a mint-fee increase can raise the target and require replenishment, a smaller target or unpaid maintenance. Actual pending draws are counted, not a presumed maximum of five: FWA checks its operator once per requested batch, so an existing four plus a new five can exceed that threshold.

## Payment and affordability

The pool clamps a policy's proposal to the same work-sensitive envelope, using the lesser of measured gas and workGas, and the lesser of actual gas price and reserveReference. These coefficients are enforced payment ceilings; they are not assertions that every external execution fits within those gas amounts. The cached selected maximum, immutable absolute maximum, real operating liquidity and persistent spending allowance are additional restrictions. The policy cannot decide work counts or alter these checks.

Paid inventory planning retains creator credit and the payment bound for the exact candidate work accumulated in the current call. It can reduce a candidate quantity, mint fewer prizes, and leave a visible deficit. It no longer withholds an unrelated entire policy maximum for a one-prize operation. Work still stops at the first unaffordable missing denomination; existing value order and custody rules remain.

The per-pool spending allowance is separate from cash locked in reserve: 0.622 ETH burst and `floor(0.05 ETH / 12)` wei/second refill. It persists through changes of policy, ownership, target and open state, and saturates during inactivity. This permits ordinary V1 work while reducing the previous absolute exposure. Actual high-volume evidence must support its operational suitability; arithmetic bounds alone do not establish profitability.

## Admission and recovery

Initial opening funds and completes the target before admitting players. Subsequent ordinary depletion may trade if the existing 70% inverse-backing-weight gate, curated-NFT presence, busy threshold and mint-fee checks permit it. A markup edit does not turn an operating partial board into initial setup again. Reopening a closed incomplete design still requires its current opening capital; reducing the design is an explicit alternative.

The operation-aware admission formula in [SPEC.md](SPEC.md) retains concurrency and credits only the previously reserved staging and next six records FWA guarantees to activate before the first new selection. A single conservative Shape/Pack staging-count upper bound also caps that loss estimate, so unrelated curated-only staging does not force Shape depletion. It needs no queue sync or keeper call between every batch, changes no reserve/payment coefficient and is not a spending counter. A large staged target increase can still pause; after requests settle, anyone may use FWA `activateListings(20)` repeatedly. This spends caller gas, pays no Balancer reward and requires no additional backing capital. Tracked-curated presence retains its prior reconciliation lag.

An expensive missing prize can have very little inverse weight, permitting continued sales. FWA prices actual listed inventory; odds and prices change when prizes leave or return. The dashboard shows the deficit rather than claiming the target is stocked. New proceeds can accumulate toward replacement, but its duration is unknown without actual demand.

If small-prize depletion crosses the admission threshold, future purchases cannot refill a paused pool. Existing owner proceeds, Add ETH, an explicit smaller target, appropriate unlisting/redemption or closing provide recovery. Losing the last curated NFT also requires creator action. No simulation may assume invisible creator deposits or automatic curated-NFT replacement.

Public unpaid maintenance preserves selected healthy prices and the immutable V1 fallback on policy quote failure. It can process/reconcile, restock what is affordable and support closing/retirement; the caller pays gas. Dependency pauses, delivery locks and buyer refund timing remain in force.

## Policy activation and protected credit

`maintenanceBudget(M, snapshot)` factors items 3 and 4 above. Activation and `policyFunding(candidate)` use one
snapshot of current basefee, pool enabled state and actual issued-minus-reconciled requests; they make no mint-fee or
policy economic quote read. Candidate interface/max validation remains a bounded static call. The old effective maximum
is zero when paid upkeep is disabled. If the candidate maintenance budget is no greater than the old budget, activation
requires no extra cash. If greater, operating cash must cover the whole candidate budget. `policyFunding` returns the
candidate maintenance budget as `required`; `shortfall` is zero for a nonincrease, otherwise
`max(candidateBudget - operatingCash, 0)`. The shared planner uses identical semantics. Delay expiry does not freeze work
counts or gas: activation rechecks both. Full opening/withdrawal reserve is unchanged by this separation.

For example, at basefee 0.5 gwei and two unreconciled requests, V1's candidate maintenance budget is 0.00648 ETH.
A previous 0.001 ETH maximum implies a 0.003 ETH old budget. For the increase, funding only the 0.00348 ETH difference
is insufficient. The entire 0.00648 ETH must be operating cash. Missing 100 ETH inventory does not become activation
funding; it remains visible in the separate restoration shortfall.

`creatorCredit` is always protected. Both paid and unpaid replacement affordability retain it, keeper payments use
`balance - creatorCredit`, and capital claims reserve operating cash after excluding credit. Closing never resets credit.
Credit-only claims bypass all reserve and dependency reads. With B=0.20 ETH, C=0.02 ETH and R=0.10 ETH, O=0.18 ETH and
withdrawable=C+max(O-R,0)=0.10 ETH. The 0% and 100% collection rates are valid; at 100%, operating replenishment receives
zero new revenue. A creator can withdraw and redeposit voluntarily, with no reinvestment API.

## Alternatives considered

| Approach | Capital and guarantee | Decision |
|---|---|---|
| A: retain full immediate replacement insurance with tighter classes | Removes exaggerated keeper multiples but still duplicates the largest backing and future work | Too costly for a 100 ETH top prize; unnecessary for purchaser custody |
| B: current missing work plus a consumable working buffer | Funds paid setup and current work; allows transparent partial depletion and conditional recovery | Implemented |
| C: largest-prize hybrid without the full-board cycle | Lower keeper reserve but retains a potentially enormous second largest-prize backing | Not selected; same top-prize capital problem |
| Zero operating reserve | Creator can strip all maintenance cash; paid setup/reconciliation becomes unreliable | Not selected; the displayed minimum would hide necessary expense |

Shape markup above the first 10% calibrates only the planner's initial rate suggestion. Runtime credit is the stored
share of actual collections. There is no inventory attribution, historical-markup mapping, allocation-drift tolerance or
unsold-fee accumulator. Fees, gas, curated contributions and bad prize luck can still make the creator lose money.

## Things that don't make sense

Guaranteed immediate replacement of every possible win and minimum launch capital are different products. This implementation chooses conditional operation with explicit deficits, rather than duplicating expensive prize backing. A paused low-liquidity pool cannot recover from hypothetical demand alone, and a flat positive work fee can subsidize buyer/keeper activity from creator capital at very low gas. The measured low-gas expiry case selected `ReserveReviewMaxPolicy` at its maximum-paying behavior and deliberately withheld randomness past the timeout. Buyer plus keeper gained 0.000047094427 ETH from creator operating cash at basefee 0.0005 gwei/bid 0.001 gwei; the combined creator/buyer/keeper loss of 0.000003158689 ETH reconciles costs and does not protect the creator from that subsidy. This local execution does not establish that an outside buyer can force expiry with a normally operating oracle. See [the experiment and its limits](PROTECTED-REVENUE-RESULTS.md).
