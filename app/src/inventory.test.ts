import { expect, it } from 'vitest';
import { DENOMS } from '../../shared/planner';
import { activationBatch, isHeld, isSelectable, isStaged, listedShapeCounts } from './inventory';

const activeShape = { kind: 2, denom: 0, state: 1, fwaStatus: 1 };
const stagedShape = { ...activeShape, fwaStatus: 5 };
const activeCurated = { kind: 1, denom: 0, state: 1, fwaStatus: 1 };
const stagedCurated = { ...activeCurated, fwaStatus: 5 };

it('separates 20 selectable Shapes from80 staged Shapes and retains all backing in the holdings ledger', () => {
  const listings = [...Array.from({ length: 20 }, () => activeShape), ...Array.from({ length: 80 }, () => stagedShape), activeCurated, stagedCurated];
  expect(listings.filter(isSelectable)).toHaveLength(21);
  expect(listings.filter(isStaged)).toHaveLength(81);
  expect(listedShapeCounts(listings)[0]).toBe(20);
  expect(listedShapeCounts(listings, 5)[0]).toBe(80);
  const backing = listings.filter(listing => listing.kind === 2 && isHeld(listing)).reduce((sum, listing) => sum + DENOMS[listing.denom], 0n);
  expect(backing).toBe(1_000_000_000_000_000_000n);
  expect(isSelectable(stagedCurated)).toBe(false);
  expect(isHeld(stagedCurated)).toBe(true);
});

it('offers a bounded activation batch only after draws settle', () => {
  const staged = Array.from({ length: 80 }, () => stagedShape);
  expect(activationBatch(staged, 1n)).toBe(0n);
  expect(activationBatch(staged, 0n)).toBe(20n);
  expect(activationBatch(staged.slice(0, 3), 0n)).toBe(3n);
  expect(activationBatch([activeShape], 0n)).toBe(0n);
});

it('retains staging and delivery-recovery records in creator holdings while excluding exited tracking states', () => {
  for (const fwaStatus of [1, 5, 6, 7]) expect(isHeld({ ...activeShape, fwaStatus })).toBe(true);
  for (const fwaStatus of [0, 2, 3, 4]) expect(isHeld({ ...activeShape, fwaStatus })).toBe(false);
});
