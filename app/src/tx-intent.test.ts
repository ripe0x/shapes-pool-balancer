import { readFileSync } from 'node:fs';
import { createPublicClient, encodeFunctionData, http, parseAbi, type Hash } from 'viem';
import { describe, expect, it } from 'vitest';
import { balancerFactoryAbi } from '../../shared/abi';
import type { CreationAttempt } from './creation';
import { assertTransactionIntent, confirmAction, reviewedIntent, runTransactionSteps, verifyActionReceipt } from './tx';

const from = '0x00000000000000000000000000000000000ce001' as const;
const to = '0x00000000000000000000000000000000000ba1a5' as const;
const abi = parseAbi(['function close()', 'function claimSurplus(uint256 amount,address to)']);
const intent = reviewedIntent({ account: from, chainId: 31337, address: to, abi, functionName: 'close' });

describe('reviewed generic action intent', () => {
  // These are pure comparison inputs, not responses from an external client.
  it('binds the reviewed account, network, encoded arguments and default zero value', () => {
    expect(intent).toEqual({ chainId: 31337, from, to, input: encodeFunctionData({ abi, functionName: 'close' }), value: 0n });
    const claim = reviewedIntent({ account: from, chainId: 1, address: to, abi, functionName: 'claimSurplus', args: [1n, from], value: 2n });
    expect(claim.input).toBe(encodeFunctionData({ abi, functionName: 'claimSurplus', args: [1n, from] }));
    expect(claim.value).toBe(2n);
    expect(() => reviewedIntent({ address: to, abi, functionName: 'close' })).toThrow('account and network');
  });

  it('allows fee-only repricing but rejects cancellation and every changed intent field', () => {
    expect(() => assertTransactionIntent(intent, intent)).not.toThrow();
    for (const transaction of [{ ...intent, to: from, input: '0x' as const }, { ...intent, from: to },
      { ...intent, to: from }, { ...intent, value: 1n }, { ...intent, input: '0x' as const }]) {
      expect(() => assertTransactionIntent(intent, transaction)).toThrow('cancelled or replaced');
    }
  });

  it('stops dependent steps and caller success effects after a confirmation failure', async () => {
    const calls: string[] = [];
    // Existing real submitted hash; program callbacks do not emulate a wallet or supply RPC answers.
    const hash: Hash = '0x5a951cae3a12f7732c9df85fedad7d929520c65fe9023144db21e3127425794a';
    for (const reason of ['cancelled', 'changed intent', 'reverted', 'unverified', 'timeout']) {
      calls.length = 0;
      await expect(runTransactionSteps('Batch', [
        ['Close', async () => { calls.push('first'); return hash; }],
        ['Dependent action', async () => { calls.push('dependent'); return undefined; }],
      ], (name) => { calls.push(name); }, async () => { throw new Error(reason); })
        .then(() => { calls.push('success effect'); })).rejects.toThrow(reason);
      expect(calls).toEqual(['Close', 'first']);
    }
  });

  it('keeps skipped and independently verified creation steps out of generic confirmation', async () => {
    const calls: string[] = [];
    await runTransactionSteps('Create', [async () => { calls.push('creation verified by its own path'); return undefined; }],
      () => undefined, async () => { throw new Error('generic confirmation must not run'); });
    expect(calls).toEqual(['creation verified by its own path']);
  });
});

const rpc = process.env.ACTION_CONFIRMATION_RPC;
it.skipIf(!rpc)('verifies actual recorded local replacement receipts without accepting cancellation or a real revert', async () => {
  expect(rpc).toBe('http://127.0.0.1:18795');
  const records = JSON.parse(readFileSync('docs/verification/creation-replacement/transactions.json', 'utf8')).records as {
    original?: CreationAttempt; replacementHash?: Hash;
  }[];
  const pub = createPublicClient({ transport: http(rpc, { retryCount: 0 }), cacheTime: 0 });
  expect(await pub.getChainId()).toBe(31337);
  let successful = 0, reverted = 0, cancelled = 0;
  for (const record of records.filter(r => r.original && r.replacementHash)) {
    const a = record.original!;
    const reviewed = reviewedIntent({ account: a.creator, chainId: a.chainId, address: a.factory, abi: balancerFactoryAbi,
      functionName: 'createBalancer', args: [a.salt, { ...a.config, target: BigInt(a.config.target), mintFeeCap: BigInt(a.config.mintFeeCap) },
        a.curated.map(n => ({ ...n, tokenId: BigInt(n.tokenId), base: BigInt(n.base) }))], value: BigInt(a.value) });
    const receipt = await pub.getTransactionReceipt({ hash: record.replacementHash! });
    const transaction = await pub.getTransaction({ hash: receipt.transactionHash });
    if (receipt.status === 'reverted') {
      await expect(confirmAction(pub, record.replacementHash!, reviewed)).rejects.toThrow('reverted'); reverted++;
    } else if (transaction.input !== reviewed.input || transaction.to?.toLowerCase() !== reviewed.to.toLowerCase() || transaction.value !== reviewed.value) {
      await expect(confirmAction(pub, record.replacementHash!, reviewed)).rejects.toThrow('cancelled or replaced'); cancelled++;
    } else {
      await confirmAction(pub, record.replacementHash!, reviewed); successful++;
      await expect(verifyActionReceipt(pub, receipt, { ...reviewed, chainId: 1 })).rejects.toThrow('network does not match');
      // Off-chain failure injection supplies no successful external answers.
      await expect(verifyActionReceipt({ getChainId: () => pub.getChainId(), getTransaction: async () => { throw new Error('RPC unavailable'); } }, receipt, reviewed))
        .rejects.toThrow('unverified');
    }
  }
  expect(successful).toBeGreaterThan(0); expect(reverted).toBeGreaterThan(0); expect(cancelled).toBeGreaterThan(0);
});
