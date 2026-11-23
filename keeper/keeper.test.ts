import { describe, expect, it } from 'vitest';
import { BaseError } from 'viem';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, gasLimitFor, Keeper, STUCK_TICKS, MAX_TRANSACTION_GAS, minimumPayment, paymentAt, paymentFloor, traceGasUsed, tracingUnsupported, UPKEEP_GAS_FLOOR } from './keeper';

const GWEI = 10n ** 9n;

describe('keeper expense budget, independently of payment policy', () => {
  for (const baseFee of [150_000_000n, 500_000_000n, 4_950_000_000n]) {
    it(`requires the actual offered reward to cover its expense budget at ${baseFee} wei basefee`, () => {
      const p = { gasEstimate: 900_000n, baseFee, priorityFee: 50_000_000n, maxLossWei: 0n };
      const cost = 900_000n * (baseFee + 50_000_000n);
      expect(minimumPayment(p)).toBe(cost);
      expect(decide({ ...p, expectedReward: cost })).toEqual({ send: true, reason: 'ok' });
      expect(decide({ ...p, expectedReward: cost - 1n })).toEqual({ send: false, reason: 'unprofitable at current gas' });
    });
  }

  it('fixes a concrete minimum in calldata after the operator subsidy allowance', () => {
    const p = { gasEstimate: 800_000n, baseFee: 500_000_000n, priorityFee: 50_000_000n, maxLossWei: 100_000_000_000_000n };
    // 800k gas x 0.55 gwei = 0.00044 ETH; the operator accepts at most 0.0001 ETH less.
    expect(minimumPayment(p)).toBe(340_000_100_000_000n);
    expect(decide({ ...p, expectedReward: 339_999_999_999_999n }).send).toBe(false);
    expect(decide({ ...p, expectedReward: 340_000_100_000_000n }).send).toBe(true);
  });

  it('does not invert a reward to manufacture a lower expense estimate', () => {
    // A policy may pay any formula. A 0.004 ETH offer does not prove what gas or service fees it contains.
    const p = { gasEstimate: 2_830_000n, expectedReward: 4_000_000_000_000_000n, baseFee: 2n * GWEI, priorityFee: 50_000_000n, maxLossWei: 0n };
    expect(decide(p).send).toBe(false);
    expect(minimumPayment(p)).toBe(5_801_500_000_000_000n);
  });

  it('prices traced expense separately from an executable gas limit', () => {
    const p = { gasEstimate: 2_830_000n, expenseGas: 2_200_000n, expectedReward: 4_600_000_000_000_000n, baseFee: 2n * GWEI, priorityFee: 50_000_000n, maxLossWei: 0n };
    expect(minimumPayment(p)).toBe(4_510_000_000_000_000n);
    expect(decide(p).send).toBe(true);
    expect(decide({ ...p, expenseGas: undefined }).send).toBe(false);
  });

  it('includes configured operating and failed-attempt expenses', () => {
    const p = { gasEstimate: 100_000n, baseFee: GWEI, priorityFee: 0n, operatingCostWei: 20_000_000_000_000n, maxLossWei: 0n };
    expect(minimumPayment(p)).toBe(120_000_000_000_000n);
    expect(decide({ ...p, expectedReward: 110_000_000_000_000n }).send).toBe(false);
  });

  it('re-pricing changed work or a bumped fee raises the required payment', () => {
    const p = { gasEstimate: 500_000n, baseFee: GWEI, priorityFee: 50_000_000n, maxLossWei: 0n };
    expect(minimumPayment({ ...p, gasEstimate: 1_000_000n })).toBe(2n * minimumPayment(p));
    expect(minimumPayment({ ...p, priorityFee: 250_000_000n })).toBe(625_000_000_000_000n);
  });

  it('never returns a negative payment floor', () => {
    const p = { gasEstimate: 100_000n, baseFee: 0n, priorityFee: 0n, maxLossWei: 1n };
    expect(minimumPayment(p)).toBe(0n);
    expect(decide({ ...p, expectedReward: 0n }).send).toBe(true);
  });
});

describe('executable gas limits', () => {
  it('covers work that arrives between estimation and inclusion', () => {
    expect(gasLimitFor(674_278n)).toBe(UPKEEP_GAS_FLOOR);
    expect(gasLimitFor(UPKEEP_GAS_FLOOR)).toBe(5_200_000n);
  });

  it('refuses a gas limit beyond EIP-7825 instead of broadcasting an invalid transaction', () => {
    expect(gasLimitFor(12_000_000n)).toBe(15_600_000n);
    expect(() => gasLimitFor(MAX_TRANSACTION_GAS)).toThrow('EIP-7825');
  });
});

