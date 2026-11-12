import { describe as suite, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { BIG_WIN_SHARE, JACKPOT_MULTIPLE, available, describe, mixOf, playerView, styleBonus, type DesignInputs } from './design';
import { DENOMS, MAX_SHAPES_PER_PLAN, restockFeeAt, shapeCount, type Counts } from './planner';

const base: DesignInputs = {
  curatedBases: [parseEther('0.05'), parseEther('0.1')],
  markupBps: 1500,
  edgeBps: 500,
  mintFee: parseEther('0.0005'),
  restockFee: restockFeeAt(10n ** 9n),
  have: Array(9).fill(0),
};
const mix = (m: Record<number, number>): Counts => DENOMS.map((_, i) => m[i] ?? 0);

suite('playerView', () => {
  it('without per-Shape fees the average return is the same for every mix', () => {
    const noFees = { ...base, mintFee: 0n, restockFee: 0n };
    for (const counts of [mix({ 0: 10 }), mix({ 0: 2, 3: 1 }), mix({ 1: 5, 2: 2 })]) {
      expect(playerView(describe(counts, noFees), 0n).avgReturn).toBeCloseTo(1 / (1.05 * 1.15), 3);
    }
  });

  it('per-Shape mint and restocking fees cost players more on small prizes', () => {
    const small = playerView(describe(mix({ 0: 10 }), base), 0n).avgReturn;
    const large = playerView(describe(mix({ 1: 5, 2: 2 }), base), 0n).avgReturn;
    expect(small).toBeLessThan(large);
    expect(large).toBeLessThan(1 / (1.05 * 1.15));
  });

  it('counts only prizes worth more than the draw plus VRF fee as wins', () => {
    const ev = describe(mix({ 0: 10, 3: 1 }), base);
    const v = playerView(ev, parseEther('0.002'));
    const wins = v.tiers.filter((t) => t.value > v.cost);
    expect(v.winMore).toBeCloseTo(wins.reduce((s, t) => s + t.odds, 0), 9);
    expect(wins.every((t) => t.value > ev.drawPrice)).toBe(true);
    expect(v.top.value).toBe(parseEther('0.5'));
  });
});

suite('pool size and styles', () => {
  const one = { ...base, curatedBases: [parseEther('0.05')] };
  const at = (c: Counts) => { const ev = describe(c, one); return { odds: ev.curatedOddsPpm, price: ev.drawPrice, v: playerView(ev, 0n) }; };

  it('more small Shapes make the NFT rarer and the draw cheaper', () => {
    const [few, many] = [at(mixOf(3)), at(mixOf(30))];
    expect(many.odds).toBeLessThan(few.odds);
    expect(many.price < few.price).toBe(true);
  });

  it('a higher NFT value makes it rarer with the same Shapes', () => {
    const odds = (v: string) => describe(mixOf(10), { ...one, curatedBases: [parseEther(v)] }).curatedOddsPpm;
    expect(odds('1')).toBeLessThan(odds('0.05'));
  });

  it('steady adds nothing', () => {
    expect(styleBonus('steady', one, 10)).toEqual(mix({}));
  });

  it('more big wins: about 1 in 10 draws wins 2x the price or more, within the Shape limit', () => {
    const c = mixOf(10, styleBonus('balanced', one, 10));
    expect(at(c).v.win2x).toBeGreaterThanOrEqual(BIG_WIN_SHARE);
    expect(shapeCount(c)).toBeLessThanOrEqual(MAX_SHAPES_PER_PLAN);
  });

  it('jackpot: one bonus Shape near 50x the draw price', () => {
    const bonus = styleBonus('jackpot', one, 10);
    expect(shapeCount(bonus)).toBe(1);
    const ratio = Number(DENOMS[bonus.findIndex((n) => n > 0)]) / Number(at(mixOf(10)).v.cost);
    expect(ratio).toBeGreaterThan(JACKPOT_MULTIPLE / 3);
    expect(ratio).toBeLessThan(JACKPOT_MULTIPLE * 3);
  });

  it('a style never pushes the pool past the Shape limit', () => {
    for (const st of ['board', 'balanced', 'jackpot'] as const) for (const n of [38, 78, 80]) expect(shapeCount(mixOf(n, styleBonus(st, one, n)))).toBeLessThanOrEqual(MAX_SHAPES_PER_PLAN);
  });

  it('counts Shapes the switch would redeem as available', () => {
    expect(available(parseEther('0.1'), mix({ 3: 2 }), mix({ 3: 1 }))).toBe(parseEther('0.6'));
  });
});

suite('balanced style (ape-Ball board)', () => {
  const one = { ...base, curatedBases: [parseEther('0.05')] };
  const counts = (small: number) => mixOf(small, styleBonus('board', one, small));

  it('at 20 small Shapes is ape-Ball\'s 47-row board scaled to 40', () => {
    const c = counts(20);
    expect([c[0], c[9], c[1], c[2], c[3]]).toEqual([20, 7, 10, 2, 1]); // 0.01, 0.02 pack, 0.05, 0.1, 0.5
    expect(shapeCount(c)).toBe(40);
  });

  it('keeps a 0.1 and a 0.5 ETH prize in a small pool and never exceeds the Shape limit', () => {
    const small = counts(4);
    expect(small[2]).toBeGreaterThanOrEqual(1);
    expect(small[3]).toBeGreaterThanOrEqual(1);
    for (const n of [1, 10, 24, 30, 38, 60, 78, 80]) expect(shapeCount(counts(n))).toBeLessThanOrEqual(MAX_SHAPES_PER_PLAN);
  });
});

