import { encodeFunctionData, parseEther, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { packManagerAbi } from '../../shared/main-pool-abi';
import { mainProductAccess, mainTabForProducts, type Manager } from './main-pool';
import { assertManagerExitIntent, managerExitCalls, managerExitSpendKey, managerQueueAbi } from './main-manager-exit';
import { checkExitSpend, exitSpendKey, observeExitReceipt, reserveExitReplacement, reserveExitSpend, type SavedExitSpend } from './main-pool-exit';
import { assertTransactionIntent } from './tx';

const owner = '0x0000000000000000000000000000000000000001' as Address;
const manager = '0x0000000000000000000000000000000000000002' as Address;
const fwa = '0x0000000000000000000000000000000000000003' as Address;
const stranger = '0x0000000000000000000000000000000000000004' as Address;
const snapshot = (fields: Record<string, unknown> = {}) => ({ manager, fwa, owner, exiting: true, balance: 1234n,
  book: { ids: [], openCount: 0n, idle: 0, recovery: 0, pendingReceipts: 0n, credit: 0n, witness: 0n }, budget: [0n, 0n], ...fields }) as unknown as Manager;
const input = (functionName: string, args: readonly unknown[]) => encodeFunctionData({ abi: packManagerAbi, functionName, args } as never);

describe('owner-paid manager closeout', () => {
  it('works with no vault address and an independently closed shared-vault gate', () => {
    const access = mainProductAccess({ chainId: 31337, factory: manager, vaultOpen: false, managerOpen: false,
      vaultPreview: 'false', managerPreview: 'true' });
    expect(access).toEqual({ visible: true, vault: false, manager: true });
    expect(mainTabForProducts('overview', false, true)).toBe('manager');
    expect(mainTabForProducts('vault', false, true)).toBe('manager');
    expect(mainProductAccess({ chainId: 1, factory: manager, vaultOpen: false, managerOpen: false, managerPreview: 'true' }).manager).toBe(false);
    expect(mainProductAccess({ chainId: 1, factory: manager, vaultOpen: false, managerOpen: true })).toEqual({ visible: true, vault: false, manager: true });
  });

  it('refuses a wrong owner before planning any step, including an empty account', () => {
    expect(() => managerExitCalls(snapshot(), stranger)).toThrow('does not own');
    expect(() => managerExitCalls(snapshot({ balance: 0n }), stranger)).toThrow('does not own');
  });

  it('stops investment before withdrawing even with zero keeper allowance', () => {
    expect(managerExitCalls(snapshot({ exiting: false }), owner)).toEqual([
      { label: 'Start owner-paid manager closeout', functionName: 'setExiting', args: [true] },
    ]);
    const empty = snapshot({ exiting: false, balance: 0n });
    expect(managerExitCalls(empty, owner).map((call) => call.functionName)).toEqual(['setExiting']);
    // Emptying the account does not leave investment enabled for later incoming ETH.
    expect(managerExitCalls({ ...empty, exiting: true }, owner)).toEqual([]);
  });

  it('offers bounded unpaid recovery/unlisting in both halves of a page without a keeper-profit filter', () => {
    const m = snapshot({ book: { ids: Array.from({ length: 32 }, (_, i) => BigInt(i + 1)), openCount: 32n,
      idle: 0, recovery: 0, pendingReceipts: 1n, credit: 99n, witness: 7n } });
    const calls = managerExitCalls(m, owner, true);
    expect(calls.map((c) => c.functionName)).toEqual(['recover', 'recover', 'recoverUnlist', 'recoverUnlist', 'processAcquisitions']);
    expect(calls.filter((c) => c.functionName === 'recoverUnlist').some((c) => (c.args[0] as bigint[]).includes(32n))).toBe(true);
    expect(calls.filter((c) => c.functionName === 'recover').every((c) => (c.args[0] as bigint[]).length === 16)).toBe(true);
    expect(calls.find((c) => c.target)?.target).toBe(fwa);
    expect(calls.some((c) => ['checkpoint', 'recoverCheckpoint', 'requestRedeem', 'fundCheckpoint', 'burnTokens', 'harvest'].includes(c.functionName))).toBe(false);
    expect(calls.every((c) => !c.value)).toBe(true);
  });

  it('redeems recovery-only inventory and collects fee credit before the final full ETH withdrawal', () => {
    const recovery = snapshot({ book: { ids: [], openCount: 0n, idle: 0, recovery: 1, pendingReceipts: 0n, credit: 99n } });
    expect(managerExitCalls(recovery, owner).map((c) => [c.functionName, c.args])).toEqual([['recoverLiquidate', [16n]]]);
    const fees = snapshot({ book: { ...recovery.book, recovery: 0, credit: 99n } });
    expect(managerExitCalls(fees, owner).map((c) => [c.functionName, c.args])).toEqual([['harvest', [[], 0n]]]);
    expect(managerExitCalls(snapshot(), owner)).toEqual([{ label: 'Withdraw all manager ETH to owner', functionName: 'withdraw', args: [owner, 1234n] }]);
    expect(managerExitCalls(snapshot({ balance: 0n }), owner, true)).toEqual([]);
  });

  it('does not complete or withdraw while a settlement receipt remains unresolved', () => {
    const m = snapshot({ book: { ids: [], openCount: 0n, idle: 0, recovery: 0, pendingReceipts: 1n, credit: 99n } });
    expect(managerExitCalls(m, owner).map((c) => c.functionName)).toEqual(['recover']);
  });

  it('strictly binds the manager owner, withdrawal recipient and amount in signed calldata', () => {
    const intent = { from: owner, to: manager, input: input('withdraw', [owner, 1234n]), value: 0n };
    expect(() => assertManagerExitIntent(manager, owner, fwa, intent)).not.toThrow();
    expect(() => assertManagerExitIntent(manager, owner, fwa, { ...intent, from: stranger })).toThrow('owner');
    expect(() => assertManagerExitIntent(manager, owner, fwa, { ...intent, input: input('withdraw', [stranger, 1234n]) })).toThrow('calldata');
    expect(() => assertManagerExitIntent(manager, owner, fwa, { ...intent, input: input('withdraw', [owner, 0n]) })).toThrow('calldata');
    expect(() => assertTransactionIntent({ chainId: 31337, ...intent }, { ...intent, input: input('withdraw', [owner, 1235n]) })).toThrow('different transaction');
    expect(() => assertManagerExitIntent(manager, owner, fwa, { ...intent, input: input('setExiting', [false]) })).toThrow('calldata');
  });

  it('allowlists only the actual FWA target with exact process16 calldata and zero attached ETH', () => {
    const intent = { from: owner, to: fwa, input: encodeFunctionData({ abi: managerQueueAbi, functionName: 'processAcquisitions', args: [16n] }), value: 0n };
    expect(() => assertManagerExitIntent(manager, owner, fwa, intent)).not.toThrow();
    expect(() => assertManagerExitIntent(manager, owner, undefined, intent)).toThrow('target');
    expect(() => assertManagerExitIntent(manager, owner, fwa, { ...intent, to: stranger })).toThrow('target');
    expect(() => assertManagerExitIntent(manager, owner, fwa, { ...intent, input: encodeFunctionData({ abi: managerQueueAbi, functionName: 'processAcquisitions', args: [17n] }) })).toThrow('target');
    expect(() => assertManagerExitIntent(manager, owner, fwa, { ...intent, value: 1n })).toThrow('send no ETH');
  });

  it('retains manager signed maxima across unknown, reverted and replacement outcomes, separately from vault flows', () => {
    expect(managerExitSpendKey(31337, manager, owner)).not.toBe(exitSpendKey(31337, manager, owner));
    const initial: SavedExitSpend = { chainId: 31337, vault: manager, holder: owner, limit: '1000', debited: '0', temporaryFunding: '0', actualGas: '0' };
    const pending = { id: 'manager-queue', minimumNonce: 4, to: fwa, input: encodeFunctionData({ abi: managerQueueAbi, functionName: 'processAcquisitions', args: [16n] }), value: '0', maximumDebit: '800' };
    const signed = reserveExitSpend(initial, 1000n, 800n, pending);
    expect(JSON.parse(JSON.stringify(signed))).toEqual(signed);
    expect(() => reserveExitSpend(signed, 1000n, 1n, pending)).toThrow('unresolved');
    const reverted = observeExitReceipt(signed, 100n, false);
    expect(reverted.debited).toBe('800');
    expect(() => reserveExitSpend(reverted, 1000n, 201n, pending)).toThrow('spending limit');
    expect(reserveExitReplacement(signed, 900n).debited).toBe('900');
    expect(() => reserveExitReplacement(signed, 1001n)).toThrow('explicitly raise');
    expect(() => checkExitSpend({ limit: parseEther('0.000000000000000001'), debited: 0n, actualGas: 0n, temporaryFunding: 0n }, 100_000n, 1n, 0n)).toThrow('spending limit');
  });
});
