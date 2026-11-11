import { numberToHex, parseAbi, toEventSelector, type Address, type PublicClient } from 'viem';

const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const erc721 = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function name() view returns (string)',
  'function tokenURI(uint256 tokenId) view returns (string)',
]);

export interface WalletNft { collection: Address; tokenId: bigint; name: string; image?: string }
type Scan = Pick<PublicClient, 'getBlockNumber' | 'request' | 'multicall'>;

/**
 * ERC-721 tokens the owner holds now. Candidates come from every Transfer into the wallet (ERC-721 Transfer has
 * three indexed topics; ERC-20 has two), then ownerOf confirms current ownership. Candidates and the last scanned
 * block are cached per chain and owner, so later scans read only new blocks. The first scan of a busy wallet can
 * take about a minute on a public RPC.
 */
export async function scanWalletNfts(pub: Scan, owner: Address, chainId: number, exclude: Address[] = []): Promise<WalletNft[]> {
  const key = `nfts:${chainId}:${owner.toLowerCase()}`;
  let from = 0n;
  const seen = new Map<string, [Address, string]>();
  try {
    const c = JSON.parse(localStorage.getItem(key) ?? 'null') as { block: string; seen: [Address, string][] } | null;
    if (c) { from = BigInt(c.block) + 1n; for (const [a, t] of c.seen) seen.set(`${a}:${t}`, [a, t]); }
  } catch { /* storage unavailable: full scan */ }
  const latest = await pub.getBlockNumber();
  if (from <= latest) {
    const topic = `0x${owner.slice(2).toLowerCase().padStart(64, '0')}` as const;
    const logs = await chunkedLogs(pub, from, latest, [TRANSFER, null, topic]);
    for (const l of logs) {
      if (l.topics.length !== 4) continue;
      const t = BigInt(l.topics[3]).toString();
      seen.set(`${l.address.toLowerCase()}:${t}`, [l.address, t]);
    }
    try { localStorage.setItem(key, JSON.stringify({ block: latest.toString(), seen: [...seen.values()] })); } catch { /* ignore */ }
  }
  const skip = new Set(exclude.map((a) => a.toLowerCase()));
  const items = [...seen.values()].filter(([a]) => !skip.has(a.toLowerCase()));
  const owners = await calls(pub, items.map(([a, t]) => ({ address: a, abi: erc721, functionName: 'ownerOf', args: [BigInt(t)] })));
  const held = items.filter((_, i) => owners[i].status === 'success' && (owners[i].result as string).toLowerCase() === owner.toLowerCase());
  const collections = [...new Set(held.map(([a]) => a))];
  const names = await calls(pub, collections.map((a) => ({ address: a, abi: erc721, functionName: 'name' })));
  const nameOf = new Map(collections.map((a, i) => [a, names[i].status === 'success' ? (names[i].result as string) : `${a.slice(0, 6)}…${a.slice(-4)}`]));
  return held
    .map(([a, t]) => ({ collection: a, tokenId: BigInt(t), name: nameOf.get(a)! }))
    .sort((x, y) => x.name.localeCompare(y.name) || (x.tokenId < y.tokenId ? -1 : 1));
}

type RawLog = { address: Address; topics: string[] };
const CHUNK = 500_000n;

/** eth_getLogs over a long range: fixed chunks, a few at a time; a chunk the node rejects or times out on is halved. */
async function chunkedLogs(pub: Scan, from: bigint, to: bigint, topics: (string | null)[]): Promise<RawLog[]> {
  const get = async (a: bigint, b: bigint): Promise<RawLog[]> => {
    try {
      return (await pub.request({ method: 'eth_getLogs', params: [{ fromBlock: numberToHex(a), toBlock: numberToHex(b), topics }] } as never)) as RawLog[];
    } catch (e) {
      if (b - a < 2_000n) throw e;
      const mid = (a + b) / 2n;
      return [...(await get(a, mid)), ...(await get(mid + 1n, b))];
    }
  };
  const ranges: [bigint, bigint][] = [];
  for (let a = from; a <= to; a += CHUNK) ranges.push([a, a + CHUNK - 1n < to ? a + CHUNK - 1n : to]);
  const out: RawLog[] = [];
  for (let i = 0; i < ranges.length; i += 6) (await Promise.all(ranges.slice(i, i + 6).map(([a, b]) => get(a, b)))).forEach((r) => out.push(...r));
  return out;
}

