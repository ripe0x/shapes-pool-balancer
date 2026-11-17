// Deterministic policy economics model. Run npm run sim; no RPCs, broadcasts, or secret material.
// Numeric outputs are scenario estimates until a matching fork run agrees step by step.
import { writeFileSync } from 'node:fs';
import { parseEther } from 'viem';
import {
  BPS, BY_VALUE, DEFAULT_SETTINGS, DENOMS, MAX_KEEPER_REWARD, MAX_OPS, MIN_MARKUP_BPS, NUM, SHAPES_IN,
  keeperWorkAt, listingBatches, KEEPER_LIMITS, paymentBound, reserveBreakdownAt, prizeBase, prizeCost, quoteV1,
  requiredReserveAt, restockFeeAt,
  type Counts, type KeeperWork,
} from '../shared/planner';

const E = (x: bigint) => Number(x) / 1e18;
const counts = (m: Record<number, number>): Counts => DENOMS.map((_, d) => m[d] ?? 0);
const MINT_FEE = parseEther('0.001');
const DAY = 86400;
export interface ModelPolicy {
  name: string;
  maxReward: bigint;
  reward: (work: KeeperWork) => bigint;
  surcharge: (d: number, baseFee: bigint) => bigint;
}
export const V1: ModelPolicy = {
  name: 'V1', maxReward: MAX_KEEPER_REWARD,
  reward: quoteV1,
  surcharge: (d, b) => BigInt(SHAPES_IN[d]) * restockFeeAt(b),
};
/** Deliberately different test schedule, matched to the fork test's policy fixture before reporting parity. */
export const V2: ModelPolicy = {
  name: 'V2 test policy', maxReward: parseEther('0.03'),
  reward: (w) => {
    const candidate = w.baseFee + 20_000_000n;
    const price = [candidate, w.gasPrice, 8_000_000_000n].reduce((a, b) => a < b ? a : b);
    const gas = w.measuredGas > 3_200_000n ? 3_200_000n : w.measuredGas;
    return (gas + 70_000n) * price + w.reconciledDraws * parseEther('0.00001') + w.listedPrizes * parseEther('0.00004');
  },
  surcharge: (d, b) => {
    const price = b + 20_000_000n < 8_000_000_000n ? b + 20_000_000n : 8_000_000_000n;
    return (d < 9 ? 950_000n : 1_100_000n) * price + BigInt(SHAPES_IN[d]) * parseEther('0.00025');
  },
};
interface Listing { d: number; price: bigint; fee: bigint; value: bigint }
export interface Scenario {
  name: string; target: Counts; nftValues: bigint[]; markupBps: number; days: number; drawsPerDay: number; baseFee: bigint;
  burst?: number; refundEvery?: number; spikeDay?: number; spikeDays?: number; switchDay?: number;
  elasticity?: number; failPolicyDay?: number; dependencyPausedDay?: number; forcedLargeEvery?: number; seed?: number;
  forceFirstLargest?: boolean; replaceCurated?: boolean; unpaidRecovery?: boolean; extraCapital?: bigint; initialCapital?: bigint;
}
export interface ModelResult {
  name: string; baseFeeGwei: number; draws: number; refunded: number; blockedDraws: number;
  unavailableSeconds: number; maintenanceLatencySeconds: number; initialCapital: number; switchTopup: number;
  reserve: number; setupKeeperPay: number; keeperPay: number; keeperCost: number; keeperNet: number; creatorNet: number;
  nftsContributed: number; curatedReplacements: number; drawPrice: number; finalDrawPrice: number; playerSpend: number;
  fund: number; creatorProfitWithdrawn: number; creatorWithdrawals: number; accountingDifferenceWei: string; listedBacking: number;
  mintFees: number; deliveredBacking: number; ownerProceeds: number; missingPrizes: number;
  profitCredited: number; gasSpikeWhileOpen: number; policyFailureWhileOpen: number; dependencyPauseWhileOpen: number;
  unreconciledDraws: number; endStatus: string; restockShortfall: number; paidOperations: number; unpaidGasCost: number;
}

