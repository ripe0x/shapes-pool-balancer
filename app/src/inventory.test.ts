import { expect, it } from 'vitest';
import { DENOMS } from '../../shared/planner';
import { activationBatch, closeoutState, deliveryHistory, inventoryBatches, isPendingDelivery, isRefunded, curatedWitness, isHeld, isSelectable, isStaged, listedShapeCounts } from './inventory';

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

it('offers only a currently selectable, locally active curated listing as a proof candidate', () => {
  expect(curatedWitness([activeShape, stagedCurated, { ...activeCurated, fwaStatus: 6 }])).toBeUndefined();
  expect(curatedWitness([{ ...activeCurated, state: 2 }, activeCurated])).toBe(activeCurated);
});


it('keeps completed retries out of recovery while retaining buyer and creator claims', () => {
  expect(isPendingDelivery({ ...activeCurated, state: 2, fwaStatus: 4 })).toBe(false);
  expect(isPendingDelivery({ ...activeCurated, state: 2, fwaStatus: 6 })).toBe(true);
  expect(isRefunded({ ...activeCurated, state: 2, fwaStatus: 7 })).toBe(true);
  expect(isRefunded({ ...activeCurated, state: 2, fwaStatus: 6 })).toBe(false);
});

it('never declares closeout empty while ETH, recoverable NFTs, buyer rights or unknown reads remain', () => {
  const empty = { listings: [], pending: [], proceeds: 0n, surplus: 0n, unsettled: 0n, awaitingUpkeep: 0, historyLoading: false };
  expect(closeoutState(empty)).toBe('empty');
  expect(closeoutState({ ...empty, proceeds: 500_000_000_000_000_000n })).toBe('recoverable');
  expect(closeoutState({ ...empty, surplus: 1n })).toBe('recoverable');
  expect(closeoutState({ ...empty, listings: [stagedCurated] })).toBe('recoverable');
  expect(closeoutState({ ...empty, pending: [{ ...activeCurated, state: 2, fwaStatus: 7 }] })).toBe('recoverable');
  expect(closeoutState({ ...empty, pending: [{ ...activeCurated, state: 2, fwaStatus: 6 }] })).toBe('waiting');
  expect(closeoutState({ ...empty, unsettled: 1n })).toBe('settling');
  expect(closeoutState({ ...empty, awaitingUpkeep: 1 })).toBe('settling');
  expect(closeoutState({ ...empty, historyLoading: true })).toBe('unknown');
  expect(closeoutState({ ...empty, historyError: 'unreachable' })).toBe('unknown');
  expect(closeoutState({ ...empty, surplus: undefined })).toBe('unknown');
});

it('uses five bounded transactions for 100 NFTs on new pools and preserves single calls on old pools', () => {
  const ids = Array.from({ length: 100 }, (_, i) => BigInt(i + 1));
  expect(inventoryBatches(ids, true).map(b => b.length)).toEqual([20, 20, 20, 20, 20]);
  expect(inventoryBatches(ids, true).flat()).toEqual(ids);
  expect(inventoryBatches(ids, false)).toHaveLength(100);
  expect(inventoryBatches([], true)).toEqual([]);
  expect(inventoryBatches(ids.slice(0, 21), true).map(b => b.length)).toEqual([20, 1]);
});


it('counts a successful delayed NFT delivery in the ledger without offering it for recovery', () => {
  const delivered = { ...activeCurated, state: 2, fwaStatus: 4, base: 500_000_000_000_000_000n };
  const waiting = { ...delivered, fwaStatus: 6 };
  const refunded = { ...delivered, fwaStatus: 7 };
  const recovered = { ...refunded, state: 0, fwaStatus: 3 };
  const history = deliveryHistory([delivered, waiting, refunded, recovered]);
  expect(history.pending).toEqual([waiting, refunded]);
  const wins = history.tracked.filter(l => !isHeld(l));
  expect(wins).toEqual([delivered]);
  expect(wins.reduce((sum, l) => sum + l.base, 0n)).toBe(500_000_000_000_000_000n);
});
