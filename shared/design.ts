import {
  BPS, BY_VALUE, DENOMS, MAX_PLANS, MAX_SHAPES_PER_PLAN, evaluate, requiredReserveAt,
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
export const shapeTotal = (c: Counts) => c.reduce((a, b) => a + b, 0);

/**
 * The pool's mix: `small` 0.01 ETH Shapes plus `bonus` Shapes. Each listing is drawn in inverse proportion to its price,
 * so every listing returns the same expected value per draw: the small Shapes set how rare the NFTs are (more of them,
 * rarer NFTs and a cheaper draw), and an NFT's own value is the other lever (a higher value is rarer).
 */
export const mixOf = (small: number, bonus: Counts = NONE): Counts => bonus.map((n, i) => n + (i === 0 ? small : 0));

export type Style = 'steady' | 'board' | 'balanced' | 'jackpot';
/**
 * "Balanced": ape-Ball's opening board (24 x 0.01 Shape, 8 x 0.02 Pack, 12 x 0.05, 2 x 0.1, 1 x 0.5 ETH Shape;
 * apeball LaunchConfig D93), as prizes per 24 small Shapes: size index -> count.
 */
export const BOARD: readonly [number, number][] = [[9, 8], [1, 12], [2, 2], [3, 1]];
/** "More big wins" adds bonus Shapes until about this share of draws wins 2x the draw price or more. */
export const BIG_WIN_SHARE = 0.1;
/** "Jackpot" adds one Shape worth about this many times the draw price. */
export const JACKPOT_MULTIPLE = 50;

/**
 * Bonus Shapes for a style, on top of `small` 0.01 ETH Shapes, within the per-plan Shape limit:
 * steady: none;
 * balanced: Shapes worth at least 2x the draw price, added one at a time (the smallest size that qualifies at the
 * current price) until about 1 in 10 draws wins 2x or more;
 * jackpot: one Shape, the size closest to 50x the draw price of the small-Shape pool;
 * board: ape-Ball's proportions scaled to `small` (at least one 0.1 and one 0.5 ETH prize), trimmed from the most
 * numerous sizes to fit the Shape limit.
 */
export function styleBonus(style: Style, d: DesignInputs, small: number): Counts {
  const room = MAX_SHAPES_PER_PLAN - small;
  if (style === 'steady' || !d.curatedBases.length || room <= 0) return NONE;
  if (style === 'board') {
    const b = [...NONE];
    for (const [i, per24] of BOARD) b[i] = Math.max(i === 2 || i === 3 ? 1 : 0, Math.round((small * per24) / 24));
    while (shapeTotal(b) > room) {
      const i = BOARD.map(([j]) => j).reduce((m, j) => (b[j] > b[m] ? j : m));
      if (b[i] === 0) break;
      b[i]--;
    }
    return b;
  }
  const view = (b: Counts) => playerView(describe(mixOf(small, b), d), d.markupBps, d.vrfFee ?? 0n);
  let bonus = NONE;
  if (style === 'jackpot') {
    const target = Number(view(NONE).cost) * JACKPOT_MULTIPLE;
    const i = DENOMS.reduce((b, v, j) => (Math.abs(Math.log(Number(v) / target)) < Math.abs(Math.log(Number(DENOMS[b]) / target)) ? j : b), 0);
    return NONE.map((_, j) => (j === i ? 1 : 0));
  }
  while (shapeTotal(bonus) < room) {
    const v = view(bonus);
    if (v.win2x >= BIG_WIN_SHARE) break;
    const i = BY_VALUE.find((j) => DENOMS[j] >= 2n * v.cost) ?? -1; // the smallest size worth 2x the draw
    if (i < 0) break;
    bonus = bonus.map((n, j) => (j === i ? n + 1 : n));
  }
  return bonus;
}

/**
 * Plans upkeep can switch to when `best` stops meeting the limits (after an NFT is drawn the remaining NFTs are rarer):
 * the same mix with fewer of its smallest Shapes, which raises the chance of an NFT.
 */
export function fallbacksFor(best: Counts): Counts[] {
  const low = BY_VALUE.find((i) => best[i] > 0) ?? -1; // the smallest size in the mix
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
