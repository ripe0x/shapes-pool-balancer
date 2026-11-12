// Money-flows timeline for PoolBalancer: fill gate, markup at listing, one target mix, restocks staged while
// draws are pending, withdrawal reserve. Every step reconciles where each wei sits; the 'contract' policy is the
// on-chain rule and the other policies are the alternatives it was chosen over (docs/simulation-results.md).
// FWA model: weights 1e36/price, fee = EV x (1 + edge), owner proceeds = EV at request (StandardPool 1435, 1824),
// staging FIFO activated 6 per request (drained at once only when no draw is unsettled), 10% slippage refunds.
// Run: npm run sim
import { BPS, BY_VALUE, DENOMS, GAS, KEEPER_INCENTIVE, KEEPER_MAX_GAS, SHAPES_IN, requiredReserveAt, type Counts } from '../shared/planner';
import { mixOf, styleBonus } from '../shared/design';

const E = 10n ** 18n;
const eth = (x: number) => BigInt(Math.round(x * 1e9)) * 10n ** 9n;
const f = (x: bigint) => (Number(x) / 1e18).toFixed(4);
const NUM = 10n ** 36n;
const EDGE = 500n;
const VRF = eth(0.0003);
const MAX_OPS = 5; // PoolBalancer.MAX_OPS
const MAX_RESTOCK_SIZES = 4; // PoolBalancer.MAX_RESTOCK_SIZES
const MAX_RECONCILE = 5; // PoolBalancer.MAX_RECONCILE
const PER_TX = 5;
const ACTIVATIONS = 6;

type Item = { id: number; nft: boolean; d: number; base: bigint; price: bigint; cost: bigint }; // cost: what it cost the pool (backing + mint fees) or the creator's value
type Req = { seq: number; who: number; fee: bigint; ev: bigint; reserved: Item[] };

interface Policy {
  fillBps: number; // gate: live listings minus unsettled draws >= fillBps x designed listings
  buffer: boolean; // claimSurplus leaves the restock cost of the current deficit + pending draws
  float: boolean; // buffer also keeps one largest-prize cost
  maxMintFee: bigint; // gate closes above this
  maxPending: number; // gate: draws requested but not yet settled
  byWeight?: boolean; // fill measured as tracked prize weight, less the heaviest prize per unreconciled draw (contract)
}
interface Scenario {
  name: string;
  steps: number;
  curated: number[];
  addCurated?: [number, number][]; // [step, value]
  markup: (t: number) => number;
  mintFee: (t: number) => bigint;
  baseGwei: (t: number) => number;
  burst: (t: number) => number; // draws requested before anything settles
  keeperEvery: number; // steps between keeper visits
  creatorDrains: boolean; // creator claims all withdrawable ETH every step
  deposit: number; // ETH deposited at open on top of what the dashboard asks for
  retireAt?: number;
  relistNft?: boolean; // creator lists a fresh NFT of the same value when one is won
}

