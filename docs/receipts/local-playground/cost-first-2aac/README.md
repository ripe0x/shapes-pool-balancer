# Cost-first pool local draw walkthrough

Local-only scope: http://127.0.0.1:8545, chain 31337, preserved Anvil PID28171 and fork block26485619.
Owner authorized finding the fresh ripe0x.eth pool, attaching a keeper, running20 draws with simulated randomness,
verifying NFT wins, restocking and cost-first proceeds, and supplying a reusable X-draw command. No mainnet activity.

- Balancer: `0x2Aacb8aFe400b3Ffe61063142AAE5A351A69A0Db`
- FWA pool: `0x1F5Fc2dDDF6cCe162cEC5Af706d55678bD5139cF`
- Creator ripe0x.eth: `0xCB43078C32423F5348Cab5885911C3B5faE217F9`
- Creation event block26485987; cost-first accounting version1, fixed implementation0176016958744B0030c96cC10896bd0817D94855.
- Dedicated keeper: `0x000000000000000000000000000000000001e007`; PID32605. Funded0.1testETH in its external wallet only.
- Existing funded test buyer: `0x000000000000000000000000000000000001e008`.
- Initial target: six0.01ETH Shapes, three0.05ETH Shapes, one0.1ETH Shape and two0.02ETH Packs. All12 automatic NFT prizes listed.
- Initial contributed ETH capital0.358133; cash0.001133; backing0.35; net assets0.351133; startup loss0.007; earnings0.

The existing Keeper implementation runs in a separate process/state file scoped to this new clone. Discovery starts
at its verified creation block and a send guard rejects other pools, changed code/node identity and aggregate budget
overruns. The old keeper/node/pools are preserved. The runner and keeper drain one another's pending work before each
purchase, callback and accounting observation; only one draw command may hold the draw lock. An EEXIST lock error
while the agent's20draw batch runs means a parallel command was refused before sending anything. Do not delete that
lock to force simultaneous runs.

## More draws

After the current batch releases its lock:

```bash
cd /Users/dd/CascadeProjects/fwa-pool-balancer
X=5
node --import tsx scripts/local-cost-first-draws.ts --execute --allow-simulated-randomness --draws "$X"
```

X is1..20 per batch, within shared lifetime ceilings:1testETH purchase value,1testETH transaction gas and200 combined
draw/keeper transactions. These ceilings do not reset for another command. The existing keeper must still be ticking.
No pool deposit, price/target change, earnings claim, manual free maintenance or randomness-word retry is performed.
A failed or interrupted batch requires receipt reconciliation before continuing; the helper does not silently restart
its target or send uncertain transactions again.

The already-running keeper command is:

```bash
node --import tsx scripts/local-cost-first-draws.ts --keeper
```

Do not start a second keeper: its process lock and separate signer prevent duplicate ownership. Mutable journal and
keeper state/locks are ignored; frozen completion evidence is recorded separately.

## Meaning of the checks

These are real local fork purchases, actual FWA NFT custody transfers, actual automatic prize mint/replacement and
paid maintenance. Randomness is explicitly simulated through the real service's callback entrypoint by impersonating
its coordinator only on this fork, for requests mapped to this pool. Genuine coordinator commitments remain pending;
this does not verify VRF cryptography, consume authentic commitments or prove mainnet randomness billing/liveness.

Each win must be fulfilled, not refunded, and its actual token owner must be the buyer. Each pinned before/after
maintenance interval independently checks:

```text
change in pool cash + actual automatic backing held
  = actual owner proceeds collected
  - automatic backing delivered to winner
  - actual replacement mint fees
  - actual KeeperPaid amounts
```

After all issued outcomes are reconciled, earned proceeds must equal positive net assets above contributed native
capital. Available proceeds must also fit cash above the current reserve. Deposits do not become profit, curated
asking prices create no assigned ETH basis, and all pool cash remains available to maintenance. Every contribution
stays fixed throughout the draw batch. The initial0.007ETH startup loss must be recovered before any earnings appear.
Full target restoration is reported separately from20successful wins: a genuine shortage is not hidden by a topup or
a rerolled word. Local receipts and their actual gas prices do not establish mainnet economics or release readiness.
## Recorded 20 draw result

