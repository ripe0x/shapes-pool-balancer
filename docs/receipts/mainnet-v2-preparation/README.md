# Mainnet v2 preparation, before broadcast

Owner instructed the agent to run all commands up to mainnet deployment. No production transaction or service cutover is authorized or performed here. PR: https://github.com/ripe0x/shapes-pool-balancer/pull/57.

## Completed

- Published reviewed/signed candidate `8db66c2` on `codex/batch-inventory-closeout`; opened PR57. Existing dirty local journal, ignored state, services and fork preserved. Initial Git HTTPS fetch timed out; the same read retried with HTTP/1.1 succeeded. No reauthentication or credential changes.
- Credential-pattern publication scan matched a literal environment-rejection test sentinel in `scripts/local-playground.test.ts`, not a credential (24 hyphenated ordinary letters, not hex/key material). The shell failed to stop publication on that scan exit; the exact location was checked and confirmed synthetic before continuing. No real secret exposure was identified. No credentials are present in these preparation records.
- Fresh read-only canonical preflight: `node --import tsx scripts/deployment-preflight.ts --rpc-url https://mainnet.gateway.tenderly.co --out docs/receipts/mainnet-v2-preparation/preflight.json`, exit 0. Reused dependency code/relationships and packaged legacy scans pass. Separate fresh current-factory scan found zero pools.
- Read-only candidate simulation through **the production wrapper**: exact command and code revision in `candidate-dry-run-result.json`, exit 0, 22.35 seconds. The wrapper reran its signed focused gate and passed; actual `Deploy.s.sol` checks passed. It used the public RIPE sender, no keystore unlock, wallet configuration or `--broadcast`. This simulation ran on the frozen feature candidate while CI was pending; it is not a deployment from that branch. Actual production broadcast still requires main checkout == origin/main under R110 and fresh nonce/source/fee checks. Existing public generated `deployments/1.json` was preserved and restored byte-for-byte; simulation values have a separate filename.
- Initial hosted CI passed build, typecheck, all TypeScript tests, application build and `Fork.t.sol`, then failed three stale `CommunityConfigAcceptance` cases with `InvalidConfig()`. The log is retained. These require nonzero manual creation fees, superseded by R118–R121; one also expects a claim during a reserve gap. No runtime defect is inferred from those stale rights assertions.
- Owner explicitly approved CI migration patch SHA256 `2cf7ba11fa1c46ce84e72d90ccd6bb13102041608d83a954417dcc07658cb3f3`. Applied exactly and committed/pushed `36895b3`. It retains 14 other Solidity regression commands, full build, all TypeScript tests, typecheck and app build. It replaces seven mixed legacy suites plus the retired full campaign with the 13-contract focused check. Those seven also contain valid non-fee assertions, so this is an owner-approved narrowing, not equivalent coverage or a claim that every old test passed. No old tests are deleted. Hosted CI then passed the 46 focused cases and Fork, but Settings revealed a retained fixture trying to withdraw unearned opening capital. Local fixture repairs were subsequently committed as `6fc8c62`; 118 retained contract cases and the refreshed money-path replay pass. The remaining Hardening case exposes a real surcharge-cost mismatch, detailed below; no merge has occurred.
- Proposed workflow YAML parsed; its source-hash command executed locally and produced the exact signed source digest. Bounded independent static review confirmed hash equivalence, shell failure behavior, hosted dependencies, retained 14 commands/`--isolate` flags and coverage tradeoffs. Production source, focused gate/config/signature and approved economics are unchanged; source digest remains `58c252dd452c6c54b2b91694ed6c25e52f65eb9face0725d6ba1b88461c0596b`.

## Decoded candidate simulation

Readback at mainnet block26497137: RIPE nonce latest=pending=4251, balance 0.173556986201324617 ETH, EIP-7702 delegation unchanged. Existing factory `0x6F018fF718Ab5A4287F937e4e4729Aa65610f53b` remains at implementation `0xfEBaFdbFf526afb2bE2DCCedcb740962B5E91089`, with RIPE policy/keeper admins and no creation-pause getter. The source change requires a new factory, not an old-factory pointer switch.

