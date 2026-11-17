# Independent focused security review: keeper policies

2026-11-17. Informed AI review of the replacement-policy change, under a 30-minute focused-review scope. This is not a professional audit, exhaustive examination, blind review, or release approval. No mainnet transaction was sent.

## Target and correspondence

The initial immutable source copy is `/private/tmp/keeper-policy-review-source`. Its `MANIFEST.json` SHA-256 is `c3ad896078afa9ec276ad7c8da5987b0f8c2a0ea3d50bb920fb62d9b0b4331a5`. Every listed live source matched before independent tests. It contains all `src/**/*.sol`, owner requirements, Foundry settings, and `script/Deploy.s.sol`, based on main `a29af3a` plus the implementation changes. Earlier review conclusions were not used as evidence, but inherited implementation context makes this an informed review.

A confirmed finding was repaired by the implementation owner. Relative to the immutable copy, the reviewed repair changes `KeeperPolicyCalls.restock`, PoolBalancer's recovery-path comment, and a price-indexed caller-minimum overload. The latter takes `(expected, minimumFixed, minimumGas)` and requires `reward >= minimumFixed + minimumGas * tx.gasprice`; existing entry points remain. This expands caller refusal conditions only, not reward authority. Oversized caller minimum arithmetic reverts atomically. A final source-only addendum below also reviews cancellation of pending proposals during emergency disable. Final reviewed file SHA-256:

- `src/KeeperPolicyCalls.sol`: `d05a1da9901663a58ad76165353b651cd114a22447f3c838b611ab131b93bc7c`
- `src/PoolBalancer.sol`: `2e777f27386ba35e1d7a9378ffee1657c1fb3502e216395d81dcfba5c93d6f61`

Canonical SHA-256 of the full repaired path/hash map, sorted keys with compact JSON encoding: `2a23411d5acead861bb8372648e2b43f5d85779422feaf3cdef05a095cdda45f`. These final hashes include the source-only emergency-disable addendum; the five security tests below ran before that last narrow change, as explicitly recorded in Commands and evidence. The permanent independent test file SHA-256 is `404fc89316ca2a9a7d627f179cfb069649a11ff59265a7fffd0bf9d94183784e`.

Tests use Foundry 1.8.1, solc 0.8.28, Cancun, via IR and optimizer runs 50, pinned mainnet block 26,382,349 through `https://mainnet.gateway.tenderly.co`. Setup sets and asserts **0.5 gwei basefee and 0.55 gwei gas price inside an executed state-changing context**. FWA factory `0x8919814D825a5Af238cC04DE06b1C18c9eaA477C`, implementation `0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7`, and Shapes `0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0` are real fork contracts. The target constructor checks the FWA implementation runtime hash. Draw Packs is deployed on the fork from the pinned production source, not a replacement stub. The curated test NFT is a real arbitrary collection accepted by design. The new independent tests use real expiry processing, so they do not require the retained deterministic-VRF exception.

The vendored FWA source was consulted for owner proceeds, refund credits, delivery recovery, and bounded purchase-operator calls. Its README records a Sourcify partial runtime match; that provenance was not independently recompiled/reverified in this review. Deployed FWA code-hash correspondence is checked by the target constructor. No claim about the safety of FWA or Shapes follows from this work.

## Finding and repair

**E1, economic correctness, medium: any unpaid caller could override a healthy selected listing-price policy. Resolved and independently retested.**

The original `KeeperPolicyCalls.restock` consulted the selected policy only when `paid` was true. Public unpaid upkeep always selected the built-in V1 surcharge, even while the creator's active policy was healthy. Thus anyone volunteering gas could repeatedly force replacement listings to carry a different surcharge from the creator's chosen economics. Higher future fee income could be defeated; a lower-fee chosen policy could also be replaced with higher V1 prices. This did not provide a direct path to player escrow or backing, but undermined the central replaceable-pricing contract.

The failing permanent witness `test_unpaidMaintenanceRespectsHealthySelectedSurcharge` reached a healthy stateless alternative, asserted the pool's live selected surcharge was **0.01 ETH**, genuinely unlisted one Shape, and restored the board through public unpaid upkeep. Both the real FWA listing and Item record carried only **0.000695 ETH** surcharge. Failure: `695000000000000 != 10000000000000000`. The caller received zero compensation.

Repair: unpaid work now first attempts the same bounded selected-policy pricing quote. A valid in-range quote is retained; only failure, malformed output or an over-limit quote uses the immutable recovery formula. Paid quote failures still revert. Work validation and reward selection do not change. The original witness now passes without weakening its selected-price assertion. The builder owns the associated hostile-policy fallback regression runs; they are not silently represented as new independent tests here.

