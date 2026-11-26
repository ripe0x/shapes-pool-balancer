# Focused version 2 release evidence

Candidate code commit: `e47fdef` (based on `c887bc7`; contract sources unchanged from `213a6ab`).
Gate source/evidence digest: `58c252dd452c6c54b2b91694ed6c25e52f65eb9face0725d6ba1b88461c0596b`.
Focused outcome/config digest: `5acc93973dcad11c81c9945851f85ddd62ea24a1ebea2f55264e7528331f4d3f`.

**Contract checks and read-only UI acceptance completed. Transactional creator-fee UI acceptance awaits the separately requested local batch approval. Owner signature and all production writes remain outstanding.** This is focused evidence, not a full economic campaign or whole-system audit.

## Execution record

Foundry 1.8.1, solc 0.8.28, optimizer 50, via IR, Cancun. RPC: `https://mainnet.gateway.tenderly.co`; no paid Alchemy use. Tests set and assert nonzero gas/basefee inside calls. Reference roundtrips fork block 26382349, gas 1 gwei/basefee 0.5 gwei. Genuine proof fixtures start at 26442752 and advance to 26442757, asserting historical timestamps and execution gas price 565418379 wei/basefee 548662718 wei at fulfillment. Actual FWA, Shapes, Packs and coordinator execute. Historical proof submissions and persistent counterfactual request accounts do not establish present oracle availability; some cases explicitly process FWA's queue from the harness.

| Check | Result | Command and evidence |
| --- | --- | --- |
| Focused Solidity | 46 unique tests pass, zero remaining failures | Exact initial command/exit 0 in `contracts-result.json`, output `logs/contracts.log`: only 12 executed because seven cached test artifacts were ABI-only. This initial exit was insufficient. |
| Omitted suites | 31 pass, 3 fail; failures repaired | `SOURCE_HASH=... CANDIDATE_RUN=1 forge test --match-contract '^(FocusedERC20CallbacksTest\|FocusedReleaseFlowTest\|FocusedInventoryGasTest\|InventoryBatchesTest\|ERC20RecoveryTest\|FactoryPauseTest\|CreatorFeeReinvestmentTest)$' --threads 1 -vv`, exit 1, `logs/omitted-suites.log`. Targeted `forge build <seven omitted test sources> --no-cache`, exit 0, `logs/missing-artifacts-build.log`, restored executable artifacts without deleting caches. |
| Fixture repair / scorecards | 9 pass, exit 0 | Same command narrowed to `^(FactoryPauseTest\|FocusedReleaseFlowTest)$`, `logs/pause-scorecard-repair.log`. The obsolete manual 400 bps creation setting became zero, as v2 requires. All three scorecards regenerated at the final digest. No runtime economics changed. |
| TypeScript | 73 unique pass, 7 skipped | `npx vitest run app/src/profit.test.ts shared/planner.test.ts app/src/creation.test.ts app/src/creation-replacement.test.ts app/src/ledger.test.ts app/src/transfer.test.ts app/src/tx.test.ts scripts/deployment-preflight.test.ts` (70 pass/7 skip), then `scripts/implementation-deployment.test.ts` (2 pass); after review repair only `app/src/profit.test.ts` rerun (7 pass, formerly 6). All exit 0; logs retained. Initial command also named nonexistent `scripts/verify-deployment.test.ts`; Vitest ran the matching files and exited 0. The separate existing implementation-deployment tests were then run. |
| Typecheck / application build | Both exit 0 | `CANDIDATE_RUN=1 npm run typecheck`, `CANDIDATE_RUN=1 npm run build:app`; logs retained. Log whitespace is normalized only; failures and result content are preserved. Build emits dependency annotation and large-chunk warnings. |
| Artifact guard | Pass | `bash -n scripts/focused-release-check.sh`; its Python precheck against all 13 real contract artifacts passed. Production gate now fails before testing if an executable artifact is missing. The combined shell command was not rerun just to duplicate all passing suites. |
| Runtime sizes | Balancer 24,438 B; Inventory 19,184 B; Factory 5,594 B | Read final compiled deployed bytecode artifacts. Balancer has 138 B EIP-170 headroom; unchanged production source and compiler profile. |
| Production read-only preflight | Pass at 26496902 | `node --import tsx scripts/deployment-preflight.ts --rpc-url https://mainnet.gateway.tenderly.co --block 26496902 --out docs/receipts/focused-v2-release/mainnet-preflight.json`, exit 0. Saved readback, dependency hashes/relationships and legacy scans. Separate current-factory scan found 0 pools. |

