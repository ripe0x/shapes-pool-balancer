import { describe, expect, it } from 'vitest';
import { INITIAL_LIMITS, LEGACY_LIMITS, markupAllowed, markupSliderRange, maxUnsettled, prizeLimit, refillPerDay, validBacklog, validFillGate } from './limits';
import { LEGACY_FACTORIES, legacyFactory, selectLegacyFactories } from '../../shared/legacy';

describe('product limits (PoolInventory.validateTarget)', () => {
  const lowered = { maxPrizes: 100, minMarkupBps: 2_000, maxMarkupBps: 5_000 };
  it('lets a saved design keep a prize count above a lowered maximum, never grow past it', () => {
    expect(prizeLimit(lowered, 250)).toBe(250);
    expect(prizeLimit(lowered, 40)).toBe(100);
    expect(prizeLimit(INITIAL_LIMITS, 0)).toBe(1_000);
    expect(prizeLimit(LEGACY_LIMITS, 1_200)).toBe(1_000);
  });
  it('accepts a markup in range or the unchanged current one', () => {
    expect(markupAllowed(lowered, 2_000, 0)).toBe(true);
    expect(markupAllowed(lowered, 5_001, 0)).toBe(false);
    expect(markupAllowed(lowered, 9_000, 9_000)).toBe(true);
    expect(markupAllowed(lowered, 8_000, 9_000)).toBe(false);
    expect(markupAllowed(lowered, 0, 0)).toBe(false);
    expect(markupAllowed(LEGACY_LIMITS, 12_000, 12_000)).toBe(false);
  });
  it('widens the slider only to include a markup the pool may keep', () => {
    expect(markupSliderRange(lowered, 0)).toEqual({ min: 20, max: 50 });
    expect(markupSliderRange(lowered, 9_000)).toEqual({ min: 20, max: 90 });
    expect(markupSliderRange(lowered, 1_000)).toEqual({ min: 10, max: 50 });
    expect(markupSliderRange(LEGACY_LIMITS, 2_500)).toEqual({ min: 10, max: 100 });
  });
});

describe('creator purchase pauses', () => {
  it('validates the fill gate and backlog threshold like the setters', () => {
    expect([0, 7_000, 10_000].every(validFillGate)).toBe(true);
    expect([-1, 10_001, 0.5].some(validFillGate)).toBe(false);
    expect([1, 5, 65_535].every(validBacklog)).toBe(true);
    expect([0, 65_536, 2.5].some(validBacklog)).toBe(false);
  });
  it('allows threshold + 4 unsettled draws, since FWA admits before a batch of five', () => {
    expect(maxUnsettled(5)).toBe(9);
    expect(maxUnsettled(1)).toBe(5);
  });
});

describe('legacy factories', () => {
  it('packages community-v1 with its own ABIs and skips factories without one', () => {
    expect(LEGACY_FACTORIES.map((f) => f.label)).toEqual(['community-v2', 'community-v1']);
    const v1 = legacyFactory('0x91c31ad620555de24e62290906ad1aa14c4ce281')!;
    expect(v1.fromBlock).toBe(26_475_448n);
    const fns = v1.poolBalancerAbi.filter((x) => x.type === 'function').map((x) => (x as { name: string }).name);
    expect(fns).toContain('proposeKeeperPolicy');
    expect(fns).not.toContain('setFillGateBps');
    expect(legacyFactory('0xA57de1a6Ad66aB053057Ff7829F65eFe1cD57ece')).toBeUndefined();
  });

  it('discovers community-v2 pools but manages them as current pools, with the ABI they were deployed with', () => {
    const v2 = LEGACY_FACTORIES.find((f) => f.label === 'community-v2')!;
    expect(v2.factory).toBe('0x526FbD402624B50861f54c081B592cdCeE322929');
    expect(v2.fromBlock).toBe(26_482_707n);
    const fns = v2.poolBalancerAbi.filter((x) => x.type === 'function').map((x) => (x as { name: string }).name);
    expect(fns).toContain('effectiveEconomics');
    expect(fns).not.toContain('owner');
    expect(legacyFactory(v2.factory)).toBeUndefined();
  });

  it('selects the legacy factories a keeper services', () => {
    const next = '0x0000000000000000000000000000000000000001';
    const v2 = '0x526FbD402624B50861f54c081B592cdCeE322929';
    expect(selectLegacyFactories('0', next)).toEqual([]);
    expect(selectLegacyFactories(undefined, next).map((f) => f.label)).toEqual(['community-v2', 'community-v1']);
    expect(selectLegacyFactories('community-v2', next).map((f) => f.label)).toEqual(['community-v2']);
    // Never the creation factory itself, so switching LEGACY_FACTORIES before FACTORY scans nothing twice.
    expect(selectLegacyFactories('community-v2', v2.toLowerCase())).toEqual([]);
    expect(() => selectLegacyFactories('community-v3', next)).toThrow('community-v3');
  });
});

describe('spending bucket refill per day', () => {
  it('shows the roundest per-day amount that stores back to the same wei per second', () => {
    const DAY = 86_400n;
    expect(refillPerDay(4_166_666_666_666_666n)).toBe(360n * 10n ** 18n);
    expect(360n * 10n ** 18n / DAY).toBe(4_166_666_666_666_666n);
    expect(refillPerDay(0n)).toBe(0n);
    expect(refillPerDay(1n)).toBe(100_000n);
    for (const r of [1n, 7n, 4_166_666_666_666_666n, 11_574_074_074_074n, 2n ** 96n - 1n]) expect(refillPerDay(r) / DAY).toBe(r);
  });
});
