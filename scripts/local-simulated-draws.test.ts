import { expect, it } from 'vitest';
import { encodeFunctionData } from 'viem';
import { poolBalancerAbi } from '../shared/abi';
import { SCOPE, TOPUP_WEI, additionalDrawTarget, fullyRestocked, keeperBudget, keeperGateAcknowledged, requestDeadline, testWord, validateCalldata, validateScope, validateWrite } from './local-simulated-draws';

it('restricts the owner exception to this pool, node endpoint, chain and twenty draws', () => {
  expect(() => validateScope(SCOPE.rpc, 31337, SCOPE.pool, 20)).not.toThrow();
  for (const args of [
    ['https://mainnet.gateway.tenderly.co', 31337, SCOPE.pool, 20],
    [SCOPE.rpc, 1, SCOPE.pool, 20], [SCOPE.rpc, 31337, SCOPE.balancer, 20],
    [SCOPE.rpc, 31337, SCOPE.pool, 21],
  ] as const) expect(() => validateScope(args[0], args[1], args[2], args[3])).toThrow();
});

it('permits only buyer purchases/processing/unpaid upkeep and simulated own-service callbacks', () => {
  expect(() => validateWrite(SCOPE.buyer, SCOPE.pool, 'acquireBatch', [SCOPE.buyer, 1n, 1n, 0n, 10000n, 1n, 1n], 1n)).not.toThrow();
  expect(() => validateWrite(SCOPE.buyer, SCOPE.pool, 'processAcquisitions', [1n], 0n)).not.toThrow();
  expect(() => validateWrite(SCOPE.buyer, SCOPE.balancer, 'performUpkeepUnpaid', [], 0n)).not.toThrow();
  expect(() => validateWrite(SCOPE.coordinator, SCOPE.service, 'rawFulfillRandomWords', [1n, [testWord(1n)]], 0n)).not.toThrow();
  for (const args of [
    [SCOPE.buyer, SCOPE.service, 'rawFulfillRandomWords', [1n, [1n]], 0n],
    [SCOPE.coordinator, SCOPE.pool, 'rawFulfillRandomWords', [1n, [1n]], 0n],
    [SCOPE.coordinator, SCOPE.service, 'rawFulfillRandomWords', [1n, []], 0n],
    [SCOPE.coordinator, SCOPE.service, 'rawFulfillRandomWords', [1n, [1n]], 1n],
    [SCOPE.buyer, SCOPE.balancer, 'depositETH', [], 1n],
    [SCOPE.buyer, SCOPE.balancer, 'claimSurplus', [1n, SCOPE.buyer], 0n],
    [SCOPE.buyer, SCOPE.pool, 'processAcquisitions', [20n], 0n],
    [SCOPE.buyer, SCOPE.pool, 'acquireBatch', [SCOPE.coordinator, 1n, 1n, 0n, 10000n, 1n, 1n], 1n],
    [SCOPE.buyer, SCOPE.pool, 'acquireBatch', [SCOPE.buyer, 5n, 1n, 0n, 10000n, 1n, 1n], 1n],
    [SCOPE.buyer, SCOPE.pool, 'acquireBatch', [SCOPE.buyer, 1n, 1n, 0n, 10000n, 1n, 1n], SCOPE.purchaseCapWei + 1n],
  ] as const) expect(() => validateWrite(args[0], args[1], args[2], args[3], args[4])).toThrow();
});

it('derives repeatable test words from request IDs independently of prizes or inventory', () => {
  expect(testWord(1n)).toBe(testWord(1n)); expect(testWord(1n)).not.toBe(testWord(2n));
  expect(testWord(1n)).toBeGreaterThanOrEqual(0n); expect(testWord(1n)).toBeLessThan(2n ** 256n);
});

it('accepts actual zero-argument ABI calldata and rejects a different decoded action or args', () => {
  const data = encodeFunctionData({ abi: poolBalancerAbi, functionName: 'performUpkeepUnpaid' });
  expect(() => validateCalldata(poolBalancerAbi, data, 'performUpkeepUnpaid', [])).not.toThrow();
  expect(() => validateCalldata(poolBalancerAbi, data, 'collectProceeds', [])).toThrow();
  expect(() => validateCalldata(poolBalancerAbi, data, 'performUpkeepUnpaid', [1n])).toThrow();
});

