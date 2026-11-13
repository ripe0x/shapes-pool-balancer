// Prize-mix planner. Prices, odds and the reserve use the same integer arithmetic as PoolBalancer and FWA
// StandardPool, so the numbers shown match the chain for the same curated set, markup, edge and mint fee.

export const BPS = 10_000n;
export const NUM = 10n ** 36n; // FWA INVERSE_WEIGHT_NUMERATOR
/** PoolBalancer.MIN_MARKUP_BPS: the game's share of every markup. While the fund is below the reserve, only the markup
 *  above this is the creator's claimable profit; the rest refills the reserve. */
export const MIN_MARKUP_BPS = 1_000n;
export const MAX_BATCH = 5;
export const MAX_OPS = 5; // PoolBalancer.MAX_OPS: Shape units restocked per upkeep call
export const MAX_SHAPES_PER_PLAN = 80; // PoolBalancer.MAX_SHAPES_PER_PLAN
export const KEEPER_MAX_GAS = 3_200_000n;
export const KEEPER_PRIORITY_CAP = 5n * 10n ** 7n; // 0.05 gwei over basefee
export const KEEPER_MAX_GAS_PRICE = 5n * 10n ** 9n;
export const KEEPER_INCENTIVE = 10n ** 14n; // provisional, not owner-approved
export const KEEPER_OVERHEAD_GAS = 50_000n; // provisional: gas a transaction pays outside the measured span
/** Reward = (measured gas + 50,000) x min(bid, basefee + 0.05 gwei, 5 gwei) + 0.0001 ETH, for every call that
 *  reconciles a draw or lists a prize, from the creator's ETH. */
export const MAX_KEEPER_REWARD = (KEEPER_MAX_GAS + KEEPER_OVERHEAD_GAS) * KEEPER_MAX_GAS_PRICE + KEEPER_INCENTIVE;
/** Bound on one call's reward at a price (PoolBalancer._rewardBound). */
export const rewardBound = (price: bigint) => (KEEPER_MAX_GAS + KEEPER_OVERHEAD_GAS) * price + KEEPER_INCENTIVE;
/** Price an honest keeper is reimbursed at: min(basefee + 0.05 gwei, 5 gwei). */
export const rewardPrice = (baseFee: bigint) => (baseFee + KEEPER_PRIORITY_CAP > KEEPER_MAX_GAS_PRICE ? KEEPER_MAX_GAS_PRICE : baseFee + KEEPER_PRIORITY_CAP);
/** PoolBalancer.restockFee(): per Shape in a prize listed at `baseFee`; built into the draw price, the creator's income toward keeper pay. */
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
  /** FWA prices of curated NFTs already listed, matching the first entries of `curatedBases`. A listing keeps the
   *  markup in force when it was made; entries without a price are new and priced at `markupBps`. */
  curatedPrices?: bigint[];
  /** FWA prices of Shape prizes already listed, by size index (0..15): each size's array holds the actual listed price
   *  of each active prize of that size, which keeps the markup and fees in force when it was listed. Prizes beyond the
   *  listed count (new ones the plan adds) are priced at the current markup and fees. Parallels `curatedPrices`. */
  shapePrices?: bigint[][];
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

/** A curated NFT's FWA price: its live listing price if listed, else its value at the current markup. */
export const curatedPrice = (i: number, inputs: Pick<PoolInputs, 'curatedBases' | 'markupBps' | 'curatedPrices'>) =>
  inputs.curatedPrices?.[i] ?? listPrice(inputs.curatedBases[i], inputs.markupBps);

export function curatedTotals(inputs: Pick<PoolInputs, 'curatedBases' | 'markupBps' | 'curatedPrices'>) {
  let w = 0n;
  let wp = 0n;
  for (let i = 0; i < inputs.curatedBases.length; i++) {
    const p = curatedPrice(i, inputs);
    const wi = weightOf(p);
    w += wi;
    wp += wi * p;
  }
  return { w, wp };
}

/** The FWA price of the k-th listed prize of size `d`: the price it was listed at if it is already listed, else the
 *  price a new prize of that size takes at the current markup and fees. */
export const shapePriceAt = (d: number, k: number, inputs: Pick<PoolInputs, 'mintFee' | 'markupBps' | 'restockFee' | 'shapePrices'>) =>
  inputs.shapePrices?.[d]?.[k] ?? prizePrice(d, inputs);

export function shapeTotals(counts: Counts, inputs: PoolInputs) {
  let w = 0n;
  let wp = 0n;
  counts.forEach((n, d) => {
    for (let k = 0; k < n; k++) {
      const p = shapePriceAt(d, k, inputs);
      const wi = weightOf(p);
      w += wi;
      wp += wi * p;
    }
  });
  return { w, wp };
}

/** Unsettled draws a fully stocked board still admits a purchase with (PoolBalancer's fill gate counts each
 *  unreconciled draw as the loss of a 0.01 ETH prize's weight, 1e36 / backing, and admits while 70% of the target's
 *  weight remains), capped at FWA's MAX_BATCH. Below MAX_BATCH the board pauses while that many draws are unsettled. */
