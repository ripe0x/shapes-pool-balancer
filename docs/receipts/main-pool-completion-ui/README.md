# Main pool app: final local UI acceptance

**Local integration evidence, unsigned.** Two actual writable UI flows completed against the source-R main pool candidate on chain **31337**, RPC `http://127.0.0.1:18647`, vault `0xb0858bf1b8a167188847499b3008e597b57eaebc`. Sixteen UI wallet transactions have successful actual receipts. At block **26,484,944**, the holder has zero shares, locked shares, priced claims and pending deposits; the vault has zero open listings and idle packs; every tested payer refund, IDs 7–11, is zero after explicit claims. This is not production launch or economic approval.

The preview ran at `http://127.0.0.1:5217` with local-only main-pool interactivity and the unlocked checked local actor `0x37Dcd875c4E367e080f1e05F18F10dB0D45a65B5`. The wallet transport uses the real local RPC for estimates, submission and receipts. Hardware/extension-wallet confirmation UX was not exercised. `MAIN_POOL_OPEN=false` remains in product source. No public transaction, public mint-fee change, live cutover or merge occurred.

## Exercised flows

1. **Cancellable/liquid flow:** actual 0.1 ETH wallet deposit; a positive one-wei total exit limit rejects an executable cancellation with **zero submission writes**; explicit 0.01 ETH cap permits cancellation; a second actual 0.1 ETH deposit is priced by a genuine paid normal checkpoint; the UI requests all shares, submits unpaid recovery pricing, claims priced ETH, and separately claims all unused payer sponsorship.
2. **Productive book flow:** actual 1 ETH wallet deposit; a genuine funded paid checkpoint; **one real launch pack containing three paid 0.01 ETH Shapes**, 0.21 ETH backing and **0.003 ETH actual creator mint fees**; after the real crown delay/quiet-window conditions, the UI requests all shares, unlists the actual position, redeems its actual pack, calls unpaid `recoverCheckpoint`, claims priced ETH, and separately claims every remaining contribution refund. No position, claim or payer refund remains.

The paid checkpoints and build used the existing keeper/deployment harness, not a fabricated counterparty or substituted successful service response. Only isolated fork time was advanced to valid protocol windows. No extra sponsorship topup was required. The build receipt used 1,903,900 actual gas; this UI context is separate from cold receipt calibration. Setup transaction receipts and before/after states are [recorded here](completion-productive-ui-setup.json), with the first checkpoint [recorded separately](completion-ui-checkpoint.json).

The first refund click uses the current bounded contribution page. A newly closed request-era refund became visible after refreshing that page, so each case explicitly claimed its remaining tail. The final disabled refund button and pinned contract reads confirm completion. Refunds are separate wallet transactions outside the durable exit-step cap, as the completion UI states.

## Exact wallet costs and returned capital

All values below are **wei**. Gas is actual `receipt.gasUsed × receipt.effectiveGasPrice`. Returned ETH is independently derived from the isolated actor's before/after balances plus actual gas and attached values. The productive setup's mint fees and keeper compensation are borne inside vault accounting and are therefore reflected in returned capital; the separate setup receipt records identify them. Refund-claim gas is included in wallet gas, not omitted.

| Observation | Cancellable/liquid case | Productive book case |
| --- | ---: | ---: |
| Blocks | 26,484,918 → 26,484,929 | 26,484,929 → 26,484,944 |
| UI wallet transactions | 8 | 8 |
| Attached ETH sent | 200045006170500000 | 1000045001108000000 |
| Actual wallet gas cost | 1447924662319679 | 1829128882751420 |
| Actual returned ETH | 199879959782818725 | 996765912624148080 |
| Net wallet change, including gas | -1612971050000954 | -5108217366603340 |
| Separate refund-claim transactions | 2 | 2 |
| Refund-claim wallet gas, included above | 192629333193836 | 152220143462910 |

The durable flow limit stayed **0.01 ETH** across both cases. After the first case, signed maxima reserved `1101127368833423` wei; after the productive case the cumulative reserved maximum was `3387874407673575` wei, still below the `10000000000000000` wei limit. Refunds/claims and lower receipt costs did not replenish that maximum. The recorded cap observations cover cancellation, redemption request, unlisting, pack redemption, recovery checkpoints and priced claims. Deposits and the explicitly separate refund claims have their own wallet transactions.

The UI wallet priority allowance in these transactions is approximately **1 gwei**, while the local block base fee was low. These costs must not be presented as the main keeper's 0.2/0.5 gwei economic experiment or extrapolated to an APR. Both rows are complete actual wallet outcomes for these stated inputs, not promised depositor returns.

