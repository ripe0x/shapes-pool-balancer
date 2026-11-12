# Round 8 neutral discovery packet (prepared, not issued)

## Frozen target and access

- Repository: `/Users/dd/CascadeProjects/fwa-pool-balancer`, branch `fork-tests`, commit `2ac7a7e7b965d1798729068566c026128a4ba4b9`. The tracked tree and submodules were clean at intake. `freeze.json` hashes 809 tracked files.
- Primary contracts: `src/PoolBalancer.sol`, `src/BalancerFactory.sol`, `src/PoolPage.sol`, `src/interfaces/External.sol`, `script/Deploy.s.sol`.
- Draw Packs and Shapes dependencies are in scope for pack minting, custody, listing and redemption: `lib/shape-packs` and `src/vendor/PacksBuild.sol`.
- Mainnet integrations: FWA factory `0x8919814D825a5Af238cC04DE06b1C18c9eaA477C`, implementation `0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7` (expected codehash `0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02`), FWA VRF service and fee router, Shapes `0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0`, ENS `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e`.
- Secondary integration surfaces: `keeper/keeper.ts`, `shared/planner.ts`, `shared/design.ts`, `app/src/App.tsx`, `app/src/tx.ts`.
- Build: Solidity 0.8.28, Cancun, via IR, optimizer 50 runs; Draw Packs 20 runs. Forks: mainnet block 26,382,349 and one recent block, using only `https://mainnet.gateway.tenderly.co`. The Balancer is undeployed, so deployed source-to-runtime correspondence is not applicable.
- Discovery may read `src/`, `script/`, `lib/`, `foundry.toml`, `docs/SPEC.md`, `README.md` and public on-chain integration state. No discovery access to `audit/`, `test/`, other `docs/` files, `sim/`, Git history, PR text, memory, other sessions or another lane's output.

## Owner's rights and money goals

The creator funds the pool, lists NFTs, chooses the mix and markup, can perform their own upkeep, withdraws free capital, and after close and unlist withdraws everything. Players pay FWA, win one listed prize, and receive exactly the embedded ETH on Shape or pack redemption; FWA defines refunds. Keepers are permissionless by default and receive measured gas × min(bid, basefee + 0.05 gwei, 5 gwei) + 0.0005 ETH, subject to keeper credit. Creator-started work is paid in full. Factory keeper admin may restrict upkeep globally to approved keepers or reopen it, with no other power. FWA and Shapes are trusted external systems with admin powers, including pause and a Shapes mint fee up to 0.01 ETH.

- **M1:** Creator markup is never spent on non-creator keeper work; those rewards come from restocking fees.
- **M2:** Shape price is backing + one mint fee and one restocking fee per contained Shape + backing × markup. `restockFee()` is 900k gas × min(basefee + 0.05 gwei, 5 gwei) + 0.0002 ETH at listing. The pool fronts it, the winner repays it, and unused fees remain the creator's.
- **M3:** Mint fees reach Shapes at mint; winning players repay them in price.
- **M4:** Prize backing remains in prize tokens and returns at exact value on unlist or refunded-prize recovery.
- **M5:** Creator loss is bounded by fees fronted for never-won prizes, opening stock-up gas, and prize luck, with no keeper pay beyond fees.
- **M6:** Open-pool reserve covers target restoration, the largest prize per unrecorded draw plus one spare, and keeper rewards at the 5 gwei cap.
- **M7:** After close, unlist and withdraw, no ETH or prize is stranded or owed to anyone other than the creator.
- **M8:** Purchases pause before odds materially drift: the gate is 70% of target weight, charging each unrecorded draw as the heaviest prize.

Product objective: operate through ordinary mainnet gas up to 5 gwei, with positive expected creator profit at an acceptable player draw price. Challenge the requirements as well as the code; destination of value matters.

## Methods and budget

The total approved cap is 12 auditor-hours, including PoCs, forks, fuzzing, challenge and reporting. Suggested ceilings are 3 h for each blind discovery lane, 2 h for integration assessment and 4 h for controller work. Seal lane inventories before informed comparison. Record actual time. No human review is planned.

Cover all external/public functions and getters, nested external calls and callbacks, all privileged and permissionless paths, hostile NFT collections, buyers and receivers, reentrancy and creator transfer. Trace assets and authority through FWA listing, withdrawal, redemption, delivery and refunds. Test the two-step factory handover, compromised admin, factory identity at initialization, outside clones and locked implementation.

Challenge lifetime keeper pay versus listed-prize restocking fees using real receipts: overbidding, inflated gas limits, refunds, split batches, basefee spikes, creator work toggles, self-dealing draws, failed delivery/refunds and griefing. State attacker cost. Measure billed gas × effective gas price.

For M1–M8, test destination invariants at rest after every step, full open/draw/restock/close/unlist/withdraw cycles, and round trips for mint, restocking, FWA, VRF and keeper fees. Include one, five and burst draws in flight; list ratchets. Use launch-scale Balanced, bigger-prize and cheap-Shape mixes, gas at 0.05, 0.1, 1, 3, 4.9 and above 5 gwei, slow rise, jump and ending spike, mint fee 0.005 and 0.01 ETH, stopped demand, late keeper, maximum allowed withdrawal each step and retirement. Report creator net/spread/loss share, player price/return, liveness, NFT odds, idle/fronted capital and stranded assets. Check simulation formulas against contracts and a matching fork run.

Test quote-to-inclusion drift for gas and block-dependent values, gas-price-zero simulations, keeper/restock and draw races, price caps, inventory versions and slippage/refunds. Assess keeper gas headroom, state growth, restricted pools, RPC errors, restarts, replacements and reorgs; planner parity; dashboard gas estimation, batch calls, deposits and event replay.

No mocks, `vm.mockCall`, `vm.etch`, `vm.store` on protocol contracts, or stub FWA/Shapes/Packs/VRF. Only coordinator-delivered VRF words are permitted as an exception. Funded external actors are setup. Unreachable real behavior is an untested gap. Run test files singly using `forge test --match-path <file>`, with PoCs under `audit/round8/` and their own `FOUNDRY_TEST` path. No whole-suite run without `CANDIDATE_RUN=1`, no cache deletion or `forge clean`. Run Slither with `--ignore-compile` after a real build. No mainnet broadcast, real spending, secrets, deployment, publication, production-code edits or existing-test edits.
