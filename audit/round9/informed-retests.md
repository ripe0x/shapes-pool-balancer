# Round 8 findings and follow-ups: retest dispositions (controller, informed)

Target `c686534` (production source identical to `7b32497`). Evidence reused under the unchanged-code rule: the
release-candidate run on `7b32497` (`docs/READINESS.md`, "Release-candidate checks": `CANDIDATE_RUN=1 forge test` 112
passed, exit 0; `CANDIDATE_RUN=1 npm run test:ts` 48 passed). The cited tests are repository tests written by the
controller (informed, same author as the code); round 9 lane evidence is cited where it exists. Reading-based
dispositions say so.

| Round 8 item | Disposition | Evidence and bounds |
| --- | --- | --- |
| E1 reserve vs multi-prize burst | **Accepted by owner** (DECISIONS 66): purchases continue while sales refill the reserve; every listed prize holds its own backing | `test/Reserve.t.sol::test_bigWinKeepsSellingWhileReserveRefills`, `test_worstBatchAtMinimumReservePaysEveryWinner` (RC pass). Round 9 lane A reports M6 held; lane B's below-reserve regime was resumed because its first pass could not drive it. M9 now carries the risk instead: see the M9 finding. |
| E2 close, drain, reopen with no reserve | **Fixed** | `open()` reverts `ReserveNotFunded` unless balance + owner proceeds ≥ `requiredReserve()` (`src/PoolBalancer.sol:346-354`); `test_openNeedsTheReserve` (RC pass). Bound: the check runs at open only; after open the reserve can fall below by design (E1 acceptance). |
| E3 simulation VRF fee and destination checks | **Still applies** | `sim/flows.ts:15` still fixes `VRF = 0.0003 ETH`; integration lane measured 0.00234 ETH at 1 gwei on the real route (2,340,000 gas × gas price). `sim/fund.ts` (used for the fork-economics comparison) is a separate model. |
| E4 planner reprices historical curated listings | **Fixed (reading)** | `shared/planner.ts:114-115` uses `curatedPrices` when given; `app/src/App.tsx:519,1047` pass live FWA listing prices. Not re-executed on a fork this round. |
| E5 old keeper credit consumes fresh capital | **Fixed for close** | `close()` zeroes `keeperCredit` (`src/PoolBalancer.sol:358-365`); `test_closeReturnsKeeperCredit` (RC pass). Bound: credit for an unlisted-but-open prize still stands until close (owner policy question from round 8 not reopened). |
| E6 dashboard simulation without fees, wrong caller | **Fixed (reading + unit tests)** | `app/src/tx.ts:14-27` simulates and estimates with explicit EIP-1559 fees and the account; `app/src/tx.test.ts` (RC pass). Integration lane round 9 reports dashboard callers simulate at real fees. |
| E7 keeper rejects estimates above 3.2M | **Fixed** | `keeper/keeper.ts:21-32,48` treats `KEEPER_MAX_GAS` as a reward cap only; `keeper/keeper.test.ts:66` (RC pass). |
| E8 same-block fulfilment beats 30% headroom | **Fixed within measured bound** | `UPKEEP_GAS_FLOOR = 4,000,000` (`keeper/keeper.ts:27-32`); integration lane measured a 5-draw burst upkeep at 2,526,347 gas. Bound: the largest same-block growth was not re-measured this round. |
| S1, S2, S3, S5 curated-collection trust and router coverage | **Accepted documented limits** | Unchanged code paths; curated collections are creator-chosen and trusted for custody (SPEC). Not retested this round. |
| S4 listing callback leaves stale markup | **Fixed** | `_pullCurated` pulls before pricing; `test_curatedPricedAfterCollectionCallback` (RC pass). |
| Follow-up: curated padding of the split | **Fixed for listing, not for withdrawal** | Curated share is 0 (`_share`), so listing NFTs lowers the creator share (`test_listingNFTsBeforeCollectionCannotMoveFundMoney`, RC pass). The same test's withdraw case asserts only `< amount / 2`, not `≤ honest`; round 9 lane A shows withdrawal before collection raises profit. **New finding (M9).** |
| Follow-up: 10% minimum markup | **Held (tests)** | `configure` rejects below 1,000 bps (`src/PoolBalancer.sol:324`); `test_markupBelowTenPercentRejected` (RC pass). |
| Follow-up: funded open | See E2. | |

## Test-suite mock review (ApeBall item 5)

`vm.mockCallRevert` stands in for a failed delivery of a Shape or pack in three repository tests:
`test/Packs.t.sol`, `test/Gas.t.sol`, `test/Balancer.t.sol` (each mocks `transferFrom(pool, buyer, id)` on Shapes or
Draw Packs). This breaks the project's no-mocks rule on a protocol contract. The real failed-delivery path for a Shape
or pack prize therefore has no real test; whether it is reachable at all (Shapes and Draw Packs use plain
`transferFrom`) is open and assigned to lane A's continuation (refund path with a hostile receiver). The curated
failed-delivery path uses a hostile collection (`ContractBlockingNFT`), a legitimate adversary.

`vm.deal` uses are external actor funding (setup), except `test/Hardening.t.sol` `vm.deal(address(g), 1 ether)` on
a test contract (not a protocol contract). No `vm.store` or `vm.etch` in `test/`. `test/utils/Mocks.sol` holds hostile
NFT collections, a rejecting keeper and a non-refunding buyer: legitimate adversaries.
