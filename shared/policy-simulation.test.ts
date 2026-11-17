import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { DESIGNS, V1, V2, runScenario, transactionCost } from '../sim/fund';
import { keeperWorkAt } from './planner';

const base = { ...DESIGNS[1], name: 'test mixed board', markupBps: 2500, days: 3, drawsPerDay: 10, baseFee: 500_000_000n };
describe('keeper policy economic model', () => {
  it('checks an absolute payment and its separate execution expense', () => {
    const w = keeperWorkAt(500_000_000n, 550_000_000n, 0);
    expect(V1.reward(w)).toBe(542_700_000_000_000n);
    expect(transactionCost(w)).toBe(502_700_000_000_000n);
    expect(V2.reward(w)).toBe(535_680_000_000_000n);
    expect(V2.surcharge(0, w.baseFee)).toBe(744_000_000_000_000n);
    expect(V2.surcharge(10, w.baseFee)).toBe(1_322_000_000_000_000n);
  });

  it('preserves exact ETH and NFT accounting with funded policy replacement and refunds', () => {
    const r = runScenario({ ...base, switchDay: 1, refundEvery: 5 });
    expect(r.accountingDifferenceWei).toBe('0');
    expect(r.draws).toBe(30);
    expect(r.refunded).toBe(6);
    expect(r.switchTopup).toBeGreaterThan(0);
    expect(r.finalDrawPrice).not.toBe(r.drawPrice);
    expect(r.creatorNet).toBeLessThan(r.playerSpend);
  });

  it('counts zero demand as setup cost, without imaginary listing-fee revenue', () => {
    const r = runScenario({ ...base, drawsPerDay: 0 });
    expect(r.draws).toBe(0);
    expect(r.playerSpend).toBe(0);
    expect(r.creatorNet).toBeLessThan(0);
    expect(r.keeperPay).toBe(r.setupKeeperPay);
    expect(r.accountingDifferenceWei).toBe('0');
  });

  it('exposes unavailable time during a sustained high-gas period and resumes after it', () => {
    const r = runScenario({ ...base, days: 5, spikeDay: 1, spikeDays: 2 });
    expect(r.draws).toBe(30);
    expect(r.unavailableSeconds).toBeGreaterThanOrEqual(2 * 86400);
    expect(r.accountingDifferenceWei).toBe('0');
  });

  it('models demand sensitivity as reduced volume rather than treating higher prices as free income', () => {
    const fixed = runScenario({ ...base, days: 10, drawsPerDay: 40, switchDay: 1 });
    const sensitive = runScenario({ ...base, days: 10, drawsPerDay: 40, switchDay: 1, elasticity: 2 });
    expect(sensitive.draws).toBeLessThan(fixed.draws);
    expect(sensitive.playerSpend).toBeLessThan(fixed.playerSpend);
  });
});
