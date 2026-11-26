# Authentic local economic lifecycle, 2026-11-25

Scope: changes based on c12a1e0, frozen by this containing commit. No production contracts, ABI, deployment values,
owner outcomes or asset-flow.json settings changed. No public-chain deployment, broadcast, service reset or cache
clear occurred. The source/test diff was independently reviewed; its claim was narrowed to creator assets.

The new AuthenticEconomicFlowsTest exercises the actual mainnet FWA/VRF/Shapes contracts on a local fork starting
immediately before purchase transaction 0x2d9d2a85771c6ea346a6ed9e581fe5c5c1f5aefb770f669effcee35e254f8283,
block 26,442,752, using https://mainnet.gateway.tenderly.co. It deploys the candidate locally, builds a 47-prize board
with 55 contained Shape units and 1.7 ETH backing plus a 0.2 ETH creator NFT, at 25% markup and stored 400 bps creator
share. Creator funds 5 ETH. Three real purchases produce the exact historical request IDs. Each original proof
transaction executes once through the real coordinator at canonical block 26,442,757. Request/candidate accounts
persist across the fork advance; intervening canonical mutations to those accounts are intentionally omitted.
No protocol balance/storage/code or oracle result is fabricated. The creator-defined NFT is an accepted untrusted
collection, not a replacement for FWA/Shapes/VRF. Actor wallet funding is local setup.

State-changing GasProbe calls assert request gasprice/basefee 565418379/565409872 wei and economic-call gasprice/basefee
565418379/548662718 wei after proof replay. These are historical-context calls, not a production wallet gas benchmark.
The harness explicitly calls FWA processAcquisitions before paid Balancer reconciliation; this does not establish
keeper-only queue liveness, rational keeper profitability or the monthly campaign.

| Economic flow | Reached/checked result | Scope limit |
| --- | --- | --- |
| Creator setup | 47 Shape/Pack NFTs, exact 1.7 ETH backing, plus curated NFT | One reference-size board, 25% markup, 5 ETH deposit |
| Buyer payment and delivery | Independent inverse-weight quote plus historical 5% edge; buyer pays exact 3-draw quote; all 3 acquisitions fulfilled and buyer owns actual prizes | Three genuine historical requests, not 180 draws |
| Owner sale proceeds | Actual 66,278,634,547,026,369 wei equals three request-time base quotes | Request-time economics, not long-run profitability |
| Creator credit | Exactly 2,651,145,381,881,054 wei (floor of proceeds times 400/10000); second collection adds zero | Current stored rate, one collection lifecycle |
| Keeper work | Actual paid reconciliation; cursor catches issued sequence | Reward transfer checked; production gas profit not measured |
| Creator closeout | Every remaining NFT withdrawn; each Shape/Pack redeems exact backing; creator claims 4,913,901,123,666,667,089 wei | Protocol edge, oracle fees and mint fees are not a complete conservation scorecard |
| Final creator buckets | Balancer cash/credit/tracking, active FWA listings, FWA owner proceeds and unsettled draws all zero | FWA protocol fees and subscription funds are separate buckets |
| Failed delivery recovery | Existing authentic test still passes: 3 NFT recoveries and 0.0315 ETH purchaser refund | Independent fresh fixture, not continuation of this successful lifecycle |

## Release evidence protection

The historical FlowBreakdown campaign no longer invents words or impersonates its coordinator: those methods
revert HistoricalProofCorpusRequired. Candidate/SOURCE_HASH execution rejects at setup. The shared scorecard reporter
rejects unverified producers before writing; the isolated serializer fixture opts in only for test/fixtures.
Its new negative regression verifies an unverified report reverts. No old scorecard was relabelled with fresh hashes.

The approved 28 regimes, thresholds and owner signature payload remain unchanged. The new short case writes no
release scorecards and cannot substitute for the required 180-draw/30-day regimes, five-pending burst, forced
large wins or up-to-540-request concurrent workloads. The release gate remains incomplete.

## Verification and preserved failures

- CANDIDATE_RUN=1 forge test --match-contract '^(AuthenticEconomicFlowsTest|AuthenticRefundRecoveryTest|FlowReportingTest)$' -vvvv:
  exit 0, four tests pass (new economic lifecycle initially used inherited 15% markup).
- Independent review identified that the test name overclaimed every bucket. It was renamed to creator-assets
  closeout and the scope excludes complete oracle/mint/protocol-fee accounting. The fixture was aligned to reference
  25% markup. First adjustment failed Unauthorized in setup because the mint-fee argument consumed a one-shot prank;
  that failed log is retained. Reading mintCap before the prank repairs the fixture; the existing shared configure
  helper uses startPrank/stopPrank and did not share that defect.
- CANDIDATE_RUN=1 forge test --match-contract '^AuthenticEconomicFlowsTest$' -vvvv:
  exit 0, affected final 25% lifecycle passes. Unchanged reporter/refund evidence is reused.
- python3 scripts/test-flow-reporting.py: exit 0, seven shared-reader tests pass.
- Attempts to select the retired legacy quiet test returned `No tests found` and are NOT runtime guard evidence.
  Contract listing compiled/typechecked the historical source successfully but produced an ABI-only artifact.
  No caches were deleted and no alternate binary bypass was used. Retired-body/report guards have static independent
  review and the shared writer has a passing negative execution test.
- No full 28-regime run, production build or size check was repeated: production bytecode is unchanged.

Next exact action: collect enough distinct, matching request/proof pairs and implement an execution schedule for
the full economic campaign. Every real request needs its original tuple/nonce/request blockhash, and each proof
can consume its commitment only once. Preserve approved workloads/outcomes; do not cycle these three proofs or
shrink workloads and call the original regimes complete. Any required gate-config migration needs the existing
owner approval/signature procedure, not an agent-written pass marker.

Things that don't make sense: a current source hash alone never established authentic oracle evidence. This patch
closes that reporting gap, but full campaign coverage is still missing; no release-readiness claim follows.
