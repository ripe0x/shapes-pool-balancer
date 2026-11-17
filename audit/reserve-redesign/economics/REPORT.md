# Independent economic review: capital-efficient reserve candidate

**Scope:** consequential reserve/payment redesign, bounded independent economic review. No confirmed economic exploit or security finding from the paths exercised. The low-bid manufactured-work measurement gap is closed for the five executed cycles below. This is not a full audit, a safety claim, or release approval.

## Target and method

- Base revision: `a8fb321265f50d1d322023c7b26d39d38022da8d`, with the candidate's uncommitted production changes identified by immutable manifest `2291b07ab2278d26c5bc8b8e841956aa5298b05a8cbabeef53aeb6ee5ca9331a` in `/private/tmp/reserve-review-target-mtk_bq5d`. All twelve manifest entries matched both the immutable copy and live worktree before execution. The target is the manifest, not clean base HEAD.
- Read OWNER-REQUIREMENTS R39–R54 and derived the rights/flow map from the immutable `src` before consulting existing helpers. No earlier audit reports, builder notes/results, or sibling review results were consulted during discovery.
- Foundry **1.8.1**, Solidity **0.8.28**, optimizer **50**, via-IR; Packs retain their configured optimizer **20**. Dependencies: forge-std `dc647cc`, shape-packs `3a463f7`, solady `acd959a`.
- All fork executions: Ethereum block **26,382,349**, explicit source `https://mainnet.gateway.tenderly.co`. Isolated Anvil **18552**, chain **31337**, existing production `script/Deploy.s.sol` path, followed by actual unlocked local test-account transactions and receipt readbacks. This did not touch UI chain 18546 or any production account, key, money, or network state.
- Accepted malicious policy asks `type(uint256).max` for every reward, declares max **0.311 ETH**, and quotes **zero** surcharge. This is a real creator-selected untrusted policy, not a replacement protocol. The collection is a real creator-controlled NFT accepted by FWA; its refusal path rejects delivery to the buyer while permitting creator recovery.
- Only retained exception: deterministic randomness delivered through real FWA VRF service `0x7D93…d65d` by impersonating its actual coordinator. FWA `0x8919…477C`, reviewed implementation `0x85Fa…fEe7`/codehash `0af01f…ce02`, Shapes `0x6fE9…FAf0`, and deployed Packs are real dependency paths. Production deployment asserts FWA implementation/codehash. Service fee, seven-day window, ownership, refund, and proceeds behavior were read/exercised against deployed fork contracts; independent compilation correspondence for the VRF service was not established in this lane.
- Both basefee and transaction bid were asserted from a **state-changing on-chain probe**. Every recorded transaction additionally asserts inclusion-block basefee and effective receipt gas price. All creator, buyer, keeper, and coordinator gas receipts are retained in raw output. Local node signs unlocked test accounts; no keys are exported.

## Independently derived rights and buckets

| Bucket | Who contributes / controls / receives | Trigger and round trip |
|---|---|---|
| Balancer liquid ETH | Creator deposits; settled FWA owner proceeds; creator owns surplus | Funds real backing/minting and quoted keeper compensation; available surplus returns to creator. Actual booked creator profit is excluded from paid work and activation capital. |
| Listed Shape/Pack backing | Balancer buys real Shapes/Packs; FWA holds prize NFTs | Winner receives NFT and may redeem; creator unlists/redeems active inventory after permitted withdrawal. Existing listed backing is never a liquid reserve. |
| Listed surcharge ledger | Policy sets bounded quote at listing; buyers eventually repay through FWA price | `listedRestockFees` increases/decreases with listings. It is an **expectation**, never an ETH balance or reserve offset. Unlisting deletes it and returns backing only. |
| Creator markup allocation | Shape markup above first 10%; curated values carry none | Collected before reconciliation from actual proceeds and tracked listing shares; claimable even while a large prize deficit remains. First 10% and surcharge income join operating funds. |
| FWA buyer escrows/refunds | Buyer pays acquisition fee; FWA controls until outcome | Fulfilled delivery splits owner proceeds/edge; expiry or seven-day failed delivery returns price through the buyer's pull refund. Balancer cannot withdraw that escrow. |
| Keeper compensation | Creator's operating ETH pays actual verified draw/listing work | Immutable work/gas/price/max/burst envelopes bound policy quotes. Keeper transfer is **internal** to a creator+buyer+keeper coalition and cancels from its total wealth. |
| Irreversible external costs | Shapes mint fee, VRF service fee, FWA edge, all actual actor gas | No capital recovery. These remain losses after wind-down; successful backing redemption does not return mint fees. |

