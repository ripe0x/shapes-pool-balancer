import { describe, expect, it } from 'vitest';
import { decide, KEEPER_MAX_GAS } from './keeper';

const GWEI = 10n ** 9n;
/**
 * PoolBalancer._payKeeper: 4/5 of measured gas at price = min(bid, basefee + 0.05 gwei, 5 gwei), plus an incentive
 * of max(0.0005 ETH, (measured/5 + 21k) * price + 0.0001 ETH) for work, capped by `credit` for purchase-caused work.
 */
const reward = (measured: bigint, baseFee: bigint, bid: bigint, incentive: boolean, credit = 10n ** 18n) => {
  let price = bid;
  if (price > baseFee + GWEI / 20n) price = baseFee + GWEI / 20n;
  if (price > 5n * GWEI) price = 5n * GWEI;
  const gasPart = ((measured * 4n) / 5n) * price;
  const shortfall = (measured - (measured * 4n) / 5n + 21_000n) * price;
  if (!incentive) return gasPart + shortfall;
  let inc = shortfall + 10n ** 14n;
  if (inc < 5n * 10n ** 14n) inc = 5n * 10n ** 14n;
  return gasPart + (inc < credit ? inc : credit);
};

describe('keeper profitability policy across gas prices', () => {
  // A 1-Shape replacement: ~820k measured, ~843k billed (docs/GAS.md); the keeper bids 0.05 gwei priority.
  const measured = 820_000n;
  const billed = 843_000n;
  for (const baseGwei of [0.05, 0.2, 1, 2, 4.9]) {
    it(`replacement upkeep is worth sending at ${baseGwei} gwei basefee`, () => {
      const baseFee = BigInt(Math.round(baseGwei * 1e9));
      const prio = GWEI / 20n;
      const d = decide({ gasEstimate: billed, expectedReward: reward(measured, baseFee, baseFee + prio, true), baseFee, priorityFee: prio, maxLossWei: 0n });
      expect(d.send).toBe(true);
    });
  }

  it('waits above the 5 gwei cap (basefee spike)', () => {
    const baseFee = 8n * GWEI;
    const d = decide({ gasEstimate: billed, expectedReward: reward(measured, baseFee, baseFee + GWEI / 20n, true), baseFee, priorityFee: GWEI / 20n, maxLossWei: 0n });
    expect(d).toEqual({ send: false, reason: 'unprofitable at current gas' });
  });

  it('waits when the edge credit of a cheap pool cannot cover the shortfall at high gas', () => {
    const baseFee = 4n * GWEI;
    const credit = 57n * 10n ** 13n; // 0.00057 ETH: one draw in a 0.012 ETH-per-draw pool
    const r = reward(measured, baseFee, baseFee + GWEI / 20n, true, credit);
    expect(decide({ gasEstimate: billed, expectedReward: r, baseFee, priorityFee: GWEI / 20n, maxLossWei: 0n }).send).toBe(false);
  });

  it('overbidding priority never pays: the excess is not reimbursed', () => {
    const baseFee = GWEI / 5n;
    const prio = 3n * GWEI; // the ApeBall bot's bid
    const r = reward(measured, baseFee, baseFee + prio, false);
    expect(decide({ gasEstimate: billed, expectedReward: r, baseFee, priorityFee: prio, maxLossWei: 0n }).send).toBe(false);
  });

  it('gas-only work is covered within the default loss allowance up to the cap', () => {
    const baseFee = 4.95e9;
    const prio = GWEI / 20n;
    const bf = BigInt(baseFee);
    const r = reward(170_000n, bf, bf + prio, false); // refund-only batch: ~170k measured, ~195k billed
    expect(decide({ gasEstimate: 195_000n, expectedReward: r, baseFee: bf, priorityFee: prio, maxLossWei: 0n }).send).toBe(false);
    expect(decide({ gasEstimate: 195_000n, expectedReward: r, baseFee: bf, priorityFee: prio, maxLossWei: 10n ** 14n }).send).toBe(true);
  });

  it('never sends a call estimated above the reimbursable maximum', () => {
    const d = decide({ gasEstimate: KEEPER_MAX_GAS + 1n, expectedReward: 10n ** 18n, baseFee: 0n, priorityFee: 0n, maxLossWei: 0n });
    expect(d.send).toBe(false);
  });
});
