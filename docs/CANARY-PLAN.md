# Mainnet canary execution plan

**One authorization covers this whole plan.** The owner fills [canary-plan.template.json](canary-plan.template.json)
into `deployments/canary-plan.json` and approves that file's SHA-256. The executor then runs every action below, in
order, within its limits, without asking again per transaction. A new decision is needed only when an input is missing,
an action, account or limit changes, or a stop condition fires. Nothing here is authorized until that approval exists.

Contracts: `e7e3558` (gate source hash `341db26a…`). Deployment requires an observed production gate `PASS` first.

## Inputs and limits

| Item | Value | Status |
| --- | --- | --- |
| `deployer`, `packsAdmin`, `keeperAdmin`, `policyAdmin`, `creator`, `keeper` | Addresses; `keeperAdmin` and `policyAdmin` should differ | **owner to choose** |
| Curated NFT | collection, token id, listing price | **owner to choose** |
| Pool | `markupBps`, `creatorRevenueBps` | **owner to choose**; the 25 benchmark scenarios used 2,500 and 400, which are not a recommendation |
| Prize target | 20 × 0.01 ETH Shapes (`target = 20`), mint fee cap 0.001 ETH | from the reviewed canary proposal |
| Pool funding | one owner pool; cumulative deposits ≤ **0.25 ETH** (the creation value; no later Add ETH) | fixed |
| Gas | cumulative gross gas ≤ **0.05 ETH** across all six accounts, reverted transactions included | fixed; enforced below |
| Keepers | factory list restricted to the plan's `keeper` during the canary | fixed |

The 0.25 ETH limit is the owner's pilot funding. It is not a protocol cap: anyone can create other pools on the factory.

## Gas budget enforcement

`scripts/canary-guard.ts` counts gross spend from canonical receipts. It walks every nonce each plan account has used
since its recorded start nonce, and sums `gasUsed × effectiveGasPrice`. Reverted transactions and transactions from any
tool are counted; keeper compensation is never subtracted. Before each send it requires:

`spent + in-flight maximums + this transaction's gasLimit × maxFee + every later planned action's gasLimit × maxFee ≤ 0.05 ETH`

An account with a pending transaction the guard cannot price fails closed. With the template's 1.5 gwei maximums, the
deployment check needs 21,223,646 × 1.5 gwei = 0.031835 ETH plus 0.012615 ETH reserved for the later actions:
0.044450 ETH, within 0.05 ETH. The deployment would fit up to a 1.761 gwei max fee. The keeper gets what remains after
actual spend and the closeout reserve (0.0070575 ETH). At the 0.59 gwei basefee observed at block 26,451,186, actual
deployment costs about 16.0M gas × 0.64 gwei ≈ 0.010 ETH, leaving roughly 0.03 ETH of keeper gas.

The keeper runs with `CANARY_PLAN` set. Before each new send and each fee replacement it asks the guard. The guard
counts the transaction at gas limit × max fee, and a replacement at the larger of its old and new maximums. When the
budget is short, the keeper withholds the transaction and logs `withheld by spending guard`. The shared keeper still
discovers every factory pool; its gas on any pool counts against this budget. Stop the keeper process during manual
actions so two senders never pass the check at the same moment.

## Execution sequence

Every `cast send` uses the plan action's gas limit and max fee, and is preceded by its guard check, which must exit 0:

```bash
node --import tsx scripts/canary-guard.ts check --plan deployments/canary-plan.json --action <id>
```

0. **Record start nonces** (all accounts idle): `node --import tsx scripts/canary-guard.ts init --plan deployments/canary-plan.json`.
   Approve the plan file's `shasum -a 256` (this is the single authorization).
1. **Gate.** Sign and commit per [RELEASE-RECORD.md](RELEASE-RECORD.md). Production requires `ASSET FLOW GATE: PASS`.
2. **Dry run** (no signer, no broadcast; reruns the gate):
   `script/deploy.sh --rpc-url https://mainnet.gateway.tenderly.co --sender "$DEPLOYER"` with `PACKS_ADMIN`,
   `KEEPER_ADMIN`, `POLICY_ADMIN` exported. Keep the reviewed copy:
   `cp broadcast/Deploy.s.sol/1/dry-run/run-latest.json deployments/1.reviewed-dry-run.json`. Set the `deploy` action's gas limit
   to its total: `python3 -c "import json;print(sum(int(t['transaction']['gas'],16) for t in json.load(open('deployments/1.reviewed-dry-run.json'))['transactions']))"`.
   `deployments/1.json` from this run is simulation output and proves nothing about mainnet.
