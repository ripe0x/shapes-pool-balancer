import { describe, expect, it } from 'vitest';
import fixture from '../test/fixtures/parity.json';
import { batchReserve, economics, enumeratePlans, evaluate, MAX_KEEPER_REWARD, packPlan, requiredReserveAt, unpackPlan } from './planner';

const EDGE = 500;

describe('planner parity with on-chain FWA (fork fixture)', () => {
  for (const [k, c] of Object.entries(fixture as Record<string, any>)) {
    it(`case ${k}`, () => {
      const counts = unpackPlan(BigInt(c.plan));
      const inputs = { curatedBases: c.bases.map((b: string | number) => BigInt(b)), markupBps: c.markupBps, edgeBps: EDGE, mintFee: BigInt(c.mintFee) };
      const ev = evaluate(counts, inputs);
      expect(ev.drawPrice).toBe(BigInt(c.drawPrice));
      expect(ev.curatedOddsBps).toBe(Number(c.curatedOddsBps));
      expect(ev.requiredReserve).toBe(BigInt(c.reserve));
    });
  }
});

describe('planner', () => {
  const E = 10n ** 18n;
  const inputs = { curatedBases: [3n * E / 10n, E / 2n], markupBps: 1500, edgeBps: EDGE, mintFee: E / 1000n };

  it('packs and unpacks plans', () => {
    const c = [5, 3, 2, 0, 0, 0, 0, 0, 1];
    expect(unpackPlan(packPlan(c))).toEqual(c);
  });

  it('flags every violated constraint', () => {
    const ev = evaluate([5, 3, 2, 0, 0, 0, 0, 0, 0], inputs, { maxDrawPrice: 1n, minCuratedOddsBps: 9000, maxShapeCapital: 0n });
    expect(ev.feasible).toBe(false);
    expect(ev.reasons).toEqual(['Shapes capital above limit', 'Draw price above ceiling', 'Curated odds below floor']);
  });

  it('reports infeasible with no curated NFTs', () => {
    expect(evaluate([1, 0, 0, 0, 0, 0, 0, 0, 0], { ...inputs, curatedBases: [] }).feasible).toBe(false);
  });

  it('tier odds sum to ~1e6 ppm', () => {
    const ev = evaluate([5, 3, 2, 0, 0, 0, 0, 0, 0], inputs);
    const sum = ev.tiers.reduce((s, t) => s + t.oddsPpm, 0);
    expect(Math.abs(sum - 1_000_000)).toBeLessThan(10);
  });

  it('batch reserve takes the five most expensive replacements', () => {
    const fee = E / 1000n;
    expect(batchReserve([5, 3, 2, 0, 0, 0, 0, 0, 0], fee)).toBe(2n * (E / 10n + fee) + 3n * (E / 20n + fee));
    expect(batchReserve([1, 0, 0, 0, 0, 0, 0, 0, 0], fee)).toBe(E / 100n + fee);
    expect(batchReserve([0, 0, 0, 0, 0, 0, 0, 0, 7], fee)).toBe(5n * (100n * E + fee));
  });

  it('enumerates only feasible plans and respects limits', () => {
    const limits = { maxDrawPrice: 4n * E / 100n, minCuratedOddsBps: 100, maxShapeCapital: E };
    const r = enumeratePlans(inputs, limits, [0, 1, 2], 40);
    expect(r.plans.length).toBeGreaterThan(0);
    for (const p of r.plans) {
      const ev = evaluate(p.counts, inputs, limits);
      expect(ev.feasible).toBe(true);
    }
    expect(r.plans[0].net).toBeGreaterThanOrEqual(r.plans[r.plans.length - 1].net);
  });

  it('returns nothing when constraints conflict', () => {
    const r = enumeratePlans(inputs, { maxDrawPrice: 1n, minCuratedOddsBps: 9_999, maxShapeCapital: E }, [0, 1, 2]);
    expect(r.plans.length).toBe(0);
  });

  it('min markup grows with gas price and shrinks with draw value', () => {
    const lo = economics([5, 3, 2, 0, 0, 0, 0, 0, 0], inputs, { gasPriceGwei: 0.5, drawsPerUpkeep: 1, safety: 0.25 });
    const hi = economics([5, 3, 2, 0, 0, 0, 0, 0, 0], inputs, { gasPriceGwei: 10, drawsPerUpkeep: 1, safety: 0.25 });
    const thin = economics([5, 0, 0, 0, 0, 0, 0, 0, 0], { ...inputs, markupBps: 100 }, { gasPriceGwei: 2, drawsPerUpkeep: 1, safety: 0.25 });
    expect(thin.outlook).toBe('loss');
    expect(thin.belowModeledMarkup).toBe(true);
    expect(hi.minMarkupBps).toBeGreaterThan(lo.minMarkupBps);
    const big = economics([0, 0, 0, 0, 3, 1, 0, 0, 0], { ...inputs, curatedBases: [20n * E] }, { gasPriceGwei: 10, drawsPerUpkeep: 1, safety: 0.25 });
    expect(big.minMarkupBps).toBeLessThan(hi.minMarkupBps);
    expect(MAX_KEEPER_REWARD).toBe(16_500_000_000_000_000n); // 3.2M * 5 gwei + 0.0005
    expect(lo.outlook).toBe('sustainable');
  });

  it('required reserve matches the contract for the small pool at 0.08 gwei (fork test_reserveSizes)', () => {
    const ten = [10, 0, 0, 0, 0, 0, 0, 0, 0];
    const fee = E / 1000n;
    expect(requiredReserveAt(ten, Array(9).fill(0), fee, 8n * 10n ** 7n)).toBe(184_248_000_000_000_000n);
    expect(requiredReserveAt(ten, ten, fee, 8n * 10n ** 7n)).toBe(72_416_000_000_000_000n);
  });
});
