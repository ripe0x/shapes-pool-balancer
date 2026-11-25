import { describe, expect, it } from 'vitest';
import fixture from '../test/fixtures/parity.json';
import { BPS, economics, pendingDrawsAdmitted, evaluate, MAX_KEEPER_REWARD, NUM, packPlan, prizePrice, requiredReserveAt, restockFeeAt, unpackPlan, suggestedCreatorRevenueBps, maintenanceBudgetAt, quoteV1, keeperWorkAt, reserveBreakdownAt, listingBatches, paymentBound, workBudget, DENOMS, prizeRestockFee, V1_ECONOMICS } from './planner';

const EDGE = 500;

describe('planner parity with on-chain FWA (fork fixture)', () => {
  for (const [k, c] of Object.entries(fixture as Record<string, any>)) {
    it(`case ${k}`, () => {
      const counts = unpackPlan(BigInt(c.target ?? c.plan));
      const inputs = { baseFee: BigInt(c.baseFee), curatedBases: c.bases.map((b: string | number) => BigInt(b)), markupBps: c.markupBps, edgeBps: EDGE, mintFee: BigInt(c.mintFee), restockFee: BigInt(c.restockFee), economics: V1_ECONOMICS };
      if (c.maxReward !== undefined) expect(BigInt(c.maxReward)).toBe(MAX_KEEPER_REWARD);
      const ev = evaluate(counts, inputs);
      expect(ev.drawPrice).toBe(BigInt(c.drawPrice));
      expect(ev.curatedOddsBps).toBe(Number(c.curatedOddsBps));
      expect(ev.requiredReserve).toBe(BigInt(c.reserve));
    });
  }
});

