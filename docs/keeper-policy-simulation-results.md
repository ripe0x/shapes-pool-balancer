> **Historical a8fb321 reserve model.** These results retain the superseded full-board maintenance reserve and automatic curated-NFT replacement assumptions. Current results are in [reserve-redesign-simulation-results.md](reserve-redesign-simulation-results.md). The historical values below are unchanged.

> **Historical `a8fb321` evidence.** The capital-intensive reserve and related bounds below are superseded by [RESERVES.md](RESERVES.md) and the current reserve redesign results. Preserve these numbers as history; they do not describe the current implementation.
# Keeper policy economics scenarios

Generated with `npm run sim`. **Model estimates, not release or fork parity evidence.** The model reads the V1 parameters exported by the Solidity policy fixture test.

The generated `test/fixtures/keeper-policy-money-path.json` is independently replayed by `shared/policy-money-path.test.ts`: every setup, delivered/refunded draw, V1-to-V2 activation, redemption and withdrawal step matches pool ETH, booked profit, listed backing, recorded surcharges, reserve, FWA proceeds/prices and reward arithmetic. The underlying fork uses block 26,382,349, actual FWA and Shapes, production Draw Packs deployed locally, basefee 0.5 gwei and bid 0.55 gwei; the repository-authorized coordinator impersonation supplies deterministic VRF words. This bounds money-branch parity. It does not calibrate the stochastic scenarios' transaction gas, batching, demand, admission pauses or timing.

All scenarios: 25% Shape markup, 0.001 ETH Shapes mint fee, FWA 5% edge, deterministic seed 12345, 30 days, 40 desired draws/day unless named otherwise. The 5 gwei case bids 5 gwei with zero priority; the keeper's default 0.05 gwei priority skips a 5 gwei basefee. Draw price excludes randomness and transaction gas.

| Scenario | Draws | Initial ETH | Switch ETH | First / final draw ETH | Reserve ETH | Keeper net ETH | Creator net ETH | Paid service outage hours |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| small Shapes 0.15 gwei | 1200 | 1.1027 | 0.0000 | 0.01537 / 0.01537 | 0.6296 | 0.04822 | 2.7818 | 0.00 |
| small Shapes 0.5 gwei | 1200 | 1.1027 | 0.0000 | 0.01572 / 0.01572 | 0.6243 | 0.04822 | 2.5085 | 0.00 |
| small Shapes 5 gwei | 1200 | 1.1027 | 0.0000 | 0.02013 / 0.02013 | 0.5562 | 0.04822 | -0.9733 | 0.00 |
| mixed Shapes and packs 0.15 gwei | 1200 | 4.7729 | 0.0000 | 0.02263 / 0.02263 | 2.0922 | 0.05206 | 4.8818 | 0.00 |
| mixed Shapes and packs 0.5 gwei | 1200 | 4.7729 | 0.0000 | 0.02310 / 0.02310 | 2.0749 | 0.05220 | 3.7927 | 0.00 |
| mixed Shapes and packs 5 gwei | 1200 | 4.7729 | 0.0000 | 0.02903 / 0.02903 | 1.8546 | 0.05242 | 2.2933 | 0.00 |
| NFT heavy 0.15 gwei | 1200 | 1.1027 | 0.0000 | 0.02391 / 0.02391 | 0.6296 | 0.04252 | 2.3873 | 0.00 |
| NFT heavy 0.5 gwei | 1200 | 1.1027 | 0.0000 | 0.02432 / 0.02432 | 0.6243 | 0.04228 | 1.8113 | 0.00 |
| NFT heavy 5 gwei | 1200 | 1.1027 | 0.0000 | 0.02912 / 0.02912 | 0.5562 | 0.04152 | -1.3206 | 0.00 |
| large expensive 0.15 gwei | 1200 | 73.9128 | 0.0000 | 0.01551 / 0.01551 | 33.5564 | 0.07066 | 1.8224 | 0.00 |
| large expensive 0.5 gwei | 1200 | 73.9128 | 0.0000 | 0.01586 / 0.01586 | 33.2162 | 0.07066 | 1.3801 | 0.00 |
| large expensive 5 gwei | 1200 | 73.9128 | 0.0000 | 0.02034 / 0.02034 | 28.8908 | 0.07062 | -4.2202 | 0.00 |
| quiet 1/day | 30 | 4.7729 | 0.0000 | 0.02310 / 0.02310 | 2.0749 | 0.00236 | 0.1193 | 0.00 |
| bursty 240/day | 7200 | 4.7729 | 0.0000 | 0.02310 / 0.02310 | 2.0749 | 0.30686 | 25.0436 | 0.00 |
| zero demand | 0 | 4.7729 | 0.0000 | 0.02310 / 0.02310 | 2.0749 | 0.00110 | -0.0699 | 0.00 |
| large win every 200 draws | 1200 | 4.7729 | 0.0000 | 0.02310 / 0.02310 | 2.0749 | 0.05170 | 1.2096 | 0.00 |
| refund each fifth draw | 1200 | 4.7729 | 0.0000 | 0.02310 / 0.02310 | 2.0749 | 0.04666 | 2.8282 | 0.00 |
| gas spike then idle day | 1160 | 4.7729 | 0.0000 | 0.02310 / 0.02310 | 2.0749 | 0.05050 | 3.5648 | 24.00 |
| sustained gas spike seven days | 920 | 4.7729 | 0.0000 | 0.02310 / 0.02310 | 2.0749 | 0.04018 | 2.8638 | 168.00 |
| V2 switch with demand elasticity 2 | 1186 | 4.7729 | 1.5639 | 0.02310 / 0.02313 | 3.4035 | 0.03961 | 4.0763 | 0.00 |
| V1 to V2 active board | 1200 | 4.7729 | 1.5639 | 0.02310 / 0.02313 | 3.4035 | 0.03990 | 3.9675 | 0.00 |
| policy outage | 1160 | 4.7729 | 0.0000 | 0.02310 / 0.02310 | 2.0749 | 0.05050 | 3.5648 | 24.00 |
| dependency paused | 1160 | 4.7729 | 0.0000 | 0.02310 / 0.02310 | 2.0749 | 0.05050 | 3.5648 | 24.00 |

