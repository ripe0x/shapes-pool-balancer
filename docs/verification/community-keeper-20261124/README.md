# Community keeper service verification, 2026-11-24

Scope: deploy the existing keeper as a single Fly service for community factory
`0x526FbD402624B50861f54c081B592cdCeE322929`. No Solidity, ABI, compensation formula, pool rights or economics changed.
Owner choices are recorded in `OWNER-REQUIREMENTS.md` R106–R110. Mainnet startup, funding and secrets remain owner actions.

Base commit: `e495f9c15b8972730e39ca54acdf4cf1c748d2f4`.
Reviewed source tree: `93595691f9c63df6585cbba1ea7bee75fbea15a9`.
The complete fork pass ran tree `7767822846a62aa5b2a6917adced043173441d82`; the only subsequent source repair
replaced an unused coordinator-balance fallback with an assertion of sufficient existing funds. Its focused read-only
assertion passed at fork block `26485860`, balance `99999815131009437508` wei. The fallback never executed in the pass.
Independent review of the final source tree found no remaining actionable findings; its acceptance-only P2 is fixed.

## Commands and results

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | Complete changed source compiles; repeated after driver repairs |
| `npm run test:ts -- keeper/keeper.test.ts shared/listing.test.ts` | 0 | 25 tests passed, including actual HTTP monitoring routes and identity guards |
| `bash -n keeper/deploy.sh` | 0 | Shell syntax accepted |
| `fly config validate --strict --config keeper/fly.toml --app shapes-community-keeper` | 0 | Fly CLI accepted configuration; no app created or deployed |
| `git diff --cached --check` | 0 | No whitespace errors |
| Worktree invocation of `keeper/deploy.sh`, checked by Python subprocess | 1, expected | Refused before any external action |
| `npm run keeper:acceptance`, first attempt | 1 | Old fork factory still had 5 gwei ceiling; assertion caught it; [output](failed-fork-economics.log) |
| `npm run keeper:acceptance`, second attempt | 1 | Fork supplies no opcode steps; trace assertion caught it; [output](failed-opcode-tracing.log) |
| `npm run keeper:acceptance`, repaired attempt | 0 | Listing, draw win/restock, expiry/refund and cash assertions passed; [output](acceptance.log) |
| Read-only coordinator-balance assertion after review repair | 0 | Existing protocol funds exceed 0.01 ETH; no protocol balance modified |

Only the failed fork suite was rerun. No contract compilation, broad suite, historical `keeper:e2e`, or old top-level
rehearsal was run. No processes other than the test's own keeper children were stopped. Anvil on port 8545 remained running.

## One-screen economic and behavior scorecard

The fork pass used real deployed factory, Shapes, FWA and VRF contracts, fresh code-free actors, and the production
`npm run keeper` process with `KEEPER_ADDRESS`. Keeper funding was exactly 0.01 ETH once, with no subsequent top-up.
Mainnet economics were read at block `26487608`.
The shared fork factory was preserved: the test creator set its own new pool's local economics to those live values.

| Outcome | Measured result |
| --- | --- |
| High-gas wait, then remove trigger | At 1.1 gwei basefee, exact skip log and zero sends/listings; resume at 0.3 gwei |
| Initial stocking | 12 Shapes in 3 bounded calls, fully stocked, admission status 0 |
| Backing and mint fee | 0.120 ETH backing + 0.006 ETH live mint fees = 0.126 ETH |
| Win and replacement | One actual Shape delivered to buyer; keeper reconciled and restored all 12 |
| Stuck draw and refund round trip | One unfulfilled draw expired by keeper; buyer withdrew 0.014170884777799804 ETH |
| Keeper receipts | 5 successful paid transactions, zero reverts or outstanding nonces |
| Keeper gross gas | 0.002664877569936071 ETH |
| Keeper reward | 0.003047484951363347 ETH |
| Keeper net | +0.000382607381427276 ETH |
| Keeper ending balance | 0.010382607381427276 ETH, exactly initial + rewards − actual gas |
| Other buckets | FWA actual cash equals owner proceeds + acquisition/delivery escrow + refund credit + protocol fees at each snapshot; creator credit remains backed |

Actual keeper inclusion gas prices ranged from 0.286030654 to 0.35 gwei. Initial payments were independently
checked against `KeeperPaid` measured gas, the deployed operation bounds, the actual mined fee context, and
exactly 0.00002 ETH per listed Shape. Successful fee quotes are not supplied by a fake service.

## Limits and next action

- Opcode tracing is unavailable on the owner's running fork (`structLogs=[]`). The driver explicitly reports
  `opcodeTraceVerified=false`. Receipt fees and actual payment amounts are checked; there is no direct opcode proof.
- Fork gas is controlled, and VRF fulfillment uses the owner's expressly allowed coordinator-impersonation exception.
  Expiry deliberately omits randomness. These do not establish live inclusion or oracle timing.
- The test pool uses local economics copied from mainnet because the long-lived fork predates the factory update.
  This proves the upkeep path with those numbers, not a newly updated fork's default-follow creation reserve.
- No container engine is installed. Container build/startup, mounted-volume persistence, Fly restart behavior, public
  health routing, and Better Stack email delivery still need the owner-run deployment and postflight checks.
- No mainnet keeper was started, private key handled, account funded, branch pushed, PR opened, merge performed,
  or Fly resource created by this work. The next action is owner approval to push the reviewed branch and open its PR.
- A 0.01 ETH account cannot cover two concurrent 4M × 1.5 gwei maximum commitments. A single Machine and local volume
  also have host-failure downtime. No cumulative spending cap was requested.

## First deployment path repair

The first authorized `keeper/deploy.sh` invocation from main commit `949ee1d` exited 1 before building or starting a
Machine: `dockerfile '/Users/dd/CascadeProjects/fwa-pool-balancer/keeper/keeper/Dockerfile' not found`.
Fly resolves the configured Dockerfile relative to the configuration file. The repair sets `dockerfile = "Dockerfile"`
inside `keeper/fly.toml` and explicitly passes the repository root (`.`) as the deploy build context.
Shell syntax, strict Fly configuration validation, resolved-file existence and whitespace checks passed.
The next real deployment remains the image-build and startup verification; prior fork and application evidence stays valid.

Independent review also found that unignoring a directory allowed its unlisted descendants into the build context.
The repair re-excludes each subtree before allowing its exact runtime files. One focused check using Fly's real
`github.com/moby/patternmatcher v0.6.1` and ignorefile parser passed (exit 0): 9 runtime paths included, 17 unexpected
paths excluded, including `keeper/state.json`, `deployments/1.json`, `scripts/.env`, and nested key/temp paths.
No secret contents were read or source uploaded. The isolated verified Go 1.27.4 toolchain and check are under
`/tmp/keeper-ignore-proof-xnsbfgsh`; `.dockerignore` SHA-256 is
`3918f8a58f31261316c5843226cd7f7eca006da26ba47fb83dea216796b9ea74`.

Things that don't make sense: none beyond these documented capital, environment and availability limits.
