import {
  BPS, DENOMS, MAX_PLANS, MAX_SHAPES_PER_PLAN, evaluate, requiredReserveAt,
  type Counts, type Evaluation, type PoolInputs,
} from './planner';

export interface DesignInputs extends PoolInputs {
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

const NONE: Counts = DENOMS.map(() => 0);
const NO_CEILING = 2n ** 255n;

/**
 * The cheapest mix for the creator's NFT odds. Each listing is drawn in inverse proportion to its price, so the chance of
 * an NFT fixes how much Shape weight the pool may hold; the smallest Shapes supply that weight with the fewest items
 * and the least ETH, which also gives the lowest draw price. Filler Shapes go on top of the creator's bonus Shapes for
 * as long as the chance of an NFT stays at or above `minCuratedOddsBps` (the on-chain floor).
 *
 * Search: each filler size, plus up to 4 of the next size and 1 of the size after (more of those is always matched by
 * one more of the smaller size with fewer items). Lowest draw price wins. Draw prices within 0.5% count as equal; then
 * the chance of an NFT closest to the floor wins (the odds the creator asked for), then less ETH. Undefined when no mix
 * with at least one Shape meets the floor.
 */
export function cheapest(d: DesignInputs, bonus: Counts = NONE): Counts | undefined {
  if (!d.curatedBases.length) return undefined;
  const used = bonus.reduce((a, b) => a + b, 0);
  let best: { c: Counts; price: bigint; odds: number; eth: bigint } | undefined;
  const better = (x: NonNullable<typeof best>, y: NonNullable<typeof best>) => {
    const tie = (x.price > y.price ? x.price - y.price : y.price - x.price) * 200n <= (x.price > y.price ? x.price : y.price);
    if (!tie) return x.price < y.price;
    return x.odds !== y.odds ? x.odds < y.odds : x.eth < y.eth;
  };
  for (let j = 0; j < DENOMS.length; j++) {
    for (let b = 0; b <= (j + 1 < DENOMS.length ? 4 : 0); b++) {
      for (let k = 0; k <= (j + 2 < DENOMS.length ? 1 : 0); k++) {
        for (let a = 0; used + a + b + k <= MAX_SHAPES_PER_PLAN; a++) {
          const c = bonus.map((n, i) => n + (i === j ? a : 0) + (i === j + 1 ? b : 0) + (i === j + 2 ? k : 0));
          if (!c.some(Boolean)) continue;
          const ev = describe(c, d, NO_CEILING);
          // More Shapes only lower the chance of an NFT, so once below the floor this line is done.
          if (!ev.feasible) break;
          const x = { c, price: ev.drawPrice, odds: ev.curatedOddsPpm, eth: ethNeeded(c, d) };
          if (!best || better(x, best)) best = x;
        }
      }
    }
  }
  return best?.c;
}

/**
 * Plans upkeep can switch to when `best` stops meeting the limits (after an NFT is drawn the remaining NFTs are rarer):
 * the same mix with fewer of its smallest Shapes, which raises the chance of an NFT.
 */
export function fallbacksFor(best: Counts): Counts[] {
  const low = best.findIndex((n) => n > 0);
  const seen = new Set([best.join()]);
  const out: Counts[] = [];
  for (const keep of [0.75, 0.5, 0.25, 0]) {
    const c = best.map((n, i) => (i === low ? Math.floor(n * keep) : n));
    if (c.every((n) => n === 0) || seen.has(c.join()) || out.length === MAX_PLANS - 1) continue;
    seen.add(c.join());
    out.push(c);
  }
  return out;
}

/** Evaluate a mix for display; `limits` omitted means no ceiling or floor check. */
export const describe = (counts: Counts, d: DesignInputs, maxDrawPrice?: bigint) =>
  evaluate(counts, d, maxDrawPrice === undefined ? undefined : { maxDrawPrice, minCuratedOddsBps: d.minCuratedOddsBps, maxShapeCapital: 2n ** 255n });