export function pendingDrawsAdmitted(counts: Counts): number {
  const w = counts.reduce((s, n, d) => s + BigInt(n) * (NUM / DENOMS[d]), 0n);
  const k = Number((3_000n * w) / (BPS * (NUM / DENOMS[0])));
  return Math.min(k, MAX_BATCH);
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
  const c = curatedTotals(inputs);
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
    const p = curatedPrice(i, inputs);
    tiers.push({ label: `Curated #${i + 1}`, kind: 'curated', count: 1, value: b, listPrice: p, oddsPpm: Number((weightOf(p) * 1_000_000n) / (tW || 1n)) });
  });
  counts.forEach((n, d) => {
    if (!n) return;
    // Each listed prize of this size keeps its own price (different markup/fees at listing time), so weigh them one by
    // one; new prizes the plan adds beyond the listed count fall back to the current price.
    let dw = 0n;
    for (let k = 0; k < n; k++) dw += weightOf(shapePriceAt(d, k, inputs));
    tiers.push({ label: prizeLabel(d), kind: 'shape', size: d, count: n, value: DENOMS[d], listPrice: shapePriceAt(d, 0, inputs), oddsPpm: Number((dw * 1_000_000n) / (tW || 1n)) });
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

/** Keeper pay inputs (PoolBalancer, DECISIONS 73; mainnet fork, test/scenario/PriceCaps.t.sol): reward =
 *  (measured gas + 50,000) x price + 0.0001 ETH. One draw reconciled and one 0.01 Shape restocked measured about
 *  811k gas, an NFT-win reconcile about 137k; both below include the 50,000 overhead. */
const KEEPER_GAS_PER_SHAPE = 861_000n;
const KEEPER_GAS_RECONCILE = 187_000n;
const KEEPER_FLAT = 10n ** 14n;

/**
 * Expected ETH per draw, by where it goes. Players pay for mint fees and keepers on top of the markup: a drawn Shape
 * prize's price is its cost, the creator's markup on its backing and its restocking fees; a curated NFT's is its value
 * plus the markup. The restocking fee is the creator's income toward keeper pay; the creator's ETH pays every keeper
 * call, including reconciles of draws that time out or win an NFT, which bring no fee (DECISIONS 73).
 */
export function economics(counts: Counts, inputs: PoolInputs) {
  const ev = evaluate(counts, inputs);
  const m = BigInt(inputs.markupBps);
  // The game's share (the first MIN_MARKUP_BPS of markup) refills the reserve; only the markup above it is the creator's
  // claimable profit while the fund is below the reserve. Curated NFTs contribute nothing to profit while short.
  const claimM = m > MIN_MARKUP_BPS ? m - MIN_MARKUP_BPS : 0n;
  let markup = 0;
  let claimable = 0;
  let mint = 0;
  let restock = 0;
  let keeper = 0;
  // The keeper's reimbursed gas price, recovered from the restocking fee (900k gas x price + 0.0002 ETH).
  const price = inputs.restockFee > RESTOCK_FEE_FLAT ? (inputs.restockFee - RESTOCK_FEE_FLAT) / 900_000n : 0n;
  for (const t of ev.tiers) {
    const p = t.oddsPpm / 1e6; // this tier, all its listings
    if (t.kind === 'curated') {
      markup += p * toEth(t.listPrice - t.value);
      keeper += p * toEth(KEEPER_GAS_RECONCILE * price + KEEPER_FLAT);
    } else {
      const shapes = BigInt(SHAPES_IN[t.size!]);
      markup += p * toEth((DENOMS[t.size!] * m) / BPS);
      claimable += p * toEth((DENOMS[t.size!] * claimM) / BPS);
      mint += p * toEth(shapes * inputs.mintFee);
      restock += p * toEth(shapes * inputs.restockFee);
      keeper += p * Number(shapes) * toEth(KEEPER_GAS_PER_SHAPE * price + KEEPER_FLAT);
    }
  }
  return {
    ownerProceeds: toEth(ev.ownerProceedsPerDraw),
    /** The markup priced into every draw: what the creator keeps per draw on average (all of it is withdrawable once the
     *  reserve is full). A model average: prize luck moves short runs either way. */
    markupPerDraw: markup,
    /** What the creator can withdraw per draw while the fund is below the reserve: the Shape markup above
     *  MIN_MARKUP_BPS. A model average: prize luck moves short runs either way. */
    claimablePerDraw: claimable,
    mintFeesPerDraw: mint,
    restockFeesPerDraw: restock,
    /** Keeper pay per draw, from the creator's ETH: each Shape won is replaced by its own upkeep call and each NFT win is
     *  reconciled by one (batched calls cost less, so this is an upper estimate). */
    keeperPayPerDraw: keeper,
    /** What the creator keeps per draw: markup plus restocking fees, less keeper pay. A model average. */
    keptPerDraw: markup + restock - keeper,
  };
}
