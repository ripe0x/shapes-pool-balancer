import { expect, it } from 'vitest';
import { approvalCollections, needsCollectionApproval } from './nft-approvals';

const first = '0x11111111111111111111111111111111111111aA' as const;
const second = '0x2222222222222222222222222222222222222222' as const;
const operator = '0x33333333333333333333333333333333333333bB' as const;
const zero = '0x0000000000000000000000000000000000000000';

it('groups selected NFTs into one approval per collection, including mixed address casing', () => {
  const nfts = [{ collection: first, tokenId: '1' }, { collection: second, tokenId: '2' },
    { collection: first.toLowerCase() as typeof first, tokenId: '3' }];
  expect(approvalCollections(nfts)).toEqual([[nfts[0], nfts[2]], [nfts[1]]]);
  expect(approvalCollections([])).toEqual([]);
});

it('does not request broader approval when existing token or collection permission already covers the selection', () => {
  expect(needsCollectionApproval(true, [zero, zero], operator)).toBe(false);
  expect(needsCollectionApproval(false, [operator, operator.toLowerCase()], operator)).toBe(false);
  expect(needsCollectionApproval(false, [operator, zero], operator)).toBe(true);
  expect(needsCollectionApproval(false, [], operator)).toBe(false);
});
