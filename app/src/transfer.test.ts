import { expect, it } from 'vitest';
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hash } from 'viem';
import { localTransactionNonce, localTransferContext, transferKey, transferState, UNSEEN_HOLD_MS } from './tx';

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

it('never asks mainnet for Anvil metadata and fails closed when local identity is unavailable', async () => {
  expect(await localTransferContext(offline, 1)).toBeUndefined();
  expect(await localTransactionNonce(offline, 1, parties.from)).toBeUndefined();
  await expect(localTransferContext(offline, 31337)).rejects.toThrow();
});

it('keeps unknown legacy records and mainnet reservations blocked across local instance changes', async () => {
  const instanceId = `0x${'12'.repeat(32)}` as Hash, old = `0x${'34'.repeat(32)}` as Hash;
  const local = { instanceId, retiredHashes: [] };
  expect(await transferState(offline, { ...parties, since: 1000, forkInstanceId: old }, 1001, local)).toEqual({ unresolved: true });
  expect(await transferState(offline, { ...parties, chainId: 31337, since: 1000 }, 1001, local)).toEqual({ unresolved: true });
  expect(await transferState(offline, { ...parties, chainId: 31337, since: 1000, forkInstanceId: instanceId }, 1001, local)).toEqual({ unresolved: true });
  expect(await transferState(offline, { ...parties, chainId: 31337, since: 1000, forkInstanceId: old }, 1001, local)).toEqual({ unresolved: false });
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
    const local = await localTransferContext(pub, 31337);
    expect((await transferState(pub, { ...sent, forkInstanceId: `0x${'56'.repeat(32)}` as Hash }, Date.now(), local)).unresolved).toBe(true);
    const own = (await pub.getTransaction({ hash })).nonce;
    expect(await localTransactionNonce(pub, 31337, from)).toBe(own + 1);
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

const resetRpc = process.env.TRANSFER_RESET_RPC;
it.skipIf(!resetRpc)('uses real Anvil identities and retires only proven old local hashes on the configured instance', async () => {
  expect(resetRpc).toBe('http://127.0.0.1:18559');
  const pub = createPublicClient({ transport: http(resetRpc, { retryCount: 0 }), cacheTime: 0 });
  const original = await localTransferContext(pub, 31337);
  expect(original?.instanceId).toMatch(/^0x[0-9a-f]{64}$/);
  // This exact successful old-fork creation is preserved in the original fork backup, not an RPC fixture.
  const hash = '0xa1b5d34465857b982f9e8e1aeb4a6f0687011522a421fcdd9ca36ae6db4c848a' as Hash;
  const legacy = { ...parties, chainId: 31337, since: Date.now(), hash };
  expect((await transferState(pub, legacy, Date.now(), original)).unresolved).toBe(true);
  const reset = { instanceId: original!.instanceId, retiredHashes: [hash] };
  await expect(localTransferContext(pub, 31337, { ...reset, retiredHashes: ['invalid'] })).rejects.toThrow('Invalid local fork reset record');
  const verified = await localTransferContext(pub, 31337, reset);
  expect((await transferState(pub, legacy, Date.now(), verified)).unresolved).toBe(false);
  expect((await transferState(pub, { ...legacy, chainId: 1 }, Date.now(), verified)).unresolved).toBe(true);
  await pub.request({ method: 'anvil_reset' as never, params: [] as never });
  const fresh = await localTransferContext(pub, 31337, reset);
  expect(fresh!.instanceId).not.toBe(original!.instanceId);
  expect(fresh!.retiredHashes).toEqual([]);
  expect((await transferState(pub, legacy, Date.now(), fresh)).unresolved).toBe(true);
  expect((await transferState(pub, { ...legacy, forkInstanceId: original!.instanceId }, Date.now(), fresh)).unresolved).toBe(false);
});
