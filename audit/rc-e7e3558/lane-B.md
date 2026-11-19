# Lane B independent release review — Shapes Pool Balancer

**Target (immutable):** commit e7e3558f4d0de3e30d24f92f3b0e2dbdde664028 at /private/tmp/shapes-review-B-e7e3558.
docs/ and audit/ deliberately absent. Read only: code, OWNER-REQUIREMENTS.md, asset-flow.json, the two allowed
guidance files, vendored FWA source under external/. Uninformed lane B, first small capped mainnet launch.

**Toolchain:** Foundry 1.8.1 (matches gate pin). Fork block 26382349, Tenderly public RPC.

## Methods and commands (exit status)
1. `forge build` -> 0 (warm).
2. `CANDIDATE_RUN=1 forge test --fork-url <tenderly> --fork-block-number 26382349 --isolate --match-path test/scenario/FlowBreakdown.t.sol --match-test 'test_breakdown_closeoutPending|test_breakdown_minimumCapital|test_breakdown_quiet' --gas-limit 1e11` -> 0, 3 passed.
3. Code reading: all src/, script/Deploy.s.sol, script/deploy.sh, FWA StandardPool.sol proceeds/refund/delivery paths, interfaces.

Did NOT run: full 25-regime gate, TypeScript keeper/rehearsal suites, adversarial Solidity suites. No test files added.

## Time per phase
Phase0 setup+requirements ~12m; Phase1 contracts+FWA ~28m; Phase2 economic reasoning ~18m; Phase3 fork tests+FWA accrual ~12m (overlapped); Phase4 report ~15m. Total ~75/90m. TIMEBOXED: not exhaustive, not a clean bill.

## ECONOMIC SECTION

### Derived rights model (R46-R73, O1-O16)
- Creator capital (deposits/transfer/pre-deploy addr): anyone may add; irrevocable pool capital; sender gets NO credit/refund/recovery (R73); only creator withdraws as surplus above reserve.
- Creator revenue credit: floor(collected*creatorRevenueBps/10000) once per _collect; capital returns create zero; creator may claim immediately even during depletion (R62/R63).
- Shape/Pack backing: exact redeemable backing, winner on delivery or pool on unlist/recover (O4).
- Purchaser escrow/refunds: live at FWA only, player-claimable only; never reach the Balancer (R47).
- Keeper reward: msg.sender of performUpkeep; bounded quote <= envelope <= maxReward <= 0.311, <= burst 0.622/floor, <= balance-credit; real work only.
- Curated NFT: creator value no markup (R35); creator withdraw/recover or winner on draw.
- FWA edge + VRF + Shapes mint fee: one-way (O6/R27).

### Absolute-amount checks (passing fork tests)
- O15/O16 minimumCapital: opening asserted exactly 0.2356 ETH, zero top-ups. PASS.
- O6/O3/O4 closeoutPending: creator_assets_left_wei==0, redeem_gap_wei==0, unclaimable_after_close_beyond_held_pay_wei==0. PASS.
- O8/O11/O12 quiet: creator_credit_error_wei==0, keeper-play net loss<=0, creator net loss<=0. PASS.

### Destination of every wei (confirmed in FWA source)
StandardPool._completeNFTDelivery (L1819-1826) accrues ownerProceeds+=basePrice and accruedProtocolFees+=(paid-basePrice) ONLY on successful delivery. Failed delivery keeps price in deliveryEscrow and refunds player (refundFailedDelivery L1747); slippage/expiry refunds credit purchaser at settle (L1619) with no proceeds. So the Balancer's _collect can only credit the creator for delivered draws -> O4/O6 cannot be broken by a refund race; FWA edge and Shapes mint fee are genuinely one-way.

### Invariant verified by hand: balance >= creatorCredit
Only _collect raises credit, raising balance by amount >= floor(amount*bps/10000) (equal at bps=10000; verified rounding identity (a/BPS)*bps+(a%BPS)*bps/BPS==floor(a*bps/10000)). Every balance-reducer respects credit: pay() and fill() cap spend at balance-credit; claimSurplus reduces both together bounded by withdrawableSurplus<=balance. requiredReserve/withdrawableSurplus/pay fund = balance-creatorCredit can never underflow. No stuck-pool from underflow.

