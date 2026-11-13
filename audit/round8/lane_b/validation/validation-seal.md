# Lane B post-seal validation, frozen target

Target revision `2ac7a7e7b965d1798729068566c026128a4ba4b9`, mainnet fork block `26382349`, Solidity 0.8.28 via IR, optimizer 50, Cancun. This stage owns only `audit/round8/lane_b/validation/`; blind and informed seals remain unchanged. All mainnet fork sourcing used `https://mainnet.gateway.tenderly.co`. Local Anvil writes were on chain ID 31337 and snapshot-restored; no live transaction was broadcast. External actor wallets were funded; no protocol balance or storage was faked. The only protocol identity used for word delivery was the actual coordinator calling the real FWA VRF service.

## Main outcomes

1. **E-B1 with the real router path.** A fresh Balanced pool withdrew its maximum free capital, then two code-free-player FWA purchases drew 0.5 and 0.1 ETH Shapes via actual coordinator → service → pool delivery. Upkeep restored the 0.1 target but left the 0.5 target empty; Balancer held `0.474750884357087310` ETH against `1.035` ETH required reserve, and admission status was `0`. A third real FWA purchase succeeded. Word search took 1144 and 206 candidate deliveries. This demonstrates reachable VRF outcomes and subsequent purchase liveness, not attacker control of VRF words. `BalancedRouter.t.sol` SHA-256 `8e25e140c26680ee6ae71ec49674a0f9e6439e9b0fad1e12be8eb5e5b0c9f75f`; passing log `balanced-router-escalated.log` SHA-256 `5f27d09ad7af1b337256134805dcbd8a6d7b14b4053ab8f34c7ca6853ed6bf49`.
2. **Fresh five-draw boundary.** The real FWA factory reports `maxAcquisitionsPerTx = 5`. A fresh pinned fork accepted one code-free-payer batch of five, all five coordinator → service deliveries reached acquisition status `2`, unsettled count returned to zero, and upkeep reconciled sequence `5`. The retained Anvil pool accepted counts 1–4 but count 5 reverted `InsufficientVrfCoverage()` at base fees 0.05, 1, 3 and 4.9 gwei. It had prior direct-pool callback tests, so this is a state-specific coverage observation, not a global four-draw cap; the exact router accounting cause was not established. `RouterFive.t.sol` SHA-256 `3269dc62df2a02e99dadc253e0faac67d56c35a5f8d2d9b4618a5474198023aa`; passing log `router-five-retry.log` SHA-256 `6a8ded5f68dd800e67a79a378c4ed1872de969878865135dd50dadcf7b6ffd8c`.
3. **Mined keeper P&L through actual router.** A four-draw retained-fork reconciliation paid `0.0027722693` ETH at an honest 1.05 gwei bid, billed `2,108,146` gas (`0.0022135533` ETH), and raised the code-free keeper wallet by exactly `0.000558716` ETH. The same snapshot with a 5.05 gwei bid paid `0.0027722399` ETH but billed `0.0106459959` ETH, losing exactly `0.007873756` ETH. The measured gas values `2,164,066` and `2,164,038` exceeded billed gas by `55,920`, consistent with refunds. A **fresh clean-fork five-draw** receipt paid `0.0032406974` ETH, billed `2,539,868 × 1.05 gwei = 0.0026668614` ETH, and gained `0.000573836` ETH; measured gas `2,610,188` exceeded billed by `70,320`. Overbidding at 5.05 gwei on the same state paid `0.00324067955` ETH, billed `0.01282624755` ETH, and lost `0.009585568` ETH. All wallet deltas equal reward minus billed cost. Outputs `batch4-router-receipt-approved.json` and `fresh-five-receipt-deploy.json`, SHA-256 `a2b34e3f06df61440d78a5b8b066bc35888ed692179fc668b9b7f27ade7c050c` and `d6a9936062ce4e9870aa9a07213e0a142c6afb3456250c6b3f21365273b1ecbc`.
4. **Credit ratchet through actual router.** An outside keeper listed a replacement Shape at 4.9 gwei after a real draw, leaving `0.0002163048` ETH keeper credit. A second unrelated draw occurred; the creator closed and unlisted the fee-bearing replacement without it winning. Credit stayed `0.0002163048` ETH. An outside keeper then did reconciliation-only work at 1.05 gwei and received that credit, billed `0.0001341333` ETH, netting `0.0000821715` ETH in a code-free wallet. This is real useful work and not automatically theft; it qualifies a literal claim that every unused listing fee remains with the creator. `credit-ratchet-router.json` SHA-256 `702cf31546e1052b1a2db8ed05d1baee468bc95d91a27a8db563bb26de4bff27`.
5. **Matched split versus batch incentive.** Both branches began at credit `0`, FWA sequence `1`, active listings `41`, base fee 1 gwei/effective 1.05 gwei, and selected four 0.01 ETH Shapes through real service deliveries. The one-batch player quote was `0.099909357149883348` ETH; four single-purchase quotes summed to `0.099909357149883340` ETH, **8 wei less** because of rounding. One batch upkeep billed `2,083,631` gas, paid `0.00274358855` ETH, netted `0.000555776` ETH, and left `0.00183641145` ETH credit. Four separate useful upkeeps billed `3,143,215` gas total, paid `0.00458` ETH, netted `0.00127962425` ETH, and left zero credit. Splitting increased keeper net by `0.00072384825` ETH and consumed the batch's remaining `0.00183641145` ETH credit, while doing four calls instead of one. It did not breach the lifetime fee-credit bound. Word search forced matching attainable prize classes for comparison; it does not imply keeper control over VRF. The first unscreened branch comparison had different prize classes and is retained only as diagnostic. `split-upkeep-cheap.json` SHA-256 `eab763d6b6b284cea2116a3b0f050ddb737d3c861f662e6c31c6552840cc4f52`.
6. **Listing-to-restock gas jump.** On a fresh official-factory pool, a 0.01 ETH Shape listed at base fee 0.05 gwei had restock fee `0.00029` ETH and listed price `0.01279` ETH. It was drawn at 4.9 gwei through actual coordinator → service; replacement fee repriced to `0.004655` ETH and listed price `0.017155` ETH. Keeper receipt billed `793,203 × 4.95 gwei = 0.00392635485` ETH, measured `803,123`, rewarded `0.00447545885`, and code-free wallet gained exactly `0.000549104` ETH. Old listing fee did not cap the new replacement listing price. `gas-jump-router.json` SHA-256 `df486ec6a2cf9ab957bd15852ebc80d3647005c3f51fd2f5d0dad5169cb42ecb`.
7. **Full strict-route lifecycle.** A code-free EOA paid `0.024977339287470837` ETH for one FWA draw. Actual coordinator → service fulfillment delivered a 0.01 ETH Shape; Balancer restocked, then the creator closed, unlisted all active Shapes, recovered exactly `1.54` ETH of their backing, withdrew BAYC #1, retired, and claimed `3.933103955478543655` ETH leaving Balancer balance/reserve zero. The winner redeemed the exact `0.01` ETH backing. This is a Foundry ETH-flow check, not billed-wallet gas P&L. `RouterFullCycle.t.sol` SHA-256 `81a2c3d872534ff3a8f5a340eeb94585d2b39475512f6ff923d00196aad54b32`; log `router-full-cycle.log` SHA-256 `a04c5232210ac44a85d14848f2a50e23e3ab3d73474ad627ad4d58b5b26d4aea`.
8. **Independent Lane A S5 review.** Accepted within the domain of a creator-listed malicious ERC721 implementation. Actual coordinator delivery, pre-read inventory versions, code-free payer pranks, FWA statuses/refund rejection and one/two-sale creator ETH arithmetic were checked against the test source/log. `lane-a-s5-review.md` SHA-256 `62ef085ce0c4222effbf6786c7387ebdd42c1082b07788613f40164521b2b228`; reviewed Lane A source/log SHA-256 `1928274b1df76185256006cdb9296066c492ac28d9a3f54e3bb39d8fc6f2061a` / `211c255786d56be72cf13eac0ca7f23fdf9505f25e46ef12dd22a04b4ce2629d`.