No additional security vulnerability was reproduced by this reviewer's independent counterexample families below. The later emergency-disable control finding was discovered and executed by the separate economic reviewer, as attributed in the addendum. This is a bounded result, not an absence-of-defects claim.

## Independent asset and authority map

| Bucket / authority | Contribution and legitimate destination | Policy capability |
|---|---|---|
| Balancer operating ETH | Creator deposits and collected owner proceeds; buys backing/mints and pays bounded work; creator withdraws surplus | Read-only quote proposal, constrained by pool's cached maximum, work envelope and persistent allowance |
| Booked `profit` | Creator's claimable markup share; excluded from activation funding and paid reward liquidity | Cannot alter or withdraw it |
| Shape/Pack backing | Held by real Shapes/Pack contracts; listed tokens held by FWA, delivered to winners or redeemed on unlisting | No custody, approvals or transfer capability |
| FWA draw escrow / player refunds | FWA holds acquisition fees; expiry credits the original buyer; only that buyer withdraws its refund | Never becomes keeper capital |
| Curated NFT | Creator supplies it to FWA; winner receives it, or creator recovers according to real FWA rules | No recipient or custody authority |
| Keeper eligibility | Separate factory keeper admin; creator always paid-eligible; unpaid maintenance public | Policy cannot alter the list |
| Default policy selection | Separate policy admin proposes; anyone executes after two days; future clones snapshot only | No effect on an existing pool without its creator's proposal |
| Existing pool selection | Creator proposal/cancel, permissionless delayed activation with final operating-capital check | Cannot self-activate, raise cached bound, reset spending, transfer creator, or reprice old records |

The compiler-linked `PoolInventory`, `KeeperPolicyCalls` and `PoolPage` targets are fixed in implementation bytecode. Their delegatecalls are distinct from the dynamically selected policy address, which reaches only bounded `staticcall`. No configurable delegatecall or arbitrary pool executor was found in this reviewed target. Solidity library context preserves the pool as FWA owner and NFT custodian.

All relevant state-changing pool entry points are under the reentrancy guard except deposits/receive, which only contribute ETH. Static context propagates into policy callbacks. Policy selection is not sufficient authority to change creator ownership. Reconciliation advances real finalized sequences once; service units count only successful listing work and finalized reconciliation. Previously finalized sequences cannot earn repeated work fees.

## Counterexample attempts and measured outcomes

| Property challenged | Concrete attempt | Result |
|---|---|---|
| Cached obligations cannot be increased by a mutable compatible policy | Adopt declaration 0.001 ETH, then mutate its declaration to 0.311 ETH and reward quote to max uint | Actual reward remains exactly **0.001 ETH**; cached bound and reserve formula unchanged; second empty upkeep rejected |
| Purchaser funds stay outside malicious-policy payment | Expire a real FWA draw during that maximum-quote attack | **0.014499656757271948 ETH** acquisition fee independently calculated from actual board prices; full amount remains buyer refund credit and FWA ETH; keeper paid from Balancer only; owner proceeds zero |
| Policy static isolation is stronger than authority checks | Active policy additionally becomes creator, then attempts `claimSurplus`, `transferCreator` and emergency-disable from its quote callback | All fail in static/guarded context; creator and payment state unchanged, policy receives zero ETH, only legitimate keeper receives **0.0001 ETH** |
| Caller minimum is atomic across external work and recipient side effects | Receiver increments storage on reward receipt; request one wei above offered 0.0001 ETH while real expiry work is pending | Whole call reverts: FWA cursor, Balancer cursor, ETH, allowance, recipient balance and recipient callback counter unchanged; acceptable minimum succeeds once |
| Gas-indexed minimum follows actual mined price without partially committing rejected work | A fixed 0.0001 ETH offer fails a 200k-gas minimum at 0.55 gwei, then succeeds at 0.2 gwei with 0.15 gwei basefee asserted inside the executed context | Rejected attempt preserves cursors, ETH and allowance; identical real expiry work is completed once under the accepted lower-price guard |
| Unpaid maintainer cannot select a healthy policy's prices | Force genuine missing inventory and call public unpaid maintenance | Failed on initial target, passed after E1 repair; actual FWA price matches Item price and selected **0.01 ETH** surcharge |

These tests do not impersonate protocol owners, replace a protocol's successful answer, set a protocol's internal state, or fabricate protocol balances. Funding creator/buyer/keeper actor wallets is setup. Existing shared fixture deploys production Pack code and a creator-supplied NFT collection.