Dry-run SHA256: `b196c10b91293be329970fc6a61d6fc6203be214e6094f3e261311f46d789902`. Full unsigned calldata and constructor arguments are in `candidate-reviewed-dry-run.json`; independent CREATE/CREATE2 address, nonce, sender, zero-value, role and gas assertions are reflected in `decoded-candidate-plan.json`.

| Label | Nonce | Created address | Gas limit |
| --- | ---: | --- | ---: |
| PoolPage, CREATE2 through canonical deployer | 4251 | `0x8Ca9E6CfE4A4F4F10cEF1d2EfF6954e476bd890C` | 614,344 |
| PoolInventory, CREATE2 through canonical deployer | 4252 | `0xe64f685C24056e41C30e4cf35C8Cb28381F1EAa5` | 6,156,029 |
| PoolBalancer implementation, CREATE | 4253 | `0x45754494B606f9E3AebfB9984330eC788A87eF76` | 7,021,362 |
| BalancerFactory, CREATE | 4254 | `0x96fd7B2e83E04Ea2e78be415e0BC82A1332e7671` | 1,928,999 |

All transaction values are zero. Constructor admins are RIPE. The new factory is publicly paused; existing pools, factory pointers, user assets and live app/keeper configuration are unchanged. KeeperPolicyCalls and existing FWA/Shapes/Packs/renderer dependencies are reused and checked by the canonical path.

Total gas limit **15,720,734**. Proposed fee cap **0.25 gwei**, priority fee **0.05 gwei**; maximum gas commitment **0.0039301835 ETH**, subject to fresh state and explicit action-time approval. Simulation's initial near-zero suggested tip is not used as the proposed inclusion tip. Fee settings use Forge `--with-gas-price 250000000 --priority-gas-price 50000000`; no raw key. No broadcast command was run. These are not locked future nonce/address or gas-price commitments: any external signer transaction, code/state change, nonce movement, fee change or simulation difference requires reconciliation before approval.

## Independent packet check

An informed read-only reviewer independently derived all four CREATE/CREATE2 addresses and zero salt, checked public sender/nonces/calldata hashes, constructor arguments, linked artifact bytecode and source metadata, compiler settings (50 optimizer runs, via IR, Cancun), 24,438-byte Balancer runtime, admin roles and new-factory paused construction. The saved reused dependencies and exact gas-budget arithmetic matched. No blocker was established in the examined packet. This reviewer performed no RPC calls, tests, builds, edits or broadcasts; fresh chain state and action-time owner approval remain necessary. Fee caps are proposed flags, not fields already embedded in the raw dry-run transactions.

## Remaining economic decision

[RESTOCK-SETTING-DECISION.md](RESTOCK-SETTING-DECISION.md) records a confirmed, includable 5-gwei cost shortfall under the 910k setting, not a stale fixture failure. A temporary 940k factory setting passed all four exercised cycles; the source was restored and no production parameter was changed. Owner decision is pending. [Retained regression evidence](retained-regressions/verification.md) distinguishes raw failures, actual repairs and the conditional parameter proposal.

## Exact next action

Receive the pending economic decision, apply only its authorized test/launch-setting changes, and run affected checks. Push the completed repair and wait for hosted checks; merge PR57 under the owner's current authority only once checks are satisfactory, and fast-forward the main checkout while preserving unrelated dirty files. Then confirm main == origin/main, unchanged signed digest, actual signer/nonce and target-code state. Reuse valid simulation evidence only if its inputs remain identical; otherwise rerun the affected dry run through the same wrapper. Present fresh decoded broadcast actions and spending bounds to the owner. Mainnet writes and public unpause remain separate explicit confirmations. R83's no-mainnet-canary decision is preserved.

Things that don't make sense: the old CI required superseded manual-fee rights and a deliberately retired full-campaign harness while the approved release scope was focused v2. The explicit migration records the coverage reduction; green focused checks do not retroactively validate that legacy campaign, all historical assertions, or live oracle availability.
