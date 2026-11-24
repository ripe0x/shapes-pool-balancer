import { encodeFunctionData, type Address, type Hash, type Hex, type PublicClient, type Transaction, type TransactionReceipt } from 'viem';

type Client = Pick<PublicClient, 'simulateContract' | 'estimateContractGas' | 'estimateFeesPerGas' | 'chain'>;
type Params = Record<string, unknown> & { gas?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint };

/** Gas limit headroom over the node's estimate. Gas use can rise between estimation and inclusion (Shapes mint gas
 *  varies with each block's seed; an FWA listing sent with an exact estimate was seen to fail inside a nested call).
 *  The margin is a limit only: the sender is charged for gas used, and keepers are reimbursed for measured gas. */
export const GAS_MARGIN_NUM = 13n;
export const GAS_MARGIN_DEN = 10n;

/** Simulate the exact call (so reverts surface by name), then set its gas limit to the estimate for the same account,
 *  contract, calldata and value plus 30%. A gas limit already supplied is kept as is. Throws on either failure.
 *  The call is simulated and sent at current EIP-1559 fees: without fee fields a node simulates at gas price 0, where
 *  upkeep's reward bound and FWA's VRF fee are both lower than at inclusion.
 *  The result names the simulated account and chain, so the wallet refuses to send it if either changed meanwhile. */
export async function prepareWrite<P extends Params>(
  client: Client,
  account: Address | undefined,
  params: P,
): Promise<P & { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; account: Address | undefined; chainId: number | undefined }> {
  const fees = params.maxFeePerGas !== undefined && params.maxPriorityFeePerGas !== undefined
    ? { maxFeePerGas: params.maxFeePerGas, maxPriorityFeePerGas: params.maxPriorityFeePerGas }
    : await client.estimateFeesPerGas();
  const priced = { ...params, maxFeePerGas: fees.maxFeePerGas!, maxPriorityFeePerGas: fees.maxPriorityFeePerGas! };
  const call = { ...priced, account } as never;
  await client.simulateContract(call);
  const gas = params.gas ?? ((await client.estimateContractGas(call)) * GAS_MARGIN_NUM) / GAS_MARGIN_DEN;
  return { ...priced, account, chainId: client.chain?.id, gas };
}

/** A plain ETH transfer prepared like `prepareWrite`: simulated with `eth_call` at current fees (so a refusing
 *  receiver surfaces before the wallet opens), with 30% gas-limit headroom, bound to the account and chain. */
export async function prepareTransfer(client: Pick<PublicClient, 'call' | 'estimateGas' | 'estimateFeesPerGas' | 'chain'>,
  account: Address | undefined, to: Address, value: bigint) {
  if (!account) throw new Error('Connect a wallet first.');
  const fees = await client.estimateFeesPerGas();
  const call = { account, to, value, maxFeePerGas: fees.maxFeePerGas!, maxPriorityFeePerGas: fees.maxPriorityFeePerGas! };
  await client.call(call);
  const gas = ((await client.estimateGas(call)) * GAS_MARGIN_NUM) / GAS_MARGIN_DEN;
  const prepared = { ...call, gas, chainId: client.chain?.id };
  if (prepared.chainId === undefined) throw new Error('The reviewed network is unavailable.');
  const intent: TransactionIntent = { chainId: prepared.chainId, from: account, to, input: '0x', value };
  return { prepared, intent };
}

export interface TransactionIntent { chainId: number; from: Address; to: Address; input: Hex; value: bigint }

/** Capture the simulated intent before the wallet can change its selected account or transaction fields. */
export function reviewedIntent(prepared: Record<string, unknown>): TransactionIntent {
  if (typeof prepared.account !== 'string' || typeof prepared.address !== 'string' || typeof prepared.chainId !== 'number') {
    throw new Error('The reviewed account and network are unavailable.');
  }
  return { chainId: prepared.chainId, from: prepared.account as Address, to: prepared.address as Address,
    input: encodeFunctionData(prepared as Parameters<typeof encodeFunctionData>[0]), value: (prepared.value as bigint | undefined) ?? 0n };
}

