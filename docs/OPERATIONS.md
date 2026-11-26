# Operations and recovery

Current operations, 2026-11-18. See [SPEC.md](SPEC.md), [KEEPER-POLICIES.md](KEEPER-POLICIES.md) and
[focused audit repairs](AUDIT-FOLLOWUP-RESULTS.md). Historical reports validate only their named revisions.

Status codes come from `admissionStatus()`; the dashboard shows them as text.

| Code | Name | Meaning | Action |
| --- | --- | --- | --- |
| 0 | OK | Open: the Balancer admits purchases (FWA can still refuse one, e.g. when its VRF service lacks capacity) | none |
| 1 | CLOSED | Closed by creator | `open()` |
| 2 | SETTING_UP | Initial stocking or reopening setup is unfinished | call `performUpkeepUnpaid()` (keeper, creator or anyone) until the target is restored; deposit ETH first if the reserve is short |
| 3 | NO_CURATED | Only while `curatedRequired`: no curated listing remains in local tracking | list a curated NFT, or `setCuratedRequired(false)`; then complete any stocking |
| 4 | BUSY | 5 draws are unsettled on FWA | wait for VRF and FWA processing (upkeep processes stuck draws after 10 blocks while BUSY); anyone may call FWA `processAcquisitions(5)` |
| 5 | (retired) | Not returned by this release. A Shapes mint fee above `mintFeeCap` stops minting in upkeep; listed prizes keep selling until LOW_INVENTORY | run `configure(markupBps, target)` again to accept the new fee (the reserve must cover it), then upkeep |
| 6 | LOW_INVENTORY | Prospective Shape-weight lower bound is below 70% of target | process/reconcile existing draws; inspect actual staging and liquidity before adding ETH |
| 7 | CURATED_PROOF_REQUIRED | Only while `curatedRequired`: an active curated listing has not been proven | activate staged curated inventory if necessary, then anyone calls `refreshCuratedWitness(listingId)` |

## Keeper down

New purchases pause once prize weight falls below 70% of the target (status 6) or 5 draws are unsettled (status 4).
Outstanding draws, refunds and NFT claims retain FWA's rules. Ready or expired draws can require explicit processing (see "Stuck draws"). Anyone, including the creator from the dashboard, can call `performUpkeepUnpaid()`, even if the factory restricts paid keepers. Run a second keeper with the same factory address; duplicate submissions just
revert `NoUpkeepNeeded` in simulation and are never sent.

Shape admission uses the [operation-aware bound](SPEC.md): the old unreconciled allowance and actual nonselectable count receive credit only for FWA's previously reserved prefix plus the next six guaranteed activations. It preserves the existing busy threshold and permits purchases without keeper maintenance between every batch. A single bounded Shape/Pack staging-count estimate prevents unrelated curated staging from being charged as missing Shapes; its zero fast path preserves the original allowance.

Curated presence is checked separately against current FWA inventory. A cached listing ID and slot are only a candidate: each purchase checks that FWA's slot still maps to that tracked curated listing. An active count greater than all tracked Shape prizes also proves curated presence. Otherwise status 7 pauses purchases, including when every curated item is staged. The dashboard's **Refresh curated proof** action is permissionless and verifies one actually active curated listing. It transfers no assets and pays no reward; the caller pays gas. A still-valid cached witness cannot be replaced. When the witness exits but another curated NFT remains, one refresh transaction can restore this gate. This bounded ambiguity pause is owner-approved R72; it is not a maintenance requirement after every batch. Earlier pending draws can still win the last curated item before a later draw selects; the gate establishes presence at admission, not a guaranteed prize mix for all future selections.

If actual staging remains after all draws settle, the dashboard's bounded activation action calls the existing public FWA `activateListings(20)`; repeat while needed. This creates no Balancer compensation and spends only caller gas. Inspect actual active/staged records: a tracked count is not a proof that all records are selectable or that the target is complete. An operating deficit may instead need existing proceeds, Add ETH, a smaller target or closing. Do not add capital to cure a mere activation backlog.

If no curated item is active, let pending requests become ready or expire and process FWA's queue, activate the FIFO prefix through a curated item, then refresh its proof. The prefix can include arbitrarily many curated listings, so there is no fixed global activation-call bound. Anyone can perform these recovery calls; neither the keeper nor an automatic browser job is assumed to do so. Refresh alone does not cure a separate low-Shape-weight or funding condition.

## Stuck draws

FWA's randomness callback processes a draw only when it is the queue head and reserved no staged listing, so a Ready
draw behind the head, or one that reserved a staged restock, waits for an explicit `processAcquisitions`; Ready draws
never expire. Upkeep processes such a draw only after `processGraceBlocks` (default 50, about 10 minutes) from its
request block, or `pausedProcessGraceBlocks` (default 10) while sales are paused BUSY or LOW_INVENTORY, at most two per
call. FWA stores no fulfillment time; randomness arrives about three blocks after the request. The keeper is paid the
gas at the usual price rule plus one work fee per processed draw, besides the reconcile fee. Before the grace nobody is
paid for it; buyers or the FWA app usually process their own draw first.

