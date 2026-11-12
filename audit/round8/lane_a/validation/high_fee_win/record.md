# Round 8 Lane A higher-mint-fee winner validation

Frozen target `2ac7a7e7b965d1798729068566c026128a4ba4b9`; real Tenderly mainnet fork at block **26,382,349**, local Balancer/Factory/Packs with deployed FWA, Shapes and VRF service. The live Shapes admin at this pin is EIP-7702 delegated external account `0xCB43078C32423F5348Cab5885911C3B5faE217F9`, asserted by exact designator code; `vm.prank(ADMIN)` represents its authorized role action on the local fork. The only protocol identity used for random-word delivery is **actual coordinator** `0xD7f86b4b8Cae7D942340FF628F82735b7a20893a` calling deployed service `0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d`, then real FWA processing. Player `0xB0B` and keeper `0xBEEF` are asserted code-free. No protocol mock, balance/state fake, direct service-sender shortcut, private key or mainnet broadcast.

## One selected-file run

From repository root, zsh:

```sh
set -o pipefail; FOUNDRY_TEST=audit/round8/lane_a/validation/high_fee_win FOUNDRY_OUT=audit/round8/lane_a/validation/high_fee_win/out FOUNDRY_CACHE_PATH=audit/round8/lane_a/validation/high_fee_win/cache forge test --match-path audit/round8/lane_a/validation/high_fee_win/HighFeeWinner.t.sol --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv 2>&1 | tee audit/round8/lane_a/validation/high_fee_win/attempt1.log; exit ${pipestatus[1]}
```

Exit **0**: **2 passed, 0 failed, 0 skipped**. Test source SHA-256 `bc458884267565b61ad37760c00a9c6facbaa08aadaecea06ea5a1d8b240dac7`; raw output `attempt1.log` SHA-256 `ec2acd155b35a87e31516d050bf1cbd1a607504451cd2931081b77dbbc104193`. Solc 0.8.28 compiled with repository via-IR/optimizer-50/Cancun settings. No other test file was selected, and no prior sealed source or production file was edited.

## Exact selected-outcome ledger

Each test starts from its own pinned fork state: one creator-owned curated ERC721 listed at 0.1 ETH, a target of one 0.01 ETH Shape, and a 1 ETH creator deposit. Shapes admin raises the mint fee from 0.001 ETH to the case value; creator explicitly reconfigures to accept it, opens, and a keeper mints/lists one real Shape. A funded code-free player calls real FWA `acquire` with inventory version computed before its prank. Candidate coordinator words select that Shape (2 trials at 0.005 fee; 1 at 0.01). FWA acquisition becomes **2 fulfilled**, listing **4 delivered**, and Shapes `ownerOf` becomes the player. Balancer directly collects exact FWA owner proceeds. Shapes fee accrual is separately asserted in both `pendingFees()` and `feesOwedTo(configured recipient)`. Permissionless `withdrawFees` transfers the configured recipient's entire owed balance to its actual contract. The player then redeems the delivered Shape, receives exactly **0.01 ETH** backing, and Shapes redeemable backing returns to its pre-mint level.

| Wei, except fee label | 0.005 ETH mint fee | 0.01 ETH mint fee |
| --- | ---: | ---: |
| Shape FWA listing price (backing + mint fee + 0.001145 ETH restock fee) | **16,145,000,000,000,000** | **21,145,000,000,000,000** |
| Player acquisition fee | **29,191,527,831,589,822** | **36,654,009,657,848,032** |
| Player VRF fee | **2,457,000,000,000,000** | **2,457,000,000,000,000** |
| Player total paid to FWA | **31,648,527,831,589,822** | **39,111,009,657,848,032** |
| FWA owner proceeds collected by Balancer | **27,801,455,077,704,593** | **34,908,580,626,521,936** |
| New Shapes fee owed to configured recipient | **5,000,000,000,000,000** | **10,000,000,000,000,000** |
| Configured recipient payout including 0.304 ETH previously owed at pin | **309,000,000,000,000,000** | **314,000,000,000,000,000** |
| Winner backing redeemed from Shapes | **10,000,000,000,000,000** | **10,000,000,000,000,000** |

For these two selected Shape wins, player payment and Balancer owner proceeds each exceed the Shape's backing-plus-mint-fee creation cost (0.015 and 0.02 ETH). The fee itself did **not** return on redemption: it accrued to Shapes' configured recipient, while backing stayed with the token until the winner redeemed. FWA's acquisition quote is for the **whole curated-plus-Shape pool**, so these amounts do not prove that every mix, draw sequence or high-fee configuration recovers fees or yields creator profit. Keeper reward, FWA edge, luck and subsequent restocking/closeout were not assembled into a lifetime profit calculation here. The candidate word search shows reachable coordinator outcomes, not player/creator control of live VRF randomness.

Work ran approximately **17:52–17:55 UTC on 2026-11-12**, about **3 active minutes**, below the requested 30-minute high-fee stage cap and the controller's 18:15 stop time. Previous cumulative Lane A active time was approximately **113 ±7 minutes**; final cumulative active time through this validation is approximately **116 ±7 minutes**, below the original three-hour lane ceiling. No further lane exploration is planned.
