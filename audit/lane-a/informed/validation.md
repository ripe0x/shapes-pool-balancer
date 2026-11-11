# Informed validation: B4 / INT-1 keeper economics

Sealed 2026-11-11 02:13 UTC. This is an informed follow-up to lane A and B discovery and the integration assessment, not independent blind discovery. Target remains 0f017843ec333f499809f751e19017be325448e3, Solidity 0.8.28 via IR, Ethereum fork block 26382349 through https://mainnet.gateway.tenderly.co. No broadcasts, fixes or production-code edits.

## Disposition

**B4's premise that half the FWA edge returns to the owner is inapplicable to the pinned implementation.** The [verified FWA StandardPool source](https://eth.blockscout.com/address/0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7?tab=contract), lines 1810–1829, accrues only request-time basePrice to ownerProceeds and the full paid − basePrice difference to accruedProtocolFees. Its StandardPoolBuyback override routes the full accrued fee to FWAV2Buyback. The [verified PoolFactory source](https://eth.blockscout.com/address/0x8919814D825a5Af238cC04DE06b1C18c9eaA477C?tab=contract) declares edgeBps = 500 as a constant, so the purchase-to-reconciliation governance edge-change branch in B4 is not reachable for this implementation. The older FWA settings page cited by B4 describes a different fee policy.

**INT-1 is a real funding-source clarification, not a demonstrated asset violation.** The edge credit is an accounting cap on Balancer-funded keeper incentives. The FWA edge remains in FWA and, when paid out, goes to buyback; it is never transferred to Balancer as keeper funding. The creator's Balancer ETH pays the keeper. The confirmed test below shows that the aggregate incentive across seven purchase-caused upkeeps equaled the full edge, while FWA independently routed that same edge to buyback. Whether this dual expense is acceptable operating economics is an owner decision. No profitable exploit of keeper reimbursement was demonstrated.

## Exact source argument

Let B be FWA's snapshotted integer weighted-mean base, e = 500, F = floor(B × (10000 + e) / 10000) the ETH acquisition fee, and P = F − B the protocol fee on successful delivery. Balancer sets credit C = floor(F × e / (10000 + e)). Since F ≤ B × (10000 + e) / 10000, C ≤ floor(B × e / 10000) = P. Thus, for this pinned constant-edge implementation, the summed purchase-caused incentive paid after reconciliation cannot exceed the actual protocol fee on delivered draws. Multiple upkeep calls spend one credit rather than refreshing it. Expiry/slippage and failed-delivery statuses contribute no delivered edge; the latter's pending item may still cause gas work. This argument covers the integer fee and credit formulas and Balancer's spend/reset logic; it assumes the inspected verified source corresponds to the pinned runtime and does not prove all external economics.

For keeper gas, the event's gasUsed is floor(measured × 4/5), capped by measured ≤ 3.2 million; reimbursed price is min(transaction gas price, basefee + 0.05 gwei, 5 gwei). EIP-3529 caps transaction gas refunds at one fifth of gas used, so billed gas in any containing transaction is at least four fifths of the measured span. The gas portion of reward is therefore no greater than billed gas × reimbursed price ≤ billed gas × bid. This is a bound, not a receipt measurement. Intrinsic/post-call gas, purchase gas, failed keeper attempts and VRF processing only worsen the attacker ledger.

## Executed worst-case sequence and ETH ledger

Test file: audit/lane-a/informed/Economics.t.sol, SHA-256 4290cefd5234bcbfce4742c406612a4abbe9e311284863af2099634888d6bfbe. An outsider is both buyer and keeper; the creator is separate. A 0.0001 ETH curated listing plus a 0.5 ETH listing and 40 × 0.01 ETH Shapes makes the cheap curated draw force a switch to a one-Shape plan. The fork test selects that curated listing with a controlled VRF word and executes seven upkeeps at 0.05 gwei. Controlling the fork word is a stress case, not a claimed mainnet buyer capability. The test checks the delivered NFT, FWA acquisition state, pool cash, owner proceeds, protocol accrual, Shape count/backing shift, Balancer cash, keeper events and final buyback transfer.

