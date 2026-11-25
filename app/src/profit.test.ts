import { expect, it } from 'vitest';
import { BaseError, ContractFunctionZeroDataError } from 'viem';
import { operatingCash, readProfitVersion, withdrawalBreakdown } from './profit';

it('does not classify a transport failure as legacy accounting', async () => {
  const failure = new BaseError('RPC unavailable', { cause: new Error('connection refused') });
  const pub = { readContract: async () => { throw failure; } };
  await expect(readProfitVersion(pub, '0x0000000000000000000000000000000000000001', 1n)).rejects.toBe(failure);
});

it('recognizes an unsupported version selector through the viem error chain', async () => {
  const failure = new BaseError('Contract call failed', { cause: new ContractFunctionZeroDataError({ functionName: 'profitAccountingVersion' }) });
  const pub = { readContract: async () => { throw failure; } };
  await expect(readProfitVersion(pub, '0x0000000000000000000000000000000000000001', 1n)).resolves.toBe(0n);
});

it('keeps all cash usable for cost-first maintenance without double-subtracting informational profit', () => {
  expect(operatingCash(100n, 30n, true)).toBe(100n);
  expect(operatingCash(10n, 30n, true)).toBe(10n);
  expect(operatingCash(100n, 30n, false)).toBe(70n);
});

it('shows only reserve-gated available profit and closed capital separately', () => {
  expect(withdrawalBreakdown(30n, 0n, true)).toEqual({ total: 0n, earnings: 0n, capital: 0n });
  expect(withdrawalBreakdown(30n, 20n, true)).toEqual({ total: 20n, earnings: 20n, capital: 0n });
  expect(withdrawalBreakdown(30n, 100n, true)).toEqual({ total: 100n, earnings: 30n, capital: 70n });
  expect(withdrawalBreakdown(30n, undefined, true)).toEqual({ total: 0n, earnings: 0n, capital: undefined });
});

it('preserves protected-credit withdrawal display for earlier immutable clones', () => {
  expect(withdrawalBreakdown(30n, 100n, false)).toEqual({ total: 100n, earnings: 30n, capital: 70n });
  expect(withdrawalBreakdown(30n, undefined, false)).toEqual({ total: 30n, earnings: 30n, capital: undefined });
});