## Exact commands and status

All commands ran from repository root. Every Forge command used only one selected test file. Node scripts targeted a local Anvil fork and restored their outer snapshot.

```sh
FOUNDRY_TEST=audit/round8/lane_b/validation FOUNDRY_OUT=audit/round8/lane_b/validation/out FOUNDRY_CACHE_PATH=audit/round8/lane_b/validation/cache forge test --match-path audit/round8/lane_b/validation/BalancedRouter.t.sol --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv
# first run exit 1: sandbox DNS, balanced-router.log; approved retry exit 0: balanced-router-escalated.log

FOUNDRY_TEST=audit/round8/lane_b/validation FOUNDRY_OUT=audit/round8/lane_b/validation/out FOUNDRY_CACHE_PATH=audit/round8/lane_b/validation/cache forge test --match-path audit/round8/lane_b/validation/RouterFive.t.sol --match-test testFreshFiveRouterRequestsAndDeliveries --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv
# initial compile error querying pool instead of factory, router-five.log exit 1; corrected retry router-five-retry.log exit 0

FOUNDRY_TEST=audit/round8/lane_b/validation FOUNDRY_OUT=audit/round8/lane_b/validation/out FOUNDRY_CACHE_PATH=audit/round8/lane_b/validation/cache forge test --match-path audit/round8/lane_b/validation/RouterFullCycle.t.sol --match-test testRealRouterWinRestockCloseUnlistWithdrawRedeem --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv
# router-full-cycle.log exit 0

node audit/round8/lane_b/validation/coverage-boundary.mjs
node audit/round8/lane_b/validation/coverage-boundary.mjs 0.05
node audit/round8/lane_b/validation/coverage-boundary.mjs 3
node audit/round8/lane_b/validation/coverage-boundary.mjs 4.9
# coverage-boundary.json, coverage-0.05.json, coverage-3.json, coverage-4.9.json; each exit 0, .exit files retained

node audit/round8/lane_b/validation/router-state-diff.mjs
# router-state-diff.json and router-state-summary.json, exit 0; purchase wrote router storage whereas direct pool callback did not

node audit/round8/lane_b/validation/batch4-receipt.mjs
node audit/round8/lane_b/validation/gas-jump.mjs
# direct-pool-callback diagnostics only; batch4-receipt.json and gas-jump.json, each exit 0

node audit/round8/lane_b/validation/batch4-router-receipt.mjs
# first sandbox localhost EPERM exit 1; approved retry batch4-router-receipt-approved.json exit 0
node audit/round8/lane_b/validation/credit-ratchet-router.mjs
# credit-ratchet-router.json exit 0

anvil --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 --chain-id 31337 --port 18548 --silent
# new clean fork started; PID 82973, still running at seal
LANE_B_RPC=http://127.0.0.1:18548 node audit/round8/lane_b/validation/fresh-five-receipt.mjs
# first attempt on port 18547 reverted InsufficientVrfCoverage, fresh-five-receipt.err exit 1; next attempt on 18548 lacked local Balancer factory, fresh-five-receipt-clean.err exit 1; corrected deployment retry fresh-five-receipt-deploy.json exit 0

node audit/round8/lane_b/validation/split-upkeep.mjs
# initial unmatched prize-class comparison split-upkeep.json exit 0; corrected same cheap-Shape-class comparison split-upkeep-cheap.json exit 0
node audit/round8/lane_b/validation/gas-jump-router.mjs
# gas-jump-router.json exit 0
```

