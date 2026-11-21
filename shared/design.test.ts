import { describe as suite, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { BIG_WIN_SHARE, JACKPOT_MULTIPLE, available, mixOf, playerView, presetCounts, presetMaxSmall, styleBonus, type DesignInputs } from './design';
import { BY_VALUE, DENOMS, MAX_SHAPES_PER_PLAN, evaluate, packPlan, restockFeeAt, shapeCount, unpackPlan, type Counts } from './planner';

const base: DesignInputs = {
  curatedBases: [parseEther('0.05'), parseEther('0.1')],
  markupBps: 1500,
  edgeBps: 500,
  mintFee: parseEther('0.0005'),
  restockFee: restockFeeAt(10n ** 9n),
  baseFee: 10n ** 9n,
  have: Array(9).fill(0),
  v1Preview: true,
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
    expect(styleBonus('lowPrice', one, 10)).toEqual(mix({}));
  });

  it('more big wins: about 1 in 10 draws wins 2x the price or more, within the Shape limit', () => {
    const c = mixOf(10, styleBonus('bigWins', one, 10));
    expect(at(c).v.win2x).toBeGreaterThanOrEqual(BIG_WIN_SHARE);
    expect(shapeCount(c)).toBeLessThanOrEqual(MAX_SHAPES_PER_PLAN);
  });

  it('more big wins: the fast search picks the same mix as adding one Shape at a time', () => {
    const oneAtATime = (d: DesignInputs, small: number) => {
      let b = mix({});
      while (shapeCount(b) < MAX_SHAPES_PER_PLAN - small) {
        const v = playerView(evaluate(mixOf(small, b), d));
        if (v.win2x >= BIG_WIN_SHARE) break;
        const i = BY_VALUE.find((j) => DENOMS[j] >= 2n * v.cost) ?? -1;
        if (i < 0) break;
        b = b.map((n, j) => (j === i ? n + 1 : n));
      }
      return b;
    };
    for (const d of [one, { ...one, curatedBases: [] }, { ...one, markupBps: 1000 }, { ...one, markupBps: 10_000 }])
      for (const n of [1, 2, 3, 7, 10, 25, 60, 150, 400, 666, 900]) expect(styleBonus('bigWins', d, n)).toEqual(oneAtATime(d, n));
  });

  it('jackpot: one bonus Shape near 50x the draw price', () => {
    const bonus = styleBonus('jackpot', one, 10);
    expect(shapeCount(bonus)).toBe(1);
    const ratio = Number(DENOMS[bonus.findIndex((n) => n > 0)]) / Number(at(mixOf(10)).v.cost);
    expect(ratio).toBeGreaterThan(JACKPOT_MULTIPLE / 3);
    expect(ratio).toBeLessThan(JACKPOT_MULTIPLE * 3);
  });

  it('a style never pushes the pool past the Shape limit', () => {
    for (const st of ['balanced', 'bigWins', 'jackpot'] as const) for (const n of [38, 78, 80, 199]) expect(shapeCount(mixOf(n, styleBonus(st, one, n)))).toBeLessThanOrEqual(MAX_SHAPES_PER_PLAN);
  });

  it('counts Shapes the switch would redeem as available', () => {
    expect(available(parseEther('0.1'), mix({ 3: 2 }), mix({ 3: 1 }))).toBe(parseEther('0.6'));
  });
});

suite('styles without a curated NFT', () => {
  it('pick the same kind of mix from the Shapes alone', () => {
    const none = { ...base, curatedBases: [] };
    expect(shapeCount(styleBonus('balanced', none, 10))).toBeGreaterThan(0);
    expect(shapeCount(styleBonus('jackpot', none, 10))).toBe(1);
    expect(shapeCount(styleBonus('bigWins', none, 10))).toBeGreaterThan(0);
    expect(styleBonus('lowPrice', none, 10)).toEqual(mix({}));
  });
});

