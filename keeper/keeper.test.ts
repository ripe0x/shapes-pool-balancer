import { describe, expect, it } from 'vitest';
import { decide, KEEPER_MAX_GAS } from './keeper';

const GWEI = 10n ** 9n;
/** PoolBalancer._payKeeper: 4/5 of (measured + 21k) at min(bid, basefee + 0.05 gwei, 2 gwei), + incentive. */
const reward = (measured: bigint, baseFee: bigint, bid: bigint, incentive: boolean) => {
  let price = bid;
  if (price > baseFee + GWEI / 20n) price = baseFee + GWEI / 20n;
  if (price > 2n * GWEI) price = 2n * GWEI;
  return ((measured + 21_000n) * 4n) / 5n * price + (incentive ? 5n * 10n ** 14n : 0n);
};

describe('keeper profitability policy across gas prices', () => {
  // A 1-Shape replacement: ~810k measured, ~833k billed (docs/GAS.md); the keeper bids 0.05 gwei priority.
  const measured = 810_000n;
  const est = 900_000n; // eth_estimateGas is an upper bound on billed gas
  for (const baseGwei of [0.05, 0.2, 1, 1.9]) {
    it(`replacement upkeep is worth sending at ${baseGwei} gwei basefee`, () => {
      const baseFee = BigInt(Math.round(baseGwei * 1e9));
      const prio = GWEI / 20n;
      const d = decide({ gasEstimate: est, expectedReward: reward(measured, baseFee, baseFee + prio, true), baseFee, priorityFee: prio, maxLossWei: 0n });
      expect(d.send).toBe(true);
    });
  }

  it('waits when the 2 gwei cap makes upkeep unprofitable (basefee spike)', () => {
    const baseFee = 4n * GWEI;
    const d = decide({ gasEstimate: est, expectedReward: reward(measured, baseFee, baseFee + GWEI / 20n, true), baseFee, priorityFee: GWEI / 20n, maxLossWei: 0n });
    expect(d).toEqual({ send: false, reason: 'unprofitable at current gas' });
  });

  it('overbidding priority never pays: the excess is not reimbursed', () => {
    const baseFee = GWEI / 5n;
    const prio = 3n * GWEI; // the ApeBall bot's bid
    const r = reward(measured, baseFee, baseFee + prio, false);
    expect(decide({ gasEstimate: est, expectedReward: r, baseFee, priorityFee: prio, maxLossWei: 0n }).send).toBe(false);
  });

  it('gas-only work (no incentive) needs an explicit loss allowance', () => {
    const baseFee = GWEI / 5n;
    const prio = GWEI / 20n;
    const r = reward(200_000n, baseFee, baseFee + prio, false);
    expect(decide({ gasEstimate: 230_000n, expectedReward: r, baseFee, priorityFee: prio, maxLossWei: 0n }).send).toBe(false);
    expect(decide({ gasEstimate: 230_000n, expectedReward: r, baseFee, priorityFee: prio, maxLossWei: 10n ** 14n }).send).toBe(true);
  });

  it('never sends a call estimated above the reimbursable maximum', () => {
    const d = decide({ gasEstimate: KEEPER_MAX_GAS + 1n, expectedReward: 10n ** 18n, baseFee: 0n, priorityFee: 0n, maxLossWei: 0n });
    expect(d.send).toBe(false);
  });
});
