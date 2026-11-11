// Fixed-inventory planner. All price, odds and reserve checks use the same integer arithmetic as
// PoolBalancer._feasible / _batchReserve and FWA StandardPool, so a plan this marks feasible is
// feasible on chain for the same curated set, markup, edge and mint fee.

export const BPS = 10_000n;
export const NUM = 10n ** 36n; // FWA INVERSE_WEIGHT_NUMERATOR
export const MAX_BATCH = 5;
export const MAX_SHAPES_PER_PLAN = 40;
export const MAX_PLANS = 4;
export const KEEPER_MAX_GAS = 3_200_000n;
export const KEEPER_PRIORITY_CAP = 5n * 10n ** 7n; // 0.05 gwei over basefee
export const KEEPER_MAX_GAS_PRICE = 5n * 10n ** 9n;
export const KEEPER_INCENTIVE = 5n * 10n ** 14n;
/** Reward = 4/5 measured gas + (1/5 measured gas + 0.0005 ETH incentive), at min(bid, basefee + 0.05 gwei, 5 gwei). */
export const MAX_KEEPER_REWARD = KEEPER_MAX_GAS * KEEPER_MAX_GAS_PRICE + KEEPER_INCENTIVE;
/** Bound on one call's reward at a price (PoolBalancer._rewardBound). */
export const rewardBound = (price: bigint) => KEEPER_MAX_GAS * price + KEEPER_INCENTIVE;
/** Price an honest keeper is reimbursed at: min(basefee + 0.05 gwei, 5 gwei). */
export const rewardPrice = (baseFee: bigint) => (baseFee + KEEPER_PRIORITY_CAP > KEEPER_MAX_GAS_PRICE ? KEEPER_MAX_GAS_PRICE : baseFee + KEEPER_PRIORITY_CAP);
/** PoolBalancer.requiredReserve() for a plan at a basefee: deficit + refill-step rewards + worst batch + held reward
 *  + re-checkpoint reward. */
export function requiredReserveAt(target: Counts, have: Counts, mintFee: bigint, baseFee: bigint): bigint {
  let r = 0n;
  let missing = 0; // Shape units: refill steps are budgeted in Shapes minted, a pack counting its Shapes
  target.forEach((n, d) => {
    if (n > (have[d] ?? 0)) {
      r += BigInt(n - (have[d] ?? 0)) * prizeCost(d, mintFee);
      missing += (n - (have[d] ?? 0)) * SHAPES_IN[d];
    }
  });
  const steps = BigInt(Math.ceil(missing / 6) + 1);
  return r + steps * rewardBound(rewardPrice(baseFee)) + batchReserve(target, mintFee) + MAX_KEEPER_REWARD;
}

const E = 10n ** 18n;
/**
 * Prize sizes (wei), PoolBalancer's size table: 0-8 the mainnet Shapes ladder (each prize one Shape), 9-15 Draw Packs
 * holding the fewest Shapes that sum to the value. Not in value order; use BY_VALUE for that.
 */
export const DENOMS: readonly bigint[] = [
  E / 100n, E / 20n, E / 10n, E / 2n, E, 5n * E, 10n * E, 50n * E, 100n * E,
  E / 50n, (3n * E) / 100n, E / 5n, E / 4n, 2n * E, (5n * E) / 2n, 25n * E,
];
export const DENOM_LABELS = ['0.01', '0.05', '0.1', '0.5', '1', '5', '10', '50', '100', '0.02', '0.03', '0.2', '0.25', '2', '2.5', '25'];
/** Sizes that are single Shapes (the rest are packs). */
export const SHAPE_SIZES = 9;
export const isPack = (d: number) => d >= SHAPE_SIZES;
/** Shapes inside one prize of each size; each pays the Shapes mint fee (PoolBalancer.SHAPES_IN). */
export const SHAPES_IN: readonly number[] = [1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 3, 2, 3, 2, 3, 3];
/** The most Shapes any prize holds; the worst-batch reserve charges each prize this many mint fees. */
export const MAX_SHAPES_IN = 3;
/** Size indices smallest value first. */
export const BY_VALUE: readonly number[] = DENOMS.map((_, i) => i).sort((a, b) => (DENOMS[a] < DENOMS[b] ? -1 : 1));
/** ETH to create one prize of size d: its backing plus a mint fee per Shape inside. */
export const prizeCost = (d: number, mintFee: bigint) => DENOMS[d] + BigInt(SHAPES_IN[d]) * mintFee;
export const prizeLabel = (d: number) => `${DENOM_LABELS[d]} ETH ${isPack(d) ? 'Pack' : 'Shape'}`;

