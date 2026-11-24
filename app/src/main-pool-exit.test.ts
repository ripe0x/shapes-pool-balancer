import { parseEther } from 'viem';
import { describe, expect, it } from 'vitest';
import { assertExitReplacementNonce, checkExitSpend, exitCalls, observeExitReceipt, parseSpend, reserveExitReplacement, reserveExitSpend, serializeSpend, signedExitMaximum, type SavedExitSpend } from './main-pool-exit';

describe('caller funded main vault exit', () => {
  it('includes transaction value and maximum gas debit in the remaining spending cap', () => {
    const spend = { limit: parseEther('0.01'), debited: parseEther('0.009'), actualGas: 0n, temporaryFunding: 0n };
    expect(checkExitSpend(spend, 100000n, 1000000000n, parseEther('0.0009'))).toBe(parseEther('0.001'));
    expect(() => checkExitSpend(spend, 100001n, 1000000000n, parseEther('0.0009'))).toThrow('spending limit');
    expect(() => checkExitSpend(spend, 1n, 1n, parseEther('0.001'))).toThrow('spending limit');
  });
  it('retains exact wei across reloads', () => {
    const spend = { limit: 12345678901234567890n, debited: 123456789123456789n, actualGas: 333333333333333n, temporaryFunding: 111111111111111n };
    expect(parseSpend(serializeSpend(spend))).toEqual(spend);
  });
  it('offers necessary unpaid maintenance with a zero routine budget and negative keeper profit', () => {
    const snapshot = { holder: { pendingDeposit: 0n, claimable: 0n, shares: 0n, redeeming: 1n },
      book: { ids: Array.from({ length: 32 }, (_, i) => BigInt(i + 1)), witness: 1n, idle: 1 },
      budget: [0n, 0n], requestCharge: 5n, configHash: `0x${'11'.repeat(32)}` };
    const calls = exitCalls(snapshot as never, 1n, 1n);
    expect(calls.map((c) => c.functionName)).toEqual(['recover', 'recover', 'recoverLiquidate', 'recoverUnlist', 'recoverUnlist', 'recoverCheckpoint']);
    expect((calls[0].args[0] as bigint[])).toHaveLength(16);
    expect(calls.filter((c) => c.functionName === 'recover').some((c) => (c.args[0] as bigint[]).includes(32n))).toBe(true);
    expect(calls.filter((c) => c.functionName === 'recoverUnlist').some((c) => (c.args[0] as bigint[]).includes(32n))).toBe(true);
    expect(calls.find((c) => c.functionName === 'recoverCheckpoint')?.args).toEqual([1n]);
    expect(calls.every((c) => !c.value)).toBe(true);
  });
  it('rejects a second stale tab review against the latest durable reservation and spent allowance', () => {
    const initial: SavedExitSpend = { chainId: 31337, vault: '0x0000000000000000000000000000000000000001',
      holder: '0x0000000000000000000000000000000000000002', limit: String(parseEther('0.01')), debited: '0', temporaryFunding: '0', actualGas: '0' };
    const maximumDebit = parseEther('0.006');
    const pending = { id: 'first-tab', minimumNonce: 0, maximumDebit: String(maximumDebit), value: '0', input: '0x' as const };
    const reserved = reserveExitSpend(initial, parseEther('0.01'), maximumDebit, pending);
    expect(BigInt(reserved.debited)).toBe(maximumDebit);
    expect(() => reserveExitSpend(reserved, parseEther('0.01'), maximumDebit, { ...pending, id: 'second-tab' })).toThrow('unresolved');
    expect(() => reserveExitSpend({ ...reserved, pending: undefined }, parseEther('0.01'), maximumDebit, { ...pending, id: 'second-tab' })).toThrow('spending limit');
    expect(() => reserveExitSpend({ ...initial, limit: String(parseEther('0.02')) }, parseEther('0.01'), maximumDebit, pending)).toThrow('changed');
  });
  it('redeems recovery-only inventory with no ordinary idle pack or open listing', () => {
    const snapshot = { holder: { pendingDeposit: 0n, claimable: 0n, shares: 0n, redeeming: 1n },
      book: { ids: [], witness: 0n, idle: 0, recovery: 1 }, budget: [0n, 0n], requestCharge: 0n };
    const calls = exitCalls(snapshot as never, parseEther('0.03'), 0n);
    expect(calls.map((call) => call.functionName)).toEqual(['recover', 'recoverLiquidate', 'recoverCheckpoint']);
    expect(calls.find((call) => call.functionName === 'recoverLiquidate')?.args).toEqual([16n]);
    expect(exitCalls({ ...snapshot, book: { ...snapshot.book, recovery: 0 } } as never, parseEther('0.03'), 0n)
      .some((call) => call.functionName === 'recoverLiquidate')).toBe(false);
  });
  it('never frees signed capacity when a reverted first receipt can later remine successfully', () => {
    const initial: SavedExitSpend = { chainId: 31337, vault: '0x0000000000000000000000000000000000000001',
      holder: '0x0000000000000000000000000000000000000002', limit: '1000', debited: '0', temporaryFunding: '0', actualGas: '0' };
    const pending = { id: 'first', minimumNonce: 0, maximumDebit: '800', value: '500', input: '0x' as const };
    const signed = reserveExitSpend(initial, 1000n, 800n, pending);
    const revertedObservation = observeExitReceipt(signed, 100n, false);
    expect(revertedObservation.debited).toBe('800');
    expect(revertedObservation.actualGas).toBe('100');
    expect(revertedObservation.temporaryFunding).toBe('0');
    expect(() => reserveExitSpend(revertedObservation, 1000n, 300n, { ...pending, id: 'second', maximumDebit: '300', value: '0' })).toThrow('spending limit');
    // The same signed transaction may reappear with a successful, more expensive execution.
    const canonicalSuccess = observeExitReceipt(signed, 250n, true);
    expect(canonicalSuccess.debited).toBe('800');
    expect(canonicalSuccess.temporaryFunding).toBe('500');
    expect(() => reserveExitSpend(canonicalSuccess, 1000n, 300n, { ...pending, id: 'second', maximumDebit: '300', value: '0' })).toThrow('spending limit');
  });
  it('reserves only a positive replacement maximum delta and blocks a wallet override above the explicit limit', () => {
    const pending = { id: 'signed', minimumNonce: 4, nonce: 5, maximumDebit: '800', value: '500', input: '0x' as const };
    const saved: SavedExitSpend = { chainId: 31337, vault: '0x0000000000000000000000000000000000000001',
      holder: '0x0000000000000000000000000000000000000002', limit: '1000', debited: '900', temporaryFunding: '0', actualGas: '0', pending };
    expect(signedExitMaximum({ gas: 100n, maxFeePerGas: 4n, gasPrice: 2n, value: 500n })).toBe(900n);
    expect(signedExitMaximum({ gas: 100n, gasPrice: 4n, value: 500n })).toBe(900n);
    expect(() => signedExitMaximum({ gas: 100n, value: 500n })).toThrow('unavailable');
    const replacement = reserveExitReplacement(saved, 900n);
    expect(replacement.debited).toBe('1000');
    expect(replacement.pending?.maximumDebit).toBe('900');
    expect(reserveExitReplacement(replacement, 700n)).toBe(replacement);
    expect(() => reserveExitReplacement(saved, 901n)).toThrow('explicitly raise');
    expect(saved.debited).toBe('900');
    expect(saved.pending).toBe(pending);
    const explicitlyRaised = reserveExitReplacement({ ...saved, limit: '1001' }, 901n);
    expect(explicitlyRaised.debited).toBe('1001');
    expect(() => assertExitReplacementNonce(pending, 4)).toThrow('nonce');
    expect(() => assertExitReplacementNonce(pending, 5)).not.toThrow();
    expect(() => assertExitReplacementNonce({ ...pending, nonce: undefined }, 4)).not.toThrow();
    expect(() => assertExitReplacementNonce({ ...pending, nonce: undefined }, 6)).toThrow('nonce');
  });
});
