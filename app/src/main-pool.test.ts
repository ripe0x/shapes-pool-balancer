import { parseEther } from 'viem';
import { describe, expect, it } from 'vitest';
import { POSITION_VALUE, creationState, depositShares, managerStatus, outcomes, packCost, packsFor, redeemCharge, vaultStatus, type ManagerCreation } from './main-pool';

const eth = parseEther;

describe('vault request math (mirrors PackVault.deposit and requestRedeem)', () => {
  it('matches the deployment charge PackVault escrowed for a real 0.5 ETH deposit', () => {
    // Fork observation: deposit{value: 0.5 ETH} with requestCharge 38,001 gwei and deployCharge 2,109,250,009,695,000
    // wei stored amount 499,961,999,000,000,000 and charge 8,309,440,416,339,404.
    const v = { requestCharge: 38_001_000_000_000n, deployCharge: 2_109_250_009_695_000n, pricePerShare: eth('10') };
    const net = eth('0.5') - v.requestCharge;
    expect(net).toBe(499_961_999_000_000_000n);
    const charge = (net * v.deployCharge) / (POSITION_VALUE + v.deployCharge);
    expect(charge).toBe(8_309_440_416_339_404n);
    expect(depositShares(eth('0.5'), v)).toBe(((net - charge) * 10n ** 18n) / eth('10'));
  });

  it('buys nothing at or below the request charge', () => {
    expect(depositShares(1000n, { requestCharge: 1000n, deployCharge: 0n, pricePerShare: eth('1') })).toBe(0n);
  });

  it('charges the request charge plus the unwind charge on the shares value at the last checkpoint', () => {
    const v = { requestCharge: eth('0.0001'), unwindCharge: eth('0.001'), lastNav: eth('20'), totalShares: eth('2') };
    // 0.5 shares are worth 5 ETH; 5 / 0.1248 positions at 0.001 ETH each.
    expect(redeemCharge(eth('0.5'), v)).toBe(eth('0.0001') + (eth('5') * eth('0.001')) / POSITION_VALUE);
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
  const m = { exiting: false, listingPaused: false, edge: [0n, eth('0.0649'), true] as const, book: { listed: 3, idle: 0 }, balance: 0n, params: { reserve: eth('0.005') } };
  const cost = packCost(eth('0.0649'), eth('0.0021'));
  it('lists', () => expect(managerStatus(m as never, cost).body).toBe("3 packs on FWA's main pool. Nothing needs attention."));
  it('reports exit, pause and FWA gate in that order', () => {
    expect(managerStatus({ ...m, exiting: true, listingPaused: true } as never, cost).head).toBe('Exiting.');
    expect(managerStatus({ ...m, listingPaused: true } as never, cost).head).toBe('Listing paused.');
    expect(managerStatus({ ...m, edge: [0n, 0n, false] } as never, cost).head).toBe('New investment paused.');
  });
  it('asks for the ETH one pack and the reserve still need', () => {
    const st = managerStatus({ ...m, book: { listed: 0, idle: 0 }, balance: eth('0.1') } as never, cost);
    expect(st.head).toBe('Not enough ETH to list.');
    expect(st.short).toBe(cost + eth('0.005') - eth('0.1'));
  });
  it('reports packs below the target before listing', () => {
    expect(managerStatus(m as never, cost, { missing: 0, short: 0n }).head).toBe('Listing.');
    expect(managerStatus(m as never, cost, { missing: 2, short: 0n }).body).toBe('2 packs in your target are funded and wait for the next keeper run.');
    const st = managerStatus(m as never, cost, { missing: 1, short: eth('0.0004') });
    expect(st.body).toBe("1 pack in your target isn't built. Add 0.0004 ETH or lower the counts.");
    expect(st.short).toBe(eth('0.0004'));
    expect(managerStatus({ ...m, listingPaused: true } as never, cost, { missing: 1, short: 1n }).head).toBe('Listing paused.');
  });
  it('counts whole packs above the reserve', () => {
    expect(cost).toBe(eth('0.127'));
    expect(packsFor(eth('1'), eth('0.005'), cost)).toBe(7n);
    expect(packsFor(eth('0.004'), eth('0.005'), cost)).toBe(0n);
  });
});

describe('keep and bid outcomes from position events', () => {
  it('counts a selection resolved by a keep receipt as a keep, by a returned pack as a bid, and ignores unlists', () => {
    const updates = [
      { listingId: 1n, state: 1 }, { listingId: 1n, state: 2 }, { listingId: 1n, state: 0 }, // kept
      { listingId: 2n, state: 1 }, { listingId: 2n, state: 2 }, { listingId: 2n, state: 3 }, // bid, owed back
      { listingId: 3n, state: 1 }, { listingId: 3n, state: 0 }, // unlisted, never selected
      { listingId: 4n, state: 1 }, { listingId: 4n, state: 2 }, // still waiting
    ];
    expect(outcomes(updates, [1n])).toEqual({ keeps: 1, bids: 1 });
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