/** Billed gas from isolated mainnet-fork transactions (docs/GAS.md). Cost estimates only, never limits.
 *  The pool pays the keeper at most this (4/5 of measured gas is 80-99% of billed gas). */
export const GAS = {
  upkeepBase: 833_000, // reconcile + collect + replace 1 Shape + checkpoint
  perShape: 327_000, // each additional Shape replaced in the same denomination
  perExtraDenom: 153_000, // separate mint call for each further denomination
  reconcileOnly: 220_000, // curated-only or refund-only batch
  redeemPerShape: 120_000, // plan switch: withdraw + redeem each surplus Shape (~1.0M for 6)
};

export type Counts = number[]; // length 16, indexed like DENOMS

export interface PoolInputs {
  curatedBases: bigint[]; // creator-assigned values (wei), before markup
  markupBps: number;
  edgeBps: number; // FWA factory edgeBps (500 at time of review)
  mintFee: bigint; // Shapes.mintFee()
}

export interface Limits {
  maxDrawPrice: bigint; // FWA acquisitionFee ceiling (incl. edge, excl. VRF fee); enforced on chain
  minCuratedOddsBps: number; // enforced on chain
  maxShapeCapital: bigint; // planner preference only: the approved plans fix the capital on chain
}

export function packPlan(counts: Counts): bigint {
  let p = 0n;
  counts.forEach((c, d) => {
    if (c < 0 || c > 0xffff || !Number.isInteger(c)) throw new Error('bad count');
    p |= BigInt(c) << BigInt(16 * d);
  });
  return p;
}

export function unpackPlan(p: bigint): Counts {
  // Plans saved before pack sizes existed decode the same: their high counts are zero.
  return DENOMS.map((_, d) => Number((p >> BigInt(16 * d)) & 0xffffn));
}

export const listPrice = (base: bigint, markupBps: number) => (base * (BPS + BigInt(markupBps))) / BPS;
export const weightOf = (price: bigint) => NUM / price;

export function curatedTotals(bases: bigint[], markupBps: number) {
  let w = 0n;
  let wp = 0n;
  for (const b of bases) {
    const p = listPrice(b, markupBps);
    const wi = weightOf(p);
    w += wi;
    wp += wi * p;
  }
  return { w, wp };
}

export function shapeTotals(counts: Counts, markupBps: number) {
  let w = 0n;
  let wp = 0n;
  counts.forEach((n, d) => {
    if (!n) return;
    const p = listPrice(DENOMS[d], markupBps);
    const wi = weightOf(p);
    w += BigInt(n) * wi;
    wp += BigInt(n) * wi * p;
  });
  return { w, wp };
}

export const capitalOf = (counts: Counts) => counts.reduce((s, n, d) => s + BigInt(n) * DENOMS[d], 0n);
export const shapeCount = (counts: Counts) => counts.reduce((s, n) => s + n, 0);

/** Cash for the worst MAX_BATCH prize draws from a full plan (PoolBalancer._batchReserve): largest values first, each
 *  charged MAX_SHAPES_IN mint fees. */
export function batchReserve(counts: Counts, mintFee: bigint): bigint {
  let left = MAX_BATCH;
  let r = 0n;
  for (let k = BY_VALUE.length - 1; k >= 0 && left > 0; k--) {
    const d = BY_VALUE[k];
    const n = Math.min(left, counts[d] ?? 0);
    r += BigInt(n) * (DENOMS[d] + BigInt(MAX_SHAPES_IN) * mintFee);
    left -= n;
  }
  return r;
}