/** Scenario assumption, not a receipt-calibrated billed-gas bound. Refunds and failed sends are absent. */
export function transactionCost(work: KeeperWork): bigint { return (work.measuredGas + 50_000n) * work.gasPrice; }
const gasPriceAt = (baseFee: bigint) => baseFee + DEFAULT_SETTINGS.priorityCap <= DEFAULT_SETTINGS.maxGasPrice
  ? baseFee + DEFAULT_SETTINGS.priorityCap : baseFee;

/** Explicit stochastic gas assumption, shared by setup projections and the operating model. */
function modeledWork(baseFee: bigint, processed: number, reconciled: number, units = 0, prizes = 0): KeeperWork {
  return { measuredGas: processed ? 180_000n + BigInt(processed) * 450_000n : 100_000n + BigInt(units) * 425_000n,
    gasPrice: gasPriceAt(baseFee), baseFee, reconciledDraws: BigInt(reconciled), processedDraws: BigInt(processed),
    listedShapeUnits: BigInt(units), listedPrizes: BigInt(prizes) };
}

/** Hypothetical constant-elasticity demand, not fitted market behavior. */
export const demandAt = (baseline: number, initialPrice: bigint, currentPrice: bigint, elasticity: number) =>
  Math.floor(baseline * Math.pow(Number(initialPrice) / Number(currentPrice || 1n), elasticity));

