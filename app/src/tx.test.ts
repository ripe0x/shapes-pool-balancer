import { describe, expect, it } from 'vitest';
import { prepareWrite } from './tx';

const ACCOUNT = '0x00000000000000000000000000000000000c0ffe' as const;
const CALL = { address: '0x00000000000000000000000000000000000ba1a5', abi: [], functionName: 'listCurated', args: [1n, 2n], value: 3n };

/** Records every call so tests can check what was simulated and estimated. */
function client(opts: { estimate?: bigint; simulateError?: Error; estimateError?: Error } = {}) {
  const calls: { fn: string; arg: Record<string, unknown> }[] = [];
  return {
    calls,
    simulateContract: async (arg: never) => {
      calls.push({ fn: 'simulate', arg });
      if (opts.simulateError) throw opts.simulateError;
      return {} as never;
    },
    estimateContractGas: async (arg: never) => {
      calls.push({ fn: 'estimate', arg });
      if (opts.estimateError) throw opts.estimateError;
      return opts.estimate ?? 100_000n;
    },
  };
}

describe('prepareWrite', () => {
  it('sets the gas limit to the estimate + 30% for the exact call and account', async () => {
    const c = client({ estimate: 658_714n });
    const out = await prepareWrite(c as never, ACCOUNT, CALL);
    expect(out.gas).toBe(856_328n); // 658,714 × 1.3, rounded down
    expect(out).toEqual({ ...CALL, gas: 856_328n }); // nothing else changes: no gas price fields are added
    expect(c.calls.map((x) => x.fn)).toEqual(['simulate', 'estimate']);
    for (const x of c.calls) expect(x.arg).toEqual({ ...CALL, account: ACCOUNT });
  });

  it('keeps a gas limit the caller supplied and does not estimate', async () => {
    const c = client();
    const out = await prepareWrite(c as never, ACCOUNT, { ...CALL, gas: 5_000_000n });
    expect(out.gas).toBe(5_000_000n);
    expect(c.calls.map((x) => x.fn)).toEqual(['simulate']);
  });

  it('fails with the simulation error and sends nothing when the call would revert', async () => {
    const err = new Error('PoolBusy');
    const c = client({ simulateError: err });
    await expect(prepareWrite(c as never, ACCOUNT, CALL)).rejects.toBe(err);
    expect(c.calls.map((x) => x.fn)).toEqual(['simulate']);
  });

  it('fails with the estimation error when gas cannot be estimated', async () => {
    const err = new Error('execution reverted');
    const c = client({ estimateError: err });
    await expect(prepareWrite(c as never, ACCOUNT, CALL)).rejects.toBe(err);
  });
});
