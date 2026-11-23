import { decodeFunctionResult, encodeFunctionData, multicall3Abi, parseAbi, type Abi, type Address, type PublicClient, type Block, type Hex } from 'viem';
import { DENOMS, SHAPES_IN, keeperWorkAt, maxPaymentOf, maxSurchargeOf, paymentBound, type Economics } from '../../shared/planner';

export { maxPaymentOf, maxSurchargeOf, type Economics };

const lesser = (a: bigint, b: bigint) => (a < b ? a : b);

const ECONOMICS = '(address policy,uint64 workFee,uint32 maxGas,uint32 overheadGas,uint64 gasPriceCeiling,uint64 priorityAllowance,uint32 restockGas,uint64 restockFlat,uint32 baseGas,uint32 processGas,uint32 reconcileGas,uint32 shapeGas,uint32 prizeGas)';
export const policyAbi = parseAbi([
  'function interfaceVersion() view returns (uint256)',
  'function version() view returns (uint256)',
  `function quoteRestock(uint8 denomination,uint256 shapeUnits,uint256 baseFee,${ECONOMICS} economics) view returns (uint256)`,
  `function quoteReward((uint256 measuredGas,uint256 gasPrice,uint256 baseFee,uint256 reconciledDraws,uint256 listedShapeUnits,uint256 listedPrizes,uint256 processedDraws) work,${ECONOMICS} economics) view returns (uint256)`,
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

/** Existing pools quote through Balancer under their effective economics; a not-yet-created pool has only unverified
 *  direct previews under the factory's `economics`. */
export async function policyEconomics(pub: PublicClient, economics: Economics, balancer?: Address, snapshot?: Pick<Block, 'number' | 'baseFeePerGas' | 'timestamp'>) {
  const block = snapshot ?? await pub.getBlock();
  const policy = economics.policy;
  const at = { address: policy, blockNumber: block.number!, gas: 100_000n };
  const baseFee = block.baseFeePerGas ?? 0n;
  const version = await pub.readContract({ ...at, abi: policyAbi, functionName: 'version' }).catch(() => undefined);
  // A preview bid is a local assumption; only bounded pool quotes promise compensation.
  const gasPrice = baseFee + 50_000_000n;
  const callContext = { blockNumber: block.number!, gasPrice, gasPerRead: 150_000n };
  const restockFees = await readsAt(pub, DENOMS.map((_, d) => balancer
    ? { address: balancer, abi: poolQuoteAbi, functionName: 'restockFeeFor', args: [d] }
    : { address: policy, abi: policyAbi, functionName: 'quoteRestock', args: [d, BigInt(SHAPES_IN[d]), baseFee, economics] }), callContext) as bigint[];
  // An existing pool quotes keeper pay itself. A pool not created yet has no quote of its own: the preview asks the
  // policy directly and applies the pool's bound (KeeperPolicyCalls.reward), an unverified estimate like its restocking
  // fees. Either way a failed quote leaves keeper costs unknown.
  const keeperQuotes = await (async () => {
    const work = (d?: number) => keeperWorkAt(baseFee, gasPrice, d);
    const quote = (d?: number) => balancer
      ? { address: balancer, abi: poolQuoteAbi, functionName: 'quoteKeeperReward', args: [work(d)] }
      : { address: policy, abi: policyAbi, functionName: 'quoteReward', args: [work(d), economics] };
    const ds = [undefined, ...DENOMS.map((_, d) => d)];
    const out = await readsAt(pub, ds.map(quote), callContext) as bigint[];
    const [reconcile, ...replace] = balancer ? out : out.map((q, i) => lesser(q, paymentBound(work(ds[i]), economics)));
    return { reconcile, replace };
  })().catch(() => undefined);
  // A pool enforces its own bound; a direct preview applies the factory economics' derived per-Shape maximum.
  if (!balancer && restockFees.some((fee, d) => fee > BigInt(SHAPES_IN[d]) * maxSurchargeOf(economics))) {
    throw new Error('Policy surcharge exceeds the pool limit');
  }
  return { version, economics, policyMaxReward: maxPaymentOf(economics), baseFee, gasPrice, chainTimestamp: block.timestamp, restockFee: restockFees[0], restockFees, keeperQuotes, restockQuoteVerified: balancer !== undefined, policyUnavailable: false };
}

export type PolicyEconomics = Awaited<ReturnType<typeof policyEconomics>>;
