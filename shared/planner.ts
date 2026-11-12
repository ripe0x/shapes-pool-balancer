// Prize-mix planner. Prices, odds and the reserve use the same integer arithmetic as PoolBalancer and FWA
// StandardPool, so the numbers shown match the chain for the same curated set, markup, edge and mint fee.

export const BPS = 10_000n;
export const NUM = 10n ** 36n; // FWA INVERSE_WEIGHT_NUMERATOR
export const MAX_BATCH = 5;
export const MAX_OPS = 5; // PoolBalancer.MAX_OPS: Shape units restocked per upkeep call
export const MAX_SHAPES_PER_PLAN = 80; // PoolBalancer.MAX_SHAPES_PER_PLAN
export const KEEPER_MAX_GAS = 3_200_000n;
export const KEEPER_PRIORITY_CAP = 5n * 10n ** 7n; // 0.05 gwei over basefee
export const KEEPER_MAX_GAS_PRICE = 5n * 10n ** 9n;
export const KEEPER_INCENTIVE = 5n * 10n ** 14n;
/** Reward = measured gas x min(bid, basefee + 0.05 gwei, 5 gwei) + 0.0005 ETH, capped by the restocking fees earned. */
export const MAX_KEEPER_REWARD = KEEPER_MAX_GAS * KEEPER_MAX_GAS_PRICE + KEEPER_INCENTIVE;
/** Bound on one call's reward at a price (PoolBalancer._rewardBound). */
export const rewardBound = (price: bigint) => KEEPER_MAX_GAS * price + KEEPER_INCENTIVE;
/** Price an honest keeper is reimbursed at: min(basefee + 0.05 gwei, 5 gwei). */
export const rewardPrice = (baseFee: bigint) => (baseFee + KEEPER_PRIORITY_CAP > KEEPER_MAX_GAS_PRICE ? KEEPER_MAX_GAS_PRICE : baseFee + KEEPER_PRIORITY_CAP);
/** PoolBalancer.restockFee(): per Shape in a prize listed at `baseFee`; keepers are paid only from these fees. */
export const RESTOCK_FEE_GAS = 900_000n;
export const RESTOCK_FEE_FLAT = 2n * 10n ** 14n;
export const restockFeeAt = (baseFee: bigint) => RESTOCK_FEE_GAS * rewardPrice(baseFee) + RESTOCK_FEE_FLAT;
/** PoolBalancer.requiredReserve() while open: restoring `target` from `have`, one largest prize for each unreconciled
 *  draw and one spare, and a maximum keeper reward for each upkeep call that work takes plus one. */
