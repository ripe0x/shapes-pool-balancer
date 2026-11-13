// Game-fund model (DECISIONS 67). Run: npx tsx sim/fund.ts
// Prices, weights, costs and the restocking fee come from shared/planner (the contract's formulas). FWA pays the owner
// each draw's EV. That payment is split by the listed prices: the Shapes' markup share (curated NFTs count zero, as on
// chain, so NFT money stays in the fund) and the rest, which goes to the game fund. The fund pays every restock,
// smallest first, when it can. While the fund is below its target (one largest prize) a share `s` of the markup part
// tops it up; above target the overflow is profit. The creator withdraws profit daily. s = 1 with the cushion
// deposited is the rule before the split (2ad61fd); the contract uses s = 1/2 with the cushion required at open.
import { parseEther } from 'viem';
import { mixOf, styleBonus, type DesignInputs } from '../shared/design';
import { restockFeeAt, prizePrice, prizeCost, listPrice, SHAPES_IN, DENOMS } from '../shared/planner';

const E = (x: bigint) => Number(x) / 1e18;
type Design = { name: string; s: number; cushion: boolean };
type Out = { withdrawn: number[]; position: number[]; dryDraws: number[]; topOff: number[]; topOffMax: number[]; short: number[]; deposit: number };

function run(small: number, markupBps: number, sched: number[], d: Design, runs: number, seed0: number): Out {
  const nftValue = parseEther('0.2');
  const din: DesignInputs = { curatedBases: [nftValue], markupBps, edgeBps: 500, mintFee: parseEther('0.001'), restockFee: restockFeeAt(10n ** 9n), have: Array(16).fill(0), vrfFee: 0n };
  const target = mixOf(small, styleBonus('board', din, small));
  const sizes = target.map((_, i) => i).filter((i) => target[i] > 0);
  const price = sizes.map((i) => E(prizePrice(i, din)));
  const cost = sizes.map((i) => E(prizeCost(i, din.mintFee)) + SHAPES_IN[i] * E(din.restockFee)); // replacement, keeper paid
  const order = sizes.map((_, k) => k).sort((a, b) => cost[a] - cost[b]);
  const top = sizes.reduce((m, _, k) => (DENOMS[sizes[k]] > DENOMS[sizes[m]] ? k : m), 0);
  const T = cost[top];
  const nftPrice = E(listPrice(nftValue, markupBps));
  const board = sizes.reduce((s, i, k) => s + target[i] * cost[k], 0);
  const deposit = board + (d.cushion ? T : 0);
  const o: Out = { withdrawn: [], position: [], dryDraws: [], topOff: [], topOffMax: [], short: [], deposit };
  let rng = seed0 >>> 0;
  const rand = () => ((rng = (rng * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let r = 0; r < runs; r++) {
    const have = [...target];
    let F = d.cushion ? T : 0, P = 0, withdrawn = 0, inflow = 0, spent = 0;
    let dry = 0, dryRun = 0, topOff = 0, topRun = 0, topMax = 0, short = 0, total = 0;
    for (const n of sched) {
      for (let t = 0; t < n; t++) {
        total++;
        // Payment and its split, at the listed board.
        let S = 1 / nftPrice, N = 1, C = 0; // Shape markups only: curated NFTs count zero, as on chain
        sizes.forEach((i, k) => { S += have[i] / price[k]; N += have[i]; C += (have[i] / price[k]) * (E(DENOMS[i]) * markupBps / 10_000); });
        const ev = N / S, creator = C / S, replace = ev - creator;
        inflow += ev;
        F += replace;
        const toFund = F < T ? Math.min(creator * d.s, T - F) : 0;
        F += toFund;
        P += creator - toFund;
        // Draw.
        let x = rand() * S - 1 / nftPrice;
        if (x >= 0) for (let k = 0; k < sizes.length; k++) { x -= have[sizes[k]] / price[k]; if (x < 0) { have[sizes[k]]--; break; } }
        // Restock from the fund, smallest first.
        for (const k of order) while (have[sizes[k]] < target[sizes[k]] && F >= cost[k]) { F -= cost[k]; spent += cost[k]; have[sizes[k]]++; }
        // Overflow above what the board and the target need is profit.
        const need = T + sizes.reduce((s, i, k) => s + (target[i] - have[i]) * cost[k], 0);
        if (F > need) { P += F - need; F = need; }
        // Checks: the fund never pays what it does not hold; money is conserved.
        if (F < -1e-12 || P < -1e-12) throw new Error('negative bucket');
        const missing = have.some((h, i) => h < target[i]);
        if (missing) short++;
        if (have[sizes[top]] < target[sizes[top]]) { topOff++; topRun++; topMax = Math.max(topMax, topRun); } else topRun = 0;
        if (creator - toFund < 1e-12) { dry++; dryRun++; } else dryRun = 0;
      }
      withdrawn += P; P = 0; // daily withdrawal
    }
    const err = (d.cushion ? T : 0) + inflow - (withdrawn + P + F + spent);
    if (Math.abs(err) > 1e-9) throw new Error(`not conserved by ${err}`);
    const backing = sizes.reduce((s, i) => s + have[i] * E(DENOMS[i]), 0);
    o.withdrawn.push(withdrawn);
    o.position.push(withdrawn + F + backing - deposit); // ETH back if closed now, before NFTs given
    o.dryDraws.push(dry / total); o.topOff.push(topOff / total); o.topOffMax.push(topMax); o.short.push(short / total);
  }
  return o;
}

const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const designs: Design[] = [
  { name: "today (s=100%, cushion)", s: 1, cushion: true },
  { name: 's=50%, cushion', s: 0.5, cushion: true },
  { name: 's=25%, cushion', s: 0.25, cushion: true },
  { name: 's=0%, cushion', s: 0, cushion: true },
  { name: 's=50%, no cushion', s: 0.5, cushion: false },
  { name: 's=100%, no cushion', s: 1, cushion: false },
];
const ape = [43, 44, 54, 18, 0, ...Array(25).fill(1)];
const scenarios: [string, number, number, number[]][] = [
  ['ape-ball curve, 30 days', 12, 2500, ape],
  ['40 a day, 180 days', 12, 2500, Array(180).fill(40)],
  ['40 a day, 180 days, 10% markup', 12, 1000, Array(180).fill(40)],
];
for (const [label, small, m, sched] of scenarios) {
  console.log(`\n${label} (Balanced ${small} small, 0.2 ETH NFT, ${m / 100}% markup, ${sched.reduce((a, b) => a + b, 0)} draws)`);
  console.log('design | ETH in | withdrawn median (p10) | position median | draws with no profit | top prize off board (worst run) | any prize missing');
  for (const d of designs) {
    const o = run(small, m, sched, d, 4000, 12345);
    console.log(`${d.name} | ${o.deposit.toFixed(2)} | ${q(o.withdrawn, 0.5).toFixed(2)} (${q(o.withdrawn, 0.1).toFixed(2)}) | ${q(o.position, 0.5).toFixed(2)} | ${pct(q(o.dryDraws, 0.5))}, p90 ${pct(q(o.dryDraws, 0.9))} | ${pct(q(o.topOff, 0.5))}, p90 ${pct(q(o.topOff, 0.9))} (${q(o.topOffMax, 0.99)} draws p99) | ${pct(q(o.short, 0.5))}, p90 ${pct(q(o.short, 0.9))}`);
  }
}
