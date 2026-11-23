import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keeper, STUCK_TICKS } from '../../keeper/keeper.ts';

const pool = '0x0000000000000000000000000000000000000001';
const factory = '0x0000000000000000000000000000000000000002';
const actor = '0x0000000000000000000000000000000000000003';
const directory = mkdtempSync(join(tmpdir(), 'keeper-C-'));
let cases = 0;
try {
  const make = (suffix: string) => {
    const k = new Keeper({ rpcUrl: 'https://mainnet.gateway.tenderly.co', factory, account: actor,
      fromBlock: 1n, stateFile: join(directory, `${suffix}.json`) });
    k.state.balancers = [pool];
    k.lastTick = Date.now();
    return k;
  };
  const alternating = make('alternate');
  for (let n = 0; n < STUCK_TICKS * 2; n++) {
    alternating.recordPool(pool, new Error('failed'));
    assert.equal(alternating.health().ok, true);
    alternating.recordPool(pool);
    assert.equal(alternating.health().ok, true);
  }
  cases++;

  const first = make('first');
  for (let n = 1; n <= STUCK_TICKS; n++) {
    first.recordPool(pool, new Error('failed before success'));
    assert.equal(first.health().ok, n < STUCK_TICKS);
  }
  assert.deepEqual(first.health().stuck, [pool]);
  const server = first.serveHealth(0);
  const bound = server.address();
  assert.ok(bound && typeof bound === 'object');
  try { assert.equal((await fetch(`http://127.0.0.1:${bound.port}/health`)).status, 503); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  cases++;

  first.recordPool(pool); // discover's no-code / confirmed removal path
  assert.equal(first.health().ok, true);
  first.recordPool(pool, new Error('failed after re-add'));
  assert.equal(first.failures[pool], 1);
  cases++;

  const before = make('restart');
  for (let n = 0; n < 2; n++) before.recordPool(pool, new Error('failed'));
  before.save();
  const after = make('restart');
  assert.equal(after.failures[pool], 2);
  for (let n = 2; n < STUCK_TICKS; n++) after.recordPool(pool, new Error('failed'));
  assert.equal(after.health().ok, false);
  assert.deepEqual(after.health().stuck, [pool]);
  after.save();
  const third = make('restart');
  assert.equal(third.failures[pool], STUCK_TICKS);
  assert.equal(third.health().ok, false);
  cases++;

  console.log(JSON.stringify({ revision: '5b1fb2c', cases, stuckTicks: STUCK_TICKS,
    afterRestartFailures: third.failures[pool], afterRestartHealthy: third.health().ok,
    directEthTransferWei: '0' }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
