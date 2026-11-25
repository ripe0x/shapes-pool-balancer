# Local playground tooling verification

Revision before tooling: `cc900c9`. Scope: existing-node 8545 setup, exact-hash local deployment wrapper, and user-operated draw helper. No Solidity, ABI or compiler setting changes.

- `npm run typecheck`: exit 0, including the final environment-boundary repair. See typecheck logs.
- Selected Vitest playground/production-wrapper gate checks: exit 0, 4 passed, 39 skipped. The rejection case missed by that filter was then run separately: exit 0, 1 passed.
- After the environment repair, `npx vitest run scripts/local-playground.test.ts`: exit 0, all 4 passed. Production gate tail remains byte-for-byte identical.
- `node --import tsx scripts/local-draws.ts --help`: exit 0; no RPC writes.
- Read-only canonical Deploy.s.sol dry run: successful; four deployment actions, paused factory, exact dependency/code hashes retained in each bounded packet and simulation log.
- Independent scoped review: environment-only deployment override gap identified, repaired, and reviewed again with no further actionable issue. No independent execution claimed.

## Asset flows and limits

| Flow | Destination / bound | Evidence |
| --- | --- | --- |
| Local wallet funding | synthetic deployer 1 ETH, creator 100 ETH, buyer 100 ETH | Prepared only, awaiting owner batch approval |
| Setup transactions | four contract/library deployments, DemoNFT deployment and two mints; <=12 transactions, <=1 test ETH gas | Dry-run actions verified; no bootstrap broadcasts yet |
| Demo NFTs | tokens 1 and 2 to creator 0x000000000000000000000000000000000001e004 | Prepared only; receipt readbacks required |
| Buyer payments | real FWA acquireBatch, <=1 ETH aggregate forward payment; refunds do not reset cap | Helper implemented; user-created pool not yet available |
| Expired draws | actual refund credit returned to buyer; real VRF fee retained | Runtime execution still untested on a new UI-created pool |
| Upkeep gas | buyer pays optional permissionless performUpkeepUnpaid; helper <=1 ETH aggregate gas | Function authority checked in source; execution pending |

This is local interactive tooling, not a production release scorecard or the full economic campaign. Historical proof replay cannot fulfill fresh requests on this private fork. Local setup creates no pools and submits no draws. The owner will exercise creation and withdrawals through the app.

The older preparation packet is preserved as superseded, never approved/executed. Current packet: `../20261125174335482/bounded-plan.json`, hash `dc8e8319d5818376d618a1439aaeb621b14383f82ad5c9f35e60b567791de552`.

Things that do not make sense: claiming timeout refunds prove successful random NFT delivery. They do not; the two paths remain separate.