export function runScenario(s: Scenario): ModelResult {
  let rng = (s.seed ?? 12345) >>> 0;
  const rand = () => ((rng = (rng * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  let policy = V1, baseFee = s.baseFee;
  const listings: Listing[] = [], have = DENOMS.map(() => 0);
  const owed: { won?: Listing; refunded: boolean }[] = [];
  let liquid = 0n, profit = 0n, profitWithdrawn = 0n, putIn = 0n, withdrawn = 0n, proceeds = 0n, heldProceeds = 0n;
  let mintSpent = 0n, keeperPay = 0n, keeperCost = 0n, unpaidGas = 0n, prizesDelivered = 0n, playerSpend = 0n;
  let profitCredited = 0n, gasSpikeWhileOpen = 0, policyFailureWhileOpen = 0, dependencyPauseWhileOpen = 0;
  let nftContributed = s.nftValues.reduce((a, b) => a + b, 0n), nftDelivered = 0n, switchTopup = 0n;
  let unavailable = 0, serviceLatency = 0, draws = 0, refunded = 0, blocked = 0, replacements = 0, paidOperations = 0;
  let opening = true, policyFailed = false, paused = false;
  const targetWeight = s.target.reduce((a, n, d) => a + BigInt(n) * (NUM / DENOMS[d]), 0n);
  const required = () => requiredReserveAt(s.target, have, MINT_FEE, owed.length, policy.maxReward, baseFee);
  const missing = () => s.target.reduce((a, n, d) => a + Math.max(0, n - have[d]), 0);
  const contribute = (amount: bigint) => { putIn += amount; liquid += amount; };
  const drawQuote = () => {
    const w = listings.reduce((a, l) => a + NUM / l.price, 0n);
    const wp = listings.reduce((a, l) => a + (NUM / l.price) * l.price, 0n);
    return { weight: w, proceeds: w ? wp / w : 0n, price: w ? (wp / w) * 10500n / BPS : 0n };
  };
  const status = () => {
    if (opening && missing()) return 'setting up';
    if (!listings.some((l) => l.d < 0)) return 'no curated NFT';
    if (owed.length >= 5) return 'outstanding draws';
    const weight = have.reduce((a, n, d) => a + BigInt(n) * (NUM / DENOMS[d]), 0n);
    const lost = BigInt(owed.length) * (NUM / DENOMS[0]);
    if (weight < lost || (weight - lost) * BPS < 7000n * targetWeight) return 'inventory below admission threshold';
    return 'open';
  };
  const collectPreview = () => {
    const active = listings.length + owed.filter((o) => o.won).length;
    const tracked = [...listings, ...owed.flatMap((o) => o.won ? [o.won] : [])];
    const shares = tracked.reduce((a, l) => a + (l.d < 0 ? 0n
      : DENOMS[l.d] * BigInt(Math.max(0, s.markupBps - Number(MIN_MARKUP_BPS))) / BPS) * 10n ** 18n / l.price, 0n);
    const mine = active ? heldProceeds * shares / (BigInt(active) * 10n ** 18n) : 0n;
    return profit + mine;
  };
  const collect = (nextProfit: bigint) => { profitCredited += nextProfit - profit; liquid += heldProceeds; proceeds += heldProceeds; heldProceeds = 0n; profit = nextProfit; };
  const work = (processed: number, reconciled: number, units = 0, prizes = 0) =>
    modeledWork(baseFee, processed, reconciled, units, prizes);
  const rewardFor = (w: KeeperWork) => { const quote = policy.reward(w), cap = paymentBound(w, policy.maxReward); return quote < cap ? quote : cap; };
  const pay = (w: KeeperWork, paid: boolean) => {
    const amount = paid ? rewardFor(w) : 0n;
    if (amount > liquid - profit) throw new Error('paid work consumed booked creator profit');
    liquid -= amount; keeperPay += amount;
    if (paid) { keeperCost += transactionCost(w); paidOperations++; } else unpaidGas += transactionCost(w);
  };
  const mint = (batch: Counts, paid: boolean) => {
    batch.forEach((n, d) => {
      for (let i = 0; i < n; i++) {
        const cost = prizeCost(d, MINT_FEE), fee = (policyFailed ? V1 : policy).surcharge(d, baseFee);
        liquid -= cost; mintSpent += BigInt(SHAPES_IN[d]) * MINT_FEE; have[d]++;
        listings.push({ d, price: prizeBase(d, MINT_FEE, s.markupBps) + fee, fee, value: DENOMS[d] });
      }
    });
    if (!paid && profit > liquid) profit = liquid;
  };
  const maintain = () => {
    if (paused || (baseFee > DEFAULT_SETTINGS.maxGasPrice && !s.unpaidRecovery) || (policyFailed && !s.unpaidRecovery)) return;
    const paid = !policyFailed && baseFee <= DEFAULT_SETTINGS.maxGasPrice;
    while (owed.length) {
      const n = Math.min(owed.length, 2), w = work(n, n), nextProfit = collectPreview();
      if (paid && rewardFor(w) > liquid + heldProceeds - nextProfit) return;
      collect(nextProfit); pay(w, paid);
      for (const o of owed.splice(0, n)) {
        if (!o.won) continue;
        if (o.won.d >= 0) have[o.won.d]--;
        else if (s.replaceCurated) { listings.push({ ...o.won }); nftContributed += o.won.value; replacements++; }
      }
      serviceLatency += 12;
    }
    for (;;) {
      const next = listingBatches(s.target, have)[0];
      if (!next) { opening = false; return; }
      const batch = DENOMS.map(() => 0);
      let units = 0, prizes = 0, cost = 0n, stop = false;
      for (const d of BY_VALUE) {
        for (let i = 0; i < next.counts[d]; i++) {
          const newUnits = units + SHAPES_IN[d], newPrizes = prizes + 1, newCost = cost + prizeCost(d, MINT_FEE);
          const bound = paid ? paymentBound({ ...work(0, 0, newUnits, newPrizes), measuredGas: KEEPER_LIMITS.maxGas }, policy.maxReward) : 0n;
          if (newCost + bound > (paid ? liquid - profit : liquid)) { stop = true; break; }
          batch[d]++; units = newUnits; prizes = newPrizes; cost = newCost;
        }
        if (stop) break;
      }
      if (!prizes) return;
      mint(batch, paid); pay(work(0, 0, units, prizes), paid); serviceLatency += 12;
      if (!missing()) opening = false;
    }
  };
  const claim = () => {
    const free = liquid > required() ? liquid - required() : 0n;
    const amount = profit > free ? profit : free;
    if (amount > liquid) throw new Error('claim exceeded liquid ETH');
    profitWithdrawn += profit < amount ? profit : amount;
    liquid -= amount; withdrawn += amount; profit = profit > amount ? profit - amount : 0n;
  };
  contribute(s.initialCapital ?? required());
  if (s.extraCapital) contribute(s.extraCapital);
  const initialCapital = liquid;
  if (liquid < required()) throw new Error('initial capital does not meet the opening requirement');
  for (const value of s.nftValues) listings.push({ d: -1, price: value, fee: 0n, value });
  maintain();
  const setupPay = keeperPay, openingPrice = drawQuote().price;
  claim(); // expose ongoing operation with only the advertised working-capital target, not unused setup allowance
  for (let day = 0; day < s.days; day++) {
    baseFee = s.spikeDay !== undefined && day >= s.spikeDay && day < s.spikeDay + (s.spikeDays ?? 1)
      ? 10n * 10n ** 9n : s.baseFee;
    policyFailed = day === s.failPolicyDay; paused = day === s.dependencyPausedDay;
    if (status() === 'open') {
      if (baseFee > DEFAULT_SETTINGS.maxGasPrice) gasSpikeWhileOpen++;
      if (policyFailed) policyFailureWhileOpen++;
      if (paused) dependencyPauseWhileOpen++;
    }
    if (day === s.switchDay) {
      policy = V2;
      const need = required() > liquid - profit ? required() - (liquid - profit) : 0n;
      contribute(need); switchTopup += need; // explicit creator-funded policy adoption, never an ordinary operating top-up
    }
    maintain();
    const quote = drawQuote();
    const intended = demandAt(s.drawsPerDay, openingPrice, quote.price, s.elasticity ?? 0);
    let remaining = intended;
    if (paused || policyFailed && !s.unpaidRecovery || baseFee > DEFAULT_SETTINGS.maxGasPrice && !s.unpaidRecovery) {
      blocked += remaining; unavailable += DAY; continue;
    }
    while (remaining > 0) {
      if (status() !== 'open') { blocked += remaining; unavailable += Math.floor(DAY * remaining / Math.max(1, intended)); break; }
      const batch = Math.min(remaining, s.burst ?? 1, 5);
      let requested = 0;
      for (let j = 0; j < batch && status() === 'open'; j++) {
        remaining--; requested++; draws++;
        const q = drawQuote();
        if (s.refundEvery && draws % s.refundEvery === 0) { refunded++; owed.push({ refunded: true }); continue; }
        playerSpend += q.price; heldProceeds += q.proceeds;
        let index = listings.length - 1;
        if (s.forceFirstLargest && draws === 1 || s.forcedLargeEvery && draws % s.forcedLargeEvery === 0) {
          index = listings.reduce((best, l, k) => l.d >= 0 && (best < 0 || l.value > listings[best].value) ? k : best, -1);
          if (index < 0) index = listings.length - 1;
        } else {
          let x = rand() * Number(q.weight);
          for (let k = 0; k < listings.length; k++) { x -= Number(NUM / listings[k].price); if (x < 0) { index = k; break; } }
        }
        const won = listings.splice(index, 1)[0]; owed.push({ won, refunded: false });
        if (won.d >= 0) prizesDelivered += won.value; else nftDelivered += won.value;
      }
      if (!requested) { blocked += remaining; break; }
      maintain(); claim();
    }
  }
  const backing = listings.filter((l) => l.d >= 0).reduce((a, l) => a + l.value, 0n);
  const nftHeld = listings.filter((l) => l.d < 0).reduce((a, l) => a + l.value, 0n);
  const diff = putIn + proceeds - liquid - backing - withdrawn - prizesDelivered - mintSpent - keeperPay;
  if (diff !== 0n) throw new Error(`ETH accounting differs by ${diff} wei`);
  if (nftContributed !== nftHeld + nftDelivered) throw new Error('NFT value accounting mismatch');
  const fund = liquid - profit, need = required();
  return {
    name: s.name, baseFeeGwei: Number(s.baseFee) / 1e9, draws, refunded, blockedDraws: blocked,
    unavailableSeconds: unavailable, maintenanceLatencySeconds: serviceLatency,
    initialCapital: E(initialCapital), switchTopup: E(switchTopup), reserve: E(need), setupKeeperPay: E(setupPay),
    keeperPay: E(keeperPay), keeperCost: E(keeperCost), keeperNet: E(keeperPay - keeperCost),
    creatorNet: E(withdrawn + liquid + backing + nftHeld - putIn - nftContributed - unpaidGas),
    nftsContributed: E(nftContributed), curatedReplacements: replacements, drawPrice: E(openingPrice), finalDrawPrice: E(drawQuote().price),
    playerSpend: E(playerSpend), fund: E(fund), creatorProfitWithdrawn: E(profitWithdrawn), creatorWithdrawals: E(withdrawn), accountingDifferenceWei: diff.toString(),
    listedBacking: E(backing), mintFees: E(mintSpent), deliveredBacking: E(prizesDelivered), ownerProceeds: E(proceeds),
    profitCredited: E(profitCredited), gasSpikeWhileOpen, policyFailureWhileOpen, dependencyPauseWhileOpen,
    missingPrizes: missing(), unreconciledDraws: owed.length, endStatus: status(), restockShortfall: E(need > fund ? need - fund : 0n),
    paidOperations, unpaidGasCost: E(unpaidGas),
  };
}

export const DESIGNS = [
  { name: 'small Shapes', target: counts({ 0: 17 }), nftValues: [parseEther('0.2')] },
  { name: 'mixed Shapes and packs', target: counts({ 0: 24, 9: 8, 1: 12, 2: 2, 3: 1 }), nftValues: [parseEther('0.2')] },
  { name: 'NFT heavy', target: counts({ 0: 17 }), nftValues: Array(20).fill(parseEther('0.05')) },
  { name: 'large expensive', target: counts({ 0: 900, 9: 80, 3: 19, 4: 1 }), nftValues: [parseEther('2')] },
];
export const REPRESENTATIVE_BOARDS = [
  { name: '10 small', target: counts({ 0: 10 }), nftValues: [parseEther('0.2')] },
  { name: '20 small', target: counts({ 0: 20 }), nftValues: [parseEther('0.2')] },
  DESIGNS[1],
  { name: '100 mixed', target: counts({ 0: 52, 9: 17, 1: 25, 2: 4, 3: 2 }), nftValues: [parseEther('0.2')] },
  { name: '200 mixed', target: counts({ 0: 108, 9: 32, 1: 48, 2: 8, 3: 4 }), nftValues: [parseEther('0.2')] },
  { name: '1000 with expensive Packs', target: counts({ 0: 900, 9: 80, 14: 19, 15: 1 }), nftValues: [parseEther('2')] },
  DESIGNS[2],
  { name: '100 ETH top prize', target: counts({ 0: 19, 8: 1 }), nftValues: [parseEther('0.2')] },
];
const GAS_CASES = [150_000_000n, 500_000_000n, 1_000_000_000n, 3_000_000_000n, 5_000_000_000n];
/** Frozen a8fb321 comparison only; never used to plan current production funding. */
export function historicalReserveAt(target: Counts, mintFee: bigint, baseFee: bigint, stocked: boolean): bigint {
  const maximum = 16_450_000_000_000_000n;
  const units = target.reduce((a, n, d) => a + n * SHAPES_IN[d], 0), prizes = target.reduce((a, n) => a + n, 0);
  const inventory = stocked ? 0n : target.reduce((a, n, d) => a + BigInt(n) * prizeCost(d, mintFee), 0n);
  const largest = target.reduce((a, n, d) => n && prizeCost(d, mintFee) > a ? prizeCost(d, mintFee) : a, 0n);
  const historicalPrice = baseFee + 50_000_000n < 5_000_000_000n ? baseFee + 50_000_000n : 5_000_000_000n;
  const fees = stocked ? BigInt(units) * (900_000n * historicalPrice + 200_000_000_000_000n) : 0n;
  const cycle = 2n * BigInt(prizes) * maximum;
  return inventory + largest + BigInt((stocked ? 0 : units) + 4) * maximum + (cycle > fees ? cycle - fees : 0n);
}
export function capitalComparisons() {
  return REPRESENTATIVE_BOARDS.flatMap((b) => GAS_CASES.map((baseFee) => {
    const none = DENOMS.map(() => 0), before = historicalReserveAt(b.target, MINT_FEE, baseFee, false);
    const after = reserveBreakdownAt(b.target, none, MINT_FEE, 0, V1.maxReward, baseFee);
    const stocked = requiredReserveAt(b.target, b.target, MINT_FEE, 0, V1.maxReward, baseFee);
    const backing = b.target.reduce((a, n, d) => a + BigInt(n) * DENOMS[d], 0n);
    const setupQuote = listingBatches(b.target, none).reduce((a, batch) => {
      const w = modeledWork(baseFee, 0, 0, batch.units, batch.prizes), quote = V1.reward(w), cap = paymentBound(w, V1.maxReward);
      return a + (quote < cap ? quote : cap);
    }, 0n);
    const freeAfterSetup = after.total - after.inventoryCost - setupQuote - stocked;
    return { name: b.name, baseFeeGwei: Number(baseFee) / 1e9, beforeWei: before.toString(), afterWei: after.total.toString(),
      reductionWei: (before - after.total).toString(), reductionPercent: Number(before - after.total) / Number(before) * 100,
      beforeStockedWei: historicalReserveAt(b.target, MINT_FEE, baseFee, true).toString(), stockedWei: stocked.toString(),
      backingWei: backing.toString(), mintFeesWei: (after.inventoryCost - backing).toString(), setupBudgetWei: after.listingBudget.toString(), modeledSetupQuoteWei: setupQuote.toString(),
      modeledWithdrawableAfterSetupWei: (freeAfterSetup > 0n ? freeAfterSetup : 0n).toString(),
      workingBufferWei: after.workingBuffer.toString(), curatedContributionWei: b.nftValues.reduce((a, x) => a + x, 0n).toString() };
  }));
}
export const scenarios = (): Scenario[] => REPRESENTATIVE_BOARDS.flatMap<Scenario>((d) => GAS_CASES.map((baseFee) => ({
  ...d, name: `${d.name} ${Number(baseFee) / 1e9} gwei`, baseFee, markupBps: 1500, days: 30, drawsPerDay: 40,
}))).concat([
  { ...DESIGNS[1], name: 'immediate largest win', baseFee: 500_000_000n, markupBps: 1500, days: 30, drawsPerDay: 40, forceFirstLargest: true },
  { ...DESIGNS[1], name: 'dependency paused with creator NFT replacement', baseFee: 500_000_000n, markupBps: 1500, days: 30, drawsPerDay: 40, dependencyPausedDay: 15, replaceCurated: true },
  { ...DESIGNS[1], name: 'quiet 1/day', baseFee: 500_000_000n, markupBps: 1500, days: 30, drawsPerDay: 1 },
  { ...DESIGNS[1], name: 'bursty 240/day with creator NFT replacement', replaceCurated: true, baseFee: 500_000_000n, markupBps: 1500, days: 30, drawsPerDay: 240, burst: 5 },
  { ...DESIGNS[1], name: 'zero demand', baseFee: 500_000_000n, markupBps: 1500, days: 30, drawsPerDay: 0 },
  { ...DESIGNS[1], name: 'repeated largest-prize wins', baseFee: 500_000_000n, markupBps: 1500, days: 30, drawsPerDay: 40, forcedLargeEvery: 1 },
  { ...DESIGNS[1], name: 'refund each fifth draw', baseFee: 500_000_000n, markupBps: 1500, days: 30, drawsPerDay: 40, refundEvery: 5 },
  { ...DESIGNS[1], name: 'gas spike seven days with creator NFT replacement', replaceCurated: true, baseFee: 500_000_000n, markupBps: 1500, days: 30, drawsPerDay: 40, spikeDay: 15, spikeDays: 7 },
  { ...DESIGNS[1], name: 'explicit creator-funded V2 adoption and NFT replacement', replaceCurated: true, baseFee: 500_000_000n, markupBps: 1500, days: 30, drawsPerDay: 40, switchDay: 15 },
  { ...DESIGNS[1], name: 'V2 demand elasticity 2 with creator NFT replacement', replaceCurated: true, baseFee: 500_000_000n, markupBps: 1500, days: 30, drawsPerDay: 40, switchDay: 15, elasticity: 2 },
  { ...DESIGNS[1], name: 'unavailable policy with creator NFT replacement', replaceCurated: true, baseFee: 500_000_000n, markupBps: 1500, days: 30, drawsPerDay: 40, failPolicyDay: 15 },
  { ...DESIGNS[1], name: 'unpaid recovery and creator NFT replacement', replaceCurated: true, baseFee: 500_000_000n, markupBps: 1500, days: 30, drawsPerDay: 40, failPolicyDay: 15, unpaidRecovery: true },
  { ...DESIGNS[1], name: 'creator replaces won curated NFTs', baseFee: 500_000_000n, markupBps: 1500, days: 30, drawsPerDay: 40, replaceCurated: true },
]);

function report(results: ModelResult[]): string {
  const matrix = capitalComparisons();
  return '# Reserve redesign: capital and operating scenarios\n\n'
    + 'Generated by `npm run sim`. **Model-only gas, demand, selection and timing assumptions.** Contract parameter fixtures and separate real-fork money replay establish arithmetic/branch correspondence, not these demand or availability forecasts.\n\n'
    + '**Funding-quote parity:** Every current opening/stocked value in the 40-row capital matrix is exported from actual `KeeperPolicyCalls.reserve` calls on fork block 26,382,349, using the real Shapes mint fee of 0.001 ETH and the deployed V1 maximum. The non-view probe asserts the selected basefee and bid inside execution. `shared/reserve-capital.test.ts` matches every current report row to `test/fixtures/reserve-capital.json`, plus closed-outstanding and paid-disabled-deficit cases. This validates funding quotes, not forty separately executed pool lifecycles.\n\n'
    + 'All amounts are ETH; 0.001 ETH mint fee, 15% Shape markup, FWA 5% edge. Gas columns are basefees; bids add 0.05 gwei except at 5 gwei where the bid is 5 gwei. Opening capital includes initial backing, mint fees, bounded current setup and one working buffer. Stocked reserve excludes backing already in Shapes. No ordinary operating top-ups occur. Only the explicitly named policy-adoption scenario deposits its quoted activation shortfall. Curated NFTs are not automatically replaced, except in the explicitly named creator-replacement scenario. Creator claims after every maintenance batch.\n\n'
    + '## Exact before/after capital matrix\n\nHistorical formula is frozen at a8fb321. Unsold fee income is never a liquid balance in either comparison.\n\n'
    + '| Board | Basefee gwei | Before opening | After opening | Reduction ETH / % | Before stocked | After stocked | Backing | Mint fees | Setup budget |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n'
    + matrix.map((r) => `| ${r.name} | ${r.baseFeeGwei} | ${E(BigInt(r.beforeWei)).toFixed(8)} | ${E(BigInt(r.afterWei)).toFixed(8)} | ${E(BigInt(r.reductionWei)).toFixed(8)} / ${r.reductionPercent.toFixed(2)}% | ${E(BigInt(r.beforeStockedWei)).toFixed(8)} | ${E(BigInt(r.stockedWei)).toFixed(8)} | ${E(BigInt(r.backingWei)).toFixed(4)} | ${E(BigInt(r.mintFeesWei)).toFixed(4)} | ${E(BigInt(r.setupBudgetWei)).toFixed(8)} |`).join('\n')
    + '\n\nAt 0.5 gwei, the following setup payouts and withdrawable remainders use the explicit stochastic gas model, not receipts:\n\n| Board | Setup payment estimate | Withdrawable after estimated setup |\n|---|---:|---:|\n'
    + matrix.filter((r) => r.baseFeeGwei === 0.5).map((r) => `| ${r.name} | ${E(BigInt(r.modeledSetupQuoteWei)).toFixed(8)} | ${E(BigInt(r.modeledWithdrawableAfterSetupWei)).toFixed(8)} |`).join('\n')
    + '\n\nThe minted backing can return on unlisting/redemption; mint fees and execution gas are one-way costs. Setup budgets are immutable upper allowances for canonical batches, not expected keeper invoices. The listed surcharge remains an expected future contribution and never reduces the new reserve.\n\n'
    + '## Operating scenarios\n\nEach scenario is 30 days with baseline demand of 40 draws/day unless named otherwise; elasticity changes desired volume after price changes, deterministic seed 12345. A lower request count reflects refusal/curated-NFT depletion, not manufactured demand. Partial replenishment uses only operating ETH after excluding booked creator profit and reserving the current call’s immutable payment ceiling. It stops at the first unaffordable prize in value order. Every batch rechecks the existing 70% weight admission condition and curated-NFT presence. Missing inventory can coexist with open admission; a paused pool cannot bootstrap new revenue from refused purchases.\n\n'
    + '| Scenario | Draws / refused | Initial ETH | Explicit switch ETH | First / final draw ETH | Fund / required | Missing prizes | Keeper net | Creator net | Refusal hours | Final status |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|\n'
    + results.map((r) => `| ${r.name} | ${r.draws} / ${r.blockedDraws} | ${r.initialCapital.toFixed(6)} | ${r.switchTopup.toFixed(6)} | ${r.drawPrice.toFixed(6)} / ${r.finalDrawPrice.toFixed(6)} | ${r.fund.toFixed(6)} / ${r.reserve.toFixed(6)} | ${r.missingPrizes} | ${r.keeperNet.toFixed(6)} | ${r.creatorNet.toFixed(6)} | ${(r.unavailableSeconds / 3600).toFixed(2)} | ${r.endStatus} |`).join('\n')
    + '\n\nNamed disruptions reached while the weighted gate was open:\n\n| Scenario | Gas-spike days | Policy-failure days | Dependency-pause days | Curated NFTs added |\n|---|---:|---:|---:|---:|\n'
    + results.filter((r) => r.gasSpikeWhileOpen || r.policyFailureWhileOpen || r.dependencyPauseWhileOpen).map((r) => `| ${r.name} | ${r.gasSpikeWhileOpen} | ${r.policyFailureWhileOpen} | ${r.dependencyPauseWhileOpen} | ${r.curatedReplacements} |`).join('\n')
    + '\n\nKeeper net subtracts modeled billed gas but excludes competition, failed sends and hosting. Gas is assumed measured span plus 50k, without storage refunds. Unpaid recovery expenses are charged separately to the creator; paid keeper net excludes them. Draw price excludes VRF and player transaction gas. Refusal hours are scenario scheduling estimates, not fork-measured FWA downtime. Randomness is modeled as immediate; this does not establish live Chainlink timing. The stochastic board selection and batched request/pricing order are approximations, not replayed FWA transactions. Aggregate spending-bucket contention is not simulated; separate actual-fork cap/workload tests must support it.\n\n'
    + 'The separate `keeper-policy-money-path.json` fork fixture is replayed step by step by TypeScript. That bounded real-contract ledger must be regenerated for the new reserve; it does not validate the modeled gas, selection, demand or timing above.\n\n'
    + '## Money destinations and demand limits\n\nEvery scenario asserts pool deposits plus actually collected FWA owner proceeds equal liquid pool ETH plus held Shape/Pack backing plus creator claims plus delivered backing plus Shapes mint fees plus keeper transfers. Contributed curated-NFT value equals retained plus delivered value; automatic replacement is disabled by default. Uncollected FWA proceeds remain outside pool liquid ETH. Paid work never consumes booked profit. Claimable surplus is the greater of booked profit and balance above the current reserve, spent profit first.\n\n'
    + 'A 20% draw-price increase implies 83.3%, 69.4% or 57.9% retained demand at hypothetical elasticity 1, 2 or 3. These sensitivities are not empirical estimates. Higher surcharges cannot be assumed harmless. The V1 surcharge and creator markup allocation are unchanged by reserve reduction.\n\n'
    + "## Things that don't make sense\n\nA fully backed prize board can still have no operating liquidity. Once the weighted inventory or curated-NFT gate stops purchases, future demand cannot replenish it; a creator must contribute ETH/NFTs, lower the target, or close. These are explicit operating conditions, not assets missing from purchasers. Model timing and gas still need real-fork calibration; a balanced ledger alone cannot validate sustainability.\n";
}

if (process.argv[1]?.endsWith('/sim/fund.ts')) {
  const results = scenarios().map(runScenario);
  const reached = (name: string, property: keyof ModelResult, expected: number) => {
    const row = results.find((r) => r.name === name);
    if (!row || row[property] !== expected) throw new Error(`${name}: named regime was not reached`);
  };
  reached('gas spike seven days with creator NFT replacement', 'gasSpikeWhileOpen', 7);
  reached('unavailable policy with creator NFT replacement', 'policyFailureWhileOpen', 1);
  reached('unpaid recovery and creator NFT replacement', 'policyFailureWhileOpen', 1);
  reached('dependency paused with creator NFT replacement', 'dependencyPauseWhileOpen', 1);
  writeFileSync('sim/reserve-results.json', JSON.stringify({ capital: capitalComparisons(), scenarios: results }, null, 2) + '\n');
  writeFileSync('docs/reserve-redesign-simulation-results.md', report(results));
  console.log(report(results));
}