3. **Deploy** after `check --action deploy`:
   `script/deploy.sh --rpc-url https://mainnet.gateway.tenderly.co --ledger --sender "$DEPLOYER" --broadcast --verify --slow --with-gas-price 1500000000 --priority-gas-price 50000000`
   (`--account <keystore>` instead of `--ledger` for a keystore).
4. **Verify the mined deployment** before any funding:
   `DEPLOYER=… PACKS_ADMIN=… KEEPER_ADMIN=… POLICY_ADMIN=… node --import tsx scripts/verify-deployment.ts --rpc-url https://mainnet.gateway.tenderly.co --reviewed-dry-run deployments/1.reviewed-dry-run.json --broadcast broadcast/Deploy.s.sol/1/run-latest.json`.
   It reads each canonical receipt and checks that it succeeded, came from `DEPLOYER` and matches the reviewed dry run's
   calldata. It checks each CREATE/CREATE2 address and its code, the factory implementation, keeper/policy admins,
   default policy and open list, and no pending role transfers. It checks the implementation is locked to `address(1)`
   with its FWA, Shapes, Packs and ENS wiring, and the Packs admin, renderer, unlocked presentation, 0.02 ETH minimum,
   name and symbol. Only then does it write `deployments/1.verified.json` with the factory's receipt block. Any
   mismatch stops the canary. It expects exactly the 8 reviewed transactions; if forge skips a library that already
   exists at its CREATE2 address, verification refuses and the plan needs a fresh dry run and decision.
5. **Keeper list** (`keeperAdmin`): `cast send $FACTORY "setKeeperApproved(address,bool)" $KEEPER true` then
   `cast send $FACTORY "setKeepersRestricted(bool)" true`, each with `--gas-limit` and `--gas-price` from the plan,
   `--priority-gas-price 50000000 --ledger --rpc-url https://mainnet.gateway.tenderly.co`.
6. **Approve the curated NFT** (`creator`): `PRED=$(cast call $FACTORY "predictBalancer(address,bytes32)(address)" $CREATOR $SALT --rpc-url …)`,
   then `cast send $NFT "approve(address,uint256)" $PRED $TOKEN_ID` with plan fees.
7. **Create and fund** (`creator`). First the read-only funding check, which reverts unless 0.25 ETH covers the
   required opening reserve at current gas and mint fee:
   `cast call $FACTORY "createBalancer(bytes32,(uint16,uint16,uint256,uint256),(address,uint256,uint256)[])" $SALT "($MARKUP,$BPS,20,1000000000000000)" "[($NFT,$TOKEN_ID,$PRICE)]" --value 0.25ether --from $CREATOR --rpc-url …`.
   Then the same as `cast send`. A revert stops the canary for a decision; the value is never raised above 0.25 ETH.
8. **Keeper.** Start from the verified block, with the signer from your secret store (never typed or committed):
   `CANARY_PLAN=deployments/canary-plan.json FACTORY=<verified factory> FROM_BLOCK=<factoryDeploymentBlock> RPC_URL=https://mainnet.gateway.tenderly.co STATE_FILE=keeper/state-canary.json MAX_GAS_PRICE_GWEI=1.5 npm run keeper`.
   Monitor `/health` including its `errors` field.
9. **Frontend.** `app/.env.production.local`: `VITE_CHAIN_ID=1`, `VITE_RPC_URL=https://mainnet.gateway.tenderly.co`,
   `VITE_FACTORY` and `VITE_FROM_BLOCK` from `deployments/1.verified.json`; `npm run build:app`.
10. **Observe.** At least one real purchase, live oracle fulfillment, keeper upkeep, collection and creator claim.
    No artificial mainnet failures.
11. **Close out** (`creator`, keeper stopped, each action guard-checked): `close()`; `performUpkeepUnpaid()` until every
    draw is reconciled; `unlistShapes(<Shape listing ids from getActiveIds()>)`;
    `withdrawCurated(<curated listing id>, $CREATOR)`; `collectProceeds()`; `claimSurplus(<withdrawableSurplus()>, $CREATOR)` (it already includes `creatorCredit`); `retire()`.
    FWA's pending-delivery and refund rules still apply.

## Stop conditions

Stop new sends and ask the owner on: a guard refusal for a planned manual action; a deployment verification mismatch;
a creation funding check that fails at 0.25 ETH; an unexplained ledger gap; an unexpected authority, code or recipient;
a keeper payment above the policy bounds; an unresolved pending transaction. If stopping mid-pool: close purchases,
preserve purchaser rights, then settle and recover only through the permitted paths above.

## What cannot be capped or claimed

The contracts have no global pool, asset or creation cap. Restricting the keeper list does not limit third-party
creators, player purchases or public unpaid work. No canary result promises stocked targets, profitability, oracle
reliability or safety beyond the paths it observes.