export interface Tier {
  label: string;
  kind: 'curated' | 'shape'; // 'shape': a Shape or Pack prize of size `size`
  size?: number;
  count: number;
  listPrice: bigint;
  oddsPpm: number; // combined probability of this tier per draw, parts per million
}

export interface Evaluation {
  feasible: boolean;
  reasons: string[];
  drawPrice: bigint; // FWA acquisitionFee
  curatedOddsBps: number; // floor, as checked on chain
  curatedOddsPpm: number;
  tiers: Tier[];
  capital: bigint;
  shapes: number;
  batchReserve: bigint;
  requiredReserve: bigint; // checkpoint reserve = batchReserve + MAX_KEEPER_REWARD; requiredReserve() on chain holds one more reward while open
  initialMintFees: bigint;
  ownerProceedsPerDraw: bigint; // EV paid to the owner on each delivered draw
}

export function evaluate(counts: Counts, inputs: PoolInputs, limits?: Limits): Evaluation {
  const c = curatedTotals(inputs.curatedBases, inputs.markupBps);
  const s = shapeTotals(counts, inputs.markupBps);
  const tW = c.w + s.w;
  const reasons: string[] = [];
  const capital = capitalOf(counts);
  const shapes = shapeCount(counts);
  const ev = tW === 0n ? 0n : (c.wp + s.wp) / tW;
  const drawPrice = (ev * (BPS + BigInt(inputs.edgeBps))) / BPS;
  const curatedOddsBps = tW === 0n ? 0 : Number((c.w * BPS) / tW);
  const curatedOddsPpm = tW === 0n ? 0 : Number((c.w * 1_000_000n) / tW);

  if (c.w === 0n) reasons.push('No curated NFTs');
  if (shapes === 0) reasons.push('Plan has no Shapes');
  if (shapes > MAX_SHAPES_PER_PLAN) reasons.push(`More than ${MAX_SHAPES_PER_PLAN} Shapes`);
  if (limits) {
    if (capital > limits.maxShapeCapital) reasons.push('Shapes capital above limit');
    if (drawPrice > limits.maxDrawPrice) reasons.push('Draw price above ceiling');
    if (c.w * BPS < BigInt(limits.minCuratedOddsBps) * tW) reasons.push('Curated odds below floor');
  }

  const tiers: Tier[] = [];
  inputs.curatedBases.forEach((b, i) => {
    const p = listPrice(b, inputs.markupBps);
    tiers.push({ label: `Curated #${i + 1}`, kind: 'curated', count: 1, listPrice: p, oddsPpm: Number((weightOf(p) * 1_000_000n) / (tW || 1n)) });
  });
  counts.forEach((n, d) => {
    if (!n) return;
    const p = listPrice(DENOMS[d], inputs.markupBps);
    tiers.push({ label: prizeLabel(d), kind: 'shape', size: d, count: n, listPrice: p, oddsPpm: Number((BigInt(n) * weightOf(p) * 1_000_000n) / (tW || 1n)) });
  });

  const br = batchReserve(counts, inputs.mintFee);
  return {
    feasible: reasons.length === 0,
    reasons,
    drawPrice,
    curatedOddsBps,
    curatedOddsPpm,
    tiers,
    capital,
    shapes,
    batchReserve: br,
    requiredReserve: br + MAX_KEEPER_REWARD,
    initialMintFees: counts.reduce((s, n, d) => s + BigInt(n * SHAPES_IN[d]) * inputs.mintFee, 0n),
    ownerProceedsPerDraw: ev,
  };
}

export interface CostAssumptions {
  gasPriceGwei: number; // expected effective keeper gas price
  drawsPerUpkeep: number; // average draws reconciled per upkeep (1..5)
  safety: number; // operating safety allowance, e.g. 0.25
}

const toEth = (x: bigint) => Number(x) / 1e18;

/**
 * Expected per-draw economics. With FWA's inverse weights, the expected listed value of the drawn
 * item equals the owner proceeds H, so the creator's expected gain before costs is H*m/(1+m).
 * Costs: for each prize drawn, a mint fee and keeper gas per Shape it holds (a pack replaces all its Shapes), plus
 * per-upkeep overhead.
 */
