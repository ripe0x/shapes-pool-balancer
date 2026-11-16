import { describe, expect, it } from 'vitest';
import { ContractFunctionRevertedError, toFunctionSelector } from 'viem';
import { poolBalancerAbi } from '../../shared/abi';
import { explain } from './errors';

const revert = (data: `0x${string}`) => new ContractFunctionRevertedError({ abi: poolBalancerAbi, data, functionName: 'unlistShapes' });

describe('explain', () => {
  it('names FWA errors that bubble up through the Balancer', () => {
    expect(explain(revert(toFunctionSelector('WithdrawLocked()')))).toBe('draws are settling on FWA; try again in a minute');
  });
  it('names the Balancer\'s own errors', () => {
    expect(explain(revert(toFunctionSelector('NotClosed()')))).toBe('close purchases first');
  });
  it('falls back to the short message for unknown errors', () => {
    expect(explain(revert('0xdeadbeef'))).toMatch(/0xdeadbeef|reverted/i);
  });
});