A draw whose randomness never arrived (past its word deadline, or arrived late) is stuck too: after the same grace,
upkeep has FWA skip it as Expired, crediting the buyer's fee as refund credit, with the same pay, and the draws behind
it proceed. Upkeep never processes a head still inside its word deadline. Anyone can process expired draws sooner with
FWA's `processAcquisitions(5)`, unpaid.

## Dashboard results and transaction confirmation

**Pool lifetime operating ETH result** is owner proceeds less Shape/Pack backing won, Shapes mint fees and keeper pay. It includes previous creators' activity and excludes capital transfers, wallet gas and curated NFT valuations. Deposits and withdrawal recipients are listed by address for attribution only. All `depositETH()` and plain ETH contributions are irrevocable pool capital: the sender gets no protocol recovery or withdrawal claim, and the current creator may withdraw available surplus under the reserve rules without a holding period. Holdings and unattributed reconciliation are separate; an eventless ETH transfer is not inferred to be personal profit or a refundable donor balance.

Generic wallet actions confirm only when the included successful transaction matches the reviewed chain, sender, destination, calldata and value. Fee-only repricing is accepted. Cancellation, changed intent, revert and unavailable confirmation stop dependent steps. A failed lookup is unverified, not a successful action. Atomic creation retains its separate persisted, factory-and-pool-verified recovery path.

## Keeper service

Configure `FACTORY`, `FROM_BLOCK`, `RPC_URL=https://mainnet.gateway.tenderly.co`, `STATE_FILE`, and the keeper's signing identity through the existing environment/secret store, then run `npm run keeper`. Never place a private key in a command literal, file, or log. `KEEPER_ADDRESS` selects an unlocked account for isolated local forks only.

- Each tick discovers all pools created by the factory and reads each pool's effective economics (or, on a legacy community-v1 pool, its policy address), payment state and settings hash. It simulates the actual offered reward with fee fields and the same executable gas limit it would send, so economics changes need no keeper code change. Bidding caps are operator configuration; policy economics are learned only through bounded quotes and complete transaction simulation. No settings metadata is read.
- The send condition budgets execution expense, `OPERATING_COST_WEI`, and the configured `MAX_LOSS_WEI` (default 0.0002 ETH per attempted successful call). Setting the loss allowance to zero requests no modeled loss; it does not guarantee inclusion or profit. Failed attempts remain operator costs and are included in receipt stats.
- `eth_estimateGas` sets the executable limit with 30% headroom and a 4M floor, bounded by EIP-7825's 16,777,216. It is not the gas ultimately billed. An optional top-level `debug_traceCall` estimates billed expense; receipt comparisons report its calibration. If tracing is unavailable, estimation is conservative and may skip profitable work. No formula is recovered by dividing compensation or listing fees.
- Paid calls use `performUpkeep(settingsHash, minimumFixed, minimumGas)`: minimumFixed budgets operating costs, while minimumGas budgets traced/estimated billed gas less a conservative conversion of the configured loss allowance. The atomic floor follows the transaction's actual included gas price, avoiding false fixed-wei reverts when basefee falls. Stale settings, disabled payments, insufficient operating funds/allowance, or reward below the minimum reverts all work. Another caller can change work between simulation and inclusion, so atomic checks protect the minimum, not the operator's spent gas.
- Pending nonce state is saved before broadcast. Every replacement refreshes the settings hash, simulation, expense and gas limit, raises fees by 25%, and uses the same nonce only while the offer remains acceptable. Each hash keeps its own offered policy/payment for receipt attribution. Lost responses and node eviction recover without allocating a duplicate nonce. Do not delete pending state as a normal recovery step.
- Health: `GET http://localhost:8787/health`; per-pool errors do not stop unrelated pools. Discovery rescans a 64-block window and drops creations absent after a reorg. Receipt stats reconcile actual gas costs and received compensation.
- The persisted receipt journal covers 64 blocks and at most 1,000 entries. Recent orphaned receipts reverse their gas/reward counters; pending accounting survives a pool disappearing from discovery. Lost response hashes are recovered by the sender nonce using historical account reads and the actual canonical transaction. Historical-RPC failure retains the accounting entry and exposes an error. Reward events must originate from the tracked pool and name this keeper.
- `health.accounting` reports retry nonces, errors, coverage and `journalPrunedThrough`. `legacy-unverified` means pre-journal counters were not reconstructed; `history-unverified` means pruned/deep history requires external reconciliation. A normal `journal` status does not promise unbounded historical finality. If a genuinely different operator transaction consumes a tracked nonce, that external transaction is outside service financial totals. A later reorg of that external cancellation followed by original-upkeep reinclusion requires manual canonical reconciliation; there is no retained external-consumption tombstone. Do not clear state to conceal these limits.
- The accounting retry queue never broadcasts. If a reorg removes a pool and the node does not reinsert its orphaned transaction, an unconsumed nonce can block later sends. After the grace period health reports operator rebroadcast/cancellation required and `ok=false`. Inspect the chain, nonce and original decoded transaction before authorized recovery; no automatic cancellation spend is assumed. A node or peer may reinsert it, but that is not guaranteed service behavior.
- `MAX_GAS_PRICE_GWEI` is the operator's bid cap, `PRIORITY_GWEI` the requested tip. Reimbursement follows each pool's live effective economics. The community factory below was read on 2026-11-24 with a 1.5 gwei reimbursement ceiling and 0.05 gwei priority allowance; 5 gwei was an earlier setting. At basefee exactly the reimbursement ceiling a positive tip exceeds it; zero priority can execute at the ceiling if included. Inclusion and competition are not proven by fork tests.
- `CANARY_PLAN=<plan.json>` with `CANARY_PLAN_SHA256=<approved hash>` (the keeper refuses a file with another hash) makes every send and fee replacement pass `scripts/canary-guard.ts`: cumulative gross gas from canonical receipts of all plan accounts, plus in-flight and next maximums and reserved later actions, must fit the plan budget, otherwise the transaction is withheld. Without it the keeper has no aggregate spending limit. See [CANARY-PLAN.md](CANARY-PLAN.md).
- Use an account that retains its received ETH. A forwarding EIP-7702 delegation can pass keeper rewards elsewhere. Fund the sender for its transaction's gas limit times maximum bid; simulation does not supply this ETH.

