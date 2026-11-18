import { createPublicClient, custom, http, toFunctionSelector, toHex, type Address } from 'viem';
import { expect, it } from 'vitest';
import { poolBalancerAbi } from '../../shared/abi';
import { DENOMS, SHAPES_IN } from '../../shared/planner';
import { policyEconomics } from './policy';

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
  const [policy, maxReward] = await Promise.all([
    pub.readContract({ address: balancer!, abi: poolBalancerAbi, functionName: 'keeperPolicy' }),
    pub.readContract({ address: balancer!, abi: poolBalancerAbi, functionName: 'policyMaxReward' }),
  ]);
  const costs = await policyEconomics(pub, policy, maxReward, balancer);
  expect(costs.restockQuoteVerified).toBe(true);
  expect(costs.keeperQuotes).toBeDefined();
  for (const quote of [...costs.keeperQuotes!.replace, costs.keeperQuotes!.reconcile]) {
    expect(quote).toBeGreaterThanOrEqual(0n);
    expect(quote).toBeLessThanOrEqual(maxReward);
  }
  costs.restockFees.forEach((fee, d) => expect(fee).toBeLessThanOrEqual(BigInt(SHAPES_IN[d]) * 102_000_000_000_000_000n));
  const settingsSelector = toFunctionSelector('settings()');
  expect(requests.some(request => request.method === 'eth_call' && JSON.stringify(request.params).includes(settingsSelector.slice(2)))).toBe(false);
  expect(costs.restockFees).toHaveLength(DENOMS.length);
  expect(costs.policyMaxReward).toBe(maxReward);
  const feeCalls = requests.filter(request => request.method === 'eth_call').map(request => request.params as [{ to?: string; data?: string; gasPrice?: string }, string])
    .filter(([call]) => call.to?.toLowerCase() === balancer!.toLowerCase() && call.data?.startsWith(toFunctionSelector('restockFeeFor(uint8)')));
  expect(feeCalls).toHaveLength(DENOMS.length);
  for (const [call, block] of feeCalls) {
    expect(call.gasPrice).toBe(toHex(costs.gasPrice));
    expect(block).toMatch(/^0x[0-9a-f]+$/);
  }
});

// Failure injection is permitted for off-chain services; no successful answer is fabricated.
it('reports failed policy economics as unavailable instead of substituting V1', async () => {
  const pub = createPublicClient({ transport: custom({ request: async () => { throw new Error('RPC unavailable'); } }, { retryCount: 0 }), cacheTime: 0 });
  const snapshot = { number: 1n, baseFeePerGas: 500_000_000n, timestamp: 1_000n };
  await expect(policyEconomics(pub, '0x0000000000000000000000000000000000000001', 100_000_000_000_000n, undefined, snapshot)).rejects.toThrow('RPC unavailable');
});
