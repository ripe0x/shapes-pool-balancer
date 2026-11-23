import { parseEther } from 'viem';
import { presetMaxSmall, styleBonus, type DesignInputs, type Style } from '../../shared/design';
import { MAX_SHAPES_PER_PLAN, restockFeeAt, shapeCount } from '../../shared/planner';

const base: DesignInputs = {
  curatedBases: [], markupBps: 1500, edgeBps: 500, mintFee: parseEther('0.001'),
  restockFee: restockFeeAt(500_000_000n), baseFee: 500_000_000n,
  have: Array(16).fill(0), v1Preview: true,
};
const styles: Style[] = ['lowPrice', 'balanced', 'bigWins', 'jackpot'];
let cases = 0;
let violations = 0;
for (const curatedBases of [[], [parseEther('0.01')], [parseEther('0.05')], [parseEther('0.2')], [parseEther('2')], [parseEther('100')]]) {
  for (const markupBps of [1000, 1500, 10000]) {
    const d = { ...base, curatedBases, markupBps };
    for (const style of styles) {
      const max = presetMaxSmall(style, d);
      let first = -1;
      let falseAfterTrue = -1;
      let previouslyHit = false;
      // Independent linear sweep of the binary-search predicate, including every size, not a mirror of its search.
      for (let small = 1; small <= MAX_SHAPES_PER_PLAN; small++) {
        const hit = small + shapeCount(styleBonus(style, d, small)) >= MAX_SHAPES_PER_PLAN;
        if (hit && first === -1) first = small;
        if (!hit && previouslyHit && falseAfterTrue === -1) falseAfterTrue = small;
        previouslyHit ||= hit;
      }
      cases++;
      if (max !== first || falseAfterTrue !== -1) {
        violations++;
        console.log(JSON.stringify({ style, curatedBases: curatedBases.map(String), markupBps, max, first, falseAfterTrue }));
      }
    }
  }
}
console.log(JSON.stringify({ cases, violations }));
if (violations) process.exitCode = 1;
