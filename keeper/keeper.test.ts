import { describe, expect, it } from 'vitest';
import { decide, KEEPER_MAX_GAS } from './keeper';

const GWEI = 10n ** 9n;
/**
 * PoolBalancer._payKeeper: price = min(bid, basefee + 0.05 gwei, 5 gwei); measured gas x price + 0.0005 ETH, capped
 * outside creator work by `credit`, the restocking fees of the prizes the call lists.
 */
const reward = (measured: bigint, baseFee: bigint, bid: bigint, credit = 10n ** 18n) => {
  let price = bid;
  if (price > baseFee + GWEI / 20n) price = baseFee + GWEI / 20n;
  if (price > 5n * GWEI) price = 5n * GWEI;
  const full = measured * price + 5n * 10n ** 14n;
  return full < credit ? full : credit;
};

describe('keeper profitability policy across gas prices', () => {
  // A 1-Shape replacement, costed the way a keeper must: eth_estimateGas, measured 70-80k above the measured span.
  const measured = 820_000n;
  const billed = 900_000n;
  for (const baseGwei of [0.05, 0.2, 1, 2, 4.9]) {
    it(`replacement upkeep is worth sending at ${baseGwei} gwei basefee`, () => {
      const baseFee = BigInt(Math.round(baseGwei * 1e9));
      const prio = GWEI / 20n;
      const d = decide({ gasEstimate: billed, expectedReward: reward(measured, baseFee, baseFee + prio), baseFee, priorityFee: prio, maxLossWei: 0n });
      expect(d.send).toBe(true);
    });
  }

  it('waits above the 5 gwei cap (basefee spike)', () => {
    const baseFee = 8n * GWEI;
    const d = decide({ gasEstimate: billed, expectedReward: reward(measured, baseFee, baseFee + GWEI / 20n), baseFee, priorityFee: GWEI / 20n, maxLossWei: 0n });
    expect(d).toEqual({ send: false, reason: 'unprofitable at current gas' });
  });

  it('waits when the credit cannot cover the call (a reconcile-only call at high gas)', () => {
    const baseFee = 4n * GWEI;
    const credit = 6n * 10n ** 14n; // ~0.0006 ETH left over from earlier restocks
    const r = reward(measured, baseFee, baseFee + GWEI / 20n, credit);
    expect(decide({ gasEstimate: billed, expectedReward: r, baseFee, priorityFee: GWEI / 20n, maxLossWei: 0n }).send).toBe(false);
  });

  it('overbidding priority never pays: the excess is not reimbursed', () => {
    const baseFee = GWEI / 5n;
    const prio = 3n * GWEI; // the ApeBall bot's bid
    const r = reward(measured, baseFee, baseFee + prio);
    expect(decide({ gasEstimate: billed, expectedReward: r, baseFee, priorityFee: prio, maxLossWei: 0n }).send).toBe(false);
  });

  // Refund-only batch: ~164k measured, ~197k billed, estimate ~78k above billed. A refund earns no restocking fee.
  it('unpaid work is sent only within the loss allowance at low gas', () => {
    const prio = GWEI / 20n;
    const bf = GWEI / 10n;
    const r = reward(164_000n, bf, bf + prio, 0n);
    expect(r).toBe(0n);
    expect(decide({ gasEstimate: 275_000n, expectedReward: r, baseFee: bf, priorityFee: prio, maxLossWei: 0n }).send).toBe(false);
    expect(decide({ gasEstimate: 275_000n, expectedReward: r, baseFee: bf, priorityFee: prio, maxLossWei: 2n * 10n ** 14n }).send).toBe(true);
  });

  it('unpaid work waits for the creator near the cap', () => {
    const bf = 4_950_000_000n;
    const r = reward(164_000n, bf, bf + GWEI / 20n, 0n);
    expect(decide({ gasEstimate: 275_000n, expectedReward: r, baseFee: bf, priorityFee: GWEI / 20n, maxLossWei: 2n * 10n ** 14n }).send).toBe(false);
  });

  it('never sends a call estimated above the reimbursable maximum', () => {
    const d = decide({ gasEstimate: KEEPER_MAX_GAS + 1n, expectedReward: 10n ** 18n, baseFee: 0n, priorityFee: 0n, maxLossWei: 0n });
    expect(d.send).toBe(false);
  });
});