| Flow | Exact wei | Result |
| --- | ---: | --- |
| Buyer pays FWA acquisition fee | 3,149,550,064,276,531 | FWA holds it during request and settlement. |
| Buyer pays VRF service fee | 117,000,000,000,000 | Separate from refundable acquisition fee and Balancer funds. |
| FWA credits owner base proceeds | 2,999,571,489,787,173 | Collected by Balancer during upkeep. |
| FWA accrues full protocol edge | 149,978,574,489,358 | F = base + edge exactly in this test. Later payout increases FWAV2Buyback's ETH balance by this amount. |
| Shapes backing redeemed during fallback | 390,000,000,000,000,000 | 39 Shapes burn; same ETH moves from Shapes backing to Balancer liquid balance. No new mint fee in this switch. |
| Seven keeper rewards from Balancer | 460,001,774,489,358 | 310,023,200,000,000 gas portion plus 149,978,574,489,358 incentive. |
| Balancer liquid ETH change | +392,539,569,715,297,815 | base proceeds + redeemed backing − keeper rewards, asserted. FWA protocol fee was not received by Balancer. |

The outsider's transfer-and-asset PnL, valuing the received curated NFT at its creator-set 0.0001 ETH base and subtracting only the guaranteed billed-gas lower bound of 310,023,200,000,000 wei, is at most **−3,016,571,489,787,173 wei** (−0.003016571489787173 ETH). Actual purchase, VRF-settlement and other transaction gas would make this result lower. The NFT's market value is unknown; if worth more than the fee, a favorable lottery draw can profit independently of keeper rewards. The test does not establish a universal no-profit conclusion. Combining creator, buyer and keeper as one owner cancels internal proceeds/rewards/backing transfers; the observed external ETH loss before gas is edge + VRF = 266,978,574,489,358 wei, with any mint fee or gas additionally external.

Forge prank calls do not debit the pranked EOA's ETH for payable calls in this test. The exact payment is instead reconciled through FWA's fee escrow and pool balance; the gas calculation uses the event's conservative billed-gas lower bound. No transaction receipt gas cost is claimed.

## Expiry/refund boundary

In the second fork test, one admitted request expires after its word deadline; FWA processes it without a listing, the named purchaser claims the complete 3,149,550,064,276,531 wei acquisition-fee refund, FWA protocol accrual remains zero, and no owner proceeds arise. The 117,000,000,000,000 wei VRF charge stays external. Balancer's reconciliation pays the keeper 6,551,500,000,000 wei, exactly gasUsed × 0.05 gwei, and sets incentiveCredit to zero. Even assuming all paid keeper gas is reimbursed and ignoring purchase/refund gas, the cycle's upper PnL is **−117,000,000,000,000 wei**. This covers an expiry sequence, not every failed-delivery or slippage state.

## Commands and execution record

- Initial focused test compile: exit 1 with a via-IR Yul stack exception in the test harness. Split its functions and reran.
- First compiled run: exit 1 at a test-only assumption that a Foundry prank debits the impersonated EOA for a payable call. Replaced it with FWA escrow/balance assertions and preserved the failure above.
- Intermediate cheap-draw run: exit 0, 1 passed; seven upkeeps, summed incentive equal to protocol fee. Intermediate expiry run: exit 0, 1 passed; compiler warned about two shadowed test locals, then those were renamed.
- Final command: FOUNDRY_TEST=audit/lane-a/informed forge test --match-path audit/lane-a/informed/Economics.t.sol --match-test 'test(Cheap|Expired)' --fork-url https://mainnet.gateway.tenderly.co --fork-block-number 26382349 -vv. Approved execution outside the DNS-restricted sandbox. Exit 0; 2 passed, 0 failed, no compiler warnings; gas reported 8,245,509 and 1,000,558 for the two whole tests. Exact values above appeared in the emitted logs and were asserted. The final test additionally called FWA payoutProtocolFees on the ephemeral fork and checked buyback's balance rose by the entire accrued edge.

## Limits and next decisions

- This resolves the specific half-edge and mutable-edge hypotheses for the pinned FWA implementation. It does not establish profitability for every NFT value, VRF outcome, transaction gas price, refund composition or builder strategy. No mainnet transaction receipts were obtained.
- The primary economic policy question remains: the creator pays keeper incentives from Balancer ETH while the buyer's full edge goes to FWA buyback. The owner should decide whether the UI/spec must express that cost explicitly and whether this is acceptable for the intended pool economics. That is a participant-rights decision, not a code patch authorized by this validation.
- The test did not independently compile Blockscout's partially verified FWA source against runtime or inspect the VRF service's internal fee use. The pinned code hash was matched in the integration assessment; source correspondence retains that limit.
- Informed phase wall time was approximately 8 minutes, 02:05–02:13 UTC. No additional hour beyond lane allocation was used. Evidence and file protection remain advisory, and no human review occurred.
