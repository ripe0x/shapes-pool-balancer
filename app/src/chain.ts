import { createConfig, http } from 'wagmi';
import { injected, mock } from 'wagmi/connectors';
import { defineChain, type Address } from 'viem';
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
export const ETHERSCAN = (a: string) => `https://etherscan.io/address/${a}`;

export const config = createConfig({
  chains: [chain],
  // Local fork only: an unlocked anvil account signs through the node. Never enabled on mainnet.
  connectors: chainId === 31337 && import.meta.env.VITE_DEV_ACCOUNT
    ? [injected(), mock({ accounts: [import.meta.env.VITE_DEV_ACCOUNT as Address] })]
    : [injected()],
  transports: { [chain.id]: http(rpcUrl) } as Record<number, ReturnType<typeof http>>,
});
