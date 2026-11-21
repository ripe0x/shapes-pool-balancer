import {
  BY_VALUE, DENOMS, MAX_SHAPES_PER_PLAN, evaluate, effectivePolicyMaximum, requiredReserveAt, shapeCount,
  type Counts, type Evaluation, type PoolInputs,
} from './planner';

export interface DesignInputs extends PoolInputs {
  have: Counts; // prizes listed now
  enabled?: boolean;
}

/** One draw from a player's side, at what each prize is worth (a Shape redeems for its backing). */
/** The player's side of a draw, against the draw price (FWA's randomness fee and gas are not included). */
export function playerView(ev: Evaluation) {
  const cost = ev.drawPrice;
  const tiers = ev.tiers.map((t) => ({ ...t, odds: t.oddsPpm / 1e6, multiple: cost ? Number(t.value) / Number(cost) : 0 }));
  const top = tiers.reduce((a, b) => (b.value > a.value ? b : a), tiers[0]);
  return {
    cost,
    tiers,
    top,
    winMore: tiers.filter((t) => t.value > cost).reduce((s, t) => s + t.odds, 0),
    win2x: tiers.filter((t) => t.value >= 2n * cost).reduce((s, t) => s + t.odds, 0),
    // Inverse weights give every listing the same expected price, so this depends on fees and markup more than the mix.
    avgReturn: tiers.reduce((s, t) => s + t.odds * t.multiple, 0),
    curated: ev.curatedOddsPpm / 1e6,
  };
}

/** ETH the creator has for a target plan: liquid ETH plus the backing of Shapes the switch would redeem. */
export function available(balance: bigint, have: Counts, target: Counts): bigint {
  return have.reduce((s, n, d) => s + (n > target[d] ? BigInt(n - target[d]) * DENOMS[d] : 0n), balance);
}

/** ETH that stays in the pool while open with `target`: PoolBalancer.requiredReserve() from the prizes listed now. */
export const ethNeeded = (target: Counts, d: Pick<DesignInputs, 'have' | 'mintFee' | 'policyMaxReward' | 'baseFee' | 'unreconciled' | 'enabled' | 'paidUpkeepEnabled' | 'v1Preview'>) =>
  requiredReserveAt(target, d.have, d.mintFee, d.unreconciled ?? 0, effectivePolicyMaximum(d), d.baseFee, d.enabled ?? true);

const NONE: Counts = DENOMS.map(() => 0);

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
 * board: ape-Ball's proportions scaled to `small` (at least one 0.1 ETH prize; the 0.5 ETH prize from 12 small Shapes,
 * since it sets the reserve: 0.534 ETH with it, 0.134 without), trimmed from the most
 * numerous sizes to fit the Shape limit.
 */
export function styleBonus(style: Style, d: DesignInputs, small: number): Counts {
  const room = MAX_SHAPES_PER_PLAN - small;
  if (style === 'steady' || room <= 0) return NONE;
  if (style === 'board') {
    const b = [...NONE];
    for (const [i, per24] of BOARD) b[i] = Math.max(i === 2 ? 1 : 0, Math.round((small * per24) / 24));
    while (shapeCount(b) > room) {
      const i = BOARD.map(([j]) => j).reduce((m, j) => (b[j] > b[m] ? j : m));
      if (b[i] === 0) break;
      b[i]--;
    }
    return b;
  }
  const view = (b: Counts) => playerView(evaluate(mixOf(small, b), d));
  let bonus = NONE;
  if (style === 'jackpot') {
    const target = Number(view(NONE).cost) * JACKPOT_MULTIPLE;
    const i = DENOMS.reduce((b, v, j) => (Math.abs(Math.log(Number(v) / target)) < Math.abs(Math.log(Number(DENOMS[b]) / target)) ? j : b), 0);
    return NONE.map((_, j) => (j === i ? 1 : 0));
  }
  const pick = (cost: bigint) => BY_VALUE.find((j) => DENOMS[j] >= 2n * cost) ?? -1; // the smallest size worth 2x the draw
  while (shapeCount(bonus) < room) {
    const v = view(bonus);
    if (v.win2x >= BIG_WIN_SHARE) break;
    const i = pick(v.cost);
    if (i < 0) break;
    // Same result as adding size i one at a time, in O(log n) evaluations: find the most extra i after which the
    // one-at-a-time loop would still add i (galloping, then halving), then add one more. Relies on the 2x share and the
    // draw price both rising as size i is added.
    const add = (k: number) => bonus.map((n, j) => (j === i ? n + k : n));
    const more = (k: number) => {
      const b = add(k);
      if (shapeCount(b) >= room) return false;
      const w = view(b);
      return w.win2x < BIG_WIN_SHARE && pick(w.cost) === i;
    };
    let k = 0, step = 1;
    while (more(k + step)) { k += step; step *= 2; }
    for (step >>= 1; step >= 1; step >>= 1) if (more(k + step)) k += step;
    bonus = add(k + 1);
  }
  return bonus;
}

/** A preset's whole mix at `small` 0.01 ETH Shapes, at least one so a preset never collapses to a one-prize pool. */
export const presetCounts = (style: Style, d: DesignInputs, small: number): Counts => {
  const n = Math.max(1, small);
  return mixOf(n, styleBonus(style, d, n));
};

/**
 * The pool-size control's last step for a preset: the first count of 0.01 ETH Shapes where the Shape limit binds (the
 * preset's other Shapes then shrink, so the total stops growing). Found by halving: a preset's mix is too costly to
 * compute for every count.
 */
export function presetMaxSmall(style: Style, d: DesignInputs): number {
  let lo = 1, hi = MAX_SHAPES_PER_PLAN;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (m + shapeCount(styleBonus(style, d, m)) >= MAX_SHAPES_PER_PLAN) hi = m; else lo = m + 1;
  }
  return lo;
}
