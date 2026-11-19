# Mainnet canary execution plan

**One authorization covers this whole plan.** The plan is finalized after the gate and the dry run (steps 1–4): the
owner's inputs, the dry run's deployment gas limit and file hash, and every account's start nonce are all written into
`deployments/canary-plan.json`. The owner then approves that file's exact SHA-256. The guard and the keeper refuse to run
unless the file still has that hash, so the plan cannot change after approval without a new approval. The executor then
runs every action below, in order, within its limits, without asking again per transaction. A new decision is needed only
when an input is missing, an action, account or limit changes, or a stop condition fires.

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

`scripts/canary-guard.ts` counts gross spend from canonical receipts. It walks every nonce each distinct wallet in the
plan has used since its recorded start nonce, and sums `gasUsed × effectiveGasPrice`. A wallet that holds several roles
(for example deployer and creator) is counted once. Reverted transactions and transactions from any
tool are counted; keeper compensation is never subtracted. Before each send it requires:

`spent + in-flight maximums + this transaction's gasLimit × maxFee + every later planned action's gasLimit × maxFee ≤ 0.05 ETH`

An account with a pending transaction the guard cannot price fails closed. History lookup uses
`eth_getTransactionBySenderAndNonce`. Providers differ on this method, so each answer is cross-checked against
`eth_getTransactionByHash` and the receipt, and any disagreement fails closed. On 2026-11-19 the Tenderly endpoint
answered consistently for existing mainnet nonces 0 and 1716 of `0x0198…E8Cb`, and returned an error for an unused
nonce. Step 0 repeats that check before execution. With the template's 1.5 gwei maximums, the
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

`$H` is the approved plan SHA-256. Every manual transaction is preceded by its guard check, which must exit 0, and is
sent with exactly that action's gas limit and max fee from the plan:

```bash
node --import tsx scripts/canary-guard.ts check --plan deployments/canary-plan.json --approved-plan-hash "$H" --action <id>
```

**Preparation (before approval; nothing is sent):**

0. **Provider preflight** on an existing mainnet transaction:
   `node --import tsx scripts/canary-guard.ts preflight --rpc-url https://mainnet.gateway.tenderly.co --sender 0x019817aD02a31B990433542097bE29D97613E8Cb --nonce 0`
   must print `"consistent": true`.
1. **Gate.** Sign and commit per [RELEASE-RECORD.md](RELEASE-RECORD.md). Production requires `ASSET FLOW GATE: PASS`.
2. **Fill inputs.** Copy the template to `deployments/canary-plan.json` and fill the addresses, curated NFT and pool settings.
3. **Dry run** (no signer, no broadcast; reruns the gate):
   `script/deploy.sh --rpc-url https://mainnet.gateway.tenderly.co --sender "$DEPLOYER"` with `PACKS_ADMIN`,
   `KEEPER_ADMIN`, `POLICY_ADMIN` exported. Keep the reviewed copy:
   `cp broadcast/Deploy.s.sol/1/dry-run/run-latest.json deployments/1.reviewed-dry-run.json`. Write its total gas limit,
   `python3 -c "import json;print(sum(int(t['transaction']['gas'],16) for t in json.load(open('deployments/1.reviewed-dry-run.json'))['transactions']))"`,
   into the `deploy` action and `shasum -a 256 deployments/1.reviewed-dry-run.json` into `reviewedDryRunSha256`.
   `deployments/1.json` from this run is simulation output and proves nothing about mainnet.
4. **Finalize.** With every account idle, record start nonces:
   `node --import tsx scripts/canary-guard.ts init --plan deployments/canary-plan.json`; then print the hash:
   `node --import tsx scripts/canary-guard.ts hash --plan deployments/canary-plan.json`.
   **The owner approves this exact hash.** That is the single authorization. Do not edit the file afterwards.

**Execution (within the approved plan):**

5. **Deploy** after `check --action deploy`:
   `script/deploy.sh --rpc-url https://mainnet.gateway.tenderly.co --ledger --sender "$DEPLOYER" --broadcast --verify --slow --with-gas-price <deploy maxFeePerGas> --priority-gas-price 50000000`
   (`--account <keystore>` instead of `--ledger` for a keystore).
