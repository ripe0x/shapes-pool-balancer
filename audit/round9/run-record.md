# Round 9 process record

## Intake (2026-11-13 11:28 UTC)

- Operation: full audit (security and economic), per `docs/AUDIT-PROMPT.md` round 9 under `$adversarial-audit`.
- Owner budget: **12 auditor-hours**, run in this session (owner reply "Yes, 12 hours here", 2026-11-13). Committed in
  `c686534`. Planned split: lane A 3 h, lane B 3 h, integration assessor 2 h, controller 4 h.
- Frozen target: `fork-tests` commit `c686534669562e78fd33f7297c13f12e68fe3066`; clean tracked tree and submodules.
  Production source identical to `7b32497` (later commits touch docs only). `freeze.json` hashes 1,290 tracked
  in-scope files. Submodules: forge-std `dc647cc`, shape-packs `3a463f7`, solady `acd959a`.
- Compiler: `/Users/dd/.svm/0.8.28/solc-0.8.28`, SHA-256
  `81515b0e53deaa266d549545ccaac0a5a96e6d4e8201c77f673b2c710976d9ea`; Cancun, via IR, optimizer 50 (Draw Packs 20).
- Undeployed target: source-to-runtime correspondence not applicable. Pinned block 26,382,349; recent block recorded by
  each lane. RPC: `https://mainnet.gateway.tenderly.co` only.
- Workflow hashes (SHA-256): standard `2334a09d…f9219`; SKILL `7922c9e3…cffb4`; runbook `a2042edd…6e35`;
  acceptance `e45d1b36…e6f1`; report contract `aa9f1b06…ed6`.
- Isolation: **prompt-level (procedural)**, as in rounds 7 and 8. No runtime boundary is available; the shared
  filesystem does not prevent excluded reads. Evidence integrity: advisory. Calibration: uncalibrated. Human review:
  none planned.
- Controller exposure: the controller (this session) wrote the code under audit and knows round 8's findings and the
  round 9 follow-up review. It does not perform discovery; it prepares packets and runs the informed phase.
