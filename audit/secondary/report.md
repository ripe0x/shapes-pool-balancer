# Secondary informed review: keeper loss policy and dashboard writes

Sealed 2026-11-11 02:27 UTC. Frozen target 0f017843ec333f499809f751e19017be325448e3. This is an informed, bounded code review with executable local proofs; it is not an independent discovery lane, full UI acceptance test, on-chain audit or release approval. I made no production or existing-test changes, broadcasts or external writes.

## Review boundaries

Read keeper/keeper.ts and callers keeper/keeper.test.ts, keeper/e2e.ts, keeper/rehearsal.ts, docs/OPERATIONS.md; app/src/tx.ts, app/src/App.tsx, app/src/chain.ts, app/src/tx.test.ts, relevant pool-page e2e and source contract. Inspected the installed @wagmi/core writeContract/getConnectorClient implementation (version locked by package.json) to determine sender selection. Did not run the full keeper e2e, a browser, a wallet provider or the FWA profile server. Evidence control is advisory; no human review.

Source SHA-256: keeper/keeper.ts 8885b1815c6b0200bc0f9b030c0e4a5b1a48347789e0714f1395101c7259fd2f; app/src/tx.ts 036862775edf9de7298342ca4125584557ec3d0f835ad3fcab5959b75a12421c; app/src/App.tsx da2dcf5866903a4a55d20afaf4a7110450e037dc1885046325c50ad161d4c629.

## S1: simulated creator account can differ from wallet that writes

**Confirmed local routing sequence; mainnet occurrence depends on an account switch during the async gap.** App.tsx useTx.write captures useAccount().address, awaits prepareWrite, then passes the prepared object to writeContractAsync. prepareWrite simulates and estimates with that address but returns only params plus gas, omitting account. The installed @wagmi/core writeContract sees no explicit account and obtains the current connector client; getConnectorClient uses its current connection/account. A switch from A to B between estimate and submission therefore lets the wallet sign as B while simulation validated A. The executable proof uses the actual prepareWrite and installed wagmi action with a connector whose current account changes to B; it asserts simulate/estimate used A, returned params omit account, and submission used B.

For creator-only Balancer methods, B ordinarily reverts and may waste gas. For permissionless BalancerFactory.createBalancer, B supplies the deposit and becomes the creator of the resulting pool even though A was the simulated account. A wallet confirmation may display B and allow the user to catch it; that behavior was not tested. The proof does not send a transaction or establish how often this race occurs.

## S2: account switch leaves an unrelated Balancer selected

**Confirmed local state transition; consequential write remains conditional on user action.** App.loadMine fetches factory events filtered by the current address and replaces mine, but only assigns selected when selected is falsy. After switching from A to B, an existing selected pool A remains while mine now contains B's pools. Dashboard still renders selected A. The extracted actual loadMine callback was executed with B's log result and selected=A; it left selected=A.

useBalancer also retains its prior data until the async load for a new pool completes. When selected changes, Dashboard can briefly combine a new balancer prop with old data. Creator checks and contract authorization mitigate most mistaken asset-moving writes. Permissionless upkeep stays available, so a user can spend gas on the wrong pool; a creator who controls both pools can also issue a valid write against the old selected pool. This review did not run a browser timing test of the transient data mix.

## S3: failed page approval still submits a profile POST

**Confirmed callback execution, with remote acceptance unverified.** useTx.send catches a failed write, sets an error message and resolves undefined. PoolPage.publish awaits send but does not check its result, then constructs and sends the POST to pools.fwa.fun. An executable test extracted the unmodified send and publish callbacks from App.tsx with TypeScript's parser, injected a wallet rejection and a stub FWA server, and observed the error message followed by one POST. With the stub returning 200, the UI result became “FWA accepted the page.” This is a client sequencing bug. The real FWA server may reject a page whose ERC-1271 approval never landed; its contract-owner verification is unconfirmed. No unauthorized remote publication is claimed.

