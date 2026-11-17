# Working-capital reserves

Current implementation work starts from `a8fb321` on `codex/replaceable-keeper-policies`, 2026-11-17. This replaces its whole-board keeper insurance reserve. No mainnet deployment or real-fund spending is authorized. Final measurements/reviews belong in the reserve redesign results; this specification alone is not release evidence.

## What is protected

Player prizes remain actually backed by Shapes/Draw Packs and held by FWA. FWA also holds draw escrow, delivery escrow and purchaser-owned refund credits. These never fund keeper payments. Balancer ETH and settled owner proceeds are creator operating capital, excluding independently claimable booked creator profit for paid maintenance. Existing listing prices, base values and markup shares do not change under a new policy or a lower reserve.

A reserve is a restriction on creator surplus withdrawals and a funding check at opening/policy activation. It is not an accrued debt to a keeper before work, an untouched perpetual buffer, or a guarantee of unlimited fully restored inventory. Successful paid operations pay the final bounded quote and caller minimum atomically; unavailable compensation reverts the entire transaction. Legitimate maintenance can consume working capital and leave the pool below its current funding target.

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

When closed, only item 3 remains while payments are enabled. When payments are disabled all keeper budget terms are zero; open pools retain only actual missing inventory cost. Delayed activation reenables payment and must fund the positive candidate budget. Current mint fee cannot be understated by an older accepted fee. Old unsold surcharges never offset these ETH requirements. The expected fee sum remains available for creator information only.

The largest-prize duplicate backing, implied spare draw, full-board future maintenance cycle, fee-income bridge and multiplication of every missing Shape unit by an unrelated full-call maximum are removed. There is no new tax or player-price increase. V1's quoted formula and restocking surcharge are unchanged.

The reference price is current, not a promise that the initial deposit covers all later gas regimes. Gas growth or a mint-fee increase can raise the target and require replenishment, a smaller target or unpaid maintenance. Actual pending draws are counted, not a presumed maximum of five: FWA checks its operator once per requested batch, so an existing four plus a new five can exceed that threshold.

## Payment and affordability

The pool clamps a policy's proposal to the same work-sensitive envelope, using the lesser of measured gas and workGas, and the lesser of actual gas price and reserveReference. These coefficients are enforced payment ceilings; they are not assertions that every external execution fits within those gas amounts. The cached selected maximum, immutable absolute maximum, real operating liquidity and persistent spending allowance are additional restrictions. The policy cannot decide work counts or alter these checks.

Paid inventory planning retains booked profit and the payment bound for the exact candidate work accumulated in the current call. It can reduce a candidate quantity, mint fewer prizes, and leave a visible deficit. It no longer withholds an unrelated entire policy maximum for a one-prize operation. Work still stops at the first unaffordable missing denomination; existing value order and custody rules remain.

The per-pool spending allowance is separate from cash locked in reserve: 0.622 ETH burst and `floor(0.05 ETH / 12)` wei/second refill. It persists through changes of policy, ownership, target and open state, and saturates during inactivity. This permits ordinary V1 work while reducing the previous absolute exposure. Actual high-volume evidence must support its operational suitability; arithmetic bounds alone do not establish profitability.

## Admission and recovery

Initial opening funds and completes the target before admitting players. Subsequent ordinary depletion may trade if the existing 70% inverse-backing-weight gate, curated-NFT presence, busy threshold and mint-fee checks permit it. A markup edit does not turn an operating partial board into initial setup again. Reopening a closed incomplete design still requires its current opening capital; reducing the design is an explicit alternative.

An expensive missing prize can have very little inverse weight, permitting continued sales. FWA prices actual listed inventory; odds and prices change when prizes leave or return. The dashboard shows the deficit rather than claiming the target is stocked. New proceeds can accumulate toward replacement, but its duration is unknown without actual demand.

If small-prize depletion crosses the admission threshold, future purchases cannot refill a paused pool. Existing owner proceeds, Add ETH, an explicit smaller target, appropriate unlisting/redemption or closing provide recovery. Losing the last curated NFT also requires creator action. No simulation may assume invisible creator deposits or automatic curated-NFT replacement.

Public unpaid maintenance preserves selected healthy prices and the immutable V1 fallback on policy quote failure. It can process/reconcile, restock what is affordable and support closing/retirement; the caller pays gas. Dependency pauses, delivery locks and buyer refund timing remain in force.

## Alternatives considered

| Approach | Capital and guarantee | Decision |
|---|---|---|
| A: retain full immediate replacement insurance with tighter classes | Removes exaggerated keeper multiples but still duplicates the largest backing and future work | Too costly for a 100 ETH top prize; unnecessary for purchaser custody |
| B: current missing work plus a consumable working buffer | Funds paid setup and current work; allows transparent partial depletion and conditional recovery | Implemented |
| C: largest-prize hybrid without the full-board cycle | Lower keeper reserve but retains a potentially enormous second largest-prize backing | Not selected; same top-prize capital problem |
| Zero operating reserve | Creator can strip all maintenance cash; paid setup/reconciliation becomes unreliable | Not selected; the displayed minimum would hide necessary expense |

The first 10% of markup remains a replenishment priority, not permanent third-party escrow. The above-10% share is always booked while open before collection is followed by reconciliation/paid restocking, preserving the allocation when a new deficit is recognized. A lower target releases surplus earlier; that withdrawal timing change is intentional and must be measured. Fees, gas and bad prize luck can still make the creator lose money.

## Things that don't make sense

Guaranteed immediate replacement of every possible win and minimum launch capital are different products. This implementation chooses conditional operation with explicit deficits, rather than duplicating expensive prize backing. A paused low-liquidity pool cannot recover from hypothetical demand alone, and a flat positive work fee can subsidize buyer/keeper activity from creator capital at very low gas. Final economic evidence must quantify both coalition-wide loss and that separate subsidy.
