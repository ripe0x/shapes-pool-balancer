import { expect, it } from 'vitest';
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hash } from 'viem';
import { transferKey, transferState, UNSEEN_HOLD_MS } from './tx';

it('keys a pending transfer by chain, sender and contract, ignoring address case', () => {
  const a = { chainId: 1, from: '0x00000000000000000000000000000000000000aA' as Address, to: '0x00000000000000000000000000000000000000Bb' as Address };
  expect(transferKey(a)).toBe(transferKey({ ...a, from: a.from.toLowerCase() as Address, to: a.to.toUpperCase().replace('0X', '0x') as Address }));
  expect(transferKey(a)).not.toBe(transferKey({ ...a, chainId: 31337 }));
});

// No node is reachable here: a reservation without a hash or nonce is decided without any RPC read.
const offline = createPublicClient({ transport: http('http://127.0.0.1:1', { retryCount: 0, timeout: 1_000 }) });
const parties = { chainId: 1, from: '0x00000000000000000000000000000000000d0e02' as Address, to: '0x00000000000000000000000000000000000d0e03' as Address };

it('a reservation made before the wallet opened blocks until the hold ends', async () => {
  const p = { ...parties, since: 1_000 };
  expect(await transferState(offline, p, 1_000 + UNSEEN_HOLD_MS - 1)).toEqual({ unresolved: true });
  expect(await transferState(offline, p, 1_000 + UNSEEN_HOLD_MS)).toEqual({ unresolved: false });
});

it('throws instead of permitting a transfer when the node cannot answer', async () => {
  await expect(transferState(offline, { ...parties, since: 0, hash: `0x${'cd'.repeat(32)}` as Hash })).rejects.toThrow();
});

const forkRpc = process.env.TRANSFER_RPC;
// Local node only (chain 31337), with automine paused so a real ETH transfer stays in the mempool. Every answer comes
// from that node; transfers go to the sender's own address, so no fork state is read upstream.
it.skipIf(!forkRpc || !process.env.TRANSFER_FROM)('blocks while unmined, learns the real nonce, and survives a lower nonce mining first', async () => {
  const pub = createPublicClient({ transport: http(forkRpc, { retryCount: 0 }), cacheTime: 0 });
  expect(await pub.getChainId()).toBe(31337);
  const from = process.env.TRANSFER_FROM as Address;
  const rpc = (method: string, params: unknown[]) => pub.request({ method: method as never, params: params as never });
  await rpc('anvil_impersonateAccount', [from]);
  const wallet = createWalletClient({ account: from, transport: http(forkRpc, { retryCount: 0 }) });
  await rpc('evm_setAutomine', [false]);
  try {
    const base = { chainId: 31337, from, to: from, since: Date.now() };
    const hash = await wallet.sendTransaction({ to: from, value: parseEther('0.001'), chain: null, gas: 21_000n });
    const sent = { ...base, hash };
    const first = await transferState(pub, sent);
    expect(first.unresolved).toBe(true);
    const own = (await pub.getTransaction({ hash })).nonce;
    expect(first.nonce).toBe(own);

    // A hash the node never showed (the wallet queued it at a higher nonce): mining the lower nonce must not clear it.
    const unseen = { ...base, hash: `0x${'ab'.repeat(32)}` as Hash };
    expect((await transferState(pub, unseen)).unresolved).toBe(true);
    await rpc('evm_mine', []);
    expect((await pub.getTransactionReceipt({ hash })).status).toBe('success');
    expect(await pub.getTransactionCount({ address: from, blockTag: 'latest' })).toBeGreaterThan(own);
    expect((await transferState(pub, unseen)).unresolved).toBe(true);

    expect(await transferState(pub, sent)).toEqual({ unresolved: false });
    // A transfer whose own nonce the node showed earlier, now used by another transaction, can never mine.
    expect((await transferState(pub, { ...unseen, nonce: own })).unresolved).toBe(false);
  } finally {
    await rpc('evm_setAutomine', [true]);
    await rpc('anvil_stopImpersonatingAccount', [from]);
  }
}, 120_000);
