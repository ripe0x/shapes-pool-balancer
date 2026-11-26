# Retained regression repairs and calibration evidence

Production source and the signed source digest remain unchanged. Owner-approved CI migration `36895b3` retained these general suites. Hosted CI ran the 46 focused cases successfully (413.11s cold RPC), all TypeScript tests (323 pass/17 skip), build/typecheck/app build and Fork, then failed Settings's old open-capital-draining fixture. Original hosted logs remain one directory above.

Six test files repaired stale v1 fixture rights without altering runtime behavior: Settings, ReserveCapital, Balancer, ConcurrentRecovery, CuratedAdmission and KeeperPay. Low-cash fixtures now use real closed principal recovery and reopen with the same operating buffer. Pending and unreconciled claims retain all cash; exact keeper holds and payouts remain asserted. The staged-admission test invokes FWA's real public expiry processor before keeper work. Constructor input zero preserves the intended stale-settings/initializer errors. No mock protocol state, source or new synthetic oracle implementation was introduced. Existing legacy synthetic fulfillment is regression setup, not genuine-proof evidence.

One targeted `--no-cache` build restored only the 13 retained sources' executable artifacts. Subsequent batch:

| Command scope | Result / file |
| --- | --- |
| 11 non-isolated general contracts, exact argv in results.json | 83 pass / 2 fail; general.log, exit1 |
| KeeperPayTest, --isolate | 9 pass; keeper-pay.log, exit0 |
| GasBench, --isolate | 25 pass; gas.log, exit0 |
| shared/policy-money-path.test.ts on newly generated actual fixture | 1 pass; fresh-model.log, exit0 |

The first general failure was a one-shot prank consumed by an external `mintFee()` argument getter. Caching the value before the prank fixed it; only that failed case was rerun, exit0 in reserve-capital-repair.log. It additionally asserts actual retained .19 ETH backing plus cash remains below contributed capital and that the exact negative operating result survives the fee claim, avoiding reliance solely on a clipped zero-profit getter. Six-file fixture repair and actual regenerated fixture committed as `6fc8c62`. Effective retained result: **118 passing contract cases**, one outstanding Hardening economic case, plus one passing fresh model replay. The full batch was not rerun after the isolated repair.

Independent informed source review found no further blocker in the six fixture diffs, but caught overstrong wording on clipped zero-profit getters. Lead corrected wording and added actual signed-loss conservation assertions. A subsequent 1-wei authorization/cash boundary or setup failure would remain a real test failure, not evidence to relax approved economic rights.

Hardening's old 80-gwei basefee/5-gwei bid could not be included on Ethereum. An actual GasProbe CALL now witnesses 4.95-gwei basefee/5-gwei bid. The retained 910k surcharge bound still fails: first measured gas899584, reward .004837920ETH, surcharge .00475ETH, gap .000087920ETH. This original material failure is preserved in hardening-realistic-cap.log and awaits the owner's economic decision.

Temporary real-factory 940k proposal: same failing test, all four cumulative assertions retained, exit0. Rewards .004837920, .004752530, .004752530, .004752530ETH, surcharges .0049ETH each. Total margin .000504490ETH; smallest individual margin .000062080ETH. This is conditional calibration evidence only. hardening-proposed940k.patch/log/result retain exact inputs; permanent source was restored byte-for-byte. No default or launch pricing is changed by that diagnostic. Early anchored function filters matched zero tests and are recorded separately; they are not successful checks. The method filter `gasJump` ran exactly one test; no claim relies on the mistaken initial cache-only diagnosis.

All production init/runtime artifact object hashes are identical before/after/final. Test changes and parameter-only simulations have not changed the reviewed deployment bytecode or SSH-approved gate. No mainnet broadcast, service cutover, live oracle generation, new full economic campaign or proof of whole-system safety follows from these results.

Things that don't make sense: the current 910k surcharge fails its original at-cap coverage claim; suppressing the failure would hide a pricing decision. The proposed 940k covers four exercised cycles, not every possible inventory/gas/callback workload.
