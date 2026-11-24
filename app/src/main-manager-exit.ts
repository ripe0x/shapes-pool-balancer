import { decodeFunctionData, encodeFunctionData, parseAbi, type Abi, type Address, type PublicClient } from 'viem';
import { fwaV2Abi, packManagerAbi } from '../../shared/main-pool-abi';
import { readManager, type Manager } from './main-pool';
import { checkExitSpend, exitBatches, type ExitCall, type ExitReview, type ExitSpend, type SavedExitSpend } from './main-pool-exit';
import { prepareWrite, reviewedIntent, type TransactionIntent } from './tx';

export const managerQueueAbi = parseAbi(['function processAcquisitions(uint256 maxCount) returns (uint256 processed)']);
export const managerExitSpendKey = (chainId: number, manager: Address, owner: Address) =>
  `main-manager-exit:${chainId}:${manager.toLowerCase()}:${owner.toLowerCase()}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
type ExitManager = Pick<Manager, 'manager' | 'fwa' | 'owner' | 'exiting' | 'balance' | 'book'>;

export function assertManagerExitOwner(actual: Address, owner: Address) {
  if (!same(actual, owner)) throw new Error('The connected wallet does not own this manager.');
}

/** Owner-funded closeout never consults keeper economics or prices pooled holder shares. */
export function managerExitCalls(m: ExitManager, owner: Address, queueBlocked = false): ExitCall[] {
  assertManagerExitOwner(m.owner, owner);
  if (!m.exiting) return [{ label: 'Start owner-paid manager closeout', functionName: 'setExiting', args: [true] }];
  const assets = m.book.openCount > 0n || m.book.idle > 0 || m.book.recovery > 0 || m.book.pendingReceipts > 0n;
  if (!assets && m.book.credit === 0n && m.balance === 0n) return [];
  const calls: ExitCall[] = [];
  const batches = exitBatches(m.book.ids);
  if (m.book.openCount > 0n || m.book.pendingReceipts > 0n) {
    for (const ids of batches.length ? batches : [[]]) calls.push({ label: 'Reconcile bounded manager settlement', functionName: 'recover', args: [ids, m.book.witness ?? 0n] });
  }
  if (m.book.idle > 0 || m.book.recovery > 0) calls.push({ label: 'Redeem manager packs to ETH', functionName: 'recoverLiquidate', args: [16n] });
  for (const ids of batches) calls.push({ label: 'Unlist a bounded manager batch', functionName: 'recoverUnlist', args: [ids] });
  if (queueBlocked && m.book.openCount > 0n) calls.push({ label: 'Process a bounded FWA request queue', functionName: 'processAcquisitions', args: [16n], target: m.fwa });
  if (!assets && m.book.credit > 0n) calls.push({ label: 'Collect manager FWA earnings', functionName: 'harvest', args: [[], 0n] });
  if (!assets && m.book.credit === 0n && m.balance > 0n) calls.push({ label: 'Withdraw all manager ETH to owner', functionName: 'withdraw', args: [owner, m.balance] });
  return calls;
}

/** Also applied to durable unknown/replacement intents; no arbitrary third-party target is accepted. */
export function assertManagerExitIntent(manager: Address, owner: Address, fwa: Address | undefined,
  intent: Pick<TransactionIntent, 'from' | 'to' | 'input' | 'value'>) {
  if (!same(intent.from, owner) || intent.value !== 0n) throw new Error('Manager closeout must use its owner and send no ETH.');
  if (!same(intent.to, manager)) {
    const queueInput = encodeFunctionData({ abi: managerQueueAbi, functionName: 'processAcquisitions', args: [16n] });
    if (!fwa || !same(intent.to, fwa) || intent.input !== queueInput) throw new Error('Manager closeout target is not its bounded FWA queue operation.');
    return;
  }
  const decoded = decodeFunctionData({ abi: packManagerAbi, data: intent.input });
  const args = decoded.args as readonly unknown[];
  const ids = (value: unknown) => Array.isArray(value) && value.length <= 16 && value.every((id) => typeof id === 'bigint' && id >= 0n);
  const valid = decoded.functionName === 'setExiting' ? args.length === 1 && args[0] === true
    : decoded.functionName === 'recover' ? args.length === 2 && ids(args[0]) && typeof args[1] === 'bigint'
    : decoded.functionName === 'recoverUnlist' ? args.length === 1 && ids(args[0])
    : decoded.functionName === 'recoverLiquidate' ? args.length === 1 && typeof args[0] === 'bigint' && args[0] > 0n && args[0] <= 16n
    : decoded.functionName === 'harvest' ? args.length === 2 && ids(args[0]) && args[1] === 0n
    : decoded.functionName === 'withdraw' ? args.length === 2 && typeof args[0] === 'string' && same(args[0], owner) && typeof args[1] === 'bigint' && args[1] > 0n
    : false;
  if (!valid) throw new Error('The manager closeout calldata does not match an owner-paid bounded exit step.');
}

export async function validateManagerExitIntent(pub: PublicClient, manager: Address, owner: Address,
  intent: Pick<TransactionIntent, 'from' | 'to' | 'input' | 'value'>, checkOwner = false) {
  const currentOwner = checkOwner ? await pub.readContract({ address: manager, abi: packManagerAbi, functionName: 'owner' }) : undefined;
  if (currentOwner) assertManagerExitOwner(currentOwner, owner);
  const fwa = same(intent.to, manager) ? undefined : await pub.readContract({ address: manager, abi: packManagerAbi, functionName: 'fwa' });
  assertManagerExitIntent(manager, owner, fwa, intent);
}

export async function validateManagerExitPending(pub: PublicClient, saved: SavedExitSpend) {
  const pending = saved.pending;
  if (pending) await validateManagerExitIntent(pub, saved.vault, saved.holder, {
    from: saved.holder, to: pending.to ?? saved.vault, input: pending.input, value: BigInt(pending.value),
  });
}

export async function requireManagerQueueProgress(pub: PublicClient, prepared: Record<string, unknown>) {
  const result = await pub.simulateContract(prepared as never);
  if (typeof result.result !== 'bigint' || result.result <= 0n) throw new Error('FWA queue processing must wait for randomness or the real request deadline.');
}

export async function reviewManagerExit(pub: PublicClient, manager: Address, owner: Address, spend: ExitSpend): Promise<ExitReview> {
  const m = await readManager(pub, manager);
  assertManagerExitOwner(m.owner, owner);
  const queued = m.book.openCount > 0n ? await pub.readContract({ address: m.fwa, abi: fwaV2Abi, functionName: 'unsettledAcquisitionCount', blockNumber: m.blockNumber }) : 0n;
  const candidates = managerExitCalls(m, owner, queued > 0n);
  if (!candidates.length) return { done: true };
  let spendingFailure: Error | undefined;
  for (const call of candidates) {
    try {
      const prepared = await prepareWrite(pub, owner, { address: call.target ?? manager,
        abi: (call.target ? managerQueueAbi : packManagerAbi) as Abi, functionName: call.functionName, args: call.args, value: 0n });
      assertManagerExitIntent(manager, owner, m.fwa, reviewedIntent(prepared));
      if (call.target) await requireManagerQueueProgress(pub, prepared);
      if (prepared.gas > 16777216n) throw new Error('The estimated transaction exceeds the network gas limit.');
      const maximumDebit = checkExitSpend(spend, prepared.gas, prepared.maxFeePerGas, 0n);
      const block = await pub.getBlock({ blockNumber: m.blockNumber });
      const price = block.baseFeePerGas === null ? prepared.maxFeePerGas
        : block.baseFeePerGas + prepared.maxPriorityFeePerGas < prepared.maxFeePerGas ? block.baseFeePerGas + prepared.maxPriorityFeePerGas : prepared.maxFeePerGas;
      return { done: false, call, prepared, maximumDebit, expectedWalletGas: prepared.gas * 10n / 13n * price,
        configHash: m.configHash, reviewedBlock: m.blockNumber, reviewedLimit: spend.limit };
    } catch (e) {
      if (e instanceof Error && e.message.includes('spending limit')) spendingFailure = e;
    }
  }
  if (spendingFailure) throw spendingFailure;
  throw new Error('No bounded manager exit step can execute yet. Wait for FWA randomness, its request deadline or crown exit delay, or refresh for the next inventory page.');
}
