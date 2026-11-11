// Monte Carlo economic simulation of one Balancer-operated FWA pool.
// Exact FWA selection (weights 1e36/price, uniform target in [0, totalWeight)), FWA's 10% settlement
// slippage refund, the Balancer's one-batch admission gate, approved fallback plans with first-feasible
// selection, MAX_OPS inventory operations per upkeep, worst-batch reserve and keeper reward bounds.
// Two models: 'current' (surplus Shapes redeemed, 4/5 gas at basefee + 0.05 gwei, 2 gwei cap) and
// 'previous' (surplus kept as spares, full gas + 45k at basefee + 2 gwei, 10 gwei cap).
// Time advances in minutes. Run: npm run sim [-- --runs 40]
import { writeFileSync } from 'node:fs';
import { economics, evaluate, BPS, DENOMS, GAS, KEEPER_INCENTIVE, SHAPES_IN, listPrice, prizeCost, weightOf, type Counts } from '../shared/planner';

const GWEI = 10n ** 9n;
const eth = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const toEth = (x: bigint) => Number(x) / 1e18;
const MAX_OPS = 6;
const MAX_BATCH = 5;

export type Model = string;
/** 'final': 4/5 gas + (1/5 gas + incentive); 'cover': 4/5 gas + max(incentive, 1/5 gas + 21k + 0.0001);
 *  'fixed': gas x gasNum/gasDen + incentive; 'fwa': FWA V2 sponsored rule (gas + 55k at min(bid, min(basefee, 5) + 1)
 *  gwei, gas <= 2.1M, payout <= 0.02 ETH, no incentive). */
type IncentiveMode = 'fixed' | 'cover' | 'final' | 'fwa';
const MARGIN = 10n ** 14n; // 0.0001 ETH ('cover' only)
/** eth_estimateGas exceeds billed gas by this much (median of 25 keeper txs, launch rehearsal); keepers cost with it. */
const ESTIMATE_GAP = 78_000;
const finalPolicy = (prio: bigint) => ({ priorityCap: prio, maxPrice: 5n * GWEI, gasNum: 4n, gasDen: 5n, overhead: 0n, capIncentive: true, bid: prio, incentive: KEEPER_INCENTIVE, mode: 'final' as IncentiveMode, maxReward: 3_200_000n * 5n * GWEI + KEEPER_INCENTIVE, keepSpares: false });
const MODEL: Record<string, ReturnType<typeof finalPolicy>> = {
  current: finalPolicy(GWEI / 20n),
  'final, priority 0.05 gwei': finalPolicy(GWEI / 20n),
  'final, priority 0.1 gwei': finalPolicy(GWEI / 10n),
  'final, priority 0.25 gwei': finalPolicy(GWEI / 4n),
  'final, priority 0.5 gwei': finalPolicy(GWEI / 2n),
  'final, priority 1 gwei': finalPolicy(GWEI),
  'previous (cover + 0.0001)': { ...finalPolicy(GWEI / 20n), mode: 'cover', maxReward: 3_221_000n * 5n * GWEI + MARGIN },
  'FWA V2 rule, permissionless': { ...finalPolicy(GWEI), mode: 'fwa', capIncentive: false, maxReward: 2n * 10n ** 16n },
  'current+spares': { ...finalPolicy(GWEI / 20n), keepSpares: true },
  'original PR (gas + 45k, 2 gwei priority, 10 gwei cap)': { priorityCap: 2n * GWEI, maxPrice: 10n * GWEI, gasNum: 1n, gasDen: 1n, overhead: 45_000n, capIncentive: false, bid: 2n * GWEI, incentive: KEEPER_INCENTIVE, mode: 'fixed', maxReward: 3_200_000n * 10n * GWEI + KEEPER_INCENTIVE, keepSpares: true },
};
MODEL.previous = { ...MODEL['original PR (gas + 45k, 2 gwei priority, 10 gwei cap)'], bid: GWEI / 10n };

/** Priority fee included transactions needed to land in the next block (block p10), 90 days of eth_feeHistory. */
const PRIO_P10: [number, [number, number, number]][] = [[0.3, [0, 0.001, 0.05]], [1, [0.0001, 0.0212, 0.2255]], [2, [0.0013, 0.1, 0.9947]], [5, [0.01, 0.1375, 1.5438]], [Infinity, [0.0003, 0.15, 1.5616]]];
function requiredPriority(baseGwei: number, u: number) {
  const [, [p50, p90, p99]] = PRIO_P10.find(([hi]) => baseGwei < hi)!;
  const lerp = (a: number, b: number, t: number) => (a <= 0 ? b * t : Math.exp(Math.log(a) + t * (Math.log(b) - Math.log(a))));
  if (u < 0.5) return p50 * (u / 0.5);
  if (u < 0.9) return lerp(p50, p90, (u - 0.5) / 0.4);
  if (u < 0.99) return lerp(p90, p99, (u - 0.9) / 0.09);
  return p99 * (1 + (u - 0.99) * 100);
}
/** Gas outside the measured span; billed gas ≈ measured + this (fork receipts, docs/GAS.md). */
const OUTSIDE_SPAN = 30_000;
/** Withdrawing a listing without redeeming (previous model) vs withdraw + redeem (current). */
const WITHDRAW_ONLY_GAS = 90_000;

