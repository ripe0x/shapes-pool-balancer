> **Correction (2026-11-19). Historical lane report; [REPORT.md](REPORT.md) is authoritative.** (1) The "~75 min"
> phase table is wrong: harness wall clock was 9.4 min (follow-up 4.2 min). (2) The `quiet` destination list below omits
> 1.7 ETH of Shape/Pack backing still listed and 0.196809999707904070 ETH held by FWA; the full list is in REPORT.md.
> (3) "no supplied randomness" is wrong: fork tests deliver selected words by impersonating the real VRF coordinator
> (owner-approved exception). Live oracle delivery was not tested.

# Independent Release Review (Lane A, informed) — shapes-pool-balancer

**Target (immutable):** e7e3558f4d0de3e30d24f92f3b0e2dbdde664028 of ripe0x/shapes-pool-balancer, at /private/tmp/shapes-review-A-e7e3558.
**Scope:** whole candidate (src, script, keeper, app/src, shared), FWA/Shapes/Packs integration, deploy route. Extra attention to git diff cc35dce e7e3558.
**Standard:** adversarial-security-audit-standard (release-candidate tier) + holistic-verification. Economic pass first, then security, then self-challenge.
**Result:** No Critical/High. Prior audit E1 (zero-selectable-curated admission) repair HOLDS under source proof, 7 fork tests, a real-fork rehearsal, and exact conservation across 25 economic regimes. One Low carryover (cc35dce-report S2 keeper /health false positive) unchanged in code, non-blocking. Timeboxed pass, NOT a clean/complete/release-ready claim.

## Methods and commands (exit status)
- git diff --stat cc35dce e7e3558 -- src keeper app/src shared script -> 0. src change is only PoolBalancer.sol(+11), PoolInventory.sol(+43), interfaces/External.sol(+1); rest app/keeper/abi.
- forge --version -> 1.8.1 (matches gate pin).
- forge test --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 --match-path test/CuratedAdmission.t.sol -vv -> 0, 7 passed. Cold canPurchase at 1000 shapes+100 curated = 71,194 gas (< FWA 100k stipend).
- forge test ... --match-path 'test/{SelectableInventory,HostileCollection,KeeperAdversarial,ConcurrentRecovery}.t.sol' -> 0, 22 passed.
- Read deployed FWA StandardPool.sol (impl 0x85Faf9...) slot/settle internals.
- Read 25 gate scorecards (read-only): conservation gap 0 everywhere, mismatches [] everywhere.
Fork context: Foundry runs calls at gas 0/basefee 0 unless set; ForkBase.sol sets vm.fee/vm.txGasPrice and fee-sensitive tests assert inside calls. No broadcast, no protocol mock, no supplied randomness. Added no new .sol files.

## Time per phase (~75 min)
orient+diff 12; economic 15; security 40; self-challenge 8.

## ECONOMIC
quiet regime (0.5/0.55 gwei, mintFee 0.001, 180 draws). Inflow base 9.364669993865986350 ETH = 5 deposits + 4.36467 player payments.
Destinations (gate scorecard, independently reconciled):
- creator claimed 4.068446924008082280
- prize backing to winners 2.790000000000000000 (279 x 0.01 backing units)
- randomness to FWA 0.231660000000000000 (180 x 0.001287 = 0.23166 verified; per-draw matches CuratedAdmission test)
- Shapes mint fees 0.258000000000000000 (258 shape units x 0.001 verified)
- keeper pay 0.116073070150000000 (matches prior independent audit to the wei)
- player refunds 0; creator reserve change 0.003680000000000000
- SUM 9.364669993865986350, conservation gap = 0.
Conservation independently verified (inflow - sum destinations): quiet 0, closeout_pending 0, large_win 0, minimum_capital 0, zero_demand 0, gas_5_gwei 0. All 25 scorecards mismatches [].
One-screen scorecard per-flow absolute checks:
- creator capital in: 5 ETH conserved, gap 0.
- creator credit: floor(amount x bps/1e4) once per collection (_collect), gated error 0 (O8).
- backing: listed 1.70 held; unlist redeems exactly backing, redeem_gap 0 (O4).
- purchaser escrow/refunds remain in FWA; 0 in quiet.
- keeper: retained refund <= 80k gas/draw (O1); beyond_gas_and_reward 0.00099 ETH / 180 draws quiet; gate mismatches [].
- restock outstanding (O2) <= 0.26: listed 0.17931 - won 0.141085 = 0.038225 ETH verified.
- FWA fee: 0.001287/draw verified.
- idle/stranded: minimum_capital 3.274 ETH fully conserved; O16 topups 0.
No ratchet/one-way anomaly in sampled regimes; closeout returns to documented zero except FWA-quarantined delivery-failed NFTs (O6 carve-out).