`KeeperPolicyCalls.reserve` (115–159) reserves missing inventory costs, bounded actual setup calls, one current maintenance bound, and actual unreconciled sequences. It does not reserve a lifetime board cycle or subtract expected surcharge income. `PoolInventory.fill` (153–161) retains only the candidate operation's enforced payment envelope and permits partial progress. `PoolBalancer._collect` (780–795), `_reserveInput` (742–746), and `withdrawableSurplus` (725–732) maintain the liquid/expected/profit distinction.

## One-screen flow and round-trip scorecard

All amounts are ETH. The detailed low-bid tables below supply exact cycle values.

| Regime / outcome | Measured result | Status / limit |
|---|---|---|
| Quiet stocked default board, 20 one-Shape prizes | **0.00368 liquid reserve** versus **0.0139 unsold fees** at base 0.5 / bid 0.55 gwei | Independently asserted separately; expected fees do not discount cash. No duplicate future board is held. |
| Max-policy stocked board | **0.00103265** current reserve at base 0.0005 / bid 0.001 gwei | Current-call envelope only; zero surcharge does not become cash. |
| Real 100 ETH prize win, no topups | Buyer owns actual backed prize; large slot remains missing; 19 small prizes continue trading/restocking | Admission remains 0, `creatorWork=false`, required reserve exceeds 100 ETH; depletion is exposed. |
| Ten following real small wins, base 0.5 / bid 0.55 gwei | Operating capital **+0.018073957464399730**; creator booked markup **+0.004982698235993700** | No automatic funding. Linear conditional refill of 100 ETH is ~**55,328 draws**, not a demonstrated full recovery. |
| Mature low→max policy switch with one actual outstanding draw | Requirement **0.00508**, available **0.00005**, shortfall **0.00503** | Activation fails until funded; unsold listing remains **0.0125**. Funds current work rather than future whole-board replacement. |
| Manufactured expiry and refused delivery | Buyer price is refunded; keeper receives creator-funded compensation; whole coalition loses VRF+gas | Expiry additionally assumes unavailable VRF. Failed delivery is creator-controlled and actually reaches quarantine/refund/recovery. |
| Manufactured unlist→restock | Exact **0.01** backing returns then re-enters; **0.001** new mint fee remains spent | Keeper's apparent profit cancels against creator cost. |
| Last curated NFT won | Admission becomes **3 / NO_CURATED**; controlled NFT returned to creator in measured cycle | Recovery requires creator relisting; no invented NFT restock actor. |
| Disable / close / unlist / claim / retire | Balancer **0**, owner proceeds **0**, refund credit **0**, all original **0.2** Shape backing redeemed | FWA retains only actual edge in delivered cases. All curated NFTs return to creator. |
| Gas spike / globally paused dependency / all setting extremes / full 1,000-prize execution | Not executed in this focused lane | No assurance claimed for these domains; root's broader candidate verification is separate. |

## Economic findings and limitations

**No confirmed exploitable positive creator+buyer+keeper coalition result in the executed regimes.** In particular, a positive buyer+keeper result is not external income: the creator supplies their reward. The incremental and complete launch scopes are kept separate below.

