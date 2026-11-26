import { describe, expect, it } from 'vitest';
import { decodeMix, encodeMix, fundingFor, packCount, presetMix, scaleMix } from './manager-design';

describe('manager pack mix', () => {
  it('a preset sums to the chosen pack count', () => {
    for (const n of [1, 2, 3, 4, 7, 40, 100]) expect(packCount(presetMix('balanced', n))).toBe(n);
    expect(presetMix('balanced', 4)).toEqual({ 3: 2, 5: 1, 10: 1 });
    expect(presetMix('balanced', 1)).toEqual({ 3: 1 });
    expect(presetMix('small', 5)).toEqual({ 3: 5 });
  });
  it('scaling keeps a hand-set mix proportional', () => {
    expect(scaleMix({ 3: 1, 20: 1 }, 6)).toEqual({ 3: 3, 20: 3 });
    expect(scaleMix({}, 2)).toEqual({ 3: 2 });
  });
  it('encodes the contract design and mask', () => {
    const { design, mask } = encodeMix({ 3: 2, 5: 1 });
    expect(design).toBe((2n << 24n) | (1n << 40n)); // ForkManager.t.sol test_designCapsEachPackSize
    expect(mask).toBe((1n << 3n) | (1n << 5n));
    expect(decodeMix(design)).toEqual({ 3: 2, 5: 1 });
    expect(() => encodeMix({ 2: 1 })).toThrow();
    expect(() => encodeMix({ 3: 256 })).toThrow();
    expect(() => encodeMix({})).toThrow();
  });
  it('funding adds each pack and the reserve once', () => {
    expect(fundingFor({ 3: 2, 10: 1 }, { 3: 10n, 10: 30n }, 6n)).toBe(56n);
    expect(fundingFor({ 5: 1 }, { 3: 10n }, 6n)).toBeUndefined();
  });
});
