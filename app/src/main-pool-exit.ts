import { formatEther, parseAbiItem, type Abi, type Address, type Hash, type Hex, type PublicClient } from 'viem';
import { packVaultAbi } from '../../shared/main-pool-abi';
import { historyRange, readVault } from './main-pool';
import { incrementalRange } from './ledger';
import { assertTransactionIntent, prepareWrite, type TransactionIntent } from './tx';

const CONTRIBUTION = parseAbiItem('event ContributionFunded(uint256 indexed id, address indexed payer, uint256 indexed era, uint256 amount)');
const contributionCache = new Map<string, { through: bigint; ids: { id: bigint; block: bigint }[] }>();
export async function readContributions(pub: PublicClient, vault: Address, payer: Address, page: number) {
  const blockNumber = await pub.getBlockNumber();
  const deployment = await pub.readContract({ address: vault, abi: packVaultAbi, functionName: 'deploymentBlock', blockNumber });
  const key = `${pub.chain?.id}:${vault.toLowerCase()}:${payer.toLowerCase()}`;
  const previous = contributionCache.get(key);
  const range = incrementalRange(previous?.through, deployment, 64n);
  const bounded = historyRange(range.from, blockNumber);
  const logs = await pub.getLogs({ address: vault, event: CONTRIBUTION, args: { payer }, ...bounded });
  const ids = [...(previous?.ids.filter((c) => c.block <= range.keepThrough) ?? []),
    ...logs.map((l) => ({ id: l.args.id!, block: l.blockNumber! }))];
  contributionCache.set(key, { through: bounded.toBlock, ids });
  const rows = await Promise.all(ids.slice(page * 16, page * 16 + 16).map(async ({ id }) => {
    const read = <T,>(functionName: string, args: unknown[]) => pub.readContract({ address: vault, abi: packVaultAbi as Abi, functionName, args, blockNumber }) as Promise<T>;
    const [contribution, refund] = await Promise.all([
      read<readonly [Address, bigint, bigint, bigint, boolean]>('contributions', [id]), read<bigint>('checkpointRefund', [id]),
    ]);
    const [, era, , amount, claimed] = contribution;
    const [, refundable, closed] = await read<readonly [bigint, bigint, boolean]>('chargeEras', [era]);
    return { id, era, amount, claimed, refund, eraRefundable: refundable, closed };
  }));
  return { rows, knownCount: ids.length, complete: bounded.toBlock === blockNumber, through: bounded.toBlock };
}

export interface ExitSpend { limit: bigint; debited: bigint; temporaryFunding: bigint; actualGas: bigint }
export function checkExitSpend(state: ExitSpend, gas: bigint, maxFeePerGas: bigint, value: bigint) {
  const maximumDebit = gas * maxFeePerGas + value;
  if (maximumDebit > state.limit - state.debited) throw new Error('This step exceeds your remaining wallet spending limit. Raise the limit explicitly or wait for lower gas.');
  return maximumDebit;
}
export interface ExitCall { label: string; functionName: string; args: readonly unknown[]; value?: bigint; target?: Address; transfer?: boolean }
export function exitBatches(ids: bigint[]) {
  return Array.from({ length: Math.ceil(ids.length / 16) }, (_, i) => ids.slice(i * 16, i * 16 + 16));
}
export function exitCalls(v: Awaited<ReturnType<typeof readVault>>, need: bigint, shortfall: bigint): ExitCall[] {
  const holder = v.holder;
  if (!holder) return [];
  if (holder.pendingDeposit > 0n) return [{ label: 'Cancel uncommitted deposit', functionName: 'cancelDeposit', args: [] }];
  if ((holder.claimable ?? 0n) > 0n) return [{ label: 'Claim priced ETH', functionName: 'claim', args: [] }];
  if (holder.shares > 0n) return [{ label: 'Request redemption of all shares', functionName: 'requestRedeem',
    args: [holder.shares, v.configHash], value: v.requestCharge + (holder.shares * v.lastNav / v.totalShares) * v.unwindCharge / v.referencePositionValue }];
  if (holder.redeeming === 0n) return [];
  const batches = exitBatches(v.book.ids);
  const calls: ExitCall[] = (batches.length ? batches : [[]]).map((ids) => ({ label: 'Reconcile bounded settlement work', functionName: 'recover', args: [ids, v.book.witness ?? 0n] }));
  if (need > 0n && (v.book.idle > 0 || v.book.recovery > 0)) calls.push({ label: 'Redeem idle or recovery packs for holder liquidity', functionName: 'recoverLiquidate', args: [16n] });
  if (shortfall > 0n) for (const ids of batches) calls.push({ label: 'Unlist a bounded batch for holder liquidity', functionName: 'recoverUnlist', args: [ids] });
  calls.push({ label: 'Price the next redemption fill', functionName: 'recoverCheckpoint', args: [v.book.witness ?? 0n] });
  return calls;
}

