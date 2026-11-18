import { BaseError, ChainMismatchError, UserRejectedRequestError, type Address, type Hash, type PublicClient } from 'viem';
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
  config: { markupBps: number; creatorRevenueBps: number; target: string; mintFeeCap: string };
  curated: { collection: Address; tokenId: string; base: string }[];
  value: string;
}

export interface CreationContext { chainId?: number; factory: Address; creator?: Address }
export type CreationOutcome = 'confirmed' | 'reverted' | 'pending' | 'unknown' | 'context' | 'mismatch';
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

/** These wallet/connector failures occur before submission; RPC timeouts never establish a revert. */
export function creationNotSubmitted(error: unknown): boolean {
  const rejected = (cause: unknown) => cause instanceof UserRejectedRequestError || cause instanceof ChainMismatchError
    || cause instanceof ConnectorAccountNotFoundError || cause instanceof ConnectorChainMismatchError
    || cause instanceof ConnectorNotConnectedError || (!!cause && typeof cause === 'object' && 'code' in cause && cause.code === 4001);
  return rejected(error) || (error instanceof BaseError && !!error.walk(rejected));
}

export const canRetryCreation = (outcome: CreationOutcome, a: CreationAttempt, context: CreationContext) =>
  outcome === 'reverted' && creationContextMatches(a, context);

/** Creation-only submission tracking. A failed lookup must never turn into another wallet submission. */
export async function submitCreation(a: CreationAttempt, write: (beforeWallet: () => void) => Promise<Hash>, tracking: {
  existing: () => CreationAttempt | undefined;
  store: (attempt: CreationAttempt) => void;
  reject: (attempt: CreationAttempt) => void;
}): Promise<Hash> {
  if (tracking.existing()) throw new Error('An earlier creation still needs confirmation.');
  try {
    const hash = await write(() => {
      if (tracking.existing()) throw new Error('An earlier creation still needs confirmation.');
      tracking.store(a);
    });
    tracking.store({ ...a, hash });
    return hash;
  } catch (error) {
    if (creationNotSubmitted(error)) tracking.reject(a);
    throw error;
  }
}

type CreationClient = Pick<PublicClient, 'getChainId' | 'getBlockNumber' | 'readContract' | 'getTransactionReceipt' | 'getTransaction'>;

/** Receipt availability is independent of success: verify the reviewed pool through real current-state reads first. */
export async function recoverCreation(pub: CreationClient, a: CreationAttempt, context: CreationContext): Promise<CreationOutcome> {
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
    const receipt = await pub.getTransactionReceipt({ hash: a.hash }).catch(() => undefined);
    if (receipt?.status === 'reverted') return 'reverted';
    const transaction = await pub.getTransaction({ hash: a.hash }).catch(() => undefined);
    return transaction?.blockNumber === null ? 'pending' : 'unknown';
  } catch {
    return 'unknown';
  }
}