export interface Scenario {
  name: string;
  curated: number[]; // creator values (ETH)
  plans: Counts[]; // approved plans, first preferred
  maxDrawPrice?: number; // ETH; default: no ceiling
  minOddsBps?: number; // default 0
  markupBps: number;
  mintFeeEth: number;
  mintFeeChange?: { day: number; feeEth: number };
  gasGwei: number; // median basefee
  gasSpikeProb?: number; // per keeper check
  gasSpikeGwei?: number;
  keeperEveryMin: number;
  drawsPerDay: number;
  days: number;
  inactive?: { fromDay: number; days: number }; // no keeper and no demand
  keeperAbsent?: { fromDay: number; days: number }; // demand continues, no keeper
  expensiveStreakBatches?: number; // first N batches draw the most expensive Shapes
  depositEth: number;
  noRestock?: boolean; // creator never replaces drawn curated NFTs
  gasModel?: 'measured' | 'lognormal'; // default 'measured': mainnet basefee distribution (docs/GAS.md)
  restockDelayHours?: number; // creator relists a drawn curated NFT after this delay (default: next upkeep)
}

interface Item { kind: 'c' | 's'; base: bigint; price: bigint; w: bigint; d: number }

/** Mainnet basefee quantiles (gwei), 184,320 blocks sampled over the 90 days to block 26,385,025. */
const BASEFEE_Q: [number, number][] = [[0, 0.02], [0.5, 0.078], [0.9, 0.333], [0.959, 0.76], [0.9685, 1], [0.98, 2], [0.9842, 3], [0.99, 4.64], [0.999, 29.9], [1, 51]];
function measuredBasefee(u: number) {
  for (let i = 1; i < BASEFEE_Q.length; i++) {
    const [q1, v1] = BASEFEE_Q[i];
    const [q0, v0] = BASEFEE_Q[i - 1];
    if (u <= q1) return Math.exp(Math.log(v0) + ((u - q0) / (q1 - q0)) * (Math.log(v1) - Math.log(v0)));
  }
  return BASEFEE_Q.at(-1)![1];
}

const M64 = (1n << 64n) - 1n;
const mix64 = (x: bigint) => {
  let z = x & M64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
  return z ^ (z >> 31n);
};

/** SplitMix64. The seed is hashed into the start state so different seeds are unrelated streams. */
function rng(seed: number) {
  let s = mix64(BigInt(seed) * 0xd1342543de82ef95n + 0x632be59bd9b4e019n);
  const next64 = () => {
    s = (s + 0x9e3779b97f4a7c15n) & M64;
    return mix64(s);
  };
  return {
    u: () => Number(next64() >> 11n) / 2 ** 53,
    big: () => (next64() << 192n) | (next64() << 128n) | (next64() << 64n) | next64(),
  };
}

/** Worst MAX_BATCH replacements; `spares` (previous model) cover draws of their denomination. */
function worstBatch(plan: Counts, fee: bigint, spares: number[]) {
  let left = MAX_BATCH;
  let r = 0n;
  for (let d = 8; d >= 0 && left > 0; d--) {
    const n = Math.min(left, Math.max(0, plan[d] - spares[d]));
    r += BigInt(n) * prizeCost(d, fee);
    left -= n;
  }
  return r;
}