suite('balanced style (ape-Ball board)', () => {
  const one = { ...base, curatedBases: [parseEther('0.05')] };
  const counts = (small: number) => mixOf(small, styleBonus('balanced', one, small));

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


suite('designer presets as functions of one counts array', () => {
  const styles = ['lowPrice', 'balanced', 'bigWins', 'jackpot'] as const;
  // The derivation App.tsx used before one counts array (rev 58f4009): `small` 0.01 ETH Shapes, the style's bonus at
  // that count, the slider clamp found by halving, and the floor of one.
  const oldMaxSmall = (style: (typeof styles)[number], d: DesignInputs) => {
    let lo = 1, hi = MAX_SHAPES_PER_PLAN;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (m + shapeCount(styleBonus(style, d, m)) >= MAX_SHAPES_PER_PLAN) hi = m; else lo = m + 1;
    }
    return lo;
  };
  const oldCounts = (style: (typeof styles)[number], d: DesignInputs, small: number) => {
    const bonus = styleBonus(style, d, small);
    const room = MAX_SHAPES_PER_PLAN - shapeCount(bonus);
    return mixOf(Math.max(1, Math.min(small, room, oldMaxSmall(style, d))), bonus);
  };
  const inputs = [
    base,
    { ...base, curatedBases: [], curatedPrices: [] },
    { ...base, markupBps: 1000 },
    { ...base, markupBps: 10_000, curatedBases: [parseEther('2')] },
    { ...base, mintFee: parseEther('0.001'), curatedBases: [parseEther('0.05'), parseEther('0.3'), parseEther('25')] },
  ];

  it('each preset produces the same counts and packed target as before, at every tested pool size', () => {
    for (const d of inputs) for (const style of styles) {
      const max = presetMaxSmall(style, d);
      expect(max).toBe(oldMaxSmall(style, d));
      for (const small of [1, 2, 10, 24, 100, 499, max]) {
        if (small > max) continue;
        const now = presetCounts(style, d, small);
        expect(now, `${style} at ${small}`).toEqual(oldCounts(style, d, small));
        expect(unpackPlan(packPlan(now))).toEqual(now);
        expect(shapeCount(now)).toBeLessThanOrEqual(MAX_SHAPES_PER_PLAN);
      }
    }
  });

  it('a preset never drops below one 0.01 ETH Shape; a hand-made mix may have none', () => {
    for (const style of styles) expect(presetCounts(style, base, 0)[0]).toBe(1);
    for (const m of [mix({ 1: 10 }), mix({ 2: 1, 3: 1 }), mix({ 9: 4 }), mix({ 12: 2, 3: 1 })]) {
      expect(m[0]).toBe(0);
      expect(unpackPlan(packPlan(m))).toEqual(m);
      const ev = evaluate(m, base);
      expect(ev.feasible).toBe(true);
      expect(ev.drawPrice).toBeGreaterThan(0n);
    }
  });

  it('a draw-price preset recomputes from the same count when markup or curated NFTs change', () => {
    expect(presetCounts('bigWins', base, 20)).toEqual(mix({ 0: 20, 1: 9, 10: 1 }));
    expect(presetCounts('bigWins', { ...base, markupBps: 10_000 }, 20)).toEqual(mix({ 0: 20, 1: 1, 2: 20 }));
    expect(presetCounts('jackpot', base, 20)).toEqual(mix({ 0: 20, 4: 1 }));
    expect(presetCounts('jackpot', { ...base, curatedBases: [] }, 20)).toEqual(mix({ 0: 20, 3: 1 }));
    // Balanced depends only on the count.
    expect(presetCounts('balanced', base, 10)).toEqual(presetCounts('balanced', { ...base, markupBps: 5000, curatedBases: [] }, 10));
  });

  it('presets stay fast at the 1,000-prize limit', () => {
    const started = performance.now();
    for (const style of styles) presetCounts(style, base, presetMaxSmall(style, base));
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
