import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { Keeper, STUCK_TICKS } from '../../keeper/keeper.ts';

const pool = '0x0000000000000000000000000000000000000001';
const factory = '0x0000000000000000000000000000000000000002';
const actor = '0x0000000000000000000000000000000000000003';
const make = (stateFile = '/private/tmp/keeper-health-probe-nonexistent.json') => {
  const k = new Keeper({
    rpcUrl: 'https://mainnet.gateway.tenderly.co',
    factory,
    fromBlock: 1n,
    stateFile,
    account: actor,
  });
  k.lastTick = Date.now();
  k.state.balancers = [pool];
  return k;
};

const alternating = make();
for (let n = 0; n < STUCK_TICKS * 2; n++) {
  alternating.recordPool(pool, new Error('pool cannot service'));
  assert.equal(alternating.health().ok, true, 'under five consecutive failures');
  alternating.recordPool(pool);
  assert.equal(alternating.health().ok, true, 'success clears count');
}

const firstSuccessAbsent = make();
for (let n = 1; n <= STUCK_TICKS; n++) {
  firstSuccessAbsent.recordPool(pool, new Error('pool cannot service\nprovider detail'));
  assert.equal(firstSuccessAbsent.health().ok, n < STUCK_TICKS);
}
assert.deepEqual(firstSuccessAbsent.health().stuck, [pool]);
assert.equal(firstSuccessAbsent.health().errors[pool], 'pool cannot service');

// discover() calls recordPool(b) on an absent-code pool, so a re-added address starts fresh.
firstSuccessAbsent.recordPool(pool);
assert.deepEqual(firstSuccessAbsent.health().stuck, []);
firstSuccessAbsent.recordPool(pool, new Error('still cannot service'));
assert.equal(firstSuccessAbsent.health().ok, true);

for (let n = 1; n < STUCK_TICKS; n++) firstSuccessAbsent.recordPool(pool, new Error('still cannot service'));
assert.equal(firstSuccessAbsent.health().ok, false);
const server = firstSuccessAbsent.serveHealth(0);
const address = server.address();
assert.ok(address && typeof address === 'object');
const response = await fetch(`http://127.0.0.1:${address.port}/health`);
assert.equal(response.status, 503);
assert.deepEqual((await response.json()).stuck, [pool]);
await new Promise<void>((resolve) => server.close(() => resolve()));

const dir = mkdtempSync('audit/launch-2d9d16b-A/keeper-health-state-');
try {
  const file = `${dir}/state.json`;
  const beforeRestart = make(file);
  beforeRestart.recordPool(pool, new Error('pool cannot service'));
  beforeRestart.recordPool(pool, new Error('pool cannot service'));
  beforeRestart.save();
  const afterRestart = make(file);
  for (let n = 0; n < 3; n++) afterRestart.recordPool(pool, new Error('pool cannot service'));
  assert.equal(afterRestart.health().ok, true, 'five failures across restart leave health healthy');
  assert.equal(afterRestart.failures[pool], 3);
} finally {
  rmSync(dir, { recursive: true });
}
console.log(`PASS alternating, pre-first-success, dropped/re-added counter state, HTTP 503; restart resets consecutive count; STUCK_TICKS=${STUCK_TICKS}`);