export function economics(counts: Counts, inputs: PoolInputs, a: CostAssumptions) {
  const ev = evaluate(counts, inputs);
  const m = inputs.markupBps / 10_000;
  const H = toEth(ev.ownerProceedsPerDraw);
  const gp = a.gasPriceGwei * 1e-9;
  const k = Math.max(1, Math.min(MAX_BATCH, a.drawsPerUpkeep));
  const perShapeCost = toEth(inputs.mintFee) + GAS.perShape * gp;
  // Expected Shapes replaced per draw: each prize tier's chance times the Shapes it holds.
  const shapesPerDraw = ev.tiers.reduce((s, t) => s + (t.kind === 'shape' ? (t.oddsPpm / 1e6) * SHAPES_IN[t.size!] : 0), 0);
  // Incentive: the withheld 1/5 of gas + 0.0005 ETH, capped by FWA's edge on the draw.
  const edgePerDraw = toEth((ev.drawPrice * BigInt(inputs.edgeBps)) / (BPS + BigInt(inputs.edgeBps)));
  const incentive = Math.min((GAS.upkeepBase / 5) * gp + toEth(KEEPER_INCENTIVE), edgePerDraw);
  const perUpkeep = (GAS.upkeepBase - GAS.perShape) * gp + incentive;
  const overhead = shapesPerDraw * perShapeCost + perUpkeep / k;
  const grossMargin = (H * m) / (1 + m);
  const H0 = H / (1 + m); // harmonic mean of unmarked values
  const net = grossMargin - overhead;
  const minMarkupBps = H0 > 0 ? Math.ceil(((overhead * (1 + a.safety)) / H0) * 10_000) : Infinity;
  return {
    ownerProceeds: H,
    grossMarginPerDraw: grossMargin,
    overheadPerDraw: overhead,
    expectedNetPerDraw: net,
    minMarkupBps,
    keeperCostPerUpkeepEth: (GAS.upkeepBase + (k - 1) * GAS.perShape) * gp + incentive,
    /** Model outlook, not a guarantee: individual draws and short runs can lose money either way. */
    outlook: (net > 0 ? 'sustainable' : 'loss') as 'sustainable' | 'loss',
    belowModeledMarkup: inputs.markupBps < minMarkupBps,
  };
}

/** Feasible plans over `allowed` denominations, best expected net margin first. Bounded search. */
export function enumeratePlans(
  inputs: PoolInputs,
  limits: Limits,
  allowed: number[],
  maxShapes = MAX_SHAPES_PER_PLAN,
  cost: CostAssumptions = { gasPriceGwei: 1, drawsPerUpkeep: 1, safety: 0.25 },
  maxResults = 20,
  maxVisits = 300_000,
) {
  const out: { counts: Counts; ev: Evaluation; net: number }[] = [];
  const counts: Counts = Array(DENOMS.length).fill(0);
  let visits = 0;
  const c = curatedTotals(inputs.curatedBases, inputs.markupBps);
  const rec = (i: number, left: number, capital: bigint) => {
    if (visits++ > maxVisits) return;
    if (i === allowed.length) {
      if (shapeCount(counts) === 0) return;
      const ev = evaluate(counts, inputs, limits);
      if (ev.feasible) out.push({ counts: [...counts], ev, net: economics(counts, inputs, cost).expectedNetPerDraw });
      return;
    }
    const d = allowed[i];
    for (let n = 0; n <= left; n++) {
      const cap = capital + BigInt(n) * DENOMS[d];
      if (cap > limits.maxShapeCapital) break;
      // Adding Shapes only lowers curated odds; stop once the floor is already broken.
      const s = shapeTotals(counts.map((x, j) => (j === d ? n : x)), inputs.markupBps);
      if (c.w * BPS < BigInt(limits.minCuratedOddsBps) * (c.w + s.w)) break;
      counts[d] = n;
      rec(i + 1, left - n, cap);
    }
    counts[d] = 0;
  };
  rec(0, maxShapes, 0n);
  out.sort((a, b) => b.net - a.net || (a.ev.capital < b.ev.capital ? -1 : 1));
  return { plans: out.slice(0, maxResults), truncated: visits > maxVisits, total: out.length };
}