### Mainnet community keeper on Fly.io

Owner decisions, 2026-11-24: Fly.io; a fresh dedicated EOA initially funded with **0.01 ETH**; `MAX_LOSS_WEI=0`; `MAX_GAS_PRICE_GWEI=1.5`; **no cumulative spending cap and no CANARY_PLAN**; Better Stack email alerts. This deployment services the creator-fee v2 factory `0x96fd7B2e83E04Ea2e78be415e0BC82A1332e7671` (2026-11-26), scanning from block `26499988`, plus the `community-v3` factory `0x6F018fF718Ab5A4287F937e4e4729Aa65610f53b` (owner() and setImplementation, 2026-11-24) and the `community-v2` factory `0x526FbD402624B50861f54c081B592cdCeE322929` (`LEGACY_FACTORIES=community-v3,community-v2`); community-v1 and v0 are excluded. It changes no pool economics or participant rights. Funding, setting secrets and starting the mainnet service are owner actions. Pushes, merges and deployments require the owner's explicit go.

`keeper/fly.toml` runs one 512 MB shared-CPU Machine in `iad`, with auto-stop and request-triggered auto-start disabled, an `always` crash restart policy, and an encrypted 1 GB `keeper_data` volume mounted at `/data`. `STATE_FILE=/data/keeper-state.json` survives replacement and restart. Keep exactly one Machine and one signer process: there is no distributed nonce lock. Deploying the Machine briefly interrupts polling. A volume is local to one host, not replicated storage; preserve its snapshots and inspect pending nonces before restoring an older snapshot. Crash restart does not fix an RPC outage, a stalled tick, or a host/volume failure; the external alerts are required.

The image uses the repository's lockfile and starts `npm run keeper`; `.dockerignore` allows only its runtime files and dependency manifests into the remote build. Its official `node:22-bookworm-slim` base follows patched Node 22 releases, so rebuilding the same source can change the base image; retain the deployed Fly image reference when recording a release. `KEEPER_PRIVATE_KEY` comes from Fly's encrypted secret store at runtime. `KEEPER_EXPECTED_ADDRESS` is a public signer check supplied by the deploy command. Do not set `KEEPER_ADDRESS` on Fly: it is for unlocked local forks. Do not set `CANARY_PLAN` or `CANARY_PLAN_SHA256` for this service. Never inspect the process environment or use verbose/debug CLI logging when handling secrets.

The launch planning figures are **not an observed traffic forecast**: at mainnet block 26,487,552 the factory had zero `BalancerCreated` events. A 3.2M-gas billed call costs 0.0048 ETH at 1.5 gwei; the keeper's minimum transaction gas limit of 4M requires **0.006 ETH upfront** at that bid cap. Larger estimates require more. Ten heavy runs per day would spend 0.048 ETH gross before compensation. Successful calls receive the simulated payment; reverts still cost gas, and `MAX_LOSS_WEI=0` does not guarantee profit. **0.007 ETH is the low-balance warning**, not a stop or cumulative cap. At the 0.01 ETH initial balance, multiple pending calls or a larger gas limit can exceed available working capital.

