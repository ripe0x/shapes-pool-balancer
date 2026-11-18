import { createPublicClient, custom, http, toFunctionSelector, toHex, type Address } from 'viem';
import { expect, it } from 'vitest';
import { poolBalancerAbi } from '../../shared/abi';
import { DENOMS, restockFeeAt, SHAPES_IN } from '../../shared/planner';
import { policyEconomics } from './policy';

const rpc = process.env.POLICY_PREVIEW_RPC;
const balancer = process.env.POLICY_PREVIEW_BALANCER as Address | undefined;

// Opt-in reads of the preserved V1 local rehearsal. No successful RPC answers are substituted.
it.skipIf(!rpc || !balancer)('keeps legacy pools usable with exact pool surcharge quotes and unknown unsupported reward estimates', async () => {
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
  expect(policy.toLowerCase()).toBe('0x058b476b600e8f3d66c84ce874eb131eeacddbdf');
  const costs = await policyEconomics(pub, policy, maxReward, balancer);
  expect(costs.restockQuoteVerified).toBe(true);
  expect(costs.keeperQuotes).toBeUndefined();
  expect(costs.baseFee).toBe(80_000_000n);
  expect(costs.restockFee).toBe(317_000_000_000_000n);
  expect(costs.restockFees).toEqual(SHAPES_IN.map(units => BigInt(units) * restockFeeAt(costs.baseFee)));
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
