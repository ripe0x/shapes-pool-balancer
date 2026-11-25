# Genuine proof corpus and sequential execution, 2026-11-25

Scope: source based on 6574fbd, with no production contract, ABI, owner outcome, gate configuration or deployment
changes. All network access used https://mainnet.gateway.tenderly.co read-only. No public broadcasts, oracle
impersonation, protocol code/storage/balance injection, node reset or cache clearing occurred.

## Corpus availability

The bounded forward scan found only three shared-service requests from block 26,442,752 through 26,493,490, all
in one purchase. An additional single backward query over the preceding 65,536 blocks found 836 request events
across 453 purchase transactions. Those are event observations, not 836 captured or verified proofs.

The actual fixture captures FOUR genuine request/proof pairs: the three original requests at block 26,442,752,
fulfilled at 26,442,757, plus the immediately preceding request at 26,442,101 fulfilled at 26,442,106. It includes
canonical block hashes, original transaction calldata/senders/targets, actual stored random words, protocol code
hashes and scan bounds. Anchor-prefix summary fields describe the three entries; previousEntries holds the fourth.
The full 180-draw/28-regime corpus is not yet captured.

scripts/collect-authentic-vrf.ts is a bounded read-only collector with checkpoint reuse, paced RPC and one bounded
429 retry. It imports no wallet or broadcast client. Its --previous-only mode acquired the preceding singleton
in eight actual reads. Initial 4096-block target acquisition found fewer than six requests; a broader unpaced scan
hit Tenderly429. These anomalies are retained in the fixture's collectionAttempts; no alternate RPC or new quota
service was used. A paced scan and checkpoint reuse established the actual three-entry forward prefix.

## Local cryptographic execution

AuthenticContinuationTest submits the captured genuine proof calldata through the deployed coordinator's public
fulfillRandomWords function as the ordinary test-contract caller. No caller is impersonated to bypass proof
verification. Three genuine proofs succeed and actual FWA words equal canonical historical outputs; buyers own
the actual NFTs and keeper-role calls reconcile/restock all 47 Shape/Pack prizes. Damaging the proof's gamma point
reverts `gamma is not on curve` and leaves its request pending. Reusing a consumed proof reverts
`NoCorrespondingRequest()` and creates no extra owner proceeds. This is proof validation, not a claim that anyone
can invent fresh proofs or choose an outcome.

GasProbe state-changing calls assert 0.5 gwei basefee and 0.55 gwei gas price for economic operations. This is an
explicit counterfactual gas context; canonical request blockhashes and authentic proof data remain unchanged.
Persistent accounts preserve state reached through actual calls and omit intervening canonical mutations.

The new AuthenticSequenceTest starts before the preceding single purchase, settles its genuine proof, reconciles
and restocks, advances to the later canonical request block, creates the next three actual requests, and submits
their distinct genuine proofs. It checks request/sequence continuity through four, actual buyer ownership,
restocking and creator closeout. This is a two-cohort acceptance case, not the complete monthly campaign.

## Focused asset-flow scorecard

| Flow | Reached outcome | Limit |
| --- | --- | --- |
| Real requests across batches | One genuine request at26442101, then three at26442752; sequence counter reaches4 | Only four captured proofs, not the full corpus |
| Proof submission | Ordinary caller submits exact genuine inputs; real coordinator validates every proof | No oracle-node liveness or private-key availability claim |
| Wrong/duplicate proof | Damaged gamma rejected; actual request remains pending; consumed commitment rejected with no extra proceeds | Focused mutation/replay checks, not exhaustive cryptographic audit |
| Buyer prizes | All four acquisitions succeed and each actual NFT belongs to buyer | No selected/forced winner or unbiased-sampling claim |
| Keeper-role restock | Reconciliation cursor reaches4, unsettled0 and all47 Shape/Pack prizes restocked | Explicit FWA processing is used; rational profitability is not measured |
| Creator capital/credit closeout | Starting funding5ETH; actual surplus above3ETH returned exactly to creator; Balancer ETH/credit/tracking and FWA owner proceeds/unsettled counts0 | Not complete protocol/mint/oracle-fee conservation |

## Verification record

- Initial public-proof run: CANDIDATE_RUN=1 forge test --match-contract '^AuthenticContinuationTest$' -vvvv;
  exit0, two tests pass (public proof/tamper/replay/restock plus inherited economic closeout).
- CANDIDATE_RUN=1 forge test --match-contract '^(AuthenticContinuationTest|AuthenticSequenceTest)$' -vvvv:
  two public/inherited tests passed; sequence failed DuplicateRequestId. Advancing to the end of the canonical request
  block imported the original request into uncached service slots. The repair forks immediately BEFORE that actual
  transaction using vm.rollFork(requestTx), preserving the genuine prefix boundary.
- The first repaired attempt then rejected a canonical EIP-7702 transaction under Cancun execution. The fixture now
  explicitly selects/asserts Prague EXECUTION via vm.setEvmVersion; production COMPILATION remains Cancun unchanged.
- CANDIDATE_RUN=1 forge test --match-contract '^AuthenticSequenceTest$' -vvvv: exit0, affected four-proof sequence passes
  in3.46seconds on the warm cache. Full initial failure and EIP-7702 failure traces are preserved. No fake requests,
  storage edits, cached-status overwrites or callback impersonation were used to resolve either failure.
- npm run typecheck initially failed at a nullable canonical log transaction hash; an explicit hash assertion fixes
  the collection boundary. Affected typecheck rerun exits0. No additional successful-service fixtures were invented.
- Independent focused static review and affected-repair review found no consequential authenticity, scheduling or custody issue. It excludes
  rational keeper profit, unbiased sampling, present oracle availability and a complete protocol-fee scorecard.

Remaining full-campaign work: materialize enough distinct proof pairs from the observed 836-event source, schedule
requests/fulfillments without consuming a commitment twice, and retain the approved workload/outcome assertions.
No gate/signature configuration was changed and no short case substitutes for any required monthly regime.

Things that don't make sense: conflating four captured proofs with 836 observed request events, or using repeated
proofs to declare hundreds of continuous draws. Both claims are explicitly excluded.
