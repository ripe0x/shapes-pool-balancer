# Independent economic review: replaceable keeper policies

Date: 2026-11-17. Scope: the policy replacement, reserve, pricing and payout changes on top of main `a29af3a`, including affected creator withdrawals and real FWA/Shapes/Draw Packs flows. This is a focused, informed review, not a full audit or a claim of release readiness. No professional human review or method calibration was performed here.

## Target and execution

Initial immutable snapshot: `/private/tmp/keeper-policy-review-source-r2`, manifest SHA-256 `57ee23cebcd395a2622c125510942a04f801d5efd38c0fe9571b78cf339fbd4d`. Every manifest entry matched the working tree before counterexample execution. The only subsequent production delta examined was the emergency-disable repair:

| File | Final SHA-256 |
| --- | --- |
| `src/KeeperPolicyCalls.sol` | `d05a1da9901663a58ad76165353b651cd114a22447f3c838b611ab131b93bc7c` |
| `src/PoolBalancer.sol` | `2e777f27386ba35e1d7a9378ffee1657c1fb3502e216395d81dcfba5c93d6f61` |
| `src/PoolInventory.sol` | `f8a9a21f50bcd98f9d01232d20d97a7ca5d960db882f74efebda918625c32b75` |
| `src/KeeperPolicyV1.sol` | `d0a859d2d146b74637ace4418b9865c3cccbc80dd57f9b0dd379818afc993038` |
| `src/BalancerFactory.sol` | `6e0a60f6b3fa264cd15db657ab019b9da543ce3282bdd1818275aa0720a5141a` |

Other production/configuration files remained identical to the snapshot. Initial discovery used source and owner requirements before comparison with the builder's policy/simulation documents. No other new review report was consulted. The production repair was made by the implementation owner, not this reviewer.

Tests: `test/PolicyEconomicReview.t.sol`. Foundry 1.8.1, Solidity 0.8.28, optimizer 50, via IR, Cancun. The fork is block **26,382,349**, using `https://mainnet.gateway.tenderly.co` through the configured `mainnet` RPC alias. Both basefee **0.5 gwei** and transaction gas price **0.55 gwei** are set and asserted inside a state-changing `GasProbe.record()` call. Actors are funded external test wallets. No protocol balance/state fabrication or mock counterparty is used. The custom policies are actual deployed, interface-compatible choices the system permits; the creator's test NFT is an untrusted third-party collection allowed by design.

FWA factory: `0x8919814D825a5Af238cC04DE06b1C18c9eaA477C`; pinned implementation: `0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7`; Shapes: `0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0`. FWA implementation codehash is checked by the actual implementation constructor. Production Draw Packs code is deployed locally on the fork, wrapping the deployed Shapes; it is not a substitute protocol. This review did not independently reproduce all external verified-source compiler outputs. Assertions about custody, price, redemption and refunds below are demonstrated by actual calls to these dependencies. The four review tests use no injected randomness: purchased draws expire through the real FWA queue.

Commands and retained evidence:

| Command | Exit / result | Evidence |
| --- | --- | --- |
| `forge test --match-path test/PolicyEconomicReview.t.sol --match-test test_emergencyDisableInvalidatesMaturedProposal --isolate -vv` | First sandbox attempt could not resolve the public RPC; no behavior tested | `/private/tmp/keeper-policy-economic-disable-witness.log` |
| Same focused command with approved network execution | **1**, intended counterexample reached; public activation did not revert after emergency disable | `/private/tmp/keeper-policy-economic-disable-witness-network.log` |
| `forge test --match-path test/PolicyEconomicReview.t.sol --no-match-test test_emergencyDisableInvalidatesMaturedProposal --isolate -vv` | **0**, two capital/refund round trips passed | `/private/tmp/keeper-policy-economic-roundtrips-network.log` |
| `forge test --match-path test/PolicyEconomicReview.t.sol --isolate -vv` | **0, 4/4 passed** after repair; last compile 3.05 s, last suite 1.34 s | `/private/tmp/keeper-policy-economic-review-final.log` |

The initial network/filter limitation was explicit; it was not counted as a semantic failure or success. No whole-suite or invariant campaign was duplicated by this reviewer. Aggregate Foundry test gas includes many independent protocol calls and is not an EIP-7825 transaction-size measurement. Test wallet transfer deltas establish gross value flows; they do not automatically charge each impersonated actor its real transaction gas. No keeper net-profit claim below is inferred from those deltas or from the disputed `lastCallGas` refund interpretation.

