# Round 8 Lane A estimate-to-inclusion keeper gas race

**One constructed real-dependency race reproduced an internal out-of-gas failure with 30% estimate headroom.** Frozen target `2ac7a7e7b965d1798729068566c026128a4ba4b9`; private Anvil fork of Tenderly mainnet block **26,382,349**. The production `script/Deploy.s.sol:Deploy` path deployed local Factory/Balancer/Packs to that private node with `--unlocked`; every transaction was sent to `127.0.0.1`, never mainnet. Tenderly was a read-only fork upstream. No private keys, protocol state/balance overrides, direct FWA-service-sender callback or production/existing-test edits. The only protocol-identity impersonation was the **actual coordinator** `0xD7f86b4b8Cae7D942340FF628F82735b7a20893a` calling deployed service `0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d`, which the script first verified reported that coordinator. The coordinator had **262,820,627,116,953,620,448 wei** on the pinned fork and its balance was not changed. BAYC creator, player and keeper were asserted code-free; only their external wallets received setup funding.

## Exact command and retained outputs

From repository root in zsh:

```sh
set -o pipefail; node --import tsx audit/round8/lane_a/validation/gas_race/gas_race.ts 2>&1 | tee audit/round8/lane_a/validation/gas_race/attempt4.log; exit ${pipestatus[1]}
```

Final exit **0**. Script SHA-256 `9a8af30de75fb618f01bceef13e7f26e58ae917183cd2014d97b4e2099cf02a7`; final raw output `attempt4.log` SHA-256 `205036e507722e2ec1526dbb96489b360f8f82d184196bbc5ceaef962e9e6a21`. The same command with `attempt3.log` as `tee` target exited **0**, first successful measurement before the call-trace addition; output SHA-256 `77b7d1232d68eeb01745cf4d442c75a9890ecd596bcae9d08147b8cf2dfaee75`. Attempts `attempt1.log` exit **1** (test-only `uint64` decoding comparison used JS `2` instead of bigint `2n`; SHA-256 `ebf74e26cf3aef89c8e3744ffb262c9d1756004ccc9667c104b36a98c2efa922`) and `attempt2.log` exit **1** (candidate VRF words 1–30 all selected the non-Shape path; SHA-256 `e41dc4c21354d0d3808881832188e21872e2e939f1ca3d4865d197c73bade967`) remain diagnostic test-setup failures. Hashed, distributed words found two Shape outcomes; no source under test changed.

The first two attempts used a private Anvil child on port **18768**, chosen before the controller requested its preferred keeper rehearsal port. No existing fork/service was touched. The successful third and fourth attempts used requested free port **18847**. Each script run terminated only its own child and removed only its temporary project symlinks; its build cache/output and raw logs remain. Port inspection after the final run found no listener on either 18768 or 18847.

## Exact receipt comparison

The local pool held real BAYC #1 and **four live 0.01 ETH Shapes** after creator setup. A code-free player funded two real FWA acquisitions, each **17,644,058,900,881,243 wei** (12,964,058,900,881,243 acquisition fee plus 4,680,000,000,000,000 VRF fee) at the script's **2 gwei** purchase bid. The coordinator/service route selected and processed the first Shape; the second request remained pending. This was the keeper's **prestate**. The script used `eth_estimateGas` for `performUpkeep` from code-free keeper `0xBEEF`, at the same **2 gwei gasPrice**, zero call value and same Balancer address as the eventual upkeep transaction. It also executed one prestate keeper transaction on a snapshot and retained its real local receipt before restoring the snapshot.

| State and transaction | Gas | Result |
| --- | ---: | --- |
| Prestate `eth_estimateGas`, one settled Shape draw plus one pending request | **674,255** | Estimate returned successfully. |
| Prestate keeper receipt, same state before second fulfillment | **608,013 billed** | One-draw reconcile/restock succeeded; snapshot then restored. |
| Inclusion-block keeper receipt after second coordinator fulfillment and FWA processing | **1,210,524 billed** | Reconciled/restocked both Shape draws and restored five active listings (four Shapes plus curated NFT). This is **536,269 gas / 79.54% above the estimate**, and **602,511 / 99.10% above the one-draw baseline receipt**. |
| Replayed inclusion with `estimated × 1.3` gas limit | **876,531 limit; 850,071 billed** | Keeper receipt **reverted**. Anvil `debug_traceTransaction` callTracer reported `out of gas` in nested path `upkeep/0/12/0`, propagating `execution reverted` outward. A forwarded subcall exhausted gas before the outer transaction used its entire limit. |

The inclusion block was **26,382,362** in the local fork; callback, FWA `processAcquisitions(5)` and keeper upkeep had transaction indexes **0, 1, 2** in that **same block**. The second service callback went coordinator→real VRF service→real FWA pool, with no router accounting bypass. The script used snapshots to compare the unlimited and 30%-limit executions from the same pre-inclusion state. The prestate and inclusion basefee were both forced to the same local value **13,744,712 wei** in the final run, avoiding basefee as the cause of the gas jump. Callback/process gas prices were 3 and 2.5 gwei to order them before the 2 gwei keeper transaction; only the keeper's estimate versus inclusion used the same sender, gas price, calldata/value and Balancer address. Transaction hashes and selected request/word IDs are in the raw JSON output. No player or creator controls the real coordinator's words; the test chooses reachable outcomes to probe this race.

**Bound:** this demonstrates a plausible estimate-to-inclusion failure mechanism in one constructed two-Shape mixed reconcile/restock state. The earlier integration's 24 sampled five-Shape opening upkeeps all billed about 75.6–75.8k below their estimates and remain valid for that different state. This test does **not** establish that this race caused the historic **3/340** keeper out-of-gas failures, their frequency, or the correct production headroom rule. It also does not measure private-relay transaction ordering or mainnet block production; it proves the ordering and receipts on a local fork.

## Time

This focused stage ran approximately **17:34–17:50 UTC on 2026-11-12**, about **16 active minutes**, below the requested 50-minute stage cap. Previous Lane A active time was approximately **95 ±6 minutes**; cumulative active time through this gas-race record is approximately **111 ±7 minutes**, still below the original three auditor-hour lane ceiling. The separately requested B E5 evidence challenge will be recorded after this stage.