Fly's published October 2026 pricing implies about **$3.84/month** for shared-CPU 1x with 512 MB ($2.19 base plus 0.25 GB additional RAM at $6/GB-month) and a 1 GB volume ($0.15), before regional differences, network, snapshots, builders, taxes or account minimums. This is a planning estimate, not a spending authorization. Better Stack currently advertises ten free monitors with 3-minute checks. Sources: [Fly pricing](https://fly.io/pricing-update/), [volume limits](https://fly.io/docs/volumes/overview/), [secrets](https://fly.io/docs/apps/secrets/), [restart policies](https://fly.io/docs/machines/guides-examples/machine-restart-policy/), [health checks](https://fly.io/docs/reference/health-checks/), [Better Stack](https://betterstack.com/uptime).

#### First deployment: owner-run commands

Replace public placeholders before running. Each command is self-contained and starts in the main checkout; do not run deployments from a worktree. Code must first be reviewed, pushed and merged by the owner. `KEEPER_RELEASE` is the **full reviewed merge commit** now at `origin/main`, not the worktree commit before merging. Commands which create Fly resources incur costs. No command below requires a private key in an argument or a file.

Setup line (public values only):

```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer && export KEEPER_APP='<unique Fly app name>' KEEPER_ADDRESS='<fresh keeper EOA>' KEEPER_RELEASE='<reviewed 40-character origin/main commit>' RPC_URL=https://mainnet.gateway.tenderly.co
```

1. Create the fresh keeper EOA in your wallet, with no EIP-7702 delegation. In **Keychain Access**, create a generic-password item with service/name `shapes-community-keeper` and store its key there yourself. Keep wallet backups in your existing secure system. Check the public address and chain before funding:

```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer && export KEEPER_ADDRESS='<fresh keeper EOA>' RPC_URL=https://mainnet.gateway.tenderly.co && test "$(cast chain-id --rpc-url "$RPC_URL")" = 1 && test "$(cast code "$KEEPER_ADDRESS" --rpc-url "$RPC_URL")" = 0x && cast nonce "$KEEPER_ADDRESS" --rpc-url "$RPC_URL" && cast balance "$KEEPER_ADDRESS" --ether --rpc-url "$RPC_URL"
```

Check: chain is 1, code check succeeds, and a fresh account has nonce 0. A delegated account fails the code check. Confirm the address independently in the wallet; a typing check does not prove ownership.

2. Fund the account **only after reviewing**: Ethereum mainnet, your funding signer, recipient `KEEPER_ADDRESS`, empty calldata, native value **0.01 ETH**, maximum gas 21,000 and maximum fee 1.5 gwei. Confirm the hardware wallet's decoded transfer; stop on any mismatch. This is an owner transaction, separate from keeper startup:

```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer && export KEEPER_ADDRESS='<fresh keeper EOA>' FUNDING_ADDRESS='<your Ledger funding address>' RPC_URL=https://mainnet.gateway.tenderly.co && test "$(cast chain-id --rpc-url "$RPC_URL")" = 1 && test "$(cast code "$KEEPER_ADDRESS" --rpc-url "$RPC_URL")" = 0x && cast send "$KEEPER_ADDRESS" --from "$FUNDING_ADDRESS" --ledger --value 0.01ether --gas-limit 21000 --gas-price 1.5gwei --priority-gas-price 0.05gwei --rpc-url "$RPC_URL" && cast balance "$KEEPER_ADDRESS" --ether --rpc-url "$RPC_URL"
```

Check: receipt succeeds and the recipient balance increased by exactly 0.01 ETH; confirm the receipt's sender, recipient, value and chain. With an existing keystore use `--account <existing keystore name>` instead of `--ledger --from ...`; do not export a raw key.

3. Authenticate Fly using its normal browser flow, then create the app in the intended organization:

```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer && export KEEPER_APP='<unique Fly app name>' FLY_ORG='<your Fly organization slug>' && fly auth login && fly apps create "$KEEPER_APP" --org "$FLY_ORG"
```

Check: the account/organization and new app name match your intended production account. No Machine is running yet.

4. Create one encrypted volume in the configured region:

```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer && export KEEPER_APP='<unique Fly app name>' && fly volumes create keeper_data --app "$KEEPER_APP" --region iad --size 1 && fly volumes list --app "$KEEPER_APP"
```

Check: exactly one `keeper_data` volume exists in `iad`; scheduled snapshots are enabled. Do not repeat this command on redeployment.

5. Stage the signing secret from the Keychain item. The Python process captures it in memory, validates its shape, and passes it directly to Fly's stdin. The value is never a shell argument, terminal output, environment file or build input. Do this in your own terminal with shell tracing/debug logging disabled:

```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer && export KEEPER_APP='<unique Fly app name>' && python3 -c 'import re,subprocess,sys; key=subprocess.check_output(["security","find-generic-password","-w","-s","shapes-community-keeper"],text=True).strip(); assert re.fullmatch(r"0x[0-9a-fA-F]{64}",key), "Keychain value must be a 0x-prefixed keeper key"; subprocess.run(["fly","secrets","import","--app",sys.argv[1],"--stage"],input="KEEPER_PRIVATE_KEY="+key+"\n",text=True,check=True)' "$KEEPER_APP" && fly secrets list --app "$KEEPER_APP"
```

Check: Fly lists the **name** `KEEPER_PRIVATE_KEY` with a digest/staged status. It must never show the value. Staging does not start the keeper. If the CLI asks for unexpected debug output or a secret value is exposed, stop and rotate it before funding or startup.

6. Start the keeper after the owner has merged the PR and approved this release and its continuing gas spend:

```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer && export KEEPER_APP='<unique Fly app name>' KEEPER_ADDRESS='<fresh keeper EOA>' KEEPER_RELEASE='<reviewed 40-character origin/main commit>' && ./keeper/deploy.sh
```

Check: the wrapper requires the main checkout on `main`, clean tracked files, fetches and fast-forwards only, and requires `HEAD == origin/main == KEEPER_RELEASE`. It refuses more than one existing Machine and deploys with `--ha=false`. Startup must report chain 1, the exact factory and public keeper address, and a successful tick with a discovered pool count, initially possibly zero. The signer code check must pass. Do not interpret a successful deploy as a successful pool lifecycle.

7. Inspect the running deployment and health without inspecting environment variables:

```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer && export KEEPER_APP='<unique Fly app name>' && fly status --app "$KEEPER_APP" && fly checks list --app "$KEEPER_APP" && curl --fail --silent --show-error "https://${KEEPER_APP}.fly.dev/health" && fly logs --app "$KEEPER_APP" --no-tail
```

Check: exactly one running Machine, a successful recent tick, expected public signer and factory, balance at least 0.007 ETH, no stuck pools or accounting errors, and persistent state at `/data/keeper-state.json`. Discovery logs name each new pool. With no community pools, a successful tick reporting zero pools is expected. When the first pool exists, confirm `listedShapePrizes` reaches its target and `admissionStatus()` becomes 0 on mainnet; first listing waits for basefee at or below 1 gwei and can also wait for profitable quotes or sufficient pool capital.

8. When the first community pool exists, read its factory, target, listed inventory and status directly from mainnet:

```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer && export PUBLIC_BALANCER='<first community Balancer address>' RPC_URL=https://mainnet.gateway.tenderly.co && READ_BLOCK="$(cast block-number --rpc-url "$RPC_URL")" && printf 'Mainnet read block: %s\n' "$READ_BLOCK" && cast call "$PUBLIC_BALANCER" 'factory()(address)' --block "$READ_BLOCK" --rpc-url "$RPC_URL" && cast call "$PUBLIC_BALANCER" 'target()(uint256)' --block "$READ_BLOCK" --rpc-url "$RPC_URL" | python3 -c 'import sys; target=int(sys.stdin.read().split()[0],0); counts=[(target>>(16*d))&65535 for d in range(16)]; print("Target counts:",counts,"Total prize units:",sum(counts))' && cast call "$PUBLIC_BALANCER" 'listedShapePrizes()(uint256)' --block "$READ_BLOCK" --rpc-url "$RPC_URL" && cast call "$PUBLIC_BALANCER" 'getActiveShapes()(uint16[16])' --block "$READ_BLOCK" --rpc-url "$RPC_URL" && cast call "$PUBLIC_BALANCER" 'admissionStatus()(uint8)' --block "$READ_BLOCK" --rpc-url "$RPC_URL"
```

Check: factory is `0x96fd7B2e83E04Ea2e78be415e0BC82A1332e7671`, active counts match every target count, `listedShapePrizes` equals the summed target counts and status is **0**. Retain the block and successful keeper transaction hash as evidence. A first pool that has not yet been created leaves this acceptance item pending; do not create or fund a mainnet pool just to obtain a passing result.

9. Configure the four HTTP monitors below in your Better Stack account and choose your email recipient there:

```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer && export KEEPER_APP='<unique Fly app name>' && open 'https://betterstack.com/uptime' && printf 'Monitor base URL: https://%s.fly.dev\n' "$KEEPER_APP"
```

Check: use GET and expected status 200, free 3-minute frequency, recovery email enabled, and no maintenance window during normal operation. Use Better Stack's test-notification action and verify the email arrived. No API token is required in the keeper. Do not publish a public status page containing operational details unless you intend to.

| Monitor | Path | Failure and response |
| --- | --- | --- |
| Keeper unavailable | `/health/live` | Process or public endpoint unavailable. Inspect Fly Machine status, host/volume status and logs; restart or recover only after checking the old process is stopped. |
| Keeper tick stale | `/health/tick` | No successful tick for 120 seconds. Inspect RPC/discovery/persistence failures and the last block. A healthy HTTP server is not successful keeper work. |
| Keeper low balance | `/health/balance` | Balance below 0.007 ETH, or no usable balance observation. Inspect pending commitments and top up the same public signer if needed. The warning does not stop spending. |
| Keeper pool failures | `/health/pools` | At least 5 consecutive errors for one pool (`STUCK_TICKS=5`), or unresolved receipt-accounting errors. Inspect pool/error/nonce fields. Other pools continue; preserve state and reconcile before replacing or cancelling anything. |

