# Mainnet v2 deployment record, 2026-11-26

**Deployed, verified and configured on Ethereum mainnet. Public creation remains paused.** Owner-approved broadcasts from the main checkout at `6d94d01` (code candidate `cf4dccd`), signer `0xCB43078C32423F5348Cab5885911C3B5faE217F9` via keystore `ripe0x`, through Alchemy because Tenderly returned 429. Approval packet: [APPROVAL.md](../mainnet-v2-preparation/APPROVAL.md).

## Deployment, nonces 4251–4254

| Contract | Address | Tx | Block | Gas used |
| --- | --- | --- | ---: | ---: |
| PoolPage (CREATE2) | `0x8Ca9E6CfE4A4F4F10cEF1d2EfF6954e476bd890C` | `0x01eb77bcfae2dfc52613a1e95479726eddb2e9969101fa60d1cf1589e520298d` | 26499985 | 420,065 |
| PoolInventory (CREATE2) | `0xe64f685C24056e41C30e4cf35C8Cb28381F1EAa5` | `0x6a38e7a9092f079c3f4b0b8ddb052d0a11f9b2f48f5def4a41fc9eabd73270f5` | 26499986 | 4,209,251 |
| PoolBalancer implementation | `0x45754494B606f9E3AebfB9984330eC788A87eF76` | `0xa52e0620b60fa06a736ab675772e02da0da00d5366832f2e53b5a9da905860fa` | 26499987 | 5,401,048 |
| BalancerFactory | `0x96fd7B2e83E04Ea2e78be415e0BC82A1332e7671` | `0xde0bce7b521adc1d63cda7d583fddf894360150773b51602e65101b1573d5a1b` | 26499988 | 1,483,846 |

Total **11,514,210 gas, 0.001571642619637461 ETH** (approved cap 0.0039301835 ETH), all zero native value.

- Asset gate PASS at source hash `58c252dd452c6c54b2b91694ed6c25e52f65eb9face0725d6ba1b88461c0596b`. Its fork tests ran through Alchemy using a `FOUNDRY_RPC_ENDPOINTS` environment override; `foundry.toml` was not edited. Two earlier attempts stopped at keystore decryption (wrong password) and broadcast nothing; nonce 4251 was confirmed unchanged after each.
- `scripts/verify-deployment.ts` against the reviewed dry run (SHA-256 `b196c10b91293be329970fc6a61d6fc6203be214e6094f3e261311f46d789902`): `DEPLOYMENT VERIFIED`. Output: [`deployments/1.creator-fee-v2.verified.json`](../../../deployments/1.creator-fee-v2.verified.json); broadcast: [`deployments/1.creator-fee-v2.broadcast.json`](../../../deployments/1.creator-fee-v2.broadcast.json).
- Readbacks: `creationPaused() == true`, `policyAdmin == 0xCB43…17F9`, implementation `profitAccountingVersion() == 2`, signer nonce 4255.

## Paused launch setup, nonce 4255

`setEconomics` on the new factory, tx `0x6b8be303a6402537882d856864462b7263d1e1680cd39c7ab3ccb54d34290253`, block 26499997, status 1, 48,984 gas at 0.151013981 gwei. Receipt: [`deployments/1.creator-fee-v2.setup-receipt.json`](../../../deployments/1.creator-fee-v2.setup-receipt.json).

Readback of `economics()` matches [launch-values.json](../mainnet-v2-preparation/launch-values.json) exactly, including **gasPriceCeiling 1.5 gwei and restockGas 940000**. `creationPaused()` still true.

## Cutover

- `0x6F018fF718Ab5A4287F937e4e4729Aa65610f53b` is packaged as `community-v3` in `deployments/1.legacy.json` with its deployed ABI (`shared/abi.ts` at `ab60c4b`, unchanged through its deployment commit `418233f`). It has no creation pause, so any pool created on it later stays discoverable and serviced.
- Post-deployment rescan through Alchemy at block **26500013** (after factory block 26499988): `ok: true`, no problems; community-v3 0 pools, community-v2 1 pool (known), community-v1 0, community-v0 0; no missing ABI selectors for v3. Output: [`deployments/1.creator-fee-v2.postdeploy-preflight.json`](../../../deployments/1.creator-fee-v2.postdeploy-preflight.json).
- Keeper `keeper/fly.toml`: `FACTORY` 0x96fd…7671, `FROM_BLOCK` 26499988, `LEGACY_FACTORIES` `community-v3,community-v2`. Dashboard: Netlify `VITE_FACTORY` and `VITE_FROM_BLOCK` to the same values.
- Checks: typecheck; 8 affected vitest files, 56 passed, 4 skipped. Local preview against mainnet loaded the new factory's economics without console errors; legacy pool listing needs a connected wallet and was not exercised in the preview.

## Production cutover, 2026-11-26

- `4fda6dc` pushed to `origin/main`.
- Netlify site `shapes-pool-balancer` (pools.shapes.ripe.wtf): `VITE_FACTORY` and `VITE_FROM_BLOCK` set in all four contexts, then `netlify deploy --build --prod`. The live bundle `index-BtStD0ip.js` contains the new factory and block; no localhost RPC.
- Keeper `shapes-community-keeper`, machine `80e9615a750398`, deployed via `keeper/deploy.sh` at `4fda6dc`: env reads back `FACTORY` 0x96fd…7671, `FROM_BLOCK` 26499988, `LEGACY_FACTORIES` community-v3,community-v2, `MAX_GAS_PRICE_GWEI` 1.5, expected signer `0x8D23…949d`. `/health` ok at block 26500043 with 1 balancer, no alerts, pending or errors.

## Not done

`setCreationPaused(false)` requires separate owner signing. No mainnet canary (R83).

Things that don't make sense: none.
