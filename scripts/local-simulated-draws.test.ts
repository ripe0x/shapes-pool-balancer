import { expect, it } from 'vitest';
import { encodeFunctionData } from 'viem';
import { poolBalancerAbi } from '../shared/abi';
import { SCOPE, TOPUP_WEI, testWord, validateCalldata, validateScope, validateWrite } from './local-simulated-draws';

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
