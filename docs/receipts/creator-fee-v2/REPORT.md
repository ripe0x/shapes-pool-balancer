# Automatic creator fee / exact-shortfall reinvestment checkpoint

2026-11-25, base revision `471578b`. **UNVERIFIED contract runtime: external RPC blocked the focused fork batch.**
Source hashes are in `source-sha256.json`. No deployment, factory switch, funding, pool writes or new draws occurred.
Existing Anvil 8545, application and both keepers remain running. Unrelated live journals remain untouched.

## Implemented scope

Owner R118–R121: automatic markup/mix creator fees, protected cash credit, separate bankroll profit, reserve-first
claims, creator-only capped exact-shortfall reinvestment, closed reopening allowance, retired rejection, v0/v1 UI
compatibility, no manual earnings setter. Reinvestment decreases fees and increases capital equally; no ETH transfer.
Fees use collection epochs, not per-ticket snapshots. Full-target automatic mix prevents normal depletion changing
allocation; curated changes wait for settlement, reconciliation and activation.

## Verification

| Check | Result | Evidence / limit |
| --- | --- | --- |
| Compilation/size | PASS | `forge build --skip test --skip script --sizes`, exit 0, `logs/build.log`; runtime Balancer 24,438 B (138 B EIP-170 margin), Inventory 19,184 B. Final selected `--list` compilation passed, without executing tests. It emitted ABI-only artifacts; ordinary cache-aware build skipped their missing bytecode. Diagnosed and restored bytecode with targeted `forge build src/PoolBalancer.sol src/PoolInventory.sol --no-cache --sizes` and a targeted Factory build, without deleting caches. Final sizes unchanged (`logs/bytecode-restored.log`). |
| Typecheck | PASS | `npm run typecheck`, exit 0, `logs/typecheck.log` |
| Focused TS | 53 PASS, 5 SKIPPED | `npx vitest run app/src/profit.test.ts shared/planner.test.ts app/src/creation.test.ts app/src/creation-replacement.test.ts app/src/ledger.test.ts`, exit 0, `logs/vitest.log`. Five pre-existing live transaction/receipt cases require explicit environment setup; no live writes were authorized here. |
| Focused contract batch | BLOCKED | Compile first rejected reserved identifier `partial`; repaired to `partialAmount`. Retry compiled successfully, then Tenderly returned HTTP429/-32005 even for `eth_chainId`. Pinned-block single-thread retry also blocked before any test execution. Original failures preserved in logs (only trailing blank lines normalized). |
| Independent affected review | Completed, bounded static review | Reviewer found closed-pool top-up incorrectly appended upkeep. Fixed by appending upkeep only while enabled; reviewer confirmed repair and equivalent reserve extraction. No other concrete money/authority defect identified in reviewed files. No execution claim. |
| Read-only actual React preview | PASS for reached controls | Actual Overview with static props, transactions disabled: deposit zero fees; .05 fees/.02 gap shows .02 top-up/.03 remaining; .01 fees/.02 gap shows .01 cap/zero remaining; closed pool .011 reopening gap shows .011/.039 remaining; v1 net-profit UI preserved; details toggle and Other amount form work. No wallet transaction. Fixture retained as `.tsx.txt`; temporary app entry removed. Closed fixture initially supplied a stale .02 quote, corrected to its independently calculated .011 reopening gap and rechecked. |

Blocked command (retry only this contract batch when the required RPC recovers):

```sh
forge test --match-contract 'CreatorFeeReinvestmentTest|CostFirstProceedsTest|AuthenticEconomicFlowsTest|AuthenticPositiveProceedsTest|AuthenticContinuationTest|AuthenticSequenceTest|AuthenticRefundRecoveryTest' --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26442752 --chain-id 1 --threads 1 -vv
```

Tests use real protocol contracts and genuine public historical VRF proofs; they are not yet executed for this patch.
Seven new fee scenarios cover fee-limited residual shortfall, old-rate pending receipts, deferred updates, zero allocation at 10% markup, deposits, actual
fee claims, optional partial/exact/stale-maximum top-ups, maintenance credit protection, closed/reopened/retired cycles.
Existing focused cost-first tests cover real mint/redemption, gifts/forced donations, keeper callback donation,
creator authority and closeout. No fabricated protocol balance/storage/oracle answers were added.

## Economic scorecard

These are **static illustrative arithmetic**, independently derived during review, not measured fork outcomes.

| Flow / outcome | Amount |
| --- | ---: |
| Starting native capital | 1 ETH |
| Actual owner receipts, illustrative | +0.02 ETH |
| Automatic prize backing lost | −0.01 ETH |
| Initial plus replacement mint fees | −0.002 ETH |
| Keeper payment | −0.002 ETH |
| Combined gain | 0.006 ETH |
| Reserved fee at illustrative 11.5% | 0.0023 ETH |
| Separate bankroll profit | 0.0037 ETH |
| Withdrawal with adequate reserve | 0.006 ETH; leaves NAV/capital 1 ETH |
| Deposit of 1 ETH | +1 ETH capital, 0 fees, 0 profit |
| Reinvest .02 of .05 fees into .02 gap | Fees .03; capital +.02; cash movement 0; new profit 0 |
| Fees .01 versus .02 gap | Uses .01; leaves .01 unfunded |

Asset map: player -> FWA protocol/randomness buckets + owner receipts -> Balancer reserved fees and operating cash.
Operating cash -> Shape/Pack backing + mint costs + keeper reward. Prize backing -> actual NFT winner or redeemed
cash. Reserved fees -> creator wallet or explicit capital reinvestment. Bankroll profit -> creator only above reserve.
Curated NFTs -> winner/creator/recovery with no invented native capital basis. Native gifts/deposits -> capital only.
Capital target increases on contribution/reinvestment and falls on closed principal claims; prior losses persist.
New fee accrual adds no extra transaction per draw; collection and configuration do more work. Incremental gas and
keeper margin have not been measured for this patch at launch gas or the cap; no operating-cost claim follows.

No quiet/maximum/idle/zero-demand/large-win/gas-spike/dependency-pause/wind-down regime is newly proven here. The
full economic campaign remains separate under R113. Historical 20-draw v1 evidence does not validate v2. No replay
simulation agreement, production-path rehearsal, new browser-wallet lifecycle, live oracle availability or mainnet
canary claim is made. Existing immutable v1 pools cannot gain these methods by a factory switch.

## Things that do not make sense

- A passing TypeScript batch cannot stand in for unexecuted contract regressions. RPC refusal is a concrete remaining blocker.
- Gross creator fees may coexist with bankroll losses; describing them as overall investment profit would still be wrong.
- Only 138 bytes of implementation size headroom remain. Any further contract change needs its size checked.