it('allows only the separately approved exact contribution to this Balancer from the existing test buyer', () => {
  expect(() => validateWrite(SCOPE.buyer, SCOPE.balancer, 'depositETH', [], TOPUP_WEI, true)).not.toThrow();
  expect(() => validateWrite(SCOPE.buyer, SCOPE.balancer, 'depositETH', [], TOPUP_WEI)).toThrow();
  expect(() => validateWrite(SCOPE.buyer, SCOPE.balancer, 'depositETH', [], TOPUP_WEI + 1n, true)).toThrow();
  expect(() => validateWrite(SCOPE.coordinator, SCOPE.balancer, 'depositETH', [], TOPUP_WEI, true)).toThrow();
  expect(() => validateWrite(SCOPE.buyer, SCOPE.pool, 'depositETH', [], TOPUP_WEI, true)).toThrow();
});

it('never labels a partial or differently distributed prize mix as fully restocked', () => {
  expect(fullyRestocked([7, 4, 1, 2], [7, 4, 1, 2])).toBe(true);
  expect(fullyRestocked([7, 3, 1, 2], [7, 4, 1, 2])).toBe(false);
  expect(fullyRestocked([8, 3, 1, 2], [7, 4, 1, 2])).toBe(false);
  expect(fullyRestocked([7, 4, 1], [7, 4, 1, 2])).toBe(false);
});

it('reserves keeper pending/accounting gas once per nonce at its largest liability', () => {
  expect(keeperBudget({})).toEqual({ gas: 0n, transactions: 0 });
  expect(keeperBudget({ stats: { spentWei: '100', sent: 2, replaced: 1 },
    pending: { pool: { nonce: 7, gas: '10', maxFeePerGas: '20' } },
    accounting: { seven: { pending: { nonce: 7, gas: '20', maxFeePerGas: '20' } },
      eight: { pending: { nonce: 8, gas: '5', maxFeePerGas: '10' } } },
  })).toEqual({ gas: 550n, transactions: 3 });
});

it('keeps an idle fork purchase deadline ahead of both wall and chain timestamps', () => {
  expect(requestDeadline(1000n, 2000n)).toBe(2600n);
  expect(requestDeadline(2000n, 1000n)).toBe(2600n);
});

it('fixes an additional batch target so an interrupted resume does not request X more wins again', () => {
  expect(additionalDrawTarget(20, [], 3)).toEqual({ count: 3, startWins: 20, targetWins: 23, resume: false });
  const pending = { count: 3, startWins: 20, targetWins: 23, drawsComplete: false };
  expect(additionalDrawTarget(21, [pending], 3)).toEqual({ ...pending, resume: true });
  expect(additionalDrawTarget(23, [pending], 3).targetWins).toBe(23);
  expect(() => additionalDrawTarget(21, [pending], 2)).toThrow();
  expect(() => additionalDrawTarget(24, [pending], 3)).toThrow();
  expect(additionalDrawTarget(23, [{ ...pending, drawsComplete: true }], 2).targetWins).toBe(25);
});

it('rejects additional counts outside the current 1..10 scope and cannot extend an unfinished original batch', () => {
  for (const count of [0, -1, 1.5, 11, NaN, Infinity]) expect(() => additionalDrawTarget(20, [], count)).toThrow();
  expect(() => additionalDrawTarget(19, [], 1)).toThrow();
  expect(() => additionalDrawTarget(20, [{ count: 3, startWins: 20, targetWins: 24 }], 3)).toThrow();
  expect(SCOPE.count).toBe(20); expect(SCOPE.maxTransactions).toBe(100);
});

it('acknowledges a draw gate only after a newer keeper tick has drained pending and accounting work', () => {
  const drained = { pending: {}, accounting: {} };
  expect(keeperGateAcknowledged(100n, 99n, drained)).toBe(false);
  expect(keeperGateAcknowledged(100n, 100n, drained)).toBe(false);
  expect(keeperGateAcknowledged(100n, 101n, drained)).toBe(true);
  expect(keeperGateAcknowledged(100n, 101n, { pending: { pool: {} }, accounting: {} })).toBe(false);
  expect(keeperGateAcknowledged(100n, 101n, { pending: {}, accounting: { nonce: {} } })).toBe(false);
});
