import type { Address } from 'viem';

/** ERC-721 collection approvals share one operator across every token in that contract. */
export function approvalCollections<T extends { collection?: Address }>(nfts: readonly T[]): T[][] {
  const collections = new Map<string, T[]>();
  for (const nft of nfts) {
    if (!nft.collection) continue;
    const key = nft.collection.toLowerCase();
    const group = collections.get(key);
    if (group) group.push(nft); else collections.set(key, [nft]);
  }
  return [...collections.values()];
}

export const needsCollectionApproval = (approvedForAll: boolean, tokenApprovals: readonly string[], operator: Address) =>
  !approvedForAll && tokenApprovals.some(approved => approved.toLowerCase() !== operator.toLowerCase());