### Scorecard
- Deposit -> operating cash; claimable as surplus above reserve; not ratchet. 5 ETH quiet ends creator ahead (O12).
- Proceeds -> balance; floor(*bps)->credit, remainder->operating; credit ratchets but is spendable by creator. credit_error 0 (O8).
- Prize backing -> Shapes/Packs custody; round-trips mint->list->(winner | unlist/redeem). redeem_gap 0 (O4).
- Keeper reward -> keeper EOA; one-way bounded; allowance floor ratchets per burst rule. <=0.311/call, 80k gas/draw kept (O1).
- Purchaser escrow -> FWA only; refund to player. creator_assets_left 0 (O6).
- Curated NFT -> creator<->FWA<->winner; round-trips. O6 closeout 0.
Idle/stranded at launch scale: none. Reserve holds exactly missing-inventory cost + one maintenance call + per-owed-draw reconcile budget; does NOT lock capital for hypothetical future keeper cycles (R46 honored; old R26 duplicate-prize insurance removed per R54). minimumCapital opens at 0.2356 ETH, no top-ups.

## SECURITY SECTION (positives load-bearing for the decision)
1. No admin can touch pool funds. Factory keeperAdmin/policyAdmin only gate who runs upkeep and which default NEW pools snapshot; existing pools snapshot defaultKeeperPolicy at initialize and never follow later factory changes (R41). Keeper reward bounded, real work only, from pool's own balance-credit. Hostile approved keeper cannot drain; only edge is accepted retained-refund ~80k gas/draw.
2. Emergency disable is real. setPaidUpkeepEnabled(false): enabled=false, ++generation, cancels matured pending (so public activate cannot undo stop); re-enable re-runs 2-day proposal. Unpaid upkeep + recovery work with broken/hostile policy: that path never calls quoteReward, and restock() falls back to immutable V1 surcharge when paid=false (R42/R51).
3. Credit protected and read-free. claimSurplus(amount<=creatorCredit) short-circuits before any external read; matches R63 0.20/0.02/0.10->0.10 (verified withdrawableSurplus=0.10).
4. Reentrancy: all state-changing entries nonReentrant; canPurchase/onERC721Received view/pure; upkeep holds lock across processAcquisitions so a hostile winner reentering reverts into FWA's catch (delivery-failed->refund), never into Balancer state.
5. Policy-call hardening: KeeperPolicyCalls.word = fixed 100k-gas staticcall, 32-byte out buffer; validate requires interfaceVersion==1, 0<maxReward<=0.311, nonzero code.
6. Deploy script pins FWA factory/impl/codehash, re-checks in preflight + maxAcquisitionsPerTx==5, locks impl (creator=address(1)), requires ASSET_GATE_PASSED=yes on chainid 1 (set only by deploy.sh after gate), postflight reads back wiring. R2 caveat (bypassing deploy not stopped) stands.

### Property map (property | attack | outcome | evidence)
- B>=C invariant | credit>balance via rounding at bps=10000 | holds (equal increments) | _collect PoolBalancer.sol:773
- Credit protected in depletion | withdraw credit while low inventory | allowed by design, no player harm | claimSurplus:481-488; R63
- Keeper overpay | hostile policy quotes 0.311 for trivial work | capped to _bound envelope (gas*price) then maxReward then burst/fund | reward/_bound KeeperPolicyCalls.sol:214-223,194-198
- Burst floor reset | split pay across many keeper EOAs | per-pool allowance decremented regardless of sender | pay:104-114
- Emergency stop sticky | public activate after creator disable | disable cancels pending; re-enable needs 2 days | :88-95
- Proceeds not booked on refund | collect for a draw that refunds | FWA accrues proceeds only on delivery | StandardPool.sol:1819-1826
- Admin drain | factory admin moves pool funds | no path; policy snapshot at init | BalancerFactory.sol
- recoverUntrackedNFT abuse | pull a backing Shape | tracked prizes never held between txs; ownerOf==this gate | PoolInventory.recoverUntracked:82-88
- Reentrancy during delivery | hostile winner reenters upkeep | nonReentrant revert -> FWA delivery-failed path | lock in _performUpkeep

## FINDINGS

### Low/Info-1 — O6 player-loss exception reachable by ANY creator, not just owner (disclosed, accepted)
BalancerFactory.createBalancer is permissionless. The R20/O6 exception (creator-controlled collection delivered then clawed back; player loses 0.0175 ETH with FWA treating transfer as final; refusing collection costs player VRF fee + 7-day wait) therefore applies to every public pool from launch, not only the owner's canary. Owner-accepted ("passthrough for FWA", R20/R21) and disclosed in O6. NOT a blocker. Owner should confirm understanding that the first capped launch opens pool creation to the public; there is no on-chain allowlist to keep the canary owner-only.

### Info-2 — Creator can self-starve the pool by withdrawing protected credit below the reserve (by design)
claimSurplus(amount<=creatorCredit) ignores the reserve (R63 intends this), so a creator whose credit exceeds balance-reserve can pull it, dropping operating cash below requiredReserve; paid upkeep then reverts PaymentUnavailable, restock stalls, inventory depletes, sales pause. No player harm (backing + FWA refunds untouched; B>=C preserved). Working as specified; flagged because "protected credit" (R63) and "self-sustaining" (R6) can conflict at the creator's election.

