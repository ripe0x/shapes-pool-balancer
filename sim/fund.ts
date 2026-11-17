// Deterministic policy economics model. Run npm run sim; no RPCs, broadcasts, or secret material.
// Numeric outputs are scenario estimates until a matching fork run agrees step by step.
import { writeFileSync } from 'node:fs';
import { parseEther } from 'viem';
import {
  BPS, BY_VALUE, DEFAULT_SETTINGS, DENOMS, MAX_KEEPER_REWARD, MAX_OPS, MIN_MARKUP_BPS, NUM, SHAPES_IN,
  keeperWorkAt, policyBridgeAt, prizeBase, prizeCost, quoteV1,
  requiredReserveAt, restockFeeAt, rewardPrice,
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
  name: string;
  target: Counts;
  nftValues: bigint[];
  markupBps: number;
  days: number;
  drawsPerDay: number;
  baseFee: bigint;
  burst?: number;
  refundEvery?: number;
  spikeDay?: number;
  spikeDays?: number;
  switchDay?: number;
  elasticity?: number;
  failPolicyDay?: number;
  dependencyPausedDay?: number;
  forcedLargeEvery?: number;
  seed?: number;
}
export interface ModelResult {
  name: string;
  baseFeeGwei: number;
  draws: number;
  refunded: number;
  unavailableSeconds: number;
  maintenanceLatencySeconds: number;
  initialCapital: number;
  switchTopup: number;
  reserve: number;
  bridge: number;
  setupKeeperPay: number;
  keeperPay: number;
  keeperCost: number;
  keeperNet: number;
  creatorNet: number;
  nftsContributed: number;
  drawPrice: number;
  finalDrawPrice: number;
  playerSpend: number;
  fund: number;
  creatorProfitWithdrawn: number;
  accountingDifferenceWei: string;
  listedBacking: number;
  mintFees: number;
  deliveredBacking: number;
  ownerProceeds: number;
}

/** The cost model explicitly assumes billed gas equals measured span + 50k, without refunds.
 *  Historical fork receipts had 24k-46k outside-span gas and ~31k refund gas/draw; neither calibrates this candidate. */
export function transactionCost(work: KeeperWork): bigint {
  return (work.measuredGas + 50_000n) * work.gasPrice;
}
const gasPriceAt = (baseFee: bigint) => baseFee + DEFAULT_SETTINGS.priorityCap <= DEFAULT_SETTINGS.maxGasPrice
  ? baseFee + DEFAULT_SETTINGS.priorityCap : baseFee;

