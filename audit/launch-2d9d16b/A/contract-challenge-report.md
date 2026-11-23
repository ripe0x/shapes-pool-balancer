# Informed contract challenge: accepted mint fee reserve

- Candidate: `2d9d16bf289817eff1831263e48c8b5412a3855f` (previous `28b53ad`), detached `/private/tmp/fwa-launch-2d9d16b-A`.
- Window: 2026-11-22 23:16–23:20 UTC, about four minutes. This was a focused fresh-context contribution to launch audit A, not the full audit.
- Scope: R80 with R62/R63 credit and paid keeper work, plus R78 admission at the fee cap. Mainnet fork block `26382349`, real FWA pool/factory, Shapes, Packs and VRF service. Only the Shapes admin fee setter and VRF coordinator were impersonated. `block.basefee=0.5 gwei` and `tx.gasprice=1 gwei` were set and asserted in the executed path. No protocol mock or storage/balance overwrite was used; externally funded actors are setup.

## Attack and result

The candidate pools 20 real 0.01 ETH Shapes. Seven purchases deliver seven Shapes with 0.01 ETH backing each through the real FWA and VRF path. After six wins, the Shapes admin raises the fee from 0.001 ETH to its 0.01 ETH hard maximum. Paid upkeep reconciles but does not mint. The creator collects proceeds and withdraws the full 2.7789558649 ETH available, leaving exactly the 0.0734 ETH accepted-fee reserve. A seventh win while the fee remains high creates 0.0005278 ETH of new protected creator credit; another paid reconciliation leaves it booked. The Shapes fee returns to 0.001 ETH, and paid upkeep restores all 20 prizes. The post-restock Balancer balance is 0.00723997145 ETH, including the fully claimable 0.0005278 ETH credit. Sales admit again. No harmful outcome was observed in this sequence. The ETH impact of a demonstrated defect is **0 ETH**; this is a bounded successful challenge, not a safety claim.

The first test version assumed a creator could claim operating surplus while keeping existing credit booked. It failed because `claimSurplus` consumes credit first. That is its current accounting rule, not a proof of lost credit; the corrected sequence obtained new credit after the exact-reserve withdrawal and passed. The initial failed result is superseded by the final source and log.

Source: `contract-challenge-cap-recovery.t.sol`. Full final output: `contract-challenge-cap-recovery.log`. For reproduction, create a temporary symlink from `test/audit/contract-challenge-cap-recovery.t.sol` to `../../audit/launch-2d9d16b-A/contract-challenge-cap-recovery.t.sol`, then run:

```sh
forge test --match-path test/audit/contract-challenge-cap-recovery.t.sol --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv
```

Final command exit **0**, one test passed. The copied submodule contents in this detached worktree trigger nonfatal Foundry clone warnings; compilation and test execution completed. The temporary symlink was removed. `git diff --exit-code 2d9d16b -- src test` exited 0. No tracked files were edited.

## Limitations and things that don't make sense

- This is a 20-prize, seven-draw boundary test at 1 gwei, not a launch-scale economic run or a proof for every denomination, policy or gas regime. A no-finding result has no minimal fix.
- `claimSurplus` consumes booked credit before operating surplus even when the requested amount is smaller than the operating surplus. This is consistent with the code's accounting, but the interface does not expose a way to choose the source of a partial claim. It did not lose funds in this test.