export function requiredReserveAt(target: Counts, have: Counts, mintFee: bigint, unreconciled = 0): bigint {
  let r = 0n;
  let units = 0; // Shape units: upkeep steps are budgeted in Shapes minted, a pack counting its Shapes
  let largest = 0n;
  target.forEach((n, d) => {
    if (!n) return;
    const c = prizeCost(d, mintFee);
    if (c > largest) largest = c;
    const missing = n - (have[d] ?? 0);
    if (missing > 0) {
      r += BigInt(missing) * c;
      units += missing * SHAPES_IN[d];
    }
  });
  const draws = unreconciled + 1;
  r += BigInt(draws) * largest;
  units += draws * MAX_SHAPES_IN;
  return r + BigInt(Math.ceil(units / MAX_OPS) + 1) * MAX_KEEPER_REWARD;
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
  restockFee: bigint; // PoolBalancer.restockFee(), per Shape (restockFeeAt(basefee))
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
/** A prize's listed price less its restocking fees (PoolBalancer._prizeBase): cost plus the markup on its backing. */
export const prizeBase = (d: number, mintFee: bigint, markupBps: number) => prizeCost(d, mintFee) + (DENOMS[d] * BigInt(markupBps)) / BPS;
/** A prize's FWA listing price (PoolBalancer._fillDeficit). */
export const prizePrice = (d: number, i: Pick<PoolInputs, 'mintFee' | 'markupBps' | 'restockFee'>) =>
  prizeBase(d, i.mintFee, i.markupBps) + BigInt(SHAPES_IN[d]) * i.restockFee;
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

export function shapeTotals(counts: Counts, inputs: PoolInputs) {
  let w = 0n;
  let wp = 0n;
  counts.forEach((n, d) => {
    if (!n) return;
    const p = prizePrice(d, inputs);
    const wi = weightOf(p);
    w += BigInt(n) * wi;
    wp += BigInt(n) * wi * p;
  });
  return { w, wp };
}

export const capitalOf = (counts: Counts) => counts.reduce((s, n, d) => s + BigInt(n) * DENOMS[d], 0n);
export const shapeCount = (counts: Counts) => counts.reduce((s, n) => s + n, 0);

export interface Tier {
  label: string;
  kind: 'curated' | 'shape'; // 'shape': a Shape or Pack prize of size `size`
  size?: number;
  count: number;
  value: bigint; // what a winner receives: the creator's value, or the ETH a Shape or pack redeems for
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
  requiredReserve: bigint; // PoolBalancer.requiredReserve() with the target fully listed and reconciled
  initialMintFees: bigint;
  ownerProceedsPerDraw: bigint; // EV paid to the owner on each delivered draw
}

export function evaluate(counts: Counts, inputs: PoolInputs): Evaluation {
  const c = curatedTotals(inputs.curatedBases, inputs.markupBps);
  const s = shapeTotals(counts, inputs);
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

  const tiers: Tier[] = [];
  inputs.curatedBases.forEach((b, i) => {
    const p = listPrice(b, inputs.markupBps);
    tiers.push({ label: `Curated #${i + 1}`, kind: 'curated', count: 1, value: b, listPrice: p, oddsPpm: Number((weightOf(p) * 1_000_000n) / (tW || 1n)) });
  });
  counts.forEach((n, d) => {
    if (!n) return;
    const p = prizePrice(d, inputs);
    tiers.push({ label: prizeLabel(d), kind: 'shape', size: d, count: n, value: DENOMS[d], listPrice: p, oddsPpm: Number((BigInt(n) * weightOf(p) * 1_000_000n) / (tW || 1n)) });
  });

  return {
    feasible: reasons.length === 0,
    reasons,
    drawPrice,
    curatedOddsBps,
    curatedOddsPpm,
    tiers,
    capital,
    shapes,
    requiredReserve: requiredReserveAt(counts, counts, inputs.mintFee),
    initialMintFees: counts.reduce((s, n, d) => s + BigInt(n * SHAPES_IN[d]) * inputs.mintFee, 0n),
    ownerProceedsPerDraw: ev,
  };
}

const toEth = (x: bigint) => Number(x) / 1e18;

/**
 * Expected ETH per draw, by where it goes. Players pay for mint fees and keepers on top of the markup: a drawn Shape
 * prize's price is its cost, the creator's markup on its backing and its restocking fees; a curated NFT's is its value
 * plus the markup. Keepers are paid only from restocking fees, so the creator keeps at least the markup; fees keepers
 * never claim stay with the creator too.
 */
export function economics(counts: Counts, inputs: PoolInputs) {
  const ev = evaluate(counts, inputs);
  const m = BigInt(inputs.markupBps);
  let markup = 0;
  let mint = 0;
  let restock = 0;
  for (const t of ev.tiers) {
    const p = t.oddsPpm / 1e6; // this tier, all its listings
    if (t.kind === 'curated') markup += p * toEth(t.listPrice - t.value);
    else {
      const shapes = BigInt(SHAPES_IN[t.size!]);
      markup += p * toEth((DENOMS[t.size!] * m) / BPS);
      mint += p * toEth(shapes * inputs.mintFee);
      restock += p * toEth(shapes * inputs.restockFee);
    }
  }
  return {
    ownerProceeds: toEth(ev.ownerProceedsPerDraw),
    /** The creator's markup: what the creator keeps per draw, at least. A model average: prize luck moves short runs
     *  either way. */
    markupPerDraw: markup,
    mintFeesPerDraw: mint,
    restockFeesPerDraw: restock,
  };
}