function run(s: Scenario, p: Policy, seed: number) {
  let rnd = seed >>> 0;
  const rand = () => ((rnd = (Math.imul(rnd ^ (rnd >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32);
  // ledger (wei)
  const L = { deposits: 0n, nftIn: 0n, playerPaid: 0n, balance: 0n, ownerProceeds: 0n, escrow: 0n, refundOwed: 0n,
    listedBacking: 0n, wonBacking: 0n, nftWon: 0n, mintFees: 0n, edge: 0n, vrf: 0n, keeper: 0n, keeperCost: 0n,
    withdrawn: 0n, nftBack: 0n, credit: 0n, markupEarned: 0n, setupKeeper: 0n };
  const live: Item[] = [];
  let staged: Item[] = [];
  const pending: Req[] = [];
  let unreconciled: { item?: Item; delivered: boolean }[] = [];
  let id = 0, seq = 0, enabled = true, retired = false;
  const curated = new Set<number>(); // tracked (reconciled) curated listing ids
  let markupAtList = 0;
  const target: Counts = (() => {
    const inputs = { curatedBases: s.curated.map(eth), markupBps: s.markup(0), edgeBps: 500, mintFee: s.mintFee(0), have: DENOMS.map(() => 0), baseFee: 0n, minCuratedOddsBps: 0 };
    return mixOf(20, styleBonus('board', inputs, 20));
  })();
  const designedCount = (c: Set<number>) => c.size + target.reduce((a, b) => a + b, 0);
  const have = DENOMS.map(() => 0); // tracked active prizes per size
  const cost = (d: number, fee: bigint) => DENOMS[d] + BigInt(SHAPES_IN[d]) * fee;
  const priceOf = (base: bigint, m: number) => (base * (BPS + BigInt(m))) / BPS;
  const tw = () => live.reduce((a, i) => a + NUM / i.price, 0n);
  const evNow = () => { const w = tw(); return w === 0n ? 0n : live.reduce((a, i) => a + (NUM / i.price) * i.price, 0n) / w; };
  const feeNow = () => (evNow() * (BPS + EDGE)) / BPS;

  const metrics = { attempts: 0, admitted: 0, refunds: 0, oddsRatioSum: 0, oddsRatioMax: 0, oddsSamples: 0, bigMissing: 0, settled: 0, keeperWaits: 0, restockBlocked: 0 };
  const designOdds = (() => { const w = [...s.curated.map(eth).map((b) => NUM / priceOf(b, s.markup(0)))]; const cw = w.reduce((a, b) => a + b, 0n); let sw = 0n; target.forEach((n, d) => (sw += BigInt(n) * (NUM / priceOf(DENOMS[d], s.markup(0))))); return Number(cw) / Number(cw + sw); })();

  // ---- creator opens: deposit, list curated, mint initial inventory (paid from the deposit)
  const list = (it: Item) => (pending.length ? staged.push(it) : live.push(it));
  const addNft = (v: number) => { const it = { id: ++id, nft: true, d: -1, base: eth(v), price: priceOf(eth(v), s.markup(0)), cost: eth(v) }; L.nftIn += it.base; list(it); curated.add(it.id); };
  s.curated.forEach(addNft);
  // The dashboard's deposit (ethNeeded): the whole stock, a spare top prize and keeper rewards, plus `deposit` extra.
  const opening = requiredReserveAt(target, DENOMS.map(() => 0), s.mintFee(0)) + eth(s.deposit);
  L.deposits += opening; L.balance += opening;
  let setup = true; // PoolBalancer.creatorWork: the opening stock-up is paid in full from the deposit; purchases wait

  const reserve = (fee: bigint) => {
    if (!enabled || !p.buffer) return 0n;
    let r = 0n, maxCost = 0n;
    target.forEach((n, d) => { if (n > have[d]) r += BigInt(n - have[d]) * cost(d, fee); if (n) maxCost = cost(d, fee) > maxCost ? cost(d, fee) : maxCost; });
    let units = 0; target.forEach((n, d) => { if (n > have[d]) units += (n - have[d]) * SHAPES_IN[d]; });
    const draws = pending.length + unreconciled.length;
    r += BigInt(draws) * maxCost; // each unreconciled draw may remove the largest prize
    if (p.float) r += maxCost;
    const steps = Math.ceil((units + 3 * draws + (p.float ? 3 : 0)) / MAX_OPS) + 1;
    return r + BigInt(steps) * (KEEPER_MAX_GAS * 5n * 10n ** 9n + KEEPER_INCENTIVE);
  };

  const check = (t: number) => {
    const inFlows = L.deposits + L.nftIn + L.playerPaid;
    const where = L.balance + L.ownerProceeds + L.escrow + L.refundOwed + L.listedBacking + L.wonBacking + L.nftWon + L.mintFees + L.edge + L.vrf + L.keeper + L.setupKeeper + L.withdrawn + L.nftBack
      + [...live, ...staged, ...pending.flatMap((r) => r.reserved)].filter((i) => i.nft).reduce((a, i) => a + i.base, 0n);
    if (inFlows !== where) throw new Error(`${s.name} step ${t}: ledger off by ${f(inFlows - where)} ETH`);
    const inv = [...live, ...staged, ...pending.flatMap((r) => r.reserved)].filter((i) => !i.nft).reduce((a, i) => a + i.base, 0n);
    if (inv !== L.listedBacking) throw new Error(`${s.name} step ${t}: listed backing mismatch`);
  };

  const gate = (fee: bigint) => {
    if (!enabled || retired || setup || curated.size === 0) return false;
    if (fee > p.maxMintFee || pending.length >= p.maxPending) return false;
    if (p.byWeight) {
      // PoolBalancer.admissionStatus: FWA asks before activating staged listings, so tracked weight counts them.
      const tracked = [...live, ...staged, ...pending.flatMap((r) => r.reserved), ...unreconciled.flatMap((u) => (u.item ? [u.item] : []))]
        .filter((i) => !i.nft).reduce((a, i) => a + NUM / i.price, 0n);
      const lost = BigInt(pending.length + unreconciled.length) * (NUM / eth(0.01));
      const tsw = target.reduce((a, n, d) => a + BigInt(n) * (NUM / priceOf(DENOMS[d], s.markup(0))), 0n);
      return tracked >= lost && (tracked - lost) * 10_000n >= BigInt(p.fillBps) * tsw;
    }
    return (live.length - pending.length) * 10_000 >= p.fillBps * designedCount(curated);
  };

  const request = (who: number) => {
    if (!pending.length) { live.push(...staged); staged = []; } // idle: FIFO drains at request
    const fee = feeNow();
    if (fee === 0n) return false;
    const reserved = staged.splice(0, ACTIVATIONS);
    pending.push({ seq: ++seq, who, fee, ev: evNow(), reserved });
    L.playerPaid += fee + VRF; L.vrf += VRF; L.escrow += fee;
    return true;
  };

  const settleAll = () => {
    while (pending.length) {
      const r = pending.shift()!;
      live.push(...r.reserved);
      L.escrow -= r.fee;
      const liveFee = feeNow();
      if (live.length === 0 || (liveFee > r.fee ? liveFee - r.fee : r.fee - liveFee) * 10n > r.fee) {
        L.refundOwed += r.fee; metrics.refunds++; unreconciled.push({ delivered: false });
        continue;
      }
      // odds snapshot before the draw
      const w = tw(); const cw = live.filter((i) => i.nft).reduce((a, i) => a + NUM / i.price, 0n);
      const ratio = Number(cw) / Number(w) / designOdds; metrics.oddsRatioSum += ratio; metrics.oddsRatioMax = Math.max(metrics.oddsRatioMax, ratio); metrics.oddsSamples++;
      let x = BigInt(Math.floor(rand() * 2 ** 52)) * w / 2n ** 52n, k = 0;
      for (; k < live.length; k++) { const wi = NUM / live[k].price; if (x < wi) break; x -= wi; }
      const it = live.splice(Math.min(k, live.length - 1), 1)[0];
      const base = r.ev > r.fee ? r.fee : r.ev;
      L.ownerProceeds += base; L.edge += r.fee - base;
      if (it.nft) L.nftWon += it.base; else { L.listedBacking -= it.base; L.wonBacking += it.base; }
      metrics.settled++;
      unreconciled.push({ item: it, delivered: true });
    }
  };

  // PoolBalancer.performUpkeep. An honest keeper simulates the call and sends it only when the reward covers its
  // gas; outside creator work the reward is capped by the markup earned on delivered draws (keeperCredit).
  // `creatorRuns`: the creator sends it whatever it pays (the unwind).
  const upkeep = (t: number, creatorRuns = false) => {
    const fee = s.mintFee(t);
    const gwei = s.baseGwei(t);
    const rewardPrice = BigInt(Math.round(Math.min(gwei + 0.05, 5) * 1e9));
    const actualPrice = BigInt(Math.round((gwei + 0.03) * 1e9));
    const m = s.markup(t);
    for (let call = 0; call < 20; call++) {
      // plan the call: reconcile up to MAX_RECONCILE draws, then restock as PoolBalancer._fillDeficit does
      const recon = unreconciled.slice(0, MAX_RECONCILE);
      const earned = recon.reduce((a, u) => a + (u.item && u.delivered ? u.item.price - u.item.cost : 0n), 0n);
      const haveAfter = [...have];
      for (const u of recon) if (u.item && !u.item.nft) haveAfter[u.item.d]--;
      const bound = KEEPER_MAX_GAS * rewardPrice + KEEPER_INCENTIVE;
      let bal = L.balance + L.ownerProceeds;
      const mints: [number, number][] = [];
      let units = 0, denoms = 0;
      if (enabled && !retired && fee <= p.maxMintFee) for (const d of BY_VALUE) {
        const missing = target[d] - haveAfter[d];
        if (missing <= 0) continue;
        const need = Math.min(missing, Math.floor((MAX_OPS - units) / SHAPES_IN[d]));
        let k = 0;
        while (k < need && bal >= cost(d, fee) + bound) { bal -= cost(d, fee); k++; }
        if (k < need) metrics.restockBlocked++;
        if (k) { mints.push([d, k]); units += k * SHAPES_IN[d]; denoms++; }
        if (k < missing || denoms === MAX_RESTOCK_SIZES) break;
      }
      if (!recon.length && !units) return;
      const gas = BigInt(units ? GAS.upkeepBase + GAS.perShape * (units - 1) + GAS.perExtraDenom * Math.max(0, denoms - 1) : GAS.reconcileOnly);
      const credit = L.credit + earned;
      let reward = (gas > KEEPER_MAX_GAS ? KEEPER_MAX_GAS : gas) * rewardPrice + KEEPER_INCENTIVE;
      if (!setup && reward > credit) reward = credit;
      if (reward > bal) reward = bal;
      const keeperCost = gas * actualPrice;
      if (!creatorRuns && !setup && reward < keeperCost) { metrics.keeperWaits++; return; }

      // apply
      unreconciled.splice(0, recon.length);
      for (const u of recon) if (u.item) {
        if (u.item.nft) { curated.delete(u.item.id); if (s.relistNft && !retired && enabled) addNft(Number(u.item.base) / 1e18); } else have[u.item.d]--;
      }
      L.markupEarned += earned; L.credit = setup ? credit : credit - reward;
      L.balance += L.ownerProceeds; L.ownerProceeds = 0n;
      for (const [d, k] of mints) for (let j = 0; j < k; j++) {
        L.balance -= cost(d, fee); L.mintFees += BigInt(SHAPES_IN[d]) * fee; L.listedBacking += DENOMS[d];
        list({ id: ++id, nft: false, d, base: DENOMS[d], price: priceOf(DENOMS[d], m), cost: cost(d, fee) });
        have[d]++;
      }
      markupAtList = m;
      L.balance -= reward; L.keeperCost += keeperCost;
      if (setup) L.setupKeeper += reward; else L.keeper += reward;
      if (setup && target.every((n, d) => have[d] >= n)) setup = false;
      if (L.keeper > L.markupEarned) throw new Error(`${s.name} step ${t}: keepers paid more than the markup earned`);
      if (units < MAX_OPS && denoms < MAX_RESTOCK_SIZES && !unreconciled.length) return;
    }
  };

  for (let t = 0; t < s.steps; t++) {
    for (const [at, v] of s.addCurated ?? []) if (at === t) addNft(v);
    if (s.retireAt === t) { enabled = false; retired = true; }
    const fee = s.mintFee(t);
    // players: a burst of requests, in transactions of up to PER_TX, before anything settles
    let left = s.burst(t);
    while (left > 0) {
      metrics.attempts++;
      if (!gate(fee)) break;
      metrics.admitted++;
      for (let i = 0; i < Math.min(PER_TX, left); i++) request(t * 1000 + i);
      left -= PER_TX;
    }
    settleAll();
    if (t % s.keeperEvery === 0) upkeep(t);
    if (target.some((n, d) => n && DENOMS[d] >= eth(0.1) && have[d] < n)) metrics.bigMissing++;
    if (s.creatorDrains) {
      const free = L.balance - reserve(fee);
      if (free > 0n) { L.balance -= free; L.withdrawn += free; }
    }
    check(t);
  }
  // unwind: close, settle, reconcile, withdraw everything
  enabled = false; settleAll(); while (unreconciled.length) upkeep(s.steps, true);
  for (const it of [...live, ...staged]) { if (it.nft) L.nftBack += it.base; else { L.listedBacking -= it.base; L.balance += it.base; } }
  live.length = 0; staged = [];
  L.withdrawn += L.balance; L.balance = 0n;
  check(s.steps);
  const creatorIn = L.deposits + L.nftIn;
  const creatorOut = L.withdrawn + L.nftBack;
  return { L, metrics, pnl: creatorOut - creatorIn, designOdds, target, markupAtList };
}

const flat = <T,>(v: T) => () => v;
const base: Scenario = { name: 'baseline', steps: 400, curated: [0.3], markup: flat(1500), mintFee: flat(eth(0.001)), baseGwei: flat(1), burst: flat(3), keeperEvery: 1, creatorDrains: false, deposit: 0.2, relistNft: true };
const scenarios: Scenario[] = [
  base,
  { ...base, name: 'low fees (0.1 gwei)', baseGwei: flat(0.1) },
  { ...base, name: 'gas rises 1 -> 12 gwei', baseGwei: (t) => 1 + (11 * t) / 400 },
  { ...base, name: 'gas spike: 8 gwei for steps 100-250', baseGwei: (t) => (t >= 100 && t < 250 ? 8 : 1) },
  { ...base, name: 'mint fee 0.001 -> 0.005 at step 150', mintFee: (t) => (t < 150 ? eth(0.001) : eth(0.005)) },
  { ...base, name: 'markup 15% -> 10% (the floor) at step 150', markup: (t) => (t < 150 ? 1500 : 1000) },
  { ...base, name: 'only the dashboard deposit', deposit: 0 },
  { ...base, name: 'overlap: bursts of 20', burst: flat(20) },
  { ...base, name: 'keeper every 10 steps', keeperEvery: 10 },
  { ...base, name: 'board grows: +NFT every 80', addCurated: [[80, 0.5], [160, 1], [240, 2], [320, 0.2]] },
  { ...base, name: 'retire at 300', retireAt: 300 },
  { ...base, name: 'creator drains every step', creatorDrains: true },
  { ...base, name: 'drains + overlap 20 + slow keeper', creatorDrains: true, burst: flat(20), keeperEvery: 5 },
];
const CONTRACT: Policy = { fillBps: 7000, buffer: true, float: true, maxPending: 5, byWeight: true, maxMintFee: eth(0.002) };
const policies: Record<string, Policy> = {
  contract: CONTRACT,
  'no reserve': { ...CONTRACT, buffer: false },
  'reserve without spare': { ...CONTRACT, float: false },
  'no pending cap': { ...CONTRACT, maxPending: 1e9 },
  'count-based fill': { ...CONTRACT, byWeight: false },
};
/** Alternatives shown only where they differ. */
const relevant = (pn: string, s: Scenario) =>
  pn === 'contract'
  || ((pn === 'no reserve' || pn === 'reserve without spare') && (s.creatorDrains || s.deposit === 0))
  || (pn === 'no pending cap' && s.burst(0) > 5)
  || (pn === 'count-based fill' && (s.keeperEvery > 1 || s.burst(0) > 5));

const RUNS = 40;
for (const s of scenarios) {
  console.log(`\n## ${s.name}`);
  for (const [pn, p] of Object.entries(policies)) {
    if (!relevant(pn, s)) continue;
    const agg = { admitted: 0, attempts: 0, draws: 0, refunds: 0, odds: 0, oddsMax: 0, big: 0, pnl: 0, keeperNet: 0, waits: 0, setup: 0, keeperPaid: 0, markup: 0, blocked: 0, edge: 0, mint: 0, won: 0, nftWon: 0, stranded: 0n };
    let target: Counts = [];
    let dOdds = 0;
    for (let i = 0; i < RUNS; i++) {
      const r = run(s, p, i + 1);
      target = r.target; dOdds = r.designOdds;
      agg.admitted += r.metrics.admitted; agg.attempts += r.metrics.attempts; agg.draws += r.metrics.settled; agg.refunds += r.metrics.refunds;
      agg.odds += r.metrics.oddsRatioSum / Math.max(1, r.metrics.oddsSamples); agg.oddsMax = Math.max(agg.oddsMax, r.metrics.oddsRatioMax);
      agg.big += r.metrics.bigMissing / s.steps; agg.pnl += Number(r.pnl) / 1e18; agg.keeperNet += Number(r.L.keeper - r.L.keeperCost) / 1e18;
      agg.waits += r.metrics.keeperWaits; agg.keeperPaid += Number(r.L.keeper) / 1e18; agg.setup += Number(r.L.setupKeeper) / 1e18; agg.markup += Number(r.L.markupEarned) / 1e18; agg.blocked += r.metrics.restockBlocked; agg.edge += Number(r.L.edge) / 1e18; agg.mint += Number(r.L.mintFees) / 1e18;
      agg.won += Number(r.L.wonBacking) / 1e18; agg.nftWon += Number(r.L.nftWon) / 1e18;
      agg.stranded += r.L.balance + r.L.listedBacking + r.L.ownerProceeds + r.L.escrow;
    }
    const n = RUNS;
    console.log(`${pn.padEnd(22)} admitted ${((100 * agg.admitted) / agg.attempts).toFixed(0)}% | draws ${(agg.draws / n).toFixed(0)} refunds ${(agg.refunds / n).toFixed(1)} | NFT odds x${(agg.odds / n).toFixed(2)} (max x${agg.oddsMax.toFixed(2)}) | big prize missing ${((100 * agg.big) / n).toFixed(0)}% of time | creator P&L ${(agg.pnl / n).toFixed(4)} ETH (${((agg.pnl / n / Math.max(1, agg.draws / n)) * 1000).toFixed(3)} mETH/draw) | keepers paid ${(agg.keeperPaid / n).toFixed(4)} of ${(agg.markup / n).toFixed(4)} markup (+${(agg.setup / n).toFixed(4)} setup), net ${(agg.keeperNet / n).toFixed(4)}, waited ${(agg.waits / n).toFixed(0)} | restock blocked ${(agg.blocked / n).toFixed(0)} | FWA edge ${(agg.edge / n).toFixed(3)} mint fees ${(agg.mint / n).toFixed(3)} | stranded ${f(agg.stranded)}`);
    void target; void dOdds;
  }
}
