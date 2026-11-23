import { runScenario } from '../sim/fund';
import { DENOMS } from '../shared/planner';

// Real-path fork counterpart: UninformedForkTest's Shapes-only pool admits purchases.
// This script checks whether the standalone economic model can represent that mode.
const target = DENOMS.map((_, i) => i === 0 ? 20 : 0);
const r = runScenario({
  name: 'standard_shapes_only', target, nftValues: [], markupBps: 1500,
  days: 1, drawsPerDay: 5, baseFee: 500_000_000n,
  initialCapital: 1_000_000_000_000_000_000n, creatorRevenueBps: 1000,
});
console.log(JSON.stringify({
  name: r.name, draws: r.draws, blockedDraws: r.blockedDraws,
  endStatus: r.endStatus, initialCapital: r.initialCapital,
  playerTotalSpend: r.playerTotalSpend,
}, null, 2));
if (r.draws !== 0 || r.blockedDraws !== 5 || r.endStatus !== 'no curated NFT') {
  throw new Error('The model changed: re-evaluate this observation');
}
