# Audit prompt: Shapes Pool Balancer, round 9 (full security and economic audit)

Run a full adversarial audit of the Shapes Pool Balancer under `$adversarial-audit`. Follow the audit standard
(`/Users/dd/.agents/guidance/adversarial-security-audit-standard.md`) and its workflow
(`/Users/dd/.agents/skills/adversarial-audit/SKILL.md`: runbook, acceptance checkpoint, report contract). This prompt
adds the target, the owner's requirements, the required methods and one informed pass for round 8's findings and for
misses seen on ApeBall.
Where this prompt and the standard differ, the stricter rule applies.

## 1. Target and freeze

- Repository `/Users/dd/CascadeProjects/fwa-pool-balancer`, branch `fork-tests`. Freeze at intake: record the commit
  (the owner's latest; `9fd5f83` or later), a clean tracked tree, and SHA-256 of every in-scope file.
- **Primary contracts:** `src/PoolBalancer.sol`, `src/BalancerFactory.sol`, `src/PoolPage.sol`,
  `src/interfaces/External.sol`, `script/Deploy.s.sol`.
- **Draw Packs:** `lib/shape-packs` and `src/vendor/PacksBuild.sol`. They are in scope where the Balancer depends on
  them: minting packs, holding and listing them, and redeeming them.
- **Integrations, pinned on chain:**
  - FWA pool factory `0x8919814D825a5Af238cC04DE06b1C18c9eaA477C`;
  - FWA pool implementation `0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7`, codehash
    `0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02`;
  - FWA's VRF service and fee router;
  - Shapes `0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0`;
  - ENS `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e`.
- **Off-chain code, in scope second, as integration surfaces that move money or decide when it moves:**
  - `keeper/keeper.ts` (the bundled keeper);
  - `shared/planner.ts` and `shared/design.ts` (the prices, odds and reserve the dashboard shows);
  - `app/src/App.tsx` and `app/src/tx.ts` (the transactions the dashboard builds and sends).
- **Compiler:** Solidity 0.8.28, `via_ir`, optimizer 50 runs (Draw Packs: 20), Cancun, as in `foundry.toml`. Record
  the solc binary and its hash.
- **Fork:** Ethereum mainnet block 26,382,349 (the test suite's pin), plus one run at a recent block to catch live
  drift, both through `https://mainnet.gateway.tenderly.co` only. Record the recent block number.
- The target is undeployed. There is no deployed bytecode to match, so source-to-runtime correspondence is "not
  applicable (undeployed)". The deploy script's postflight readbacks are in scope.

## 2. Owner requirements (the rules to test, and to challenge)

Owner's words: "we need to make this so it never loses money with keepers"; "The markup is where they make money";
"obviously we need this thing to function"; "the gas at listing time != gas at draw time"; the keeper list should be
"on the factory", "open at default", and no creator should have to update their pool individually. Since round 8:
"this needs to be like a self-sustaining system"; the revenue should restock the prizes "and then the creator gets
the profit"; "protect the game first, profit after" but "not always have the game eating the profit for the creator";
and the minimum markup is the game's share: "if the min for a setup is 10%, and they choose 30%, then shouldn't it be
1/3 - 2/3?" (DECISIONS 66-68).

**Participants and rights**
- **Creator:** funds the pool (`open()` needs the reserve in ETH), lists NFTs, sets the mix and a markup of 10% to
  100%, can always run their own upkeep, and withdraws the larger of their unclaimed `profit` and the balance above the
  reserve. They can never withdraw the reserve while open. After closing and unlisting, they withdraw everything.
- **Players:** pay FWA a draw price, win one listed prize, and get exactly the ETH inside a Shape or pack when they
  redeem it. Refunds follow FWA's rules.
- **Keepers:** permissionless by default. Paid measured gas × min(bid, basefee + 0.05 gwei, 5 gwei) + 0.0005 ETH,
  limited by `keeperCredit`. Creator-started work (opening, configuring, unlisting) is paid in full.
- **Keeper admin (on the factory):** only restricts upkeep to approved keepers or opens it to anyone, for all pools
  at once. No other power.
- **FWA and Shapes:** trusted external systems with their own admin powers (pause, mint fee up to 0.01 ETH). Their
  effects on the Balancer are in scope.

**Where each wei should end up (money goals: test each as an invariant at rest and over full cycles)**
- **M1. Markup.** The creator's markup is never spent on keepers. Every keeper reward outside creator work comes from
  restocking fees.
- **M2. Restocking fees.** A Shape prize lists at: backing + one mint fee per Shape inside + backing × markup + one
  restocking fee per Shape inside. The fee is `restockFee()` = 900k gas × min(basefee + 0.05 gwei, 5 gwei) +
  0.0002 ETH, at the listing block. It is credited to keepers in the call that lists the prize. The pool fronts it,
  and the player who wins that prize repays it. Unused fees stay with the creator.
- **M3. Mint fees.** These go to Shapes when a prize is minted, and the winning player repays them in the price.
- **M4. Prize backing.** It sits in prize tokens, and comes back to the pool at exactly its value when a prize is
  unlisted or a refunded prize is recovered.
- **M5. Creator exposure.** The creator's possible loss is bounded: the fees fronted for prizes never won, the opening
  stock-up gas, and prize luck. It must not include keeper pay beyond the fees.
- **M6. Reserve.** `requiredReserve` is the cost to restore the target, one largest prize per unrecorded draw plus a
  spare, and keeper rewards at the 5 gwei cap. A pool cannot open without it in ETH. Purchases do not wait for ETH:
  after a big win uses the spare, sales refill it (owner-accepted: back-to-back big wins leave prizes off the board
  until sales restock them, smallest first). No winner is ever unpaid: every listed prize holds its own backing.
- **M7. Nothing stranded.** After close, unlist and withdraw, no ETH or prize is stranded or owed to anyone but the
  creator. Excluded: the one-way FWA edge, VRF fee and Shapes mint fees, refunds FWA owes players, and a curated NFT
  whose own collection refuses the transfer.
- **M8. Fill gate.** Purchases pause before the odds drift far from the design (the gate is at 70% of target weight,
  and each unrecorded draw is charged the heaviest prize).
- **M9. Game first, profit after.** The fund is the balance less unclaimed `profit`. While it is below the reserve,
  the creator's share of each collected payment is each Shape's markup above 10% (at its listing markup, weighted by
  1 / price as FWA weights draws); the fund keeps the rest, including the first 10% of markup and all NFT sale money.
  While the fund is below the reserve, a claim never lowers it (it spends only allocated profit); while open, a claim never
  takes the fund below the reserve. Upkeep spends unclaimed profit only when the
  fund cannot pay a restock. No creator action (markup changes, listing or withdrawing NFTs, unlisting, timing of
  collection, creator transfer, open/close) may move fund money into profit.

**Product goal:** the pool stays open through ordinary mainnet gas, up to 5 gwei, funds itself from sales, and is
profitable for the creator in expectation, with profit withdrawable on every draw above the 10% minimum, at a draw
price players will accept.

Challenge these rules as well as the code. A passing check can enforce the wrong rule, and "fully accounted for" is
not "in the right place".

## 3. Process

- **Budget:** 12 auditor-hours (owner, 2026-11-13), including PoCs, fork and fuzz campaigns, challenge and
  reporting. Suggested split for 12 h: discovery lane A 3 h, lane B 3 h, integration
  assessor 2 h, controller (§5, reconciliation, economic tables, report) 4 h. Stop each lane at its ceiling and report what was
  used. If the cap is hit, write a partial report with exact blockers; that is not a
  clean result.
- **Blind discovery lanes:** at least two, plus an integration assessor. Each packet contains only §1, §2, §4, the
  budget and the permitted methods.
  - Discovery may read `src/`, `script/`, `lib/`, `foundry.toml`, `docs/SPEC.md`, `README.md`, and the on-chain state
    of the integrations.
  - **Not during discovery:** `audit/` (rounds 7 and 8), `test/`, the other files in `docs/` (`DECISIONS`, `SECURITY`,
    `READINESS`, `GAS`, the simulation results, `keeper-funding-results`), `sim/`, git history, PR text, this
    prompt's §5, memory, and other sessions.
  - Seal each lane's inventory before any informed work. Isolation is prompt-level unless a runtime boundary is
    available; record which.
- **Informed phase, after sealing:** reconcile the lanes, then read the excluded material. Run §5. Compare with
  round 8 findings (`audit/round8/report.md`) and check each is fixed, accepted or still applies.
  - Write focused falsification tests and validate findings.
  - Run a separate evidence challenge that compares every claimed negative result with its actual assertion or trace.
- **Human review:** none is planned. Disclose that.

## 4. Required methods (all lanes)

**Rules for tests and tools**
- **No mocks.** No `vm.mockCall`, `vm.etch`, or `vm.store` on protocol contracts, and no stub contracts in place of
  FWA, Shapes, Packs or VRF. Drive the real fork path. Funding an external actor's wallet is setup.
  - The only accepted exception is delivering VRF words by acting as the coordinator. Record it as such.
  - A behaviour that cannot be reached for real is an untested gap.
- **Run test files one at a time:** `forge test --match-path <file>`. Whole-suite runs are blocked except under
  `CANDIDATE_RUN=1`. Put PoCs under `audit/round9/` with their own `FOUNDRY_TEST` path.
- **Never run `forge clean`** or delete caches. Run Slither with `--ignore-compile` after a normal build; round 7's
  Slither run cleared the build cache.
- **Network:** fork access may need sandbox-escape approval for DNS. Record the capability preflight.

**Holistic pass (all lanes and the challenger)**
- Say when something does not make sense, inside or outside your scope, about the owner's rules, the numbers, the
  test environment or another agent's conclusion, without needing proof first; label it suspicion, question or
  confirmed. The report ends with a "Things that don't make sense" section.
- Prove the environment behind every economic number from inside the executed path: Foundry runs test transactions
  at gas price 0 and at basefee 0 inside calls unless `vm.fee` and `vm.txGasPrice` are set (views show the real
  basefee). Set both to stated realistic values and give every number its gas and block context.
- Check at least one absolute amount per money flow against an independent real-world calculation; conservation,
  bounds and planner-equals-contract checks pass in a fake world too. Reconcile Foundry results with real-transaction
  runs of the same scenario.
- Treat any setup fix or unexplained mismatch as a possible pattern and check all evidence that shares it. Ask of the
  whole evidence base: if the environment or a shared assumption were wrong in one way, which conclusions survive?
- Shared guidance, where available: `/Users/dd/.agents/guidance/holistic-verification.md`.

**Security pass**
- Cover every external and public function, including compiler-generated getters, every external call and callback,
  and every owner, creator, keeper-admin and anyone path.
- Write asset and authority ledgers across FWA's nested calls (list, withdraw, redeem, delivery, refund).
- Test hostile NFT collections, hostile purchasers and receivers, reentrancy across entry points, and creator
  transfer.
- Keeper admin and factory: the two-step handover, a compromised admin, `factory` set at initialize, clones made
  outside the factory, and the locked implementation.

**Keeper incentive pass**
- Prove or break: lifetime keeper pay outside creator work ≤ the restocking fees of the prizes keepers listed (M1, M2).
- Attempts to include:
  - bidding up priority fees;
  - an inflated gas limit;
  - EVM refunds that lower billed gas below measured gas;
  - splitting one batch into several calls;
  - restocking deliberately during a basefee spike;
  - toggling creator work;
  - self-dealing draws, including on a pool of cheap NFTs and with failed deliveries or refunds;
  - griefing that makes the creator front fees that are never repaid. State its cost to the attacker.
- Measure each keeper's profit and loss from real receipts (billed gas × effective price), not from measured gas.

**Economic pass (its own section and its own findings)**
- For each money goal M1–M8, write the destination invariant and test it:
  - at rest after every step of stateful runs;
  - over full cycles: open, draws, restock, close, unlist, withdraw.
- Test every one-way flow as a round trip: trigger it, remove the trigger, then check where the ETH ended up.
  One-way flows include mint fees, restocking fees, FWA's fee, the VRF fee and keeper rewards.
- Test with draws in flight: 1, 5, and bursts of batches before settlement.
- List every value that only goes up (`keeperCredit`, fees priced into listings, reserve terms, approvals) and
  whether each can strand or idle capital.
- Use launch-scale numbers: a Balanced mix (20×0.01, 10×0.05, 2×0.1, 1×0.5 ETH Shapes, 7×0.02 ETH packs, one
  0.3 ETH NFT, 15% markup), a bigger-prize mix, and a mix with only 0.01 ETH Shapes.
- Model gas at 0.05, 0.1, 1, 3 and 4.9 gwei, above 5 gwei, gas rising slowly, a jump on a fresh pool, and a spike that
  ends.
- Model the mint fee rising to 0.005 and 0.01 ETH, demand stopping, a late keeper, the creator withdrawing everything
  allowed every step, and retirement.
- Report for each scenario:
  - the creator's net and its spread across runs;
  - the share of runs that lose money;
  - the player price and average return;
  - liveness, as the share of the time purchases are open;
  - NFT odds against the design;
  - idle and fronted capital;
  - anything stranded.
- `sim/fund.ts` models the contract (`sim/flows.ts` was removed, DECISIONS 71). Check its formulas against the contract line by line, and check its numbers
  against a fork run of the same scenario. A simulation that disagrees with the fork is a finding.

**Liveness and timing pass**
- Inventory every value that depends on gas price or block state: rewards, `restockFee()`, FWA's VRF fee (depends on
  `tx.gasprice`), the reserve's keeper term, and gas use that varies with the block (Shapes mint seed, VRF request
  path).