**Observed subsidy, not an unqualified attack finding:** at the deliberately low 0.001 gwei bid a buyer+keeper earns approximately 0.000047 ETH from an expired or refused curated draw, while creator capital loses approximately 0.000050 ETH. The full coalition still loses. Expiry cannot be assumed buyer-controlled while Chainlink operates normally. The refused NFT case requires the creator-controlled collection and policy, and is actually exercised through failed delivery, seven-day refund, player withdrawal and creator recovery.

**Long recovery is a real product limitation:** preserving a tiny launch reserve permits the 100 ETH slot to remain absent for a long time. The measured ten-small-draw operating gain implies ~55,328 identical future draws to accumulate 100 ETH. At 10 such draws/day this is about 15.2 years; at 100/day about 553 days. Those are arithmetic conditionals, not demand forecasts or full-fork lifecycle results. Zero demand never supplies the missing 100 ETH. R49 permits partial depletion, but “temporary” must not be presented as prompt automatic recovery. Add ETH or reduce the target remains a real creator decision.

## Security findings

None confirmed in the scoped paths. This lane tested economic destinations and rights across real FWA paths; it is not the separate security review and cannot establish system-wide safety.

### Scope of costs and equations

The **incremental cycle** baseline is after twenty Shapes are listed. It includes purchase and exact refund/redemption, actual keeper maintenance, creator manufacture/recovery calls, and the three actors' billed gas. The **full lifecycle** baseline precedes creator pool creation and includes configuration, policy selection/activation, initial paid setup, 20 initial mint fees, the cycle, close, all unlisting/withdrawal/claims, and retirement. All twenty initial prizes' **0.2 ETH backing** returns to the creator at closeout; a won Shape is redeemed by the buyer and its replacement backing returns to the creator. Curated NFTs return to the creator, so neither their invented cash valuation nor internal transfers create coalition income.

The complete-run total additionally includes the creator's real NFT collection, malicious policy and execution-probe deployment receipts. The once-per-system production factory/implementation/Packs deployment is performed through the production path, but paid by a separate system deployer and excluded from creator-coalition P&L: an attacker can use the already-deployed public factory and does not need to redeploy it. This excluded infrastructure cost can only make a broader all-participant total more negative.

The coordinator's actual delivery gas is retained separately in receipts, but is not charged a second time to the creator/buyer/keeper coalition; that coalition already pays the actual external VRF service charge. The coordinator is the permitted deterministic-delivery exception, not an extra coalition-owned income source.

For each cycle the executed script asserts, to the wei:

```
coalition change = creator wallet + buyer wallet + keeper wallet + Balancer liquid change
                 = -(actual three-actor gas + VRF fee + FWA edge + new mint fees)
```

After full closeout the Balancer is zero and all prize backing has left the system, so the wallet-only result equals the negative of initial+new mint fees, VRF, edge and actual actor gas. Keeper rewards are neither added as outside income nor subtracted twice.

### Current-price reference

A read from explicit Tenderly RPC returned block **26,437,289**, basefee **0.16477224 gwei**, during this review. A second replay used base **0.16477224 gwei** and bid **0.2 gwei**, asserted inside its state-changing probe and every receipt. The 0.001 gwei case is a deliberate low-price stress case, substantially below that observed current basefee; it is not a statement about today's typical inclusion price.

At the reference prices, incremental expiry buyer+keeper result is **−0.0005296056 ETH**, creator operating-fund cost **0.0001006216 ETH**, coalition **−0.0006302272 ETH**. Actual refused delivery/refund/recovery gives buyer+keeper **−0.0005472486 ETH**, creator fund cost **0.0000964862 ETH**, coalition **−0.0006752854 ETH**. The positive low-price buyer+keeper subsidy therefore does not persist at this particular reference price.

### Retained game-first behavior

Paid maintenance and policy activation exclude booked creator profit from spendable operating capital. **Public unpaid maintenance may spend it on real replacement backing**, then cap booked profit to remaining ETH (`_fillDeficit` passes keep=0 for unpaid work; `_performUpkeep` caps profit afterwards). This is retained game-first behavior, not a new unconditional promise that booked creator markup always stays liquid. No repair is proposed here.