See [all sixteen full transactions and receipts, balance arithmetic and zero-liability assertions](final-all-ui-receipts.json), [durable cap observations](saved-cap-states.json), and the [productive UI steps](productive/final-exit.json).

## Frozen inputs and final batch

[The 70-file app/dependency manifest](final-app-source-manifest.json) binds the app/shared/scripts sources, package/lock and TypeScript/Vite settings. The only change after starting the UI flow was the root-owned exporter's non-writing `--check` helper; runtime UI files stayed unchanged. All 70 hashes were checked again after the batch. [The source-R runtime context](core-runtime-context.json) binds eight current main-core source hashes and five actual local runtime bytecode hashes at block 26,484,944. It selects the latest R context from the append-only campaign log, not an earlier deployment phase.

One final affected batch ran after both UI flows, with exact commands/status and timing in [final-app-batch.json](final-app-batch.json):

| Check | Command | Exit/result |
| --- | --- | --- |
| Generated ABI/default freshness | `SHAPES_FWA_POOL=/Users/dd/CascadeProjects/shapes-fwa-pool-completion node scripts/export-main-pool-abi.mjs --check` | 0 |
| TypeScript | `npm run typecheck` | 0 |
| Affected app tests | `npx vitest run app/src/main-pool.test.ts app/src/main-pool-settings.test.ts app/src/main-pool-exit.test.ts app/src/errors.test.ts app/src/creation.test.ts app/src/creation-replacement.test.ts app/src/chain.test.ts app/src/policy.test.ts` | 0; **51 passed, 10 skipped** |
| Production app build | `npm run build:app` | 0 |
| Stale generated ABI negative | Absolute exporter with `--check`, in a temporary cwd containing copied generated files plus stale text appended only to the copied ABI | **1 expected**, explicit stale-output rejection |

The negative check changed no real generated file. The exporter verifies ABI and defaults against the actual compiled main candidate and manager values without writing. Ten existing opt-in service tests were skipped because their live community-creation/replacement/policy, wallet-fallback or backup-RPC inputs were not supplied. The main-pool, settings, exit and error tests passed. The build retains the existing warning about chunks larger than 500 kB. No additional broad run was performed.

This slice changed no app behavior and required no app repair. The `src/` community contracts, `keeper/`, `deployments/`, community `shared/abi.ts`, route host `app/src/App.tsx` and chain-selection `app/src/chain.ts` have no working-tree diff. Main integration remains isolated from community contract/route behavior. The local preview's main manager factory was `0x67bc465229c9b1c92f5efbbf0f3d61aec91a496f`; the existing community factory selection stayed `0x91C31Ad620555DE24e62290906aD1aA14C4CE281`.

## Screenshots and harness

- [Actual positive one-wei cap refusal](cheap/final-cap-refusal.png).
- [Actual listed pack before productive exit](productive/inventory-before-exit.png).
- [Productive holder exit and all refunds complete](productive/final-refunds-complete.png).
- [Existing desktop](desktop-compact-status.png) and [mobile](mobile-compact-status.png) layout checks.
- [Eight earlier read-only interactions](interactions-read-only.json), including owner settings review/reset, all 28 named gas fields, manager state and community navigation; [layout observations](layout.json).

The captured drivers are `final-flow-owned.cjs`, `final-refund-tail.cjs`, `productive-flow.cjs` and `productive-refund-tail.cjs`. They require the explicitly prepared isolated node/preview and existing local actor; they are not a second deployment path or a public-network transaction tool. `run-final-app-batch.py` records the single final batch. `capture-final-receipts.py` reads the pinned local chain and proves completed wallet accounting. Hardware wallets, acquisition/VRF renewal UI, explicit checkpoint topup, and a multi-checkpoint partial-fill UI are outside this bounded acceptance run; underlying core/CLI verification is separate.

## Things that don't make sense

- Some separately claimed refunds are smaller than their wallet gas expense at the selected roughly 1 gwei priority fee. The receipt table includes that expense; the user explicitly chose each wallet transaction. No profitable-refund or positive-return claim follows.
- Initial harness setup found a missing requested Playwright browser revision and a stopped prior preview; the existing Chromium 156 shell was reused and a task-owned local preview was started. One CLI read used the wrong return arity before checking the actual ABI. The evidence binder initially selected an earlier campaign context and was corrected to the latest source-R context with actual runtime readbacks. These were harness issues, not failed protocol/UI transactions. Details are retained in [the harness limitations record](ui-harness-limitations.json) and the two setup-failure logs.