describe('planner', () => {
  const E = 10n ** 18n;
  const inputs = { curatedBases: [3n * E / 10n, E / 2n], markupBps: 1500, edgeBps: EDGE, mintFee: E / 1000n, restockFee: restockFeeAt(10n ** 9n), baseFee: 10n ** 9n, v1Preview: true, economics: V1_ECONOMICS };

  it('prices curated NFTs at their value, at any markup, and listed ones at their live FWA price', () => {
    const counts = unpackPlan(packPlan([4, 0, 0, 0, 0, 0, 0, 0, 0]));
    for (const markupBps of [1000, 3000]) {
      expect(evaluate(counts, { ...inputs, curatedBases: [E / 50n], markupBps }).tiers[0].listPrice).toBe(E / 50n);
    }
    // Round 8 E4: the live FWA price is used for a listed NFT; a new NFT added after it is priced at its value.
    const added = evaluate(counts, { ...inputs, curatedBases: [E / 50n, E / 10n], curatedPrices: [E / 40n] });
    expect(added.tiers[0].listPrice).toBe(E / 40n);
    expect(added.tiers[1].listPrice).toBe(E / 10n);
  });

  it('prices listed Shapes at their live FWA price, so a historical board matches FWA\'s fee formula (E8)', () => {
    const edge = EDGE;
    const at = { baseFee: 10n ** 9n, curatedBases: [E / 2n], markupBps: 2000, edgeBps: edge, mintFee: E / 1000n, restockFee: restockFeeAt(10n ** 9n), economics: V1_ECONOMICS };
    // Four 0.01 Shapes listed earlier at 10% markup, before the creator raised it to 20%; FWA keeps their old price.
    const listedPrice = prizePrice(0, { ...at, markupBps: 1000 });
    const counts = unpackPlan(packPlan([4, 0, 0, 0, 0, 0, 0, 0, 0]));
    const curatedPrices = [E / 2n];
    const live = evaluate(counts, { ...at, curatedPrices, shapePrices: [[listedPrice, listedPrice, listedPrice, listedPrice]] });

    // Independent of evaluate: FWA's acquisitionFee is the inverse-weight average of the actual listed prices x (1 + edge).
    const prices = [curatedPrices[0], listedPrice, listedPrice, listedPrice, listedPrice];
    const w = prices.reduce((s, p) => s + NUM / p, 0n);
    const wp = prices.reduce((s, p) => s + (NUM / p) * p, 0n);
    const expected = ((wp / w) * (BPS + BigInt(edge))) / BPS;
    expect(live.drawPrice).toBe(expected);

    // Pricing the same board at the current 20% markup (as if freshly listed) is more expensive: listed prizes are cheaper.
    expect(evaluate(counts, { ...at, curatedPrices }).drawPrice).toBeGreaterThan(live.drawPrice);
  });

  it('packs and unpacks plans', () => {
    const c = [5, 3, 2, 0, 0, 0, 0, 0, 1, 2, 0, 0, 1, 0, 0, 4];
    expect(unpackPlan(packPlan(c))).toEqual(c);
    // a plan saved with the nine Shapes sizes only decodes with zero pack counts
    expect(unpackPlan(packPlan([5, 3, 2, 0, 0, 0, 0, 0, 1]))).toEqual([5, 3, 2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('a Shapes-only plan is feasible: curated NFTs are optional', () => {
    const ev = evaluate([0, 10, 0, 0, 0, 0, 0, 0, 0], { ...inputs, curatedBases: [] });
    expect(ev.feasible).toBe(true);
    expect(ev.curatedOddsPpm).toBe(0);
    expect(ev.drawPrice).toBeGreaterThan(0n);
  });

  it('tier odds sum to ~1e6 ppm', () => {
    const ev = evaluate([5, 3, 2, 0, 0, 0, 0, 0, 0], inputs);
    const sum = ev.tiers.reduce((s, t) => s + t.oddsPpm, 0);
    expect(Math.abs(sum - 1_000_000)).toBeLessThan(10);
  });

  it('prices a Shape prize at cost, markup on its backing and a basefee-indexed restocking fee per Shape', () => {
    const GWEI = 10n ** 9n;
    expect(restockFeeAt(GWEI)).toBe(910_000n * (GWEI + GWEI / 20n) + 2n * 10n ** 14n); // 0.0011555 ETH (910k recalibrated restocking gas)
    expect(restockFeeAt(80n * GWEI)).toBe(910_000n * 5n * GWEI + 2n * 10n ** 14n); // capped at 5 gwei: 0.00475 ETH
    // 0.01 Shape: 0.01 + 0.001 mint fee + 0.0015 markup + one fee
    expect(prizePrice(0, inputs)).toBe(E / 100n + E / 1000n + 15n * E / 10_000n + restockFeeAt(GWEI));
    // 0.03 pack: three Shapes, three mint fees and three restocking fees
    expect(prizePrice(10, inputs)).toBe(3n * E / 100n + 3n * E / 1000n + 45n * E / 10_000n + 3n * restockFeeAt(GWEI));
    expect(MAX_KEEPER_REWARD).toBe(16_500_000_000_000_000n); // (3.2M + 60k recalibrated overhead) * 5 gwei + 10 work units * 0.00002
  });

  it('predicts the unsettled draws the fill gate admits (test/TopHeavyGate.t.sol on the fork)', () => {
    const counts = (pairs: [number, number][]) => { const c = Array(16).fill(0); for (const [d, n] of pairs) c[d] = n; return c; };
    // launch board: 24 x 0.01, 8 x 0.02 pack, 12 x 0.05, 2 x 0.1, 1 x 0.5 -> weight 3.062e21, admits 9, capped at 5
    expect(pendingDrawsAdmitted(counts([[0, 24], [9, 8], [1, 12], [2, 2], [3, 1]]))).toBe(5);
    // Codex rc-122de71 E2 board: one 0.01 Shape and one 25 ETH Pack -> weight 1.0004e20: pauses at one pending draw
    expect(pendingDrawsAdmitted(counts([[0, 1], [15, 1]]))).toBe(0);
    // 17 x 0.01 Shapes is the smallest all-0.01 board that never pauses before FWA's limit
    expect(pendingDrawsAdmitted(counts([[0, 16]]))).toBe(4);
    expect(pendingDrawsAdmitted(counts([[0, 17]]))).toBe(5);
    // Creator fill gate: 16 x 0.01 admits floor(16 x (1 - gate)); 0 keeps only the unavailable-inventory check, which
    // since audit E1 refuses once the unreconciled draws could take every prize: 15, not 16 (16 would admit a 17th draw
    // against 16 prizes).
    expect(pendingDrawsAdmitted(counts([[0, 16]]), 5_000, 100)).toBe(8);
    expect(pendingDrawsAdmitted(counts([[0, 16]]), 0, 100)).toBe(15);
    expect(pendingDrawsAdmitted(counts([[0, 5]]), 0, 100)).toBe(4); // test_case07e: five prizes, five outstanding refuse
    expect(pendingDrawsAdmitted(counts([[0, 16]]), 10_000, 100)).toBe(0);
    expect(pendingDrawsAdmitted(counts([[0, 16]]), 7_000, 3)).toBe(3);
  });

  it('creator estimates use explicit V1 gas context and work-based fees', () => {
    // all 0.01 Shapes: every draw wins one Shape, so keeper pay per draw is one replacement call
    const e = economics([10, 0, 0, 0, 0, 0, 0, 0, 0], { ...inputs, curatedBases: [], restockFee: restockFeeAt(5n * 10n ** 8n), baseFee: 5n * 10n ** 8n });
    // Assumption: 864k measured span plus 60k overhead, 0.55 gwei bid, one draw and one listed Shape unit.
    expect(e.keeperCostKnown).toBe(true);
    expect(e.keeperPayPerDraw).toBeCloseTo(0.0005482, 12);
    expect(e.marginPerDraw).toBeCloseTo(e.retainedRevenuePerDraw - e.replacementCostsPerDraw - e.mintFeesPerDraw - e.keeperPayPerDraw!, 12);
  });

  it('calibrates the initial share using full-precision selection weights, pack costs and only FWA owner revenue', () => {
    const mix = unpackPlan(packPlan([5, 3, 2, 0, 0, 0, 0, 0, 0, 1, 2]));
    const prices = [E / 3n, E / 7n, ...mix.flatMap((n, d) => Array(n).fill(prizePrice(d, inputs)) as bigint[])];
    const weights = prices.map((p) => NUM / p);
    const totalWeight = weights.reduce((a, b) => a + b, 0n);
    const weightedPrice = prices.reduce((a, p, i) => a + weights[i] * p, 0n);
    const owner = weightedPrice / totalWeight;
    let index = 2, intended = 0n;
    mix.forEach((n, d) => { for (let k = 0; k < n; k++) intended += weights[index++] * (DENOMS[d] * 500n / BPS); });
    const at = { ...inputs, curatedBases: prices.slice(0, 2) };
    expect(suggestedCreatorRevenueBps(mix, at)).toBe(Number(intended * BPS / (totalWeight * owner)));
    const ev = evaluate(mix, at);
    expect(ev.ownerProceedsPerDraw).toBe(owner);
    expect(ev.drawPrice).toBe(owner * 10500n / BPS);
    const rate = suggestedCreatorRevenueBps(mix, at);
    expect(rate).toBeGreaterThan(0);
    expect(economics(mix, at).creatorEarningsPerDraw).toBe(Number(owner * BigInt(rate) / BPS) / 1e18);
    expect(suggestedCreatorRevenueBps(mix, { ...at, edgeBps: 1000 })).toBe(rate);
    expect(suggestedCreatorRevenueBps(mix, { ...at, markupBps: 1000 })).toBe(0);
  });

  it('calibrates a 0.01 ETH Shape draw to 366 basis points with residual operating cash', () => {
    const at = { ...inputs, curatedBases: [] };
    expect(suggestedCreatorRevenueBps([10], at)).toBe(366);
    const e = economics([10], at);
    expect(e.ownerProceeds).toBe(0.0136555);
    expect(e.creatorEarningsPerDraw).toBe(0.0004997913);
    expect(e.retainedRevenuePerDraw).toBe(0.0131557087);
  });

  it('keeps a reviewed rate through target, markup, fees and policy quote changes', () => {
    const fixed = { ...inputs, creatorRevenueBps: 321 };
    for (const at of [fixed, { ...fixed, markupBps: 10000 }, { ...fixed, restockFee: E / 10n },
      { ...fixed, keeperQuotes: { replace: Array(16).fill(E / 100n), reconcile: E / 1000n } }]) {
      for (const mix of [[5, 3, 2], [50, 0, 1]]) {
        const e = economics(mix, at);
        expect(e.creatorRevenueBps).toBe(321);
        expect(e.creatorEarningsPerDraw + e.retainedRevenuePerDraw).toBeCloseTo(e.ownerProceeds, 15);
      }
    }
  });

  it('handles zero and full revenue allocation and discloses an operating shortfall', () => {
    const mix = [10];
    const zero = economics(mix, { ...inputs, creatorRevenueBps: 0 });
    expect(zero.creatorEarningsPerDraw).toBe(0);
    expect(zero.retainedRevenuePerDraw).toBe(zero.ownerProceeds);
    const full = economics(mix, { ...inputs, creatorRevenueBps: 10000 });
    expect(full.creatorEarningsPerDraw).toBe(full.ownerProceeds);
    expect(full.retainedRevenuePerDraw).toBe(0);
    expect(full.marginPerDraw).toBeLessThan(-0.01);
    for (const creatorRevenueBps of [-1, 10001, 0.5]) {
      expect(() => economics(mix, { ...inputs, creatorRevenueBps })).toThrow('basis points');
    }
  });

  it('holds only missing inventory, canonical listing calls, present draws and one working buffer', () => {
    const ten = DENOMS.map((_, d) => d === 0 ? 10 : 0), none = DENOMS.map(() => 0);
    const fee = E / 1000n, baseFee = 500_000_000n;
    expect(requiredReserveAt(ten, none, fee, 0, V1_ECONOMICS, baseFee)).toBe(115_779_000_000_000_000n);
    expect(requiredReserveAt(ten, ten, fee, 0, V1_ECONOMICS, baseFee)).toBe(1_993_000_000_000_000n);
    // Each owed draw: (2.15M + 60k) gas at 0.55 gwei plus a processing and a reconciling work fee (since 2026-11-23).
    expect(requiredReserveAt(ten, ten, fee, 2, V1_ECONOMICS, baseFee)).toBe(4_504_000_000_000_000n);
    expect(requiredReserveAt(ten, ten, fee, 2, V1_ECONOMICS, baseFee, false)).toBe(2_511_000_000_000_000n);
    expect(requiredReserveAt(ten, none, fee, 2, undefined, baseFee)).toBe(110_000_000_000_000_000n);
    expect(evaluate(ten, { ...inputs, paidUpkeepEnabled: false }).requiredReserve).toBe(0n);
    const twenty = ten.map((n) => 2 * n);
    const breakdown = reserveBreakdownAt(twenty, none, fee, 0, V1_ECONOMICS, baseFee);
    expect(breakdown.inventoryCost).toBe(220_000_000_000_000_000n);
    expect(breakdown.listingBudget).toBe(7_572_000_000_000_000n);
    expect(breakdown.workingBuffer).toBe(1_993_000_000_000_000n);
    expect(breakdown.total).toBe(229_565_000_000_000_000n);
  });

  it('uses canonical Shape-unit, denomination and value-order grouping for actual setup work', () => {
    const target = DENOMS.map((_, d) => [0, 1, 2, 3, 4].includes(d) ? 1 : 0);
    const batches = listingBatches(target, DENOMS.map(() => 0));
    expect(batches.map((b) => [b.units, b.prizes])).toEqual([[4, 4], [1, 1]]);
    const packs = DENOMS.map((_, d) => d === 10 ? 3 : d === 0 ? 1 : 0);
    expect(listingBatches(packs, DENOMS.map(() => 0)).map((b) => [b.units, b.prizes]))
      .toEqual([[4, 2], [3, 1], [3, 1]]);
  });

  it('clamps a hostile quote to actual useful work and the included price under the selected economics', () => {
    const w = { measuredGas: 6_000_000n, gasPrice: 150_000_000n, baseFee: 100_000_000n,
      processedDraws: 0n, reconciledDraws: 1n, listedShapeUnits: 0n, listedPrizes: 0n };
    expect(paymentBound(w, V1_ECONOMICS)).toBe(81_500_000_000_000n); // (350k + 60k) * 0.15 gwei + one work fee
    expect(paymentBound(w, undefined)).toBe(0n); // paid upkeep off
    expect(workBudget(w, w.baseFee, V1_ECONOMICS)).toBe(81_500_000_000_000n);
    expect(paymentBound({ ...w, measuredGas: 1n }, V1_ECONOMICS)).toBe(29_000_150_000_000n);
    // A factory change applies directly: a doubled work fee and overhead move the bound, no outer literal clamps it.
    const raised = { ...V1_ECONOMICS, workFee: 2n * V1_ECONOMICS.workFee, overheadGas: 120_000 };
    expect(paymentBound(w, raised)).toBe((350_000n + 120_000n) * 150_000_000n + 40_000_000_000_000n);
  });

  it('quotes different pack surcharges and the selected policy maximum without a V1 fee inversion', () => {
    const counts = unpackPlan(packPlan([3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]));
    const fees = Array(16).fill(123n); fees[10] = 999n;
    const selected = { ...V1_ECONOMICS, workFee: E / 10_000n };
    const custom = { ...inputs, economics: selected, restockFees: fees,
      keeperQuotes: { reconcile: E / 100n, replace: Array(16).fill(E / 50n) } };
    expect(prizeRestockFee(10, custom)).toBe(999n);
    expect(prizePrice(10, custom)).toBe(3n * E / 100n + 3n * E / 1000n + 45n * E / 10_000n + 999n);
    const ev = evaluate(counts, custom);
    expect(ev.requiredReserve).toBe(requiredReserveAt(counts, counts, inputs.mintFee, 0, selected, inputs.baseFee));
    expect(ev.requiredReserve).toBeGreaterThan(requiredReserveAt(counts, counts, inputs.mintFee, 0, V1_ECONOMICS, inputs.baseFee));
    const econ = economics(counts, custom);
    expect(econ.keeperCostKnown).toBe(true);
    expect(econ.keeperPayPerDraw).toBeGreaterThan(0.01);
  });

  it('does not manufacture a keeper quote from restocking income', () => {
    const counts = [10, 0, 0, 0, 0, 0, 0, 0, 0];
    const unknown = { ...inputs, v1Preview: false };
    expect(economics(counts, unknown).keeperCostKnown).toBe(false);
    expect(economics(counts, { ...unknown, restockFee: E }).keeperCostKnown).toBe(false);
  });

  it('requires a selected maximum and complete quotes instead of substituting V1', () => {
    const at = { ...inputs, v1Preview: false, economics: undefined };
    expect(() => economics([2], at)).toThrow('Keeper economics unavailable');
    const partial = economics([2], { ...inputs, v1Preview: false, keeperQuotes: { replace: [], reconcile: 1n } });
    expect(partial.keeperCostKnown).toBe(false);
    expect(partial.keeperPayPerDraw).toBeUndefined();
  });

  it('keeps quote failures unavailable, with revenue and replacement estimates still visible', () => {
    const e = economics([2], { ...inputs, v1Preview: false, creatorRevenueBps: 500 });
    expect(e.keeperPayPerDraw).toBeUndefined();
    expect(e.marginPerDraw).toBeUndefined();
    expect(e.creatorEarningsPerDraw).toBeGreaterThan(0);
    expect(e.replacementCostsPerDraw).toBeGreaterThan(0);
  });

  it('estimates cost-first profit from proceeds after backing, mint fees and keeper costs without a revenue rate', () => {
    const e = economics([10], { ...inputs, curatedBases: [], profitAccounting: true, creatorRevenueBps: 0 });
    expect(e.creatorRevenueBps).toBe(0);
    expect(e.creatorEarningsKnown).toBe(true);
    expect(e.retainedRevenuePerDraw).toBe(e.ownerProceeds);
    expect(e.creatorEarningsPerDraw).toBeCloseTo(e.ownerProceeds - e.replacementCostsPerDraw - e.mintFeesPerDraw - e.keeperPayPerDraw!, 15);
    expect(e.creatorEarningsPerDraw).toBe(e.marginPerDraw);
    expect(() => economics([10], { ...inputs, profitAccounting: true, creatorRevenueBps: 500 })).toThrow('no creator revenue percentage');
  });

  it('withholds a cost-first earnings estimate when keeper costs are unknown and exposes negative net margins', () => {
    const unknown = economics([2], { ...inputs, profitAccounting: true, creatorRevenueBps: 0, v1Preview: false });
    expect(unknown.creatorEarningsKnown).toBe(false);
    expect(unknown.marginPerDraw).toBeUndefined();
    const loss = economics([2], { ...inputs, profitAccounting: true, creatorRevenueBps: 0, keeperQuotes: { replace: [10n ** 18n], reconcile: 10n ** 18n } });
    expect(loss.creatorEarningsKnown).toBe(true);
    expect(loss.creatorEarningsPerDraw).toBeLessThan(0);
  });

  it('separates maintenance funding from a 100 ETH inventory deficit', () => {
    const baseFee = 500_000_000n;
    // Two outstanding draws at (2.15M + 60k) gas and two work fees each, plus the larger operating call at
    // (3.2M + 60k) gas, 0.55 gwei.
    const high = maintenanceBudgetAt(2, V1_ECONOMICS, baseFee).total;
    expect(high).toBe(4_504_000_000_000_000n);
    expect(maintenanceBudgetAt(2, { ...V1_ECONOMICS, workFee: 0n }, baseFee).total).toBe(4_224_000_000_000_000n);
    expect(maintenanceBudgetAt(2, undefined, baseFee).total).toBe(0n);
    const target = DENOMS.map((_, d) => d === 8 ? 1 : 0);
    expect(requiredReserveAt(target, DENOMS.map(() => 0), inputs.mintFee, 2, V1_ECONOMICS, baseFee))
      .toBeGreaterThan(100n * E);
    expect(high).toBeLessThan(E / 100n);
  });

});

describe('V1 quote arithmetic from exported Solidity parameters', () => {
  it('matches the independent absolute payment exercised by Solidity', () => {
    const work = { measuredGas: 800_000n, gasPrice: 550_000_000n, baseFee: 500_000_000n,
      reconciledDraws: 1n, listedShapeUnits: 1n, listedPrizes: 1n, processedDraws: 0n };
    expect(quoteV1(work)).toBe(513_000_000_000_000n); // (800k + 60k) * 0.55 gwei + 2 * 0.00002
    expect(quoteV1({ ...work, gasPrice: 1n })).toBe(40_000_000_860_000n);
  });
  it('caps measured gas and gas price while retaining verified-unit service fees', () => {
    const work = keeperWorkAt(100_000_000_000n, 200_000_000_000n, 0);
    expect(quoteV1({ ...work, measuredGas: 100_000_000n, reconciledDraws: 5n, listedShapeUnits: 5n }))
      .toBe(MAX_KEEPER_REWARD);
  });
});
