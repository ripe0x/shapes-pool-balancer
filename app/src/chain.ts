import { createConfig, http } from 'wagmi';
import { mock } from 'wagmi/connectors';
import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import { injectedWallet, metaMaskWallet, rabbyWallet, walletConnectWallet } from '@rainbow-me/rainbowkit/wallets';
import { BaseError, custom, defineChain, fallback, type Address, type EIP1193Provider, type Transport } from 'viem';
import { limitConcurrency } from './limit';
import { mainnet } from 'viem/chains';

const chainId = Number(import.meta.env.VITE_CHAIN_ID ?? 1);
const rpcUrl = (import.meta.env.VITE_RPC_URL as string | undefined) ?? 'https://mainnet.gateway.tenderly.co';

export const localFork = defineChain({
  ...mainnet,
  id: 31337,
  name: 'Local mainnet fork',
  rpcUrls: { default: { http: [rpcUrl] } },
});

export const chain = chainId === 31337 ? localFork : mainnet;
export const FACTORY = import.meta.env.VITE_FACTORY as Address;
export const FROM_BLOCK = BigInt(import.meta.env.VITE_FROM_BLOCK ?? 0);
export const FWA_POOL_URL = (pool: string) => `https://pools.fwa.fun/pools/${pool}`;

// WalletConnect (mobile and QR wallets) is offered only when a project ID is configured; browser wallets need none.
const wcProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;
const wallets = connectorsForWallets(
  [{ groupName: 'Wallets', wallets: [metaMaskWallet, rabbyWallet, injectedWallet, ...(wcProjectId ? [walletConnectWallet] : [])] }],
  { appName: 'Shapes Pool Balancer', projectId: wcProjectId ?? 'unset' },
);

// Read-only backup through the injected wallet (MetaMask, Rabby), used only while it is on this dashboard's chain:
// otherwise its answers would describe another network. Wallets serve these reads without a connection prompt.
export const walletReads = custom({
  async request({ method, params }) {
    const wallet = (globalThis as { ethereum?: EIP1193Provider }).ethereum;
    // BaseError keeps this text as the message the page shows; viem wraps any other error as an unknown RPC error.
    if (!wallet) throw new BaseError('The public RPC is busy. Try again in a minute, or open this page in a browser with a wallet.');
    if (Number(await wallet.request({ method: 'eth_chainId' })) !== chain.id) throw new BaseError(`The public RPC is busy. Switch your wallet to ${chain.name} to read through it.`);
    return wallet.request({ method, params } as Parameters<EIP1193Provider['request']>[0]);
  },
}, { retryCount: 0 });

export const config = createConfig({
  chains: [chain],
  // Local fork only: an unlocked anvil account signs through the node. Never enabled on mainnet.
  connectors: chainId === 31337 && import.meta.env.VITE_DEV_ACCOUNT
    ? [...wallets, mock({ accounts: [import.meta.env.VITE_DEV_ACCOUNT as Address] })]
    : wallets,
  // Reads go to the public RPC, at most four in flight. When it refuses (it rate-limits per IP), the browser wallet's
  // own node answers instead. The whole chain retries with backoff (2, 4, 8, 16 s) before a read fails.
  transports: { [chain.id]: fallback([http(rpcUrl, { fetchFn: limitConcurrency(fetch, 4), retryCount: 0 }), walletReads], { retryCount: 4, retryDelay: 1000 }) } as Record<number, Transport>,
  // Reads made together go out as one multicall: a pool reads two values per listing on load (2,200 reads at 1,100).
  batch: { multicall: { batchSize: 16_384 } },
});
