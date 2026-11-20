import { decodeFunctionResult, encodeFunctionData, multicall3Abi, parseAbi, type Abi, type Address, type PublicClient, type Block, type Hex } from 'viem';
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

const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
type Read = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };

/** Several reads in one eth_call through Multicall3, at a pinned block and with an explicit gas price. The gas price
 *  matters: nodes run eth_call with block.basefee = 0 unless one is given, and these quotes read block.basefee. One
 *  request instead of one per read keeps the dashboard under public-RPC burst limits. Any failing read fails all. */
export async function readsAt(pub: PublicClient, reads: Read[], at: { blockNumber: bigint; gasPrice: bigint; gasPerRead: bigint }) {
  const data = encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3', args: [reads.map((r) => ({
    target: r.address, allowFailure: false,
    callData: encodeFunctionData({ abi: r.abi, functionName: r.functionName, args: r.args } as never),
  }))] });
  const { data: out } = await pub.call({ to: MULTICALL3, data, blockNumber: at.blockNumber, gasPrice: at.gasPrice, gas: at.gasPerRead * BigInt(reads.length) + 100_000n });
  const results = decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data: out! }) as readonly { success: boolean; returnData: Hex }[];
  return results.map((r, i) => decodeFunctionResult({ abi: reads[i].abi, functionName: reads[i].functionName, data: r.returnData } as never) as unknown);
}

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
  const callContext = { blockNumber: block.number!, gasPrice, gasPerRead: 150_000n };
  const restockFees = await readsAt(pub, DENOMS.map((_, d) => balancer
    ? { address: balancer, abi: poolQuoteAbi, functionName: 'restockFeeFor', args: [d] }
    : { address: policy, abi: policyAbi, functionName: 'quoteRestock', args: [d, BigInt(SHAPES_IN[d]), baseFee] }), callContext) as bigint[];
  // A policy's direct response is never a pool payment offer. Older pools without
  // this informational view keep costs unknown, while newer pools apply their own bounds.
  const keeperQuotes = balancer ? await (async () => {
    const quote = (d?: number) => ({ address: balancer, abi: poolQuoteAbi, functionName: 'quoteKeeperReward', args: [keeperWorkAt(baseFee, gasPrice, d)] });
    const [reconcile, ...replace] = await readsAt(pub, [quote(), ...DENOMS.map((_, d) => quote(d))], callContext) as bigint[];
    return { reconcile, replace };
  })().catch(() => undefined) : undefined;
  if (restockFees.some((fee, d) => fee > BigInt(SHAPES_IN[d]) * 102_000_000_000_000_000n)) {
    throw new Error('Policy surcharge exceeds the pool limit');
  }
  return { version, policyMaxReward: maxReward, baseFee, gasPrice, chainTimestamp: block.timestamp, restockFee: restockFees[0], restockFees, keeperQuotes, restockQuoteVerified: balancer !== undefined, policyUnavailable: false };
}

export type PolicyEconomics = Awaited<ReturnType<typeof policyEconomics>>;