type Result = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };

/** Multicall in ~150-call batches (viem's 1 KB default makes hundreds of requests and trips public RPC rate limits),
 *  retrying failed calls once: a rate-limited batch fails every call in it, a real revert fails again. */
async function calls(pub: Scan, contracts: { address: Address; abi: typeof erc721; functionName: string; args?: unknown[] }[]): Promise<Result[]> {
  const run = (cs: typeof contracts) => pub.multicall({ contracts: cs as never, allowFailure: true, batchSize: 16_384 }) as Promise<Result[]>;
  const out = await run(contracts);
  const retry = out.map((r, i) => (r.status === 'failure' ? i : -1)).filter((i) => i >= 0);
  if (retry.length) (await run(retry.map((i) => contracts[i]))).forEach((r, k) => { out[retry[k]] = r; });
  return out;
}

const gateway = (u: string) => (u.startsWith('ipfs://') ? `https://ipfs.filebase.io/ipfs/${u.slice(7).replace(/^ipfs\//, '')}` : u);

/** Image URL from the token's metadata, or undefined. Only http(s), IPFS and data URLs are followed. */
export async function nftImage(pub: Pick<PublicClient, 'readContract'>, collection: Address, tokenId: bigint): Promise<string | undefined> {
  const uri = (await pub.readContract({ address: collection, abi: erc721, functionName: 'tokenURI', args: [tokenId] })) as string;
  let meta: { image?: string; image_url?: string };
  if (uri.startsWith('data:application/json;base64,')) meta = JSON.parse(atob(uri.slice(29)));
  else if (uri.startsWith('data:application/json')) meta = JSON.parse(decodeURIComponent(uri.slice(uri.indexOf(',') + 1)));
  else if (/^(https?|ipfs):\/\//.test(uri)) meta = await (await fetch(gateway(uri))).json();
  else return undefined;
  const img = meta.image ?? meta.image_url;
  return img && /^(https?:|ipfs:|data:image\/)/.test(img) ? gateway(img) : undefined;
}

/** A collection in the wallet, with OpenSea's floor price (ETH) when known. Tokens are loaded on demand on mainnet. */
export interface Collection { address: Address; name: string; image?: string; floor?: number; slug?: string; count: number; tokens?: WalletNft[] }

// Alchemy's NFT API: holdings, spam flags, images and OpenSea floor prices. "demo" is Alchemy's public, rate-limited
// key; set VITE_ALCHEMY_KEY for production (it ships in the page, so restrict it to the site's domain at Alchemy).
const ALCHEMY = `https://eth-mainnet.g.alchemy.com/nft/v3/${(import.meta.env?.VITE_ALCHEMY_KEY as string | undefined) || 'demo'}`;
type Meta = { address: string; name?: string; tokenType?: string; isSpam?: boolean; numDistinctTokensOwned?: string; image?: { thumbnailUrl?: string; cachedUrl?: string }; openSeaMetadata?: { floorPrice?: number; collectionName?: string; collectionSlug?: string; imageUrl?: string } };
const json = async <T,>(url: string, init?: RequestInit) => { const r = await fetch(url, init); if (!r.ok) throw new Error(`NFT API ${r.status}`); return (await r.json()) as T; };

const toCollection = (m: Meta, count: number, tokens?: WalletNft[]): Collection => ({
  address: m.address as Address,
  name: m.openSeaMetadata?.collectionName || m.name || `${m.address.slice(0, 6)}…${m.address.slice(-4)}`,
  image: m.openSeaMetadata?.imageUrl || m.image?.thumbnailUrl || m.image?.cachedUrl,
  floor: m.openSeaMetadata?.floorPrice || undefined,
  slug: m.openSeaMetadata?.collectionSlug,
  count,
  tokens,
});
/** Most valuable first: OpenSea floor, then how many the wallet holds, then name. */
const byValue = (a: Collection, b: Collection) => (b.floor ?? 0) - (a.floor ?? 0) || b.count - a.count || a.name.localeCompare(b.name);

/**
 * The wallet's ERC-721 collections, most valuable first. Mainnet reads holdings from Alchemy (spam excluded); other
 * chains (a local fork) scan transfer logs and only ask Alchemy for each collection's name, image and floor. Without
 * Alchemy the scan result is returned with no prices.
 */
export async function walletCollections(pub: Scan, owner: Address, chainId: number, exclude: Address[] = []): Promise<Collection[]> {
  const skip = new Set(exclude.map((a) => a.toLowerCase()));
  if (chainId === 1) {
    try {
      const out: Collection[] = [];
      let pageKey: string | undefined;
      do {
        const r = await json<{ contracts: Meta[]; pageKey?: string }>(`${ALCHEMY}/getContractsForOwner?owner=${owner}&pageSize=100&excludeFilters%5B%5D=SPAM${pageKey ? `&pageKey=${pageKey}` : ''}`);
        for (const m of r.contracts) if (m.tokenType === 'ERC721' && !skip.has(m.address.toLowerCase())) out.push(toCollection(m, Number(m.numDistinctTokensOwned ?? 0)));
        pageKey = r.pageKey;
      } while (pageKey);
      return out.sort(byValue);
    } catch { /* fall through to the scan */ }
  }
  const held = await scanWalletNfts(pub, owner, chainId, exclude);
  const groups = new Map<string, WalletNft[]>();
  for (const n of held) groups.set(n.collection.toLowerCase(), [...(groups.get(n.collection.toLowerCase()) ?? []), n]);
  const addresses = [...groups.keys()];
  const meta = new Map<string, Meta>();
  try {
    for (let i = 0; i < addresses.length; i += 100) {
      const r = await json<{ contracts: Meta[] }>(`${ALCHEMY}/getContractMetadataBatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contractAddresses: addresses.slice(i, i + 100) }) });
      for (const m of r.contracts) meta.set(m.address.toLowerCase(), m);
    }
  } catch { /* no prices */ }
  return addresses
    .filter((a) => !meta.get(a)?.isSpam)
    .map((a) => { const t = groups.get(a)!; return toCollection(meta.get(a) ?? { address: t[0].collection, name: t[0].name }, t.length, t); })
    .sort(byValue);
}

/** A collection's tokens in the wallet: already known from a scan, or read from Alchemy (with images) on mainnet. */
export async function collectionTokens(owner: Address, c: Collection): Promise<WalletNft[]> {
  if (c.tokens) return c.tokens;
  const out: WalletNft[] = [];
  let pageKey: string | undefined;
  do {
    const r = await json<{ ownedNfts: { tokenId: string; name?: string; image?: { thumbnailUrl?: string; cachedUrl?: string } }[]; pageKey?: string }>(
      `${ALCHEMY}/getNFTsForOwner?owner=${owner}&contractAddresses%5B%5D=${c.address}&withMetadata=true&pageSize=100${pageKey ? `&pageKey=${pageKey}` : ''}`);
    for (const n of r.ownedNfts) out.push({ collection: c.address, tokenId: BigInt(n.tokenId), name: c.name, image: n.image?.thumbnailUrl || n.image?.cachedUrl });
    pageKey = r.pageKey;
  } while (pageKey && out.length < 1000);
  return out.sort((x, y) => (x.tokenId < y.tokenId ? -1 : 1));
}

export const openSeaAsset = (collection: string, tokenId: bigint | string) => `https://opensea.io/assets/ethereum/${collection}/${tokenId}`;
