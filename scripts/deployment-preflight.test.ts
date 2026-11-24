import { describe, expect, it } from 'vitest';
import { parseAbi, toFunctionSelector, type Address, type Hex } from 'viem';
import { missingSelectors } from './deployment-preflight';
import { creationOrder, isReuse, matchPlan } from './verify-deployment';

const action = (contractName: string, i: number) => ({
  hash: `0x${String(i + 1).padStart(64, '0')}` as Hex, contractName, contractAddress: `0x${String(i + 1).padStart(40, '0')}` as Address,
  transactionType: contractName.startsWith('Pool') && contractName !== 'PoolBalancer' ? 'CREATE2' : 'CREATE',
  transaction: { from: '0x000000000000000000000000000000000001e001' as Address, nonce: `0x${i.toString(16)}` as Hex, input: `0x0${i}` as Hex },
});
const plan = (names: string[]) => names.map(action);

describe('deployment manifest: created contracts versus reused dependencies', () => {
  it('reuse mode creates no Packs or renderer, and a library already on chain may be absent', () => {
    const reused = plan(['PoolInventory', 'PoolBalancer', 'BalancerFactory']);
    expect(isReuse(reused)).toBe(true);
    expect(matchPlan(reused, reused)).toEqual([]);
    expect(creationOrder(true)).toEqual(['KeeperPolicyCalls', 'PoolPage', 'PoolInventory', 'PoolBalancer', 'BalancerFactory']);
  });
  it('full mode requires the seven-contract order (no keeper policy contract since R95)', () => {
    const full = plan(creationOrder(false));
    expect(isReuse(full)).toBe(false);
    expect(matchPlan(full, full)).toEqual([]);
  });
  it('rejects a renderer without Packs, a missing system contract, or a reordered plan', () => {
    for (const names of [['ShapePackRenderer', 'PoolBalancer', 'BalancerFactory'], ['BalancerFactory'],
      ['BalancerFactory', 'PoolBalancer'], ['PoolBalancer', 'KeeperPolicyV1', 'BalancerFactory']]) {
      const p = plan(names);
      expect(matchPlan(p, p)[0]).toMatch(/not the deployment order/);
    }
  });
});

describe('legacy ABI selector check', () => {
  it('finds each selector only as a PUSH4 operand', () => {
    const abi = parseAbi(['function pool() view returns (address)', 'function creator() view returns (address)']);
    const pool = toFunctionSelector('pool()').slice(2);
    expect(missingSelectors(abi, `0x60806040${'63'}${pool}14`)).toEqual([toFunctionSelector('creator()')]);
    expect(missingSelectors(abi, `0x${pool}`)).toHaveLength(2);
  });
});
