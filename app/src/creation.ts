import { BaseError, ChainMismatchError, UserRejectedRequestError, encodeFunctionData, type Address, type Hash, type PublicClient, type Transaction } from 'viem';
import { ConnectorAccountNotFoundError, ConnectorChainMismatchError, ConnectorNotConnectedError } from '@wagmi/core';
import { balancerFactoryAbi, fwaPoolAbi, poolBalancerAbi } from '../../shared/abi';

/** One submitted atomic creation, retained until its on-chain outcome is known. */
export interface CreationAttempt {
  chainId: number;
  factory: Address;
  creator: Address;
  salt: Hash;
  predicted: Address;
  hash?: Hash;
  submittedHash?: Hash;
  /** Observed on the actual submitted transaction, never a pre-wallet nonce estimate. */
  nonce?: number;
  fromBlock?: string;
  config: { markupBps: number; creatorRevenueBps: number; target: string; mintFeeCap: string };
  curated: { collection: Address; tokenId: string; base: string }[];
  value: string;
}

export interface CreationContext { chainId?: number; factory: Address; creator?: Address }
export type CreationOutcome = 'confirmed' | 'cancelled' | 'replaced' | 'reverted' | 'pending' | 'unknown' | 'context' | 'mismatch';
const sameAddress = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export const sameCreation = (a?: CreationAttempt, b?: CreationAttempt) => !!a && !!b
  && a.chainId === b.chainId && sameAddress(a.factory, b.factory) && sameAddress(a.creator, b.creator)
  && sameAddress(a.predicted, b.predicted) && a.salt === b.salt && a.value === b.value
  && a.config.markupBps === b.config.markupBps && a.config.creatorRevenueBps === b.config.creatorRevenueBps
  && a.config.target === b.config.target && a.config.mintFeeCap === b.config.mintFeeCap
  && a.curated.length === b.curated.length && a.curated.every((n, i) => sameAddress(n.collection, b.curated[i].collection)
    && n.tokenId === b.curated[i].tokenId && n.base === b.curated[i].base);

export const creationContextMatches = (a: CreationAttempt, c: CreationContext) => a.chainId === c.chainId
  && sameAddress(a.factory, c.factory) && sameAddress(a.creator, c.creator);

export const sameSubmission = (a?: CreationAttempt, b?: CreationAttempt) => sameCreation(a, b)
  && a?.hash === b?.hash && a?.nonce === b?.nonce;

/** These wallet/connector failures occur before submission; RPC timeouts never establish a revert. */
export function creationNotSubmitted(error: unknown): boolean {
  const rejected = (cause: unknown) => cause instanceof UserRejectedRequestError || cause instanceof ChainMismatchError
    || cause instanceof ConnectorAccountNotFoundError || cause instanceof ConnectorChainMismatchError
    || cause instanceof ConnectorNotConnectedError || (!!cause && typeof cause === 'object' && 'code' in cause && cause.code === 4001);
  return rejected(error) || (error instanceof BaseError && !!error.walk(rejected));
}

export const canRetryCreation = (outcome: CreationOutcome, a: CreationAttempt, context: CreationContext) =>
  ['cancelled', 'replaced', 'reverted'].includes(outcome) && creationContextMatches(a, context);

export const creationStatus = (outcome: CreationOutcome) => ({
  confirmed: 'Pool creation verified.',
  cancelled: 'Creation was cancelled. Your saved design can be retried.',
  replaced: 'Creation was replaced by another transaction. Your saved design can be retried.',
  reverted: 'Creation reverted. Your saved design can be retried.',
  pending: 'Creation is pending.',
  unknown: 'Creation confirmation is unavailable. Check the existing submission before trying again.',
  context: 'Reconnect the creating account and network to verify this pool.',
  mismatch: 'The pool does not match the submitted design. Check it before continuing.',
})[outcome];