For one 864,000-gas measured replacement span plus an assumed 50,000 billed outside-span gas, V1 pays 0.0002228 ETH at basefee 0.15 / bid 0.20 gwei, 0.0005427 ETH at 0.50 / 0.55 gwei, and 0.0046100 ETH at 5.00 / 5.05 gwei. Modeled no-refund margins are +0.0000400, +0.0000400, and -0.0000057 ETH respectively. At basefee 5.00 with zero priority (bid 5.00), the margin returns to +0.0000400 ETH; the service's default 0.05-gwei priority skips this boundary. These are arithmetic examples, not receipt-based profitability claims.

## Modeled asset-flow scorecard

| Regime | Creator ETH in | FWA proceeds in | Fund at end | Listed backing | Creator withdrawals | Backing delivered | Shapes mint fees | Keeper pay | Accounting gap |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| mixed Shapes and packs 0.5 gwei | 4.77285 | 26.39977 | 2.07488 | 1.70000 | 5.99063 | 18.87000 | 1.41000 | 1.12711 | 0 wei |
| zero demand | 4.77285 | 0.00000 | 2.07488 | 1.70000 | 0.92803 | 0.00000 | 0.05500 | 0.01495 | 0 wei |
| sustained gas spike seven days | 4.77285 | 20.23982 | 2.07488 | 1.70000 | 4.86182 | 14.42000 | 1.08900 | 0.86698 | 0 wei |
| V1 to V2 active board | 6.33678 | 26.41731 | 3.40351 | 1.70000 | 6.40073 | 18.71000 | 1.42400 | 1.11586 | 0 wei |

Creator net includes the opportunity value of every contributed curated NFT, even when the model assumes the creator replaces a won NFT immediately. Operating ETH remains the creator's and is counted in final wealth; it is not earnings. Keeper net includes initial setup, no failed attempts, no operator overhead, and a billed-gas assumption of measured span + 50k without refunds. Cumulative service latency is a scenario assumption (12-24 seconds per batch), not a measurement of sales unavailability. The outage column includes only modeled full-day paid-service outages. Actual FWA admission pauses and real pool availability are unmeasured here. Policy outage and gas above the cap stop paid service for a modeled day; actual unpaid recovery must be demonstrated by fork tests.

The bridge is `max(2 × selected maximum × max(target prizes, active Shape prizes) − recorded listed surcharges, 0)`. Surcharges in unsold prizes are never liquid capital. Existing prices stay fixed across the policy switch. V2 matches the test policy schedule: 70k overhead, 8 gwei ceiling, 0.02 gwei priority allowance, 0.00001 ETH per draw and 0.00004 ETH per listed prize, with surcharge gas 950k per Shape prize or 1.1M per pack plus 0.00025 ETH per contained Shape. Its declared maximum is 0.03 ETH. Matching formulas alone does not establish transaction parity.

The model explicitly charges processing in separate calls (two draws/call), then one restock per won prize, a stressed split schedule. It does not claim that this is the cheapest keeper behavior. Every run checks exact ETH and NFT-value accounting. Its transaction gas, FWA prize selection, admission pauses, requester refunds, and timing are modeled, not replayed transactions. A conservation check is not economic or fork parity proof.

## Demand sensitivity

Holding volume constant is an exposure comparison, not a forecast. At fixed demand elasticity 1, a 20% draw-price increase reduces expected volume to 83.3%; elasticity 2 reduces it to 69.4%. At elasticity 3 it is 57.9%. These are hypothetical sensitivities, not empirically fitted demand. A higher fee can lower total fee income despite improving income per draw.

## Things that don't make sense

The whole-board worst-case bridge is deliberately expensive: a 1,000-prize board locks tens of ETH in operating capital even if observed keeper costs are much lower. This is the cost of reserving two maximum payments per prize rather than using a tighter enforced operation-specific envelope. The model's high-volume and immediate NFT-replacement assumptions do not establish real demand or creator willingness.