The fixture repair and signed-loss UI repair do not alter the previously passing runtime-contract paths. Their affected checks were rerun; the original failure and partial-coverage logs remain intact. Previously valid 24-case stress diagnostics and canonical local deployment receipts are reused, without recasting simulated randomness as genuine proof.

## One-screen economic scorecard

| Flow / regime | Absolute reached result | Destination / reversal |
| --- | --- | --- |
| Inventory roundtrip | 2 NFTs; 1 ETH returned; 0 native loss | Real FWA listing/reprice/withdraw -> creator; all reference native capital returned; zero tracked inventory/proceeds/credit left. |
| ERC20 roundtrip | 1 WETH recovered; separate 1 ETH principal returned | External actor wraps and transfers real WETH -> Balancer -> current creator; no depositor entitlement under R111. Native cash/credit preserved. |
| Creation pause | Admin 0.1 ETH in/out; denied public caller moves 0 ETH | New factory remains paused throughout admin creation/exit; public unpause then creation succeeds in a separate regression. Existing pool exit remains usable while paused. |
| Three genuine mixed draws | Owner receipts 0.066278634547026369 ETH; automatic fee 1067 bps; reserved fees 0.007071930306167713 ETH | Real coordinator proofs deliver 3 NFTs. Collection accrues once. Maintenance cannot spend fees. Fee-claim test returns the exact fee to the creator after reserve funding. |
| Same mixed-draw fee scenario | Operating bankroll loss 0.097190194207004119 ETH; clipped contract profit 0 | Separate from gross creator fees. Signed UI result now exposes a loss once receipts and draws are reconciled. Sender gas is separate from these contract-internal asset amounts. |
| Exact gap / capped / stale top-up | Fees decrease exactly by used amount; capital increases equally; cash movement 0; profit change 0 | Tests reach partial then exact filling, fee-limited residual gap, changed live gap, closed reopening, and retired rejection. Excess fees stay reserved. |
| Three genuine curated sales (separate scenario) | 0.6 ETH receipts; setup costs 0.001578589821236817 ETH; replacement mint fee 0.001 ETH; bankroll profit 0.581701410178763183 ETH | No invented curated acquisition debt. Increasing target blocks withdrawal; removing deficit permits actual fee/profit claim without reducing 5 ETH capital. |
| Mixed-draw wind-down (separate scenario) | Creator receives 4.913643653057350512 ETH; zero cash/active listings/owner proceeds/unsettled requests | Every remaining automatic NFT redeems exact backing; curated NFT ends with creator or genuine winner. Unrecovered capital loss survives closeout; 5 ETH is not promised back. |

Gas payer: each test caller's transaction gas is not debited as signed-transaction wallet gas by Foundry. Nonzero gas/basefee govern actual internal reward/VRF calculations; real-transaction local deployment/stress evidence supplies separate receipt gas. Do not conflate the reference no-draw principal return with the draw scenario's net result.

Ratchets: collected fee credit can increase with receipts but falls on claim/reinvestment; capital rises with actual contributions/reinvestment and falls only with closed principal claims; paid mint/keeper costs and delivered backing are real expenditures; settled sequence counters only rise. These are R118–R121 accounting/ordering choices. Prior operating losses survive closing/reopening; no new owner outcome is introduced here.

## UI and review

Read-only actual React `Overview` preview used static props, with transaction callbacks explicitly disabled (`component-preview.tsx.txt`). Deposit-only showed 0 fees and 0 result; an illustrative .06 cash + .01 backing - .05 protected fees - 1 capital displayed -0.98 ETH; .05 fees/.02 gap showed .02 top-up/.03 left; .01 fees/.02 gap showed .01 cap/0 left; closed reopening showed .011/.039; v1 display remained unchanged. Browser preview tab and temporary app entries were removed. Pure signed-result tests cover negative/positive amounts, donations, reinvestment and pending settlement.

Independent review: `audit/inventory-update-b44e35f/creator-fee-v2-20261125/`. One actionable signed-loss UI finding was repaired and re-reviewed. Review is informed and bounded, not a new full audit or proof of safety.

Transactional UI top-up/withdrawal remains unexecuted in this batch until the requested bounded authorization arrives. Static props, source review, contract tests and scripted stress receipts do not replace this missing interaction evidence. Seven TS opt-in receipt/live tests remain skipped; no claim of a full frontend wallet suite is made.

## Things that don't make sense

- Forge silently accepted a selected test batch while omitting ABI-only cached artifacts. The new fail-closed precheck prevents that omission on this focused gate path.
- A green focused gate alone would not exercise the pending creator UI transaction, authorize mainnet transactions, establish current oracle liveness, or validate the separate full economic campaign.
