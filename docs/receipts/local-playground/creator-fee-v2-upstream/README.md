> Completed after explicit owner refresh approval. See [deployment and verified restoration](../implementation-20261126000317038/README.md). The preparation status below is historical.

# Local v2 deployment preparation: archive fallback

Owner authorized the v2 implementation deployment/switch on preserved localhost8545, then explicitly authorized the
stored Alchemy upstream, used sparingly. No mainnet write, new funding, pool write or draw was performed here.
The existing deployment scope remains at most five transactions and one test ETH aggregate gas, from synthetic
1e001 and policy-admin1e004. The factory stays publicly unpaused.

`verified-change.json` records a successful **configuration** change and identical recorded state. Anvil1.8.1
SHA982849d3140c01fd3b72905759581a132df7aa98 has a separate execution database: `anvil_setRpcUrl` updates its fork
configuration provider but leaves that database using the original Tenderly connection. Therefore this record is
not evidence of a working execution-provider switch. Tenderly429 still blocked the subsequent deployment simulation.

A full dump including historical account snapshots exceeded Anvil's response limit. The subsequent current-state
backup succeeds: 81 accounts,446 local blocks,293 transactions,2,559,002 encoded bytes. Kept at
`/tmp/fwa-8545-before-archive-rebind.state`, SHA256
`94dfde3e7c832b6be9f46adbfce79c5f82cfc651d677c2de4032621118f2ed54`. It does not preserve old rollback snapshot IDs
or historical account-state snapshots. No reset has occurred; explicit owner approval for those losses remains pending.

A same-process reset/load controller is prepared at `/tmp/fwa-8545-archive-rebind.mjs`, SHA256
`2bd521e3c8b2b2bcc60a2952ccf54c1c1439e07c2d34746126be60b1638ef30a`. Independent affected review confirmed
its process, chain, original fork block and upstream identity gates, zero-pending check, full current-account
comparison, recorded block/transaction comparison, head/hash and unlocked-account checks. It leaves automine off
if restoration fails. Execution must wait for the owner's explicit checkpoint-loss approval and quiescent writers.

Deployment helper changes bind this update to the actual existing v1 implementation, require the v2 marker, and
allow the explicitly selected configured archive provider only on this owned local node. The packet stores an
upstream hash, never its credential URL. Default playground operations still require Tenderly; production gate
unchanged. Ten focused deployment/playground guard tests passed, typecheck passed. Bounded independent source review
found no further blocker. No broad contract or economic campaign consumed the paid RPC.

Things that don't make sense: treating a changed Anvil configuration URL as proof that execution uses that provider.