export function run(sc: Scenario, seed: number, model: Model = 'current') {
  const M = MODEL[model];
  const r = rng(seed);
  const m = sc.markupBps;
  const edge = 500n;
  let fee = eth(sc.mintFeeEth);
  let balance = eth(sc.depositEth);
  let pendingProceeds = 0n;
  const active: Item[] = [];
  const spares = Array(DENOMS.length).fill(0) as number[];
  let planIdx = 0;
  const mk = (kind: 'c' | 's', base: bigint, d = -1): Item => {
    const price = listPrice(base, m);
    return { kind, base, price, w: weightOf(price), d };
  };
  for (const c of sc.curated) active.push(mk('c', eth(c)));
  const stats = {
    draws: 0, refunds: 0, attempts: 0, rejected: 0, proceeds: 0n, mintFees: 0n, keeperPaid: 0n, keeperRuns: 0,
    redeemGasEth: 0n, redeemedBacking: 0n, backingLost: 0n, curatedLost: 0n, minBalance: balance,
    minutesClosed: 0, minutesOpenable: 0, closures: 0, upkeepsSkippedForGas: 0, attempts2: 0, sends: 0, inclusionSeconds: 0, keeperProfit: 0n, planSwitches: 0, reserveSum: 0n, reserveSamples: 0,
    endBalance: 0n, endRequired: 0n, endShapes: 0n, closedReasons: {} as Record<string, number>,
  };

  let cpValid = false;
  let reason = 'needs upkeep';
  let unreconciled: Item[] = [];
  let batchSettlesAt = -1;
  let batch: { escrowedFee: bigint; basePrice: bigint }[] = [];
  let batches = 0;
  let batchSinceUpkeep = false;
  const restockQueue: { at: number; base: bigint }[] = [];
  let wasOpen = false;

  const totals = () => {
    let w = 0n, wp = 0n;
    for (const it of active) { w += it.w; wp += it.w * it.price; }
    return { w, wp };
  };
  const drawPrice = () => { const t = totals(); return t.w === 0n ? 0n : ((t.wp / t.w) * (BPS + edge)) / BPS; };
  const ownerBase = () => { const t = totals(); return t.w === 0n ? 0n : t.wp / t.w; };
  const shapeCounts = () => { const c = Array(DENOMS.length).fill(0) as number[]; for (const it of active) if (it.kind === 's') c[it.d]++; return c; };
  const limits = { maxDrawPrice: sc.maxDrawPrice ? eth(sc.maxDrawPrice) : 10n ** 30n, minCuratedOddsBps: sc.minOddsBps ?? 0, maxShapeCapital: 10n ** 30n };
  const feasible = (p: Counts) => evaluate(p, { curatedBases: active.filter((i) => i.kind === 'c').map((i) => i.base), markupBps: m, edgeBps: 500, mintFee: fee }, limits).feasible;
  const required = () => {
    const plan = padded(sc.plans[planIdx]);
    const have = shapeCounts();
    let deficit = 0n;
    const credit = Array(DENOMS.length).fill(0) as number[];
    for (let d = 0; d < DENOMS.length; d++) {
      const covered = have[d] + (M.keepSpares ? spares[d] : 0);
      if ((plan[d] ?? 0) > covered) deficit += BigInt((plan[d] ?? 0) - covered) * prizeCost(d, fee);
      if (M.keepSpares) credit[d] = Math.min(spares[d], Math.max(0, covered - plan[d]));
    }
    return deficit + worstBatch(plan, fee, credit) + M.maxReward;
  };

  const settleBatch = () => {
    for (const b of batch) {
      const live = drawPrice();
      const tol = (b.escrowedFee * 1000n) / BPS;
      if (active.length === 0 || (live > b.escrowedFee ? live - b.escrowedFee : b.escrowedFee - live) > tol) { stats.refunds++; continue; }
      const t = totals();
      let idx: number;
      if (batches <= (sc.expensiveStreakBatches ?? 0)) {
        idx = active.reduce((best, it, i) => (it.kind === 's' && (best < 0 || it.base > active[best].base) ? i : best), -1);
        if (idx < 0) idx = 0;
      } else {
        let target = r.big() % t.w;
        idx = 0;
        while (target >= active[idx].w) { target -= active[idx].w; idx++; }
      }
      const [it] = active.splice(idx, 1);
      stats.draws++;
      pendingProceeds += b.basePrice;
      stats.proceeds += b.basePrice;
      if (it.kind === 's') stats.backingLost += it.base; else stats.curatedLost += it.base;
      unreconciled.push(it);
    }
    batch = [];
  };

  /** On-chain reward for this model. Purchase-caused work is capped by FWA's edge on the reconciled draws. */
  const rewardFor = (measured: bigint, price: bigint, work: boolean, draws: number) => {
    if (M.mode === 'fwa') {
      const g = measured + 55_000n > 2_100_000n ? 2_100_000n : measured + 55_000n;
      const r = g * price;
      return r > 2n * 10n ** 16n ? 2n * 10n ** 16n : r;
    }
    const gasPart = ((measured + M.overhead) * M.gasNum) / M.gasDen * price;
    const rest = M.mode === 'final' ? (measured - (measured * 4n) / 5n) * price : 0n;
    if (!work) return gasPart;
    let inc = M.incentive + rest;
    if (M.mode === 'cover') {
      const cover = (measured - (measured * 4n) / 5n + 21_000n) * price + MARGIN;
      if (cover > inc) inc = cover;
    }
    if (M.capIncentive && draws > 0) {
      const credit = (BigInt(draws) * drawPrice() * edge) / (BPS + edge);
      if (credit < inc) inc = credit;
    }
    return gasPart + inc;
  };

  const priceFor = (basefee: bigint) => {
    if (M.mode === 'fwa') {
      const cap = (basefee > 5n * GWEI ? 5n * GWEI : basefee) + GWEI;
      return basefee + M.bid > cap ? cap : basefee + M.bid;
    }
    let price = basefee + M.bid;
    if (price > basefee + M.priorityCap) price = basefee + M.priorityCap;
    if (price > M.maxPrice) price = M.maxPrice;
    return price;
  };

  const upkeep = (t: number, basefee: bigint) => {
    if (batch.length) return; // FWA batch unresolved: PoolBusy
    const draws = unreconciled.length;
    const reconciledBatch = batchSinceUpkeep;
    batchSinceUpkeep = false;
    balance += pendingProceeds; pendingProceeds = 0n;
    for (const it of unreconciled) {
      if (it.kind !== 'c' || sc.noRestock) continue;
      restockQueue.push({ at: t + (sc.restockDelayHours ?? 0) * 60, base: it.base });
    }
    unreconciled = [];
    let gas = draws ? GAS.reconcileOnly : 120_000;
    let ops = 0;
    const haveCurated = active.some((i) => i.kind === 'c');
    if (!haveCurated) { reason = 'no curated'; cpValid = false; }
    else {
      // Keep the active plan while feasible, else the first feasible approved plan.
      let next = feasible(sc.plans[planIdx]) ? planIdx : sc.plans.findIndex(feasible);
      if (next < 0) { reason = 'no feasible plan'; cpValid = false; next = planIdx; }
      else {
        if (next !== planIdx) stats.planSwitches++;
        planIdx = next;
        const plan = padded(sc.plans[planIdx]);
        const have = shapeCounts();
        // Surplus first (bounded by MAX_OPS), then deficits.
        for (let d = 0; d < DENOMS.length && ops < MAX_OPS; d++) {
          while (have[d] > plan[d] && ops < MAX_OPS) {
            const i = active.findIndex((x) => x.kind === 's' && x.d === d);
            active.splice(i, 1); have[d]--; ops++;
            if (!M.keepSpares) { balance += DENOMS[d]; stats.redeemedBacking += DENOMS[d]; gas += GAS.redeemPerShape; stats.redeemGasEth += BigInt(GAS.redeemPerShape) * basefee; }
            else { spares[d]++; gas += WITHDRAW_ONLY_GAS; }
          }
        }
        let denomsMinted = 0;
        let funded = true;
        for (let d = 0; d < DENOMS.length && ops < MAX_OPS; d++) {
          let need = Math.min(plan[d] - have[d], MAX_OPS - ops);
          if (need <= 0) continue;
          if (M.keepSpares) {
            const use = Math.min(spares[d], need);
            spares[d] -= use; need -= use; ops += use; have[d] += use;
            for (let i = 0; i < use; i++) active.push(mk('s', DENOMS[d], d));
            gas += use * GAS.perShape;
          }
          if (need <= 0) continue;
          const c = BigInt(need) * prizeCost(d, fee);
          if (balance < c) { funded = false; break; }
          balance -= c; stats.mintFees += BigInt(need * SHAPES_IN[d]) * fee; ops += need; have[d] += need; denomsMinted++;
          for (let i = 0; i < need; i++) active.push(mk('s', DENOMS[d], d));
          gas += GAS.perShape * need + (denomsMinted > 1 ? GAS.perExtraDenom : 0);
        }
        const full = plan.every((n, d) => have[d] === n);
        if (!funded) { reason = 'insufficient reserve'; cpValid = false; }
        else if (!full) { reason = 'needs upkeep'; cpValid = false; }
        else if (balance < required()) { reason = 'insufficient reserve'; cpValid = false; }
        else { cpValid = true; reason = 'open'; }
      }
    }
    // Keeper reward as computed on chain for this model.
    const work = ops > 0 || draws > 0;
    if (work || reconciledBatch) {
      const price = priceFor(basefee);
      const measured = BigInt(gas - OUTSIDE_SPAN);
      let reward = rewardFor(measured, price, work, draws);
      if (reward > balance) reward = balance;
      balance -= reward; stats.keeperPaid += reward;
    }
    stats.keeperRuns++;
    stats.reserveSum += required(); stats.reserveSamples++;
  };

  const minutes = sc.days * 1440;
  const perMin = sc.drawsPerDay / 1440 / 3; // purchase transactions; batch size 1..5 uniform => mean 3
  for (let t = 0; t < minutes; t++) {
    const day = t / 1440;
    if (sc.mintFeeChange && day >= sc.mintFeeChange.day) fee = eth(sc.mintFeeChange.feeEth);
    const inactive = sc.inactive && day >= sc.inactive.fromDay && day < sc.inactive.fromDay + sc.inactive.days;
    const keeperGone = inactive || (sc.keeperAbsent && day >= sc.keeperAbsent.fromDay && day < sc.keeperAbsent.fromDay + sc.keeperAbsent.days);

    if (batch.length && t >= batchSettlesAt) settleBatch();
    // Creator relists drawn curated NFTs when due (needs FWA idle); the edit invalidates the checkpoint.
    if (!batch.length && !unreconciled.length) {
      for (let i = restockQueue.length - 1; i >= 0; i--) {
        if (restockQueue[i].at <= t) { active.push(mk('c', restockQueue[i].base)); restockQueue.splice(i, 1); cpValid = false; reason = 'needs upkeep'; }
      }
    }

    if (!keeperGone && t % sc.keeperEveryMin === 0 && (unreconciled.length || !cpValid) && !batch.length) {
      const spike = r.u() < (sc.gasSpikeProb ?? 0);
      const g = spike ? sc.gasSpikeGwei ?? sc.gasGwei : sc.gasModel === 'lognormal' ? sc.gasGwei * Math.exp((r.u() - 0.5) * 0.8) : measuredBasefee(r.u());
      const basefee = BigInt(Math.round(g * 1e9));
      // A rational keeper sends only when the simulated reward covers its cost estimated with eth_estimateGas
      // (billed + ESTIMATE_GAP); competing keepers bid the reimbursed priority cap.
      const n = unreconciled.length;
      const billedGas = n ? GAS.upkeepBase + (n - 1) * GAS.perShape : 3_000_000;
      const price = priceFor(basefee);
      const estReward = rewardFor(BigInt(billedGas - OUTSIDE_SPAN), price, true, n);
      const estCost = BigInt(billedGas + ESTIMATE_GAP) * (basefee + M.bid);
      stats.attempts2++;
      if ((M.mode !== 'fwa' && basefee + M.bid > M.maxPrice) || estReward < estCost) stats.upkeepsSkippedForGas++;
      else {
        // Inclusion: blocks until the bid clears the priority that block's cheapest included transactions paid.
        let blocks = 1;
        while (blocks < 50 && Number(M.bid) / 1e9 < requiredPriority(g, r.u())) blocks++;
        stats.inclusionSeconds += blocks * 12;
        stats.sends++;
        stats.keeperProfit += estReward - BigInt(billedGas) * (basefee + M.bid);
        upkeep(t, basefee);
      }
    }

    if (!inactive) {
      stats.minutesOpenable++;
      const open = cpValid && !batch.length && unreconciled.length === 0;
      if (!open) {
        stats.minutesClosed++;
        const k = batch.length || unreconciled.length ? 'awaiting upkeep' : reason;
        stats.closedReasons[k] = (stats.closedReasons[k] ?? 0) + 1;
        if (wasOpen && k !== 'awaiting upkeep') stats.closures++;
      }
      wasOpen = open;
      if (r.u() < perMin) {
        stats.attempts++;
        if (!open) stats.rejected++;
        else {
          const size = 1 + Math.floor(r.u() * 5);
          const f = drawPrice();
          const base = ownerBase();
          for (let i = 0; i < size; i++) batch.push({ escrowedFee: f, basePrice: base });
          batches++;
          cpValid = false;
          batchSinceUpkeep = true;
          batchSettlesAt = t + 2; // VRF confirmations + callback
        }
      }
    }
    if (balance < stats.minBalance) stats.minBalance = balance;
  }
  stats.endBalance = balance + pendingProceeds;
  stats.endRequired = required();
  // Shapes still owned (listed + spares) are worth their backing at unwind.
  stats.endShapes = active.filter((i) => i.kind === 's').reduce((s, i) => s + i.base, 0n) + spares.reduce((s, n, d) => s + BigInt(n) * DENOMS[d], 0n);
  return stats;
}

