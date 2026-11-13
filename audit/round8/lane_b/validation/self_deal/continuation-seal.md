# Lane B strict-router self-deal continuation

Frozen target `2ac7a7e7b965d1798729068566c026128a4ba4b9`; mainnet fork block `26382349` sourced only from `https://mainnet.gateway.tenderly.co`; local Anvil chain ID `31337`, port `18547`, PID `46925` retained. This continuation owns only `audit/round8/lane_b/validation/self_deal/` and did not change the blind, informed, or prior validation seals. The entire local transaction sequence was reverted to its opening Anvil snapshot. No mainnet transaction, protocol mock, protocol storage or balance fake, or production edit occurred. A code-free EOA wallet was funded as setup; the only protocol identity impersonated was the actual coordinator to deliver words to the real FWA VRF service.

## Exact command and evidence

From repository root:

```sh
node audit/round8/lane_b/validation/self_deal/strict-self-deal.mjs > audit/round8/lane_b/validation/self_deal/strict-self-deal.json 2> audit/round8/lane_b/validation/self_deal/strict-self-deal.err
```

Exit `0`, retained in `strict-self-deal.exit`. Script SHA-256 `2a09c99b4a7897617dc94988e1309b3ef225056760532fba8ca4473ac6326cdf`; JSON SHA-256 `3d8d7da8d61b45cfa21f1847a925cc4da15d4d92326007f5d6675cd3d853c712`; empty stderr SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`; exit-file SHA-256 `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa`. The final manifest hashes all continuation files.

## Observed wallet cycle

The same code-free EOA `0x00000000000000000000000000000000c0dec0de` was payer, purchaser, FWA processor, permissionless Balancer keeper, Shape winner, and redeemer. It bought one draw on the retained Balanced pool at base fee `1` gwei and effective gas price `1.05` gwei. Inventory version and quote were read before sending the transaction. The coordinator `0xD7f86b4b8Cae7D942340FF628F82735b7a20893a` sent the word to the real service `0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d`, which fulfilled the real FWA pool request. The callback receipt succeeded. The selected prize was a 0.01 ETH Shape; FWA acquisition status `2` and Shape `ownerOf`/backing were checked before upkeep and redemption. Word selection was controlled only in the local reachability test, not by an ordinary mainnet player.

| Flow | ETH |
| --- | ---: |
| Player purchase total | `0.024977339287470837` |
| Of that, FWA VRF fee | `0.002457` |
| Shape backing redeemed by actor | `0.01` |
| Balancer keeper reward paid to actor | `0.001145` |
| Actor billed gas: buy, process, upkeep, redeem | `0.00149029755` |
| **Actor net wallet loss** | **`0.015322636837470837`** |

The four actor receipts all succeeded. Billed gas was `550,246`, `30,474`, `776,126`, and `62,485` respectively, all at `1.05` gwei; their gas costs sum exactly to `0.00149029755` ETH. KeeperPaid measured `786,023` gas on upkeep, `9,897` above billed gas. The actor began with `100` ETH and ended with `99.984677363162529163` ETH. The observed balance loss equals `purchase total − redeemed backing − keeper reward + billed actor gas` exactly. Coordinator callback gas was paid by the coordinator account in this local test, not by the actor; the actor's quote included the FWA VRF fee. The result is an **observed cost for this one self-dealing strategy**, not a minimum attacker cost or a probability-weighted loss estimate. The listed Shape price was `0.013645` ETH; the actual FWA purchase quote was higher because it prices the whole active mix.

After redeeming, a separate snapshot advanced local time by more than seven days and sent `refundFailedDelivery` for the delivered Shape. That receipt reverted with selector `0x83ad9f5a`, billed `32,858` gas at `1.05` gwei (`0.0000345009` ETH), and returned no ETH. This optional failed refund attempt is excluded from the core wallet-loss calculation. If the actor also made it, observed cost would rise to `0.015357137737470837` ETH. The sub-snapshot was reverted. A true failed-delivery refund batch was not reachable with a code-free EOA receiving a standard Shape without manipulating Shapes or FWA state, so refund-heavy keeper economics remain untested in this continuation.

## Bounds and time

This is one successful, cheap-Shape outcome on the retained Balanced pool. It does not establish attacker control over VRF, the cheapest possible strategy, repeated self-deal economics, fee-rise behavior, or a true delivery-failure path. It closes the prior **direct service-address → pool callback** method gap for one mined self-deal wallet P&L cycle. The actual coordinator → service → pool route is proven by the callback receipt's `from` and `to`, subsequent FWA status, and completed Shape redemption.

The continuation began at `2026-11-12 17:33:37 UTC` and sealed at about `17:36 UTC`, about **3 minutes** of active work. Prior cumulative Lane B active time was about **1 hour 49 minutes 20 seconds**; cumulative with this continuation was about **1 hour 52 minutes 20 seconds**, below the three-hour ceiling and below the 50-minute continuation cap. No additional local services were started or stopped.
