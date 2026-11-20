import { parseEther } from 'viem';
import { describe, expect, it } from 'vitest';
import { incrementalRange, poolEthLedger } from './ledger';

const creator = '0x0000000000000000000000000000000000000001' as const;
const donor = '0x0000000000000000000000000000000000000002' as const;
const successor = '0x0000000000000000000000000000000000000003' as const;
const recipient = '0x0000000000000000000000000000000000000004' as const;
const eth = parseEther;
const empty = { deposits: [], withdrawals: [], held: 0n, sales: 0n, prizesWon: 0n, mintFees: 0n, keeperPay: 0n };

describe('pool lifetime operating ETH ledger', () => {
  it('reports zero operating result for either route of the same 1 ETH third-party gift', () => {
    const inputs = { ...empty, deposits: [{ participant: creator, amount: eth('1') }],
      withdrawals: [{ participant: creator, amount: eth('2') }] };
    const direct = poolEthLedger(inputs);
    const recorded = poolEthLedger({ ...inputs, deposits: [...inputs.deposits, { participant: donor, amount: eth('1') }] });
    expect(direct.operatingResult).toBe(0n); expect(recorded.operatingResult).toBe(0n);
    expect(direct.reconciliation).toBe(eth('1')); expect(recorded.reconciliation).toBe(0n);
    expect(recorded.depositors).toEqual([{ participant: creator, amount: eth('1') }, { participant: donor, amount: eth('1') }]);
    expect(recorded.withdrawn - eth('1')).toBe(eth('1')); // Creator wallet transfer result is separate from pool operations.
  });

  it('retains predecessor and successor capital and actual recipients without inferring claim authorization', () => {
    const ledger = poolEthLedger({ ...empty, deposits: [{ participant: creator, amount: eth('1') }, { participant: successor, amount: eth('0.5') }],
      withdrawals: [{ participant: recipient, amount: eth('0.25') }], held: eth('1.25') });
    expect(ledger.deposited).toBe(eth('1.5')); expect(ledger.withdrawn).toBe(eth('0.25'));
    expect(ledger.recipients).toEqual([{ participant: recipient, amount: eth('0.25') }]);
    expect(ledger.operatingResult).toBe(0n); expect(ledger.reconciliation).toBe(0n);
  });

  it('keeps operating flows and unattributed reconciliation separate, including a negative discrepancy', () => {
    const ledger = poolEthLedger({ ...empty, sales: eth('0.5'), prizesWon: eth('0.3'), mintFees: eth('0.01'), keeperPay: eth('0.02'), held: eth('0.15') });
    expect(ledger.operatingResult).toBe(eth('0.17')); expect(ledger.reconciliation).toBe(-eth('0.02'));
  });

  it('groups all deposits and withdrawals by address without making creator identity part of the result', () => {
    const ledger = poolEthLedger({ ...empty, deposits: [{ participant: creator, amount: eth('1') }, { participant: creator, amount: eth('2') }],
      withdrawals: [{ participant: recipient, amount: eth('1') }, { participant: recipient, amount: eth('2') }] });
    expect(ledger.depositors).toEqual([{ participant: creator, amount: eth('3') }]);
    expect(ledger.recipients).toEqual([{ participant: recipient, amount: eth('3') }]);
    expect(ledger.operatingResult).toBe(0n); expect(ledger.reconciliation).toBe(0n);
  });
});

it('fetches ledger logs incrementally, re-reading only the reorg window', () => {
  expect(incrementalRange(undefined, 100n, 64n)).toEqual({ from: 100n, keepThrough: 99n });
  expect(incrementalRange(1_000n, 100n, 64n)).toEqual({ from: 937n, keepThrough: 936n });
  expect(incrementalRange(120n, 100n, 64n)).toEqual({ from: 100n, keepThrough: 56n });
});
