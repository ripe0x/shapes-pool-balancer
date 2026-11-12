import { describe, expect, it } from 'vitest';
import fixture from '../test/fixtures/parity.json';
import { economics, evaluate, markupFloorBps, MAX_KEEPER_REWARD, packPlan, requiredReserveAt, unpackPlan } from './planner';

const EDGE = 500;

describe('planner parity with on-chain FWA (fork fixture)', () => {
  for (const [k, c] of Object.entries(fixture as Record<string, any>)) {
    it(`case ${k}`, () => {
      const counts = unpackPlan(BigInt(c.target ?? c.plan));
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
    const c = [5, 3, 2, 0, 0, 0, 0, 0, 1, 2, 0, 0, 1, 0, 0, 4];
    expect(unpackPlan(packPlan(c))).toEqual(c);
    // a plan saved with the nine Shapes sizes only decodes with zero pack counts
    expect(unpackPlan(packPlan([5, 3, 2, 0, 0, 0, 0, 0, 1]))).toEqual([5, 3, 2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('reports infeasible with no curated NFTs', () => {
    expect(evaluate([1, 0, 0, 0, 0, 0, 0, 0, 0], { ...inputs, curatedBases: [] }).feasible).toBe(false);
  });

  it('tier odds sum to ~1e6 ppm', () => {
    const ev = evaluate([5, 3, 2, 0, 0, 0, 0, 0, 0], inputs);
    const sum = ev.tiers.reduce((s, t) => s + t.oddsPpm, 0);
    expect(Math.abs(sum - 1_000_000)).toBeLessThan(10);
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

  it('required reserve: restock the target, one largest prize per unreconciled draw plus a spare, and keeper rewards', () => {
    const ten = [10, 0, 0, 0, 0, 0, 0, 0, 0];
    const fee = E / 1000n;
    const r = MAX_KEEPER_REWARD;
    const shape = E / 100n + fee;
    expect(requiredReserveAt(ten, Array(9).fill(0), fee)).toBe(10n * shape + shape + 4n * r); // ceil((10 + 3) / 5) + 1 calls
    expect(requiredReserveAt(ten, ten, fee)).toBe(shape + 2n * r);
    expect(requiredReserveAt(ten, ten, fee, 2)).toBe(3n * shape + 3n * r); // ceil(9 / 5) + 1
    // the largest prize is a three-Shape 0.25 pack: backing + 3 fees
    expect(requiredReserveAt([4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], Array(16).fill(0), fee)).toBe(4n * shape + 2n * (E / 4n + 3n * fee) + 3n * r); // 10 units: ceil(10 / 5) + 1
  });
});

describe('markup floor (PoolBalancer.configure, MarkupBelowMintFee)', () => {
  const fee = 10n ** 15n; // 0.001 ETH
  const only = (d: number) => Array.from({ length: 16 }, (_, i) => (i === d ? 1 : 0));
  it('covers the mint fees of the most fee-heavy prize in the mix', () => {
    expect(markupFloorBps(only(0), fee)).toBe(1000); // 0.01 Shape: 0.001 / 0.01
    expect(markupFloorBps(only(3), fee)).toBe(20); // 0.5 Shape
    expect(markupFloorBps(only(10), fee)).toBe(1000); // 0.03 pack of three Shapes
    expect(markupFloorBps(only(3), 3n * 10n ** 15n)).toBe(60);
    expect(markupFloorBps([2, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 5n * 10n ** 15n)).toBe(5000);
  });
});
