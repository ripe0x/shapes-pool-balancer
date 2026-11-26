// Pool index: every BalancerCreated log from the current and legacy factories, and every CreatorTransferred log among
// those pools, read server-side through Alchemy and cached at Netlify's edge for 10 minutes: at most one Alchemy scan
// per 10 minutes however many visitors load it, and none while nobody does. A browser that creates a pool lists it at
// once from its own record (app/src/App.tsx), so the cache only delays pools made elsewhere or transferred in.
// The dashboard treats the index as candidates only: it confirms each pool's factory (isBalancer) and creator() on
// chain before listing it.
import { createPublicClient, http, parseAbiItem, type Address } from 'viem';
import { mainnet } from 'viem/chains';
import legacy from '../../deployments/1.legacy.json';

const CREATED = parseAbiItem('event BalancerCreated(address indexed creator, address indexed balancer, address indexed pool, bytes32 salt)');
const TRANSFERRED = parseAbiItem('event CreatorTransferred(address indexed oldCreator, address indexed newCreator)');

const json = (status: number, body: unknown, cache: string) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=0, must-revalidate', 'netlify-cdn-cache-control': cache },
});

export default async () => {
  const upstream = process.env.ALCHEMY_MAINNET_URL;
  const factory = process.env.VITE_FACTORY as Address | undefined;
  if (!upstream || !factory) return json(503, { error: 'index not configured' }, 'no-store');
  const sources = [{ factory, fromBlock: BigInt(process.env.VITE_FROM_BLOCK ?? 0) },
    ...legacy.legacyFactories.map((f) => ({ factory: f.balancerFactory as Address, fromBlock: BigInt(f.deploymentBlock) }))];
  const fromBlock = sources.reduce((m, s) => (s.fromBlock < m ? s.fromBlock : m), sources[0].fromBlock);
  try {
    const pub = createPublicClient({ chain: mainnet, transport: http(upstream, { retryCount: 1 }) });
    const block = await pub.getBlockNumber();
    const created = await pub.getLogs({ address: sources.map((s) => s.factory), event: CREATED, fromBlock, toBlock: block });
    const pools = created.map((l) => l.args.balancer!);
    const transfers = pools.length ? await pub.getLogs({ address: pools, event: TRANSFERRED, fromBlock, toBlock: block }) : [];
    return json(200, {
      block: block.toString(),
      created: created.map((l) => ({ factory: l.address, balancer: l.args.balancer, creator: l.args.creator })),
      transfers: transfers.map((l) => ({ balancer: l.address, newCreator: l.args.newCreator })),
    }, 'public, durable, s-maxage=600');
  } catch {
    // The upstream error can include its URL, so it is never returned.
    return json(502, { error: 'index upstream unavailable' }, 'no-store');
  }
};
