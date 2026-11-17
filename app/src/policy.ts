import { parseAbi, type Address, type PublicClient } from 'viem';
import { DENOMS, SHAPES_IN, keeperWorkAt, paymentBound, settingsFrom } from '../../shared/planner';

export const policyAbi = parseAbi([
  'function interfaceVersion() view returns (uint256)',
  'function version() view returns (uint256)',
  'function maxReward() view returns (uint256)',
  'function quoteRestock(uint8 denomination,uint256 shapeUnits,uint256 baseFee) view returns (uint256)',
  'function quoteReward((uint256 measuredGas,uint256 gasPrice,uint256 baseFee,uint256 reconciledDraws,uint256 listedShapeUnits,uint256 listedPrizes,uint256 processedDraws) work) view returns (uint256)',
]);
const displayAbi = parseAbi(['function settings() view returns ((uint64 maxGasPrice,uint64 priorityCap,uint64 incentive,uint64 restockFlat,uint32 maxGas,uint32 overheadGas,uint32 restockGas,uint32 maxPrizes))']);

/** Informational quotes, pinned together. Execution always simulates the pool's immutable checks again. */
export async function policyEconomics(pub: PublicClient, policy: Address, cachedMaximum?: bigint) {
  const block = await pub.getBlock();
  const at = { address: policy, blockNumber: block.number! };
  const baseFee = block.baseFeePerGas ?? 0n;
  const [version, declaredMaximum, settings] = await Promise.all([
    pub.readContract({ ...at, abi: policyAbi, functionName: 'version' }).catch(() => undefined),
    cachedMaximum === undefined ? pub.readContract({ ...at, abi: policyAbi, functionName: 'maxReward' }) : Promise.resolve(cachedMaximum),
    pub.readContract({ ...at, abi: displayAbi, functionName: 'settings' }).then(settingsFrom).catch(() => undefined),
  ]);
  const maxReward = cachedMaximum ?? declaredMaximum;
  if (settings) settings.maxPrizes = 1_000;
  // Metadata never defines a pool's reserve or payout. A future policy need not support the linear display capability.
  const gasPrice = baseFee + (settings?.priorityCap ?? 50_000_000n);
  const quote = (d?: number) => {
    const work = keeperWorkAt(baseFee, gasPrice, d);
    const bound = paymentBound(work, maxReward);
    return pub.readContract({ ...at, abi: policyAbi, functionName: 'quoteReward', args: [work] })
      .then((reward) => reward < bound ? reward : bound);
  };
  const [restockFees, keeperQuotes] = await Promise.all([
    Promise.all(DENOMS.map((_, d) => pub.readContract({ ...at, abi: policyAbi, functionName: 'quoteRestock', args: [d, BigInt(SHAPES_IN[d]), baseFee] }))),
    Promise.all([quote(), ...DENOMS.map((_, d) => quote(d))]).
      then(([reconcile, ...replace]) => ({ reconcile, replace })).catch(() => undefined),
  ]);
  if (restockFees.some((fee, d) => fee > BigInt(SHAPES_IN[d]) * 102_000_000_000_000_000n)) {
    throw new Error('Policy surcharge exceeds the pool limit');
  }
  return { version, policyMaxReward: maxReward, settings, baseFee, gasPrice, chainTimestamp: block.timestamp, restockFee: restockFees[0], restockFees, keeperQuotes, policyUnavailable: false };
}

export type PolicyEconomics = Awaited<ReturnType<typeof policyEconomics>>;
