import { describe, expect, it } from 'vitest';
import { creationOrder, matchPlan } from './verify-deployment';

const transaction = (contractName: string) => ({ contractName, contractAddress: '0x0000000000000000000000000000000000000001' as const,
  transactionType: 'CREATE', transaction: { from: '0x0000000000000000000000000000000000000002' as const,
    nonce: '0x1' as const, input: '0x1234' as const } });

describe('implementation-only deployment manifest', () => {
  it('accepts a new implementation and rejects accidental factory creation', () => {
    const dry = [transaction('PoolInventory'), transaction('PoolBalancer')];
    const sent = dry.map(t => ({ ...t, hash: ('0x' + '12'.repeat(32)) as `0x${string}` }));
    expect(matchPlan(dry, sent, true)).toEqual([]);
    expect(matchPlan([...dry, transaction('BalancerFactory')], [...sent, { ...transaction('BalancerFactory'), hash: sent[0].hash }], true))
      .toContain('reviewed dry run is not the deployment order: PoolInventory,PoolBalancer,BalancerFactory');
    expect(matchPlan(dry, sent)).not.toEqual([]);
  });
  it('still requires reviewed calldata and transaction hashes', () => {
    const dry = [transaction('PoolBalancer')];
    expect(matchPlan(dry, dry, true).join()).toContain('no transaction hash');
    expect(creationOrder(true, true)).not.toContain('BalancerFactory');
    expect(creationOrder(true)).toContain('BalancerFactory');
  });
});