describe('trace data validation', () => {
  it('parses only a successful transaction gas amount within the executable limit', () => {
    expect(traceGasUsed({ gasUsed: '0x33450' }, 1_000_000n)).toBe(210_000n);
    for (const value of [undefined, {}, { gasUsed: '0x0' }, { gasUsed: '210000' }, { gasUsed: '0x33450', error: 'revert' }, { gasUsed: '0xffffff' }]) {
      expect(() => traceGasUsed(value, 1_000_000n)).toThrow('invalid execution trace');
    }
  });
});

it('only provider capability failures disable tracing for other pools', () => {
  const failure = (code: number) => new BaseError('RPC failed', { cause: Object.assign(new Error('RPC failure'), { code }) });
  expect(tracingUnsupported(failure(-32601))).toBe(true);
  expect(tracingUnsupported(failure(-32004))).toBe(true);
  expect(tracingUnsupported(failure(-32000))).toBe(false);
  expect(tracingUnsupported(new Error('timeout'))).toBe(false);
});

describe('fee-indexed minimum payment', () => {
  it('bounds the modeled loss for every inclusion fee up to the transaction fee ceiling', () => {
    const p = { expenseGas: 900_000n, maxFeePerGas: 5_000_000_000n, maxLossWei: 100_000_000_000_000n, operatingCostWei: 20_000_000_000_000n };
    const floor = paymentFloor(p);
    expect(floor).toEqual({ minimumReward: 20_000_000_000_000n, minimumGas: 880_000n });
    for (const price of [0n, 150_000_000n, 500_000_000n, 4_375_000_000n, 5_000_000_000n]) {
      const modeledExpense = p.expenseGas * price + p.operatingCostWei;
      const minimum = paymentAt(floor, price);
      expect(modeledExpense - minimum).toBeLessThanOrEqual(p.maxLossWei);
      expect(minimum).toBeGreaterThanOrEqual(p.operatingCostWei);
    }
    expect(paymentAt(floor, p.maxFeePerGas)).toBe(4_420_000_000_000_000n);
  });

  it('does not reject profitable work solely because basefee fell after quoting', () => {
    const floor = paymentFloor({ expenseGas: 900_000n, maxFeePerGas: 5_000_000_000n, maxLossWei: 100_000_000_000_000n });
    const oldPrice = 5_000_000_000n;
    const newPrice = oldPrice * 7n / 8n;
    const offered = 900_000n * newPrice + 20_000_000_000_000n;
    expect(offered).toBeLessThan(paymentAt(floor, oldPrice));
    expect(offered).toBeGreaterThan(paymentAt(floor, newPrice));
    expect(offered - 900_000n * newPrice).toBe(20_000_000_000_000n);
  });
});

describe('health', () => {
  const pool = '0x0000000000000000000000000000000000000001';
  const make = () => {
    const k = new Keeper({ rpcUrl: 'http://127.0.0.1:1', factory: '0x0000000000000000000000000000000000000002', fromBlock: 1n,
      stateFile: '/nonexistent/keeper-health-test.json', account: '0x0000000000000000000000000000000000000003' });
    k.lastTick = Date.now();
    return k;
  };

  it(`fails after ${STUCK_TICKS} consecutive errors on one pool, and recovers on its next success`, () => {
    const k = make();
    for (let i = 1; i < STUCK_TICKS; i++) k.recordPool(pool, new Error('upkeep simulation reverted\ndetail'));
    expect(k.health().ok).toBe(true);
    expect(k.health().errors[pool]).toBe('upkeep simulation reverted');
    k.recordPool(pool, new Error('upkeep simulation reverted'));
    expect(k.health()).toMatchObject({ ok: false, stuck: [pool] });
    k.recordPool(pool);
    expect(k.health()).toMatchObject({ ok: true, stuck: [], errors: {} });
  });

  it('keeps the count across a restart', () => {
    const stateFile = join(mkdtempSync(join(tmpdir(), 'keeper-health-')), 'state.json');
    const opts = { rpcUrl: 'http://127.0.0.1:1', factory: '0x0000000000000000000000000000000000000002' as const, fromBlock: 1n,
      stateFile, account: '0x0000000000000000000000000000000000000003' as const };
    const first = new Keeper(opts);
    for (let i = 0; i < 2; i++) first.recordPool(pool, new Error('x'));
    first.save();
    const second = new Keeper(opts);
    second.lastTick = Date.now();
    for (let i = 2; i < STUCK_TICKS; i++) second.recordPool(pool, new Error('x'));
    expect(second.health()).toMatchObject({ ok: false, stuck: [pool] });
  });

  it('a success between errors restarts the count', () => {
    const k = make();
    for (let i = 1; i < STUCK_TICKS; i++) k.recordPool(pool, new Error('x'));
    k.recordPool(pool);
    for (let i = 1; i < STUCK_TICKS; i++) k.recordPool(pool, new Error('x'));
    expect(k.health().ok).toBe(true);
  });
});