## Finding E-1: a matured proposal could undo emergency disable

**Medium, repaired and independently retested.** `KeeperPolicyCalls.disable` originally left `pending` and its activation timestamp intact. The witness stocked twenty real Shapes, proposed a different V1 instance, advanced the full two days, disabled paid upkeep as creator and asserted payment was disabled. A stranger could then activate the already matured proposal immediately, reenabling payment without a new delay.

The exposed funds were creator operating capital under the previously proposed policy, not player refunds. Nevertheless the public executor defeated the creator's emergency stop and the stated fresh-delay reenabling rule. The repair atomically calls `cancel(s)` during disable. The same permanent witness now rejects public activation and keeps payments disabled. It preserves the separate two-day proposal mechanism and does not reset the spending allowance. This is the only newly reproduced control defect from this economic review.

## Independently derived asset and authority map

| Bucket / flow | Owner and trigger | Reversal and final destination |
| --- | --- | --- |
| Balancer operating ETH | Creator deposits and collected FWA proceeds; selected policy quotes only | Reserve limits creator claims; closed, fully reconciled capital can be claimed. Policies receive no custody |
| Booked `profit` | Creator's Shape markup above the game's first 10%, credited from real proceeds | Claims spend this counter first. Activation and paid keeper funding use `balance - profit`, excluding these independently withdrawable funds |
| Shape / Pack backing | ETH in real Shapes, represented by NFTs owned by FWA or by the Pack wrapper | Creator unlists and redeems for exact backing; a winner receives the backed token instead |
| Mint fees | Real Shapes minting | One-way, retained in Shapes' accrued fee accounting, not recoverable by the Balancer |
| Listed surcharge record | `Item.price - Item.base`, aggregated for listed Shape/Pack prizes | Future-income information only. No liquid ETH is created when a listing is made; removal reverses the record |
| FWA pending price / refund | Player pays FWA; expiry converts the acquisition price to refund credit | Only the player withdraws the refund. Closing, policy changes and creator retirement cannot claim it |
| FWA proceeds / edge / VRF | Real delivered draws generate proceeds and edge; request pays the VRF service | Proceeds collect into the creator pool; edge and randomness charges do not become keeper-owned escrow |
| Keeper transfer | Immutable useful progress, policy quote, cached bound, hard envelope, allowance and caller floor all succeed | Actual creator operating ETH transfers to the caller. The policy cannot redirect prize backing or refund claims |

Withdrawal preservation can also be derived algebraically. A claim at or below booked profit reduces balance and profit equally, leaving operating funds unchanged. A larger allowed claim leaves at least `requiredReserve`. Therefore, while the target, obligations and selected maximum remain unchanged, a successful funded activation cannot be defeated merely by withdrawing booked profit.

## One-screen scorecard and round trips

All figures below are exact fork values at basefee 0.5 / bid 0.55 gwei. Gross keeper receipts are separate from execution expense.

| Reached case | Capital / liabilities | Destination at completion |
| --- | --- | --- |
| Twenty 0.01 ETH Shapes, 15% markup, one 0.2 ETH NFT, zero demand | Empty-board reserve **1.2838 ETH**; stocked reserve **0.7209 ETH**; listed backing **0.2 ETH**; recorded unsold fees **0.0139 ETH** | Unsold fees create **0 ETH** of proceeds and **0 ETH** of profit |
| Same stocked board adopts a policy declaring 0.03 ETH maximum | Required operating capital **1.3171 ETH**; exact additional deposit **0.5962 ETH** after claiming old surplus | Activation without the deposit reverts. Every original listing price and the 0.0139 ETH fee record stay unchanged |
| Zero-demand complete closeout after that switch | Deposits total **5.5962 ETH**; gross setup keeper payments **0.006073756 ETH**; actual mint fees **0.02 ETH** | Creator recovers **5.570126244 ETH**, plus the same NFT. Pool/FWA proceeds/fee record all end at zero; creator transfer-value cost is **0.026073756 ETH**, excluding actor gas |
| Twenty small Shapes plus one 0.03 ETH Pack | **23 underlying Shapes**, **21 prizes**; empty reserve **1.42105 ETH**; stocked reserve **0.773715 ETH**; fee record **0.015985 ETH** | Pack lists at **0.039585 ETH**, its base is **0.0375 ETH**; actual Pack NFT value is **0.03 ETH**. Pack redemption returns exactly 0.03 ETH; all backing reverses, exactly **0.023 ETH** of mint fees remains one-way |
| Two real draws expire while switching to a uint-max-quote policy | Declared maximum **0.311 ETH**; creator adds **11.417173756 ETH**, reaching **16.1911 ETH** required capital with two outstanding draws | Actual reward is only **0.0022152194 ETH**, capped by gas/work envelope. It comes entirely from Balancer ETH; no creator proceeds are fabricated |
| Same hostile-policy case, creator exits completely | Player refund credit **0.028999313514543896 ETH** remains equal to real FWA ETH | Balancer reaches zero and retires while the credit remains intact. The buyer then actually withdraws the exact credit; FWA ETH reaches zero |
| Emergency disable after a mature proposal | Creator's `false` state is reached before stranger execution | After repair, proposal cannot reactivate payment. A fresh proposal and delay are required |

