import { describe, expect, it } from 'vitest';
import { decide, gasLimitFor, KEEPER_MAX_GAS, UPKEEP_GAS_FLOOR } from './keeper';

const GWEI = 10n ** 9n;
/**
 * PoolBalancer._payKeeper: price = min(bid, basefee + 0.05 gwei, 5 gwei); (measured gas + 50,000) x price + 0.0001 ETH,
 * for every call that reconciles a draw or lists a prize.
 */
const reward = (measured: bigint, baseFee: bigint, bid: bigint) => {
  let price = bid;
  if (price > baseFee + GWEI / 20n) price = baseFee + GWEI / 20n;
  if (price > 5n * GWEI) price = 5n * GWEI;
  return (measured + 50_000n) * price + 10n ** 14n;
};

describe('keeper profitability policy across gas prices', () => {
  // A 1-Shape replacement, costed the way a keeper must: eth_estimateGas, measured 70-80k above the measured span.
  const measured = 820_000n;
  const billed = 900_000n;
  for (const baseGwei of [0.05, 0.2, 1, 2, 3.2]) {
    it(`replacement upkeep is worth sending at ${baseGwei} gwei basefee`, () => {
      const baseFee = BigInt(Math.round(baseGwei * 1e9));
      const prio = GWEI / 20n;
      const d = decide({ gasEstimate: billed, expectedReward: reward(measured, baseFee, baseFee + prio), baseFee, priorityFee: prio, maxLossWei: 0n });
      expect(d.send).toBe(true);
    });
  }

  // The estimate is 80k above the measured span; the reward allows 50k plus 0.0001 ETH, so above about 3.3 gwei the
  // estimate costs more than the reward and the default 0.0002 ETH loss allowance is what sends the call.
  it('replacement upkeep near the cap is sent within the default loss allowance', () => {
    const baseFee = 4_900_000_000n;
    const prio = GWEI / 20n;
    const r = reward(measured, baseFee, baseFee + prio);
    expect(decide({ gasEstimate: billed, expectedReward: r, baseFee, priorityFee: prio, maxLossWei: 0n }).send).toBe(false);
    expect(decide({ gasEstimate: billed, expectedReward: r, baseFee, priorityFee: prio, maxLossWei: 2n * 10n ** 14n }).send).toBe(true);
  });

  it('waits above the 5 gwei cap (basefee spike)', () => {
    const baseFee = 8n * GWEI;
    const d = decide({ gasEstimate: billed, expectedReward: reward(measured, baseFee, baseFee + GWEI / 20n), baseFee, priorityFee: GWEI / 20n, maxLossWei: 0n });
    expect(d).toEqual({ send: false, reason: 'unprofitable at current gas' });
  });

  it('overbidding priority never pays: the excess is not reimbursed', () => {
    const baseFee = GWEI / 5n;
    const prio = 3n * GWEI; // the ApeBall bot's bid
    const r = reward(measured, baseFee, baseFee + prio);
    expect(decide({ gasEstimate: billed, expectedReward: r, baseFee, priorityFee: prio, maxLossWei: 0n }).send).toBe(false);
  });

  // Refund-only batch: ~164k measured, ~197k billed, estimate ~78k above billed. It lists nothing and is still paid.
  it('reconcile-only work is sent without a loss allowance at low gas', () => {
    const prio = GWEI / 20n;
    const bf = GWEI / 10n;
    const r = reward(164_000n, bf, bf + prio);
    expect(r).toBe(214_000n * (bf + prio) + 10n ** 14n);
    expect(decide({ gasEstimate: 275_000n, expectedReward: r, baseFee: bf, priorityFee: prio, maxLossWei: 0n }).send).toBe(true);
  });

  // The policy judges against eth_estimateGas, which overstates billed gas; near the cap that gap (61k gas x 5 gwei)
  // is more than the flat reward, so the loss allowance decides.
  it('reconcile-only work near the cap needs the loss allowance to cover the estimate gap', () => {
    const bf = 4_950_000_000n;
    const r = reward(164_000n, bf, bf + GWEI / 20n);
    expect(decide({ gasEstimate: 275_000n, expectedReward: r, baseFee: bf, priorityFee: GWEI / 20n, maxLossWei: 0n }).send).toBe(false);
    expect(decide({ gasEstimate: 275_000n, expectedReward: r, baseFee: bf, priorityFee: GWEI / 20n, maxLossWei: 3n * 10n ** 14n }).send).toBe(true);
  });

  it('sends an opening stockup estimated above KEEPER_MAX_GAS when the capped reward covers it', () => {
    // Round 8 E7: five-Shape opening upkeeps estimated 3,281,364-3,281,532 gas; creator work is paid in full.
    const bf = 80_000_000n;
    const prio = GWEI / 20n;
    const r = reward(KEEPER_MAX_GAS, bf, bf + prio);
    expect(decide({ gasEstimate: 3_281_532n, expectedReward: r, baseFee: bf, priorityFee: prio, maxLossWei: 0n }).send).toBe(true);
  });

  it('gas limit covers a draw that settles before inclusion', () => {
    // Round 8 E8: estimated 674,278 with one draw pending; billed 1,210,546 once it settled in the same block.
    expect(gasLimitFor(674_278n)).toBeGreaterThan(1_210_546n);
    expect(gasLimitFor(UPKEEP_GAS_FLOOR)).toBe((UPKEEP_GAS_FLOOR * 13n) / 10n);
  });
});