export function summarize(sc: Scenario, runs: number, model: Model = 'current') {
  const res = Array.from({ length: runs }, (_, i) => run(sc, i + 1, model));
  // Creator result: proceeds - mint fees - keeper rewards - value delivered to players (Shape backing and
  // creator-assigned curated value). Redemption returns backing that was never "lost", so it is neutral.
  const net = res.map((s) => toEth(s.proceeds - s.mintFees - s.keeperPaid - s.backingLost - s.curatedLost)).sort((a, b) => a - b);
  const mean = (f: (s: (typeof res)[0]) => number) => res.reduce((a, s) => a + f(s), 0) / runs;
  const q = (p: number) => net[Math.min(runs - 1, Math.floor(p * runs))];
  const reasons: Record<string, number> = {};
  for (const s of res) for (const [k, v] of Object.entries(s.closedReasons)) if (k !== 'awaiting upkeep') reasons[k] = (reasons[k] ?? 0) + v;
  const topReason = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '-';
  const row = {
    name: sc.name,
    draws: mean((s) => s.draws),
    revenue: mean((s) => toEth(s.proceeds)),
    mintFees: mean((s) => toEth(s.mintFees)),
    keeper: mean((s) => toEth(s.keeperPaid)),
    redeemGas: mean((s) => toEth(s.redeemGasEth)),
    lostValue: mean((s) => toEth(s.backingLost + s.curatedLost)),
    netMean: net.reduce((a, b) => a + b, 0) / runs,
    netP5: q(0.05),
    netP95: q(0.95),
    marginPct: mean((s) => (s.proceeds ? (100 * toEth(s.proceeds - s.mintFees - s.keeperPaid - s.backingLost - s.curatedLost)) / toEth(s.proceeds) : 0)),
    reserve: mean((s) => (s.reserveSamples ? toEth(s.reserveSum / BigInt(s.reserveSamples)) : 0)),
    minBalance: mean((s) => toEth(s.minBalance)),
    closedPct: mean((s) => (100 * s.minutesClosed) / Math.max(1, s.minutesOpenable)),
    closures: mean((s) => s.closures),
    rejectedPct: mean((s) => (100 * s.rejected) / Math.max(1, s.attempts)),
    surplus: mean((s) => Math.max(0, toEth(s.endBalance - s.endRequired))),
    switches: mean((s) => s.planSwitches),
    skippedForGas: mean((s) => s.upkeepsSkippedForGas),
    executedPct: mean((s) => (100 * s.sends) / Math.max(1, s.attempts2)),
    inclusionSec: mean((s) => s.inclusionSeconds / Math.max(1, s.sends)),
    profitPerUpkeep: mean((s) => toEth(s.keeperProfit) / Math.max(1, s.sends)),
    topClosedReason: topReason,
  };
  const minMarkupBps = economics(sc.plans[0], { curatedBases: sc.curated.map(eth), markupBps: sc.markupBps, edgeBps: 500, mintFee: eth(sc.mintFeeEth) }, { gasPriceGwei: sc.gasGwei + 0.05, drawsPerUpkeep: 1, safety: 0.25 }).minMarkupBps;
  const verdict = row.netMean < 0 ? 'IMPRACTICAL: negative expected net' : row.closedPct > 50 ? 'IMPRACTICAL: closed most of the time' : row.netP5 < 0 ? 'viable on average; losses in bad runs' : 'viable';
  return { ...row, minMarkupBps, verdict };
}

