import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { DESIGNS, V1, V2, runScenario, transactionCost, demandAt, playerVrfFeeAt } from '../sim/fund';
import { keeperWorkAt, DENOMS } from './planner';

const base = { ...DESIGNS[1], name: 'test mixed board', markupBps: 2500, days: 3, drawsPerDay: 10, baseFee: 500_000_000n };
describe('keeper policy economic model', () => {
  it('matches the real five-word batch slippage branch and charges VRF on every refunded request', () => {
    // Same board, basefee, purchaser bid and words as test/BatchSlippage.t.sol.
    // Only branch/prize-price/service-fee parity is asserted; modeled keeper gas and cash differ.
    const scenario = { name: 'controlled batch comparison', target: DENOMS.map((_, d) => d === 0 ? 5 : d === 1 ? 3 : d === 2 ? 2 : 0),
      nftValues: [parseEther('0.25'), parseEther('0.5')], markupBps: 1500, days: 1, drawsPerDay: 5,
      baseFee: 80_000_000n, playerGasPrice: 80_000_000n, initialCapital: parseEther('3'), selectionWords: Array(5).fill(6_000_000_000_000_000_000n) };
    const batch = runScenario({ ...scenario, burst: 5 });
    const singles = runScenario({ ...scenario, burst: 1 });
    expect(batch.draws).toBe(5);
    expect(batch.fulfilledDraws).toBe(1);
    expect(batch.refunded).toBe(4);
    expect(batch.slippageRefunds).toBe(4);
    expect(batch.emptyBoardRefunds).toBe(0);
    expect(batch.playerSpendWei).toBe('27137220785149510');
    expect(batch.playerRefundsWei).toBe('108548883140598040');
    expect(batch.deliveredBacking).toBe(0.01);
    expect(singles.draws).toBe(5);
    expect(singles.fulfilledDraws).toBe(5);
    expect(singles.refunded).toBe(0);
    expect(singles.deliveredBacking).toBe(0.05);
    expect(singles.playerSpendWei).toBe('135686103925747550');
    expect(playerVrfFeeAt(80_000_000n)).toBe(187_200_000_000_000n);
    expect(batch.playerVrfCostWei).toBe('936000000000000');
    expect(singles.playerVrfCostWei).toBe(batch.playerVrfCostWei);
    expect(batch.playerVrfCostOnRefundsWei).toBe('748800000000000');
    expect(singles.playerVrfCostOnRefundsWei).toBe('0');
    expect(batch.playerTotalSpend).toBeCloseTo(batch.playerSpend + 0.000936, 15);
    expect(singles.finalDrawPrice).toBe(singles.drawPrice);
    expect(batch.accountingDifferenceWei).toBe('0');
    expect(singles.accountingDifferenceWei).toBe('0');
  });

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
    expect(r.creatorProfitWithdrawn).toBe(0);
    expect(r.creatorWithdrawals).toBeGreaterThan(0);
    expect(r.accountingDifferenceWei).toBe('0');
  });

  it('exposes unavailable time during a sustained high-gas period and resumes after it', () => {
    const r = runScenario({ ...base, days: 5, spikeDay: 1, spikeDays: 2 });
    expect(r.draws).toBe(30);
    expect(r.unavailableSeconds).toBeGreaterThanOrEqual(2 * 86400);
    expect(r.accountingDifferenceWei).toBe('0');
  });

  it('reduces hypothetical demand when prices rise while accounting for changing board composition', () => {
    expect(demandAt(100, 100n, 120n, 1)).toBe(83);
    expect(demandAt(100, 100n, 120n, 2)).toBe(69);
    const sensitive = runScenario({ ...base, days: 10, drawsPerDay: 40, switchDay: 1, elasticity: 2, replaceCurated: true });
    expect(sensitive.finalDrawPrice).toBeGreaterThan(sensitive.drawPrice);
    expect(demandAt(40, BigInt(Math.round(sensitive.drawPrice * 1e18)), BigInt(Math.round(sensitive.finalDrawPrice * 1e18)), 2)).toBe(39);
    expect(sensitive.accountingDifferenceWei).toBe('0');
  });

  it('does not bridge a whole old board when the new maximum is above every current work bound', () => {
    const r = runScenario({ ...base, drawsPerDay: 0, switchDay: 1 });
    expect(r.switchTopup).toBe(0);
    expect(r.finalDrawPrice).toBe(r.drawPrice);
    expect(r.missingPrizes).toBe(0);
    expect(r.accountingDifferenceWei).toBe('0');
  });

  it('funds only the higher current working buffer on an otherwise identical high-gas policy switch', () => {
    const r = runScenario({ ...base, drawsPerDay: 0, baseFee: 5_000_000_000n, switchDay: 1 });
    expect(r.switchTopup).toBeCloseTo(0.01108, 12);
    expect(r.finalDrawPrice).toBe(r.drawPrice);
  });

  it('keeps expensive deficits visible while the actual weighted admission gate can remain open', () => {
    const r = runScenario({ ...base, markupBps: 1500, drawsPerDay: 40, forcedLargeEvery: 1 });
    expect(r.missingPrizes).toBeGreaterThan(0);
    expect(r.restockShortfall).toBeGreaterThan(0);
    expect(r.switchTopup).toBe(0);
    expect(r.endStatus).toBe('open');
    expect(r.creatorNet).toBeLessThan(0);
    expect(r.accountingDifferenceWei).toBe('0');
  });

  it('does not invent revenue after depletion has closed the purchase gate', () => {
    const r = runScenario({ ...base, target: DENOMS.map((_, d) => d === 0 ? 10 : 0),
      nftValues: [parseEther('0.0001')], forcedLargeEvery: 1, days: 3, drawsPerDay: 40 });
    expect(r.endStatus).toBe('inventory below admission threshold');
    expect(r.missingPrizes).toBeGreaterThan(0);
    expect(r.draws).toBeLessThan(10);
    expect(r.blockedDraws).toBeGreaterThan(100);
    expect(r.switchTopup).toBe(0);
    expect(r.accountingDifferenceWei).toBe('0');
  });

  it('stops at the last curated NFT instead of supplying an invisible replacement', () => {
    const r = runScenario({ ...base, nftValues: [parseEther('0.000001')], days: 3, drawsPerDay: 40 });
    expect(r.endStatus).toBe('no curated NFT');
    expect(r.curatedReplacements).toBe(0);
    expect(r.nftsContributed).toBe(0.000001);
    expect(r.blockedDraws).toBeGreaterThan(0);
    expect(r.accountingDifferenceWei).toBe('0');
  });

  it('preserves the creator markup share even when a large win turns a funded board into a deficit', () => {
    const r = runScenario({ ...base, days: 1, drawsPerDay: 1, forceFirstLargest: true });
    expect(r.missingPrizes).toBeGreaterThan(0);
    // Independent initial 48-listing FWA EV and 15% above-floor markup at base/bid 0.5/0.55 gwei.
    expect(r.profitCredited).toBeCloseTo(0.002355773536669513, 15);
    expect(r.ownerProceeds).toBeCloseTo(0.021999804215742121, 15);
    expect(r.profitCredited).toBeLessThan(r.ownerProceeds);
    expect(r.accountingDifferenceWei).toBe('0');
  });

});