## SECURITY
Only consequential changed logic: curated witness (E1 repair).
admission adds before fill check:
  uint256 active = pool.activeListingCount();
  if (active <= s.listedPrizes && !_hasCuratedWitness(s, pool)) return 7; // CURATED_PROOF_REQUIRED
plus permissionless refreshCuratedWitness(listingId) and a witness seeded in listCurated. _hasCuratedWitness requires lid!=0 && activeIndexPlusOne[lid]!=0 && items[lid].kind==1 && pool.slotToListing(witnessSlot)==lid.
Why it holds (source proof):
1. Valid witness => active curated. In deployed FWA StandardPool, _activateListing is the only writer of slotToListing[slot]=listingId (841), and _settleAndRemove does delete slotToListing[slot] (1890) on EVERY active-pool exit: withdraw (1016) and win/selection (1700). Listing ids are monotonic, never reused. So slotToListing[witnessSlot]==witnessLid iff that curated is currently Active in the selection tree. No stale-slot window; slot deleted atomically on removal; a reused slot yields a different id and breaks the witness. Tested: test_withdrawnCuratedAndReusedSlotCannotAuthorizeStagedCurated (pass).
2. Counting shortcut sound. active>listedPrizes skips witness. active = activeShapes_fwa + activeCurated_fwa, and activeShapes_fwa <= listedPrizes always: listedPrizes increments per tracked SHAPE added to activeIds and decrements only AFTER FWA removal (unlistShapes withdraws same tx; _onDrawn reconciles only sequences already _settleAndRemove'd on FWA). So active>listedPrizes => activeCurated_fwa>=1. No path decrements listedPrizes ahead of FWA removal.
3. E1 blocked. test_stagedCuratedBehindTwelveShapesCannotAuthorizePurchase: sole curated withdrawn, 20 shapes active, second curated staged behind 12 shapes => active(20)<=listedPrizes(32), no witness (staged curated slot 0) => admissionStatus()==7, canPurchase false; clears only after refresh once activated.
4. Griefing. refreshCuratedWitness permissionless/nonpayable, moves no assets; valid witness cannot be churned (returns false, line 134); a stranger cannot break a witness (needs real withdraw/draw). Worst case one permissionless refresh to resume.
5. Gas. Cold hook at 1000 shapes+100 curated = 71,194 gas (< 100k FWA stipend). listCurated witness-seed loop scans at most the 20-item batch.
Independent real-fork evidence: keeper/rehearsal.ts::recoverCuratedProof (new) drives two real Shape wins left unreconciled, withdraws the witnessed curated, asserts admissionStatus==7/canPurchase false, has an independent caller pay its own gas to refresh onto the surviving curated, asserts resume to 0 and a resumed real purchase, with protected state (pool balance, creatorCredit, keeper reward, settingsHash, reconciledSequence) byte-identical before/after. Covers the delivered-but-unreconciled variant the prior audit left untested.
Other surfaces (reused evidence, unchanged since cc35dce): BalancerFactory/KeeperPolicyCalls/KeeperPolicyV1/PoolPage no diff; POLICY_DELAY 2 days, reward caps intact. Reentrancy/callbacks: 22 tests pass; admission hook is view; refreshCuratedWitness nonReentrant. Deploy: chain-1 refuses without ASSET_GATE_PASSED=yes (hand-set defeat guarded by asset-flow gate + review); FWA impl address + codehash preflight (0x0af0...); full wiring postflight incl creator()==address(1), !keepersRestricted() (open keeper list), pack min 0.02; local rehearsal unsets ASSET_GATE_PASSED. App/shared off-chain: tx.ts intent capture + mined-tx match (from/to/input/value) + receipt/chain/block verify; ledger.ts display-only; abi.ts regenerated.

## Property map
- No paid draw with zero selectable curated: withdraw sole curated + stage another -> blocked status 7. Evidence: CuratedAdmission 7/7, source proof.
- Witness cannot be forged for staged/inactive: slot==0 / reused-slot curated -> revert/not set/broken. test_...ReusedSlot...
- Witness cannot be churned: stranger replace valid witness -> false no-op. test_lostWitness...CannotBeChurned + rehearsal protected-state.
- Counting shortcut cannot false-admit: active>listedPrizes with 0 curated -> impossible (invariant). Source proof.
- Hook < 100k gas: 1000 shapes+100 curated -> 71,194. test_coldWitnessHook...
- Economic conservation: 25 regimes -> gap 0, mismatches []. scorecards.
- Reentrancy via curated/keeper: hostile collection, self-dealing -> no drain/reentry. 22/22.

## Findings
L-1 (Low, carryover, non-blocking): keeper /health.ok still ignores per-pool RPC errors. keeper/keeper.ts:559 ok = (now-lastTick<120s) && accountingErrors==0; does NOT consider this.errors (per-pool failures) = cc35dce-report S2. keeper.ts unchanged since cc35dce (only rehearsal.ts changed). errors ARE in the /health JSON body (line 565) but a bare 200/503 probe can read green while a discovered pool's RPC read fails and zero upkeeps are sent. Not fund-safety/liveness blocker: factory launches keepersRestricted==false (deploy asserts), so any keeper may run upkeep; one keeper's probe false-positive cannot strand draws (O13 holds while list open). Recommend post-launch folding Object.keys(this.errors).length into ok, or documenting probe must read body. Label collision: AUDIT-FOLLOWUP-RESULTS "S2" = a DIFFERENT (wallet-confirmation) item that WAS repaired in tx.ts; this L-1 is the cc35dce-report S2.
Info: O10 2.27x, O11 shortfall examples, O2 larger-board scope are explicitly information-only in outcome text; code matches scoped text.

## Outcome-text accuracy O1-O16
All 16 texts heavily/honestly scoped. Spot-checks: O4 exact redeem (unlistShapes redeems for backing, gap 0); O6/O3 closeout zeros with FWA delivery-failed exception (recoverRefunded matches); O8 credit floor once per positive collection (_collect line 773 split-floor); O13 sales pause after last curated won until creator relists = exactly witness behavior; O15 0.2356 opening matches requiredReserve-gated open. No text promises behavior code does not deliver. Witness repair consistent with O7/O13 gate description.

## Untested paths / gaps (this review)
- Did NOT author a new .sol attack file; witness is small and provably correct from FWA source, and builder's 7 CuratedAdmission tests + real-fork rehearsal already execute slot-reuse, staged-curated, lost-witness, won-and-unreconciled, churn. An independent .sol would be near-duplicative.
- Did NOT re-run all 25 FlowBreakdown regimes (concurrent gate owns that); read scorecards read-only, verified conservation on 6-regime sample.
- Keeper estimateContractGas/send/receipt real-broadcast economics (prior S1) out of scope; no broadcast authorized.
- FWA factory config drift between review and launch is guarded by deploy preflight but not re-verified at head by me.
- Concurrent "sole curated won by draw1 while draw2 admitted on same witness" may give draw2 a non-curated prize: accepted no-barrier concurrency design (R62-R73, admission comment); confirm product copy never promises every concurrent buyer a curated-eligible pool.

## Things that don't make sense
None material. "S2" label is overloaded across audit rounds (cc35dce S2=keeper health; AUDIT-FOLLOWUP S2=wallet confirmation; INDEPENDENT-AUDIT-REVIEW S2=staged-inventory admission). Documentation hygiene hazard, not code: do not read "S2 fixed" as covering keeper-health L-1, which it does not.

## Launch call
No finding blocks a small capped mainnet launch. E1 repair sound and well-covered; economics conserve exactly across sampled regimes with destinations matching prior independent derivation; deploy route gated and self-verifying. L-1 is a post-launch observability improvement already neutralized for fund/liveness safety by the open keeper list. Timeboxed pass, not a clean or exhaustive certification.

---

## Follow-up: b294de0 (test-only fix for test_nineOutstandingDrawsAreReservedFromActualSequences)

**Context:** full CANDIDATE_RUN was 518/519; the lone failure was this test reverting with FWA `PurchaseNotAllowed()`. Builder changed only the 5 fulfill words from `0` to `wordForSlot(2)` (2 effective lines).

**Verified in my own /private/tmp copy (fork 26382349):**

1. **Diagnosis is correct — the original failure is correct contract behavior, not a defect.** Ran the unmodified test: it reverts with `PurchaseNotAllowed()`, trace shows `PoolInventory::admission()` returning 7. Setup lists `listCurated(1, 0.2 ether)` before `fillUp()`, so the sole curated occupies FWA slot 1; `fulfill(...,0)` delivers word 0, which `_selectSlot(0)` resolves to slot 1, so one settled draw wins the only curated NFT. The curated-witness repair (R71/R72) then correctly refuses the next paid batch (status 7). The test predates the repair. This is exactly the behavior my main review verified as sound.

2. **The changed test is not weakened and still tests its named behavior.** Ran the fixed test: PASS with every assertion unchanged — `requiredReserve()==0.01768 ether`, `unsettledAcquisitionCount` 4 then 9, `lastIssued-reconciled==10`, and the full expiry+refund path (`5*price` refund credited and withdrawn). `wordForSlot(2)` is computed dynamically from live listing weights (ForkBase.sol:205), not a magic constant, and slot 2 is a Shape — so the only change is that the five draws win Shapes instead of the sole curated, keeping a curated present so admission stays open and the reserve/refund logic is actually reached (the original reverted before reaching any of these assertions). Reserve-from-actual-outstanding-sequences and the refund path remain fully exercised.

3. **No other test encodes the same pre-repair assumption.** Grepped all `fulfill(...,0)` sites (word 0 => slot 1). Four others exist; each is safe for a verified reason:
   - `SelectableInventory.t.sol` deliberately uses `wordForSlot(_shapeSlot())` (lines 56/76/89) to avoid the slot-1 curated — the suite is already repair-aware. Its lone `fulfill(first[4],0)` (104) is a late callback on an already-expired draw (rolled past `selectionTimeoutBlocks`, board still 21 active); FWA ignores it, nothing is won, so the following `buy` succeeds legitimately.
   - `SelectableInventory.t.sol:132` lists curated only at line 135 (after the word-0 draws), so slot 1 is a Shape at delivery time.
   - `ReserveEconomicReview.t.sol:189` delivers word 0 as its final action (`upkeep()` + reconcile asserts); no subsequent admission-gated purchase.
   - `ProtectedRevenueAtomic.t.sol:241-242` is followed by `close()`, not a gated buy; the rate-boundary assertions are unaffected by which prize is won.
   The CANDIDATE_RUN's single failure confirms this empirically: the repair is deterministic, so any other test sharing the pattern would also have failed.

**Follow-up verdict:** The b294de0 diagnosis is correct, the fix is a legitimate test-data correction (not a weakening or an assertion relaxation), and no sibling test hides the same stale assumption. The failure was the test, not the contract; it does not change the main review's launch call. My tracked `test/ReserveCapital.t.sol` was restored to its committed e7e3558 state after verification (change applied only transiently to run both variants).
