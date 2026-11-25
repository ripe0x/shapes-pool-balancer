# Cost-first creator proceeds: focused implementation evidence

Parent revision: `024cb13` on `codex/batch-inventory-closeout`. Exact production inputs are in
`source-sha256.txt`. Owner scope: R114–R117; implementation, UI, focused checks and local commit only. No deployment,
factory switch, wallet transaction, new node or changes to the existing playground pool were performed.

## Result and commands

| Check | Command | Exit/result |
| --- | --- | --- |
| Initial contract batch | `forge test --match-contract [pattern below] --fork-url https://mainnet.gateway.tenderly.co -vv` | 1; 11 passed, positive curated fixture failed |
| Failure diagnosis | Same RPC, positive test only with `-vvvv`, then counter logging with `-vv` | 1; preserved in trace/counter logs |
| Repaired positive fixture | `forge test --match-contract AuthenticPositiveProceedsTest --fork-url https://mainnet.gateway.tenderly.co -vv` | 0; 1 passed |
| App/planner regression | `npx vitest run app/src/profit.test.ts shared/planner.test.ts app/src/creation.test.ts app/src/nft-approvals.test.ts` | 0; 48 passed, 3 existing live-creation tests skipped |
| TypeScript | `npm run typecheck` | 0; final log after display repairs |
| Local demo caller compile | `forge build script/DevSetup.s.sol` | 0; compilation only, no execution |
| Deployment size | Deployed bytecode in the exact compiled Foundry artifacts | PoolBalancer 23,474 B; PoolInventory 16,047 B; below 24,576 B |
| UI interactions | Real exported Overview component in local Vite, explicit static props, no successful RPC answers substituted | Deposit, earned, reserve-blocked, closed; projection frequency, other withdrawal amount and cost explanation exercised |

Initial contract pattern (literal argument):

```text
CostFirstProceedsTest|AuthenticEconomicFlowsTest|AuthenticPositiveProceedsTest|AuthenticContinuationTest|AuthenticSequenceTest|AuthenticRefundRecoveryTest
```

The initial Solidity batch compiled in 17.68 seconds and executed in 12.68 seconds. The successful isolated repair
compiled in 4.49 seconds and executed in 11.41 seconds. Intermediate failed runs remain preserved; they are not passes.
Two early size builds exceeded EIP-170 (25,162 and 24,677 B); moving the existing reconciliation loop into the immutable
inventory library resolved the limit. Intermediate size logs are retained and are not the final artifact size.

## Economic scorecard

| Reached regime | Absolute outcome | Evidence |
| --- | --- | --- |
| No demand / deposits | 1 ETH starts with 0 earnings; 0.25 + 0.125 ETH contributions raise capital to 1.375 ETH, no duplicate income | CostFirstProceeds |
| Forced ETH | 0.2 ETH actual forced transfer raises capital from 1 to 1.2 ETH, earnings remain 0 | CostFirstProceeds |
| Mint/unlist/close/reopen | Exact 0.01 ETH backing is redeemed; historical 0.001 ETH mint loss survives zero-cash closeout and reopening | CostFirstProceeds |
| Hostile keeper callback | Keeper returns its actual reward during payment; returned ETH is capital, never earnings | CostFirstProceeds |
| Genuine positive curated sales | 0.6 ETH owner receipts − 0.001567144056990720 ETH setup − 0.001 ETH replacement mint fee = 0.597432855943009280 ETH earned proceeds | positive-public-proofs.log |
| Funded profit vs larger target | Positive earnings persist, but 10 missing 1 ETH automatic prizes put reserve above cash; even a 1 wei claim reverts. Removing that trigger preserves the same earned figure | AuthenticPositiveProceeds |
| Profit payout | Actual creator wallet receives the permitted profit; the 5 ETH capital target survives, with real remaining backing/cash independently checked | AuthenticPositiveProceeds |
| Launch-size loss and wind-down | 47 automatic prizes, 1.7 ETH backing; setup 0.072259223030504928 ETH; 3 receipts total 0.066278634547026369 ETH; closeout returns 4.913793850230129693 ETH from initial 5 ETH, with 0 earned profit | solidity-focused.log |
| Real proof continuation | Four distinct historical commitments across two cohorts, actual NFT custody and actual restocking/closure; claims use surviving assets less capital | AuthenticSequence |
| Refund recovery | Genuine historical failed curated deliveries, actual purchaser refund path and NFT recovery | AuthenticRefundRecovery |

