# Completed local creator UI acceptance

The owner approved plan 802d8dd575e37d9ee81255a0420a3934232a4237ee571c972723eb33f0ed46fd and 15 additional active minutes.
The owner separately approved the recorded depositETH amendment before that call. Original packet and approval
boundary are preserved; no mainnet authority is inherited. Start/end UTC timestamps are in journal.json.

Candidate: source revision da603f70156693ea32a0b0dbe484c50880c6bc36, with evidence-only descendant c6d36d4.
Source/dependency/runtime/artifact fingerprints were checked unchanged before transactions. No production source
was edited. Owned Anvil PID 23449, endpoint http://127.0.0.1:18790, chain 31337, canonical mainnet fork
26,493,164 via https://mainnet.gateway.tenderly.co. No node reset, protocol state edit, fabricated oracle, new wallet
funding or cache deletion occurred. Existing services remain running.

Preview: http://127.0.0.1:5211/, Vite with chain 31337, the approved RPC/factory and synthetic creator e004.
A separate read-only preview at :5212 used synthetic creatorA e005. CUA drove actual app controls. The app's local
Wagmi development connector used the unlocked synthetic node account; reads and transactions reached the actual
local RPC and integrated deployed FWA/WETH contracts. This is not production wallet-extension signing evidence.
The one WETH setup transfer was submitted directly through viem, as explicitly included in the plan; ERC20 recovery
and the other ten transactions were sent through the actual app. No successful external-service answers were stubbed.

## Product acceptance and asset-flow scorecard

| Flow | Actual UI/chain evidence | Outcome |
| --- | --- | --- |
| Public creation pause | Connected e005 showed `Pool creation is paused.` and disabled Create pool; e004 could access existing canary | Paused remained true; no creation write attempted |
| NFT listing | Manual collection/token1 plus discovered collection/token2, values confirmed at 0.2/0.3 ETH; two exact approvals then listCuratedBatch | Both NFTs held by real FWA pool; native transfer 0 wei |
| Batch repricing | Select all, value 0.4, Change selected values; real updateCuratedPricesBatch([3,4],[0.4,0.4]) | Both rows showed 0.400 ETH; native transfer 0 wei |
| Selective withdrawal and refresh | Uncheck NFT #2; Withdraw selected(1); real withdrawCuratedBatch([3],e004); reload/reconnect | NFT #1 returned; NFT #2 alone remained listed at0.4 ETH |
| ERC20 recovery roundtrip | Existing0.1 WETH transferred into Balancer; actual UI form tokenWETH/raw100000000000000000; recoverERC20 | Exactly0.1 WETH returned to creator, BalancerWETH0 |
| Native deposit and closeout roundtrip | Deposit0.1 ETH through amended depositETH; UI RETIRE confirmation; Take everything back | RemainingNFT #2 returned, exact0.1 ETH claimed, active inventory/ETH0 |
| Closeout completion | UI showed `Take everything back: confirmed` and `Retired. No listed prizes or operating ETH remain.` | Readbacks match UI, both FWA listings Withdrawn(status3), FWA proceeds/unsettled 0 |
| Wallet economics | Start898724110310173952wei; end895729977095110105wei; totalgas2994133215063847wei | Native principal returned completely; sole net native cost equals actual receipt gas |

Eleven transactions succeeded, nonces 14..24, within 12 permitted. Gas 0.002994133215063847 test ETH is below 0.1 test ETH.
All receipts have actual nonzero basefee and effective gas price recorded in journal.json. No draws, buyer spending,
oracle calls, keeper payouts, new wallet funding, protocol balance/storage edits or public unpause occurred.

## Evidence and bounded failures

- journal.json: actual transaction inputs/decoded intent, hashes, nonces, canonical block hashes, receipt gas and final readbacks.
- listing-intents.json: exact decoded intents prepared against actual state before UI sends.
- deposit-amendment.json: owner-approved method correction, with unchanged amount/caps/time budget.
- postflight.json: independent direct chain readbacks after UI completion.
- record-ui.mjs: read-only receipt collector with sender/nonce/input/value/status/gas assertions; it never broadcasts.
- This was the one batched actual-UI acceptance run; no production files changed, so no duplicate build/test suite was run.

Two read-only operator checks failed before correction: importing CLI helpers from stdin used argv `-`, which their
main-entry guard could not resolve; no mutation occurred, and retry with an existing non-entry argv path passed.
One manually written read used non-existent `unsettledAcquisitions()` and reverted in eth_call; the repository's
actual ABI `unsettledAcquisitionCount()` returned 0. No transaction reverted. A stale CUA button index was refreshed
from current AX state before clicking; it produced no chain action. The original packet's deposit function omission
was stopped and amended by the owner before depositETH was sent.

Acceptance excludes refunded-history UI, a hostile failing NFT UI batch, production wallet-extension signatures,
all 28 economic release regimes, full independent security review and a mainnet canary. The existing authentic-proof
fork test remains separate valid backend refunded-recovery evidence. This local UI result does not make the release
ready or establish oracle availability. No production deployment or implementation switch occurred.

Independent read-only acceptance review found no consequential inconsistency in the plan hash, amended method,
consecutive nonces, actual input/value matching, final holdings and exact wallet/gas reconciliation. This review
did not run tests or claim a whole-source audit.

Things that don't make sense: the existing economic harness fabricates randomness, so merely rerunning its 28 regimes
would not establish the required no-mock evidence. Cosmetic existing UI text `Won about every draw draws` is awkward;
it did not affect transaction intent or custody and was not changed during this frozen acceptance batch.
