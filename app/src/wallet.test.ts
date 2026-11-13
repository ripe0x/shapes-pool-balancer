import { beforeEach, describe, expect, it } from 'vitest';
import { scanWalletNfts, walletCollections } from './wallet';

const OWNER = '0x00000000000000000000000000000000000000aa';
const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const SKIP = '0x00000000000000000000000000000000000000c3';
const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (x: string | bigint) => `0x${(typeof x === 'bigint' ? x.toString(16) : x.slice(2)).padStart(64, '0')}`;
const nft = (address: string, id: bigint, block: number) => ({ address, block, topics: [T, pad('0x01'), pad(OWNER), pad(id)] });

/** Fake client: logs by block, ownership table, and a node that rejects ranges wider than `maxRange`. */
function client(logs: { address: string; block: number; topics: string[] }[], owners: Record<string, string>, maxRange: number, latest = 2_000_000n) {
  const requests: [bigint, bigint][] = [];
  return {
    requests,
    getBlockNumber: async () => latest,
    request: async ({ params: [p] }: { params: [{ fromBlock: string; toBlock: string }] }) => {
      const [a, b] = [BigInt(p.fromBlock), BigInt(p.toBlock)];
      requests.push([a, b]);
      if (b - a > BigInt(maxRange)) throw new Error('range too large');
      return logs.filter((l) => BigInt(l.block) >= a && BigInt(l.block) <= b);
    },
    multicall: async ({ contracts }: { contracts: { address: string; functionName: string; args?: bigint[] }[] }) =>
      contracts.map((c) => {
        if (c.functionName === 'name') return { status: 'success', result: c.address === A ? 'Alpha' : 'Beta' };
        const o = owners[`${c.address}:${c.args![0]}`];
        return o ? { status: 'success', result: o } : { status: 'failure', error: new Error('revert') };
      }),
  };
}

beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
});

describe('scanWalletNfts', () => {
  it('keeps ERC-721 tokens the wallet still owns, ignores ERC-20 transfers and excluded collections', async () => {
    const logs = [
      nft(A, 1n, 10), nft(A, 2n, 600_000), nft(B, 7n, 1_500_000), nft(SKIP, 3n, 20),
      { address: B, block: 30, topics: [T, pad('0x01'), pad(OWNER)] }, // ERC-20: two indexed topics
    ];
    const owners = { [`${A}:1`]: OWNER, [`${A}:2`]: '0x00000000000000000000000000000000000000ff', [`${B}:7`]: OWNER, [`${SKIP}:3`]: OWNER };
    const c = client(logs, owners, 300_000);
    const r = await scanWalletNfts(c as never, OWNER, 1, [SKIP]);
    expect(r.map((n) => `${n.name} #${n.tokenId}`)).toEqual(['Alpha #1', 'Beta #7']);
    // 500k chunks over the node's 300k limit were halved and still covered every block.
    expect(c.requests.some(([a, b]) => b - a > 300_000n)).toBe(true);
    expect(c.requests.filter(([a, b]) => b - a <= 300_000n).reduce((s, [a, b]) => s + (b - a + 1n), 0n)).toBe(2_000_001n);
  });

  it('a second scan reads only blocks after the cached one and keeps earlier finds', async () => {
    const owners = { [`${A}:1`]: OWNER, [`${B}:9`]: OWNER };
    await scanWalletNfts(client([nft(A, 1n, 10)], owners, 10_000_000) as never, OWNER, 1);
    const c2 = client([nft(A, 1n, 10), nft(B, 9n, 2_000_005)], owners, 10_000_000, 2_000_010n);
    const r = await scanWalletNfts(c2 as never, OWNER, 1);
    expect(c2.requests).toEqual([[2_000_001n, 2_000_010n]]);
    expect(r.map((n) => n.tokenId)).toEqual([1n, 9n]);
  });
});

describe('walletCollections (scan + Alchemy prices)', () => {
  const C = '0x00000000000000000000000000000000000000c4';
  const logs = [nft(A, 1n, 10), nft(A, 2n, 20), nft(B, 7n, 30), nft(C, 9n, 40)];
  const owners = { [`${A}:1`]: OWNER, [`${A}:2`]: OWNER, [`${B}:7`]: OWNER, [`${C}:9`]: OWNER };

  it('groups by collection, drops spam and lists the highest floor first', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => ({ ok: true, json: async () => ({ contracts: [
      { address: A, name: 'Alpha', openSeaMetadata: { floorPrice: 0.01, collectionSlug: 'alpha' } },
      { address: B, name: 'Beta', openSeaMetadata: { floorPrice: 2.5, imageUrl: 'https://img/b' } },
      { address: C, name: 'Junk', isSpam: true },
    ] }) });
    const r = await walletCollections(client(logs, owners, 10_000_000) as never, OWNER, 31337);
    expect(r.map((c) => [c.name, c.count, c.floor])).toEqual([['Beta', 1, 2.5], ['Alpha', 2, 0.01]]);
    expect(r[0].image).toBe('https://img/b');
    expect(r[1].tokens?.map((t) => t.tokenId)).toEqual([1n, 2n]);
  });

  it('still lists the wallet when the price service fails', async () => {
    (globalThis as { fetch?: unknown }).fetch = async () => ({ ok: false, status: 429 });
    const r = await walletCollections(client(logs, owners, 10_000_000) as never, OWNER, 31337);
    expect(r).toHaveLength(3);
    expect(r.every((c) => c.floor === undefined)).toBe(true);
  });
});
