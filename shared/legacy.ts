// Earlier BalancerFactory deployments whose pools stay manageable after the official creation target changed.
// Each one's pools are discovered from its own BalancerCreated logs and called only with the ABI it was deployed
// with (deployments/1.legacy.json), never with the current shared/abi.ts. A factory without a packaged ABI
// (community-v0, which never created a pool) is left to the deployment preflight.
import type { Abi, Address } from 'viem';
import legacy from '../deployments/1.legacy.json';
import type { Economics } from './planner';

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

/** community-v1's fixed enforcement schedule (40ad9dd test/fixtures/keeper-enforcement.json) and V1 restocking, for
 *  reserve previews of its pools. Its contracts also cap each bound by the pool's stored `policyMaxReward`. */
export const legacyEconomics = (policyMaxReward: bigint): Economics => ({
  workFee: 50_000_000_000_000n, maxGas: 6_000_000, overheadGas: 100_000, gasPriceCeiling: 50_000_000_000n,
  priorityAllowance: 100_000_000n, restockGas: 900_000, restockFlat: 200_000_000_000_000n, baseGas: 200_000,
  processGas: 1_800_000, reconcileGas: 150_000, shapeGas: 700_000, prizeGas: 150_000, processGraceBlocks: 0, pausedProcessGraceBlocks: 0,
  paymentCap: policyMaxReward,
});

/** Earlier factories whose pools need community-v1 handling: no economics getter, a keeper policy contract, fixed limits
 *  and the two-argument configure. Pools of later factories (community-v2) expose the current interface less newer
 *  views, so they are managed as current pools; only discovery and the keeper's ABI choice use their entry. */
export const legacyFactory = (factory: string | undefined): LegacyFactory | undefined =>
  factory === undefined ? undefined : LEGACY_FACTORIES.find((f) => f.factory.toLowerCase() === factory.toLowerCase()
    && !f.poolBalancerAbi.some((x) => x.type === 'function' && x.name === 'effectiveEconomics'));

/** The legacy factories a keeper services: `0` none, unset all, or a comma-separated list of labels (an unknown label
 *  is refused). The creation factory is never listed twice. */
export function selectLegacyFactories(spec: string | undefined, creationFactory: string): LegacyFactory[] {
  const labels = spec === undefined || spec.trim() === '' ? undefined : spec.trim() === '0' ? [] : spec.split(',').map((l) => l.trim());
  const unknown = labels?.filter((l) => !LEGACY_FACTORIES.some((f) => f.label === l)) ?? [];
  if (unknown.length) throw new Error(`LEGACY_FACTORIES names unknown factories: ${unknown.join(', ')}`);
  return LEGACY_FACTORIES.filter((f) => f.factory.toLowerCase() !== creationFactory.toLowerCase() && (!labels || labels.includes(f.label)));
}
