# Release-candidate audit of 0c5291f (section 0, informed)

**Verdict: no blocking defect found in the diff bb0deba..0c5291f.**
- Contract bytecode is identical apart from CBOR metadata.
- A fresh 28-regime asset-gate run holds all 15 outcomes.
- The owner signature over outcomes hash `25faf114…d297` verifies.

There are two low findings. This is a bounded review of a small diff. It is not a statement that the system is safe, complete or release-ready.

**Run record**
- **Candidate:** `0c5291f7ba48091bd93e3f88b4082829de799642` (origin/main). Against a9b4d3a, only `docs/CANDIDATE-REPORT.md` differs.
- **Last examined:** bb0deba.
- **Tier and time:** informed, 30-minute timebox, about 9 minutes used.
- **Checkout:** own detached checkout. Submodules copied from the main checkout at their pinned commits (forge-std dc647cc, shape-packs 3a463f7, solady acd959a), status clean.
- **Toolchain:** Foundry 1.8.1, solc 0.8.28, via-IR, 50 runs, cancun.
- **Requirements:** taken from `OWNER-REQUIREMENTS.md` (R100-R105); they agree with the request.
- **Fork reads:** only through `https://mainnet.gateway.tenderly.co`. No transactions, port 8545 not used, no tracked files changed.
- **Not re-verified:** external contracts against deployed source (bytecode unchanged).
- **Builder material:** CANDIDATE-REPORT section C was opened only after my attacks had run. It agrees with my results: source hash `c293a329…c95d`, PoolBalancer 23,408 B, and the F2 partial branch disclosed as untested.

**Checks**
1. **Bytecode** (`bytecode_compare.py`, output in `bytecode_compare.out`): 172 objects identical, 28 metadata-only (PoolInventory, PoolBalancer, BalancerFactory), 0 real differences. The metadata change moves PoolInventory's CREATE2 address, so the addresses must come from the dry run on `main`.
2. **Signature** (`sigcheck.log`): the recomputed hash matches the recorded one. Verify exits 0 with ED25519 SHA256:K1f1jJ0j…+K0. The negative control with the previous hash d3b9ba83… fails (exit 255).
3. **Asset gate** (`gate-run.log`): all 15 outcomes OK. Exit 2 is caused only by `--require-review`. Source hash `c293a329…c95d`. Regenerated scorecards are byte-identical to the committed ones.
4. **Fork attacks** (`AuditRC0c5291f.t.sol`, `attack-run.log`, 5/5 pass, basefee 0.5 gwei and gas price 0.55 gwei asserted inside a transaction):
   - `aliasControl`: the parent revision's assertion was vacuous.
   - The repaired shipped test passes.
   - `localSurvivesThirdFactoryValue`: local economics and hash kept, follower moves, restock difference exactly 0.0004 ETH, absolute local fee 910k × 0.55 gwei + 0.0005 ETH.
   - `restockChargeAtWidthMax`: 39.92 ETH per Shape, equal to the app formula, below 2^98.
   - `rewardNoRevertAtWidthMax`: no revert at a 10,000 gwei basefee.
5. **App** (`app-run.log`, `policy-rc.test.ts`): vitest 30 passed, 2 skipped; tsc exit 0. The discriminator test is finding L1.

**Findings**
- **Security:** none in the diff.
- **Economic:** none new. R105 (accepted by the owner) is sized at up to 39.92 ETH per Shape at the field maxima.
- **L1 (low, executed):** the shipped `policy.test.ts` does not reach the F2 change; both revisions reject identically.
  - Reasoned: the repaired branch reaches the unavailable path through `App.tsx:124`, which is correct.
  - Smallest fix: an opt-in test against a deployed local pool whose transport fails only the second aggregate3 call. Every successful answer would still come from the real pool.
- **L2 (low, reasoned):** a stale "signature still required" sentence in `OWNER-REQUIREMENTS.md`.

**Economic pass (bounds changed in the range)**

| Outcome | Bound | Measured worst | Headroom | Who bears it |
| --- | --- | --- | --- | --- |
| O1 | 80,000 → 100,000 gas per draw | 96,590 (`burst`) | 3.4% | Creator's operating ETH: at most 0.0005 ETH per draw at the 5 gwei cap, at most 0.09 ETH over 180 draws |
| O2 | 0.26 → 0.2613 ETH | 0.26125 ETH | 0.00005 ETH | Buyers, through listing prices. Does not bound local economics (R105) |
| O15 | 0.2356 → 0.229565 ETH, exact | 0.229565 ETH | exact | Creator. 0.006035 ETH lower because of the single fee schedule |

No running cost per user action changed.

**Not examined:** full suites, the fork rehearsal, a browser preview of the two new notes, re-verification of external contracts, and human review (absent).

**Things that don't make sense**
1. The gate's fork block is about 100k blocks behind the head.
2. O1 and O2 have very little headroom, so most later changes will need a new signature.
3. The stale signature sentence (L2).
4. There is no pool on the legacy community-v1 factory, and its restock and reward calls fail together, so F2 changes nothing observable there today.

**Files:** SOURCE_HASH, AuditRC0c5291f.t.sol, policy-rc.test.ts, bytecode_compare.py and .out, attack-run.log, gate-run.log, sigcheck.log, app-run.log.
- To rerun the fork attacks, put `AuditRC0c5291f.t.sol` in `test/` of a 0c5291f checkout, then run `forge test --match-path test/AuditRC0c5291f.t.sol --match-test 'test_rc_|test_followersUpdatePinned' -vv`.
- To rerun the app check, put `policy-rc.test.ts` in `app/src/` beside `policy_bb0deba.ts` (made with `git show bb0deba:app/src/policy.ts`), then run `npx vitest run app/src/policy-rc.test.ts`.

_Report text written by the independent auditor; saved verbatim by the lead because the auditor's file write was refused._