`/health` combines the operational checks. Fly uses `/health/live` for routing so a low balance or stuck pool does not hide diagnostic responses; its separate `keeper` check records `/health`. Free external checks can add up to about three minutes after the 120-second stale threshold, plus provider verification/delivery time. First-list gas waits, no profitable work, and an empty factory are normal skips and do not count as stuck errors. A healthy service does not promise every pool is funded or open.

#### Routine actions: owner-run commands

1. **Inspect and read recent logs**:

```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer && export KEEPER_APP='<unique Fly app name>' && fly status --app "$KEEPER_APP" && fly logs --app "$KEEPER_APP" --no-tail && curl --silent --show-error "https://${KEEPER_APP}.fly.dev/health"
```

Check: compare pending nonces, last tick/block, balance, pool errors and receipt gas/reward totals. Logs are structured JSON; `tick complete` shows that discovery ran even with zero pools. Do not use `printenv`, process dumps or shell tracing.

2. **Pause**. Read the Machine ID from `fly status`, disable crash restart and request-triggered start, then stop that Machine; do not scale to zero or destroy its volume:

```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer && export KEEPER_APP='<unique Fly app name>' KEEPER_MACHINE='<Machine ID from fly status>' && fly machine update "$KEEPER_MACHINE" --app "$KEEPER_APP" --restart no --autostart=false --skip-start --yes && fly machine stop "$KEEPER_MACHINE" --app "$KEEPER_APP" && fly machine status "$KEEPER_MACHINE" --app "$KEEPER_APP"
```

Check: Machine state is stopped, restart policy is `no`, and state/volume remain. Already-broadcast transactions may still mine; pausing cannot recall them. Set a deliberate monitor maintenance window only after confirming this intended stop. Never kill the process inside the VM to pause an `always`-restart service.

3. **Resume or redeploy** with the reviewed merged release, using the same address and state volume:

```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer && export KEEPER_APP='<unique Fly app name>' KEEPER_ADDRESS='<current keeper EOA>' KEEPER_RELEASE='<reviewed 40-character origin/main commit>' && ./keeper/deploy.sh && fly checks list --app "$KEEPER_APP"
```

Check: exactly one Machine starts, restart policy returns to `always`, the old state resumes and no duplicate nonce is sent. Recheck health and discovery logs and end the deliberate monitor maintenance window. Do not run `fly launch`, add a replica or deploy from a worktree.

4. **Top up**. Review an Ethereum mainnet transfer from your funding signer to the existing public keeper address, empty calldata, native value **0.01 ETH**, maximum gas 21,000 and fee 1.5 gwei, then confirm it yourself:

```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer && export KEEPER_ADDRESS='<current keeper EOA>' FUNDING_ADDRESS='<your Ledger funding address>' RPC_URL=https://mainnet.gateway.tenderly.co && test "$(cast chain-id --rpc-url "$RPC_URL")" = 1 && test "$(cast code "$KEEPER_ADDRESS" --rpc-url "$RPC_URL")" = 0x && cast send "$KEEPER_ADDRESS" --from "$FUNDING_ADDRESS" --ledger --value 0.01ether --gas-limit 21000 --gas-price 1.5gwei --priority-gas-price 0.05gwei --rpc-url "$RPC_URL" && cast balance "$KEEPER_ADDRESS" --ether --rpc-url "$RPC_URL"
```

Check: successful canonical receipt and a 0.01 ETH recipient increase after allowing for any keeper activity in between reads. Health observes the balance on its next successful tick; the email incident then recovers at the next monitor check. A failed fee/inclusion attempt does not authorize increasing the bid ceiling.

5. **Rotate the key**. First pause with routine step 2. Reconcile every tracked pending/accounting nonce on the old signer against mainnet receipts; an old pending transaction must be resolved before a new signer starts. Archive the old public health/state history on the existing volume. Create a new non-delegated EOA, fund it through first-deploy steps 1–2, and replace the Keychain item yourself. Run first-deploy step 5 to stage `KEEPER_PRIVATE_KEY`; never retrieve or print the old secret from Fly. Use a **new state filename** on the same volume; do not reuse, edit or delete the old signer's pending journal:

```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer && export KEEPER_APP='<unique Fly app name>' KEEPER_ADDRESS='<new keeper EOA>' && fly secrets set "STATE_FILE=/data/keeper-state-${KEEPER_ADDRESS}.json" --app "$KEEPER_APP" --stage
```

