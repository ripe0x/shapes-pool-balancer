import { describe as suite, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { BIG_WIN_SHARE, JACKPOT_MULTIPLE, available, mixOf, playerView, styleBonus, type DesignInputs } from './design';
import { DENOMS, MAX_SHAPES_PER_PLAN, evaluate, restockFeeAt, shapeCount, type Counts } from './planner';

const base: DesignInputs = {
  curatedBases: [parseEther('0.05'), parseEther('0.1')],
  markupBps: 1500,
  edgeBps: 500,
  mintFee: parseEther('0.0005'),
  restockFee: restockFeeAt(10n ** 9n),
  have: Array(9).fill(0),
};
const mix = (m: Record<number, number>): Counts => DENOMS.map((_, i) => m[i] ?? 0);

// Without per-Shape fees: FWA picks prize i with odds 1/price_i over the sum, and the draw price is the prize count over
// that sum, times 1.05. A Shape returns 1/1.15 of its price (15% markup), a curated NFT all of it (no markup), so a draw
// returns (Shapes / 1.15 + NFTs) / (prizes x 1.05).
const noFeeReturn = (counts: Counts) => {
  const shapes = counts.reduce((a, b) => a + b, 0);
  const nfts = base.curatedBases.length;
  return (shapes / 1.15 + nfts) / ((shapes + nfts) * 1.05);
};

suite('playerView', () => {
  it('without per-Shape fees Shapes return their price less the markup and NFTs their whole price', () => {
    const noFees = { ...base, mintFee: 0n, restockFee: 0n };
    for (const counts of [mix({ 0: 10 }), mix({ 0: 2, 3: 1 }), mix({ 1: 5, 2: 2 })]) {
      expect(playerView(evaluate(counts, noFees)).avgReturn).toBeCloseTo(noFeeReturn(counts), 3);
    }
  });

  it('per-Shape mint and restocking fees cost players more on small prizes', () => {
    const small = playerView(evaluate(mix({ 0: 10 }), base)).avgReturn;
    const large = playerView(evaluate(mix({ 1: 5, 2: 2 }), base)).avgReturn;
    expect(small / noFeeReturn(mix({ 0: 10 }))).toBeLessThan(large / noFeeReturn(mix({ 1: 5, 2: 2 })));
    expect(large).toBeLessThan(noFeeReturn(mix({ 1: 5, 2: 2 })));
  });

  it('counts only prizes worth more than the draw price as wins', () => {
    const ev = evaluate(mix({ 0: 10, 3: 1 }), base);
    const v = playerView(ev);
    expect(v.cost).toBe(ev.drawPrice);
    const wins = v.tiers.filter((t) => t.value > ev.drawPrice);
    expect(v.winMore).toBeCloseTo(wins.reduce((s, t) => s + t.odds, 0), 9);
    expect(v.top.value).toBe(parseEther('0.5'));
  });
});

suite('pool size and styles', () => {
  const one = { ...base, curatedBases: [parseEther('0.05')] };
  const at = (c: Counts) => { const ev = evaluate(c, one); return { odds: ev.curatedOddsPpm, price: ev.drawPrice, v: playerView(ev) }; };

  it('more small Shapes make the NFT rarer and the draw cheaper', () => {
    const [few, many] = [at(mixOf(3)), at(mixOf(30))];
    expect(many.odds).toBeLessThan(few.odds);
    expect(many.price < few.price).toBe(true);
  });

  it('a higher NFT value makes it rarer with the same Shapes', () => {
    const odds = (v: string) => evaluate(mixOf(10), { ...one, curatedBases: [parseEther(v)] }).curatedOddsPpm;
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
    for (const st of ['board', 'balanced', 'jackpot'] as const) for (const n of [38, 78, 80, 199]) expect(shapeCount(mixOf(n, styleBonus(st, one, n)))).toBeLessThanOrEqual(MAX_SHAPES_PER_PLAN);
  });

  it('counts Shapes the switch would redeem as available', () => {
    expect(available(parseEther('0.1'), mix({ 3: 2 }), mix({ 3: 1 }))).toBe(parseEther('0.6'));
  });
});

suite('styles without a curated NFT', () => {
  it('pick the same kind of mix from the Shapes alone', () => {
    const none = { ...base, curatedBases: [] };
    expect(shapeCount(styleBonus('board', none, 10))).toBeGreaterThan(0);
    expect(shapeCount(styleBonus('jackpot', none, 10))).toBe(1);
    expect(shapeCount(styleBonus('balanced', none, 10))).toBeGreaterThan(0);
    expect(styleBonus('steady', none, 10)).toEqual(mix({}));
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

  it('keeps a 0.1 ETH prize in a small pool, adds the 0.5 from 12 small Shapes, never exceeds the Shape limit', () => {
    expect(counts(4)[2]).toBe(1);
    expect(counts(4)[3]).toBe(0);
    expect(counts(11)[3]).toBe(0);
    expect(counts(12)[3]).toBe(1);
    for (const n of [1, 10, 24, 30, 38, 60, 78, 80, 150, 200]) expect(shapeCount(counts(n))).toBeLessThanOrEqual(MAX_SHAPES_PER_PLAN);
  });
});

