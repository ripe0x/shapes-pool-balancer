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

## Approved setup execution

Owner explicitly approved the prepared local batch and app start. Executed exact packet `dc8e8319d5818376d618a1439aaeb621b14383f82ad5c9f35e60b567791de552` at tooling revision `a80f2c7` through the canonical staged deployment path. Exit 0. Earlier prepared-only table entries above describe the pre-approval state; this section supersedes their setup status.

- Seven successful transactions, blocks 26485861–26485867; aggregate gas cost 2,575,982,763,183,130 wei (0.00257598276318313 test ETH), below 12 transaction / 1 ETH caps. Raw receipts, calldata, hashes and gas are in `../20261125174335482/journal.json`; deployment output is preserved there too.
- Same Anvil PID 28171, original command and Tenderly fork block 26485619 preserved. Chain ID 31337.
- Factory `0xbe49677a403f77136e81498e5681f8dc22aa1181`, implementation `0x940815eE17aa44E861bEfe77e6812EB0f2da9710`, batch marker 2. Public creation remains paused; policy admin is the local creator 0x000000000000000000000000000000000001e004. Deployment runtime hashes matched the approved packet.
- Creator and buyer each retain exactly 100 test ETH. Deployer balance 997424017236816870 wei; funding minus measured gas reconciles exactly.
- Demo collection `0x8B4087D01443ba7619BB3A6E2a8668C5AF0d1955`, IDs 1 and 2 both verified owned by the creator.
- App on http://127.0.0.1:5280/ responds HTTP 200. Browser visibly connected local creator e004, displayed the pool designer and enabled Create pool button. No pool was created, no approvals/draws/withdrawals were submitted. NFT discovery did not finish during the short browser check; documented manual contract/token entry uses actual fork ownership reads.
- Vite runs in persistent exec session 38606. Existing app environment files, deployment records and services were not overwritten. No background keeper was started.

Current receipt readbacks: `../20261125174335482/postflight.json`. No production release gate or full economic campaign was rerun for this local setup.

Things that do not make sense: live Chainlink delivery cannot service fresh requests on this private fork. Timeout/refund checks are explicitly separate from successful winner delivery.
