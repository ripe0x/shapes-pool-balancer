# Round 8 Lane A live Shapes admin mint-fee validation

Frozen target `2ac7a7e7b965d1798729068566c026128a4ba4b9`; local Balancer/Factory/Packs against deployed Shapes/FWA on Tenderly mainnet fork block **26,382,349**, Solidity 0.8.28 via IR, optimizer 50, Cancun. Only this new `mint_fee/` directory was edited. No protocol contract was pranked, dealt ETH, etched, or storage-overridden; no broadcast or secret was used. The Shapes admin is an **EIP-7702 delegated external account** at this block, not ordinary empty-code EOA and not a protocol contract. Fork `vm.prank(ADMIN)` represents a transaction sent directly by that account to Shapes, where `msg.sender` is the configured admin. This proves role-path behavior on the fork, not that an auditor controls the real admin or that the admin will choose these fees.

## Read-only role inspection

Command from repository root (exit **0**; raw output `admin-inspection.log`, SHA-256 `98ba3ab8479a87ffa5b1fcd38253f6c152cbe564ac211e2fd06e0d57f6e53b18`):

```sh
mkdir -p audit/round8/lane_a/validation/mint_fee; { cast call 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0 'admin()(address)' --rpc-url https://mainnet.gateway.tenderly.co --block 26382349; cast call 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0 'feeRecipient()(address)' --rpc-url https://mainnet.gateway.tenderly.co --block 26382349; cast call 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0 'mintFee()(uint256)' --rpc-url https://mainnet.gateway.tenderly.co --block 26382349; } 2>&1 | tee audit/round8/lane_a/validation/mint_fee/admin-inspection.log
```

Shapes `admin()` = **`0xCB43078C32423F5348Cab5885911C3B5faE217F9`**; `feeRecipient()` = **`0xD4ba7cA95f3983514DDa317C4428CDb8F59c7e72`**; initial `mintFee()` = **0.001 ETH**. `cast code 0xCB43078C32423F5348Cab5885911C3B5faE217F9 --rpc-url https://mainnet.gateway.tenderly.co --block 26382349` exited **0** and returned EIP-7702 designator `0xef0100612373d7003d694220f7800eeaf8e3924c0951d3` (`admin-code.log`, SHA-256 `59ec3a34defc54dc82bd50363a1d7c730a92e105134358594d2365ec512896ce`). The same code command for the fee recipient exited **0** and returned nonempty contract code (`recipient-code.log`, SHA-256 `8d0ef02aee05dd3b70529cc4a9ce9c315ba2ef052d5564bee4c000ee41c2fa09`). The test asserts the exact admin designator and addresses before any role action.

## Selected real-fork test

Final command from repository root in zsh:

```sh
set -o pipefail; FOUNDRY_TEST=audit/round8/lane_a/validation/mint_fee FOUNDRY_OUT=audit/round8/lane_a/validation/mint_fee/out FOUNDRY_CACHE_PATH=audit/round8/lane_a/validation/mint_fee/cache forge test --match-path audit/round8/lane_a/validation/mint_fee/MintFeeFork.t.sol --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv 2>&1 | tee audit/round8/lane_a/validation/mint_fee/attempt2.log; exit ${pipestatus[1]}
```

Exit **0**, **1 passed, 0 failed**. Test source `MintFeeFork.t.sol` SHA-256 `e79b3c096c11c1c229585f07aeccd953219592f9e238b5111612e2febba136bc`; final raw output `attempt2.log` SHA-256 `eb5bc8b15de2f0b183b62148984d08e5c058505012e061783a186c78511984e8`. The prior same selected-file command with `attempt1.log` as `tee` target exited **1** on a test-only `console2.log` overload ambiguity during compilation; retained raw output SHA-256 `b861ee206f03eb0750fc873dc22aa8df674a8acf0439eef0e70c1bae0858484e`. Casting three log constants to `uint256` fixed that compiler error without changing any assertion or production source.