/** Reviews one real, bounded recovery transaction. No profitability filter applies after the holder authorizes gas. */
export async function reviewExit(pub: PublicClient, vault: Address, holder: Address, spend: ExitSpend) {
  const v = await readVault(pub, vault, holder);
  const read = (functionName: string) => pub.readContract({ address: vault, abi: packVaultAbi as Abi, functionName, blockNumber: v.blockNumber }) as Promise<bigint>;
  const [need, shortfall] = await Promise.all([read('liquidityNeed'), read('liquidityShortfall')]);
  const candidates = exitCalls(v, need, shortfall);
  if (!candidates.length) return { done: true as const };
  let spendingFailure: Error | undefined;
  for (const call of candidates) {
    try {
      const prepared = await prepareWrite(pub, holder, { address: vault, abi: packVaultAbi as Abi,
        functionName: call.functionName, args: call.args, value: call.value ?? 0n });
      if (prepared.gas > 16777216n) throw new Error('The estimated transaction exceeds the network gas limit.');
      const maximumDebit = checkExitSpend(spend, prepared.gas, prepared.maxFeePerGas, call.value ?? 0n);
      const estimatedGas = prepared.gas * 10n / 13n;
      const block = await pub.getBlock({ blockNumber: v.blockNumber });
      const expectedPrice = block.baseFeePerGas === null ? prepared.maxFeePerGas
        : block.baseFeePerGas + prepared.maxPriorityFeePerGas < prepared.maxFeePerGas
          ? block.baseFeePerGas + prepared.maxPriorityFeePerGas : prepared.maxFeePerGas;
      return { done: false as const, call, prepared, maximumDebit, expectedWalletGas: estimatedGas * expectedPrice,
        configHash: v.configHash, reviewedBlock: v.blockNumber, reviewedLimit: spend.limit };
    } catch (e) {
      if (e instanceof Error && e.message.includes('spending limit')) spendingFailure = e;
    }
  }
  if (spendingFailure) throw spendingFailure;
  throw new Error('No bounded exit step can execute yet. FWA settlement, the next quiet checkpoint window, or a later inventory page may be required. Refresh to continue.');
}

export type ExitReview = Awaited<ReturnType<typeof reviewExit>>;
export interface SavedExitSpend { chainId: number; vault: Address; holder: Address; limit: string; debited: string; temporaryFunding: string; actualGas: string; migration?: import('./main-manager-migration').Migration;
  pending?: { id: string; minimumNonce: number; nonce?: number; hash?: Hash; maximumDebit: string; value: string; input: Hex; to?: Address } }
export const exitSpendKey = (chainId: number, vault: Address, holder: Address) => `main-exit:${chainId}:${vault.toLowerCase()}:${holder.toLowerCase()}`;
export const serializeSpend = (s: ExitSpend) => ({ limit: String(s.limit), debited: String(s.debited), temporaryFunding: String(s.temporaryFunding), actualGas: String(s.actualGas) });
export const parseSpend = (s: Pick<SavedExitSpend, 'limit' | 'debited' | 'temporaryFunding' | 'actualGas'>): ExitSpend => ({
  limit: BigInt(s.limit), debited: BigInt(s.debited), temporaryFunding: BigInt(s.temporaryFunding), actualGas: BigInt(s.actualGas),
});

/** The lock covers reservation, confirmation and every durable reconciliation across all tabs. */
export async function withExitSpendLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('This browser cannot safely coordinate exit spending across tabs. Use a browser with Web Locks support.');
  return navigator.locks.request(key, { mode: 'exclusive' }, action);
}

