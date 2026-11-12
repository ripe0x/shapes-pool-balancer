// Money-flows timeline for PoolBalancer: fill gate, markup at listing, one target mix, restocks staged while
// draws are pending, withdrawal reserve. Every step reconciles where each wei sits; the 'contract' policy is the
// on-chain rule and the other policies are the alternatives it was chosen over (docs/simulation-results.md).
// FWA model: weights 1e36/price, fee = EV x (1 + edge), owner proceeds = EV at request (StandardPool 1435, 1824),
// staging FIFO activated 6 per request (drained at once only when no draw is unsettled), 10% slippage refunds.
// Run: npm run sim
import { BPS, BY_VALUE, DENOMS, GAS, KEEPER_INCENTIVE, KEEPER_MAX_GAS, SHAPES_IN, requiredReserveAt, restockFeeAt, type Counts } from '../../../../shared/planner';
import { mixOf, styleBonus } from '../../../../shared/design';

const E = 10n ** 18n;
const eth = (x: number) => BigInt(Math.round(x * 1e9)) * 10n ** 9n;
const f = (x: bigint) => (Number(x) / 1e18).toFixed(4);
const NUM = 10n ** 36n;
const EDGE = 500n;
const VRF_GAS = 2_340_000n; // fork quotes: 0.15 gwei -> 0.000351 ETH, 1.05 gwei -> 0.002457 ETH
const MAX_OPS = 5; // PoolBalancer.MAX_OPS
const MAX_RESTOCK_SIZES = 4; // PoolBalancer.MAX_RESTOCK_SIZES
const MAX_RECONCILE = 5; // PoolBalancer.MAX_RECONCILE
const PER_TX = 5;
const ACTIVATIONS = 6;

type Item = { id: number; nft: boolean; d: number; base: bigint; price: bigint; cost: bigint; kfee: bigint }; // cost: what it cost the pool (backing + mint fees) or the creator's value; kfee: keeper credit when drawn
type Req = { seq: number; who: number; fee: bigint; ev: bigint; reserved: Item[] };

interface Policy {
  fillBps: number; // gate: live listings minus unsettled draws >= fillBps x designed listings
  buffer: boolean; // claimSurplus leaves the restock cost of the current deficit + pending draws
  float: boolean; // buffer also keeps one largest-prize cost
  maxMintFee: bigint; // gate closes above this
  maxPending: number; // gate: draws requested but not yet settled
  byWeight?: boolean; // fill measured as tracked prize weight, less the heaviest prize per unreconciled draw (contract)
  funding?: Funding; // how keeper credit is earned (default: all markup above cost, the rule before the restocking fee)
}
/**
 * Keeper funding. 'markup': price = backing x (1 + m); credit += share of (price - cost).
 * 'fee': price = backing + mint fees + restock fee per Shape + backing x m; credit += the restock fee (curated NFTs
 * carry none). 'gasFee': as 'fee', with the fee set at listing from basefee (PoolBalancer.restockFee, the contract).
 * `floorGwei`: price the gas-indexed fee at no less than this basefee. `prepaid`: credit each new listing's fee to
 * keepers when the keeper lists it (from the pool's ETH, outside creator work) instead of when it is drawn.
 * `markupBps` overrides the scenario markup.
 */
type Funding =
  | { kind: 'markup'; shareBps: number; markupBps?: number }
  | { kind: 'fee'; perShape: bigint; markupBps?: number }
  | { kind: 'gasFee'; markupBps?: number; floorGwei?: number; prepaid?: boolean };
const ALL_MARKUP: Funding = { kind: 'markup', shareBps: 10_000 };
const gasFeePerShape = (gwei: number) => restockFeeAt(BigInt(Math.round(gwei * 1e9)));
/** Listed price and keeper credit of a prize under `fu`; d = -1 for a curated NFT of creator value `base`. */
function priced(fu: Funding, d: number, base: bigint, m: number, mintFee: bigint, gwei: number) {
  const mk = BigInt(fu.markupBps ?? m);
  const cost = d < 0 ? base : DENOMS[d] + BigInt(SHAPES_IN[d]) * mintFee;
  if (fu.kind === 'markup') {
    const price = (base * (BPS + mk)) / BPS;
    return { price, cost, kfee: price > cost ? ((price - cost) * BigInt(fu.shareBps)) / BPS : 0n };
  }
  const per = fu.kind === 'fee' ? fu.perShape : gasFeePerShape(Math.max(gwei, fu.floorGwei ?? 0));
  const kfee = d < 0 ? 0n : per * BigInt(SHAPES_IN[d]);
  return { price: cost + kfee + (base * mk) / BPS, cost, kfee };
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
  target?: Counts;
  relistNft?: boolean; // creator lists a fresh NFT of the same value when one is won
}