6. **Verify the mined deployment** before any funding:
   `DEPLOYER=… PACKS_ADMIN=… KEEPER_ADMIN=… POLICY_ADMIN=… node --import tsx scripts/verify-deployment.ts --rpc-url https://mainnet.gateway.tenderly.co --reviewed-dry-run deployments/1.reviewed-dry-run.json --reviewed-dry-run-sha256 <reviewedDryRunSha256> --broadcast broadcast/Deploy.s.sol/1/run-latest.json`.
   It first requires the dry-run file to match the approved plan's hash. It then reads each canonical receipt and checks
   that the transaction succeeded, came from `DEPLOYER` and matches the reviewed calldata. It checks each CREATE/CREATE2
   address and its code; the factory implementation, keeper/policy admins, default policy, open list and absence of
   pending role transfers; the implementation's lock to `address(1)` and its FWA, Shapes, Packs and ENS wiring; and the
   Packs admin, renderer, unlocked presentation, 0.02 ETH minimum, name and symbol. Only then does it write
   `deployments/1.verified.json` with the factory's receipt block. Any mismatch stops the canary. It expects exactly the
   8 reviewed transactions; if forge skips a library that already exists at its CREATE2 address, verification refuses
   and the plan needs a fresh dry run and decision.
7. **Keeper list** (`keeperAdmin`): `cast send $FACTORY "setKeeperApproved(address,bool)" $KEEPER true` then
   `cast send $FACTORY "setKeepersRestricted(bool)" true`, each with the plan's `--gas-limit` and `--gas-price`,
   `--priority-gas-price 50000000 --ledger --rpc-url https://mainnet.gateway.tenderly.co`.
8. **Approve the curated NFT** (`creator`): `PRED=$(cast call $FACTORY "predictBalancer(address,bytes32)(address)" $CREATOR $SALT --rpc-url …)`,
   then `cast send $NFT "approve(address,uint256)" $PRED $TOKEN_ID` with the plan's gas limit and fee.
9. **Create and fund** (`creator`). First the read-only funding check, which reverts unless 0.25 ETH covers the
   required opening reserve at current gas and mint fee:
   `cast call $FACTORY "createBalancer(bytes32,(uint16,uint16,uint256,uint256),(address,uint256,uint256)[])" $SALT "($MARKUP,$BPS,20,1000000000000000)" "[($NFT,$TOKEN_ID,$PRICE)]" --value 0.25ether --from $CREATOR --rpc-url …`.
   Then the same as `cast send`. A revert stops the canary for a decision; the value is never raised above 0.25 ETH.
10. **Keeper.** Start from the verified block, with the signer from your secret store (never typed or committed):
    `CANARY_PLAN=deployments/canary-plan.json CANARY_PLAN_SHA256="$H" FACTORY=<verified factory> FROM_BLOCK=<factoryDeploymentBlock> RPC_URL=https://mainnet.gateway.tenderly.co STATE_FILE=keeper/state-canary.json MAX_GAS_PRICE_GWEI=1.5 npm run keeper`.
    It refuses to start if the plan's hash differs. Monitor `/health` including its `errors` field.
11. **Frontend.** `app/.env.production.local`: `VITE_CHAIN_ID=1`, `VITE_RPC_URL=https://mainnet.gateway.tenderly.co`,
    `VITE_FACTORY` and `VITE_FROM_BLOCK` from `deployments/1.verified.json`; `npm run build:app`.
12. **Observe.** At least one real purchase, live oracle fulfillment, keeper upkeep, collection and creator claim.
    No artificial mainnet failures.
13. **Close out** (`creator`, keeper stopped, each action guard-checked): `close()`; `performUpkeepUnpaid()` until every
    draw is reconciled; `unlistShapes(<Shape listing ids from getActiveIds()>)`;
    `withdrawCurated(<curated listing id>, $CREATOR)`; `collectProceeds()`; `claimSurplus(<withdrawableSurplus()>, $CREATOR)` (it already includes `creatorCredit`); `retire()`.
    FWA's pending-delivery and refund rules still apply.

## Stop conditions

Stop new sends and ask the owner on: a plan hash mismatch; a guard refusal for a planned manual action; a deployment verification mismatch;
a creation funding check that fails at 0.25 ETH; an unexplained ledger gap; an unexpected authority, code or recipient;
a keeper payment above the policy bounds; an unresolved pending transaction. If stopping mid-pool: close purchases,
preserve purchaser rights, then settle and recover only through the permitted paths above.

## What cannot be capped or claimed

The contracts have no global pool, asset or creation cap. Restricting the keeper list does not limit third-party
creators, player purchases or public unpaid work. No canary result promises stocked targets, profitability, oracle
reliability or safety beyond the paths it observes.