- For each, test what happens when the quote and the inclusion block differ, and when simulation runs at gas price 0.
- Test what a keeper restock or another player's draw does to a player's draw already on its way: inventory version,
  price cap, slippage refund. Measure how often players' draws would revert under realistic keeper timing.

**Off-chain pass (second priority)**
- **Keeper bot:** gas-limit headroom against the worst call in a block; behaviour when work grows between estimate
  and inclusion; restricted pools; RPC failures; restarts; replaced transactions; reorgs.
- **Planner:** parity with the contract on prices, odds and reserve (`test/fixtures/parity.json` is generated on the
  fork).
- **Dashboard transactions:** gas price set or not when estimating, batched wallet calls that carry no gas price,
  the deposit a pool needs, and replaying events that are not enumerable.

## 5. Informed pass (only after discovery is sealed)

**Round 8 findings and their repairs (DECISIONS 61-68).** Retest each and record fixed / accepted / still applies:
E1 (owner-accepted: purchases continue while sales refill the reserve; check M6 and M9 hold instead), E2 (`open()`
needs the reserve), E3 (simulation: `sim/flows.ts` VRF fee and destination checks, still open), E4 (planner live
curated prices), E5 (`close()` zeroes keeper credit), E6 (dashboard simulates at real fees, as the creator), E7 and E8
(keeper estimate and gas floor), S1-S5 (curated-collection trust and router coverage, documented limits; S4 pricing
order fixed). Also break the round 8 follow-ups: the payment split (`profitShareSum`, `profit`, `withdrawableSurplus`,
`claimSurplus`), the 10% minimum markup and the funded `open()`; the round 8 follow-up review found and fixed one
curated-NFT padding attack on the split, so look for others.