function targetOf(s: Scenario): Counts {
  const inputs = { curatedBases: s.curated.map(eth), markupBps: s.markup(0), edgeBps: 500, mintFee: s.mintFee(0), restockFee: gasFeePerShape(s.baseGwei(0)), have: DENOMS.map(() => 0) };
  return s.target ?? mixOf(20, styleBonus('board', inputs, 20));
}

function run(s: Scenario, p: Policy, seed: number) {
  let rnd = seed >>> 0;
  const rand = () => ((rnd = (Math.imul(rnd ^ (rnd >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32);
  // ledger (wei)
  const L = { deposits: 0n, nftIn: 0n, playerPaid: 0n, balance: 0n, ownerProceeds: 0n, escrow: 0n, refundOwed: 0n,
    listedBacking: 0n, wonBacking: 0n, nftWon: 0n, mintFees: 0n, edge: 0n, vrf: 0n, keeper: 0n, keeperCost: 0n,
    withdrawn: 0n, nftBack: 0n, credit: 0n, markupEarned: 0n, setupKeeper: 0n, feesPaid: 0n, creatorGas: 0n };
  const live: Item[] = [];
  let staged: Item[] = [];
  const pending: Req[] = [];
  let unreconciled: { item?: Item; delivered: boolean }[] = [];
  let id = 0, seq = 0, enabled = true, retired = false;
  const curated = new Set<number>(); // tracked (reconciled) curated listing ids
  let markupAtList = 0;
  const target = targetOf(s);
  const fu = p.funding ?? ALL_MARKUP;
  const designPrice = (d: number, base: bigint) => priced(fu, d, base, s.markup(0), s.mintFee(0), s.baseGwei(0)).price;
  // Fill gate weight: with a restocking fee, PoolBalancer weighs a prize at its price less the fee, so fill ignores gas.
  const gatePrice = (i: { price: bigint; kfee: bigint }) => (fu.kind === 'markup' ? i.price : i.price - i.kfee);
  const designedCount = (c: Set<number>) => c.size + target.reduce((a, b) => a + b, 0);
  const have = DENOMS.map(() => 0); // tracked active prizes per size
  const cost = (d: number, fee: bigint) => DENOMS[d] + BigInt(SHAPES_IN[d]) * fee;
  const tw = () => live.reduce((a, i) => a + NUM / i.price, 0n);
  const evNow = () => { const w = tw(); return w === 0n ? 0n : live.reduce((a, i) => a + (NUM / i.price) * i.price, 0n) / w; };
  const feeNow = () => (evNow() * (BPS + EDGE)) / BPS;

  const metrics = { openSteps: 0, idleSum: 0n, freeSum: 0n, backingSum: 0n, unwonFeeSum: 0n, frontedSum: 0n, minBalance: 0n, maxDeficit: 0n, attempts: 0, admitted: 0, refunds: 0, oddsRatioSum: 0, oddsRatioMax: 0, oddsSamples: 0, bigMissing: 0, settled: 0, keeperWaits: 0, restockBlocked: 0, paid: 0n };
  const designOdds = (() => { const w = [...s.curated.map(eth).map((b) => NUM / designPrice(-1, b))]; const cw = w.reduce((a, b) => a + b, 0n); let sw = 0n; target.forEach((n, d) => (sw += BigInt(n) * (NUM / designPrice(d, DENOMS[d])))); return Number(cw) / Number(cw + sw); })();

  // ---- creator opens: deposit, list curated, mint initial inventory (paid from the deposit)
  const list = (it: Item) => (pending.length ? staged.push(it) : live.push(it));
  let tNow = 0;
  const addNft = (v: number) => { const it = { id: ++id, nft: true, d: -1, base: eth(v), ...priced(fu, -1, eth(v), s.markup(tNow), s.mintFee(tNow), s.baseGwei(tNow)) }; L.nftIn += it.base; list(it); curated.add(it.id); };
  s.curated.forEach(addNft);
  // The dashboard's deposit (ethNeeded): the whole stock, a spare top prize and keeper rewards, plus `deposit` extra.
  const opening = requiredReserveAt(target, DENOMS.map(() => 0), s.mintFee(0)) + eth(s.deposit);
  L.deposits += opening; L.balance += opening;
  let setup = true; // PoolBalancer.creatorWork: the opening stock-up is paid in full from the deposit; purchases wait

  const reserve = (fee: bigint) => {
    if (!enabled || !p.buffer) return 0n;
    if (fee < p.maxMintFee) fee = p.maxMintFee;
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
        .filter((i) => !i.nft).reduce((a, i) => a + NUM / gatePrice(i), 0n);
      const lost = BigInt(pending.length + unreconciled.length) * (NUM / eth(0.01)); // PoolBalancer.MAX_PRIZE_WEIGHT: 0.01 ETH at zero markup
      const tsw = target.reduce((a, n, d) => a + BigInt(n) * (NUM / gatePrice(priced(fu, d, DENOMS[d], s.markup(0), s.mintFee(0), s.baseGwei(0)))), 0n);
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
    const vrf = VRF_GAS * BigInt(Math.round((s.baseGwei(tNow) + 0.05) * 1e9)); L.playerPaid += fee + vrf; L.vrf += vrf; L.escrow += fee;
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
      metrics.settled++; metrics.paid += r.fee;
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
      const prepaid = fu.kind === 'gasFee' && !!fu.prepaid;
      const earned = prepaid ? 0n : recon.reduce((a, u) => a + (u.item && u.delivered ? u.item.kfee : 0n), 0n);
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
      // Prepaid: this call's new listings credit their fees now (not during creator work, which is paid in full).
      const pre = prepaid && !setup ? mints.reduce((a, [d, k]) => a + BigInt(k) * priced(fu, d, DENOMS[d], m, fee, gwei).kfee, 0n) : 0n;
      const credit = L.credit + earned + pre;
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
      L.markupEarned += earned + pre; L.feesPaid += recon.reduce((a, u) => a + (u.item && u.delivered ? u.item.price - u.item.cost : 0n), 0n); L.credit = setup ? credit : credit - reward;
      L.balance += L.ownerProceeds; L.ownerProceeds = 0n;
      for (const [d, k] of mints) for (let j = 0; j < k; j++) {
        L.balance -= cost(d, fee); L.mintFees += BigInt(SHAPES_IN[d]) * fee; L.listedBacking += DENOMS[d];
        list({ id: ++id, nft: false, d, base: DENOMS[d], ...priced(fu, d, DENOMS[d], m, fee, gwei) });
        have[d]++;
      }
      markupAtList = m;
      L.balance -= reward;
      // The unwind is the creator's own call: it pays the gas and receives the reward.
      if (creatorRuns) { L.withdrawn += reward; L.creatorGas += keeperCost; } else { L.keeperCost += keeperCost; if (setup) L.setupKeeper += reward; else L.keeper += reward; }
      if (setup && target.every((n, d) => have[d] >= n)) setup = false;
      if (L.keeper > L.markupEarned) throw new Error(`${s.name} step ${t}: keepers paid more than the markup earned`);
      if (units < MAX_OPS && denoms < MAX_RESTOCK_SIZES && !unreconciled.length) return;
    }
  };

  for (let t = 0; t < s.steps; t++) {
    tNow = t;
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
    if (gate(fee)) metrics.openSteps++;
    metrics.idleSum += L.balance;
    const fronted = reserve(fee) > L.balance ? reserve(fee) - L.balance : 0n;
    metrics.frontedSum += fronted;
    if (fronted > metrics.maxDeficit) metrics.maxDeficit = fronted;
    if (target.some((n, d) => n && DENOMS[d] >= eth(0.1) && have[d] < n)) metrics.bigMissing++;
    if (s.creatorDrains) {
      const free = L.balance - reserve(fee);
      if (free > 0n) { L.balance -= free; L.withdrawn += free; }
    }
    const freeAtRest = L.balance > reserve(fee) ? L.balance - reserve(fee) : 0n;
    metrics.freeSum += freeAtRest;
    metrics.backingSum += L.listedBacking;
    metrics.unwonFeeSum += [...live, ...staged, ...pending.flatMap((r) => r.reserved)]
      .filter((i) => !i.nft).reduce((a, i) => a + i.cost - i.base, 0n);
    check(t);
  }
  // unwind: close, settle, reconcile, withdraw everything
  enabled = false; settleAll(); while (unreconciled.length) upkeep(s.steps, true);
  for (const it of [...live, ...staged]) { if (it.nft) L.nftBack += it.base; else { L.listedBacking -= it.base; L.balance += it.base; } }
  live.length = 0; staged = [];
  L.withdrawn += L.balance; L.balance = 0n;
  check(s.steps);
  metrics.minBalance = L.balance;
  const creatorIn = L.deposits + L.nftIn;
  const creatorOut = L.withdrawn + L.nftBack;
  return { L, metrics, pnl: creatorOut - creatorIn - L.creatorGas, designOdds, target, markupAtList };
}

// This informed copy explores bounded economic scenarios. It deliberately leaves the pinned
// production simulator and contracts unchanged. Its random outcomes are a model, not a fork oracle.
const fixed = <T>(x: T) => () => x;
const kinds: [string, Counts][] = [
  ['Balanced', DENOMS.map((_, d) => ({ 0: 20, 1: 10, 2: 2, 3: 1, 9: 7 } as Record<number, number>)[d] ?? 0)],
  ['Bigger', DENOMS.map((_, d) => ({ 0: 5, 3: 5 } as Record<number, number>)[d] ?? 0)],
  ['Cheap', DENOMS.map((_, d) => ({ 0: 20 } as Record<number, number>)[d] ?? 0)],
];
const gasCases: [string, (t: number) => number][] = [
  ...[0.05, 0.1, 1, 3, 4.9, 5.1, 10].map((x): [string, (t: number) => number] => [`${x}`, fixed(x)]),
  ['slow 0.05>5.1', (t) => 0.05 + 5.05 * t / 120],
  ['jump 0.05>5.1', (t) => t < 40 ? 0.05 : 5.1],
  ['ending 0.05>10', (t) => t < 100 ? 0.05 : 10],
];
const modes: [string, (t: number) => number, number, boolean, number | undefined][] = [
  ['1 in-flight', fixed(1), 1, true, undefined],
  ['5 in-flight', fixed(5), 1, true, undefined],
  ['burst 20/late keeper', fixed(20), 10, true, undefined],
  ['demand stop/late keeper', (t) => t < 70 ? 5 : 0, 10, true, undefined],
  ['retire at 60', fixed(5), 1, true, 60],
];
const policy: Policy = { fillBps: 7000, buffer: true, float: true, maxPending: 5, byWeight: true, maxMintFee: eth(0.001), funding: { kind: 'gasFee', prepaid: true } };
const seeds = 40, steps = 120;
console.log('mix,gas,mode,runs,steps,draws_mean,refunds_mean,creator_mean_eth,creator_p05_eth,creator_median_eth,creator_p95_eth,creator_loss_share,player_paid_mean_eth,player_return_gross,player_paid_net_if_refunded_mean_eth,player_return_if_refunded,open_step_share,designed_nft_odds,observed_nft_odds_ratio,liquid_before_claim_mean_eth,free_liquid_at_rest_mean_eth,inventory_backing_mean_eth,unwon_mint_fee_fronted_mean_eth,reserve_deficit_mean_eth,max_deficit_eth,keeper_paid_mean_eth,keeper_net_est_mean_eth,refund_liability_mean_eth,stranded_after_unwind_eth');
for (const [mix, target] of kinds) for (const [gas, schedule] of gasCases) for (const [mode, burst, keeperEvery, creatorDrains, retireAt] of modes) {
  const s: Scenario = { name: `${mix}/${gas}/${mode}`, target, steps, curated: [0.3], markup: fixed(1500), mintFee: fixed(eth(0.001)), baseGwei: schedule, burst, keeperEvery, creatorDrains, deposit: 0, retireAt, relistNft: false };
  const rs = Array.from({ length: seeds }, (_, i) => run(s, policy, i + 1));
  const vals = rs.map((r) => Number(r.pnl) / 1e18).sort((a, b) => a - b);
  const mean = (get: (r: ReturnType<typeof run>) => number) => rs.reduce((a, r) => a + get(r), 0) / seeds;
  const pct = (p: number) => vals[Math.floor((seeds - 1) * p)];
  const draws = mean((r) => r.metrics.settled);
  const paid = mean((r) => Number(r.L.playerPaid) / 1e18);
  const refunds = mean((r) => Number(r.L.refundOwed) / 1e18);
  const value = mean((r) => Number(r.L.wonBacking + r.L.nftWon) / 1e18);
  const odds = mean((r) => r.metrics.oddsRatioSum / Math.max(1, r.metrics.oddsSamples));
  const fields = [mix, gas, mode, seeds, steps, draws, mean((r) => r.metrics.refunds), mean((r) => Number(r.pnl) / 1e18), pct(.05), pct(.5), pct(.95), rs.filter((r) => r.pnl < 0n).length / seeds, paid / Math.max(1, mean((r) => r.metrics.settled + r.metrics.refunds)), paid ? value / paid : 0, (paid - refunds) / Math.max(1, mean((r) => r.metrics.settled + r.metrics.refunds)), paid > refunds ? value / (paid - refunds) : 0, mean((r) => r.metrics.openSteps / steps), rs[0].designOdds, odds, mean((r) => Number(r.metrics.idleSum) / 1e18 / steps), mean((r) => Number(r.metrics.freeSum) / 1e18 / steps), mean((r) => Number(r.metrics.backingSum) / 1e18 / steps), mean((r) => Number(r.metrics.unwonFeeSum) / 1e18 / steps), mean((r) => Number(r.metrics.frontedSum) / 1e18 / steps), mean((r) => Number(r.metrics.maxDeficit) / 1e18), mean((r) => Number(r.L.keeper + r.L.setupKeeper) / 1e18), mean((r) => Number(r.L.keeper + r.L.setupKeeper - r.L.keeperCost) / 1e18), refunds, mean((r) => Number(r.L.balance + r.L.listedBacking + r.L.ownerProceeds + r.L.escrow) / 1e18)];
  console.log(fields.join(','));
}