### Values that ratchet

FWA issued/processed sequences and Balancer reconciliation sequence increase to maintain queue identity/order; policy generation and page epoch increase to prevent stale authorization/replay. These are identities, not financial claims. Cumulative external mint fees, VRF charges and edge cannot return after their trigger is removed; OWNER-REQUIREMENTS R25/R27 already describe these one-way costs. In contrast, the live required reserve, missing counts, surcharge expectations, booked profit and allowance are not permanent accumulation buckets: setup/claims/disable/close/consumption can reduce them. No new irreversible creator-capital bucket was identified in the reviewed reserve code.

## Exact receipt results

### Incremental existing-pool cycles, low bid

Basefee **0.0005 gwei**, bid **0.001 gwei**, 20 initial 0.01 ETH Shapes, one 0.2 ETH creator-created NFT, 15% Shape markup. Prices include **0.013738317757009345 ETH** acquisition fee; VRF is **0.00000234 ETH** per requested draw. A negative creator-fund cost is an inflow. These rows exclude already-paid initial mint/setup costs.

| Cycle | Buyer+keeper net | Creator fund cost | Keeper reward (internal) | Three-actor gas | Whole coalition net |
|---|---:|---:|---:|---:|---:|
| expired | 0.000047101972000000 | 0.000050253108000000 | 0.000050253108000000 | 0.000000811136000000 | -0.000003151136000000 |
| shape | -0.003641177747009345 | -0.001983166645532710 | 0.000100945504000000 | 0.000001465494000000 | -0.001658011101476635 |
| curated | -0.013691198489009345 | -0.013033857744532710 | 0.000050254405000000 | 0.000000795137000000 | -0.000657340744476635 |
| unlist | 0.000050078593000000 | 0.001050894261000000 | 0.000050894261000000 | 0.000001207006000000 | -0.001001207006000000 |
| failedDelivery | 0.000047013757000000 | 0.000050232431000000 | 0.000050232431000000 | 0.000001036427000000 | -0.000003376427000000 |

Delivered Shape/curated draws each leave **0.000654205607476635 ETH** FWA edge. The Shape winner redeems **0.01 ETH** and upkeep pays a new **0.001 ETH** mint fee. Expiry and failed delivery return the complete **0.013738317757009345 ETH** acquisition fee; zero edge accrues. Refused delivery reaches **AcquisitionStatus.DeliveryPending = 7**, **ListingStatus.DeliveryPending = 6**, Balancer pending state **2**, real NFT ownership by FWA, then the actual seven-day purchaser refund/withdrawal and creator NFT recovery. **ListingStatus 7 means DeliveryRefunded**, not pending.

### Complete creator launch through retirement, low bid

Each row starts before creating that pool and ends after closing, redeeming/unlisting every remaining Shape, returning the curated NFT, collecting all creator surplus and retiring. **Each includes 0.02 ETH initial mint fees**, all its creator/buyer/keeper receipts, and its incremental costs above. Initial backing is fully returned. Common contract-deployment expenses are added separately below.

| Cycle | Creator wallet change | Buyer wallet change | Keeper wallet change | All three-actor gas | Whole coalition net |
|---|---:|---:|---:|---:|---:|
| expired | -0.021066677222000000 | -0.000002963290000000 | 0.001050360570000000 | 0.000016939942000000 | -0.020019279942000000 |
| shape | -0.019033231551467290 | -0.003741287540009345 | 0.001100405101000000 | 0.000017568383000000 | -0.021674113990476635 |
| curated | -0.007982250476467290 | -0.013741263782009345 | 0.001050360601000000 | 0.000016608050000000 | -0.020673153657476635 |
| unlist | -0.022067683701000000 | 0.000000000000000000 | 0.001050373901000000 | 0.000017309800000000 | -0.021017309800000000 |
| failedDelivery | -0.021066498542000000 | -0.000003039136000000 | 0.001050348201000000 | 0.000016849477000000 | -0.020019189477000000 |

