import { describe as suite, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { available, describe, ethNeeded, playerView, recommend, type DesignInputs } from './design';
import { DENOMS, capitalOf, shapeCount, type Counts } from './planner';

const base: DesignInputs = {
  curatedBases: [parseEther('0.05'), parseEther('0.1')],
  markupBps: 1500,
  edgeBps: 500,
  mintFee: parseEther('0.0005'),
  budget: parseEther('2'),
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

suite('recommend', () => {
  it('fits the budget, the 40-Shape limit and the odds floor for every style', () => {
    for (const style of ['steady', 'balanced', 'jackpot'] as const) {
      const r = recommend(style, base);
      expect(r.best, style).toBeDefined();
      for (const c of [r.best!, ...r.fallbacks]) {
        expect(ethNeeded(c, base) <= available(base.budget, base.have, c)).toBe(true);
        expect(shapeCount(c)).toBeLessThanOrEqual(40);
        expect(describe(c, base).curatedOddsBps).toBeGreaterThanOrEqual(base.minCuratedOddsBps);
      }
    }
  });

  it('each style wins on its own measure: steady the draw price, balanced 2x wins, jackpot the top prize', () => {
    const ev = (s: 'steady' | 'balanced' | 'jackpot') => describe(recommend(s, base).best!, base);
    const [steady, balanced, jackpot] = [ev('steady'), ev('balanced'), ev('jackpot')];
    const top = (e: typeof steady) => e.tiers.filter((t) => t.kind === 'shape').reduce((m, t) => (t.listPrice > m ? t.listPrice : m), 0n);
    const win2x = (e: typeof steady) => playerView(e, base.markupBps, 0n).win2x;
    expect(steady.drawPrice <= balanced.drawPrice && steady.drawPrice <= jackpot.drawPrice).toBe(true);
    expect(win2x(balanced)).toBeGreaterThanOrEqual(Math.max(win2x(steady), win2x(jackpot)));
    expect(top(jackpot) > top(steady)).toBe(true);
  });

  it('fallbacks raise curated odds', () => {
    const r = recommend('steady', base);
    const odds = (c: Counts) => describe(c, base).curatedOddsPpm;
    expect(r.fallbacks.length).toBeGreaterThan(0);
    for (const f of r.fallbacks) expect(odds(f)).toBeGreaterThan(odds(r.best!));
  });

  it('counts Shapes the switch would redeem as available, and finds nothing without NFTs or budget', () => {
    expect(available(parseEther('0.1'), mix({ 3: 2 }), mix({ 3: 1 }))).toBe(parseEther('0.6'));
    expect(recommend('balanced', { ...base, curatedBases: [] }).best).toBeUndefined();
    expect(recommend('balanced', { ...base, budget: parseEther('0.01') }).best).toBeUndefined();
  });

  it('a larger budget never yields less Shapes capital for the jackpot style', () => {
    const small = capitalOf(recommend('jackpot', base).best!);
    const large = capitalOf(recommend('jackpot', { ...base, budget: parseEther('20') }).best!);
    expect(large >= small).toBe(true);
  });
});
