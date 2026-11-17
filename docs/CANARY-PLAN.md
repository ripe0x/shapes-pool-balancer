# Proposed mainnet canary plan

**Planning only. No deployment, broadcast, real spending or outcome approval is authorized.**
Target: independent-audit candidate `9b45f91`, whose production code matches `55c094f`; any contract repair requires a new target and affected verification. An agent audit is not a human audit or launch approval.

## Preconditions

- Resolve material audit findings and document remaining gaps. Obtain owner signatures on the exact revised asset-flow outcomes and the separately approved mainnet actions.
- Confirm deployment roles, signer, chain, exact FWA implementation/codehash, Shapes and Packs wiring, bytecode size and submitted transaction gas limits through the single production deployment path.
- Complete the current-block local rehearsal, real-wallet writes and external page compatibility checks, or explicitly decide which gaps prevent the named deployment step. Local signed transactions do not prove mainnet service timing or demand.

## Proposed owner-funded limits

| Item | Proposed bound | Enforcement / limitation |
|---|---:|---|
| Initial owner-funded pools | One | Operator-controlled; factory creation is public and has no global pool cap |
| Native ETH deposited to that pool | At most 0.25 ETH cumulative | Operator funding ledger; reject launch if the live opening quote exceeds this bound |
| Initial inventory | Twenty 0.01 ETH Shapes, one creator-owned curated NFT | Configure exact target; NFT token identity and acceptable market exposure must be approved separately |
| Total transaction gas expenditure | At most 0.05 ETH across deployment and all participating owner-controlled accounts | Receipt ledger and stop-before-send budget; quote first, do not assume a future gas price |
| Keeper access during observation | Restricted factory list, one monitored keeper | Creator is always allowed; public unpaid recovery remains available |
| Pool payment limits | Existing immutable per-work/per-call and per-pool burst/refill limits | Cannot be lowered through policy governance; policy may quote less and creator may disable paid upkeep |

These are proposed numbers for one approval, not new owner-approved outcomes. At basefee 0.5 gwei/mint fee 0.001 ETH, the measured twenty-Shape opening deposit is 0.2356 ETH and stocked operating target is 0.00368 ETH. The 0.25 ETH cap leaves 0.0144 ETH above that measured opening requirement; it is not insurance against arbitrary wins, gas growth or mint fee changes. The separately supplied curated NFT is not included in the native-ETH cap. Deployment gas is outside the pool deposit.

## Observation and exit

1. Read all recorded outcome checks from the deployed contracts and actual receipts: real backing and custody, purchaser acquisition/refund rights, operating ETH versus unsold fees, creator profit/claims, keeper payout/gas, actual inventory/admission and pending work.
2. Exercise real purchase, actual oracle fulfillment, upkeep, creator claim, controlled close/recovery and final ETH/NFT reconciliation. Do not substitute deterministic coordinator impersonation on mainnet. A missing oracle response is a service observation, not permission to supply one.
3. Observe an ordinary day plus at least one real refund/recovery lifecycle if it occurs. No artificial mainnet failure is required or authorized. A missing branch remains a gap; elapsed time or draw count alone does not pass the canary.
4. Stop new owner funding on any unexplained ledger gap, unexpected authority/code change, wrong recipient/token, payment above the immutable bounds, quote/receipt loss above the operator's approved allowance or unresolved pending transaction. Close purchases if the creator can, preserve purchaser rights, disable paid upkeep when appropriate, then settle actual draws and unlist/redeem/withdraw only through permitted paths. Retirement does not override FWA's pending-delivery/refund locks.
5. Expand owner funding or keeper eligibility only after readbacks meet every signed outcome and the owner explicitly approves the next values. No automatic cap increase.

## What cannot be capped or claimed

The contracts have no owner-raisable global asset cap or factory creation cap. Restricting the keeper list does not cap third-party creators, player purchases or public unpaid work. The owner-funded pilot is therefore **not an enforceable system-wide capped deployment**. Buyers' assets already in FWA retain its existing protections; closing does not seize their entitlements. A third party can deploy or use this public code independently.

The chosen reserve permits partial inventory and delayed expensive-prize replacement. No canary promises all targets stay stocked, profitability under arbitrary demand, real oracle reliability or safety beyond its observed paths. The keeper needs continuing receipt/accounting and liveness monitoring, including per-pool errors even when its process health endpoint responds successfully.

## Things that don't make sense

None identified in the plan itself. The absence of an enforceable global cap is a concrete limitation to approve before calling any mainnet rollout "capped".
