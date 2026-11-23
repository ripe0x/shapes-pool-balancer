import { createPublicClient, custom, http, parseAbi, toFunctionSelector, toHex, type Address } from 'viem';
import { expect, it } from 'vitest';
import { poolBalancerAbi } from '../../shared/abi';
import { DENOMS, SHAPES_IN } from '../../shared/planner';
import { policyEconomics, readsAt } from './policy';

/** Interface v1 of the policy deployed with the legacy (2026-11-22) factory; legacy pools still price with it. */
const legacyPolicyAbi = parseAbi(['function quoteRestock(uint8 denomination,uint256 shapeUnits,uint256 baseFee) view returns (uint256)']);

const rpc = process.env.POLICY_PREVIEW_RPC;
const balancer = process.env.POLICY_PREVIEW_BALANCER as Address | undefined;

// Opt-in reads of a deployed local pool. Every successful answer comes from its real contracts.
it.skipIf(!rpc || !balancer)('reads bounded creator previews without policy settings metadata', async () => {
  const actual = createPublicClient({ transport: http(rpc), cacheTime: 0 });
  const requests: { method: string; params?: unknown }[] = [];
  // Observe the real RPC request envelope; forward every response unchanged.
  const pub = createPublicClient({ transport: custom({ request: async (request) => {
    requests.push(request);
    return actual.transport.request(request);
  } }), cacheTime: 0 });
  expect(await pub.getChainId()).toBe(31337);
  const [economics, maxReward] = await Promise.all([
    pub.readContract({ address: balancer!, abi: poolBalancerAbi, functionName: 'effectiveEconomics' }),
    pub.readContract({ address: balancer!, abi: poolBalancerAbi, functionName: 'policyMaxReward' }),
  ]);
  const costs = await policyEconomics(pub, economics, balancer);
  expect(costs.restockQuoteVerified).toBe(true);
  expect(costs.keeperQuotes).toBeDefined();
  for (const quote of [...costs.keeperQuotes!.replace, costs.keeperQuotes!.reconcile]) {
    expect(quote).toBeGreaterThanOrEqual(0n);
    expect(quote).toBeLessThanOrEqual(maxReward);
  }
  const perShape = await pub.readContract({ address: balancer!, abi: poolBalancerAbi, functionName: 'maxRestockSurchargePerShape' }) as bigint;
  costs.restockFees.forEach((fee, d) => expect(fee).toBeLessThanOrEqual(BigInt(SHAPES_IN[d]) * perShape));
  const settingsSelector = toFunctionSelector('settings()');
  expect(requests.some(request => request.method === 'eth_call' && JSON.stringify(request.params).includes(settingsSelector.slice(2)))).toBe(false);
  expect(costs.restockFees).toHaveLength(DENOMS.length);
  expect(costs.policyMaxReward).toBe(maxReward);
  // Restock fees and keeper quotes each go out as one Multicall3 aggregate3 eth_call carrying the gas price.
  const batches = requests.filter(request => request.method === 'eth_call').map(request => request.params as [{ to?: string; data?: string; gasPrice?: string }, string])
    .filter(([call]) => call.to?.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11' && call.data?.startsWith(toFunctionSelector('aggregate3((address,bool,bytes)[])')));
  expect(batches).toHaveLength(2);
  for (const [call, block] of batches) {
    expect(call.gasPrice).toBe(toHex(costs.gasPrice));
    expect(block).toMatch(/^0x[0-9a-f]+$/);
  }
});

// Failure injection is permitted for off-chain services; no successful answer is fabricated.
it('reports failed policy economics as unavailable instead of substituting V1', async () => {
  const pub = createPublicClient({ transport: custom({ request: async () => { throw new Error('RPC unavailable'); } }, { retryCount: 0 }), cacheTime: 0 });
  const snapshot = { number: 1n, baseFeePerGas: 500_000_000n, timestamp: 1_000n };
  const economics = { policy: '0x0000000000000000000000000000000000000001' as Address, workFee: 20_000_000_000_000n, maxGas: 3_200_000,
    overheadGas: 60_000, gasPriceCeiling: 5_000_000_000n, priorityAllowance: 50_000_000n, restockGas: 910_000, restockFlat: 200_000_000_000_000n,
    baseGas: 200_000, processGas: 1_800_000, reconcileGas: 150_000, shapeGas: 700_000, prizeGas: 150_000,
    processGraceBlocks: 50, pausedProcessGraceBlocks: 10 };
  await expect(policyEconomics(pub, economics, undefined, snapshot)).rejects.toThrow('RPC unavailable');
});

// Opt-in read-only mainnet check: MAINNET_RPC=https://mainnet.gateway.tenderly.co. The deployed KeeperPolicyV1 answers
// the batched quotes exactly as it answers one call each, in a single request, at the real basefee.
it.skipIf(!process.env.MAINNET_RPC)('batches restock quotes into one request with the same answers', async () => {
  const actual = createPublicClient({ transport: http(process.env.MAINNET_RPC), cacheTime: 0 });
  const requests: { method: string }[] = [];
  const pub = createPublicClient({ transport: custom({ request: async (request) => { requests.push(request); return actual.transport.request(request); } }), cacheTime: 0 });
  const policy = '0x13797a6a7CFBfDD3956006f1cAc8Cae749569117' as Address;
  const block = await actual.getBlock();
  const baseFee = block.baseFeePerGas!;
  const at = { blockNumber: block.number!, gasPrice: baseFee + 50_000_000n, gasPerRead: 150_000n };
  const batched = await readsAt(pub, DENOMS.map((_, d) => ({ address: policy, abi: legacyPolicyAbi, functionName: 'quoteRestock', args: [d, BigInt(SHAPES_IN[d]), baseFee] })), at);
  expect(requests).toHaveLength(1);
  const single: bigint[] = [];
  for (let d = 0; d < DENOMS.length; d++) single.push(await actual.readContract({ address: policy, abi: legacyPolicyAbi, functionName: 'quoteRestock', args: [d, BigInt(SHAPES_IN[d]), baseFee], blockNumber: block.number!, gasPrice: at.gasPrice, gas: 150_000n } as never) as bigint);
  expect(batched).toEqual(single);
  // V1: units x (900,000 gas x min(basefee + 0.05 gwei, 5 gwei) + 0.0002 ETH)
  const price = baseFee + 50_000_000n > 5_000_000_000n ? 5_000_000_000n : baseFee + 50_000_000n;
  expect(batched[0]).toBe(BigInt(SHAPES_IN[0]) * (900_000n * price + 200_000_000_000_000n));
}, 120_000);
