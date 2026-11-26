# Local v2 stress diagnostics

Browse the measured campaign at <http://127.0.0.1:5280/stress-results/index.html>.
Select a design and nominal draw rate, then a scenario to inspect its timeline,
NFT wins, native ETH flows and final FWA accounting buckets. The viewer is read-only.

**Owner acceptance, 2026-11-25:** R126–R127 accept continued partial-inventory operation and burst slippage
refunds with nonreturned randomness charges. The frozen reviews retain their original observations; these
are accepted behavior, not unresolved product blockers or requests for new restrictions. The next release
step is recorded in [the version 2 status](COST-FIRST-PROCEEDS.md#current-acceptance-and-next-step).

## Scope and environment

Owner authority is R125 in `OWNER-REQUIREMENTS.md`. This is a diagnostic campaign,
not economic acceptance, an independent contract audit or a release gate.
No contract economics were changed and no mainnet transactions were broadcast.

- Preserve the original local playground at `http://127.0.0.1:8545`.
- Perform campaign transactions on its isolated Anvil child at port 18555,
  anchored to source block 26486068, hash
  `0xa5d84cff89843a95a3c99f9684add18b005435ccf0e662a94867f4d0fa9e86db`.
- Factory: `0xbe49677a403f77136e81498e5681f8dc22aa1181`.
  Implementation: `0xc02d40577880fa2c489fc5461ce3830d4eed7724`, accounting v2.
- The port-18557 source proxy permits anchored reads only. It meters forwarded
  requests, pins relative block tags, rejects mutations and conceals upstream
  credentials. Forwarded requests are not an Alchemy billing measurement:
  the original Anvil's existing cache can satisfy them.
- Synthetic creator, buyer and keeper wallets are funded on the child only.
  No protocol balance or storage is fabricated. Each scenario starts from the
  same actual child snapshot. Results persist in files; scenario pools are
  reverted between cases rather than retained as usable playground pools.
- Actual deployed FWA, Shapes, Packs and the production `Keeper.tick()` path
  perform purchases, NFT delivery, reconciliation, restocking and payments.
  Curated cases use the existing local DemoNFT collection.
- Coordinator callbacks use **simulated randomness**, explicitly authorized for
  local diagnostics. This does not validate VRF proofs, authentic delivery,
  coordinator billing, oracle outages or production liveness.
- Normal transaction basefee is 0.5 gwei, bid 0.55 gwei, asserted on receipts.
  The gas-spike case raises basefee to 8 gwei against a 5 gwei keeper ceiling.

## Cases and accounting

Six designs (small, balanced, topheavy, jackpot, zeroFee and pack) are scheduled
at 10, 240 and 86,400 nominal draws/day. Additional balanced cases exercise a
keeper outage, a gas spike, a forced largest-tier first win, fee reinvestment,
periodic fee withdrawal, and zero-demand wind-down. The 18 baseline cases each
contain 120 requests. The final stress cases use 40 requests each to preserve
coverage within the original deadline; wind-down has zero requests.

The reinvestment diagnostic removes the usual 20% backing buffer and selects
the largest prize on its first request. It must reach an actual reserve gap
alongside accrued fees, observe zero withdrawable surplus, and execute positive
fee reinvestment. This is a controlled adverse case, not an unbiased sample.

The driver serializes settlement and maintenance. **Nominal rates are schedule
inputs, not achieved concurrent load.** Actual elapsed time and achieved rates
are recorded. The zero-demand case advances 30 idle days, not 30 days of sales.
Each case uses one deterministic seed. The forced-largest case is deliberately
adverse and is not a random sample. These samples do not cover all supported
parameter extremes, curated collections, concurrent users or dependency pauses.

At every measured cycle the runner checks actual holdings beside accounting:

| Quantity | Meaning |
| --- | --- |
| Operating ETH | Balancer cash minus protected creator fees |
| Signed bankroll P/L | Cash + automatic NFT backing − creator fees − contributed capital |
| Overall native result | Cash + automatic backing + withdrawals − external contributions |
| Creator fees | Accrued compensation; separate from bankroll return |
| Reserve shortfall | Required operating reserve minus operating ETH, clipped at zero |
| FWA cash | Owner proceeds + acquisition/delivery escrows + refund credits + protocol fees |

Curated listing prices create no invented ETH acquisition basis. Overall native
results exclude personal curated-NFT investment costs and actor-wallet gas;
keeper payment counters include the protocol's reimbursement, not keeper net
profit. Deposits must create zero earnings. Reinvesting fees changes their
classification into contributed capital without transferring ETH or inventing
new profit. Wind-down redeems automatic backing and claims remaining cash.

NFT custody/backing, request outcomes, absolute setup mint fees, delivered-request
owner proceeds, fee conservation and per-cycle native NAV changes are asserted.
Refund outcomes are distinguished from NFT wins and buyer pull credits are
checked; a refund-credit withdrawal round trip is not covered. A conditional
fee withdrawal is explicitly marked unexercised if never reached.

## Execution and evidence

The original execution directory is `docs/receipts/local-stress/20261125-v2`.
Continuation directories retain completed cases and preserve failed partial
attempts. All repairs share its original `budget.json`, physical transaction and
draw counters, child instance and 30-minute deadline. Snapshot reverts do not
refund consumed execution budget. Meter extensions record old/new limits and
consumption; agent-selected ceilings are not owner-approved economic outcomes.

Raw results, receipts, keeper state and logs are committed in the byte-verified
`docs/receipts/local-stress/raw-evidence.tar.gz` archive. The original expanded
files remain in this workspace. On another checkout, restore their recorded
paths with:

```sh
tar -xzf docs/receipts/local-stress/raw-evidence.tar.gz -C docs/receipts/local-stress
```

`raw-evidence-index.json` records every archived byte hash. The browsable viewer
data and review reports are committed separately; no extraction is needed to
use the viewer.

Focused verification commands:

```sh
npx vitest run scripts/local-stress-campaign.test.ts scripts/local-stress-branch.test.ts
npm run typecheck
```

The first source-read ceiling interruption is retained in the original results.
It is an execution-budget failure, not evidence of a contract accounting failure.
The viewer labels historical failed attempts separately from current scenarios.
Receipts with the same scenario ID may belong to different attempts; do not sum
them as one economic run. Use the scenario's own measured flows and attempt files.

The final scorecard and execution manifest live alongside the frozen receipts.
Pure checks, independent source review and browser interaction checks supplement
the actual local transactions. No broad contract suite or contract build is
needed for these new off-chain helpers; deployed contract bytecode is unchanged.

## Things that don't make sense

- Treating creator fees as total investment profit would hide bankroll losses.
- Treating nominal schedule rates as achieved load would overstate throughput.
- Counting simulated words as verified VRF proofs would overstate this evidence.