const one = (plan: Counts) => [plan];
const base: Scenario = {
  name: 'baseline', curated: [0.3, 0.5], plans: one([5, 3, 2, 0, 0, 0, 0, 0, 0]), markupBps: 1500, mintFeeEth: 0.001,
  gasGwei: 0.08, keeperEveryMin: 2, drawsPerDay: 40, days: 30, depositEth: 2,
};
// Fallback plans whose limits bind in both directions: losing a curated NFT breaks the odds floor of
// the large plan; relisting it pushes the small plan over the price ceiling.
const switching: Scenario = {
  ...base, name: 'plan switching (restock after 12h)', curated: [0.3, 0.5, 0.8],
  plans: [[5, 3, 2, 0, 0, 0, 0, 0, 0], [2, 1, 1, 0, 0, 0, 0, 0, 0]], maxDrawPrice: 0.033, minOddsBps: 100, restockDelayHours: 12,
};
export const scenarios: Scenario[] = [
  base,
  { ...base, name: 'markup 5%', markupBps: 500 },
  { ...base, name: 'markup 25%', markupBps: 2500 },
  { ...base, name: 'markup 30%', markupBps: 3000 },
  { ...base, name: 'no curated restock', noRestock: true },
  { ...base, name: 'high curated values', curated: [2, 5] },
  { ...base, name: 'large Shapes', curated: [5, 10], plans: one([0, 0, 0, 4, 2, 1, 0, 0, 0]), depositEth: 20 },
  { ...base, name: 'large Shapes, markup 5%', curated: [5, 10], plans: one([0, 0, 0, 4, 2, 1, 0, 0, 0]), depositEth: 20, markupBps: 500 },
  { ...base, name: 'only 0.01 Shapes', curated: [0.2], plans: one([20, 0, 0, 0, 0, 0, 0, 0, 0]) },
  { ...base, name: 'mint fee 0.01 (cap)', mintFeeEth: 0.01 },
  { ...base, name: 'mint fee rises day 10', mintFeeChange: { day: 10, feeEth: 0.005 } },
  { ...base, name: 'gas 1 gwei', gasGwei: 1, gasModel: 'lognormal' },
  { ...base, name: 'gas 1.8 gwei (near cap)', gasGwei: 1.8, gasModel: 'lognormal' },
  { ...base, name: 'gas spikes above cap 30%', gasSpikeProb: 0.3, gasSpikeGwei: 25 },
  { ...base, name: 'keeper every 30 min', keeperEveryMin: 30 },
  { ...base, name: 'keeper every 6h', keeperEveryMin: 360 },
  { ...base, name: 'low volume 2/day', drawsPerDay: 2 },
  { ...base, name: 'high volume 400/day', drawsPerDay: 400 },
  { ...base, name: 'expensive streak 10 batches', expensiveStreakBatches: 10 },
  { ...base, name: 'inactive 10 days', inactive: { fromDay: 10, days: 10 } },
  { ...base, name: 'keeper absent 10 days', keeperAbsent: { fromDay: 10, days: 10 } },
  { ...base, name: 'thin reserve', depositEth: 0.85 },
  switching,
  { ...switching, name: 'plan switching, restock after 2h', restockDelayHours: 2 },
  { ...switching, name: 'plan switching, high volume 400/day', drawsPerDay: 400 },
  { ...switching, name: 'plan switching, mint fee 0.005', mintFeeEth: 0.005 },
];
/** Scenarios where spares vs immediate redemption can differ, plus the baseline. */
const compared = ['baseline', 'gas 1 gwei', 'high volume 400/day', 'plan switching (restock after 12h)', 'plan switching, restock after 2h', 'plan switching, high volume 400/day', 'plan switching, mint fee 0.005'];

