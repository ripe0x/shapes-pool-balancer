# Current candidate local rehearsal

This route prepares and executes one new protected-revenue candidate on a fresh, task-owned Anvil fork with synthetic actor funds. It uses `script/deploy.sh` and `script/Deploy.s.sol`, the production `Keeper`, and the prepared-node entry point in `keeper/rehearsal.ts`. It neither inherits archived local approval nor grants production approval. The historical plan validators, archived driver and production asset-flow/signature gate remain intact.

## Authority and preparation

The current owner request ([R70](../OWNER-REQUIREMENTS.md)) authorizes a fresh bounded rehearsal on an owned isolated fork and delegates routine choices. The packet makes those choices concrete: a free loopback port from 18786–18795, chain 31337, Tenderly's public mainnet upstream, the actual current fork block/hash, eight synthetic test actors `0x1e001` through `0x1e008`, decoded deployment actions and fixed limits below. Existing listeners are preserved. Preparation starts an unfunded node and performs a read-only Forge simulation; it never funds, unlocks, mines or submits transactions.

```sh
node --import tsx scripts/current-local-rehearsal.ts --prepare
```

Preparation writes `docs/receipts/current-rehearsal/<id>/bounded-plan.json`, decoded deployment actions, read-only simulation output and pristine-node preflight. The plan binds the original repository path and revision; exact source, scripts, application helpers, build and package inputs; initialized clean recursive dependency commits; the actual Node/Forge/Anvil/solc binaries and installed dependency lock; compiled artifacts; simulated deployment arguments/actions; and driver scenarios. Evidence outputs are excluded to avoid circular hashes. Original source and staged execution bytes are rechecked, including `app/src/creation.ts`, `refresh.ts`, `revenue-rate.ts` and `App.tsx`.

Review this new packet and its exact hash before execution. A hash is an exact-material control, not a signature or independent source of owner authority. No source mismatch is waived. A changed runtime input requires a new packet. A partial execution leaves its journal and stops; this route does not resume or replay it automatically.

```sh
CANDIDATE_RUN=1 node --import tsx scripts/current-local-rehearsal.ts \
  --plan <absolute-bounded-plan.json> --approved-plan-hash <exact-new-plan-hash> --execute
```

The execution controller supplies the same packet/hash to the explicit canonical wrapper route. That route accepts only the exact local Forge arguments, three named administrative addresses, owned node PID/command and pristine fork state. It cannot select a production signer, alternate RPC, relay, resume mode or arbitrary Forge arguments. Every submitted action retains nonce, decoded function, input, value, gas limit, receipt, inclusion basefee and readbacks. Unexpected status, unknown transactions, changed source or exhausted limits stops dependent work.

## Fixed bounds

| Item | Limit |
| --- | --- |
| Synthetic initial actor funding | 8.63 ETH total; no later top-ups |
| Capital deposited in two Balancers | 2 ETH total: 1.5 ETH and 0.5 ETH |
| All transaction gas, including deployment, coordinator and negative probe | 1 ETH |
| Reserved for closeout until the closeout phase | 0.1 ETH within the 1 ETH gas limit |
| Buyer purchase payments | 5 ETH |
| Buyer edge and VRF sublimits | 1 ETH each, within buyer payments |
| Fee cap | 20 gwei maximum; 0.05 gwei priority |
| Per transaction gas | 16,777,216 |
| Draws | 160 maximum; 158 planned |
| Main exercise | 50 rounds, 150 draws, plus declared lifecycle probes |
| Time changes | One 172,801-second policy-delay jump; at most 1,000 mined timing blocks |
| Negative creation | One value-zero transaction, 5,000,000 gas maximum, rate 10,001 bps |

Only external synthetic actors are funded. The real integrated FWA, Shapes, randomness service and coordinator state/balances are never fabricated. The existing real coordinator is temporarily impersonated solely for explicitly controlled callbacks and pays its own gas from its actual balance; no live randomness claim follows.

## Acceptance and limits

The fresh driver covers approvals and atomic creation with no minting, bounded paid fill, separate concurrent purchases, replenishment while another draw remains pending, actual draw delivery, explicit collection under the stored rate, credit claims while the one-ETH prize remains unfunded, creator-selected replacement policy without `settings()`, activation with an inventory deficit, and unpaid protection at zero operating cash. It also exercises a real pending and then reverted factory transaction through the production creation-recovery helper before the normal valid atomic creation. Rate 10,001 encodes as `uint16` but is rejected by the real initializer; the failed transaction must move no NFT and leave no registered clone.

The first round leaves two completed shape draws unreconciled and withdraws the original curated witness, reaching admission status 7 while another curated nft remains active. The buyer pays for one proof refresh, then completes a real resumed purchase before upkeep. The driver verifies that the refresh changes no pool funds, creator credit, keeper balance, settings or reconciliation, and restores the withdrawn nft at its original price. The Solidity scenario separately covers public activation when the replacement curated nft is still staged.

Closeout includes a real draw fulfilled after closing, a separate real selection timeout and purchaser refund withdrawal, queue settlement, unsold curated NFT return, Shape/Pack backing redemption, final creator claims and retirement. Actual FWA cash must equal its owner proceeds, purchaser escrows/refunds and protocol-fee obligations. Each Balancer's full cash cycle and collection-based credit are replayed from actual events and close exactly to the wei. Keeper rewards and all keeper gas reconcile with the real account balance.

Unsold curated returns are ordinary closeout, not failed-delivery recovery. A newly forced hostile-NFT failed-delivery path is not part of this fresh scenario; separate earlier receipt evidence remains distinct. The trusted Shapes transfer does not call its receiver, so a failed Shape-delivery/backing-refund branch is not forced. Controlled coordinator choices are not live oracle evidence; controlled production-Keeper ticks are not CLI timing evidence; unlocked synthetic actors are not wallet-extension signature evidence. The prior standalone keeper rehearsal and browser interaction receipts retain their own scope.

Preparation and execution evidence have not been produced until the commands actually complete. Nothing in this route establishes production release readiness or authorizes a public-chain broadcast.
