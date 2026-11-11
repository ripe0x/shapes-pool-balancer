import {
  BPS, DENOMS, MAX_PLANS, enumeratePlans, evaluate, requiredReserveAt,
  type Counts, type Evaluation, type PoolInputs,
} from './planner';

export type Style = 'steady' | 'balanced' | 'jackpot';

export interface DesignInputs extends PoolInputs {
  budget: bigint; // ETH the creator commits: the Balancer's balance plus Shapes already listed
  have: Counts; // Shapes listed now
  baseFee: bigint;
  minCuratedOddsBps: number;
  maxDrawPrice?: bigint; // omitted: no ceiling while searching
  vrfFee?: bigint; // FWA's per-draw VRF service fee, paid by the player on top of the draw price
}

/** Unmarked value of a listing: what a Shape redeems for, or the creator's value of a curated NFT. */
const baseOf = (listPrice: bigint, markupBps: number) => (listPrice * BPS) / (BPS + BigInt(markupBps));

/** One draw from a player's side, valued at unmarked prices (a Shape redeems for its backing). */
export function playerView(ev: Evaluation, markupBps: number, vrfFee: bigint) {
  const cost = ev.drawPrice + vrfFee;
  const tiers = ev.tiers.map((t) => {
    const value = baseOf(t.listPrice, markupBps);
    return { ...t, value, odds: t.oddsPpm / 1e6, multiple: cost ? Number(value) / Number(cost) : 0 };
  });
  const top = tiers.reduce((a, b) => (b.value > a.value ? b : a), tiers[0]);
  return {
    cost,
    tiers,
    top,
    winMore: tiers.filter((t) => t.value > cost).reduce((s, t) => s + t.odds, 0),
    win2x: tiers.filter((t) => t.value >= 2n * cost).reduce((s, t) => s + t.odds, 0),
    // Inverse weights give every listing the same expected value, so this depends on fees and markup, not on the mix.
    avgReturn: tiers.reduce((s, t) => s + t.odds * t.multiple, 0),
    curated: ev.curatedOddsPpm / 1e6,
  };
}

/** ETH the creator has for a target plan: liquid ETH plus the backing of Shapes the switch would redeem. */
export function available(balance: bigint, have: Counts, target: Counts): bigint {
  return have.reduce((s, n, d) => s + (n > target[d] ? BigInt(n - target[d]) * DENOMS[d] : 0n), balance);
}

/** ETH required to open with `target`: PoolBalancer.requiredReserve() after the switch. */
export const ethNeeded = (target: Counts, d: Pick<DesignInputs, 'have' | 'mintFee' | 'baseFee'>) =>
  requiredReserveAt(target, d.have, d.mintFee, d.baseFee);

/** Largest Shape prize in a mix (listed price). */
const topShape = (ev: Evaluation) => ev.tiers.filter((t) => t.kind === 'shape').reduce((m, t) => (t.listPrice > m ? t.listPrice : m), 0n);
const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The mix that fits the budget and best matches the style, judged from the player's side:
 * steady: lowest draw price; balanced: highest chance of a prize worth 2x the draw or more; jackpot: largest top prize,
 * then lowest draw price. Fallbacks drop some of the smallest Shapes, which raises curated odds, so the pool can stay
 * open after a curated NFT is drawn.
 */
export function recommend(style: Style, d: DesignInputs) {
  const none = { best: undefined, fallbacks: [] as Counts[], options: 0 };
  // A single Shape needs its backing twice (listed + held for its replacement), so larger ones cannot fit.
  const affordable = DENOMS.map((_, i) => i).filter((i) => 2n * (DENOMS[i] + d.mintFee) <= d.budget);
  if (!affordable.length || !d.curatedBases.length) return none;
  const small = affordable.slice(0, 3);
  const allowed = style === 'jackpot' ? [...new Set([...small.slice(0, 2), affordable[affordable.length - 1]])] : style === 'steady' ? small : affordable.slice(0, 4);
  const limits = { maxDrawPrice: d.maxDrawPrice ?? 2n ** 255n, minCuratedOddsBps: d.minCuratedOddsBps, maxShapeCapital: d.budget };
  const { plans } = enumeratePlans(d, limits, allowed, 24, { gasPriceGwei: 1, drawsPerUpkeep: 1, safety: 0.25 }, 100_000, 150_000);
  const fits = (c: Counts) => ethNeeded(c, d) <= available(d.budget, d.have, c);
  const fit = plans.filter((p) => fits(p.counts));
  if (!fit.length) return none;
  const win2x = (ev: Evaluation) => playerView(ev, d.markupBps, d.vrfFee ?? 0n).win2x;
  const ranked = [...fit].sort((a, b) =>
    style === 'steady' ? cmp(a.ev.drawPrice, b.ev.drawPrice) || b.net - a.net
      : style === 'jackpot' ? cmp(topShape(b.ev), topShape(a.ev)) || cmp(a.ev.drawPrice, b.ev.drawPrice)
        : win2x(b.ev) - win2x(a.ev) || cmp(a.ev.drawPrice, b.ev.drawPrice));
  const best = ranked[0].counts;
  const low = best.findIndex((n) => n > 0);
  const seen = new Set([best.join()]);
  const fallbacks: Counts[] = [];
  for (const keep of [0.75, 0.5, 0.25, 0]) {
    const c = best.map((n, i) => (i === low ? Math.floor(n * keep) : n));
    if (c.every((n) => n === 0) || seen.has(c.join()) || !fits(c) || fallbacks.length === MAX_PLANS - 1) continue;
    seen.add(c.join());
    fallbacks.push(c);
  }
  return { best, fallbacks, options: fit.length };
}

/** Evaluate a mix for display; `limits` omitted means no ceiling or floor check. */
export const describe = (counts: Counts, d: DesignInputs, maxDrawPrice?: bigint) =>
  evaluate(counts, d, maxDrawPrice === undefined ? undefined : { maxDrawPrice, minCuratedOddsBps: d.minCuratedOddsBps, maxShapeCapital: 2n ** 255n });
