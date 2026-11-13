# Informed challenge: creator work attribution after an issued draw

**Disposition: accepted with bounds.** The pinned-fork PoC demonstrates that a creator can call `configure` with the same economic configuration after a purchase request is issued, causing upkeep for the later delivered Shape draw to bypass the purchase-caused incentive cap. This requires the creator's authority; it is not an outsider-only route. Whether it is a security finding depends on whether the stated purchase-caused cap must hold despite an intervening creator action. The code and `docs/SPEC.md` describe both that cap and a full-reward exception for work a creator action starts. Here the draw already existed when the creator called `configure`, so the action changed its **classification**, not its cause.

## Demonstrated path

`audit/controller/CreatorWorkCredit.t.sol` creates a funded Balancer on the pinned mainnet fork, admits a pool with one Shape, and issues one purchase. The later `configure(1 ether, 0, plans)` uses the same single plan, price limit, odds floor, and markup. It is economically unchanged, although it does write configuration, reset `activePlan`, invalidate the checkpoint, and set `creatorWork=true` through `_invalidate()`. The purchase then delivers the Shape. `_sync` reconciles that draw, computes `incentiveCredit` from its delivered fee, collects base proceeds, and refills the Shape. `_payKeeper` sees `creatorWork=true`, pays the full incentive, and does not decrement credit. `performUpkeep` resets the flag once the new checkpoint is valid.

The test asserts delivered acquisition status 2, Shape selection, keeper ETH balance increase equal to the returned reward, one active replacement Shape, and unchanged `incentiveCredit`. The saved `CreatorWorkCredit.out` records one passing test. Its figures are:

| Quantity | Wei |
| --- | ---: |
| Buyer acquisition fee, excluding VRF service fee | 8,049,999,999,999,999 |
| Delivered edge credit (`paid × 500 / 10,500`) | 383,333,333,333,333 |
| Gas-only keeper component (event gas × 0.55 gwei) | 386,023,000,000,000 |
| Actual keeper incentive | 596,505,750,000,000 |
| Actual keeper reward | 982,528,750,000,000 |
| Reward if the same measured call's incentive were capped by that credit | 769,356,333,333,333 |
| Incentive above the delivered edge credit | **213,172,416,666,667** |

The final two rows are a **same-measurement counterfactual**, not a measured second transaction. The test does not run a paired control without the intervening `configure`. It nonetheless proves the bypass directly: actual incentive exceeds credit, credit stays untouched, and the source applies the credit limit only when `!creatorWork`.

## Asset and authority interpretation

The buyer sends the acquisition fee to FWA and a separate VRF service fee. The test asserts `paid - pool.ownerProceeds() == edgeCredit` before upkeep. The pinned FWA source analysis in `audit/integrations/assessment.md` says owner proceeds are the base price; the edge is protocol fee routed to FWAV2Buyback. Thus `incentiveCredit` is an accounting limit, not ETH passed to Balancer. Balancer pays the keeper from its own liquid ETH, including its creator deposit and collected base proceeds. At the same measured gas, bypassing the credit limit pays the keeper **213,172,416,666,667 wei** more from Balancer than the purchase-caused rule would allow. This reduces creator-controlled surplus or reserve headroom by that amount. The creator explicitly authorized the triggering `configure`; the PoC does not show a loss to the NFT buyer, a third-party depositor, or an underfunded admitted checkpoint.

`configure` is callable only by the creator and has no idle requirement. It unconditionally calls `_invalidate`, even when its economic inputs match current values. The exception lasts until a valid checkpoint, so this is a one-upkeep attribution switch, although the creator can initiate another cycle with another authorized configuration call. The PoC has distinct buyer, creator, and keeper; it does not establish profitable self-dealing after the buyer's purchase cost, VRF fee, inventory/markup economics, gas, and creator capital are included.

## Limits and deciding owner question

The observed test does not measure pre/post Balancer cash, surplus, reserve, protocol payout, or a paired no-`configure` upkeep. It uses a hardcoded 500 bps edge, consistent with the pinned factory observation; a changed factory edge would change the numerical credit. The keeper reward and ETH receipt are directly asserted. The exact 213,172,416,666,667 wei is an excess over the **delivered edge credit**, not proven net profit or a claim that Balancer ever received that edge.

The owner must decide whether *any* creator `configure` intentionally authorizes a full keeper incentive on an already-issued purchase, even with identical values. If the intended rule is instead that purchase-caused refill remains credit-limited, the demonstrated path violates it. No code change or broadcast was made in this challenge.
