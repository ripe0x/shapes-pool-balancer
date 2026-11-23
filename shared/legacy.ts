// Earlier BalancerFactory deployments whose pools stay manageable after the official creation target changed.
// Each one's pools are discovered from its own BalancerCreated logs and called only with the ABI it was deployed
// with (deployments/1.legacy.json), never with the current shared/abi.ts. A factory without a packaged ABI
// (community-v0, which never created a pool) is left to the deployment preflight.
import type { Abi, Address } from 'viem';
import legacy from '../deployments/1.legacy.json';

export interface LegacyFactory {
  label: string;
  factory: Address;
  fromBlock: bigint;
  poolBalancerAbi: Abi;
  balancerFactoryAbi: Abi;
}

const abis = legacy.abis as Record<string, { poolBalancer: unknown; balancerFactory: unknown }>;
export const LEGACY_FACTORIES: readonly LegacyFactory[] = legacy.legacyFactories.flatMap((f) => f.abiName && abis[f.abiName]
  ? [{ label: f.label, factory: f.balancerFactory as Address, fromBlock: BigInt(f.deploymentBlock),
    poolBalancerAbi: abis[f.abiName].poolBalancer as Abi, balancerFactoryAbi: abis[f.abiName].balancerFactory as Abi }]
  : []);

export const legacyFactory = (factory: string | undefined): LegacyFactory | undefined =>
  factory === undefined ? undefined : LEGACY_FACTORIES.find((f) => f.factory.toLowerCase() === factory.toLowerCase());