- Preserved processes: anvil 8545 (controller's dev fork, owner-authorized), anvil 8547 (another project; untouched).
  Lane forks: A 18601, B 18602, integration 18603.

## Discovery packet

`discovery-packet.md` (SHA-256 `a9c9e57eabc914c9684c29fd304ed1f96c4810920e34945c8906b8cd84a9ad8e`): §1, §2, §4, §6 of
the prompt verbatim, two edits removing pointers to the decision log ("Since round 8" became "Later";
"(DECISIONS 66-68)" removed), access rules and budget. Neutral sentinel: `preflight/Sentinel.t.sol`.

## Lanes issued (2026-11-13 ~11:30 UTC)

Three fresh general-purpose agents (no history), each given only `discovery-packet.md`, the audit standard path, its
angle, ceiling, port and output contract. Lane A: obligation-derived, security and accounting (3 h, port 18601).
Lane B: direct harm search, economic and keeper incentive (3 h, port 18602). Integration: live integrations, drift,
timing, off-chain (2 h, port 18603).

## Integration lane seal (11:44:04 UTC)

Sealed after about 12 minutes active (`integration/discovery-seal.md`). Reported no integration drift at blocks
26,382,349 and 26,405,755; F1 (Low/info, FWA config change blocks new pools, fail-closed), F2 (Low, a restock bumps
FWA's inventory version under a pending draw; refund, no principal loss), F3 (Info, VRF fee is 0 at gas price 0; no
under-send path found). Untested: full VRF-fulfilled draw cycle, FWA acquire revert reachability, keeper e2e.
Acceptance: seal accepted as a stage record only; its negative results are not yet accepted (evidence challenge
pending). Continue disposition: resumed the same lane (no answers supplied, only a tool-plumbing note about
fs_permissions) for the untested paths as a post-seal addendum within its 2 h ceiling.

## Lane A seal (~11:52 UTC)

Sealed after about 22 minutes active (`lane_a/discovery-seal.md`). Reported one finding: **M9, Medium**:
`withdrawCurated` (and other listing-set changes) before `_collect` changes the split denominator
(`activeIds.length`), so the same proceeds book more profit while the fund is short (PoC ×6/5 on its board). Held
(its claim): M1, M4/M7 full cycle, M6, implementation lock, handovers, ERC-1271 epochs, reentrancy via hostile
collection. Untested: Draw Packs lifecycle, refunded-delivery path, bursts, off-chain.
Controller note (informed): the repository test `test/Reserve.t.sol::test_listingNFTsBeforeCollectionCannotMoveFundMoney`
asserts only that the withdraw-curated case keeps profit below half the payment, not that it is no more than the
honest split, so it never tested M9 as written for that action. Lane A's VRF route impersonated the VRF service
calling `rawFulfillRandomWords` (bypasses service bookkeeping); post-fulfilment state claims are diagnostic only
until re-run through the coordinator route.
Continue disposition: lane A resumed (no answers supplied) for M9 extent across creator actions and timing, bursts,
Draw Packs, refund path, stateful cycle, coordinator route; post-seal addendum within its 3 h ceiling.

## Integration addendum (completed before 12:13 UTC)

Post-seal addendum (`integration/addendum.md`, `addendum-seal.md`, `FullCycle.t.sol`, 8 tests pass), about 21 minutes
total lane time. Real route verified: Chainlink coordinator `0xD7f8…893a` → FWA VRF consumer `0x7D93…d65d`
`rawFulfillRandomWords`. Reported: full cycle to prize delivery and restock; Deploy.s.sol postflight readbacks hold;
gas-price-0 quotes under-fund the VRF fee and revert at inclusion, but no repository caller simulates at 0; a stale
inventory version reverts the draw (F2 confirmed, refund, no principal loss); a 5-draw burst upkeep uses 2,526,347
gas against the keeper's 4,000,000 floor. Still untested by this lane: refund branch (assigned to lane A), keeper
process under reorgs, FWA frontend version pinning (out of scope). Lane closed; evidence challenge pending.

## Lane B seal (~11:57 UTC)

Sealed after about 25 minutes active (`lane_b/discovery-seal.md`), 13 tests pass. Reported: no confirmed exploit in
exercised paths; M1/M2 keeper pay equals credited restocking fees to the wei over 5 cycles; overbid neutralised; M7
closeout sweeps to 0; mint-fee open/close round trip exact; L1 informational (thin keeper margin on single-Shape
restocks at low basefee); challenge that M9's "fund keeps all NFT sale money" holds only below the reserve.
Limitation: its VRF route pranked FWA's VRF service (`0x7D93…`) calling the pool, bypassing the service; it then hit
InsufficientVrfCoverage above ~0.5 gwei and after ~5 draws, so the below-reserve regime, 1–5 gwei, launch-scale mixes
and bursts were not driven. Continue disposition: lane B resumed with a route correction only (no answers) for those
regimes as a post-seal addendum within its 3 h ceiling.

## Slither (controller, before 12:13 UTC)

First run `slither src/PoolBalancer.sol --ignore-compile --json audit/round9/slither-pool.json` against the main `out/`
failed in crytic-compile (`KeyError: 'output'`: skeleton build-info files). Second run built into
`audit/round9/slither-out` with `--build-info` and passed `--foundry-out-directory`; JSON success, 236 detections, 40
High/Medium. Triage in `slither-triage.md`.

## Informed phase started (before 12:13 UTC; all three discovery outputs sealed)

Controller work so far: Slither triage (`slither-triage.md`), round 8 retests and test-suite mock review
(`informed-retests.md`). New informed observation: three repository tests mock a failed Shape/pack delivery with
`vm.mockCallRevert` on Shapes/Draw Packs; the real path is untested and its reachability is open (lane A continuation).
Controller root-cause note for M9 (reading, to validate): `performUpkeep` reconciles (removing won listings from the
split set) before `_collect`, and creator listing changes do not collect first, so the split set at collection can
differ from the set the draws were priced on. Lanes A and B continuations still running (blind, no answers supplied).

## Lane B addendum (completed before 12:13 UTC)

About 40 minutes total lane time; `lane_b/addendum.md`, `addendum-seal.md`, 11 tests pass. Route corrected and
verified (coordinator `0xD7f8…893a` → service `rawFulfillRandomWords`); coverage failures gone. Reported: below-reserve
regime driven (fund 0.6975 vs reserve 1.0515 after a forced 0.5 win), withdrawable 0 while short with profit 0; a
markup-change timing attack booked 0 wei; M1/M2 held at 1, 3, 4.9 gwei (16 draws each); at 6 gwei rewards cap and
keepers stop (by design); creator net positive in one run per launch mix (Balanced +0.4147, 0.01-only +0.2680,
bigger-prize +1.1105 ETH); fill gate pauses at burst depth 3.
Controller acceptance: lane B's sentence "no creator action moves fund to profit" is **narrowed** to the markup-change
sequence it executed; it did not test withdrawing NFTs or unlisting before collection (lane A's M9 finding). Creator
net figures are single runs, not a distribution. Residual gaps: refund path, hostile receiver, pack prize drawn and
redeemed, mint-fee-rose gate, loss distribution, off-chain execution.

## Lane A addendum (completed before 12:13 UTC)

About 38 minutes total lane time; `lane_a/addendum/addendum.md`, `addendum-seal.md`, 14 tests pass, real coordinator
route (the earlier shortcut gave identical M9 figures). Reported: M9 levers are withdrawing curated NFTs before
collection (profit × n/(n−k)) and collection timing (when, not lifetime total); unlistShapes, listCurated, configure
and creator transfer neutral or fund-favourable on its tests. Worst case (100% markup, 10 Shapes + 10 NFTs): honest
collect books 0 profit; withdraw all 10 NFTs then collect books 0.01738 ETH and the fund drops to 0.0677 ETH.
Balanced 15% with one NFT: 0.0000198 ETH per cycle. Draws in flight (1 and 5) keep the invariants; Draw Pack
lifecycle exact (0.02 ETH); FWA delivers Shapes and packs with plain `transferFrom`, so a hostile receiver cannot fail
their delivery; a transfer-reverting curated collection takes the refund path cleanly.
Controller: lane A's delivery observation makes the three `vm.mockCallRevert` repository tests exercise a branch
that is unreachable for Shapes and packs on the real path (defensive code), not a hidden real behaviour.
Discovery lanes closed. Next: independent evidence challenge and schema-2 manifest.

## Manifest and first gate run

Manifest agent (`gate/record.md`): inventory 57 entrypoints (18 compiler getters), 67 external calls, 40 High/Medium
Slither IDs, all mapped; 6 critical paths (P1 accessors held, P2 authorization/admin held, P3 split **violation**,
P4 keeper/restock/delivery held, P5 reserve held, P8 refund open questions **unresolved**). Gate exit **1**: P8
unresolved, independent review missing (challenge not yet written), postcondition review empty. Its reported window
(12:13:41Z to 12:24Z) is about 11 minutes, not the 70 it stated; the controller records the timestamps. The gate is
re-run after the challenge.

## Evidence challenge, first pass, and controller M9 test (~12:45 UTC)

Challenger (`challenge/evidence-challenge.md`, about 13 minutes): reproduced lane A's M9 PoCs (×6/5; worst case
0.017384 ETH), the integration full cycle, and lane B's markup-change result on lane A's harness (lane B's own file
needs a root `out/` artifact and did not run). Narrowed lane B H9 to above the reserve. Accepted lane A's
"unlistShapes neutral" with a general argument (admission requires a curated listing, whose zero share pulls the average
below every Shape's share). Claimed a new automatic leak C12 (NFT draw, `collectProceeds` books 0.001985 ETH while
short).
Controller dispute of C12 (`controller/UpkeepOrder.t.sol`, real coordinator route, exit 0): the 0.001985 ETH is the
designed expected-value split on the draw-time set (same as lane A's honest baseline), and the shortfall there came
only from the unreconciled-draw term; after reconciliation the fund (0.0610 ETH) exceeded the reserve (0.044 ETH).
Controller-confirmed automatic variant (`upkeep-order-short.log`): after a 0.5 win (fund 0.0486 vs reserve 0.534), the
same NFT draw books 0.002188 ETH collected on the draw-time set and 0.002553 ETH (×7/6) through `performUpkeep`,
which reconciles before collecting. Both M9 variants share one root cause: the split set at collection differs from
the set the draws were priced on. A first version of the short-state test failed setup ("curated not drawn within 120
words" at a 0.3 ETH NFT, exit 1; the re-run at a 0.02 ETH NFT overwrote that log, so this line is the only record).
Challenger resumed to decide C12 and the controller variant on evidence, and to review every manifest postcondition.

## Evidence challenge, second pass

`challenge/challenge-pass2.md`, about 14 minutes. C12 **rejected** as a standalone leak (designed expected-value
split; transient reserve term; after reconciliation the whole payment is above the reserve). Controller's
upkeep-order variant **accepted** and now asserted (`challenge/UpkeepOrderAsserted.t.sol`, pass): after a 0.5 win,
balance 0.064 vs reserve 0.534, NFT drawn; profit 0.002188 → 0.002553, claimable 0.004283 → 0.004647 (+0.000365 ETH)
through the keeper's default order, no creator action. Manifest review (`challenge/manifest-review.json`): 10
postconditions, 7 accepted, 3 challenged (P3 automatic variant uncited; P4 reward-callback reentrancy asserted but not
executed; P8 stale wording, player refund amount still open). Next: focused tests (running), then manifest repair,
re-review of repaired postconditions, gate re-run.

## Focused informed tests (`focused/record.md`, 12:29–12:48 UTC)

All exit 0, real coordinator route. (1) Launch Balanced mix in a genuine shortfall (n 41, fund 0.534 vs reserve 1.0515):
the split books amount × S / n = 0.00079287 ETH per draw (3.94% of the 0.0201 ETH draw price), matching the formula;
the agent's label "C12 leak reproduced" is not adopted: this is the designed expected split (challenge pass 2).
Variant (a) withdrawCurated: +0.0000198 ETH per event, costs 293,280 gas (~0.00147 ETH) to withdraw and relist.
Variant (b) upkeep order: NFT draw +0.0000198, 0.01 Shape +0.00000007, 0.5 Shape −0.0000020 ETH per event; expected
value over FWA's weighting −59 gwei (fund-favourable, essentially unbiased); a single launch-scale reconcile clears the
shortfall term, so ×n/(n−1) needs a persistent shortfall. (2) MINT_FEE_ROSE (real Shapes admin, 0.001 → 0.002):
purchases refused, restock stops, configure re-accepts, restock resumes, closeout to 0: held. (3) retire(): in-flight
draw settles and reconciles, everything unlisted, 0 ETH left: held. (4) Burst: 5 unsettled (6th refused), heaviest
upkeep 2,526,724 gas under the 4,000,000 floor; keeper pay within credit: held. (5) Reward-callback reentrancy
(100k stipend): unguarded `transferCreator`, `close`, `configure` execute re-entrantly and persist; guarded calls
blocked; profit ≤ balance held; all are creator-only, so no authority gain (the creator is the caller). Non-setup
credit path not driven.

## Refund path closed (controller, ~13:05 UTC)

Focused item 6 (`focused/CuratedRefundLedger.t.sol`, exit 0) showed a failed curated delivery credits the Balancer
nothing (proceeds, profit, keeper credit all 0) and recoverRefunded returns the NFT; it stopped at
`refundFailedDelivery` and reported the player's refund as missing. FWA refunds by pull: controller copy
`controller/CuratedRefundWithdraw.t.sol` adds `withdrawAcquisitionRefund()` and asserts the player receives exactly the
acquisition fee, 0.630139131231725739 ETH (exit 0, `refund-withdraw.log`). Bound: gas price 0 in the test, so the VRF
fee was 0; round 8 measured the VRF fee as the player's only loss. Manifest agent resumed to integrate the new
evidence and re-run the gate.

## Gate run 2

Manifest repaired (`gate/record.md` "Run 2"; run-1 artifacts kept as `audit-gate-run1.json`, `gate-run1.*`). P3
violation (now with the automatic variant), P1, P2, P4, P5, new P6 (mint-fee gate, retire) and P8 held. Gate exit
**1** with one line: six repaired postconditions withheld from the independent review on purpose
(`gate/rereview-needed.md`). Challenger resumed for that review and a report-claim check.

## Gate run 3 and close (13:15 UTC)

Challenger pass 3 (`challenge/manifest-review-pass3.*`, about 12 minutes) accepted all six repaired postconditions
after re-running each cited test, and flagged three report wordings (placeholders; refund "exactly the acquisition
fee" needed the VRF bound; ApeBall item 1 needed the 5 gwei bound), all corrected. Controller merged the pass-3
entries into `gate/audit-gate.json` (run-2 copy `audit-gate-run2.json`, `gate-run2.*`), combined the review artifacts
into `gate/evidence/independent-review.md`, and re-ran the same gate command: exit **0**, "PASS: structural coverage;
independent judgment still required" (`gate/gate.output`). Structural only.
Time: lanes A 38 min, B 40 min, integration 21 min; challenger 39 min; manifest 25 min; focused 30 min; controller
about 1h55m concurrent; total about 5h10m of the 12 h cap. Wall clock 11:28 to 13:15 UTC. Stop: every known open
item has a decision in `report.md` ("Open items"); no feasible action left that could change a consequential
conclusion within scope. Human review: none.