The test also checked that, for the sample metadata, the attempted approvePoolPage call targeted the selected Balancer and supplied keccak256(JSON.stringify(posted.metadata)). The dashboard does not itself sign a different message: it stores that metadata hash on-chain and sends a 66-byte placeholder signature because the Balancer's ERC-1271 verifier ignores signature bytes. The exact FWA message reconstruction was previously exercised by keeper/e2e.ts on a local fork, but that broad e2e was not rerun here. A live FWA server template change remains outside this evidence.

## S4: MAX_LOSS_WEI is an estimate-time threshold, not a hard per-call loss cap

**Executable fee-path counterexample to an absolute cap; consistent with the documented estimate-based policy.** keeper.decide compares simulated reward + MAX_LOSS_WEI with gasEstimate × (current baseFee + priority). An EIP-1559 send uses maxFeePerGas up to twice that base fee plus priority; the transaction can be included after basefee rises. resolvePending re-simulates and rechecks at replacement time, but a profitable replacement may itself wait another block, and an already-sent transaction remains live when a later replacement is declined. The 30% gas-limit margin and block-dependent mint cost add further estimate/inclusion uncertainty. There is no hard on-chain or wallet-enforced net-loss limit.

The local proof uses an unpaid re-checkpoint (reward zero), 155,000 gas, initial basefee 0.8 gwei, priority 0.05 gwei and default MAX_LOSS_WEI = 200,000,000,000,000 wei. Initial estimated cost is 131,750,000,000,000 wei, so decide sends. Three maximum 12.5% basefee increases bring basefee to 1,139,062,500 wei; resolvePending actually sends its +25% replacement, with expected cost 186,242,187,655,000 wei, still below allowance. One further permitted increase yields basefee 1,281,445,312 wei. The replacement remains eligible at effective price 1,343,945,313 wei; if it uses the same 155,000 gas, cost is **208,311,523,515,000 wei**, exceeding MAX_LOSS_WEI by **8,311,523,515,000 wei**. The proof stubs network receipt/simulation and exercises the actual resolvePending branch; it does not show a mined receipt or establish that basefee took this path. The operator documentation explicitly says the allowance is “measured against the gas estimate,” so this is a policy-limit clarification rather than a violation of that narrower promise. Several permitted losing calls across pools can aggregate beyond one per-call allowance; no global spend cap is specified.

## Exact test record

- Files: audit/secondary/Flows.test.ts SHA-256 d6bf006d26cbc55c4250e4a98acf02cdb7acbfed3ef6215bab6a1e73f1adf6bf; audit/secondary/KeeperLoss.test.ts SHA-256 fecb7edb92247b94d39c40102897b62817b212064b836ecc76c221a1de93d165; audit/secondary/vitest.config.ts SHA-256 9bfca28175822b5aa72a8e0cd746c064f940e0f5fa51e52699945d3e6b8e5451.
- First command npx vitest run audit/secondary/Flows.test.ts: exit 1, no tests found because repository Vitest include patterns exclude audit. Added audit-owned config.
- First configured run: 1 of 2 tests failed because the extracted callback's injected context omitted poolBalancerAbi, not because the product prevented the POST. Added that binding.
- Final command npx vitest run --config audit/secondary/vitest.config.ts audit/secondary/Flows.test.ts audit/secondary/KeeperLoss.test.ts: exit 0, 2 files, **4 passed, 0 failed**. No browser, wallet, chain or remote FWA service was contacted by these tests.

## Decision and limits

S1 and S3 warrant product repair review because their effects are directly reachable in client control flow. S2 warrants a UI state reset/refresh review; its wrong-write consequences were reasoned from address routing, not exercised in a browser. S4 should be described to operators as an estimated subsidy, unless the owner requires a hard spending control; that would be a policy change requiring separate design and verification. No repair was authorized by this standalone review.

This pass used approximately six minutes of wall time, 02:21–02:27 UTC, within the original lane allocation; no additional hour was used. These proofs cover specified states and mocks only. They do not establish that other UI writes, wallet races, keeper profitability cases or pool-page server behavior are correct.