export function runScenario(s: Scenario): ModelResult {
  let rng = (s.seed ?? 12345) >>> 0;
  const rand = () => ((rng = (rng * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  let policy = V1;
  let baseFee = s.baseFee;
  const listings: Listing[] = [];
  const have = DENOMS.map(() => 0);
  let liquid = 0n;
  let profit = 0n;
  let putIn = 0n;
  let withdrawn = 0n;
  let proceeds = 0n;
  let mintSpent = 0n;
  let keeperPay = 0n;
  let keeperCost = 0n;
  let prizesDelivered = 0n;
  let nftContributed = s.nftValues.reduce((a, b) => a + b, 0n);
  let nftDelivered = 0n;
  let switchTopup = 0n;
  let unavailable = 0;
  let serviceLatency = 0;
  let draws = 0;
  let refunded = 0;
  let playerSpend = 0n;
  const feeTotal = () => listings.filter((l) => l.d >= 0).reduce((a, l) => a + l.fee, 0n);
  const required = (owed = 0) => requiredReserveAt(s.target, have, MINT_FEE, owed, policy.maxReward, feeTotal());
  const newListing = (d: number): Listing => ({ d, value: DENOMS[d],
    fee: policy.surcharge(d, baseFee), price: prizeBase(d, MINT_FEE, s.markupBps) + policy.surcharge(d, baseFee) });
  const contribute = (amount: bigint) => { putIn += amount; liquid += amount; };
  const spend = (amount: bigint) => {
    if (amount > liquid) throw new Error(`${s.name}: model attempted unfunded maintenance`);
    liquid -= amount;
    if (profit > liquid) profit = liquid;
  };
  const pay = (work: KeeperWork) => {
    const amount = policy.reward(work);
    if (amount > policy.maxReward) throw new Error('policy maximum violated');
    spend(amount); keeperPay += amount; keeperCost += transactionCost(work);
  };
  // Seed operating capital from the exact empty-board reserve. The model never treats a listing's fee as collected ETH.
  contribute(required());
  const initialCapital = liquid;
  for (const value of s.nftValues) listings.push({ d: -1, price: value, fee: 0n, value });
  let setupPay = 0n;
  while (have.some((n, d) => n < s.target[d])) {
    let units = 0, prizes = 0, sizes = 0;
    for (const d of BY_VALUE) {
      if (have[d] === s.target[d]) continue;
      if (sizes === 4) break;
      sizes++;
      while (have[d] < s.target[d] && units + SHAPES_IN[d] <= MAX_OPS) {
        spend(prizeCost(d, MINT_FEE)); mintSpent += BigInt(SHAPES_IN[d]) * MINT_FEE;
        listings.push(newListing(d)); have[d]++; units += SHAPES_IN[d]; prizes++;
      }
      if (have[d] < s.target[d]) break;
    }
    if (prizes === 0) throw new Error('setup made no progress');
    const work: KeeperWork = { measuredGas: 100_000n + BigInt(units) * 425_000n,
      gasPrice: gasPriceAt(baseFee), baseFee, reconciledDraws: 0n,
      listedShapeUnits: BigInt(units), listedPrizes: BigInt(prizes), processedDraws: 0n };
    const prior = keeperPay; pay(work); setupPay += keeperPay - prior;
  }
  const drawQuote = () => {
    const w = listings.reduce((a, l) => a + NUM / l.price, 0n);
    const wp = listings.reduce((a, l) => a + (NUM / l.price) * l.price, 0n);
    return { weight: w, proceeds: wp / w, price: (wp / w) * 10500n / BPS };
  };
  const openingPrice = drawQuote().price;
  for (let day = 0; day < s.days; day++) {
    baseFee = s.spikeDay !== undefined && day >= s.spikeDay && day < s.spikeDay + (s.spikeDays ?? 1)
      ? 10n * 10n ** 9n : s.baseFee;
    if (day === s.switchDay) {
      const oldPrices = listings.map((l) => l.price);
      policy = V2;
      const shortfall = required() > liquid - profit ? required() - (liquid - profit) : 0n;
      contribute(shortfall); switchTopup += shortfall;
      if (oldPrices.some((p, i) => listings[i].price !== p)) throw new Error('policy switch repriced an existing listing');
    }
    const quote = drawQuote();
    const elasticity = s.elasticity ?? 0;
    const intended = Math.floor(s.drawsPerDay * Math.pow(Number(openingPrice) / Number(quote.price), elasticity));
    if (baseFee > DEFAULT_SETTINGS.maxGasPrice || day === s.failPolicyDay || day === s.dependencyPausedDay) {
      unavailable += DAY;
      continue;
    }
    let remaining = intended;
    while (remaining > 0) {
      const batch = Math.min(remaining, s.burst ?? 1, 5);
      remaining -= batch;
      const selected: Listing[] = [];
      // Requests, final draws, and maintenance use canonical model order; randomness delay is 24 seconds.
      for (let j = 0; j < batch; j++) {
        draws++;
        const q = drawQuote();
        playerSpend += q.price;
        if (s.refundEvery && draws % s.refundEvery === 0) { refunded++; playerSpend -= q.price; continue; }
        const mine = listings.reduce((a, l) => a + (l.d < 0 ? 0n : DENOMS[l.d] * BigInt(s.markupBps - Number(MIN_MARKUP_BPS)) / BPS) * 10n ** 18n / l.price, 0n)
          * q.proceeds / (BigInt(listings.length) * 10n ** 18n);
        if (liquid - profit + q.proceeds - mine < required()) profit += mine;
        liquid += q.proceeds; proceeds += q.proceeds;
        let index: number;
        if (s.forcedLargeEvery && draws % s.forcedLargeEvery === 0) {
          index = listings.reduce((best, l, k) => l.d >= 0 && l.value > listings[best].value ? k : best, 0);
        } else {
          let x = rand() * Number(q.weight);
          index = listings.length - 1;
          for (let k = 0; k < listings.length; k++) { x -= Number(NUM / listings[k].price); if (x < 0) { index = k; break; } }
        }
        const won = listings.splice(index, 1)[0]; selected.push(won);
        if (won.d >= 0) { have[won.d]--; prizesDelivered += won.value; }
        else nftDelivered += won.value;
      }
      // Processing is bounded at two draws/call and skips restocking. Reconciles that reached the fast path may batch;
      // this stressed model explicitly charges ceil(batch/2) processing/reconcile calls, including refunded draws.
      let left = batch;
      while (left) {
        const n = Math.min(left, 2); left -= n;
        pay({ ...keeperWorkAt(baseFee, gasPriceAt(baseFee)), measuredGas: 180_000n + BigInt(n) * 450_000n,
          reconciledDraws: BigInt(n), processedDraws: BigInt(n) });
      }
      for (const won of selected) {
        if (won.d < 0) {
          // Relisting a curated NFT requires the creator to contribute a replacement NFT; its value is counted.
          listings.push({ ...won }); nftContributed += won.value;
        } else {
          const d = won.d;
          const work = { ...keeperWorkAt(baseFee, gasPriceAt(baseFee), d), reconciledDraws: 0n };
          spend(prizeCost(d, MINT_FEE)); mintSpent += BigInt(SHAPES_IN[d]) * MINT_FEE;
          listings.push(newListing(d)); have[d]++; pay(work);
        }
      }
      serviceLatency += Math.min(24, batch * 12); // cumulative assumed latency, not a sales-unavailability measure
    }
    // Claim recorded profit first, then only unencumbered fund surplus, as in withdrawableSurplus.
    const free = liquid > required() ? liquid - required() : 0n;
    const amount = profit > free ? profit : free;
    spend(amount); withdrawn += amount; profit = 0n;
  }
  const backing = listings.filter((l) => l.d >= 0).reduce((a, l) => a + l.value, 0n);
  const nftHeld = listings.filter((l) => l.d < 0).reduce((a, l) => a + l.value, 0n);
  const diff = putIn + proceeds - liquid - backing - withdrawn - prizesDelivered - mintSpent - keeperPay;
  if (diff !== 0n) throw new Error(`ETH accounting differs by ${diff} wei`);
  if (nftContributed !== nftHeld + nftDelivered) throw new Error('NFT value accounting mismatch');
  return {
    name: s.name, baseFeeGwei: Number(s.baseFee) / 1e9, draws, refunded, unavailableSeconds: unavailable, maintenanceLatencySeconds: serviceLatency,
    initialCapital: E(initialCapital), switchTopup: E(switchTopup), reserve: E(required()),
    bridge: E(policyBridgeAt(s.target, have, policy.maxReward, feeTotal())), setupKeeperPay: E(setupPay),
    keeperPay: E(keeperPay), keeperCost: E(keeperCost), keeperNet: E(keeperPay - keeperCost),
    creatorNet: E(withdrawn + liquid + backing + nftHeld - putIn - nftContributed),
    nftsContributed: E(nftContributed), drawPrice: E(openingPrice), finalDrawPrice: E(drawQuote().price),
    playerSpend: E(playerSpend), fund: E(liquid - profit), creatorProfitWithdrawn: E(withdrawn), accountingDifferenceWei: diff.toString(),
    listedBacking: E(backing), mintFees: E(mintSpent), deliveredBacking: E(prizesDelivered), ownerProceeds: E(proceeds),
  };
}

export const DESIGNS = [
  { name: 'small Shapes', target: counts({ 0: 17 }), nftValues: [parseEther('0.2')] },
  { name: 'mixed Shapes and packs', target: counts({ 0: 24, 9: 8, 1: 12, 2: 2, 3: 1 }), nftValues: [parseEther('0.2')] },
  { name: 'NFT heavy', target: counts({ 0: 17 }), nftValues: Array(20).fill(parseEther('0.05')) },
  { name: 'large expensive', target: counts({ 0: 900, 9: 80, 3: 19, 4: 1 }), nftValues: [parseEther('2')] },
];
export const scenarios = (): Scenario[] => DESIGNS.flatMap<Scenario>((d) => [150_000_000n, 500_000_000n, 5_000_000_000n].map((baseFee) => ({
  ...d, name: `${d.name} ${Number(baseFee) / 1e9} gwei`, baseFee, markupBps: 2500, days: 30, drawsPerDay: 40,
}))).concat([
  { ...DESIGNS[1], name: 'quiet 1/day', baseFee: 500_000_000n, markupBps: 2500, days: 30, drawsPerDay: 1 },
  { ...DESIGNS[1], name: 'bursty 240/day', baseFee: 500_000_000n, markupBps: 2500, days: 30, drawsPerDay: 240, burst: 5 },
  { ...DESIGNS[1], name: 'zero demand', baseFee: 500_000_000n, markupBps: 2500, days: 30, drawsPerDay: 0 },
  { ...DESIGNS[1], name: 'large win every 200 draws', baseFee: 500_000_000n, markupBps: 2500, days: 30, drawsPerDay: 40, forcedLargeEvery: 200 },
  { ...DESIGNS[1], name: 'refund each fifth draw', baseFee: 500_000_000n, markupBps: 2500, days: 30, drawsPerDay: 40, refundEvery: 5 },
  { ...DESIGNS[1], name: 'gas spike then idle day', baseFee: 500_000_000n, markupBps: 2500, days: 30, drawsPerDay: 40, spikeDay: 15 },
  { ...DESIGNS[1], name: 'sustained gas spike seven days', baseFee: 500_000_000n, markupBps: 2500, days: 30, drawsPerDay: 40, spikeDay: 15, spikeDays: 7 },
  { ...DESIGNS[1], name: 'V2 switch with demand elasticity 2', baseFee: 500_000_000n, markupBps: 2500, days: 30, drawsPerDay: 40, switchDay: 15, elasticity: 2 },
  { ...DESIGNS[1], name: 'V1 to V2 active board', baseFee: 500_000_000n, markupBps: 2500, days: 30, drawsPerDay: 40, switchDay: 15 },
  { ...DESIGNS[1], name: 'policy outage', baseFee: 500_000_000n, markupBps: 2500, days: 30, drawsPerDay: 40, failPolicyDay: 15 },
  { ...DESIGNS[1], name: 'dependency paused', baseFee: 500_000_000n, markupBps: 2500, days: 30, drawsPerDay: 40, dependencyPausedDay: 15 },
]);

function report(results: ModelResult[]): string {
  return `# Keeper policy economics scenarios\n\nGenerated with \`npm run sim\`. **Model estimates, not release or fork parity evidence.** The model reads the V1 parameters exported by the Solidity policy fixture test.\n\n` +
    `The generated \`test/fixtures/keeper-policy-money-path.json\` is independently replayed by \`shared/policy-money-path.test.ts\`: every setup, delivered/refunded draw, V1-to-V2 activation, redemption and withdrawal step matches pool ETH, booked profit, listed backing, recorded surcharges, reserve, FWA proceeds/prices and reward arithmetic. The underlying fork uses block 26,382,349, actual FWA and Shapes, production Draw Packs deployed locally, basefee 0.5 gwei and bid 0.55 gwei; the repository-authorized coordinator impersonation supplies deterministic VRF words. This bounds money-branch parity. It does not calibrate the stochastic scenarios' transaction gas, batching, demand, admission pauses or timing.\n\n` +
    `All scenarios: 25% Shape markup, 0.001 ETH Shapes mint fee, FWA 5% edge, deterministic seed 12345, 30 days, 40 desired draws/day unless named otherwise. The 5 gwei case bids 5 gwei with zero priority; the keeper's default 0.05 gwei priority skips a 5 gwei basefee. Draw price excludes randomness and transaction gas.\n\n` +
    `| Scenario | Draws | Initial ETH | Switch ETH | First / final draw ETH | Reserve ETH | Keeper net ETH | Creator net ETH | Paid service outage hours |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n` +
    results.map((r) => `| ${r.name} | ${r.draws} | ${r.initialCapital.toFixed(4)} | ${r.switchTopup.toFixed(4)} | ${r.drawPrice.toFixed(5)} / ${r.finalDrawPrice.toFixed(5)} | ${r.reserve.toFixed(4)} | ${r.keeperNet.toFixed(5)} | ${r.creatorNet.toFixed(4)} | ${(r.unavailableSeconds / 3600).toFixed(2)} |`).join('\n') +
    `\n\nFor one 864,000-gas measured replacement span plus an assumed 50,000 billed outside-span gas, V1 pays 0.0002228 ETH at basefee 0.15 / bid 0.20 gwei, 0.0005427 ETH at 0.50 / 0.55 gwei, and 0.0046100 ETH at 5.00 / 5.05 gwei. Modeled no-refund margins are +0.0000400, +0.0000400, and -0.0000057 ETH respectively. At basefee 5.00 with zero priority (bid 5.00), the margin returns to +0.0000400 ETH; the service's default 0.05-gwei priority skips this boundary. These are arithmetic examples, not receipt-based profitability claims.\n\n## Modeled asset-flow scorecard\n\n| Regime | Creator ETH in | FWA proceeds in | Fund at end | Listed backing | Creator withdrawals | Backing delivered | Shapes mint fees | Keeper pay | Accounting gap |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n` +
    results.filter((r) => ['mixed Shapes and packs 0.5 gwei', 'zero demand', 'sustained gas spike seven days', 'V1 to V2 active board'].includes(r.name))
      .map((r) => `| ${r.name} | ${(r.initialCapital + r.switchTopup).toFixed(5)} | ${r.ownerProceeds.toFixed(5)} | ${r.fund.toFixed(5)} | ${r.listedBacking.toFixed(5)} | ${r.creatorProfitWithdrawn.toFixed(5)} | ${r.deliveredBacking.toFixed(5)} | ${r.mintFees.toFixed(5)} | ${r.keeperPay.toFixed(5)} | ${r.accountingDifferenceWei} wei |`).join('\n') +
    `\n\nCreator net includes the opportunity value of every contributed curated NFT, even when the model assumes the creator replaces a won NFT immediately. Operating ETH remains the creator's and is counted in final wealth; it is not earnings. Keeper net includes initial setup, no failed attempts, no operator overhead, and a billed-gas assumption of measured span + 50k without refunds. Cumulative service latency is a scenario assumption (12-24 seconds per batch), not a measurement of sales unavailability. The outage column includes only modeled full-day paid-service outages. Actual FWA admission pauses and real pool availability are unmeasured here. Policy outage and gas above the cap stop paid service for a modeled day; actual unpaid recovery must be demonstrated by fork tests.\n\nThe bridge is \`max(2 × selected maximum × max(target prizes, active Shape prizes) − recorded listed surcharges, 0)\`. Surcharges in unsold prizes are never liquid capital. Existing prices stay fixed across the policy switch. V2 matches the test policy schedule: 70k overhead, 8 gwei ceiling, 0.02 gwei priority allowance, 0.00001 ETH per draw and 0.00004 ETH per listed prize, with surcharge gas 950k per Shape prize or 1.1M per pack plus 0.00025 ETH per contained Shape. Its declared maximum is 0.03 ETH. Matching formulas alone does not establish transaction parity.\n\nThe model explicitly charges processing in separate calls (two draws/call), then one restock per won prize, a stressed split schedule. It does not claim that this is the cheapest keeper behavior. Every run checks exact ETH and NFT-value accounting. Its transaction gas, FWA prize selection, admission pauses, requester refunds, and timing are modeled, not replayed transactions. A conservation check is not economic or fork parity proof.\n\n## Demand sensitivity\n\nHolding volume constant is an exposure comparison, not a forecast. At fixed demand elasticity 1, a 20% draw-price increase reduces expected volume to 83.3%; elasticity 2 reduces it to 69.4%. At elasticity 3 it is 57.9%. These are hypothetical sensitivities, not empirically fitted demand. A higher fee can lower total fee income despite improving income per draw.\n\n## Things that don't make sense\n\nThe whole-board worst-case bridge is deliberately expensive: a 1,000-prize board locks tens of ETH in operating capital even if observed keeper costs are much lower. This is the cost of reserving two maximum payments per prize rather than using a tighter enforced operation-specific envelope. The model's high-volume and immediate NFT-replacement assumptions do not establish real demand or creator willingness.\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = scenarios().map(runScenario);
  const markdown = report(results);
  writeFileSync('docs/keeper-policy-simulation-results.md', markdown);
  writeFileSync('sim/keeper-policy-results.json', JSON.stringify(results, null, 2) + '\n');
  console.log(markdown);
}