At local block 26,486,050 all 20 requests were fulfilled and reconciled, with no unsettled acquisitions and zero owner
proceeds left uncollected. The buyer actually owned 20 distinct NFT prizes: twelve 0.01 ETH Shapes, four 0.05 ETH Shapes,
and four 0.02 ETH Packs. The real paid keeper made 20 successful transactions with no reverts. It remains running.

| Pool flow / holding | ETH |
| --- | ---: |
| Contributed capital target | 0.358133 |
| Initial net assets, after startup fees | 0.351133 |
| Owner proceeds from 20 draws | +0.385892791949866765 |
| Automatic backing won by buyer | -0.400000000000000000 |
| Replacement mint fees | -0.011500000000000000 |
| Actual keeper payments | -0.001799376853376206 |
| Final cash | 0.023726415096490559 |
| Final listed backing | 0.300000000000000000 |
| Final net assets | 0.323726415096490559 |
| Carried loss including startup | 0.034406584903509441 |
| Earned / withdrawable proceeds | 0 / 0 |
| Required reserve | 0.050938500034960000 |
| Reserve shortfall | 0.027212084938469441 |

Each draw and every cumulative prefix reconciles to the actual cash/backing with 0 wei discrepancy. Independent
read-only review derived the same figures. The pool returned to its entire target after draw 17, but a later 0.05 ETH
win left one 0.05 ETH Shape missing at 20. Subsequent Pack wins increased the loss. The final target is **not fully
restored**. This is a losing sample: winner backing alone exceeded collected owner proceeds, before fees and keeper
costs. Cost-first accounting correctly creates no withdrawable earnings from deposits or this carried loss.
A pinned read-only simulation also confirmed that a creator claim of even 1 wei reverted with InsufficientSurplus.

The buyer paid 0.451987431547360095 ETH:0.385892791949866765 to owner receipts,0.019294639597493330 in FWA edge,
and 0.0468 to randomness-service fees. The 40 driver transactions consumed 0.021823371 ETHgas separately. The 20 keeper
transactions consumed 0.000874779842756712 ETHgas and received 0.001799376853376206 ETH, net 0.000924597010619494 ETH.
These are the local fork's actual prices: driver bids 1 gwei; basefee 16→8 wei, keeper bids approximately 0.05 gwei. They
are not a mainnet profitability estimate. No new funds were deposited into the pool and no creator claim was broadcast.

The first process timed out after the nineteenth request/callback, because the keeper-state freshness guard allowed
only 10 seconds. The keeper was still alive and subsequently completed its nineteenth paid transaction. The timeout
is preserved in previousFailures and initial-attempt.log. A bounded --resume path verified all 38 canonical driver
transactions and their totals, reconciled the already-delivered nineteenth NFT using its historical pre-draw state,
then bought ONLY the twentieth draw. It preserved the original 20 draw target. The freshness window is now 90 seconds;
no monetary or scope guard was removed. A permanent liveness regression covers the previously rejected 15 second gap.
The exact successful resume source is frozen and hashed in executed-resume-runner.ts.txt/run-20.json.

The resume exits 1 deliberately for the **unmet final restocking criterion**, after recording drawsComplete:true and
fullyRestocked:false. The draw lock is released. Later X-draw batches can continue within the same lifetime caps;
no assertion promises that another finite batch will repair this loss. The helper archives prior failures instead of
silently deleting them. Its earlier 18 completed cycles, actual 19 th recovery and final 20 th cycle are distinguished
from a never-interrupted 20 draw trial. Old pool operations and services were preserved.

Verification:4 focused helper tests passed; typechecking passed after the resume repair. The added liveness-only
regression was then run separately. Actual execution exercised the NFT, keeper, loss, partial-restocking, resume and
zero-profit paths; this run did not reach a positive earned-proceeds payout. Earlier genuine historical-proof tests
remain separate evidence, not a substitute for this simulated-oracle exception or for a release campaign.

Things that don't make sense: calling this fully restocked or profitable would contradict the balances. The final
partial inventory remains purchase-admitted under the accepted 70%inventory rule; that does not mean its target is
fully funded. The 0.027212084938469441 ETHshortfall remains a real, disclosed outcome. No topup or word reroll hid it.