Mint and keeper accounting tests set and assert nonzero gas price/basefee inside executed paths. Launch/positive proof
fixtures fork before canonical requests at block 26,442,752 and advance to 26,442,757: bid 0.565418379 gwei, basefee
0.565409872 then 0.548662718 gwei. General capital tests use fork 26,382,349, basefee 0.5 gwei and bid 1 gwei. The corpus
and historical fork boundaries remain the existing bounded fixtures, not current oracle availability.

The positive fixture originally used `vm.transact`. Its traces showed successful callback processing while outer
reads still reported unsettled=3, next sequence=1. Repeating an unnecessary processor call was not the cause: the
conditional call also failed. The repaired fixture submits the unchanged genuine corpus calldata through the real
coordinator's public entrypoint, as the existing continuation fixture does. It observes unsettled=0, next=4, last=3,
actual NFT ownership and 0.6 ETH actual receipts in one EVM journal. Exact Foundry caching internals are not proven;
this is not evidence of an FWA production invariant bug. No oracle impersonation, mock, fabricated proof, protocol
balance/storage editing or synthetic successful external response is used in these checks.

The independent read-only reviewer traced cash/backing/capital, authority and stale outcomes. Failed-delivery backing
is written off until actual redemption; later successful retries cannot leave phantom backing. Review identified two
untrusted callback donation hazards, repaired before the test batch: keeper pay debits only the reward, and curated
recovery never resets accounted cash after the recipient callback. The keeper case has a permanent regression.
Independent UI review found the omitted expected backing cost; it is now displayed alongside mint and keeper costs.
The preview also found a pending-draw hint shown on idle capital; the repaired hint requires actual pending work in
new accounting mode. Bounded review found no remaining actionable defect; it is not a full audit or safety claim.

The capital hurdle rises only with actual contributed ETH and falls only with capital recovery. Unrecovered losses
remain through reopening and creator transfer, per the approved prior-loss rule. It is a withdrawal target, not an
assertion that the corresponding assets still exist. Supplied NFT values never enter that hurdle.

## UI scope and remaining release work

Static component scenarios are preserved in `component-preview.tsx.txt`; the temporary HTML/entry were removed.
They are presentation fixtures, not a simulated chain or service success. Screens were inspected with actual `.pp`
styles. Examples: 1 ETH deposit → 0 withdrawable; 0.015 earned → 0.015 withdrawable; reserve shortfall → 0 available;
closed 1.005 cash → 0.015 proceeds plus 0.99 capital. Changing draws/day from 40 to 20 changed the displayed monthly
projection from 3 to 1.5 ETH. No wallet confirmation was clicked. Fresh new-generation creation and browser-wallet
writes have no execution evidence here; creation zero-rate construction has source review and contract regression.

This is a verified focused implementation slice, not a release candidate. The full economic campaign and production
rehearsal remain separate and were not rerun. Maximum-limit/idle-after-maximum, gas spike, dependency pause, launch
mix extremes and live keeper gas calibration are not established for this candidate by these focused tests. Historical
fixed-share tests/simulation/rehearsal outcomes must not be reported as validating the new accounting. New mainnet
release/canary work requires its own frozen inputs and owner broadcast authority. Existing immutable clones cannot
acquire the new behavior via a factory-pointer change.

Things that don't make sense: the original replay trace and later outer queue counters disagree; the successful
public-proof path avoids that journal inconsistency, but the precise Foundry cause remains unproven. Curated refund
recipient callback donations and failed automatic delivery/retry accounting were source-reviewed but not each reached
by a new genuine-proof runtime test. No claim of exhaustive economic or security coverage is made.
