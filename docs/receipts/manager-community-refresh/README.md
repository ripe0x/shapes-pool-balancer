# Manager app integration against current community main

The app branch incorporates community `3217bb36fccc67fa4a26244e4223984d3e765320`
without changing that release's contracts, keeper, deployments, community ABI or legacy selection.
The parent main-integration revision is `f037af2c9f3997348195913464d5d024b3631715`.
Only `App.tsx`, `HowItWorks.tsx` and `styles.css` needed conflict resolution. Main-manager
navigation, independent local preview gates, three-paid-Shape descriptions and scoped forms
remain present. Both public main launch switches remain false; the replacement vault is undeployed.
This local branch integration does not merge either PR or change the live application.

An independent read-only reviewer compared both parents against immutable integration tree
`9543190395d7982ec5177c51a17fc0bb5e787ed9`. No actionable finding was reported in the
conflict-resolution scope. Wallet/owner boundaries, reviewed transaction context, manager-only
routing and independent chain-31337 preview guards were preserved. Community `src/`, `keeper/`,
`deployments/`, deployment/preflight/verification scripts, `shared/abi.ts` and `shared/legacy.ts`
exactly match that community revision. This is focused integration review, not a security audit
or production acceptance.

## Validation

The implementing worker ran `npm run typecheck`, exit 0, on the reviewed integration tree.
The lead reused that compilation result rather than repeating it. One affected batch then ran:

```sh
npm run test:ts -- app/src shared/listing.test.ts shared/design.test.ts shared/planner.test.ts shared/reserve-capital.test.ts
SHAPES_FWA_POOL=/Users/dd/CascadeProjects/shapes-fwa-pool-completion node scripts/export-main-pool-abi.mjs --check
node docs/receipts/manager-community-refresh/preview.cjs
```

Tests: **199 pass, 12 skip**; 21 files pass, one file skips. The twelve existing opt-in cases
require fork/replacement/transfer/policy/wallet RPC inputs and were not enabled by this affected
batch. They are not reported as passes. The main ABI/default freshness check passes against the
unchanged Solidity source `1bbe54c` and corrected default-data digest. Exact commands/statuses
and logs are in [checks.json](checks.json).

The preview used the task's retained real-counterparty fork at `http://127.0.0.1:18784`, chain
31337, and local Vite session at port 5221. It checked community design/help navigation, the
current community fee example, main help tabs, actual manager discovery without a vault address,
owner settings/gas schedule, a one-wei limit refusing work, a sufficient limit displaying bounded
costs, and selecting a second real manager. At 390px the body width is 390px. Desktop settings
and mobile screenshots were visually inspected. No confirmation was clicked, no send/sign RPC
was observed, and the owner's nonce stayed `0x3`. [preview.json](preview.json) records the result.
This is read-only integration proof; the separately preserved main fork receipts prove actual
owner-paid execution and the zero-budget complete exit.

Two failed preview attempts are retained. They incorrectly expected the currently restored
fork branch to be the completed-exit branch; actual getters and UI instead showed active
managers. Only that harness assumption was corrected. No product code, protocol state, nonce,
balance or successful RPC answer was changed to produce the passing result. The failed logs,
JSON and screenshots remain under `*-attempt-1` and `*-attempt-2`.

## Economics and authority

The main [final scorecard](https://github.com/ripe0x/shapes-fwa-pool/blob/codex/main-pool-completion/docs/receipts/manager-operating-economics.md)
and [verification](https://github.com/ripe0x/shapes-fwa-pool/blob/codex/main-pool-completion/docs/receipts/manager-operating-verification.md)
now include the completed corrected 960-case study: 957 complete exits, all 480 candidate-backing
cases complete, and three hypothetical lower-backing cases retained at the wallet limit. Positive
conditional means coexist with severe losses; no demonstrated APR or production viability is
claimed. Larger sync/multiple-renewal, production signing, public inclusion and service operation
remain limited or excluded. Both PRs remain draft. No public transaction, acceptance signature,
production fee change, live cutover or PR merge was performed.

Things that don't make sense: treating a retained fork's current branch as its historical terminal
state, or treating positive conditional returns as protection against large losses.