## Economic scorecard and limitations

For the independently checked 20 × 0.01 ETH Shape board, one curated NFT valued at 0.2 ETH, 15% markup, mint fee 0.001 ETH, basefee 0.5 gwei and bid 0.55 gwei:

| Outcome | Amount / status |
|---|---|
| Active V1 surcharge in each old listing | 0.000695 ETH; aggregate 0.0139 ETH, **future income, not pool ETH** |
| V1 empty-board opening reserve, independent formula | 1.2838 ETH |
| V1 stocked reserve | 0.7209 ETH |
| Same stocked board at cached 0.001 ETH maximum | 0.0411 ETH |
| Same stocked board at hard 0.311 ETH maximum | 13.6811 ETH |
| Real expired draw refund protected from keeper | 0.014499656757271948 ETH |
| Keeper payment under mutable maximum attack | 0.001 ETH from creator operating fund |
| Caller minimum failure | Zero committed work, payment, allowance spend or recipient callback |

The reserve rows are independent arithmetic from reviewed constants and the exact board, not new sampled-regime receipts. The fork witnesses confirm cached-cap and refund ownership behavior, not long-run profitability. Closing releases future-board holds but retains one selected maximum per unreconciled draw; the pool never acquires a buyer's FWA refund entitlement. A policy can still consume the creator's own operating capital over repeated legitimate work, within immutable caps. The 3.11 ETH burst plus 0.311 ETH per 12-second refill is generous; it is a mathematical ceiling, not an empirically justified optimal exposure.

The board-cycle gap budgets **Shape/Pack listings only**. Unlimited curated NFT turnover has zero surcharge and can consume creator operating capital. Do not describe the bridge as covering an arbitrary entire board's future costs or guarantee indefinite sustainability. Security boundary claims must distinguish creator capital from FWA purchaser escrow and backing.

This focused review did not independently run all economic regimes, deep invariants, gas-market competition, full malformed-data permutations, long-running rate exhaustion, real Chainlink delivery, UI/wallet behavior, or mainnet deployment. Existing candidate tests cover several of those local behaviors, but their execution and acceptance belong to the lead's evidence set. No simulation is promoted to empirical demand or timing evidence. The original shared storage layout was reorganized for new clones only; old immutable deployments cannot acquire these entry points and are not upgraded in place.

## Commands and evidence

- Initial `forge test --match-path test/PolicySecurityReview.t.sol -vv`: setup failed before execution because sandbox DNS could not reach Tenderly. Log `/private/tmp/keeper-policy-security-review-tests.log`; preserved.
- Approved-network same command: **3 passed**, 0 failed, 1.21 seconds. Log `/private/tmp/keeper-policy-security-review-tests-network.log`.
- `forge test --match-path test/PolicySecurityReview.t.sol --match-test test_unpaidMaintenanceRespectsHealthySelectedSurcharge -vv`: **confirmed failing witness**, actual 0.000695 ETH versus selected 0.01 ETH, 7.70 seconds. Log `/private/tmp/keeper-policy-security-surcharge-witness.log`.
- Added independent refund arithmetic initially hit an integer constant conversion compiler error; corrected explicitly to uint256 division. Log `/private/tmp/keeper-policy-security-extra-refund.log`; preserved. No product code change.
- After the pricing repair: `forge test --match-path test/PolicySecurityReview.t.sol -vv`: **4 passed**, 0 failed, 441.76 ms suite, solc compilation 2.20 seconds. Log `/private/tmp/keeper-policy-security-review-repaired.log`.
- After reviewing and extending coverage for the gas-indexed minimum overload: same command, **5 passed**, 0 failed, 281.71 ms suite, solc compilation 2.44 seconds. Log `/private/tmp/keeper-policy-security-review-final.log`. That execution used `KeeperPolicyCalls.sol` SHA-256 `69d4b0f8c29eb87fc6bc7ff2df70f1441d7222a8841571fcb440ccff6a5a5f37` and the same PoolBalancer hash listed above. The final library hash now listed in Target additionally includes the source-only addendum below; it is not represented as a new run of these five security tests.

The independent test file remains in the permanent suite. This report does not replace the owner's release gates or confer publication, deployment, transaction or spending authority.

## Final emergency-disable source-review addendum

A separate independent economic review reproduced a control defect after the five security tests above: a matured `pending` proposal survived `setPaidUpkeepEnabled(false)`. Because activation is public, a stranger could immediately execute that old proposal and turn payments back on. This undermined the emergency stop and required-new-delay rule, though its spending source was creator operating capital rather than player refund assets.

