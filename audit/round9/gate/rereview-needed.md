# Postconditions needing a pass-3 independent re-review

These postconditions were changed or added in run 2 after the pass-2 review (`audit/round9/challenge/manifest-review.md`), so they are deliberately withheld from `independent_review.postcondition_review`; the gate reports them via "independent reviewer must assess every postcondition". Each needs a pass-3 review of its new text and evidence.

## P3_split_m9_violation/pc_m9_extent
- Why withheld: challenged by the review; text/evidence updated in run 2.
- New assertion: withdrawCurated-then-collect books 0.001985->0.002383 ETH (factor n/(n-1)) on identical proceeds, while unlistShapes/listCurated/transfer/configure are neutral or fund-favourable; the lever scales as k/(n-k) for k curated of n listings.
- Evidence IDs: EV_m9extent, EV_m9worst, EV_upkeeporder, EV_upkeeporder_asserted

## P4_keeper_restock_delivery/pc_delivery_reentrancy
- Why withheld: challenged by the review; text/evidence updated in run 2.
- New assertion: The full real-VRF draw cycle delivers the prize via plain transferFrom and nets keeperCredit and profit to zero; the reward-callback re-entry is now EXECUTED (creator-as-contract re-enters on the setup reward): unguarded onlyCreator functions (transferCreator/close/configure) run re-entrantly and persist, guarded collectProceeds reverts, and profit<=balance holds, with no authority gain because the caller is the creator.
- Evidence IDs: EV_draw, EV_refund, EV_rewardreentrancy

## P4_keeper_restock_delivery/pc_burst_gas
- Why withheld: added in run 2.
- New assertion: At the MAX_BATCH cap (5 unsettled draws acquired, 6th refused, admissionStatus=BUSY) the heaviest single upkeep (reconcile 5 + restock) is 2,526,724 gas, under KEEPER_MAX_GAS 3.2M and the keeper UPKEEP_GAS_FLOOR 4.0M; keeper pay 0.0005 ETH <= restock fees credited 0.001225 ETH, profit 0 <= balance at rest.
- Evidence IDs: EV_burst

## P6_lifecycle_closeout/pc_mintfeerose
- Why withheld: added in run 2.
- New assertion: Raising the live mint fee above the cap sets admissionStatus=MINT_FEE_ROSE(5) with canPurchase=false and stops restocking (creatorWork stuck true); requiredReserve rose 0.044->0.045; after configure re-accepts the new cap, upkeep restocks to target and admission returns to OK.
- Evidence IDs: EV_mintfeerose

## P6_lifecycle_closeout/pc_retire_closeout
- Why withheld: added in run 2.
- New assertion: close then retire with a draw in flight: the in-flight draw settles through the real route and performUpkeep reconciles it after retire; unlisting shapes redeems exact backing; after withdraw curated and claimSurplus the balancer holds 0 ETH and no active listing is stranded (M7).
- Evidence IDs: EV_retire

## P8_refund_open_questions/pc_refund_player
- Why withheld: challenged by the review; text/evidence updated in run 2.
- New assertion: The failed curated draw credits 0 proceeds, 0 profit and 0 keeper credit; after the 7-day window refundFailedDelivery then withdrawAcquisitionRefund returns the purchaser exactly the acquisition fee 0.630139131231725739 ETH; recoverRefunded returns the NFT to the creator and the balancer ETH is untouched; the below-reserve variant still books 0 profit (M9 holds).
- Evidence IDs: EV_refundwithdraw, EV_refund, EV_refundledger
