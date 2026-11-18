import { expect, it } from 'vitest';
import { economics, restockFeeAt } from '../../shared/planner';
import { effectiveRevenueBps } from './revenue-rate';

it('uses the latest stored rate for existing-pool economics instead of a stale local value or revised suggestion', () => {
  const counts = Array(16).fill(0); counts[0] = 20;
  const inputs = { curatedBases: [200_000_000_000_000_000n], markupBps: 2500, edgeBps: 500,
    mintFee: 1_000_000_000_000_000n, restockFee: restockFeeAt(1_000_000_000n), baseFee: 1_000_000_000n,
    gasPrice: 1_050_000_000n, v1Preview: true };
  const initial = economics(counts, { ...inputs, creatorRevenueBps: effectiveRevenueBps(400, 400, 500) });
  const updated = economics(counts, { ...inputs, creatorRevenueBps: effectiveRevenueBps(800, 400, 600) });
  expect(updated.creatorRevenueBps).toBe(800);
  expect(updated.creatorEarningsPerDraw).toBeGreaterThan(initial.creatorEarningsPerDraw);
  expect(updated.retainedRevenuePerDraw).toBeLessThan(initial.retainedRevenuePerDraw);
  expect(updated.marginPerDraw!).toBeLessThan(initial.marginPerDraw!);
  expect(updated.creatorEarningsPerDraw * 40 * 30).toBeGreaterThan(initial.creatorEarningsPerDraw * 40 * 30);
});

it.each([0, 10_000])('retains an explicitly reviewed new-pool draft share of %i bps across unrelated suggestion updates', (draft) => {
  expect(effectiveRevenueBps(undefined, draft, 100)).toBe(draft);
  expect(effectiveRevenueBps(undefined, draft, 900)).toBe(draft);
});

it('uses the suggestion only when a new pool has no explicit reviewed override', () => {
  expect(effectiveRevenueBps(undefined, undefined, 123)).toBe(123);
  expect(effectiveRevenueBps(undefined, undefined, 456)).toBe(456);
});

it.each([0, 10_000])('honors stored boundary rate %i even when a local draft or suggestion disagrees', (stored) => {
  expect(effectiveRevenueBps(stored, 400, 800)).toBe(stored);
});
