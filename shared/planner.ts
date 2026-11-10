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
export const KEEPER_MAX_GAS_PRICE = 2n * 10n ** 9n;
export const KEEPER_INCENTIVE = 5n * 10n ** 14n;
/** Reimbursed gas is 4/5 of measured gas (EIP-3529 refund bound). */
export const MAX_KEEPER_REWARD = ((KEEPER_MAX_GAS * 4n) / 5n) * KEEPER_MAX_GAS_PRICE + KEEPER_INCENTIVE;

const E = 10n ** 18n;
/** Mainnet Shapes ladder (wei), denomination index 0..8. */
export const DENOMS: readonly bigint[] = [
  E / 100n, E / 20n, E / 10n, E / 2n, E, 5n * E, 10n * E, 50n * E, 100n * E,
];
export const DENOM_LABELS = ['0.01', '0.05', '0.1', '0.5', '1', '5', '10', '50', '100'];

/** Billed gas from isolated mainnet-fork transactions (docs/GAS.md). Cost estimates only, never limits.
 *  The pool pays the keeper at most this (4/5 of measured gas is 80-99% of billed gas). */
export const GAS = {
  upkeepBase: 833_000, // reconcile + collect + replace 1 Shape + checkpoint
  perShape: 327_000, // each additional Shape replaced in the same denomination
  perExtraDenom: 153_000, // separate mint call for each further denomination
  reconcileOnly: 220_000, // curated-only or refund-only batch
  redeemPerShape: 120_000, // plan switch: withdraw + redeem each surplus Shape (~1.0M for 6)
};

export type Counts = number[]; // length 9

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

/** Cash for the worst MAX_BATCH Shape draws from a full plan (PoolBalancer._batchReserve). */
export function batchReserve(counts: Counts, mintFee: bigint): bigint {
  let left = MAX_BATCH;
  let r = 0n;
  for (let d = 8; d >= 0 && left > 0; d--) {
    const n = Math.min(left, counts[d]);
    r += BigInt(n) * (DENOMS[d] + mintFee);
    left -= n;
  }
  return r;
}

export interface Tier {
  label: string;
  kind: 'curated' | 'shape';
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
  requiredReserve: bigint; // batchReserve + MAX_KEEPER_REWARD
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
    tiers.push({ label: `${DENOM_LABELS[d]} ETH Shape`, kind: 'shape', count: n, listPrice: p, oddsPpm: Number((BigInt(n) * weightOf(p) * 1_000_000n) / (tW || 1n)) });
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
    initialMintFees: BigInt(shapes) * inputs.mintFee,
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
 * Costs: Shapes mint fee and keeper gas for each Shape drawn, plus per-upkeep overhead.
 */
export function economics(counts: Counts, inputs: PoolInputs, a: CostAssumptions) {
  const ev = evaluate(counts, inputs);
  const m = inputs.markupBps / 10_000;
  const H = toEth(ev.ownerProceedsPerDraw);
  const pShape = 1 - ev.curatedOddsPpm / 1e6;
  const gp = a.gasPriceGwei * 1e-9;
  const k = Math.max(1, Math.min(MAX_BATCH, a.drawsPerUpkeep));
  const perShapeCost = toEth(inputs.mintFee) + GAS.perShape * gp;
  // The contract caps the incentive at FWA's edge on one draw.
  const edgePerDraw = toEth((ev.drawPrice * BigInt(inputs.edgeBps)) / (BPS + BigInt(inputs.edgeBps)));
  const incentive = Math.min(toEth(KEEPER_INCENTIVE), edgePerDraw);
  const perUpkeep = (GAS.upkeepBase - GAS.perShape) * gp + incentive;
  const overhead = pShape * perShapeCost + perUpkeep / k;
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
  const counts: Counts = Array(9).fill(0);
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
