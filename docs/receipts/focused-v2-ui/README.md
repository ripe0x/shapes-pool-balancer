# Local creator-fee UI acceptance: PASS

Owner approved the previously prepared local UI batch, including its 15-minute allowance. Signature committed as `9d0e79d`; runtime/UI source candidate remains `e47fdef`, gate source digest `58c252dd452c6c54b2b91694ed6c25e52f65eb9face0725d6ba1b88461c0596b` unchanged. No mainnet transaction, extension-wallet write, new funding, implementation deployment or source change occurred.

Endpoint `http://127.0.0.1:8545`, chain 31337, existing owned Anvil instance `0x6518a4ca87cd31c66fe37cb668400be58d8c88b87be33e111edc714d5723e591`, Tenderly upstream pinned at 26485619. Synthetic creator `0x000000000000000000000000000000000001e004`; buyer `0x000000000000000000000000000000000001e008`. Dedicated new Balancer `0xDEd100384216DCcdD69C5eEd735E773dF0Dc3395`, FWA pool `0x126211b470E8B564a971CD19a37B1ce9675d6087`. Existing user pool was not a transaction target. Node, app and real keeper remain running.

## What was exercised

1. `node --import tsx docs/receipts/focused-v2-ui/run.mjs setup`, exit 0: atomic creation with .1 test ETH, automatic fee setting zero in the tuple, three small automatic prizes, no curated NFT. Deposit snapshot asserts zero fees and zero profit. Existing funded actors were reused; no balance/storage was fabricated for a protocol contract.
2. `LOCAL_FACTORY=0xbe49677a403f77136e81498e5681f8dc22aa1181 node --import tsx scripts/local-draws.ts --balancer 0xDEd100384216DCcdD69C5eEd735E773dF0Dc3395 --buyer 0x000000000000000000000000000000000001e008 --count 3 --max-spend-eth 0.1 --allow-simulated-randomness --execute`, exit 0, `draws.log`: three actual NFT wins, actual buyer custody and fully restored original target after each draw, serviced by the production keeper. Callbacks are explicitly simulated; genuine coordinator commitments are not consumed. This is not fresh cryptographic VRF evidence.
3. `node --import tsx docs/receipts/focused-v2-ui/run.mjs gap`, exit 0, `gap.log`: turn paid upkeep off only for this test pool, increase target to 20 small Shapes and contribute only enough to leave a gap equal to half the accrued fees. This makes the UI's exact-gap cap reachable without fabricated income.
4. Actual app at `http://127.0.0.1:5280/#pool/0xDEd100384216DCcdD69C5eEd735E773dF0Dc3395`, synthetic local dev connector. Before top-up, the UI displayed a .002249451076042450 ETH shortfall, .004498902152084901 ETH accrued fees, the exact maximum/remaining amounts, and disabled Withdraw. Clicked **Top up from creator fees**. The app confirmed the real reinvest transaction and its appended unpaid upkeep, refreshed capital/fees/reserve, and showed the remaining fees available for withdrawal. No fixture props or fake successful service answers were used.
5. Three actual **Run maintenance** clicks completed the remaining target (four unpaid upkeep transactions total including the appended one). UI showed 20/20 listed and zero current reserve gap. This target-expansion stocking was explicit unpaid UI maintenance, not autonomous paid keeper work. Previously reserved fees survived all four passes. Target expansion spent real mint fees and the signed bankroll result correctly became negative.
6. Clicked **Withdraw** in the app. It confirmed the actual exact remaining fee claim, refreshed accrued/withdrawable fees to zero, and added the withdrawal-history row. The synthetic connector was disconnected afterward. The final test-pool view is left available; the pool retains 20 real .01 ETH Shapes. Paid upkeep remains off for this dedicated test pool, so it is not a production operating configuration.

## Economic scorecard and complete cash ledger