**Misses found on ApeBall after its audits:**

ApeBall (repo `ripe0x/collection-games`) passed audits, then needed fixes on mainnet. Run each item below as a
focused check against this target. Record each as applies / does not apply / untested, with the test or proof.

1. **Keeper paid at the caller's bid** (issue #23 item 1). A bot bid about 2.9 gwei of priority at 0.1–0.2 gwei
   basefee. It was reimbursed at the 3 gwei cap and won every race: 0.112 ETH paid for about 0.01 ETH of work.
   Check here that overbidding lowers the bot's own profit, at every basefee up to the cap, with real receipts.
2. **Gas measured before EVM refunds** (issue #23 item 2). Large batched calls were paid 15–20% more gas than their
   receipts showed. Find each upkeep path that clears storage (reconcile, unlist, redeem, FWA's own clears), and
   compare measured gas with billed gas.
3. **Config drift** (issue #23 item 3). The repo's launch config said 3,500 where the live value was 7,500.
   - Compare every constant and default in source, the deploy script, `shared/planner.ts` (for example
     `RESTOCK_FEE_GAS` and `KEEPER_MAX_GAS`), the keeper bot, the dashboard and the docs.
   - Compare FWA and Shapes parameters read live (edge, batch limit, staging cap, mint fee, VRF service settings)
     with what the code assumes.
   - ApeBall's VRF gas estimate was 1.5M live against 1.1M in vendored source.
4. **Money in the wrong bucket with draws in flight** (ApeBall PR #34). Every balance reconciled, but one 3-draw round
   trip moved 1.5 ETH of vault money into game capital for good, left about 1.5 ETH idle at rest, and recycled
   surplus as capital. Mocked tests had hidden it.
   - Here: run every money goal (M1–M8) with draws in flight and across restock timing.
   - Look for creator ETH that becomes stuck in the reserve, is fronted and never repaid, or sits idle while the pool
     needs it.
5. **Mocks hiding behaviour** (ApeBall PR #34). Faked fees, faked balances and pranked protocol contracts hid the bug
   above.
   - Audit this repo's tests for anything that stands in for a real path: `vm.store`, `etch`, pranks or `vm.deal` on
     protocol contracts, and mock contracts used as counterparties. `test/utils/Mocks.sol` holds test NFT
     collections; judge whether each is a legitimate hostile actor or hides a real path.
   - List paths with no real test.
6. **Fees that depend on gas price, simulated at gas price 0** (ApeBall PR #13, #24). An RPC ignored `gasPrice` in
   `eth_call`, so FWA's VRF fee quoted 0, and draws reverted `InsufficientPayment`. Wallet batches carried no gas
   price, so estimates fell short and draws ran out of gas.
   - Here: `canPurchase` and `admissionStatus` run inside FWA's purchase.
   - The keeper simulates `performUpkeep`, whose reward depends on `tx.gasprice`.
   - The dashboard estimates and batches transactions.
7. **Out of gas when state changes between estimate and inclusion** (ApeBall PR #26). A Chainlink fulfilment earlier
   in the same block moved a draw onto a costlier path.
   - Here: the round-7-to-round-8 rehearsal saw 3 of 340 keeper upkeeps revert after about 1.9M gas, with the cause
     not confirmed. Billed gas exceeded the estimate by up to 291k.
   - Reproduce it, and find the largest gas difference between estimate and inclusion for upkeep and for player
     draws.
8. **Price or inventory moving under a player's draw** (ApeBall PR #13, #27). Other players' draws raised the price
   2.4% in two blocks, so draws reverted `AcquisitionFeeTooHigh`. A keeper sync landing first made draws revert
   `InventoryVersionMismatch`.
   - Here: keepers restock while draws are pending, and restocking at a new basefee changes prices.
   - Measure the player-facing revert rate and refunds.
9. **Off-chain consumers of events** (ApeBall PR #7). An indexer crashed when one Transfer matched two filters.
   Check the dashboard's and keeper's event replays (`BalancerCreated`, `ItemDrawn`) for duplicates, reorgs and
   ordering.
10. **Fork-block drift** (ApeBall PR #34). Tests pinned to a fork failed later because live Shapes names had changed.
    Re-run the integration tests at a recent block and report anything that differs from block 26,382,349.

Also check the misses this project found after rounds 7 and 8, each as a property:
- keepers paid from the markup lost money at high gas;
- a fee priced when a prize was listed did not pay for a restock after gas jumped;
- restocking-fee gas calibration was too low for a one-draw call (763k–864k gas measured);
- NFT odds drift while keepers wait;
- liveness when the keeper list is restricted.
- a purchase-time funding check paused pools for good once the creator withdrew profit (fork: 7 of 10 runs);
- profit withdrawals stopped for about a third of draws while the reserve refilled;
- splitting proceeds against the listings at collection let listed NFTs inflate the creator's share.

## 6. Constraints

- **No authority to deploy to mainnet,** broadcast, spend real funds, use production secrets, or publish.
- **Never write a private key, seed phrase or API secret** into any file, command or log. Use `--unlocked` anvil
  accounts on forks.
- **RPC:** Ethereum mainnet only through `https://mainnet.gateway.tenderly.co`.
- **Anvil:** the dev fork uses port 8545. Reuse a running one (`--chain-id 31337`) and never kill a fork you did not
  start. Keeper e2e and rehearsals start their own forks on 18546, 18547 and 18847.
- **Do not change production code or existing tests.** Audit artifacts go under `audit/round9/`.
- **Report fixes as suggestions only;** repairs need separate owner approval.

## 7. Report

Follow the report contract:
- Findings ranked by severity, **security and economic in separate sections.** For each finding, give:
  - the site;
  - the exact transactions;
  - the impact in ETH at launch scale;
  - a PoC command, with exit status and output file;
  - a suggested fix.
- A property map: each property M1–M8, each keeper and security property, and each §5 item. For each, give the attack
  attempts, the tests or proofs, the commands, the results and the assumptions.
- What was not tested, and why.
- Round 8 findings: fixed, accepted, still open, or changed.
- The economic tables from §4, with the simulation and fork comparison.
- The process record:
  - budget used;
  - isolation level;
  - calibration (uncalibrated unless a record exists);
  - structural gate status;
  - human review (none).

A clean result is scoped evidence, not proof of safety or release readiness.
