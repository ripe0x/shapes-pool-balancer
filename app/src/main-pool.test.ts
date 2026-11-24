import { parseEther } from 'viem';
import { describe, expect, it } from 'vitest';
import { creationState, depositShares, managerStatus, observedResolutions, packCost, packsFor, bookPage, historyRange, navWitnessCandidates, MANAGER_PARAMS, redeemCharge, renewalWaits, vaultStatus, type ManagerCreation } from './main-pool';

const eth = parseEther;

describe('vault request math (mirrors PackVault.deposit and requestRedeem)', () => {
  it('uses the account reference value for estimated construction charges', () => {
    const v = { requestCharge: eth('0.0001'), deployCharge: eth('0.004'), referencePositionValue: eth('0.24'), pricePerShare: eth('1') };
    // 0.488 principal + 0.0001 request charge: construction takes 1/61 of the net deposit.
    expect(depositShares(eth('0.4881'), v)).toBe(eth('0.48'));
    expect(depositShares(eth('0.4881'), { ...v, referencePositionValue: eth('0.12') })).toBeLessThan(eth('0.48'));
  });

  it('buys nothing at or below the request charge', () => {
    expect(depositShares(1000n, { requestCharge: 1000n, deployCharge: 0n, referencePositionValue: eth('0.24'), pricePerShare: eth('1') })).toBe(0n);
  });

  it('charges the request charge plus the unwind charge on the shares value at the last checkpoint', () => {
    const v = { requestCharge: eth('0.0001'), unwindCharge: eth('0.001'), lastNav: eth('20'), totalShares: eth('2'), referencePositionValue: eth('0.24') };
    // 0.5 shares are worth 5 ETH; each 0.24 ETH position carries a 0.001 ETH unwind allowance.
    expect(redeemCharge(eth('0.5'), v)).toBe(eth('0.0001') + (eth('5') * eth('0.001')) / v.referencePositionValue);
    expect(redeemCharge(eth('0.5'), { ...v, unwindCharge: 0n })).toBe(eth('0.0001'));
  });
});

describe('vault status', () => {
  const base = { windingDown: false, depositsPaused: false, pendingDepositTotal: 0n, lockedShares: 0n, lastCheckpointInterval: 10n, now: 10n * 43200n + 5n };
  it('is open by default and while this interval has been checkpointed', () => {
    expect(vaultStatus(base).head).toBe('Open.');
    expect(vaultStatus({ ...base, pendingDepositTotal: 1n }).head).toBe('Open.');
  });
  it('is due once flows wait in a later interval', () => {
    expect(vaultStatus({ ...base, lockedShares: 1n, now: 11n * 43200n }).head).toBe('Checkpoint due.');
  });
  it('puts wind-down before a deposit pause', () => {
    expect(vaultStatus({ ...base, windingDown: true, depositsPaused: true }).head).toBe('Winding down.');
    expect(vaultStatus({ ...base, depositsPaused: true }).head).toBe('Deposits paused.');
  });
});

describe('manager status and capacity', () => {
  const m = { exiting: false, listingPaused: false, edge: [0n, eth('0.21'), true] as const, book: { listed: 3, idle: 0 }, balance: 0n, operatingReserve: eth('0.25'), params: MANAGER_PARAMS };
  const cost = packCost(eth('0.03'), eth('0.21'), eth('0.004'));
  it('lists', () => expect(managerStatus(m as never, cost).body).toBe("3 packs on FWA's main pool. Account settings govern further work."));
  it('reports exit, pause and FWA gate in that order', () => {
    expect(managerStatus({ ...m, exiting: true, listingPaused: true } as never, cost).head).toBe('Exiting.');
    expect(managerStatus({ ...m, listingPaused: true } as never, cost).head).toBe('Listing paused.');
    expect(managerStatus({ ...m, edge: [0n, 0n, false] } as never, cost).head).toBe('New investment paused.');
  });
  it('does not treat the reference fallback as fresh-build permission when every recipe is disabled', () => {
    expect(managerStatus({ ...m, params: { ...MANAGER_PARAMS, packUnitsMask: 0n }, balance: eth('1') } as never, cost)).toEqual({
      head: 'Fresh minting disabled.', body: 'Existing unselected packs may still be relisted. Withdrawals remain available.',
    });
  });
  it('asks for the ETH one pack and the reserve still need', () => {
    const st = managerStatus({ ...m, book: { listed: 0, idle: 0 }, balance: eth('0.1') } as never, cost);
    expect(st.head).toBe('Not enough ETH to list.');
    expect(st.short).toBe(cost + eth('0.25') - eth('0.1'));
    const withPrincipalOnly = managerStatus({ ...m, book: { listed: 0, idle: 0 }, balance: eth('0.3') } as never, cost);
    expect(withPrincipalOnly.head).toBe('Not enough ETH to list.');
    expect(withPrincipalOnly.short).toBe(eth('0.194'));
  });
  it('counts whole packs above the reserve', () => {
    expect(cost).toBe(eth('0.244'));
    expect(packsFor(eth('1'), eth('0.005'), cost)).toBe(4n);
    expect(packsFor(eth('0.004'), eth('0.005'), cost)).toBe(0n);
  });
});