type Remember = (next: CreationAttempt, previous?: CreationAttempt) => void;
type CreationClient = Pick<PublicClient, 'getChainId' | 'getBlockNumber' | 'getBlock' | 'getTransactionCount' | 'readContract' | 'getTransactionReceipt' | 'getTransaction'>;
const creationInput = (a: CreationAttempt) => encodeFunctionData({ abi: balancerFactoryAbi, functionName: 'createBalancer',
  args: [a.salt, { ...a.config, target: BigInt(a.config.target), mintFeeCap: BigInt(a.config.mintFeeCap) },
    a.curated.map(n => ({ ...n, tokenId: BigInt(n.tokenId), base: BigInt(n.base) }))] });
const isCreationTransaction = (a: CreationAttempt, t: Transaction) => sameAddress(t.from, a.creator)
  && sameAddress(t.to ?? undefined, a.factory) && t.input === creationInput(a) && t.value === BigInt(a.value);

function retainTransaction(a: CreationAttempt, t: Transaction, remember: Remember): CreationAttempt {
  if (!sameAddress(t.from, a.creator) || (a.nonce !== undefined ? t.nonce !== a.nonce
    : t.hash !== (a.submittedHash ?? a.hash) || !isCreationTransaction(a, t))) return a;
  const next = { ...a, submittedHash: a.submittedHash ?? a.hash, hash: a.nonce === undefined ? a.hash : t.hash, nonce: t.nonce };
  if (next.hash !== a.hash || next.nonce !== a.nonce || next.submittedHash !== a.submittedHash) remember(next, a);
  return next;
}

/** Creation-only submission tracking. A failed lookup must never turn into another wallet submission. */
export async function submitCreation(a: CreationAttempt, write: (beforeWallet: () => void) => Promise<Hash>, tracking: {
  existing: () => CreationAttempt | undefined;
  store: Remember;
  reject: (attempt: CreationAttempt) => void;
}, pub?: CreationClient): Promise<Hash> {
  if (tracking.existing()) throw new Error('An earlier creation still needs confirmation.');
  try {
    if (pub) a = { ...a, fromBlock: String(await pub.getBlockNumber({ cacheTime: 0 })) };
    const hash = await write(() => {
      if (tracking.existing()) throw new Error('An earlier creation still needs confirmation.');
      tracking.store(a);
    });
    const submitted = { ...a, hash, submittedHash: hash };
    tracking.store(submitted, a);
    a = submitted;
    const transaction = await pub?.getTransaction({ hash }).catch(() => undefined);
    if (transaction) retainTransaction(a, transaction, tracking.store);
    return hash;
  } catch (error) {
    if (creationNotSubmitted(error)) tracking.reject(a);
    throw error;
  }
}

/** Locate a mined nonce consumer even when the node dropped the original before a reload. */
async function consumedTransaction(pub: CreationClient, a: CreationAttempt, blockNumber: bigint) {
  if (a.nonce === undefined || await pub.getTransactionCount({ address: a.creator, blockNumber }) <= a.nonce) return;
  let low = BigInt(a.fromBlock ?? 0), high = blockNumber;
  if (low > high || await pub.getTransactionCount({ address: a.creator, blockNumber: low }) > a.nonce) low = 0n;
  // Standard historical RPCs also work without eth_getTransactionBySenderAndNonce. A consumed nonce alone is not proof.
  while (low < high) {
    const middle = (low + high) / 2n;
    if (await pub.getTransactionCount({ address: a.creator, blockNumber: middle }) > a.nonce) high = middle;
    else low = middle + 1n;
  }
  const block = await pub.getBlock({ blockNumber: low, includeTransactions: true });
  return block.transactions.find(t => sameAddress(t.from, a.creator) && t.nonce === a.nonce);
}

