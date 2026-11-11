import { describe as suite, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { BIG_WIN_SHARE, JACKPOT_MULTIPLE, available, describe, ethNeeded, fallbacksFor, mixOf, playerView, styleBonus, type DesignInputs } from './design';
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

suite('pool size and styles', () => {
  const one = { ...base, curatedBases: [parseEther('0.05')] };
  const at = (c: Counts) => { const ev = describe(c, one); return { odds: ev.curatedOddsPpm, price: ev.drawPrice, v: playerView(ev, one.markupBps, 0n) }; };

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

  it('more big wins: about 1 in 10 draws wins 2x the price or more, within 40 Shapes', () => {
    const c = mixOf(10, styleBonus('balanced', one, 10));
    expect(at(c).v.win2x).toBeGreaterThanOrEqual(BIG_WIN_SHARE);
    expect(shapeCount(c)).toBeLessThanOrEqual(40);
  });

  it('jackpot: one bonus Shape near 50x the draw price', () => {
    const bonus = styleBonus('jackpot', one, 10);
    expect(shapeCount(bonus)).toBe(1);
    const ratio = Number(DENOMS[bonus.findIndex((n) => n > 0)]) / Number(at(mixOf(10)).v.cost);
    expect(ratio).toBeGreaterThan(JACKPOT_MULTIPLE / 3);
    expect(ratio).toBeLessThan(JACKPOT_MULTIPLE * 3);
  });

  it('ladder: big wins, a top prize near 50x and at least three Shape sizes', () => {
    const c = mixOf(10, styleBonus('ladder', one, 10));
    const v = at(c).v;
    expect(v.win2x).toBeGreaterThanOrEqual(BIG_WIN_SHARE);
    expect(c.filter((n) => n > 0).length).toBeGreaterThanOrEqual(3);
    expect(Number(v.top.value) / Number(v.cost)).toBeGreaterThan(JACKPOT_MULTIPLE / 3);
  });

  it('a style never pushes the pool past 40 Shapes', () => {
    for (const st of ['balanced', 'jackpot', 'ladder'] as const) expect(shapeCount(mixOf(38, styleBonus(st, one, 38)))).toBeLessThanOrEqual(40);
  });

  it('fallbacks raise the chance of an NFT and need no more ETH', () => {
    const best = mixOf(20);
    const fb = fallbacksFor(best);
    expect(fb.length).toBeGreaterThan(0);
    for (const f of fb) { expect(at(f).odds).toBeGreaterThan(at(best).odds); expect(ethNeeded(f, one) <= ethNeeded(best, one)).toBe(true); }
  });

  it('counts Shapes the switch would redeem as available', () => {
    expect(available(parseEther('0.1'), mix({ 3: 2 }), mix({ 3: 1 }))).toBe(parseEther('0.6'));
  });
});
