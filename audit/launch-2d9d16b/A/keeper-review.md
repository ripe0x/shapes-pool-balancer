# Keeper and rehearsal slice, informed step A

Candidate `2d9d16bf289817eff1831263e48c8b5412a3855f`; scope: `keeper/keeper.ts`, `keeper/rehearsal.ts`, `scripts/current-local-rehearsal.ts` and their immediate tests. This is bounded source and focused execution evidence, not the full local fork rehearsal. Review time: about 8 minutes (source tracing 3, probe construction and execution 2, rebuild prerequisite wait and rerun 2, report 1).

## Security finding

**K1, medium, executed: a restart erases consecutive pool failures and can suppress `/health` failure.** `failures` exists only in memory (`keeper/keeper.ts:139`), while `save()` persists `state` and `load()` restores only `state` (`:158-178`). `tick()` records errors once per pool and updates `lastTick` (`:250-260`); `health()` requires five failures (`:577-604`). The probe records two failures, saves state, constructs the next Keeper from that state, records three more failures, then observes `health().ok === true` and `failures[pool] === 3`. Thus five consecutive unsuccessful runs across one ordinary process restart need not raise a 503. A recurring restart can extend the suppressed period. A pool with rehearsal-scale funding of 1.5 ETH (A) or 0.5 ETH (B) can remain unattended without this alarm; direct ETH transfer loss from the health check is 0, and downtime/lost sales is unmeasured. Smallest fix: persist the per-pool consecutive count with state, increment on failed service, clear only on successful service or confirmed pool removal, and test restart across the threshold. This is monitoring/liveness exposure, not evidence that an attacker can seize funds.

## Other focused attacks and observations

- Alternating error/success: executed via `recordPool`; every success clears the count, so repeated isolated errors keep health 200. This matches **consecutive** errors as specified.
- Error before first success: executed; the fifth error sets `stuck=[pool]` and actual `/health` returns 503.
- Pool dropped and re-added: executed for the counter transition via `recordPool` and source-traced through `discover()` at `keeper/keeper.ts:219`. An absent-code pool resets the count. Re-add with the same address begins at one failure. The probe does not execute an RPC reorg or dishonest `getCode` response, so the discovery path remains reasoned.
- A false `getCode == 0x` can cause a dropped-pool reset even if code later reappears. This is reasoned only; an RPC that lies about code is outside the local probe. The current alarm assumes an accurate RPC.

## Rehearsal scope

`scripts/current-local-rehearsal.ts:21` fixes A to curated-required with 2 NFTs and a 1.5 ETH initial deposit, B to standard with 0 NFTs and 0.5 ETH. The pre-send gate (`:335-345`) rejects changed modes/counts; the focused guard probe executed both intended creations and four wrong combinations. `keeper/rehearsal.ts:405-427` constructs the two arrays and asserts the resulting on-chain `curatedRequired` flag and initial ownership for A. No full fork transactions were executed here, so actual A/B deployment and purchase behavior remain for launch audit step D. The older standalone `main()` path in the same file still follows its prior scenario and is not evidence for the new A/B setup.

## Commands and limits

- `npm ci --ignore-scripts --no-audit --no-fund`: exit 0; local ignored `node_modules` installed after a temporary symlink was created in parallel. No tracked files changed.
- `./node_modules/.bin/tsx audit/launch-2d9d16b-A/keeper-health-probe.ts`: exit 0; alternating, first-success-absent, reset, HTTP 503, and restart sequence above. This directly exercises keeper state and HTTP behavior; it does not drive a live pool error through a fork.
- `./node_modules/.bin/tsx audit/launch-2d9d16b-A/keeper-rehearsal-probe.ts`: exit 0; current pre-send mode/count/deposit guard with no RPC or protocol counterparty.
- `./node_modules/.bin/vitest run scripts/current-local-rehearsal.test.ts -t 'keeps the fixed scope|rejects no standard-mode pool|rejects curated NFTs in the Shapes-only pool'`: exit 1 before target assertions because `out/DevSetup.s.sol/DemoNFT.json` was absent before the candidate rebuild. Re-run only after the parent build finishes; this prerequisite failure must remain in the record.
- The same focused vitest command after the candidate rebuild: exit 0, 3 passed and 23 skipped. This checks bounded input validation, not live deployment or balances.

No gas-based or fund-flow conclusion derives from these off-chain probes. No successful external protocol answer was supplied. The prepared rehearsal's money flows and gas receipts need the actual local fork run.

## Things that don't make sense

- The health alarm is described as five failed **runs**, but restarting the keeper silently restarts the count. The operator could see healthy status after a service that has never worked since launch.
- A standalone rehearsal entry point remains in `keeper/rehearsal.ts` alongside the current bounded path, but only the latter covers A curated-required and B standard. Operators need to know which command provides the launch evidence.
