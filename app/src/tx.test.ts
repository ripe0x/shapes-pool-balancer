import { describe, expect, it } from 'vitest';
import { mainnet } from 'viem/chains';
import { writeContract } from '@wagmi/core';
import { prepareWrite } from './tx';

const ACCOUNT = '0x00000000000000000000000000000000000c0ffe' as const;
const FEES = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 50_000_000n };
const CALL = { address: '0x00000000000000000000000000000000000ba1a5', abi: [], functionName: 'listCurated', args: [1n, 2n], value: 3n };

/** Records every call so tests can check what was simulated and estimated. */
function client(opts: { estimate?: bigint; simulateError?: Error; estimateError?: Error } = {}) {
  const calls: { fn: string; arg: Record<string, unknown> }[] = [];
  return {
    calls,
    chain: { id: 1 },
    estimateFeesPerGas: async () => FEES,
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
    expect(out).toEqual({ ...CALL, ...FEES, account: ACCOUNT, chainId: 1, gas: 856_328n });
    expect(c.calls.map((x) => x.fn)).toEqual(['simulate', 'estimate']);
    // Simulated and estimated at the fees it is sent with (round 8 E6: price 0 under-quotes upkeep and VRF).
    for (const x of c.calls) expect(x.arg).toEqual({ ...CALL, ...FEES, account: ACCOUNT });
  });

  it('keeps fees the caller supplied', async () => {
    const c = client();
    const mine = { maxFeePerGas: 9n, maxPriorityFeePerGas: 1n };
    const out = await prepareWrite(c as never, ACCOUNT, { ...CALL, ...mine });
    expect(out).toMatchObject(mine);
    expect(c.calls[0].arg).toMatchObject(mine);
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

  it('names the simulated account and chain, so the wallet sends only from them', async () => {
    const abi = [{ type: 'function', name: 'listCurated', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [], stateMutability: 'payable' }];
    const out = await prepareWrite(client() as never, ACCOUNT, { ...CALL, abi });
    const sent: string[] = [];
    /** A wagmi config whose injected wallet is connected with `account` on `chainId`. */
    const wallet = (account: string, chainId: number) => {
      const provider = {
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
          sent.push(method);
          return `0x${'11'.repeat(32)}`;
        },
      };
      const connector = { getChainId: async () => chainId, getProvider: async () => provider };
      return {
        state: { status: 'connected', current: 'w', connections: new Map([['w', { accounts: [account], chainId, connector }]]) },
        chains: [mainnet],
      } as never;
    };
    await expect(writeContract(wallet('0x00000000000000000000000000000000000000bb', 1), out as never)).rejects.toThrow(/Account .* not found for connector/);
    await expect(writeContract(wallet(ACCOUNT, 31337), out as never)).rejects.toThrow(/does not match/);
    expect(sent).toEqual([]);
    await writeContract(wallet(ACCOUNT, 1), out as never);
    expect(sent).toEqual(['eth_sendTransaction']);
  });
});
