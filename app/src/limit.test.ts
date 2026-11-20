import { expect, it } from 'vitest';
import { limitConcurrency } from './limit';

it('never runs more than the limit at once and runs every call', async () => {
  let running = 0, peak = 0;
  const work = limitConcurrency(async (i: number) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5 + (i % 3)));
    running--;
    return i * 2;
  }, 4);
  const out = await Promise.all(Array.from({ length: 25 }, (_, i) => work(i)));
  expect(peak).toBe(4);
  expect(out).toEqual(Array.from({ length: 25 }, (_, i) => i * 2));
});

it('releases its slot when a call fails', async () => {
  const work = limitConcurrency(async (fail: boolean) => { if (fail) throw new Error('x'); return 1; }, 1);
  await expect(work(true)).rejects.toThrow('x');
  await expect(work(false)).resolves.toBe(1);
});
