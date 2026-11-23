import { expect, it } from 'vitest';
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hash } from 'viem';
import { transferUnresolved } from '../../app/src/tx';

// Real transactions against the pinned local mainnet fork. No successful RPC answers are supplied by the test.
it('releases an unseen higher-nonce ETH transfer after an earlier nonce mines', async () => {
  const rpc = process.env.TRANSFER_RPC;
  if (!rpc) throw new Error('TRANSFER_RPC must name this audit’s local fork');
  const pub = createPublicClient({ transport: http(rpc, { retryCount: 0 }), cacheTime: 0 });
  expect(await pub.getChainId()).toBe(31337);
  const from = '0x00000000000000000000000000000000000d0e03' as Address;
  const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address;
  const req = (method: string, params: unknown[]) => pub.request({ method: method as never, params: params as never });
  await req('anvil_setBalance', [from, '0x8ac7230489e80000']);
  await req('anvil_impersonateAccount', [from]);
  const wallet = createWalletClient({ account: from, transport: http(rpc, { retryCount: 0 }) });
  await req('evm_setAutomine', [false]);
  try {
    const preWalletNonce = await pub.getTransactionCount({ address: from, blockTag: 'pending' });
    const beforeWeth = await pub.readContract({ address: weth, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [from] });
    const futureHash = await wallet.sendTransaction({ to: weth, value: parseEther('0.01'), nonce: preWalletNonce + 2,
      gas: 100_000n, chain: null });
    const pending = { hash: futureHash, chainId: 31337, from, to: weth, nonce: preWalletNonce };
    expect((await pub.getTransaction({ hash: futureHash })).nonce).toBe(preWalletNonce + 2);
    expect(await transferUnresolved(pub, pending)).toBe(true);

    // Mine an unrelated earlier nonce; the higher-nonce ETH transfer remains in the real mempool.
    await wallet.sendTransaction({ to: from, value: 0n, nonce: preWalletNonce, gas: 21_000n, chain: null });
    await req('evm_mine', []);
    expect(await pub.getTransactionCount({ address: from, blockTag: 'latest' })).toBe(preWalletNonce + 1);
    expect((await pub.getTransaction({ hash: futureHash })).blockNumber).toBeNull();

    // The external read for a pending hash fails as TransactionNotFoundError. The nonce answer is still from the node.
    // This is the permitted off-chain service-failure injection, never a fabricated successful service answer.
    const missingHash = new Error('pending hash unavailable');
    missingHash.name = 'TransactionNotFoundError';
    const partialRpc = { getTransaction: async () => { throw missingHash; }, getTransactionCount: pub.getTransactionCount };
    expect(await transferUnresolved(partialRpc as never, pending)).toBe(false);

    const second = await wallet.sendTransaction({ to: weth, value: parseEther('0.01'), nonce: preWalletNonce + 1,
      gas: 100_000n, chain: null });
    await req('evm_mine', []);
    expect((await pub.getTransactionReceipt({ hash: second })).status).toBe('success');
    expect((await pub.getTransactionReceipt({ hash: futureHash })).status).toBe('success');
    expect((await pub.readContract({ address: weth, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [from] })) - beforeWeth).toBe(parseEther('0.02'));
  } finally {
    await req('evm_setAutomine', [true]);
    await req('anvil_stopImpersonatingAccount', [from]);
  }
}, 120_000);

it('holds a transfer through same-nonce speed-up or cancel and releases after replacement mines', async () => {
  const rpc = process.env.TRANSFER_RPC;
  if (!rpc) throw new Error('TRANSFER_RPC must name this audit’s local fork');
  const pub = createPublicClient({ transport: http(rpc, { retryCount: 0 }), cacheTime: 0 });
  const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address;
  const abi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
  const req = (method: string, params: unknown[]) => pub.request({ method: method as never, params: params as never });
  for (const [tail, cancel] of [['04', false], ['05', true]] as const) {
    const from = `0x00000000000000000000000000000000000d0e${tail}` as Address;
    await req('anvil_setBalance', [from, '0x8ac7230489e80000']);
    await req('anvil_impersonateAccount', [from]);
    const wallet = createWalletClient({ account: from, transport: http(rpc, { retryCount: 0 }) });
    await req('evm_setAutomine', [false]);
    try {
      const nonce = await pub.getTransactionCount({ address: from, blockTag: 'pending' });
      const before = await pub.readContract({ address: weth, abi, functionName: 'balanceOf', args: [from] });
      const first = await wallet.sendTransaction({ to: weth, value: parseEther('0.01'), nonce,
        gas: 100_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, chain: null });
      const pending = { hash: first, chainId: 31337, from, to: weth, nonce };
      expect(await transferUnresolved(pub, pending)).toBe(true);
      const replacement = await wallet.sendTransaction({ to: cancel ? from : weth,
        value: cancel ? 0n : parseEther('0.01'), nonce, gas: 100_000n,
        maxFeePerGas: 4_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n, chain: null });
      expect(await transferUnresolved(pub, pending)).toBe(true);
      await req('evm_mine', []);
      expect((await pub.getTransactionReceipt({ hash: replacement })).status).toBe('success');
      expect(await transferUnresolved(pub, pending)).toBe(false);
      const after = await pub.readContract({ address: weth, abi, functionName: 'balanceOf', args: [from] });
      expect(after - before).toBe(cancel ? 0n : parseEther('0.01'));
    } finally {
      await req('evm_setAutomine', [true]);
      await req('anvil_stopImpersonatingAccount', [from]);
    }
  }
}, 120_000);