The final production delta is exactly a comment and `cancel(s)` inside `KeeperPolicyCalls.disable`, after `enabled = false` and the generation increment and before `PaidUpkeepChanged(false)`. This reviewer examined that delta, the existing `cancel`, `propose` and `activate` paths, the permanent economic witness, and its retained final log. `cancel` zeros both pending address and activation timestamp and emits cancellation. Subsequent public activation therefore fails before any policy call or payment-state change. A fresh creator proposal necessarily assigns `block.timestamp + 2 days`; cancellation does not alter the stored spending allowance or refill timestamp. The caller's creator check and reentrancy guard remain in PoolBalancer. Cancellation introduces no external call, asset movement, new role or replacement execution capability.

Evidence attribution: the economic reviewer executed `test/PolicyEconomicReview.t.sol::test_emergencyDisableInvalidatesMaturedProposal`, first failing and then passing, and recorded **4/4** economic review tests passing in `/private/tmp/keeper-policy-economic-review-final.log`. Its source and [economic report](../economics/REPORT.md) were inspected for this addendum. The emergency witness reaches the old matured proposal, disables payments and verifies that a stranger cannot reactivate it. It does not itself execute a new proposal and two-day reenabling; that future-delay statement here is source reasoning, with existing builder regression coverage separately owned by the lead. This reviewer did not duplicate those tests or claim personal execution of that new case.

The exact final library hash is `d05a1da9901663a58ad76165353b651cd114a22447f3c838b611ab131b93bc7c`; PoolBalancer remains `2e777f27386ba35e1d7a9378ffee1657c1fb3502e216395d81dcfba5c93d6f61`. All other original manifest entries are unchanged. This is a narrow source review of the repair plus separately attributed independent regression evidence, not a new audit or a new full-suite pass. No production edits or additional attack work were performed for this addendum.

## Asset-flow kit source binding

The existing kit review record `SOURCE_HASH` contains `eefd64a9600fc70701db718b521a9dd83a5ced0a2ca11ddee00e828fe47ec524`, generated with `python3 /Users/dd/.agents/guidance/asset-flow-kit/asset_gate.py . --print-source-hash` after verifying the final reviewed production target map remained unchanged. This administrative record binds the final configured sources and flow helpers; it does not expand this focused review's examined behavior, imply a new audit or test run, approve changed economic outcomes, supply an owner signature, or authorize deployment. Changed outcomes remain unsigned.

## Final keeper receipt-accounting delta

A separate read-only focused pass examined final `keeper/keeper.ts` SHA-256 `08f9d954fee5b3aada21af81134b44972d261b437978f4e4de4655d8663f7431`. Source reasoning identified four narrow accounting problems: eviction discarded pending evidence before an asynchronously mined receipt; an absent transaction in a historical nonce search was treated as definitive outside consumption; duplicate retry/active entries could survive until journal pruning; recovery could overwrite known per-hash offer metadata. The worker repaired these, and this reviewer checked the final delta. Canonical success/dedup clears only matching-nonce pending/retry/error entries, preserving newer work. No accounting-only queue broadcast or new pool authority was introduced.

Execution attribution belongs to the keeper worker: `/private/tmp/keeper-policy-eviction-before.log` fails the real peer-mined eviction-boundary assertion, while `keeper-policy-eviction-after.log` ends `KEEPER RECOVERY E2E PASSED` and checks actual once-only gas/reward receipt totals. The reviewer inspected that log, ran no additional tests and made no source edits. No further actionable finding was identified within this delta; this is not comprehensive transaction-manager verification.

Coverage remains 64 blocks / 1,000 journal receipts, with legacy/pruned uncertainty visible. An actual external operator cancellation can consume the tracked nonce without a service-receipt tombstone; if that cancellation is later orphaned and the original upkeep reappears, manual canonical reconciliation is required. OPERATIONS and the implementation results explicitly preserve that gap. No claim covers all historical canonical totals.

## Things that don't make sense

- Calling unconditional V1 unpaid pricing a policy-failure fallback was misleading. E1 now restricts fallback to an invalid/unavailable selected quote.
- An entire old-board sustainability guarantee is stronger than the Shape-only bridge actually provides, especially with unlimited low-valued curated NFTs. State that residual creator-capital exposure explicitly.
- The hard ceiling and rate allowance permit very large theoretical annual expenditures; a bounded number is not necessarily a useful creator risk budget.
