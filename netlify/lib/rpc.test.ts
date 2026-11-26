import { describe, expect, it } from 'vitest';
import { MAX_BATCH, originAllowed, refuseRpc } from './rpc';

describe('read-only RPC proxy checks', () => {
  it('accepts reads and refuses anything that sends, signs or debugs', () => {
    expect(refuseRpc({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] })).toBeUndefined();
    expect(refuseRpc([{ method: 'eth_getLogs' }, { method: 'eth_blockNumber' }])).toBeUndefined();
    for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'debug_traceTransaction', 'alchemy_getAssetTransfers'])
      expect(refuseRpc({ method })).toContain(method);
    expect(refuseRpc([{ method: 'eth_call' }, { method: 'eth_sendRawTransaction' }])).toContain('eth_sendRawTransaction');
    expect(refuseRpc(null)).toBeDefined();
    expect(refuseRpc([])).toBeDefined();
    expect(refuseRpc(Array.from({ length: MAX_BATCH + 1 }, () => ({ method: 'eth_call' })))).toBeDefined();
  });

  it('serves only this site and its deploy URLs', () => {
    const env = { URL: 'https://pools.shapes.ripe.wtf', DEPLOY_PRIME_URL: 'https://main--shapes-pool-balancer.netlify.app' };
    expect(originAllowed('https://pools.shapes.ripe.wtf', {})).toBe(true);
    expect(originAllowed('https://main--shapes-pool-balancer.netlify.app', env)).toBe(true);
    expect(originAllowed('https://evil.example', env)).toBe(false);
    expect(originAllowed('https://pools.shapes.ripe.wtf.evil.example', env)).toBe(false);
    expect(originAllowed(null, env)).toBe(false);
  });
});