### Info-3 — activateKeeperPolicy permissionless; funding check reads current block.basefee
Anyone may activate once the creator's 2-day proposal matures. The increased-exposure gate (candidate>previous && fund<candidate, KeeperPolicyCalls.sol:79) uses one basefee snapshot, so activation in a low-basefee block can admit a policy with less operating cash than it needs at normal gas. Creator consented by proposing; player funds never at risk; withdrawal reserve recomputes at current basefee. Only consequence: possible later keeper-pay reverts (creator liveness). Consistent with R67. Info only.

### Info-4 — O1/O8 gate metrics narrower than their prose (signing hazard)
O1 gates only keeper_refund_gas_kept_per_draw<=80000; the 0.311/0.622/0.05-per-12s/0.00002 caps are code constants not checked by that metric. O8 gates only creator_credit_error_wei==0; "paid and unpaid work protect existing credit" and "claims available during depletion" are not captured by the credit-error metric (exercised in ProtectedRevenueAtomic/ConcurrentRecovery, not run here). A signature over O1/O8 covers the gated number, not the full sentence.

### Info-5 — O9 referenced by requirements but absent from gated outcomes; drift_groups vestigial
asset-flow.json has no O9 (O8->O10). R17/R33/R59 still discuss O9 and a 0.001 ETH drift bound, and asset-flow.json still carries drift_groups / drift_threshold_bps:500. R62 redesign supersedes the markup-attribution/drift model (O8 says so), so dropping O9 is intentional, but the leftover drift_groups config and R17/R33 prose are stale. Confirm the (unread) asset_gate.py does not still key off drift_groups for a removed outcome.

## O1-O16 TEXT-ACCURACY (code vs prose)
O1 matches (all constants present; metric narrower, Info-4). O2 matches (per-shape surcharge cap 0.102, restock:228). O3 matches (post-close reserve=owed*reconcile-budget while paid enabled, 0 when disabled; closeoutPending PASS). O4 matches (redeem_gap 0 PASS). O5 matches/not-run. O6 matches (creator_assets_left 0 PASS; NFT-delivery-failed exception real). O7 matches/not-run. O8 matches (floor(amount*bps/10000) once; credit_error 0 PASS; prose>metric Info-4). O9 ABSENT (superseded, Info-5). O10 matches/not-run. O11 matches (quiet PASS; scoped to named fixed-input regimes). O12 matches (quiet PASS). O13 matches/not-run (processAcquisitions(2) wiring present). O14 matches/not-run (activate preserves prices, funds exposed shortfall). O15 matches (0.2356 exact PASS). O16 matches (zero top-ups PASS). No O-text contradicts the code I examined; only O9 absence and O1/O8 prose>metric, both benign.

## UNTESTED PATHS (this timebox)
- 22/25 regimes (ran closeout/minimumCapital/quiet only). Not run: policy_switch (O14), no_processor/burst (O13), gas_spike, randomness_not_delivered, top_heavy/extreme_*, largest_board, whatif_* (O5), normal_gas (O10).
- All TypeScript (keeper service, rehearsal, e2e, reserve-economics).
- Adversarial Solidity: KeeperAdversarial, PolicyEconomicReview, PolicySecurityReview, HostileCollection, Invariant, entire test/audit/ tree.
- canPurchase 100k-gas boundary not independently measured.
- Coalition attacker economics (R52) not independently modeled.

## THINGS THAT DON'T MAKE SENSE / OWNER'S EYE
1. Permissionless pool creation at a "small capped launch" — O6 player loss reachable by any third-party creator from block one; no on-chain owner-only enforcement (Info-1).
2. "Protected credit" vs "self-sustaining" tension — creator can lawfully withdraw credit until their own pool cannot pay keepers (Info-2).
3. Stale drift_groups / O9 references after R62 removed O9 — confirm asset_gate.py does not gate on them (Info-5).
4. O1/O8 prose broader than their single gated metric — signature covers the number, not the sentence (Info-4).

## LAUNCH-BLOCKER VERDICT
No Critical or High finding; nothing examined blocks a small capped mainnet launch. All findings Info/Low, either owner-accepted-and-disclosed (O6) or by-design (credit protection, snapshot funding). Fund-safety core sound in checked paths: B>=C holds, admins cannot drain, keepers bounded and paid only for real work, FWA books proceeds only on delivery (no double-spend of refunds), closeout returns everything. TIMEBOXED (75m, 3/25 regimes, no adversarial suites) — NOT a clean bill. O13/O14 and the adversarial/coalition suites remain lane-B-unverified and should be covered by lane A or a full gate run before signing.
