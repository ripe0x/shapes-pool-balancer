# Round 9 neutral discovery packet

This packet is the only task input for blind discovery. Sections 1, 2, 4 and 6 are copied verbatim from the owner's
audit prompt; the access rules and budget below replace its process section for discovery.

## Access during discovery

- Read: `src/`, `script/`, `lib/`, `foundry.toml`, `docs/SPEC.md`, `README.md`, the off-chain files named in section 1
  (`keeper/keeper.ts`, `shared/planner.ts`, `shared/design.ts`, `app/src/App.tsx`, `app/src/tx.ts`), and public on-chain
  state of the integrations through `https://mainnet.gateway.tenderly.co`.
- Do not read: `audit/` (earlier rounds and other lanes), `test/`, any other file in `docs/`, `sim/`, Git history or
  diffs, PR text, memory, other Claude sessions or transcripts. Do not search the whole repository; restrict file
  searches to the allowed paths. If you read an excluded file by accident, stop, record the path and time in your
  output, and say which later results are informed by it.
- Isolation is prompt-level (procedural): the shared filesystem does not prevent excluded reads. Record your own
  accesses honestly.
- Write only inside your lane directory. Write your own tests from scratch; do not copy repository tests.
- The simulation (`sim/`) and the planner parity fixture are compared in the informed phase, not by you; the planner
  and design code in `shared/` are in your scope.

## Budget

Total cap 12 auditor-hours for the round. Your lane ceiling is stated in your task. Stop at the ceiling, seal what you
have, and record the time used. No human review is planned.

## 1. Target and freeze

- Repository `/Users/dd/CascadeProjects/fwa-pool-balancer`, branch `fork-tests`. Frozen at commit `c686534669562e78fd33f7297c13f12e68fe3066` (clean tracked tree; SHA-256 of 1,290 in-scope
  files recorded by the controller). Production source is identical to `7b32497`.
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
"on the factory", "open at default", and no creator should have to update their pool individually. Later:
"this needs to be like a self-sustaining system"; the revenue should restock the prizes "and then the creator gets
the profit"; "protect the game first, profit after" but "not always have the game eating the profit for the creator";
and the minimum markup is the game's share: "if the min for a setup is 10%, and they choose 30%, then shouldn't it be
1/3 - 2/3?".

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
  creator.
- **M8. Fill gate.** Purchases pause before the odds drift far from the design (the gate is at 70% of target weight,
  and each unrecorded draw is charged the heaviest prize).
- **M9. Game first, profit after.** The fund is the balance less unclaimed `profit`. While it is below the reserve,
  the creator's share of each collected payment is each Shape's markup above 10% (at its listing markup, weighted by
  1 / price as FWA weights draws); the fund keeps the rest, including the first 10% of markup and all NFT sale money.
  A claim never takes the fund below the reserve or below where it was. Upkeep spends unclaimed profit only when the
  fund cannot pay a restock. No creator action (markup changes, listing or withdrawing NFTs, unlisting, timing of
  collection, creator transfer, open/close) may move fund money into profit.

**Product goal:** the pool stays open through ordinary mainnet gas, up to 5 gwei, funds itself from sales, and is
profitable for the creator in expectation, with profit withdrawable on every draw above the 10% minimum, at a draw
price players will accept.

Challenge these rules as well as the code. A passing check can enforce the wrong rule, and "fully accounted for" is
not "in the right place".

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
- `sim/flows.ts` models the contract. Check its formulas against the contract line by line, and check its numbers
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

## 6. Constraints

- **No authority to deploy to mainnet,** broadcast, spend real funds, use production secrets, or publish.
- **Never write a private key, seed phrase or API secret** into any file, command or log. Use `--unlocked` anvil
  accounts on forks.
- **RPC:** Ethereum mainnet only through `https://mainnet.gateway.tenderly.co`.
- **Anvil:** the dev fork uses port 8545. Reuse a running one (`--chain-id 31337`) and never kill a fork you did not
  start. Keeper e2e and rehearsals start their own forks on 18546, 18547 and 18847.
- **Do not change production code or existing tests.** Audit artifacts go under `audit/round9/`.
- **Report fixes as suggestions only;** repairs need separate owner approval.

