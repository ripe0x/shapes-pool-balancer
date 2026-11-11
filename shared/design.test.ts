import { describe as suite, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { BIG_WIN_SHARE, JACKPOT_MULTIPLE, available, cheapest, describe, ethNeeded, fallbacksFor, playerView, styleBonus, type DesignInputs } from './design';
import { DENOMS, shapeCount, type Counts } from './planner';

const base: DesignInputs = {
  curatedBases: [parseEther('0.05'), parseEther('0.1')],
  markupBps: 1500,
  edgeBps: 500,
  mintFee: parseEther('0.0005'),
  have: Array(9).fill(0),
  baseFee: 1_000_000_000n,
  minCuratedOddsBps: 500,
};
const mix = (m: Record<number, number>): Counts => DENOMS.map((_, i) => m[i] ?? 0);

suite('playerView', () => {
  it('average return depends on fees and markup, not on the mix', () => {
    for (const counts of [mix({ 0: 10 }), mix({ 0: 2, 3: 1 }), mix({ 1: 5, 2: 2 })]) {
      const v = playerView(describe(counts, base), base.markupBps, 0n);
      expect(v.avgReturn).toBeCloseTo(1 / (1.05 * 1.15), 3);
    }
  });

  it('counts only prizes worth more than the draw plus VRF fee as wins', () => {
    const ev = describe(mix({ 0: 10, 3: 1 }), base);
    const v = playerView(ev, base.markupBps, parseEther('0.002'));
    const wins = v.tiers.filter((t) => t.value > v.cost);
    expect(v.winMore).toBeCloseTo(wins.reduce((s, t) => s + t.odds, 0), 9);
    expect(wins.every((t) => t.value > ev.drawPrice)).toBe(true);
    expect(v.top.value).toBe(parseEther('0.5'));
  });
});

suite('cheapest', () => {
  const one = { ...base, curatedBases: [parseEther('0.05')] };
  const odds = (c: Counts, d = one) => describe(c, d).curatedOddsBps;
  const plusOne = (c: Counts) => c.map((n, i) => (i === c.findIndex((x) => x > 0) ? n + 1 : n));

  it('meets the NFT odds exactly enough: one more of its smallest Shape would break the floor', () => {
    for (const floor of [5000, 2000, 500, 100]) {
      const d = { ...one, minCuratedOddsBps: floor };
      const c = cheapest(d)!;
      expect(odds(c, d), `floor ${floor}`).toBeGreaterThanOrEqual(floor);
      expect(odds(plusOne(c), d), `floor ${floor}`).toBeLessThan(floor);
    }
  });

  it('fills with the smallest Shapes: a 0.05 ETH NFT at 1 in 20 needs three 0.01 ETH Shapes', () => {
    expect(cheapest(one)).toEqual(mix({ 0: 3 }));
  });

  it('with the same Shape size, rarer NFT odds mean more Shapes, more ETH and a cheaper draw', () => {
    const at = (floor: number) => { const d = { ...one, minCuratedOddsBps: floor }; const c = cheapest(d)!; return { n: shapeCount(c), eth: ethNeeded(c, d), price: describe(c, d).drawPrice }; };
    const [common, rare] = [at(500), at(100)]; // both filled with 0.01 ETH Shapes
    expect(rare.n).toBeGreaterThan(common.n);
    expect(rare.eth > common.eth).toBe(true);
    expect(rare.price < common.price).toBe(true);
  });

  it('a valuable NFT is filled with larger Shapes, since one 0.01 ETH Shape would already make it too rare', () => {
    const d = { ...one, curatedBases: [parseEther('10')] };
    const c = cheapest(d)!;
    expect(c[0]).toBe(0);
    expect(odds(c, d)).toBeGreaterThanOrEqual(d.minCuratedOddsBps);
  });

  it('keeps the bonus Shapes and shrinks the filler to hold the odds', () => {
    const bonus = mix({ 2: 2 });
    const c = cheapest(one, bonus)!;
    expect(c[2]).toBeGreaterThanOrEqual(2);
    expect(odds(c)).toBeGreaterThanOrEqual(one.minCuratedOddsBps);
    expect(c[0]).toBeLessThanOrEqual(cheapest(one)![0]);
  });

  it('stays within 40 Shapes and finds nothing without NFTs', () => {
    expect(shapeCount(cheapest({ ...one, minCuratedOddsBps: 1 })!)).toBeLessThanOrEqual(40);
    expect(cheapest({ ...one, curatedBases: [] })).toBeUndefined();
  });

  it('fallbacks raise the chance of an NFT and need no more ETH', () => {
    const d = { ...one, minCuratedOddsBps: 200 };
    const best = cheapest(d)!;
    const fb = fallbacksFor(best);
    expect(fb.length).toBeGreaterThan(0);
    for (const f of fb) { expect(odds(f, d)).toBeGreaterThan(odds(best, d)); expect(ethNeeded(f, d) <= ethNeeded(best, d)).toBe(true); }
  });

  it('counts Shapes the switch would redeem as available', () => {
    expect(available(parseEther('0.1'), mix({ 3: 2 }), mix({ 3: 1 }))).toBe(parseEther('0.6'));
  });
});

suite('styleBonus', () => {
  const one = { ...base, curatedBases: [parseEther('0.05')] };
  const view = (bonus: Counts) => { const c = cheapest(one, bonus)!; return { c, v: playerView(describe(c, one), one.markupBps, 0n) }; };

  it('steady adds nothing: the cheapest pool for the odds', () => {
    expect(styleBonus('steady', one)).toEqual(mix({}));
  });

  it('more big wins: about 1 in 10 draws wins 2x the price or more, and the NFT odds hold', () => {
    const { c, v } = view(styleBonus('balanced', one));
    expect(v.win2x).toBeGreaterThanOrEqual(BIG_WIN_SHARE);
    expect(describe(c, one).curatedOddsBps).toBeGreaterThanOrEqual(one.minCuratedOddsBps);
    expect(shapeCount(c)).toBeLessThanOrEqual(40);
  });

  it('jackpot: one bonus Shape, sized near 50x the draw price, and the NFT odds hold', () => {
    const bonus = styleBonus('jackpot', one);
    expect(shapeCount(bonus)).toBe(1);
    const top = DENOMS[bonus.findIndex((n) => n > 0)];
    const cost = playerView(describe(cheapest(one)!, one), one.markupBps, 0n).cost;
    expect(Number(top) / Number(cost)).toBeGreaterThan(JACKPOT_MULTIPLE / 3);
    expect(Number(top) / Number(cost)).toBeLessThan(JACKPOT_MULTIPLE * 3);
    expect(describe(view(bonus).c, one).curatedOddsBps).toBeGreaterThanOrEqual(one.minCuratedOddsBps);
  });
});

suite('ladder style', () => {
  const one = { ...base, curatedBases: [parseEther('0.05')] };
  it('has a top prize near 50x, big wins about 1 in 10, and at least three Shape sizes', () => {
    const bonus = styleBonus('ladder', one);
    const c = cheapest(one, bonus)!;
    const v = playerView(describe(c, one), one.markupBps, 0n);
    expect(v.win2x).toBeGreaterThanOrEqual(BIG_WIN_SHARE);
    expect(c.filter((n) => n > 0).length).toBeGreaterThanOrEqual(3);
    expect(Number(v.top.value) / Number(v.cost)).toBeGreaterThan(JACKPOT_MULTIPLE / 3);
    expect(describe(c, one).curatedOddsBps).toBeGreaterThanOrEqual(one.minCuratedOddsBps);
  });
});
