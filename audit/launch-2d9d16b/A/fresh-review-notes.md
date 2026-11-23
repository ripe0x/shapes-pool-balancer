# Informed fresh-context challenge, launch audit A

- Candidate: `2d9d16bf289817eff1831263e48c8b5412a3855f` (detached); last informed audit revision supplied: `28b53ad`.
- Time: 2026-11-22 23:22 to 23:34 UTC, about 12 minutes. Security/economic code read about 5 minutes; harness and fork checks about 6 minutes; reporting about 1 minute.
- Independence: read `OWNER-REQUIREMENTS.md` and source/diff first. Did not read earlier audit contents, builder notes, decision logs, or sibling launch-B trees. This is informed, not blind. No tracked files edited, no commit, push, deploy, broadcast, signature, or `SOURCE_HASH`.
- Test source: `fresh-review-MintCap.t.sol`; exact final command and result: `fresh-review-output.txt`. Temporary `test/audit/FreshReviewMintCap.t.sol` copy was removed after testing.

## Finding: dashboard can repeat an irreversible ETH contribution (reasoned, P2)

`app/src/App.tsx:273-279` records `getTransactionCount(..., 'pending')` **before** the wallet chooses a nonce and only saves that number after the wallet returns a hash. `app/src/tx.ts:78-85` treats an unavailable hash as resolved when the latest on-chain nonce exceeds the saved number. A wallet may select a later queued nonce, and the app's read RPC may never have seen the transaction hash. Example: the app saves nonce 4; the wallet queues the ETH transfer at nonce 5; nonce 4 is mined; the read RPC still cannot locate the pending nonce-5 hash; `latest` becomes 5, so `transferUnresolved` returns false and the UI permits another ETH transfer to the same pool. Both may later mine. The same function releases a mined hash without checking a canonical receipt or whether the transfer succeeded, so a receipt failure after a successful deposit can also invite a retry.

This affects `depositETH` and other value-bearing `useTx.write` calls. Under R73 a non-creator's deposit is irrevocable and the creator can immediately claim available surplus. At an illustrative 0.3 ETH contribution, retrying can move another 0.3 ETH; the UI has no amount cap, so the maximum is the repeated amount chosen by the user. This is a **conditional source proof**, not an executed wallet reproduction. Smallest fix: persist a pending intent before opening the wallet, replace the estimated nonce with the actual submitted nonce when observed, and require canonical receipt plus exact transaction intent before clearing a sent transfer. When the hash is unavailable and the wallet may have chosen a later nonce, keep it unresolved until the actual nonce consumer or explicit user resolution is known. Do not infer completion from the lower pre-wallet nonce.

## Executed economic and security challenges

| Real path, pinned mainnet block 26,382,349 | Observation |
| --- | --- |
| Shapes admin raises mint fee above accepted cap to 0.01 ETH, player buys listed Shape, VRF fulfills, keeper reconciles; creator then accepts fee | Purchase remained open; over-cap mint did not occur; accepting fee raised the one-missing-Shape reserve by exactly 0.009 ETH. `test_feeSpikeDoesNotBlockListedPurchasesOrCreateUnfundedMint` passed at basefee 0.5 gwei and bid 0.55 gwei. |
| One fulfilled Shape draw, four pending draws, keeper restocks one while FWA queue waits, then pending draws expire | Operating ETH after staged restock was 0.01479879865 against a 0.06165 ETH withdrawal reserve at basefee 4.9 gwei/bid 5 gwei. All later draws reconciled through paid upkeep. Below-reserve operating capital alone was not a violation in this sequence. |
| Five draws expire with no proceeds at 4.9 gwei basefee/5 gwei bid | Paid keeper reconciled all five; 0.0132940086 ETH operating capital remained. The attempted cash-starvation sequence did not reach a paid failure. |

The environment probe asserted `block.basefee` and `tx.gasprice` inside a state-changing call. Purchases used the real forked FWA pool and VRF service; the harness impersonated the coordinator to deliver randomness. That permits a route test, not a timing claim about mainnet VRF. Mint-fee change used the deployed Shapes admin method under an admin prank; no protocol state was overwritten or mocked. The final test asserted the intended creator address, after an earlier invalid prank was caught. The transient harness failures and their corrections are in `fresh-review-output.txt`.

## Independent flow map and partial scorecard

Creator or contributor ETH enters Balancer operating cash. Shapes mint consumes backing plus a per-Shape mint fee; the backed NFT moves to FWA's pool. Buyer ETH enters FWA; its randomness fee and edge leave for their recipients, a fulfilled purchase earns owner proceeds, and an expired one creates a buyer refund. Collection moves owner proceeds to Balancer, where the stored split creates protected creator credit and the remainder is operating cash. Paid upkeep moves a bounded quote from operating cash to the keeper. Creator claims remove credit or surplus above the withdrawal reserve. Closing stops purchases; unlisting returns Shape backing and curated NFTs, subject to FWA settlement.

The three executed regimes above check the mint-fee branch and paid reconciliation, including one absolute reserve delta and remaining ETH. They do **not** form a full owner-outcome scorecard. I did not run the broad asset gate or derive every required regime's bucket breakdown; the controller's whole-candidate pass owns that. No full claim about O1–O13 follows from this challenge. In particular, the one-way FWA edge and VRF fee, curated recovery, 1/100 ETH prize cycles, policy activation limits, and closeout were not re-executed here.

## Limitations and things that don't make sense

- The test checkout's submodule gitlinks appeared uninitialized while dependency contents were present. Forge attempted and failed automatic submodule installation, then compiled and executed using the present files. Dependency contents were not independently matched to the pinned gitlinks here.
- `keeper/keeper.ts:19,333,250-255,583-586`: `PaymentUnavailable` and `KeeperNotApproved` are classified as expected; `service` returns without throwing, so `recordPool` clears a failure streak and `/health` stays green even if a pool repeatedly needs work that this keeper cannot perform. This is a **reasoned monitoring question**. A real keeper run with a sustained failing pool and no other maintainer would decide impact; the fork sequences above did not reach such a failure.
- The dashboard transfer guard is strongest when its read RPC knows the actual hash. Wallet/RPC separation and queued higher nonces are not covered by the existing transfer test's single-node, exact-nonce path. A wallet-controlled local rehearsal with the hash missing from the read node would decide practical frequency.
