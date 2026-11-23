import { describe, expect, it } from 'vitest';
import { INITIAL_LIMITS, LEGACY_LIMITS, markupAllowed, markupSliderRange, maxUnsettled, prizeLimit, validBacklog, validFillGate } from './limits';
import { LEGACY_FACTORIES, legacyFactory } from '../../shared/legacy';

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
    expect(LEGACY_FACTORIES.map((f) => f.label)).toEqual(['community-v1']);
    const v1 = legacyFactory('0x91c31ad620555de24e62290906ad1aa14c4ce281')!;
    expect(v1.fromBlock).toBe(26_475_448n);
    const fns = v1.poolBalancerAbi.filter((x) => x.type === 'function').map((x) => (x as { name: string }).name);
    expect(fns).toContain('proposeKeeperPolicy');
    expect(fns).not.toContain('setFillGateBps');
    expect(legacyFactory('0xA57de1a6Ad66aB053057Ff7829F65eFe1cD57ece')).toBeUndefined();
  });
});
