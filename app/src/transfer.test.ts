import { expect, it } from 'vitest';
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hash } from 'viem';
import { transferKey, transferUnresolved } from './tx';

it('keys a pending transfer by chain, sender and contract, ignoring address case', () => {
  const a = { chainId: 1, from: '0x00000000000000000000000000000000000000aA' as Address, to: '0x00000000000000000000000000000000000000Bb' as Address };
  expect(transferKey(a)).toBe(transferKey({ ...a, from: a.from.toLowerCase() as Address, to: a.to.toUpperCase().replace('0X', '0x') as Address }));
  expect(transferKey(a)).not.toBe(transferKey({ ...a, chainId: 31337 }));
});

const forkRpc = process.env.TRANSFER_RPC;
// Local fork only (chain 31337), with automine paused so a real ETH transfer stays in the mempool. The check reads only the transaction and the
// sender's nonce, so a transfer to the sender's own address exercises it without fork state reads upstream. Every answer comes from
// that node.
it.skipIf(!forkRpc || !process.env.TRANSFER_FROM)('blocks a second transfer while the first is unmined, and releases it once mined or its nonce is used', async () => {
  const pub = createPublicClient({ transport: http(forkRpc, { retryCount: 0 }), cacheTime: 0 });
  expect(await pub.getChainId()).toBe(31337);
  // An account the fork already holds (TRANSFER_FROM, with ETH), so no upstream state read is needed.
  const from = process.env.TRANSFER_FROM as Address;
  const rpc = (method: string, params: unknown[]) => pub.request({ method: method as never, params: params as never });
  await rpc('anvil_impersonateAccount', [from]);
  const wallet = createWalletClient({ account: from, transport: http(forkRpc, { retryCount: 0 }) });
  await rpc('evm_setAutomine', [false]);
  try {
    const nonce = await pub.getTransactionCount({ address: from, blockTag: 'pending' });
    const hash = await wallet.sendTransaction({ to: from, value: parseEther('0.001'), chain: null, gas: 21_000n });
    const sent = { hash, chainId: 31337, from, to: from, nonce };
    expect(await transferUnresolved(pub, sent)).toBe(true);
    // A hash the node never saw, with an unused nonce: still unresolved, since the wallet may yet broadcast it.
    const unknown = { ...sent, hash: `0x${'ab'.repeat(32)}` as Hash };
    expect(await transferUnresolved(pub, unknown)).toBe(true);

    await rpc('evm_mine', []);
    expect((await pub.getTransactionReceipt({ hash })).status).toBe('success');
    expect(await transferUnresolved(pub, sent)).toBe(false);
    // The unseen hash's nonce is now used by the mined transfer, so it can never mine.
    expect(await transferUnresolved(pub, unknown)).toBe(false);
  } finally {
    await rpc('evm_setAutomine', [true]);
    await rpc('anvil_stopImpersonatingAccount', [from]);
  }
}, 120_000);

it('throws instead of permitting a transfer when the node cannot answer', async () => {
  const pub = createPublicClient({ transport: http('http://127.0.0.1:1', { retryCount: 0, timeout: 1_000 }) });
  await expect(transferUnresolved(pub, { hash: `0x${'cd'.repeat(32)}` as Hash, chainId: 1,
    from: '0x00000000000000000000000000000000000d0e02', to: '0x00000000000000000000000000000000000d0e03', nonce: 0 })).rejects.toThrow();
});