The first full ledger is independently balanced: 5.5962 ETH deposited equals 5.570126244 ETH returned to creator + 0.006073756 ETH paid to keeper + 0.02 ETH retained as mint fees. All twenty backed prizes and the curated NFT return. The Pack case separately proves the other backing path, rather than assuming Shape redemption covers Pack custody. The expiry case separately proves the player's entitlement survives creator closeout and is withdrawable; merely observing the credit counter was not the final assertion.

## Remaining economic decisions and limits

- **Solvency is distinct from self-funding.** The bridge reserves actual creator ETH against a calculated future-income gap. It does not prove arbitrary policies or unlimited future draws remain profitable. Curated NFT turnover has no restocking surcharge and is not covered by the Shape/Pack board-cycle term. Outstanding draws are separately held at one cached maximum each.
- **Large capital requirement.** The conservative bridge budgets two maximum payments per target/active prize. The verified twenty-small-Shape example locks 0.7209 ETH after only 0.2 ETH backing is listed. Builder models report roughly 73.9 ETH to open a 1,000-prize expensive board; that modeled figure is not independently replayed here. Tightening future operation-specific enforced bounds could lower capital requirements, but an optimistic gas average cannot replace a hard liability bound.
- **Generous spending ceiling.** Source arithmetic permits at most 3.11 ETH burst plus `floor(0.311 ETH / 12)` wei per second, or **2,242.3099999999999424 ETH /24h** and **817,311.109999999978976 ETH /365d** including burst. Actual work, cached maximum and available creator funds add restrictions. These are finite bounds, not small expected expenditure. Policy changes and reopening do not reset stored allowance/time; inactivity saturates at the burst.
- **Malicious-policy manufacturing cost remains unmeasured.** The immutable service envelope permits up to 0.001 ETH per verified draw before gas. At very low gas a voluntarily selected malicious max-return policy could subsidize keeper/buyer work creation from creator operating capital. No additional low-gas attack was implemented or executed after the parent's documentation-only stopping instruction. A complete keeper/buyer net figure cannot be claimed from the four existing tests. A controller combining creator, buyer and keeper has no new external asset source; the separately demonstrated player refund remains protected. The allowed creator-capital exposure deserves owner review.
- **Splitting, refunds and profitability.** Work-based fees remove duplicated service units, not extra transaction gas or overhead/refund surplus. This review did not independently execute a new splitting campaign or compute billed keeper profit; the lead's receipt-based evidence must support such numbers. The parent identified a disputed Foundry gas/refund helper during this review, so no new economic claim relies on that helper.
- **Market limitations.** Gas-market inclusion, competition, demand elasticity, VRF timing, actual FWA admission downtime and immediate creator replacement of won curated NFTs are not established by these counterexamples. The builder's deterministic money-path replay and stochastic scenarios explicitly separate accounting parity from these assumptions. Higher price with fixed demand is an exposure comparison, not an income forecast.
- **Scope limit.** Factory/pool authority separation, frozen listing records, cached policy maximum and persistent allowance were examined in source; the review did not repeat every adversarial family, broad suite, live service failure or launch rehearsal. No negative conclusion covers those unexecuted domains. The original outcome signature cannot approve changed payment text, and this report supplies neither a new signature nor deployment authority.

## Things that don't make sense

A small operating budget and unlimited paid throughput cannot both be guaranteed. The chosen absolute spending bounds are very large, while the bridge locks substantial capital even for a quiet pool. Those choices need owner consideration alongside measured demand and keeper competition. The planned low-gas hostile-policy keeper/buyer profit calculation remains explicitly unmeasured; no estimate is presented as a passed attack or safe result.