## Admission, liveness and ETH destination

1. A 2 ETH-funded creator lists one curated ERC721 and opens a one-Shape target. Actual keeper upkeep mints/lists a 0.01 ETH Shape at live **0.001 ETH** mint fee. Admission becomes 0; Shapes pending fees rise by exactly 0.001 ETH and redeemable backing by exactly 0.01 ETH.
2. The real delegated admin sets mint fee to **0.005 ETH** on the fork. Balancer still records creator cap 0.001 ETH, `admissionStatus()` becomes **5 MINT_FEE_ROSE**, ordinary `canPurchase` returns false, and `requiredReserve()` increases. With no other work, keeper `performUpkeep` reverts exact `NoUpkeepNeeded()` selector. Creator `configure(0,2)` accepts 0.005 ETH and requests one more Shape; admission is 2 while creator work is pending. Keeper upkeep mints/lists it; admission returns 0, cumulative new Shapes fees become 0.006 ETH, new backing 0.02 ETH.
3. Creator increases target to three at accepted cap 0.005 ETH, leaving one missing Shape. Admin raises live fee to **0.01 ETH**. Balancer cap stays 0.005 ETH; admission reports **2 SETTING_UP** because creator-work check precedes mint-fee check. Keeper upkeep again reverts exact `NoUpkeepNeeded()` and does not clear `creatorWork`. Creator reconfigures the same target to accept 0.01 ETH; keeper then mints/lists the third Shape and admission returns 0. This proves temporary fee-rise liveness block and creator-controlled recovery for these two fees. The higher fee itself did not let a keeper bypass creator acceptance.
4. Across the three real mints, Shapes `pendingFees()` and `feesOwedTo(configured recipient)` rise by exactly **0.016 ETH**: 0.001 + 0.005 + 0.01. Shapes redeemable backing rises by **0.03 ETH** separately. Creator closes and unlists the three Shapes; exactly **0.03 ETH** backing returns to Balancer while the **0.016 ETH** incremental fees remain owed in Shapes. Permissionless `withdrawFees(configured recipient)` pays the recipient contract exactly **0.320 ETH**, consisting of **0.304 ETH** already owed at the pinned block plus this test's **0.016 ETH**, then clears its owed balance; the test asserts the resulting global pending-fee arithmetic. Creator claims remaining **1.98004557145 ETH** liquid from Balancer, leaving Balancer at zero. No player draw occurred, so repayment of these higher fees by a winner remains untested; the observed fees are creator-fronted and persist after unlisting.

This is one plan with three 0.01 ETH Shapes at 1 gwei basefee/1.05 gwei tx gas price and one pinned EIP-7702 admin role state. It does not establish profitability, a keeper willing to perform work at later gas prices, every fee-recipient fallback, all mixed Pack denominations, or immutable future admin identity. No FWA/Shapes VRF callback was needed.

## Historical method correction and time

Previously sealed `informed/GhostContinuation.t.sol:119` and `informed/HostileCurated.t.sol:216` contain comments describing direct `vm.prank(FWA_VRF_SERVICE)`→pool callback as an allowed coordinator-word delivery. **That description is obsolete:** under the strict method, direct service-sender callbacks are diagnostic only. Those source files, their cited hashes and raw logs remain unchanged at controller direction; later `validation/ghost_router/` and `validation/` tests supply accepted actual coordinator→service→pool continuations. The `security_followup` post-settlement repricing continuation is likewise diagnostic under this distinction; its pre-callback unsettled-draw rollback is still a real funded fork path.

This stage ran approximately **17:27–17:33 UTC**, about **six minutes**. The previous `final-time.md` estimated 88 ±5 active auditor minutes through per-ID triage; cumulative Lane A active time is now approximately **94 ±6 minutes**. Even the first-artifact-to-stage-end wall span is under the original three-hour lane ceiling. No prior seal was modified.
