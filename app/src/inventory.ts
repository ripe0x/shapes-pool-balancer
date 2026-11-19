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
