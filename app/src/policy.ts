import { parseAbi, type Address, type PublicClient, type Block } from 'viem';
import { DENOMS, SHAPES_IN, keeperWorkAt } from '../../shared/planner';

export const policyAbi = parseAbi([
  'function interfaceVersion() view returns (uint256)',
  'function version() view returns (uint256)',
  'function maxReward() view returns (uint256)',
  'function quoteRestock(uint8 denomination,uint256 shapeUnits,uint256 baseFee) view returns (uint256)',
  'function quoteReward((uint256 measuredGas,uint256 gasPrice,uint256 baseFee,uint256 reconciledDraws,uint256 listedShapeUnits,uint256 listedPrizes,uint256 processedDraws) work) view returns (uint256)',
]);
const poolQuoteAbi = parseAbi([
  'function restockFeeFor(uint8 denomination) view returns (uint256)',
  'function quoteKeeperReward((uint256 measuredGas,uint256 gasPrice,uint256 baseFee,uint256 reconciledDraws,uint256 listedShapeUnits,uint256 listedPrizes,uint256 processedDraws) work) view returns (uint256)',
]);

/** Existing pools quote through Balancer; a not-yet-created pool has only unverified direct previews. */
export async function policyEconomics(pub: PublicClient, policy: Address, cachedMaximum?: bigint, balancer?: Address, snapshot?: Pick<Block, 'number' | 'baseFeePerGas' | 'timestamp'>) {
  const block = snapshot ?? await pub.getBlock();
  const at = { address: policy, blockNumber: block.number!, gas: 100_000n };
  const baseFee = block.baseFeePerGas ?? 0n;
  const [version, declaredMaximum] = await Promise.all([
    pub.readContract({ ...at, abi: policyAbi, functionName: 'version' }).catch(() => undefined),
    cachedMaximum === undefined ? pub.readContract({ ...at, abi: policyAbi, functionName: 'maxReward' }) : Promise.resolve(cachedMaximum),
  ]);
  const maxReward = cachedMaximum ?? declaredMaximum;
  // A preview bid is a local assumption; only bounded pool quotes promise compensation.
  const gasPrice = baseFee + 50_000_000n;
  // viem forwards call parameters through readContract; fees also prevent multicall's caller substitution.
  const callContext = { blockNumber: block.number!, gasPrice, batch: false, gas: 150_000n };
  const restockFees = await Promise.all(DENOMS.map((_, d) => balancer
    ? pub.readContract({ ...callContext, address: balancer, abi: poolQuoteAbi, functionName: 'restockFeeFor', args: [d] })
    : pub.readContract({ ...at, ...callContext, abi: policyAbi, functionName: 'quoteRestock', args: [d, BigInt(SHAPES_IN[d]), baseFee] })));
  // A policy's direct response is never a pool payment offer. Older pools without
  // this informational view keep costs unknown, while newer pools apply their own bounds.
  const keeperQuotes = balancer ? await (async () => {
    const quote = (d?: number) => pub.readContract({ ...callContext, address: balancer,
      abi: poolQuoteAbi, functionName: 'quoteKeeperReward', args: [keeperWorkAt(baseFee, gasPrice, d)] });
    const reconcile = await quote();
    const replace = await Promise.all(DENOMS.map((_, d) => quote(d)));
    return { reconcile, replace };
  })().catch(() => undefined) : undefined;
  if (restockFees.some((fee, d) => fee > BigInt(SHAPES_IN[d]) * 102_000_000_000_000_000n)) {
    throw new Error('Policy surcharge exceeds the pool limit');
  }
  return { version, policyMaxReward: maxReward, baseFee, gasPrice, chainTimestamp: block.timestamp, restockFee: restockFees[0], restockFees, keeperQuotes, restockQuoteVerified: balancer !== undefined, policyUnavailable: false };
}

export type PolicyEconomics = Awaited<ReturnType<typeof policyEconomics>>;