export function reserveExitSpend(current: SavedExitSpend, reviewedLimit: bigint, maximumDebit: bigint,
  pending: NonNullable<SavedExitSpend['pending']>): SavedExitSpend {
  if (current.pending) throw new Error('A previous wallet step is unresolved. Wait for its confirmation before another step.');
  if (BigInt(current.limit) !== reviewedLimit) throw new Error('The wallet spending limit changed in another tab. Review again.');
  if (maximumDebit < 0n || BigInt(current.debited) + maximumDebit > BigInt(current.limit)) throw new Error('This step exceeds your remaining wallet spending limit. Review again.');
  return { ...current, debited: String(BigInt(current.debited) + maximumDebit), pending };
}

/** First-receipt amounts are observations. Signed maxima remain reserved even after a revert or reorg. */
export function observeExitReceipt(saved: SavedExitSpend, gasCost: bigint, successful: boolean): SavedExitSpend {
  if (!saved.pending) return saved;
  return { ...saved, pending: undefined, actualGas: String(BigInt(saved.actualGas) + gasCost),
    temporaryFunding: String(BigInt(saved.temporaryFunding) + (successful ? BigInt(saved.pending.value) : 0n)) };
}

export function signedExitMaximum(transaction: { gas: bigint; maxFeePerGas?: bigint | null; gasPrice?: bigint | null; value: bigint }) {
  const price = transaction.maxFeePerGas ?? transaction.gasPrice;
  if (price === undefined || price === null) throw new Error('The signed transaction fee bound is unavailable. Further exit steps remain blocked.');
  return transaction.gas * price + transaction.value;
}

export function reserveExitReplacement(saved: SavedExitSpend, signedMaximum: bigint): SavedExitSpend {
  if (!saved.pending) throw new Error('No pending exit step remains.');
  const previous = BigInt(saved.pending.maximumDebit);
  if (signedMaximum <= previous) return saved;
  const reserved = BigInt(saved.debited) + signedMaximum - previous;
  if (reserved > BigInt(saved.limit)) throw new Error(`The wallet signed a maximum of ${formatEther(signedMaximum)} ETH. Further steps remain blocked; explicitly raise the flow limit before accepting this wallet change.`);
  return { ...saved, debited: String(reserved), pending: { ...saved.pending, maximumDebit: String(signedMaximum) } };
}

export function assertExitReplacementNonce(pending: NonNullable<SavedExitSpend['pending']>, nonce: number) {
  if (nonce !== (pending.nonce ?? pending.minimumNonce)) throw new Error('That transaction does not match the pending exit nonce. Further exit steps remain blocked.');
}

export async function settleExitSpend(pub: PublicClient, saved: SavedExitSpend): Promise<SavedExitSpend> {
  const pending = saved.pending;
  if (!pending?.hash) return saved;
  const receipt = await pub.getTransactionReceipt({ hash: pending.hash }).catch((error: Error) => {
    if (error.name === 'TransactionReceiptNotFoundError') return undefined;
    throw error;
  });
  if (!receipt) return saved;
  if (await pub.getChainId() !== saved.chainId) throw new Error('The pending exit belongs to another network.');
  const transaction = await pub.getTransaction({ hash: pending.hash });
  assertExitReplacementNonce(pending, transaction.nonce);
  const intent: TransactionIntent = { chainId: saved.chainId, from: saved.holder, to: pending.to ?? saved.vault, input: pending.input, value: BigInt(pending.value) };
  assertTransactionIntent(intent, transaction);
  if (transaction.blockHash !== receipt.blockHash || transaction.blockNumber !== receipt.blockNumber) throw new Error('Exit confirmation is inconsistent. Refresh before continuing.');
  const canonical = await pub.getBlock({ blockNumber: receipt.blockNumber });
  if (canonical.hash !== receipt.blockHash) throw new Error('Exit receipt is no longer canonical. Its maximum remains reserved.');
  const gas = receipt.gasUsed * receipt.effectiveGasPrice;
  const bounded = reserveExitReplacement(saved, signedExitMaximum(transaction));
  return observeExitReceipt(bounded, gas, receipt.status === 'success');
}
