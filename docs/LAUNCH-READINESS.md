# Launch readiness (runbook section 0b), 2026-11-13

Preparation for the first launch-tier audit of the Shapes Pool Balancer. Requirements: `OWNER-REQUIREMENTS.md`.
Measurements from `test/scenario/FlowBreakdown.t.sol` on the mainnet fork at block 26,382,349 (basefee and gas price
set and asserted inside a transaction), 180 draws per regime unless stated.

## Decisions for the owner

| # | Decision | Options and measured numbers | Recommendation and why |
| --- | --- | --- | --- |
| D12 | R4 "never loses money with keepers" as an outcome | **a) O11 as drafted:** on the launch board, restocking fees repaid in won prizes cover keeper pay for play at 0.1 to 5 gwei, through a gas spike and a randomness outage. Measured +0.019 to +0.12 ETH. Information: the creator's own setup work (opening fill) costs 0.0054 to 0.14 ETH from 0.1 to 5 gwei, so at 5 gwei the total is −0.020 ETH over 180 draws (the fees in still-listed prizes, 0.26 ETH, come back as those prizes are won); NFT-dominated boards lose 0.025 to 0.035 ETH (an NFT win brings no fee, but its reconcile is paid). **b) Include setup work in the outcome:** fails at 5 gwei (−0.020). **c) Add a restocking fee to NFT listings:** a contract change | **a.** It measures the flow R4 is about. Setup is a one-time cost the creator chooses, and the NFT case is about 0.0002 ETH per NFT win |
| D13 | R8 "profitable in expectation" as an outcome | **a) O12 as drafted:** in quiet operation of the launch board the creator ends ahead after 180 draws at 0.1, 0.5, 2 and 5 gwei (measured +0.34 to +1.28 ETH on a 5 ETH deposit, NFTs given away counted). Prize luck and zero demand shown as information (−0.17 and −0.07 ETH). **b) Scorecard line only**, no limit | **a.** It is the closest measurable form of "in expectation" that a fixed run can check; luck is reported, not hidden |
| D14 | Final keeper constants (R10, R28) | **a) Keep 0.0001 ETH and 50,000 gas.** Rehearsal receipts: 336 mined keeper transactions earned 0.000146 ETH each above billed gas on average; the keeper never ran at a loss over a 300-round run. **b) Other numbers:** each changes O1, O11 and the reserve's keeper term | **a.** Measured on mined receipts, it covers real overhead (24k to 46k gas) and leaves a small margin |
| D15 | Caps for the canary (step E) | **a) No cap:** the contracts have none. The canary is the owner's own first pool with a small deposit; the factory stays public. **b) Add an owner-raisable cap at the factory** (pool count or deposit per pool): a contract change, a re-audit, and the cap holds only pools made through our factory | **a,** with the plan below. Each pool holds only its own creator's ETH and players pay through FWA per draw, so a cap protects the creator less than a small first deposit does |

## Canary plan (step E, for the owner's approval before any broadcast)

- **Caps:** none in the contracts (D15). The canary is limited by the owner's own deposit: one pool, the launch board
  scaled down if the owner wishes, a deposit the owner is willing to lose to prize luck (0.5 to 1 ETH suggested).
- **Exit:** the creator closes (purchases stop at once), waits for pending draws to settle, unlists, withdraws NFTs and
  claims everything except keeper pay held for unreconciled draws (released once reconciled). The keeper admin can
  restrict upkeep to approved keepers for all pools; it cannot move funds.
- **Read from the live chain** with `asset_live.py` and `asset-flow-live.json` (to be written once the outcomes are
  signed; the reader refuses unsigned outcomes): the closeout outcomes O3, O4 and O6 after a canary closeout, and the
  pool's balances against its requirement. Flow outcomes (keeper pay beyond gas, refusals, profit split) are not
  readable from one block; they come from the keeper's receipts and the pool's events.
- **When to open further:** after a canary closeout with O3, O4 and O6 at zero and keeper receipts within O1, the owner
  announces the factory. There is no cap to raise.
- **What cannot be capped:** other creators' pools once the factory is public; FWA's and Shapes' own admin powers
  (pause, mint fee up to 0.01 ETH); a creator's own NFT collection (R20).
- **Alerts that stay on:** the keeper's health endpoint (no tick for 2 minutes), its per-pool errors and loss-making
  skips, and a periodic live read of each pool's balance against `requiredReserve()`.
- **What a first small pool proves:** the production deployment, mainnet gas and randomness, the keeper on real fees,
  real wallets and the app. **What it does not prove:** other boards and markups, large balances, many pools, hostile
  creators or keepers at scale.

## Step B: the stripped clone for the uninformed audit

Prepare a fresh clone at the candidate revision, then delete these paths before handing it over:
- `audit/` (all earlier reports, re-attack notes, the old prompts in `audit/history/`);
- `test/audit/` (re-attack and challenge tests);
- `docs/` except `docs/OPERATIONS.md` (it holds decision logs, triage, spike notes, security history, readiness and
  results: `DECISIONS.md`, `SECURITY.md`, `READINESS.md`, `RC-ce4b699.md`, `AUDIT-RC-ec5259c-TRIAGE.md`,
  `OWNER-DECISIONS-*.md`, `LAUNCH-READINESS.md`, `SYSTEM-MAP.md`, `GAS.md`, `SPEC.md`, `fork-economics.md`, `spikes/`,
  `receipts/`, and the rest);
- `README.md` sections that describe findings (none today; check at the time).

Keep: `src/`, `test/` (without `test/audit/`), `script/`, `lib/`, `external/` (verified FWA source), `app/`,
`keeper/`, `shared/`, `sim/`, build files, `asset-flow.json` and `OWNER-REQUIREMENTS.md`. The request lists what was
removed and is labelled uninformed, not blind.

## Step D: rehearsal on the current block

Today `keeper/rehearsal.ts` deploys through `script/Deploy.s.sol` on a local fork, runs the real keeper service with
sent and mined transactions (300 rounds passed on `ce4b699`), but it forks the pinned block 26,382,349 and drives FWA's
randomness and the gas periods through anvil's impersonation and basefee calls. To meet step D:
1. Fork the current block (a `REHEARSAL_FORK_BLOCK=latest` option) and deploy with `script/deploy.sh` once a review
   record exists.
2. Randomness cannot arrive on a local fork without the coordinator: keep impersonating it and state this as the one
   remaining stand-in. Drop the basefee calls for the main run and let blocks carry the fork's real basefee.
3. Drive the app for the creator's steps (create, list, open, Add ETH / Continue, close) and keep the keeper service
   real.
4. After the run, read the signed outcomes from that chain with `asset_live.py` and reconcile with the fork regimes,
   including keeper pay from mined receipts against O1.

This waits on the signed outcomes (the live reader refuses unsigned ones) and on the review record.

## Not done here

- An app test against a failing randomness-fee lookup (now allowed for off-chain code by the shared rule): the lookup
  lives inside `App.tsx`; it needs moving to a module first.