/** Only verified factory/pool state establishes creation, never a successful cancellation receipt. */
export async function waitForCreation(pub: CreationClient & Pick<PublicClient, 'waitForTransactionReceipt'>,
  a: CreationAttempt, context: CreationContext, remember: Remember, timeout = 15_000): Promise<CreationOutcome> {
  if (!creationContextMatches(a, context) || await pub.getChainId() !== a.chainId) return 'context';
  if (a.hash && a.nonce === undefined) {
    const transaction = await pub.getTransaction({ hash: a.submittedHash ?? a.hash }).catch(() => undefined);
    if (transaction) a = retainTransaction(a, transaction, remember);
  }
  const receipt = await pub.waitForTransactionReceipt({ hash: a.hash!, timeout,
    ...(a.nonce === undefined ? {} : { replacement: { from: a.creator, nonce: a.nonce } }),
    onReplaced: ({ replacedTransaction, transaction }) => {
      a = retainTransaction(a, replacedTransaction, remember);
      a = retainTransaction(a, transaction, remember);
    },
  });
  if (!sameAddress(receipt.from, a.creator)) return 'unknown';
  if (receipt.transactionHash !== a.hash) {
    const next = { ...a, submittedHash: a.submittedHash ?? a.hash, hash: receipt.transactionHash };
    remember(next, a);
    a = next;
  }
  return recoverCreation(pub, a, context, remember);
}

/** Receipt availability is independent of success: verify the reviewed pool through real current-state reads first. */
export async function recoverCreation(pub: CreationClient, a: CreationAttempt, context: CreationContext, remember: Remember = () => {}): Promise<CreationOutcome> {
  if (!creationContextMatches(a, context)) return 'context';
  try {
    if (await pub.getChainId() !== a.chainId) return 'context';
    const blockNumber = await pub.getBlockNumber({ cacheTime: 0 });
    const registered = await pub.readContract({ address: a.factory, abi: balancerFactoryAbi, functionName: 'isBalancer', args: [a.predicted], blockNumber });
    if (registered) {
      const read = <T>(functionName: string) => pub.readContract({ address: a.predicted, abi: poolBalancerAbi,
        functionName: functionName as never, blockNumber }) as Promise<T>;
      const [creator, factory, pool, markupBps, creatorRevenueBps, target, mintFeeCap] = await Promise.all([
        read<Address>('creator'), read<Address>('factory'), read<Address>('pool'), read<number>('markupBps'),
        read<number>('creatorRevenueBps'), read<bigint>('target'), read<bigint>('mintFeeCap'),
      ]);
      const owner = await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'owner', blockNumber });
      return sameAddress(creator, a.creator) && sameAddress(factory, a.factory) && sameAddress(owner, a.predicted)
        && Number(markupBps) === a.config.markupBps && Number(creatorRevenueBps) === a.config.creatorRevenueBps
        && target === BigInt(a.config.target) && mintFeeCap === BigInt(a.config.mintFeeCap) ? 'confirmed' : 'mismatch';
    }
    if (!a.hash) return 'unknown';
    if (a.nonce === undefined && a.submittedHash && a.submittedHash !== a.hash) {
      const original = await pub.getTransaction({ hash: a.submittedHash }).catch(() => undefined);
      if (original) a = retainTransaction(a, original, remember);
    }
    let transaction = await pub.getTransaction({ hash: a.hash! }).catch(() => undefined);
    if (transaction) a = retainTransaction(a, transaction, remember);
    let receipt = await pub.getTransactionReceipt({ hash: a.hash! }).catch(() => undefined);
    if (!receipt && a.nonce !== undefined) {
      const consumed = await consumedTransaction(pub, a, blockNumber);
      if (consumed) {
        transaction = consumed;
        a = retainTransaction(a, transaction, remember);
        receipt = await pub.getTransactionReceipt({ hash: a.hash! }).catch(() => undefined);
      }
    }
    if (receipt && sameAddress(receipt.from, a.creator) && receipt.blockNumber <= blockNumber) {
      const canonical = await pub.getBlock({ blockNumber: receipt.blockNumber });
      if (canonical.hash !== receipt.blockHash) return 'unknown';
      if (receipt.status === 'reverted') return 'reverted';
      if (transaction && a.nonce !== undefined && transaction.hash === receipt.transactionHash
        && sameAddress(transaction.from, a.creator) && transaction.nonce === a.nonce && !isCreationTransaction(a, transaction)) {
        return sameAddress(transaction.to ?? undefined, a.creator) && transaction.value === 0n && transaction.input === '0x' ? 'cancelled' : 'replaced';
      }
      return 'unknown';
    }
    return transaction?.blockNumber === null ? 'pending' : 'unknown';
  } catch {
    return 'unknown';
  }
}
