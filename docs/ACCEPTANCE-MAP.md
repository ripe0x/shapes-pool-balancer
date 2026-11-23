# Community configuration acceptance map

Suite: `test/CommunityConfigAcceptance.t.sol` (spec `community-release-spec.md` A§9 cases 1-15, Part B §6 case 16).
Written from the owner's spec, independently of the implementation's own tests. Real FWA, Shapes, Draw Packs and VRF on
a mainnet fork; only the Chainlink coordinator and (fork only) the Shapes admin are impersonated. Every successful upkeep
is reconciled in wei against the Balancer balance (`balance after + mints + keeper pay == before + collected`) and the
keeper's received ETH.

Required CI command (needs the `mainnet` RPC endpoint from `foundry.toml`):

```
forge test --match-path test/CommunityConfigAcceptance.t.sol
```

Fork blocks: `ForkBase.FORK_BLOCK` 26,382,349 for cases 0-15; 26,480,000 for case 16 (after the old factory's
deployment at 26,475,448).

| # | Requirement (spec) | Test |
|---|---|---|
| 0 | Initial values: V1 work fee, 3.2M gas, 5 gwei, 0.05 gwei, 0.0002 ETH flat; documented 60k overhead / 910k restock gas; bucket 0.622 ETH and floor(0.05 ETH / 12)/s; limits 1000 / 1000-10000; fill 7000; backlog 5; derived maxima from the schedule (A§4, A§5, B§2-3) | `test_case00_initialValues` |
| 1 | Two followers adopt a factory update immediately; a pinned pool keeps its complete values (algorithm, envelope, restocking); factory update is constant work (A§2, A§9.1) | `test_case01_followersAdoptFactoryUpdateImmediately_pinnedKeepsActualValues`, `test_case01b_pinnedFallbackUsesPinnedSchedule` |
| 2 | Pinned (or local) through factory changes, then resume following adopts the latest (A§2, A§9.2) | `test_case02_resumeFollowingAdoptsLatestFactoryConfiguration` |
| 3 | Fee change at the same policy address: follower and creation hashes move, previews and payments update; pinned hash does not move on unrelated factory updates (A§6, A§9.3) | `test_case03_feeChangeSamePolicyAddress_hashPreviewsAndPaymentsUpdate` |
| 4 | Creator disable survives factory changes; re-enable, policy and local economics changes take effect with no time advance; creator transfer keeps selection and disabled state (A§2-3, A§5, A§9.4) | `test_case04_disableSurvivesFactory_reenableAndLocalChangesNeedNoTimeAdvance` |
| 5 | Only policyAdmin changes factory settings (two-step transfer); only the creator changes pool settings (A§2, A§9.5) | `test_case05_unauthorizedSettingsChangesFail` |
| 6 | Underfunded follower: update succeeds, shortfall exposed, paid spending limited by cash and bucket, unpaid maintenance, protected credit and exit usable (A§2, A§9.6) | `test_case06a_underfundedFollower_updateSucceeds_paidLimitedByCash_unpaidAndCreditUsable`, `test_case06b_paidSpendingLimitedByBucket_unpaidUnaffected` |
| 7 | Prize maximum, markup range, fill threshold (0..10000, zero keeps the unavailable-inventory check), backlog threshold (T >= 1, T + 4 outstanding); existing designs survive lowered limits (A§4, B§2-3, A§9.7) | `test_case07a_prizeMaximum_lowerKeepsExistingDesign`, `test_case07b_markupRange_noStrandingNoSilentReprice`, `test_case07c_fillThreshold_zeroKeepsUnavailableInventoryCheck`, `test_case07d_backlogThreshold_allowsTPlusFourOutstanding` |
| 8 | Raise and lower across former 0.311 ETH, 0.102 ETH/Shape, 50 gwei, 6M/100k ceilings: values take effect, not clamped (A§4, A§9.8) | `test_case08a_paymentAndRestockAboveFormerCeilings_thenLower`, `test_case08b_gasPriceAboveFormer50Gwei_largerEnvelope_thenLower` |
| 9 | Quote, actual payment, reserve, restocking price and fallback agree for one effective configuration; unpaid callers use a healthy policy's price (A§6, A§9.9) | `test_case09_oneEffectiveConfiguration_quotePaymentReserveRestockFallbackAgree` |
| 10 | Stale creation and upkeep expectations fail before side effects; keeper minimum payment respected (A§6, A§9.10) | `test_case10a_staleCreationFailsBeforeSideEffects`, `test_case10b_staleUpkeepFailsBeforeWork_minimumPaymentRespected` |
| 11 | Bucket: old-rate accrual first, spent preserved, clamp on decrease, no fill on increase, zero refill, boundary and rounding, no reset by policy/follow/paid/open/close/creator/factory changes (A§5, A§9.11) | `test_case11_bucketAccrualClampNoRefillNoReset` |
| 12 | Mint fee 0.001 -> 0.0005 -> 0.001 via the real Shapes admin: exact mint payments, new listing prices, reserve at the accepted cap, old prices unchanged, lower cap accepted with the same design, fee above cap stops minting not purchases (A§7, A§9.12) | `test_case12_mintFeeDownAndUp_realShapesAdmin` |
| 13 | Shapes-only (`curatedRequired` false), curated inventory, creator credit, unpaid recovery (A§7, A§9.13) | `test_case13a_shapesOnly_unpaidRecoveryWithPaidOff`, `test_case13b_curatedInventory_creatorCredit` |
| 14 | Bounded work (5 units, 4 sizes, 5 reconciles, 2 processed); repeated or empty calls pay nothing; each draw and Shape paid once (A§5, A§6, A§9.14). Since 2026-11-23 only stuck draws (Ready, or expired without randomness) past the processing grace are processed, each paid one work fee besides its reconcile, and the draws behind an expired head proceed; before the grace, and for a head still inside its word deadline, nothing is processed or paid; the shorter grace applies while sales are paused | `test_case14a_listingBoundedByUnitsAndSizes`, `test_case14b_reconcileBounded_noDuplicateRewards`, `test_case14c_stuckDrawsProcessedAfterGrace_boundedAndPaidOnce`; `ProcessQueue.t.sol` `test_stuckDrawProcessedOnlyAfterGrace_freshDrawUntouched_paidOnce`, `test_stuckDrawShorterGraceWhilePaused`, `test_headWaitingForRandomnessIsProcessedOnlyAfterItsDeadline`, `test_drawWithoutRandomnessProcessedAfterDeadlineAndGrace_drawBehindProceeds`, `test_manufacturedStuckDrawLosesMoney`; outage-only economic note (a buyer cannot cause undelivered randomness; the buyer-keeper net is positive only below about 0.017 gwei buyer gas): `ReserveEconomicReview.t.sol` `test_manufacturedExpiredDrawPaysBuyerKeeperButCostsTheirCreator` |
| 15 | Lifecycle: creation, funding, purchases, processing, restocking, economic update, close, refunded-delivery recovery, withdrawal, with absolute ETH per flow and full conservation (A§9.15) | `test_case15_lifecycle_absoluteEthPerFlow` |
| 16 | A pool created on the old mainnet factory `0x91C31Ad6…` stays operable through its own ABI (upkeep, configure, purchase, paid and unpaid reconcile, credit, close, redeem, withdraw) after a replacement factory reusing community Draw Packs becomes the creation target (B§6) | `CommunityLegacyFactoryAcceptanceTest.test_case16_oldFactoryPoolOperableAfterReplacementFactory` |

Not covered here: the interface half of case 12 (the app accepting a lower cap without a design edit, `app/src/App.tsx`)
belongs to the TypeScript tests.

Environment note: FWA's VRF service refuses requests its Chainlink subscription cannot cover (`InsufficientVrfCoverage`).
At block 26,382,349 the subscription held 2.5999 native ETH and refused a batch that would make 7 draws outstanding.
Case 7d funds the subscription through the coordinator's public `fundSubscriptionWithNative` so the Balancer's own
backlog boundary is what is measured.
