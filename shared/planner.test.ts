import { describe, expect, it } from 'vitest';
import fixture from '../test/fixtures/parity.json';
import { BPS, economics, evaluate, listPrice, MAX_KEEPER_REWARD, NUM, packPlan, prizePrice, requiredReserveAt, restockFeeAt, unpackPlan } from './planner';

const EDGE = 500;

describe('planner parity with on-chain FWA (fork fixture)', () => {
  for (const [k, c] of Object.entries(fixture as Record<string, any>)) {
    it(`case ${k}`, () => {
      const counts = unpackPlan(BigInt(c.target ?? c.plan));
      const inputs = { curatedBases: c.bases.map((b: string | number) => BigInt(b)), markupBps: c.markupBps, edgeBps: EDGE, mintFee: BigInt(c.mintFee), restockFee: BigInt(c.restockFee) };
      const ev = evaluate(counts, inputs);
      expect(ev.drawPrice).toBe(BigInt(c.drawPrice));
      expect(ev.curatedOddsBps).toBe(Number(c.curatedOddsBps));
      expect(ev.requiredReserve).toBe(BigInt(c.reserve));
    });
  }
});

describe('planner', () => {
  const E = 10n ** 18n;
  const inputs = { curatedBases: [3n * E / 10n, E / 2n], markupBps: 1500, edgeBps: EDGE, mintFee: E / 1000n, restockFee: restockFeeAt(10n ** 9n) };

  it('prices listed curated NFTs at their live FWA price after a markup change', () => {
    // Round 8 E4: listed at 0.02 ETH, then the markup changed to 10%; FWA keeps the listing at 0.02.
    const counts = unpackPlan(packPlan([4, 0, 0, 0, 0, 0, 0, 0, 0]));
    const at = { ...inputs, curatedBases: [E / 50n], markupBps: 1000 };
    const live = evaluate(counts, { ...at, curatedPrices: [E / 50n] });
    expect(live.tiers[0].listPrice).toBe(E / 50n);
    expect(live.drawPrice).toBeLessThan(evaluate(counts, at).drawPrice);
    // A new NFT added after the listed one is priced at the current markup.
    const added = evaluate(counts, { ...at, curatedBases: [E / 50n, E / 10n], curatedPrices: [E / 50n] });
    expect(added.tiers[1].listPrice).toBe((E / 10n) * 11n / 10n);
  });

  it('prices listed Shapes at their live FWA price, so a historical board matches FWA\'s fee formula (E8)', () => {
    const edge = EDGE;
    const at = { curatedBases: [E / 2n], markupBps: 2000, edgeBps: edge, mintFee: E / 1000n, restockFee: restockFeeAt(10n ** 9n) };
    // Four 0.01 Shapes listed earlier at 10% markup, before the creator raised it to 20%; FWA keeps their old price.
    const listedPrice = prizePrice(0, { ...at, markupBps: 1000 });
    const counts = unpackPlan(packPlan([4, 0, 0, 0, 0, 0, 0, 0, 0]));
    const curatedPrices = [listPrice(E / 2n, at.markupBps)];
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

  it('reports infeasible with no curated NFTs', () => {
    expect(evaluate([1, 0, 0, 0, 0, 0, 0, 0, 0], { ...inputs, curatedBases: [] }).feasible).toBe(false);
  });

  it('tier odds sum to ~1e6 ppm', () => {
    const ev = evaluate([5, 3, 2, 0, 0, 0, 0, 0, 0], inputs);
    const sum = ev.tiers.reduce((s, t) => s + t.oddsPpm, 0);
    expect(Math.abs(sum - 1_000_000)).toBeLessThan(10);
  });

  it('prices a Shape prize at cost, markup on its backing and a basefee-indexed restocking fee per Shape', () => {
    const GWEI = 10n ** 9n;
    expect(restockFeeAt(GWEI)).toBe(900_000n * (GWEI + GWEI / 20n) + 2n * 10n ** 14n); // 0.001145 ETH
    expect(restockFeeAt(80n * GWEI)).toBe(900_000n * 5n * GWEI + 2n * 10n ** 14n); // capped at 5 gwei: 0.0047 ETH
    // 0.01 Shape: 0.01 + 0.001 mint fee + 0.0015 markup + one fee
    expect(prizePrice(0, inputs)).toBe(E / 100n + E / 1000n + 15n * E / 10_000n + restockFeeAt(GWEI));
    // 0.03 pack: three Shapes, three mint fees and three restocking fees
    expect(prizePrice(10, inputs)).toBe(3n * E / 100n + 3n * E / 1000n + 45n * E / 10_000n + 3n * restockFeeAt(GWEI));
    expect(MAX_KEEPER_REWARD).toBe(16_350_000_000_000_000n); // (3.2M + 50k) * 5 gwei + 0.0001
  });

  it('the creator keeps the markup; players pay mint and restocking fees on top', () => {
    const mix = [5, 3, 2, 0, 0, 0, 0, 0, 0];
    const e = economics(mix, inputs);
    const none = economics(mix, { ...inputs, markupBps: 0 });
    expect(none.markupPerDraw).toBe(0);
    expect(none.restockFeesPerDraw).toBeGreaterThan(0);
    expect(e.markupPerDraw).toBeGreaterThan(0);
    expect(economics(mix, { ...inputs, restockFee: restockFeeAt(4n * 10n ** 9n) }).restockFeesPerDraw).toBeGreaterThan(e.restockFeesPerDraw);
    // every tier's odds times its parts add up to the expected listed price (owner proceeds)
    const ev = evaluate(mix, inputs);
    const priced = ev.tiers.reduce((a, t) => a + (t.oddsPpm / 1e6) * (Number(t.value) / 1e18), 0) + e.markupPerDraw + e.mintFeesPerDraw + e.restockFeesPerDraw;
    expect(priced).toBeCloseTo(e.ownerProceeds, 5);
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