Check: this staged value is a public path, not a private key. Only after old pending transactions are reconciled and the new key/address are checked, use routine step 3 with the new public address. Health must report the new signer and an initially fresh journal; discovery rescans from the factory deployment. New signer stats do not replace the old signer's financial history. Returning unused ETH from the old signer is a separately reviewed owner transaction.

6. **Failure recovery**. Do not erase state, reset nonces, restore an old snapshot or launch another signer to clear an alert. Read the health JSON and canonical receipts first. If code rollback is needed, pause, review state-format compatibility and prepare an explicit rollback PR on a worktree; merge it and redeploy through routine step 3. A restart does not repair depleted pool funds, an external protocol pause, oracle failure, or a permanently unresolved transaction.

## Working capital and depleted inventory

[RESERVES.md](RESERVES.md) defines the current target: missing inventory and its current setup work, actual outstanding reconciliation and one maintenance buffer. No whole-board future payment cycle or duplicate largest prize is held. Unsold fees shown in the dashboard are future income, not deposit ETH.

Paid work can consume the buffer, and partial targets may trade while the real weight gate permits. If admission is paused and no proceeds remain, further demand cannot restart it. Use Add ETH, reduce the target or close. A large missing prize may take an unknown number of actual purchases to replenish; do not assume automatic creator deposits or NFT replacement. The dashboard identifies missing prizes and actual withdrawable capital.

Disabling paid upkeep releases keeper-related holds, but setup then requires an unpaid caller paying gas. Re-enabling is immediate and funded. Current gas determines budgets; a later gas or mint-fee increase can require additional working capital. Creator credit is excluded from every paid and unpaid mint/payment affordability check. It stays withdrawable during depletion. Collection uses the stored revenue rate; listing turnover never recomputes that rate.

## Collect and claim earnings

`collectProceeds()` permissionlessly pulls actual FWA owner proceeds and credits the stored creator percentage, even
after closing. `creatorCredit()` is accrued withdrawable earnings, separate from capital surplus. Claim any amount up
to it using `claimSurplus(amount, to)` without collecting or reading a policy/reserve/mint fee. The earnings button
remains available when quotes or historical RPC scans fail. A larger capital withdrawal requires the full reserve.

To change allocation, the creator explicitly calls `setCreatorRevenueBps(newBps)` (0 to 10,000): it collects available
proceeds at the old rate and then saves the new one. Pending purchases collected afterward use the new rate. Inventory,
markup, gas and policy changes never change it. At 100%, all collected revenue is earnings; operations receive none.
History and failed-delivery discovery load separately with their own errors. A historical failure is a gap in that
history view, not a reason to disable current claims, maintenance, closing or policy recovery.

## Change a pool's keeper economics

A pool uses one of two economics sources (R96): **follow** (the factory's current `economics()`, the default for new
pools) or **local** (its own values). "Pin current factory values" in the app is a local save of the factory's values
shown to the creator. Pay and restocking prices are the in-library formula over these numbers (R95); there is no
policy contract to choose. Every change below takes effect in its own transaction, increments `policyGeneration` and
emits `EconomicsSelected`.

1. Read `effectiveEconomics`, `policyMaxReward`, `paidUpkeepEnabled` and `maintenanceFunding(e)` for the full economics
   `e` you intend to use.
2. `maintenanceFunding(e)` returns `e`'s maintenance budget at the current state and the operating cash it lacks. While
   paid upkeep is on, a change is refused (`ReserveNotFunded`) only when `e`'s budget exceeds the current one and
   operating cash is below it; a nonincrease needs nothing. Deposit only the shortfall with `depositETH()`. Missing
   prize capital never enters this check; existing prices and creator credit stay unchanged.
3. Creator: `setLocalEconomics(e)` sets every value at once and stops following factory changes. To pin, pass the
   factory's current `economics()` read at the block you reviewed. A paused grace longer than the normal one reverts
   `InvalidGrace`. Paid upkeep is unchanged: a disabled pool stays disabled, and no funding check runs while it is
   disabled.
4. Creator: `setPaidUpkeepEnabled(false)` stops paid upkeep immediately. `setPaidUpkeepEnabled(true)` re-enables it
   only if operating cash covers the effective economics' full maintenance budget. No factory change re-enables a
   stopped pool. A creator transfer keeps the economics source and the disabled state.
5. `followFactoryEconomics()` returns to the factory's current values, under the same funding check as step 2. The
   spending bucket (`setKeeperBucket`) is separate and none of these change it.

Only the factory admin (`policyAdmin`, trusted, R97) may change the factory economics, with `setEconomics` (immediate;
followers use the new values at their next operation, local pools are unaffected), the default spending bucket for
future pools, with `setDefaultBucket`, and the product limits, with `setProductLimits`. The keeper admin cannot change
any pool's economics.

## Keeper economics and purchase limits

