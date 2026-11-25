import { DENOMS, type Counts } from '../../shared/planner';

interface ListingState { kind: number; denom: number; state: number; fwaStatus: number }

export const isSelectable = (listing: ListingState) => listing.state === 1 && listing.fwaStatus === 1;
export const isStaged = (listing: ListingState) => listing.state === 1 && listing.fwaStatus === 5;
export const curatedWitness = <T extends ListingState>(listings: readonly T[]) =>
  listings.find((listing) => listing.kind === 1 && isSelectable(listing));
// FWA retains custody of staged prizes and prizes awaiting delivery or post-refund recovery.
export const isHeld = (listing: ListingState) => [1, 5, 6, 7].includes(listing.fwaStatus);
export const listedShapeCounts = (listings: readonly ListingState[], status = 1): Counts => {
  const counts = DENOMS.map(() => 0);
  for (const listing of listings) if (listing.kind === 2 && listing.state === 1 && listing.fwaStatus === status) counts[listing.denom]++;
  return counts;
};
export const activationBatch = (listings: readonly ListingState[], unsettled: bigint) => {
  if (unsettled !== 0n) return 0n;
  return BigInt(Math.min(20, listings.filter(isStaged).length));
};

export const isPendingDelivery = (listing: ListingState) => listing.state === 2 && [6, 7].includes(listing.fwaStatus);
export const isRefunded = (listing: ListingState) => listing.state === 2 && listing.fwaStatus === 7;
export const inventoryBatches = <T,>(items: readonly T[], batched: boolean): T[][] => {
  const size = batched ? 20 : 1;
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
};

/** An unavailable history or reserve read never establishes that the creator has nothing left. */
export function closeoutState(d: { listings: readonly ListingState[]; pending: readonly ListingState[];
  proceeds: bigint; surplus?: bigint; unsettled: bigint; awaitingUpkeep: number; historyLoading: boolean; historyError?: string }) {
  if (d.unsettled > 0n || d.awaitingUpkeep > 0) return 'settling';
  if (d.historyLoading || d.historyError || d.surplus === undefined) return 'unknown';
  if (d.proceeds > 0n || d.surplus > 0n || d.listings.some(l => isSelectable(l) || isStaged(l)) || d.pending.some(isRefunded)) return 'recoverable';
  if (d.pending.some(isPendingDelivery)) return 'waiting';
  return 'empty';
}

/** A completed retry leaves local tracking intact; retain it in the ledger, but never offer recovery. */
export function deliveryHistory<T extends ListingState>(items: readonly T[]) {
  const tracked = items.filter(l => l.state === 2);
  return { tracked, pending: tracked.filter(isPendingDelivery) };
}
