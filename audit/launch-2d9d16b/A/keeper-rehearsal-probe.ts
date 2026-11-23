import assert from 'node:assert/strict';
import { CurrentRehearsal, ROLES, SCENARIO } from '../../scripts/current-local-rehearsal.ts';

assert.deepEqual(SCENARIO.curatedRequired, [true, false]);
assert.deepEqual(SCENARIO.curatedPerPool, [2, 0]);
assert.deepEqual(SCENARIO.initialDeposits, ['1500000000000000000', '500000000000000000']);

const factory = '0x0000000000000000000000000000000000000001';
const guard = Reflect.get(CurrentRehearsal.prototype, 'permitted') as (
  this: { factory: string; journal: { pools: unknown[]; spent: { deposits: string } } },
  actor: string, to: string, fn: string, args: unknown[], value: bigint,
) => void;
const local = { factory, journal: { pools: [], spent: { deposits: '0' } } };
const create = (i: 0 | 1, curatedRequired: boolean, count: number) => {
  const actor = i === 0 ? ROLES.creatorA : ROLES.creatorB;
  guard.call(local, actor, factory, 'createBalancer', [
    `pool${i}`,
    { target: BigInt(SCENARIO.targets[i]), creatorRevenueBps: SCENARIO.creatorRevenueBps, curatedRequired },
    Array.from({ length: count }, (_, n) => n),
  ], BigInt(SCENARIO.initialDeposits[i]));
};

assert.doesNotThrow(() => create(0, true, 2));
assert.doesNotThrow(() => create(1, false, 0));
assert.throws(() => create(0, false, 2));
assert.throws(() => create(0, true, 0));
assert.throws(() => create(1, true, 0));
assert.throws(() => create(1, false, 2));
console.log('PASS current rehearsal pre-send guard: A curated-required/2, B standard/0, deposits 1.5+0.5 ETH');
