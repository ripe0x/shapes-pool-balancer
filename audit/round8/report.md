# Shapes Pool Balancer round 8: partial audit report

**Examination incomplete.** The requested blind discovery could not start because no enforceable worker isolation is available. No security or economic conclusion, clean result, or release-readiness claim follows from this preparation.

## Frozen target and status

The target is `fork-tests` commit `2ac7a7e7b965d1798729068566c026128a4ba4b9`, with a clean tracked tree at intake. [freeze.json](freeze.json) hashes 809 selected tracked files, including primary contracts, recursive Shape Packs dependencies and the named off-chain integration files. Solidity 0.8.28 binary/hash, Foundry settings, submodule revisions and mainnet block identities are in [run-record.md](run-record.md). The Balancer is undeployed; deployed bytecode correspondence is not applicable. Public integration codehash and settings remain unverified.

| Status dimension | Result |
|---|---|
| Examination | Incomplete before discovery |
| Execution capability | No worker preflight; no execution-capable lane |
| Security findings | None assessed; absence of findings is not a negative conclusion |
| Economic findings | None assessed; M1–M8 untested |
| Structural gate | Not run |
| Evidence control | Advisory; shared writable host |
| Discovery separation | Neutral packet prepared; no lane launched or sealed |
| Blindness | Blocked; process isolation unavailable; public-code training exposure unknown |
| Calibration | Uncalibrated |
| Technical and human review | None |

## Property and method map

| Requested scope | Attempt, evidence and result |
|---|---|
| M1–M8, destination and at-rest invariants, full cycles, draws in flight, ratchets | No attack attempts or tests; untested |
| Keeper pay bound, bidding, refunds, batching, spikes, self-dealing and griefing | No receipt analysis or tests; untested |
| Security entrypoints, getters, callbacks, hostile actors, roles and nested asset ledgers | No source examination, static analysis or tests; untested |
| Timing, liveness, gas-price-zero quotes and inclusion races | No fork runs; untested |
| Keeper, planner and dashboard integrations | No source or runtime examination; untested |
| Informed ApeBall items and project post-round-7 properties | Withheld before discovery; untested |
| Round 7 finding dispositions | Prior report not read; untested |
| Economic scenario tables, simulation-to-contract and fork parity | No simulation or fork scenario; unavailable |

No PoC command, ETH impact estimate, security/economic finding, or suggested fix is supportable yet. No negative conclusion was submitted for acceptance or evidence challenge. The only executed commands were intake/preflight reads, a cached `forge build --sizes` (exit 0, compilation skipped), and public RPC block reads. Raw outputs and exact observations are preserved in `build.log`, `pinned-block.json`, `recent-block.json` and `run-record.md`.

## Blocker and continuation

The current worker mechanism exposes unrestricted host tools; no Lima instance exists. Prompt-only file restrictions cannot satisfy the audit workflow's mandatory blind-isolation preflight. The installed integrated runner is designed for deployed public mainnet subjects; this target is undeployed. The owner requested the stricter standard, so prompt-level separation cannot be treated as a blind run.

Approximately 0.10 of 12 approved auditor-hours were used for preparation; all planned lanes and campaigns remain. The next action is an enforceable isolated worker runtime for this undeployed source project, followed by worker compiler/sentinel/fork/fuzz and forbidden-read preflights. Alternatively, the owner can explicitly change the requested operation to an informed audit with prompt-level separation. Until then, all consequential properties are blocked, not closed.
