import { decodeFunctionResult, encodeFunctionData, multicall3Abi, parseAbi, type Abi, type Address, type PublicClient, type Block, type Hex } from 'viem';
import { DENOMS, SHAPES_IN, keeperWorkAt, maxPaymentOf, maxSurchargeOf, paymentBound, restockFeeAt, type Economics } from '../../shared/planner';

export { maxPaymentOf, maxSurchargeOf, type Economics };

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

/** Existing pools quote through Balancer under their effective economics. A pool not created yet has no quote of its
 *  own: its preview is the same in-library formula (KeeperPolicyCalls.reward / restock) evaluated here on the factory's
 *  `economics`, an estimate at the snapshot's basefee. */
export async function policyEconomics(pub: PublicClient, economics: Economics, balancer?: Address, snapshot?: Pick<Block, 'number' | 'baseFeePerGas' | 'timestamp'>) {
  const block = snapshot ?? await pub.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  // A preview bid is a local assumption; only the pool's own quotes promise compensation.
  const gasPrice = baseFee + 50_000_000n;
  const callContext = { blockNumber: block.number!, gasPrice, gasPerRead: 150_000n };
  const work = (d?: number) => keeperWorkAt(baseFee, gasPrice, d);
  const ds = [undefined, ...DENOMS.map((_, d) => d)];
  const restockFees = balancer
    ? await readsAt(pub, DENOMS.map((_, d) => ({ address: balancer, abi: poolQuoteAbi, functionName: 'restockFeeFor', args: [d] })), callContext) as bigint[]
    : DENOMS.map((_, d) => BigInt(SHAPES_IN[d]) * restockFeeAt(baseFee, economics));
  // A failed pool quote leaves keeper costs unknown.
  const keeperQuotes = await (async () => {
    const out = balancer
      ? await readsAt(pub, ds.map((d) => ({ address: balancer, abi: poolQuoteAbi, functionName: 'quoteKeeperReward', args: [work(d)] })), callContext) as bigint[]
      : ds.map((d) => paymentBound(work(d), economics));
    const [reconcile, ...replace] = out;
    return { reconcile, replace };
  })().catch(() => undefined);
  return { economics, policyMaxReward: maxPaymentOf(economics), baseFee, gasPrice, chainTimestamp: block.timestamp, restockFee: restockFees[0], restockFees, keeperQuotes, restockQuoteVerified: balancer !== undefined, policyUnavailable: false };
}

export type PolicyEconomics = Awaited<ReturnType<typeof policyEconomics>>;