Common NFT/policy/probe deployment and probe transaction gas paid by creator: **0.000000860408000000 ETH**. Complete five-pool run including these costs: **-0.103403907274953270 ETH**, with **0.000086136060000000 ETH** total three-actor receipt gas. The malicious policy deployment alone costs **0.000000108775000000 ETH**. Coordinator receipts separately total **0.000001568830000000 ETH** and are excluded from coalition gas to avoid double-counting the external VRF service.

### Same cycles at the live-basefee reference

Basefee **0.16477224 gwei**, bid **0.2 gwei**, same fork state and input board. VRF **0.000468 ETH** per request.

| Cycle | Incremental buyer+keeper net | Incremental coalition net | Full launch→retire coalition net |
|---|---:|---:|---:|
| expired | -0.000529605600000000 | -0.000630227200000000 | -0.023855945200000000 |
| shape | -0.004210315757009345 | -0.002415308807476635 | -0.025635885207476635 |
| curated | -0.014264464157009345 | -0.001281233007476635 | -0.024443815207476635 |
| unlist | 0.000065718600000000 | -0.001241401200000000 | -0.024462021600000000 |
| failedDelivery | -0.000547248600000000 | -0.000675285400000000 | -0.023837878600000000 |

Complete reference five-pool result including common creator deployment/probe gas: **-0.122407622614953270 ETH**; three-actor gas **0.017227211400000000 ETH**.

### Focused event/custody/refund witness

A final **single-case rerun** (`--failed-only`) explicitly decoded real `NFTDeliveryFailed(listingId=1, recipient=0x00000000000000000000000000000000000ec002, collection=0x69FCa34aa0c65778B16AE1c14d0bd6f6A3765dFa, tokenId=1)` from FWA's actual VRF-delivery transaction, asserted the NFT still belonged to the FWA pool before refund, read `DELIVERY_WINDOW=604800`, and asserted the buyer's post-withdrawal ETH increase plus its receipt gas equalled the exact escrow price. Creator recovery and retirement then succeeded.

For this fresh single-pool deployment (rather than the fifth pool sharing an already-used collection), incremental buyer+keeper net is **+0.000046996657 ETH**, creator-fund cost **0.000050232431 ETH**, coalition **−0.000003407207 ETH**, actor gas **0.000001067207 ETH**. Its complete pool lifecycle is **−0.020019232611 ETH**; including the common collection/policy/probe deployment and probe cost, **−0.020020093019 ETH**. The slightly different actual gas reflects its fresh collection balances and token ID; it is not substituted into the five-pool table.

## Commands, results and retained evidence

All commands ran from `/Users/dd/CascadeProjects/fwa-pool-balancer/.worktrees/keeper-policies`. Networked fork commands ran outside the sandbox after the sandbox's DNS failure. Source/config/owner-requirement hashes still matched all twelve immutable manifest entries after the runs, before the documentation-only addendum below.

| Command / exact scope | Exit / result | Raw output |
|---|---|---|
| `forge test --match-path test/ReserveEconomicReview.t.sol --isolate -vv` | **0**, 5/5 focused tests; 8.31 s executed suites on the final test source | `/private/tmp/reserve-economic-forge-complete.log` |
| `npx tsx keeper/reserve-economics.ts` | **0**, all five low-price real-receipt lifecycles, exact coalition reconciliation, direct NFT custody/refund assertions | `/private/tmp/reserve-economic-receipts-sealed.log` |
| `REVIEW_BID_WEI=200000000 REVIEW_BASE_WEI=164772240 npx tsx keeper/reserve-economics.ts` | **0**, five reference-price real-receipt lifecycles, exact reconciliation | `/private/tmp/reserve-economic-receipts-reference.log` |
| `npx tsx keeper/reserve-economics.ts --failed-only` | **0**, actual failed-transfer event, FWA NFT custody, exact buyer refund, creator recovery and retirement | `/private/tmp/reserve-economic-failed-delivery-event.log` |
| `npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --skipLibCheck keeper/reserve-economics.ts` | **0**, final targeted strict typecheck passed | Targeted script only; broader project gates are the root's separate work |
| `cast rpc eth_getBlockByNumber latest false --rpc-url https://mainnet.gateway.tenderly.co` | **0**, block 26,437,289 / basefee 164,772,240 wei | Live reference observation; replay remains pinned to fork block 26,382,349 |

