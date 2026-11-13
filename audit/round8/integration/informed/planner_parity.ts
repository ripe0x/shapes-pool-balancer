import { strict as assert } from 'node:assert';
import { evaluate, weightOf } from '../../../../shared/planner';

// Live FWA fork fixture from fulfillment_attempt.output, block 26382349:
// BAYC was listed at zero markup before configure(1000); the Shape and Pack were listed after.
const listed = [20_000_000_000_000_000n, 12_245_000_000_000_000n, 24_490_000_000_000_000n];
const liveFee = 18_260_977_630_488_814n;
const weights = listed.map(weightOf);
const weighted = listed.reduce((sum, price, i) => sum + price * weights[i], 0n);
const expected = weighted / weights.reduce((a, b) => a + b, 0n);
const fromListings = (expected * 10_500n) / 10_000n;
assert.equal(fromListings, liveFee, 'FWA price from exact live listing prices');

const counts = Array(16).fill(0);
counts[0] = 1;
counts[9] = 1;
const planner = evaluate(counts, {
  curatedBases: [20_000_000_000_000_000n],
  markupBps: 1_000,
  edgeBps: 500,
  mintFee: 1_000_000_000_000_000n,
  restockFee: 245_000_000_000_000n,
});
assert.notEqual(planner.drawPrice, liveFee, 'current-markup planner must reveal old curated listing drift');
console.log(JSON.stringify({
  block: 26382349,
  listedPricesWei: listed.map(String),
  liveFeeWei: String(liveFee),
  recomputedFromListingsWei: String(fromListings),
  plannerFeeWei: String(planner.drawPrice),
  plannerOverstatementWei: String(planner.drawPrice - liveFee),
}));
