# Existing local factory implementation update

Owner request: “deploy the new impl on the existing local 8545 fork and set it on the factory so I can create a new
pool and test this. no mainnet.” Existing synthetic test roles and the 1 test ETH gas ceiling were retained; no new
funding was performed. The plan hash binds execution inputs; the owner request supplies authority, not the hash itself.

- Endpoint http://127.0.0.1:8545, chain 31337; preserved Anvil PID 28171, original fork block 26,485,619.
- Contract source: commit `3ff1ddd`. Dependencies reused, no factory creation.
- Factory `0xbe49677a403F77136e81498e5681f8DC22Aa1181`.
- Previous implementation `0x940815eE17aa44E861bEfe77e6812EB0f2da9710`.
- New implementation `0x0176016958744B0030c96cC10896bd0817D94855`.
- New PoolInventory library `0x24cf2635b6ccaa2cbf8957a39b0cc923f4c4f42f`.
- Plan hash `06f168dc6b46e55347b21cc3170aa6c0dc2ee9616cba79d2104c42b4d666330e`.
- Deployer `0x000000000000000000000000000000000001e001`, nonces 7 and 8.
- Policy admin `0x000000000000000000000000000000000001e004`, switch nonce 22.

| Operation | Transaction hash | Gas used | Gas paid (wei) |
| --- | --- | ---: | ---: |
| Inventory library | 0x267db47bc12d6c8e31aa0e03b70b8005f8d222576b432bf76af1d73d483b31c5 | 3529132 | 176456698815696 |
| Implementation | 0x4352d489b43ca0db9d7222b515d606db3ad901f602d423b946d583de5099806d | 5192541 | 259627179813525 |
| Factory setter | 0x6c00789bc9cf6fe0a5ed7b40fdae00aa981a262413c1fc3cb36a208eb2366551 | 33464 | 1673200769672 |

All receipts succeeded, blocks 26,485,984–26,485,986, zero transaction value. Aggregate gas cost
**0.000437757079398893 test ETH**. Actual bid was approximately 0.05 gwei on the locally advanced fork; this is not a
mainnet gas-price or keeper-profit measurement. Runtime hashes matched source-linked dry-run predictions before
switching. `verifyImplementationUpdate` checked the admin, decoded setter, event, canonical receipts and factory
snapshot; only the implementation changed. `profitAccountingVersion() == 1`; public creation remains unpaused.
The old pool proxy still embeds the old implementation. No pool-held ETH or NFT custody was changed; only deployment/admin wallets paid gas.

Preparation used the production Deploy.s.sol run path, a clean stage, read-only Forge simulation and the actual staged
guard. The initial preparation under implementation-20261125205213044 was superseded after independent review caught
a canonical-root/stage-root comparison defect. The repaired stage gate passed before any broadcast. The production
asset gate tail remains byte-for-byte unchanged. Guard bounds/implementation-manifest tests: 9 passed; typecheck
passed. Independent review covered the local guard and repairs, not a new audit of protocol economics.

Execution deployed both contracts successfully, then stopped before switching because the helper looked for
`dry-run/run-latest.json`. Forge writes the separate method to `dry-run/switchImplementation-latest.json` instead.
The failure remains in the journal's `recoveredFromFailure`. Both deployed contracts' actual runtime hashes and
receipts were reconciled, the existing switch simulation's decoded arguments and current admin nonce were checked,
and ONLY the switch was resumed through the same frozen staged wrapper and deployment script. No deployment was
repeated. The postflight then passed. The helper now selects method-specific artifact filenames, with a permanent
regression (4 focused tests passed after that repair). The repaired whole helper was not rebroadcast end-to-end;
its actual partial execution plus the separately reconciled switch are the bounded execution evidence.

The app was checked against this actual local factory, without a wallet connected. Its new-pool designer displayed
“Estimated creator proceeds per draw,” with no configured earnings percentage. The designer was left open for the
owner. No approval, creation or wallet transaction was clicked. The existing keeper remains restricted to the old
pool; the owner has not yet created a new pool to scope a new keeper/draw walkthrough to.

Recovery: the same local policy admin can switch the factory back to the recorded prior implementation after a
separately authorized call. Such a switch affects only future clones; no existing pool is upgraded or downgraded.
No mainnet release readiness or deployment authority follows from this local playground update.

Things that don't make sense: the initial runner assumed all Forge methods write run-latest.json. The actual switch
artifact proved otherwise; this is repaired and regression-tested. No unresolved postflight discrepancy remains.