describe('observed resolution activity from position events', () => {
  it('counts a selection resolved by a keep receipt as a keep, by a returned pack as a bid, and ignores unlists', () => {
    const updates = [
      { listingId: 1n, state: 1 }, { listingId: 1n, state: 2 }, { listingId: 1n, state: 0 }, // kept
      { listingId: 2n, state: 1 }, { listingId: 2n, state: 2 }, { listingId: 2n, state: 3 }, // bid, owed back
      { listingId: 3n, state: 1 }, { listingId: 3n, state: 0 }, // unlisted, never selected
      { listingId: 4n, state: 1 }, { listingId: 4n, state: 2 }, // still waiting
    ];
    expect(observedResolutions(updates, [1n])).toEqual({ recordedKeeps: 1, otherResolved: 1 });
  });
});

describe('saved manager creation', () => {
  const c: ManagerCreation = { chainId: 1, factory: '0x0000000000000000000000000000000000000001', owner: '0x0000000000000000000000000000000000000002', value: '1', fromBlock: '1', since: 0 };
  const facts = { seen: false, nonceUsed: false, now: 1000 };
  it('resolves to the created manager whatever the receipt says', () => {
    expect(creationState(c, { ...facts, created: '0x0000000000000000000000000000000000000003' }).state).toBe('created');
  });
  it('fails on a revert or a replacement, stays pending while the sent transaction is unmined', () => {
    expect(creationState({ ...c, hash: '0x01' }, { ...facts, receipt: 'reverted', seen: true }).state).toBe('failed');
    expect(creationState({ ...c, hash: '0x01' }, { ...facts, nonceUsed: true }).state).toBe('failed');
    expect(creationState({ ...c, hash: '0x01' }, { ...facts, seen: true }).state).toBe('pending');
  });
  it('keeps a creation with no hash unknown for a day, then lets it go', () => {
    expect(creationState(c, facts).state).toBe('unknown');
    expect(creationState(c, { ...facts, now: 25 * 3600 * 1000 }).state).toBe('failed');
  });
});

describe('bounded account reads', () => {
  it('reads at most 32 positions even with a million listings and wraps after the final page', () => {
    expect(bookPage(1000000n).indexes).toHaveLength(32);
    expect(bookPage(1000000n, 999999n)).toEqual({ indexes: [999999n], next: 0n });
    expect(bookPage(2n, 50n)).toEqual({ indexes: [0n, 1n], next: 0n });
    expect(bookPage(0n).indexes).toEqual([]);
  });
  it('bounds each history RPC independently of the full history length', () => {
    expect(historyRange(10n, 10000000n)).toEqual({ fromBlock: 10n, toBlock: 2009n });
    expect(historyRange(10n, 12n)).toEqual({ fromBlock: 10n, toBlock: 12n });
  });
  it('keeps the local candidate recipe explicit', () => {
    expect(MANAGER_PARAMS.packUnitsMask).toBe(8n);
    expect(MANAGER_PARAMS.backingRatioBps).toBe(70000);
    expect(MANAGER_PARAMS.upliftBoundBps).toBe(25);
  });
  it('prefers an older fee-bearing witness over a cached new listing and retains every bounded alternative', () => {
    expect(navWitnessCandidates([50n, 10n, 20n], [
      { state: 1, feeDebt: 100n }, { state: 1, feeDebt: 10n }, { state: 2, feeDebt: 0n },
    ])).toEqual([10n, 50n]);
    expect(navWitnessCandidates([50n, 10n], [{ state: 1, feeDebt: 100n }, { state: 1, feeDebt: 100n }])).toEqual([10n, 50n]);
  });
});

describe('shared vault and manager renewal status', () => {
  const funded = {
    params: MANAGER_PARAMS, mintFee: eth('0.001'), renewalState: [1n, 1n, eth('0.214'), eth('0.215')] as const,
    budget: [eth('0.001'), 0n] as const, minimumRenewalQuote: eth('0.0008'),
  };
  it('distinguishes a funded manager from exhausted spending permission without inventing a cash shortage', () => {
    expect(renewalWaits(funded)).toEqual({ feeNotAccepted: false, cashShort: false, allowanceTooSmall: false });
    expect(renewalWaits({ ...funded, budget: [0n, 0n] })).toEqual({ feeNotAccepted: false, cashShort: false, allowanceTooSmall: true });
    expect(renewalWaits({ ...funded, renewalState: [1n, 0n, eth('0.214'), 0n] })).toEqual({ feeNotAccepted: false, cashShort: true, allowanceTooSmall: false });
  });
  it('does not apply fresh-replacement waits to reuse mode', () => {
    expect(renewalWaits({ ...funded, params: { ...MANAGER_PARAMS, renewalMode: 1 }, budget: [0n, 0n] }).allowanceTooSmall).toBe(false);
  });
  it('uses the full returned-pack work quote and actual required cash instead of the ceiling-priced float target', () => {
    const returned = { ...funded, minimumRenewalQuote: eth('0.000475'), renewalCashRequired: eth('0.213475'),
      renewalState: [1n, 0n, eth('0.2140975'), eth('0.2135')] as const, budget: [eth('0.0005'), 0n] as const };
    expect(renewalWaits(returned).cashShort).toBe(false);
    expect(renewalWaits({ ...returned, budget: [eth('0.00045'), 0n] }).allowanceTooSmall).toBe(true);
  });
  it('does not imply that cash or permission can restart disabled fresh minting', () => {
    const disabled = { ...funded, params: { ...MANAGER_PARAMS, packUnitsMask: 0n }, budget: [0n, 0n] as const };
    expect(renewalWaits(disabled).allowanceTooSmall).toBe(false);
  });
});