| Flow / state | Exact amount |
| --- | ---: |
| Total contributed native ETH (creation + gap deposit) | 0.214459643444269380 ETH |
| Player purchase value, all three draws | 0.050318325118345500 ETH |
| Actual owner receipts collected | 0.041236500019110000 ETH |
| Creator fees before UI | 0.004498902152084901 ETH |
| UI reinvestment maximum and actual use | 0.002249451076042450 ETH |
| Fees retained after reinvestment | 0.002249451076042451 ETH |
| Cash movement on reinvestment | 0 ETH |
| Increase in capital on reinvestment | 0.002249451076042450 ETH |
| Total real mint payments: backing + mint fees | 0.253000000000000000 ETH |
| Backing minted / won / retained | 0.23 / 0.03 / 0.20 ETH |
| Actual mint fees, 23 mints | 0.023000000000000000 ETH |
| Paid production keeper rewards | 0.000446692387336929 ETH |
| Actual UI creator withdrawal | 0.002249451076042451 ETH |
| Final contributed-capital hurdle | 0.216709094520311830 ETH |
| Final Balancer cash / protected fees / FWA owner proceeds / unsettled requests | 0 / 0 / 0 / 0 |
| Final signed bankroll result, separate from gross fees | −0.016709094520311830 ETH |

Cash identity, asserted in integer wei: deposits + collected owner receipts − mint payments − keeper rewards − creator claim = **0** final cash. Reinvestment is an internal reclassification and appears in neither side of that cash identity. The exact claim is verified by the creator wallet delta plus that transaction's actual gas. All 20 final automatic denomination-0 items have actual Shapes `backingOf(tokenId) == .01 ETH`, summed to .2 ETH; ownership is FWA custody. All three won NFTs remain in the buyer wallet. Curated assets and offchain NFT cost basis are absent from this scenario.

The larger target and its .017 ETH of extra mint fees are a deliberate boundary setup, not a forecast of normal three-draw profitability. Closing/capital recovery was not added to this approved UI batch; existing genuine-proof closeout evidence remains separate and valid. Deposits still create no earnings, and there is no new automatic fee donation.

## Receipts, limits and commands

`postflight.json` retains 20 canonical local successful receipts, decoded calldata, before/after block-pinned accounting, actual wallet amounts and custody readbacks. `state.json` preserves setup snapshots/approval caps; `final-inventory.json` independently records actual per-token backing. These scripts are saved execution evidence bound to this instance/deadline, not general future transaction authorization.

- `node --import tsx docs/receipts/focused-v2-ui/verify.mjs`, exit 0, `verification.log`: signer/target/value, all receipts, exact cap, no cash movement/profit creation, reserve-gated initial refusal, protected remaining fees, exact actual wallet withdrawal, custody and final state.
- `python3 docs/receipts/focused-v2-ui/check-ledger.py`, exit 0, `ledger-check.log`: independent integer cash ledger, minted/delivered/retained backing, fee/capital reclassification and caps against saved real receipts.
- `node --import tsx docs/receipts/focused-v2-ui/verify-backing.mjs`, exit 0, `backing-check.log`: actual per-token backing at block 26486125, after review requested a stronger check than item count alone. No extra transactions.
- `python3 "$HOME/.agents/guidance/asset-flow-kit/asset_gate.py" . --config asset-flow-focused.json --no-run --require-review`, exit 0, `gate-signed.log`: owner signature, exact-source review and existing scorecards PASS, without duplicating passing contract suites.

Budget: **20/30 transactions**, **0.264777968562614880/.5 test ETH forward value**, **0.012731400382515208/1 test ETH gas**, **0 new actor funding**, **149.166/900 seconds** through executed postflight. All transaction work completed inside the approved allowance. Additional backing/ledger checks were read-only. Basefee had decayed to about 7 wei on Anvil; creator/keeper tips were about .05 gwei, purchase/coordinator tips 1 gwei. Creator and keeper share synthetic account 1e004; this exercises the production service path but does not prove separate-actor profitability or wallet isolation. These receipt costs are local functional-test context, not mainnet cost or keeper profitability estimates. Simulated outcomes do not establish live VRF availability. Rainbow extension signing and mainnet inclusion remain outside this local connector test.

Top-up hash: `0x40d389d353578c05fbb745aab5e082239b14b19b6f1afcdd9d17f71413e5e0b2`.
Withdrawal hash: `0x0f1dafd344fe905a62f6c8b370b16d9a81afc28ce8c3af2249d02f32f5a10153`.

Things that don't make sense: none newly unresolved. The dedicated pool's paid upkeep is deliberately disabled for the reserve-boundary test; its empty operating cash is not a recommendation for a production pool.