Older Anvil fork launch was `anvil --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 --chain-id 31337 --port 18547 --silent`, PID `46925`, also still running. Both local Anvil services were preserved. The exact script sources, outputs, failed stderr, and status files are hashed in `evidence-sha256.txt`.

Two initial manifest-generation shell attempts also failed because the shell invocation lacked `shasum`/`wc` on `PATH`; neither produced a usable manifest. The final manifest was generated with `/usr/bin/python3` and SHA-256 from the standard library.

## Limits and time

The strict-route tests establish callback and economic paths for selected outcomes. The controlled coordinator word search is a reachability witness; live VRF word selection, player demand, and keeper competition remain probabilistic. The five-draw receipts include no refund-heavy FWA failure batch. The prior self-dealing attacker-cost receipt and older full-cycle/gas-jump diagnostics used direct service-address → pool callbacks; the strict-route full-cycle and gas-jump tests supersede their path claims, but all-in self-dealing attacker P&L remains untested. A strict-route self-deal would require a separate mined attacker-wallet lifecycle with valuation assumptions and likely more than 15 minutes; it was not attempted in this bounded stage. Mint fee changes to 0.005/0.01 ETH were modeled only in the informed stage; no Shapes-admin impersonation occurred. The simulation remains model evidence, not a contract invariant proof. This validation did not rerun an exhaustive M1–M8 stateful invariant campaign or resolve the policy ambiguity over unused keeper credit.

Validation substantive work from first file creation at about `2026-11-12 16:55:16 UTC` through this seal at about `17:30 UTC` was about **35 minutes**. Prior blind + informed substantive time was **74 minutes 20 seconds**. Cumulative Lane B active time was about **1 hour 49 minutes 20 seconds**, under the three-hour ceiling. No production source, configuration, existing test or sealed evidence file was edited.
