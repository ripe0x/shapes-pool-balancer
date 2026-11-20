import { afterEach, expect, it, vi } from 'vitest';
import { createPublicClient, http } from 'viem';

// The browser wallet is a real local node (WALLET_FALLBACK_RPC, e.g. anvil) behind an EIP-1193 request function; the
// public RPC is unreachable.
const NODE = process.env.WALLET_FALLBACK_RPC;
const node = createPublicClient({ transport: http(NODE ?? 'http://127.0.0.1:1', { retryCount: 0 }) });
const wallet = { request: (args: { method: string; params?: unknown }) => node.request(args as never) };

async function load(chainId: string, withWallet = true) {
  vi.resetModules();
  vi.stubEnv('VITE_CHAIN_ID', chainId);
  vi.stubEnv('VITE_RPC_URL', 'http://127.0.0.1:1');
  if (withWallet) (globalThis as { ethereum?: unknown }).ethereum = wallet;
  return import('./chain');
}
afterEach(() => { vi.unstubAllEnvs(); delete (globalThis as { ethereum?: unknown }).ethereum; });

it.skipIf(!NODE)('reads through the browser wallet when the public RPC fails', async () => {
  const { config } = await load(String(await node.getChainId()));
  expect(await config.getClient().request({ method: 'eth_blockNumber' })).toBe(await node.request({ method: 'eth_blockNumber' }));
});

it.skipIf(!NODE)('refuses wallet reads while the wallet is on another chain', async () => {
  const { walletReads } = await load('1');
  const pub = createPublicClient({ transport: walletReads });
  await expect(pub.getBlockNumber()).rejects.toThrow('Switch your wallet to Ethereum');
});

it('explains the failure when there is no browser wallet to read through', async () => {
  const { walletReads } = await load('1', false);
  await expect(createPublicClient({ transport: walletReads }).getBlockNumber()).rejects.toThrow('open this page in a browser with a wallet');
});