export function assertTransactionIntent(intent: TransactionIntent, transaction: Pick<Transaction, 'from' | 'to' | 'input' | 'value'>) {
  if (transaction.from.toLowerCase() !== intent.from.toLowerCase() || transaction.to?.toLowerCase() !== intent.to.toLowerCase()
    || transaction.input !== intent.input || transaction.value !== intent.value) {
    throw new Error('The action was cancelled or replaced by a different transaction.');
  }
}

type ConfirmationClient = Pick<PublicClient, 'getChainId' | 'getTransaction' | 'waitForTransactionReceipt'>;

export async function verifyActionReceipt(pub: Pick<ConfirmationClient, 'getChainId' | 'getTransaction'>,
  receipt: TransactionReceipt, intent: TransactionIntent) {
  if (receipt.status !== 'success') throw new Error('Transaction reverted.');
  if (await pub.getChainId() !== intent.chainId) throw new Error('Confirmation is unverified: the network does not match the reviewed action.');
  const transaction = await pub.getTransaction({ hash: receipt.transactionHash }).catch(() => undefined);
  if (!transaction || transaction.hash !== receipt.transactionHash || transaction.blockHash !== receipt.blockHash
    || transaction.blockNumber !== receipt.blockNumber) {
    throw new Error('Confirmation is unverified: the included transaction is unavailable.');
  }
  assertTransactionIntent(intent, transaction);
}

export async function confirmAction(pub: ConfirmationClient, hash: Hash, intent: TransactionIntent, timeout?: number) {
  const receipt = await pub.waitForTransactionReceipt({ hash, ...(timeout === undefined ? {} : { timeout }) });
  await verifyActionReceipt(pub, receipt, intent);
}

/** A reserved or sent ETH transfer. `hash` is set once the wallet returns it; `nonce` only once a node has shown that
 *  transaction, so it is the transfer's own nonce, never one guessed before the wallet chose it. `id` names the attempt
 *  that wrote it, so a failed attempt removes only its own record. */
export interface PendingTransfer { chainId: number; from: Address; to: Address; since: number; id?: string; hash?: Hash; nonce?: number }

/** How long a transfer no node has shown keeps blocking another one. Its nonce is unknown, so nothing on chain can
 *  prove it will never mine. */
export const UNSEEN_HOLD_MS = 24 * 60 * 60 * 1000;

export const transferKey = (i: Pick<TransactionIntent, 'chainId' | 'from' | 'to'>) =>
  `pending-transfer:${i.chainId}:${i.from.toLowerCase()}:${i.to.toLowerCase()}`;

/** ETH sent to a pool is not refundable, so a transfer whose outcome is unknown blocks another one to the same pool.
 *  It is resolved once mined, or once its own nonce is used by another transaction (a replacement or cancellation).
 *  A transfer never seen by the node blocks for UNSEEN_HOLD_MS. Returns the transaction's nonce when the node shows it,
 *  for the caller to keep. RPC failures throw, so an unknown state never permits a second transfer. */
export async function transferState(pub: Pick<PublicClient, 'getTransaction' | 'getTransactionCount'>, p: PendingTransfer,
  now = Date.now()): Promise<{ unresolved: boolean; nonce?: number }> {
  const transaction = p.hash ? await pub.getTransaction({ hash: p.hash }).catch((e: Error) => {
    if (e.name === 'TransactionNotFoundError') return undefined;
    throw e;
  }) : undefined;
  if (transaction?.blockNumber != null) return { unresolved: false };
  const nonce = transaction?.nonce ?? p.nonce;
  if (nonce === undefined) return { unresolved: now - p.since < UNSEEN_HOLD_MS };
  return { unresolved: await pub.getTransactionCount({ address: p.from, blockTag: 'latest' }) <= nonce, nonce };
}

export type TransactionStep = (() => Promise<Hash | undefined>) | [string, () => Promise<Hash | undefined>];

/** A confirmation failure stops dependent wallet actions and caller success effects. */
export async function runTransactionSteps(label: string, steps: TransactionStep[],
  onStep: (name: string, index: number) => void, confirm: (hash: Hash) => Promise<void>,
  onDone?: (index: number, hash: Hash | undefined) => void) {
  for (const [index, step] of steps.entries()) {
    const [name, run] = Array.isArray(step) ? step : [label, step];
    onStep(name, index);
    const hash = await run();
    if (hash) await confirm(hash);
    onDone?.(index, hash);
  }
}
