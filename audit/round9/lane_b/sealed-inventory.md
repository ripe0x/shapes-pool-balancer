# Round 9 — Lane B sealed inventory (blind discovery, direct-harm search)

Auditor: blind discovery lane B. Target frozen at `c686534` (production identical to `7b32497`).
Fork: Ethereum mainnet block 26,382,349 via `https://mainnet.gateway.tenderly.co` (also the recent-block check below).
All work in `audit/round9/lane_b/`. No production code or existing tests modified. No mocks on protocol contracts:
FWA pool/factory, Shapes, Draw Packs and the VRF service are the real deployed contracts; VRF words are delivered by
`vm.prank`-ing the real coordinator `0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d` and calling the pool's real
`rawFulfillRandomWords` (the accepted "act as the coordinator through the real VRF service path" method). Curated
collections use a local `MockNFT` (a legitimate adversary / stand-in collection, not a protocol contract).

solc 0.8.28, via_ir, optimizer 50 (packs 20), cancun. Capability preflight: `preflight/record.md` (all exit 0).

## Headline

No confirmed security or economic exploit was found in the paths I exercised. The two invariants the owner cares most
about — "keepers never cost the creator more than the restocking fees" (M1/M2) and "nothing stranded; creator recovers
everything" (M4/M5/M7) — hold on real fork receipts. Keeper priority-overbidding, inflated-limit and self-dealing
levers are neutralised. Creator economics are positive on real draws. Findings below are low-severity observations,
requirement challenges, and honestly-recorded untested gaps (notably: paid draws above ~0.5 gwei and the below-reserve
profit regime could not be driven within the forked VRF subscription's coverage).

Key test files (run one at a time with
`FOUNDRY_TEST=audit/round9/lane_b FOUNDRY_OUT=audit/round9/lane_b/out FOUNDRY_CACHE_PATH=audit/round9/lane_b/cache forge test --match-path <file>`):
`Keeper.t.sol`, `Econ.t.sol`, `Scenario.t.sol`, `Security.t.sol`, `BelowReserve.t.sol`; harness `Harness.sol`,
`MockNFT.sol`; discovery probes `Probe.t.sol`, `Probe2.t.sol`, `Probe3.t.sol`, `ProbeVrf.t.sol`. Logs in `logs/`.

---

## 1. Harm inventory (each outcome I searched for)

| # | Harmful outcome searched for | Sequence tried | Evidence | Result | Domain exercised |
|---|------------------------------|----------------|----------|--------|------------------|
| H1 | Keeper paid more than the restocking fees of prizes it listed (creator's markup spent on keepers) | open→stock(creator work)→draw→keeper upkeep, 5 real cycles; summed non-setup reward vs credit added per call | `Keeper.t.sol::testKeeperCapHonest`, `logs/final-Keeper.log` | **No counterexample.** sumReward == sumCreditAdded == 0.003475 ETH; reward ≤ credit every call | real draws @0.5 gwei, real receipts |
| H2 | Keeper extracts more by bidding up priority fee | honest bid (0.5 gwei) vs greedy 100 gwei priority on the same upkeep | `Keeper.t.sol::testKeeperCannotOverbidPriority` | **No counterexample.** reward identical (0.000695 ETH): capped at basefee+0.05 gwei | real fork |
| H3 | Keeper inflates reward via gas-limit padding | reward uses measured gas (`gasStart-gasleft`) capped at KEEPER_MAX_GAS, not tx limit; verified measured 828k ≪ 3.2M cap | `logs/final-Keeper.log` | **No counterexample** (structural: limit never enters reward) | real receipts |
| H4 | Self-dealing keeper/player profits by creating restock work | reward outside creator work is capped by `keeperCredit` (= Σ listed restock fees); each credit unit requires a real paid draw (player pays FWA edge 5% + VRF fee); per-call surplus ≤ KEEPER_INCENTIVE | `Keeper.t.sol`, static analysis | **No counterexample found** (profit ≤ incentive, < edge+VRF cost per draw) | real @0.5 gwei + reasoning |
| H5 | ETH or prizes stranded after close/unlist/withdraw | full cycle: open→draws→close→unlistShapes→withdrawCurated→collect→claimSurplus | `Econ.t.sol::testFullCycleNothingStranded`, `Scenario.t.sol::testCreatorNetAndRoundTrip` | **No counterexample.** Balancer residual == 0; profit == 0 after sweep | real cycle |
| H6 | Mint-fee / backing leakage (one-way flow not repaid) | open→stock→close→unlist→withdraw with **no draws** (remove the trigger) | `Scenario.t.sol::testOpenCloseRoundTripNoDraws` | **No counterexample.** Creator recovers the exact 1.0 ETH deposit (mint fees became Shape backing, redeemed back) | real round trip |
| H7 | Creator loses money in expectation (product goal) | 5 real draws, 30% markup, five 0.01 Shapes + two 0.05 NFTs, deposit 2 ETH | `Scenario.t.sol::testCreatorNetAndRoundTrip`, `logs/scenario2.log` | **No counterexample.** creator claimed 2.037 ETH vs 2.0 deposit (+0.037 ETH cash) **plus both NFTs returned**; 0 draws blocked | real draws (small sample) |
| H8 | `claimSurplus` moves fund money out / breaches reserve | claim-everything-every-step across a draw run; check fund=balance-profit and reserve floor | `Econ.t.sol::testClaimPreservesFund`, `BelowReserve.t.sol` | **No counterexample.** fund preserved; balance never below reserve via free path | real draws |
| H9 | NFT-sale money booked into withdrawable profit while below reserve (violating "fund keeps all NFT sale money") | per-draw collect, detect curated draws via NFT ownership, deposit near reserve | `Econ.t.sol::testNftSaleMoneyBookedAsProfit`, `logs/econ-nft.log` | **No counterexample in the exercised domain** (fund stayed ≥ reserve, profit path never active; see challenge C1, gap G3) | real draws, above-reserve only |
| H10 | Outsider/attacker drains or controls the pool (access control) | attacker calls configure/open/close/claimSurplus/listCurated/retire/transferCreator/revokePoolPages | `Security.t.sol::testCreatorOnlyGating` | **No counterexample.** all revert `Unauthorized` | real |
| H11 | Keeper-list bypass / compromised keeper-admin overreach | restrict upkeep, attacker upkeep reverts `KeeperNotApproved`; creator still allowed; admin power limited to the list | `Security.t.sol::testKeeperRestriction`, `BalancerFactory.sol` review | **No counterexample.** admin can only toggle the list | real |
| H12 | Stealing a tracked/listed NFT, the pool or the factory via `recoverUntrackedNFT` | recover pool / factory / not-owned / genuinely-untracked | `Security.t.sol::testRecoverUntrackedGuards` | **No counterexample.** pool+factory `ProtectedAsset`; non-owned `ProtectedAsset`; only truly untracked recovers | real |
| H13 | Replaying a former creator's pool-page (ERC-1271) signature | approve digest, transfer creator, check old digest invalid; former creator cannot approve | `Security.t.sol::testPoolPageEpochInvalidation` | **No counterexample.** epoch bump on `acceptCreator` invalidates prior approvals | real |
| H14 | Re-initialising a clone or the locked implementation | `impl.initialize`, `clone.initialize` second call | `Security.t.sol::testImplementationLockedAndNoReinit` | **No counterexample.** impl locked (creator==address(1)); both revert `AlreadyInitialized` | real |
| H15 | A failed delivery to a protected address stranding a prize | `canPurchase` refuses this/SHAPES/PACKS/pool | `Security.t.sol::testCanPurchaseRefusesProtected` | **No counterexample** for those four addresses (a generic hostile receiver is **untested**, gap G4) | real view |
| H16 | Keeper paid after the pool closes (fresh deposits drained later) | close zeroes keeperCredit; keeper upkeep after close | `Scenario.t.sol::testCreatorNetAndRoundTrip` (asserts reward==0 post-close) | **No counterexample.** credit returned to creator; post-close upkeep pays 0 | real |

A failed attack closes only that attempt, in the stated domain.

## 2. Candidate findings

**No High/Critical/Medium finding confirmed.** Low-severity / informational only:

- **L1 (informational, economic) — keeper reward on single-Shape restocks is capped below the nominal incentive.**
  Site: `PoolBalancer._payKeeper` + `performUpkeep` (keeperCredit cap). When a call restocks one Shape, credit added
  = `restockFee()` (0.000695 ETH @0.5 gwei) but the reward formula wants `measured·price + KEEPER_INCENTIVE`
  (≈0.000914), so the reward is clamped to 0.000695. Measured on fork (`logs/final-Keeper.log`). Impact: the pool is
  fully protected (this is M1 working), but a keeper's *margin* on one-Shape calls is thin at low basefee; at high
  basefee (≈5 gwei) the restock fee dominates and margin is healthy. No creator loss; a mild liveness consideration for
  keepers that cannot batch. Suggestion (only): none required; optionally document that keepers should batch restocks
  (MAX_OPS=5) so credit comfortably covers the incentive. PoC: `Keeper.t.sol::testKeeperCapHonest`.

## 3. Economic measurements (real fork)

| Scenario | Measurement | Value | Limits |
|----------|-------------|-------|--------|
| 5×0.01 Shapes + 2×0.05 NFT, 30% markup, 2 ETH deposit, 0.3 gwei | creator net (cash) | +0.037 ETH over 5 draws, **plus both NFTs returned** | 5-draw sample; EV over long runs relies on the planner model |
| same | liveness (share of attempts admitted) | 5 admitted / 0 blocked = 100% | small sample |
| same | player paid (quoted) | 0.0973 ETH / 5 draws ≈ 0.0195 each | |
| same | keeper earned (reward) | 0.00332 ETH over the run | keeper gas cost separate; keeper net positive at 0.3–0.5 gwei |
| 2×0.01 Shapes, no draws, 1 ETH | creator recovers deposit | 1.000 ETH exactly (mint-fee round trip) | |
| 5×0.01 Shapes, 5 cycles, 0.5 gwei | lifetime keeper pay vs restock fees | equal to the wei (0.003475 ETH) | @0.5 gwei (VRF-coverage ceiling) |
| 2×0.01 Shapes, 0.12 ETH deposit | fund vs reserve | fund 0.1165 ≥ reserve 0.0715 throughout | small-prize pool self-funds above reserve |
| restockFee() @0.5/0.3 gwei | per-Shape fee | 0.000695 / 0.000515 ETH | pure, matches `restockFee()` |

Fronted/idle capital: `requiredReserve()` sizes the keeper term at `MAX_KEEPER_REWARD` (3.2M × 5 gwei + 0.0005 =
0.0165 ETH) per upkeep call regardless of the live basefee or the (much smaller) `keeperCredit`. At ordinary gas this
over-reserves the keeper term — idle capital the creator cannot withdraw while open. Owner-accepted ("reserve at the
5 gwei cap"), recorded here as idle capital, not a defect. Stranded value: none observed (H5, H6).

Recent-block drift check: the capability sentinel fork read and the system stand-up both succeed at the pinned block;
the integration addresses (FWA factory/impl codehash, Shapes, VRF service, ENS) are live and match. (A second distinct
recent block was not separately driven through a full cycle — see gap G6.)

## 4. Requirement challenges

- **C1 — "the fund keeps … all NFT sale money" (M9) is only true up to the reserve.** Once the fund reaches the
  reserve, `withdrawableSurplus` returns `balance − requiredReserve` via the *free* path, so NFT-sale proceeds (and the
  "first 10% of markup") sitting above the reserve become immediately withdrawable by the creator. This is consistent
  with the companion rule "everything over the reserve is claimable anyway," but it contradicts the literal reading of
  "the fund keeps all NFT sale money." Recommend the owner state the rule as "the fund keeps NFT sale money and the
  first 10% of markup **until it reaches the reserve**." Not a code defect.
- **C2 — below-reserve profit uses a per-collection EV ratio, not the realised draw.** `_collect` books
  `amount · profitShareSum/(n·1e18)`, where the ratio is taken over the *currently active* listings, but `amount` was
  generated by now-removed drawn listings. Per draw this over- or under-books; it is EV-neutral over many draws and a
  creator cannot bias which listing is drawn (VRF). I could not construct a creator action that systematically
  over-books: the auto-`_collect` in step 2 of every `performUpkeep` runs *before* the step-3 restock, pinning the
  ratio to the pre-restock (lower-markup) set, which defeats the markup-change-then-restock timing attack. Reported as
  analysed; **not driven in the below-reserve regime on the fork** (gap G3).
- **C3 — `MAX_KEEPER_REWARD`-sized reserve keeper term (idle capital).** See §3. The reserve could be tightened to the
  live `restockFee()`/`keeperCredit` basis, but the owner explicitly wants the 5 gwei-cap sizing; recording the
  trade-off only.
- **C4 — `keeperCredit` is monotone up except on payout/close.** It only ratchets up by listed restock fees and down by
  payouts, zeroed at close. It cannot strand capital beyond the fronted fees (returned to the creator at close, proven
  by H16/H6). No change recommended.

## 5. Untested paths (and why)

- **G1 — paid draws above ~0.5 gwei.** The forked FWA VRF subscription reverts `InsufficientVrfCoverage()` once
  `tx.gasprice` pushes the per-request fee past the subscription's on-fork balance (threshold between 0.5 and 1 gwei;
  `ProbeVrf.t.sol`, `logs/probevrf.log`). Real draw cycles were therefore driven at 0 – 0.5 gwei only. The keeper
  reward/`restockFee` math at 1 – 5 gwei is linear in a bounded, pure price (`_rewardPrice`, `restockFee`) and the
  `keeperCredit` cap is price-independent, so M1/M2 extend by construction — but gas scenarios at 1/3/4.9/>5 gwei and a
  basefee spike-and-recovery were **not** run through full draw cycles. Would need a funded VRF subscription.
- **G2 — bounded number of paid draws per fork.** The subscription's coverage depletes after ~5 paid draws, so every
  scenario is a small sample; statistical creator-net EV, long-run liveness, and odds-vs-design were not measured at
  scale. (Zero-gas-price draws are unlimited but make the keeper reward price 0, which is not representative.)
- **G3 — the below-reserve profit regime was never entered on the fork.** With small (0.01 ETH) prizes the pool
  self-funds and the fund stays above the reserve (`BelowReserve.t.sol`: fund 0.1165 ≥ reserve 0.0715). Entering it
  needs a big-prize mix (e.g. a 0.5 ETH Shape) drawn-but-not-restocked, which needs both a VRF word that hits the
  low-weight big listing and several follow-on draws — beyond the ~5-draw coverage budget. M9's below-reserve booking,
  the markup-change over-booking attack (C2), and "big win leaves prizes off the board" liveness are therefore covered
  by static reasoning only.
- **G4 — hostile purchaser / failed delivery / refund cycle.** `recoverRefunded` (PENDING → `L_DELIVERY_REFUNDED` →
  redeem backing), FWA delivery failure to a rejecting receiver, and `retryNFTDelivery` were not driven. `canPurchase`
  only screens four fixed addresses; a generic contract that rejects `onERC721Received` was not tested end to end.
- **G5 — launch-scale and pack/big mixes.** Only small all-Shape mixes (+ a couple of NFTs) were driven. Draw Packs
  prizes (sizes 9–15, multi-Shape), the Balanced board, the 0.5/bigger-prize mixes, 80-Shape plans, draws-in-flight
  bursts (1/5/batched before settlement), and `MAX_BATCH` BUSY gating were not exercised with real draws.
- **G6 — draws-in-flight and reconcile-order, mint-fee-rise, retirement, late-keeper.** Reconcile ordering across
  ≥2 unsettled sequences, `mintFeeCap` gate (`MINT_FEE_ROSE`) with a real Shapes fee change, `retire()` after close,
  and a recent second fork block through a full cycle were not driven.
- **G7 — off-chain code (keeper.ts, planner.ts, design.ts, tx.ts, App.tsx).** Reviewed by reading only (in scope but
  second priority); not executed. Parity of `shared/planner.ts`/`design.ts` against the contract was checked by reading
  both, not by running the TS or the parity fixture. No contradiction found on the formulas I compared
  (`restockFeeAt`, `requiredReserveAt`, `prizePrice`, reward bounds), but this is a read, not a run.

## 6. Time and excluded-file access

- Start (UTC): 2026-11-13T11:30:34Z. End (UTC): 2026-11-13T11:52:xx Z (writing). Active time used: ~25 minutes,
  well under the 3-hour ceiling. Sealing complete, not partial.
- Excluded-file access: **none.** I read only `src/`, `script/`, `foundry.toml`, the named `shared/`, `keeper/`,
  `app/src/` files, and public on-chain state, plus my own lane. One `audit/round9/run-record.md` read was attempted
  by a combined `ls`+`cat` and **denied by the sandbox before any content was returned**; I did not retry it. No other
  lanes, tests, docs (beyond SPEC via the packet), sim, git history, memory or sessions were read.
