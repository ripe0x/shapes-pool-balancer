# FWA PoolsV2 source (vendored, read-only)

The FWA stack the Balancer targets, as verified on Sourcify for Ethereum mainnet (chain 1), fetched 2026-11-13 from
`https://sourcify.dev/server/v2/contract/1/<address>?fields=sources,compilation`. Not compiled by this repository;
reference for reviews and design work only. `collection-games/external/fwa-v2` is the OLDER stack: do not use it for
Balancer decisions.

| Contract | Address | Sourcify match (creation / runtime) | Compiler |
| --- | --- | --- | --- |
| PoolFactory | `0x8919814D825a5Af238cC04DE06b1C18c9eaA477C` | match / match | 0.8.26+commit.8a97fa7a |
| StandardPoolBuyback (pool implementation; `script/Deploy.s.sol` checks `FWA_IMPL`) | `0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7` | match / match | 0.8.26+commit.8a97fa7a |
| PoolPurchaseNotifier (created by the implementation) | `0x6A8b9ec644D6bAcBD589e20D6aF88BC32f420264` | match / match | 0.8.26+commit.8a97fa7a |

"match" is Sourcify's partial match: the bytecode matches but the metadata hash differs (comments or file paths may
differ from the deployed build). Not an "exact_match".

Each folder holds that contract's full source tree as Sourcify serves it, including its `lib/` copies.
