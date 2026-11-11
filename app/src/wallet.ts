import { numberToHex, parseAbi, toEventSelector, type Address, type PublicClient } from 'viem';

const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const erc721 = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function name() view returns (string)',
  'function tokenURI(uint256 tokenId) view returns (string)',
]);

export interface WalletNft { collection: Address; tokenId: bigint; name: string }
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
