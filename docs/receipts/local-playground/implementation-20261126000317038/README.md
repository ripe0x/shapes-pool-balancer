# Local version 2 implementation deployed and selected

Completed on the preserved localhost8545 Anvil node, chain31337, PID28171, original fork block26485619. Owner R122–R124 authorized the local deployment, stored archive RPC use sparingly, and the disclosed rollback-checkpoint loss. No mainnet transaction, new wallet funding, pool deposit, NFT transfer or draw was broadcast.

- Source contracts: `213a6ab`; deployment helper: `e3b302a`, with owner refresh approval appended before preparation.
- Factory: `0xbe49677a403f77136e81498e5681f8dc22aa1181`.
- Previous v1 implementation: `0x0176016958744B0030c96cC10896bd0817D94855`.
- New v2 implementation: `0xc02d40577880fA2C489Fc5461ce3830D4EeD7724`.
- New Inventory library: `0xe64f685c24056e41c30e4cf35c8cb28381f1eaa5`.
- Exact packet: `6248dd0c78ba262acf8b3346b0470e8d1f37f4feb62daa39719b892732a598f6`.
- Public creation remains **unpaused**. No existing clone is upgraded.

| Operation | Transaction | Gas used |
| --- | --- | ---: |
| Inventory | `0x211c70ca37dc884f22548dbec7e029ca117f8d7b3f8800aee28f880b181caf61` | 4209251 |
| Implementation | `0x4d71f1759a3e91d52f3ce0d55589f5020b92a55c44e82f04db7d76776426190a` | 5401048 |
| Factory switch | `0xda886c28c48717042ece4ff12dba7a36e603fba46c8c29fec5b4ce7a97561b41` | 33476 |

All3 receipts succeeded; values0; aggregate gas 9,643,775; cost **0.000482188827150200 test ETH** (482188827150200 wei), below1testETH cap. Actual effective gas price50,000,008wei on the locally advanced fork, not a mainnet cost or profitability measurement. Deployer1e001 nonces9/10; admin1e004 nonce23. Production Deploy.s.sol and guarded wrapper were used through a clean stage for simulation, deployment and separate setter. Linked runtime hashes matched the packet before switch. `verifyImplementationUpdate` passed; factory configuration unchanged except implementation.

`app-preflight.json` verifies selected implementation marker2 and unpaused creation. One read-only real factory `createBalancer` simulation succeeded with target1,25% markup, automatic fee field0, accepted live mint cap and0.1simulatedtestETH at1gwei. No transaction was broadcast by that probe and the block did not advance. The actual app at http://127.0.0.1:5280/ loads this local factory, shows **Estimated creator fees per draw**, separate projected bankroll margin and working All numbers disclosure. It is left open; no wallet connection, approval or creation transaction was clicked.

## State-preserving archive repair

Anvil1.8.1 hot-switch changed its displayed provider without changing its execution database. Tenderly429 still blocked preparation. The full historical-account-state export exceeded the server response limit. A current-state backup preserved81accounts,446blocks and293transactions; its hash/path is in `refresh-verified.json`. Owner explicitly approved discarding old rollback IDs and historical account-state snapshots.

Reset succeeded, but the first2.559MB load hit Anvil's default2MB request cap. Automine stayed off. The same genuine backup was restored in two measured requests below1.9MB: saved accounts with null block/checkpoint metadata, then complete saved blocks,transactions and the exact original head/checkpoint. Independent pinned-source review confirmed merge semantics and original-head selection. Full account records (balances,nonces,code,storage), all saved blocks and transactions matched. Head26486065 and hash8eb9697d35870b5b7d8c87b272e480d1520f602d91cf6b49edf2f1185c58d9b0 were restored exactly; synthetic unlocked signers1e001/1e004/1e007/1e008 survived. Automine restored; a previously failing uncached account read succeeded. Same Anvil process remains running.

No artificial protocol balance/storage/oracle data was supplied: all imported records came from the exact saved running fork. Credential URL was passed only through the existing process environment; packets contain an upstream hash. No credential-bearing file/argument/log was created. State backup retained at `/tmp/fwa-8545-before-archive-rebind.state` and was checked for the configured credential before writing.

## Verification limits

Ten focused deployment/playground guard tests and typecheck passed. Independent source review covered the local archive guard and refresh procedure. Prior implementation focused contract regressions remain unexecuted after the public-RPC refusal; no broad campaign was run against the paid provider. Deployment, creation-call simulation and designer readback establish this local playground step only, not successful v2 fee accrual/reinvestment across draws or production readiness.

Both old pool-specific keeper processes were preserved running. Their already-loaded beforeSend guards require the old Tenderly URL and will refuse writes during the Alchemy fallback. They do not service a newly created pool. A new pool must be identified and its keeper/draw helper scoped before a draw campaign; no old process was silently restarted or scope broadened. Old pool withdrawal and creation paths remain available through the app.

## Things that do not make sense

- Anvil's displayed provider was not its execution provider; this required the approved refresh.
- Full export and load have different size constraints; the failed one-piece restoration and exact chunk repair are preserved.
- A local deployment and creation simulation do not establish full v2 economic behavior or a mainnet release.
