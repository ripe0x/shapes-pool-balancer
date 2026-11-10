// Monte Carlo economic simulation of one Balancer-operated FWA pool.
// Exact FWA selection (weights 1e36/price, uniform target in [0, totalWeight)), FWA's 10% positive
// settlement slippage refund, the Balancer's one-batch admission gate, worst-batch reserve and
// keeper reward bounds. Time advances in minutes. Run: npm run sim [-- --runs 40]
import { writeFileSync } from 'node:fs';
import {
  economics, BPS, DENOMS, GAS, KEEPER_INCENTIVE, KEEPER_MAX_GAS_PRICE, MAX_KEEPER_REWARD, batchReserve, listPrice, weightOf, type Counts,
} from '../shared/planner';

const E = 10n ** 18n;
const GWEI = 10n ** 9n;
const eth = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const toEth = (x: bigint) => Number(x) / 1e18;

export interface Scenario {
  name: string;
  curated: number[]; // creator values (ETH)
  plan: Counts;
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
  noRestock?: boolean; // creator does not replace drawn curated NFTs
}

interface Item { kind: 'c' | 's'; base: bigint; price: bigint; w: bigint; d: number }

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

export function run(sc: Scenario, seed: number) {
  const r = rng(seed);
  const m = sc.markupBps;
  const edge = 500n;
  let fee = eth(sc.mintFeeEth);
  let balance = eth(sc.depositEth);
  let pendingProceeds = 0n;
  const active: Item[] = [];
  const mk = (kind: 'c' | 's', base: bigint, d = -1): Item => {
    const price = listPrice(base, m);
    return { kind, base, price, w: weightOf(price), d };
  };
  for (const c of sc.curated) active.push(mk('c', eth(c)));
  // initial fill paid from the deposit
  sc.plan.forEach((n, d) => {
    for (let i = 0; i < n; i++) active.push(mk('s', DENOMS[d], d));
    balance -= BigInt(n) * (DENOMS[d] + fee);
  });
  const stats = {
    draws: 0, refunds: 0, attempts: 0, rejected: 0, proceeds: 0n, mintFees: BigInt(sc.plan.reduce((a, b) => a + b, 0)) * fee,
    keeperPaid: 0n, keeperRuns: 0, backingLost: 0n, curatedLost: 0n, minBalance: balance, minutesClosed: 0, minutesOpenable: 0,
    insolventMinutes: 0, upkeepsSkippedForGas: 0, endBalance: 0n, endRequired: 0n, closedReasons: {} as Record<string, number>,
  };
  if (balance < 0n) throw new Error(`${sc.name}: deposit below initial fill cost`);

  let cpValid = false;
  let reason = 'needs upkeep';
  let unreconciled: Item[] = [];
  let batchSettlesAt = -1;
  let batch: { escrowedFee: bigint; basePrice: bigint }[] = [];
  let batches = 0;
  let batchSinceUpkeep = false;
  let unreconciledCurated: Item[] = [];

  const totals = () => {
    let w = 0n, wp = 0n;
    for (const it of active) { w += it.w; wp += it.w * it.price; }
    return { w, wp };
  };
  const drawPrice = () => { const t = totals(); return t.w === 0n ? 0n : ((t.wp / t.w) * (BPS + edge)) / BPS; };
  const ownerBase = () => { const t = totals(); return t.w === 0n ? 0n : t.wp / t.w; };

  const settleBatch = () => {
    for (const b of batch) {
      const live = drawPrice();
      const tol = (b.escrowedFee * 1000n) / BPS; // FWA selectionSlippageBps; buyer negative tolerance assumed equal
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

  const upkeep = (gasGwei: number) => {
    if (batch.length) return; // FWA batch unresolved: PoolBusy
    const work = unreconciled.length;
    const reconciledBatch = batchSinceUpkeep;
    batchSinceUpkeep = false;
    balance += pendingProceeds; pendingProceeds = 0n;
    unreconciledCurated = unreconciled.filter((i) => i.kind === 'c');
    unreconciled = [];
    // The creator restocks drawn curated NFTs at the same value (modelled at the next upkeep).
    if (!sc.noRestock) for (const it of unreconciledCurated) active.push(mk('c', it.base));
    unreconciledCurated = [];
    const haveCurated = active.some((i) => i.kind === 'c');
    const counts = Array(9).fill(0);
    for (const it of active) if (it.kind === 's') counts[it.d]++;
    let minted = 0, denomsMinted = 0, cost = 0n;
    if (haveCurated) {
      for (let d = 0; d < 9; d++) {
        const need = sc.plan[d] - counts[d];
        if (need <= 0) continue;
        const c = BigInt(need) * (DENOMS[d] + fee);
        if (balance - cost < c) { reason = 'insufficient reserve'; break; }
        cost += c; minted += need; denomsMinted++;
        for (let i = 0; i < need; i++) active.push(mk('s', DENOMS[d], d));
      }
    }
    balance -= cost;
    stats.mintFees += BigInt(minted) * fee;
    const gas = minted ? GAS.upkeepBase + (minted - 1) * GAS.perShape + Math.max(0, denomsMinted - 1) * GAS.perExtraDenom : GAS.reconcileOnly;
    const basefee = BigInt(Math.round(gasGwei * 1e9));
    let price = basefee + GWEI / 10n; // keeper bids a 0.1 gwei priority fee
    if (price > KEEPER_MAX_GAS_PRICE) price = KEEPER_MAX_GAS_PRICE;
    // On chain: gas + incentive for inventory work; gas only for a reconciled refund-only batch.
    let reward = minted || work ? BigInt(gas) * price + KEEPER_INCENTIVE : reconciledBatch ? BigInt(gas) * price : 0n;
    if (reward > balance) reward = balance;
    balance -= reward; stats.keeperPaid += reward; stats.keeperRuns++;

    const required = batchReserve(sc.plan, fee) + MAX_KEEPER_REWARD;
    const full = sc.plan.every((n, d) => active.filter((i) => i.kind === 's' && i.d === d).length === n);
    if (!haveCurated) { cpValid = false; reason = 'no curated'; }
    else if (!full) { cpValid = false; }
    else if (balance < required) { cpValid = false; reason = 'insufficient reserve'; }
    else { cpValid = true; reason = 'open'; }
  };

  const minutes = sc.days * 1440;
  const perMin = sc.drawsPerDay / 1440 / 3; // purchase transactions; batch size 1..5 uniform => mean 3
  for (let t = 0; t < minutes; t++) {
    const day = t / 1440;
    if (sc.mintFeeChange && day >= sc.mintFeeChange.day) fee = eth(sc.mintFeeChange.feeEth);
    const inactive = sc.inactive && day >= sc.inactive.fromDay && day < sc.inactive.fromDay + sc.inactive.days;
    const keeperGone = inactive || (sc.keeperAbsent && day >= sc.keeperAbsent.fromDay && day < sc.keeperAbsent.fromDay + sc.keeperAbsent.days);

    if (batch.length && t >= batchSettlesAt) settleBatch();

    if (!keeperGone && t % sc.keeperEveryMin === 0 && (unreconciled.length || !cpValid) && !batch.length) {
      const spike = r.u() < (sc.gasSpikeProb ?? 0);
      const g = spike ? sc.gasSpikeGwei ?? sc.gasGwei : sc.gasGwei * Math.exp((r.u() - 0.5) * 0.8);
      // A rational keeper runs only when the capped reward covers its cost.
      if (g + 0.1 > Number(KEEPER_MAX_GAS_PRICE / GWEI)) stats.upkeepsSkippedForGas++;
      else upkeep(g);
    }

    if (!inactive) {
      stats.minutesOpenable++;
      const open = cpValid && !batch.length && unreconciled.length === 0;
      if (!open) {
        stats.minutesClosed++;
        const k = batch.length || unreconciled.length ? 'awaiting upkeep' : reason;
        stats.closedReasons[k] = (stats.closedReasons[k] ?? 0) + 1;
      }
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
  stats.endRequired = batchReserve(sc.plan, fee) + MAX_KEEPER_REWARD;
  return stats;
}

export function summarize(sc: Scenario, runs: number) {
  const res = Array.from({ length: runs }, (_, i) => run(sc, i + 1));
  const net = res.map((s) => toEth(s.proceeds - s.mintFees - s.keeperPaid - s.backingLost - s.curatedLost)).sort((a, b) => a - b);
  const mean = (f: (s: (typeof res)[0]) => number) => res.reduce((a, s) => a + f(s), 0) / runs;
  const q = (p: number) => net[Math.min(runs - 1, Math.floor(p * runs))];
  const reasons: Record<string, number> = {};
  for (const s of res) for (const [k, v] of Object.entries(s.closedReasons)) reasons[k] = (reasons[k] ?? 0) + v;
  const topReason = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '-';
  const row = {
    name: sc.name,
    draws: mean((s) => s.draws),
    revenue: mean((s) => toEth(s.proceeds)),
    maintenance: mean((s) => toEth(s.mintFees + s.keeperPaid)),
    keeper: mean((s) => toEth(s.keeperPaid)),
    lostValue: mean((s) => toEth(s.backingLost + s.curatedLost)),
    netMean: net.reduce((a, b) => a + b, 0) / runs,
    netP5: q(0.05),
    netP95: q(0.95),
    minBalance: mean((s) => toEth(s.minBalance)),
    closedPct: mean((s) => (100 * s.minutesClosed) / Math.max(1, s.minutesOpenable)),
    rejectedPct: mean((s) => (100 * s.rejected) / Math.max(1, s.attempts)),
    surplus: mean((s) => Math.max(0, toEth(s.endBalance - s.endRequired))),
    skippedForGas: mean((s) => s.upkeepsSkippedForGas),
    topClosedReason: topReason,
  };
  const minMarkupBps = economics(sc.plan, { curatedBases: sc.curated.map(eth), markupBps: sc.markupBps, edgeBps: 500, mintFee: eth(sc.mintFeeEth) }, { gasPriceGwei: sc.gasGwei + 0.1, drawsPerUpkeep: 1, safety: 0.25 }).minMarkupBps;
  const verdict = row.netMean < 0 ? 'IMPRACTICAL: negative expected net' : row.closedPct > 50 ? 'IMPRACTICAL: closed most of the time' : row.netP5 < 0 ? 'viable on average; losses in bad runs' : 'viable';
  return { ...row, minMarkupBps, verdict };
}

const base: Scenario = {
  name: 'baseline', curated: [0.3, 0.5], plan: [5, 3, 2, 0, 0, 0, 0, 0, 0], markupBps: 1500, mintFeeEth: 0.001,
  gasGwei: 1, keeperEveryMin: 2, drawsPerDay: 40, days: 30, depositEth: 2,
};
export const scenarios: Scenario[] = [
  base,
  { ...base, name: 'markup 5%', markupBps: 500 },
  { ...base, name: 'markup 25%', markupBps: 2500 },
  { ...base, name: 'markup 30%', markupBps: 3000 },
  { ...base, name: 'no curated restock', noRestock: true },
  { ...base, name: 'high curated values', curated: [2, 5] },
  { ...base, name: 'large Shapes', curated: [5, 10], plan: [0, 0, 0, 4, 2, 1, 0, 0, 0], depositEth: 20 },
  { ...base, name: 'large Shapes, markup 5%', curated: [5, 10], plan: [0, 0, 0, 4, 2, 1, 0, 0, 0], depositEth: 20, markupBps: 500 },
  { ...base, name: 'only 0.01 Shapes', curated: [0.2], plan: [20, 0, 0, 0, 0, 0, 0, 0, 0] },
  { ...base, name: 'mint fee 0.01 (cap)', mintFeeEth: 0.01 },
  { ...base, name: 'mint fee rises day 10', mintFeeChange: { day: 10, feeEth: 0.005 } },
  { ...base, name: 'gas 6 gwei', gasGwei: 6 },
  { ...base, name: 'gas spikes above cap 30%', gasSpikeProb: 0.3, gasSpikeGwei: 25 },
  { ...base, name: 'keeper every 30 min', keeperEveryMin: 30 },
  { ...base, name: 'keeper every 6h', keeperEveryMin: 360 },
  { ...base, name: 'low volume 2/day', drawsPerDay: 2 },
  { ...base, name: 'high volume 400/day', drawsPerDay: 400 },
  { ...base, name: 'expensive streak 10 batches', expensiveStreakBatches: 10 },
  { ...base, name: 'inactive 10 days', inactive: { fromDay: 10, days: 10 } },
  { ...base, name: 'keeper absent 10 days', keeperAbsent: { fromDay: 10, days: 10 } },
  { ...base, name: 'thin reserve', depositEth: 0.85 },
];

const fmt = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

if (import.meta.url === `file://${process.argv[1]}`) {
  const runsArg = process.argv.indexOf('--runs');
  const runs = runsArg > 0 ? Number(process.argv[runsArg + 1]) : 40;
  const rows = scenarios.map((s) => summarize(s, runs));
  const header = '| Scenario | Draws | Revenue | Maintenance (keeper) | Value lost | Net mean [p5, p95] | Min balance | Closed % | Rejected % | Surplus | Top closed reason | Planner min markup | Verdict |';
  const lines = rows.map((r) =>
    `| ${r.name} | ${fmt(r.draws, 0)} | ${fmt(r.revenue)} | ${fmt(r.maintenance)} (${fmt(r.keeper)}) | ${fmt(r.lostValue)} | ${fmt(r.netMean)} [${fmt(r.netP5)}, ${fmt(r.netP95)}] | ${fmt(r.minBalance)} | ${fmt(r.closedPct, 1)} | ${fmt(r.rejectedPct, 1)} | ${fmt(r.surplus)} | ${r.topClosedReason} | ${(r.minMarkupBps / 100).toFixed(1)}% | ${r.verdict} |`);
  const table = [header, '|' + ' --- |'.repeat(13), ...lines].join('\n');
  console.log(table);
  writeFileSync('docs/simulation-results.md', `# Simulation results\n\nGenerated by \`npm run sim -- --runs ${runs}\`. All values in ETH over ${base.days} days unless noted. Net = owner proceeds - mint fees - keeper rewards - Shape backing delivered - curated value delivered (creator-assigned).\n\n${table}\n`);
}