- FWA's VRF service draws on one Chainlink subscription shared by all FWA pools and refuses a purchase its balance
  cannot cover (`InsufficientVrfCoverage`). Purchases can stop before a pool reaches its backlog threshold
  (T + 4 outstanding draws).
- Paid upkeep reimburses gas at no more than the pool's effective `gasPriceCeiling`: the factory started at 5 gwei;
  the mainnet community factory was read at 1.5 gwei on 2026-11-24. A pool may use different local economics.
  The operator separately caps its bid and simulates the offered payment; above its permitted or profitable bid it
  skips work, leaving `performUpkeepUnpaid()` available until conditions change.
- A pin (`setLocalEconomics(factory.economics())`) freezes the factory values read at that moment; a factory change
  mined between the read and the pin is not included. `setLocalEconomics(e)` sets the pool's own values and detaches it
  from later factory changes; `followFactoryEconomics()` rejoins.
- A creator's local `restockFlat` raises the restocking surcharge, and with it the pool's listing prices, beyond the
  markup range; buyers see and pay that price.

## Unavailable payment

Use `performUpkeepUnpaid()`. It pays zero and prices new listings with the same formula as paid upkeep (R95; the former broken-policy fallback no longer exists). It remains public under keeper restrictions. No assets migrate. Existing listings retain their original prices. Inventory still needs capital, and dependencies' own pause/settlement restrictions remain effective.

## Failed NFT delivery

FWA quarantines a drawn NFT that cannot be transferred (status `DeliveryPending`). Anyone may retry via FWA
`retryNFTDelivery(listingId)` for 7 days. After that the purchaser may `refundFailedDelivery`. The dashboard lists failed
deliveries from `ItemDrawn` events. The creator recovers a refunded item with `recoverRefunded(listingId, to)`: a curated
NFT goes to `to`, and a drawn prize is redeemed here for its backing. Upkeep never calls curated collections, so a hostile
collection cannot tax keepers. If the collection blocks the transfer, retry later. If the purchaser never refunds, the NFT
stays in FWA's delivery escrow (FWA behavior). The gate refuses the Balancer, the Shapes contract, the Draw Packs contract
and the pool as purchasers, so prize deliveries cannot fail with mainnet Shapes or Draw Packs. Do not list collections
that refuse transfers to contracts: a purchaser contract that never refunds can lock such an NFT in FWA escrow (the
dashboard warns before listing). List only collections you trust: one whose contract can move, burn or freeze tokens can
take a listed NFT out of FWA or block its withdrawal; the dashboard says so beside the listing form.

## NFT sent to the Balancer directly

`recoverUntrackedNFT(collection, tokenId, to)` (creator) returns any NFT the Balancer owns outside FWA. Listed NFTs and
pending deliveries are owned by the FWA pool and cannot be taken this way.

## Shapes mint fee change

The Shapes admin can change `mintFee` up to 0.01 ETH. A rise pauses purchases and restocking (status 5) until the creator
runs `configure(markupBps, target)` again to accept the new fee, with the reserve funded for it. Planner and simulation
show when a fee makes the configuration uneconomic.

## FWA changes

- The Balancer only creates pools on the reviewed implementation and code hash. If FWA rotates its implementation, new
  Balancer creation reverts; existing pools are unaffected (FWA clones keep their implementation).
- FWA `globalWithdrawOnly` or retirement: FWA refuses new purchases and listings, so upkeep stops restocking; proceeds
  collection, `unlistShapes` and withdrawals still work.

## Recover all capital

1. `close()`.
2. Allow randomness or expiry. Process expired draws with FWA's `processAcquisitions(5)` (upkeep processes stuck
   draws only after the grace), then run `performUpkeepUnpaid()` until outstanding draws are reconciled.
3. `unlistShapes(listingIds)` until no prizes are listed (prize listing ids come from `getActiveIds` /
   `getActiveShapes`; it withdraws and redeems each prize for exact backing, up to 20 per call).
4. `withdrawCurated(listingId, to)` for each curated NFT; `recoverRefunded(listingId, to)` for any refunded one.
5. `collectProceeds()` separately, then `claimSurplus(withdrawableSurplus(), to)`; while closed everything is claimable except the current operation-sensitive reconciliation budget for each actual unreconciled draw while paid upkeep remains enabled. Run upkeep (or wait for a keeper), then claim the rest.
6. Optional and permanent: `retire()`.

## FWA pool page

On mainnet the dashboard's "FWA pool page" form approves FWA's exact publication message on the Balancer
(`approvePoolPage`) and then submits the page to `pools.fwa.fun/api/fwa/profile` with a placeholder signature; FWA's
server is expected to verify it through ERC-1271 (`isValidSignature`). This is unconfirmed with FWA. If FWA rejects it,
ask FWA to support contract owners or to add the creator as an editor for the pool. Purchases do not depend on the page.

## Creator key change

`transferCreator(new)` then `acceptCreator()` from the new address. Setting `new` to zero cancels.