/** A plan written with only the nine Shapes sizes, padded with zero pack counts. */
const padded = (c: Counts): Counts => [...c, ...Array(Math.max(0, DENOMS.length - c.length)).fill(0)];

const fmt = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

if (import.meta.url === `file://${process.argv[1]}`) {
  const runsArg = process.argv.indexOf('--runs');
  const runs = runsArg > 0 ? Number(process.argv[runsArg + 1]) : 40;
  const rows = scenarios.map((s) => summarize(s, runs));
  const header = '| Scenario | Draws | Revenue | Mint fees | Keeper | Value delivered | Net mean [p5, p95] | Margin % | Avg reserve | Closed % | Closures | Surplus | Plan switches | Top closed reason | Planner min markup | Verdict |';
  const lines = rows.map((r) =>
    `| ${r.name} | ${fmt(r.draws, 0)} | ${fmt(r.revenue)} | ${fmt(r.mintFees)} | ${fmt(r.keeper)} | ${fmt(r.lostValue)} | ${fmt(r.netMean)} [${fmt(r.netP5)}, ${fmt(r.netP95)}] | ${fmt(r.marginPct, 1)} | ${fmt(r.reserve)} | ${fmt(r.closedPct, 1)} | ${fmt(r.closures, 1)} | ${fmt(r.surplus)} | ${fmt(r.switches, 1)} | ${r.topClosedReason} | ${(r.minMarkupBps / 100).toFixed(1)}% | ${r.verdict} |`);
  const table = [header, '|' + ' --- |'.repeat(16), ...lines].join('\n');

  const cmpHeader = '| Scenario | Model | Keeper spend | Mint fees | Redeem gas | Avg reserve | Plan switches | Net mean [p5, p95] | Margin % | Closed % | Closures | Surplus |';
  const cmpLines: string[] = [];
  for (const name of compared) {
    const sc = scenarios.find((s) => s.name === name)!;
    for (const model of ['previous', 'current+spares', 'current'] as Model[]) {
      const r = summarize(sc, runs, model);
      cmpLines.push(`| ${name} | ${model} | ${fmt(r.keeper)} | ${fmt(r.mintFees)} | ${fmt(r.redeemGas, 5)} | ${fmt(r.reserve)} | ${fmt(r.switches, 1)} | ${fmt(r.netMean)} [${fmt(r.netP5)}, ${fmt(r.netP95)}] | ${fmt(r.marginPct, 1)} | ${fmt(r.closedPct, 1)} | ${fmt(r.closures, 1)} | ${fmt(r.surplus)} |`);
    }
  }
  const cmp = [cmpHeader, '|' + ' --- |'.repeat(12), ...cmpLines].join('\n');

  const liveScenarios = ['baseline', 'only 0.01 Shapes', 'high volume 400/day', 'plan switching (restock after 12h)'];
  const policies = ['original PR (gas + 45k, 2 gwei priority, 10 gwei cap)', 'previous (cover + 0.0001)', 'FWA V2 rule, permissionless', 'final, priority 0.05 gwei', 'final, priority 0.1 gwei', 'final, priority 0.25 gwei', 'final, priority 0.5 gwei', 'final, priority 1 gwei'];
  const liveHeader = '| Scenario | Policy | Upkeeps executed % | Inclusion delay (s) | Keeper profit / upkeep | Keeper spend (30 d) | Closed % | Draws | Creator net mean [p5, p95] | Max reward | Opening reserve, ten 0.01 Shapes |';
  const liveLines: string[] = [];
  for (const name of liveScenarios) {
    const sc = scenarios.find((x) => x.name === name)!;
    for (const model of policies) {
      const r = summarize(sc, runs, model);
      const Mx = MODEL[model];
      const p08 = 8n * 10n ** 7n + Mx.priorityCap; // honest reimbursed price at 0.08 gwei basefee
      const bound = Mx.mode === 'fwa' ? 2_155_000n * (p08 > GWEI ? GWEI : p08) : 3_200_000n * p08 + Mx.incentive;
      const opening = 11n * 10n ** 16n + 3n * bound + 55n * 10n ** 15n + Mx.maxReward; // deficit + 3 rewards + batch + held
      liveLines.push(`| ${name} | ${model} | ${fmt(r.executedPct, 1)} | ${fmt(r.inclusionSec, 1)} | ${fmt(r.profitPerUpkeep, 6)} | ${fmt(r.keeper)} | ${fmt(r.closedPct, 2)} | ${fmt(r.draws, 0)} | ${fmt(r.netMean)} [${fmt(r.netP5)}, ${fmt(r.netP95)}] | ${fmt(toEth(Mx.maxReward), 4)} | ${fmt(toEth(opening), 4)} |`);
    }
  }
  const live = [liveHeader, '|' + ' --- |'.repeat(11), ...liveLines].join('\n');
  console.log(table + '\n\n' + cmp + '\n\n' + live);
  writeFileSync('docs/simulation-results.md', `# Simulation results

Generated by \`npm run sim -- --runs ${runs}\`. All values in ETH over ${base.days} days unless noted. Basefee
median ${base.gasGwei} gwei with ±40% noise. Net = owner proceeds - mint fees - keeper rewards - Shape backing
delivered - curated value delivered (creator-assigned). Redeemed backing is not a cost: it returns to the pool.
"Closures" counts transitions from open to closed for a reason other than the normal post-batch wait for upkeep
(no feasible plan, refill in progress, insufficient reserve). These are model estimates, not guarantees.

## Current design

${table}

## Previous design vs current

- previous: surplus Shapes kept as spares and reused before minting; keeper reimbursed full measured gas + 45k
  at min(bid, basefee + 2 gwei, 10 gwei); reserve with spare credit and a 0.0325 ETH keeper allowance; keeper
  bids 0.1 gwei priority.
- current+spares: current reward rules with the previous spare handling. Isolates the inventory change.
- current: surplus redeemed at once; 4/5 of measured gas (no intrinsic credit) at min(bid, basefee + 0.05 gwei,
  5 gwei), incentive 1/5 of measured gas + 0.0005 ETH, capped by the edge credit for purchase-caused work;
  reserve without spare credit and a 0.0165 ETH keeper allowance; keeper bids 0.05 gwei priority.

${cmp}

## Keeper reimbursement policies under identical workloads

Basefee is sampled from the measured 90-day mainnet distribution (median 0.078 gwei, p90 0.33, p99 4.6); spikes are
drawn independently per keeper check, so they are shorter than real ones. Keepers compete: each bids the reimbursed
priority cap (a keeper is indifferent to bidding up to it, and bidding more wins the race), and costs the work with
eth_estimateGas, measured at billed gas + 78k. Inclusion: a bid lands in the first block whose cheapest included
transactions (block p10 priority, 90 days of eth_feeHistory, by basefee regime) paid no more than it. "Keeper profit"
is reward minus billed gas at the keeper's bid. "Opening reserve" is the creator's ETH to open a pool of ten 0.01 ETH
Shapes at 0.08 gwei. Policies:
- original PR: full measured gas + 45k at min(bid, basefee + 2 gwei, 10 gwei) + 0.0005 ETH.
- previous: 4/5 gas + max(0.0005, (1/5 gas + 21k) x price + 0.0001), price min(bid, basefee + 0.05, 5 gwei).
- FWA V2 rule: FWA's sponsored-processing formula (gas + 55k at min(bid, min(basefee, 5) + 1 gwei), at most 2.1M gas
  and 0.02 ETH, no incentive) applied to permissionless upkeep.
- final: 4/5 gas + (1/5 gas + 0.0005 ETH) at min(bid, basefee + priority cap, 5 gwei), incentive within the edge
  credit for purchase-caused work; priority caps 0.05 to 1 gwei.

${live}
`);
}