The script internally executes the existing production deployment path as `PACKS_ADMIN=<local-deployer> KEEPER_ADMIN=<local-deployer> POLICY_ADMIN=<local-deployer> forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:18552 --unlocked --sender <local-deployer> --broadcast --skip test`. It verifies a fresh isolated Anvil, chain ID, code and authority; restores the preexisting nonsecret generated deployment JSON afterwards; and shuts down only the node it created. Test actors are fresh EOAs impersonated/unlocked on this isolated node, funded once before their wealth baseline; these are actual local transaction receipts, not proof of real wallet signing behavior or a live gas market.

Harness failures are preserved rather than overwritten: sandbox DNS failure (`/private/tmp/reserve-economic-forge.log`); initial async receipt lookup before inclusion (`/private/tmp/reserve-economic-receipts.log`); a duplicate deterministic clone salt in the first large-win setup (`/private/tmp/reserve-economic-forge2.log`); and an optimized repeated `block.timestamp` read in a second `vm.warp` (`/private/tmp/reserve-economic-forge-sealed.log`). Those setups were corrected with receipt polling, a distinct creator salt, and `vm.getBlockTimestamp()`. Targeted TypeScript iterations also exposed and corrected wrong argument position, bigint coercion and RPC-parameter typing. None was represented as a successful product execution. The final focused test run and all retained receipt tables pass.

## Limits and completion

This review adds only `test/ReserveEconomicReview.t.sol`, `keeper/reserve-economics.ts`, and this report. It changes no production contracts or prior tests/helpers. The lead owns the coherent candidate commit and broader Foundry/TypeScript/keeper/simulation/asset-gate verification; there is no standalone audit-repair or deployment authority here.

The low-bid gap is measured, including complete creator-side costs and backing returns. Full demand distributions, all prize mixes/counts, all policy failures/extremes, gas spikes, dependency pause/resumption, malicious callbacks outside these cases, current-head forks, real randomness timing, live keeper competition, real transaction signing, production rehearsals and canaries remain outside this lane. The twenty-Shape board is a concrete small launch configuration; the 100 ETH jackpot case separately exercises value scale. The linear 55,328-draw recovery number has not been executed to completion and must not be presented as a simulation proven against a full fork recovery. Raw temporary logs contain the exact receipts and hashes; preserve them elsewhere if durable release provenance is required.

## Documentation-only final-source addendum

After the measurements were sealed, the lead corrected stale `PoolBalancer.sol` comments describing spare/full-setup reserves, conditional profit booking and unpaid maintenance. The measured source hash was `70f2b32dc898dff56c2798494f2d24a72075995c336829d676bac4937b175bd4`; the final comment-corrected source hash is `e98890d6a5a3a495b988c9c812d4ca5b1b6d1f450a1d1d3d646d640d1651c8d5`. Independent comparison after removing comments and whitespace found identical executable Solidity; the other eleven manifest entries remain unchanged. No behavior retest or new measurement is claimed for this documentation-only delta. Existing receipt results above refer to the original measured source.

## Things that don't make sense

- **“Temporary” depletion can last years at community-pool demand.** Without Add ETH or a smaller target, the measured 100 ETH deficit needs roughly 55,328 comparable small draws to refill. The system exposes the deficit and does not guarantee demand.
- **A keeper's or buyer+keeper's gain is not creator profit.** The low-price positive results are creator-funded; reporting those transfers as coalition income would reverse the conclusion.
- **Booked profit is not universally liquid protected.** Public unpaid game-first maintenance may transform it into prize backing. This retained behavior must stay explicit in product/economic acceptance.
