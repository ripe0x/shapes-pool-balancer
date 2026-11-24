// Read-only cutover preflight for the community replacement release. Pins one block, then
//  1. scans every legacy factory in deployments/1.legacy.json for BalancerCreated from its deployment block to the
//     pinned block, and checks each legacy ABI's selectors against the deployed code;
//  2. verifies every reused dependency named in script/Deploy.s.sol: code hash, code size, relationships, and for the
//     Draw Packs instance and renderer, equality with the local lib/shape-packs build (run `forge build` first).
// Every read is at the pinned block, so the output file is a function of that block alone. Exit 1 on any mismatch.
// Usage: node --import tsx scripts/deployment-preflight.ts [--rpc-url <url>] [--block <n>] [--out <file>]
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  createPublicClient, getAddress, http, keccak256, parseAbi, parseAbiItem, toFunctionSelector, type Abi, type Address, type Hex, type PublicClient,
} from 'viem';
import { scriptConstants } from './verify-deployment';

export const MAINNET = 'https://mainnet.gateway.tenderly.co';
const LOG_CHUNK = 5_000n;
const created = parseAbiItem('event BalancerCreated(address indexed creator, address indexed balancer, address indexed pool, bytes32 salt)');
const abi = parseAbi([
  'function shapes() view returns (address)', 'function renderer() view returns (address)', 'function MIN_PACK_VALUE() view returns (uint256)',
  'function admin() view returns (address)', 'function presentationLocked() view returns (bool)', 'function name() view returns (string)',
  'function symbol() view returns (string)', 'function implementation() view returns (address)', 'function maxAcquisitionsPerTx() view returns (uint16)',
  'function mintFee() view returns (uint256)', 'function isBalancer(address) view returns (bool)',
]);
type Constants = ReturnType<typeof scriptConstants>;

/** Runtime bytecode a Forge artifact deploys with the given immutable values, in ascending immutable-id order. */
export function expectedRuntime(artifactPath: string, immutables: (Address | bigint)[]): Hex {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  let runtime = (artifact.deployedBytecode.object as string).slice(2);
  const refs = artifact.deployedBytecode.immutableReferences ?? {};
  const ids = Object.keys(refs).sort((a, b) => Number(a) - Number(b));
  if (ids.length !== immutables.length) throw new Error(`${artifactPath}: ${ids.length} immutables, ${immutables.length} values`);
  ids.forEach((id, i) => {
    for (const { start, length } of refs[id]) runtime = runtime.slice(0, start * 2) + BigInt(immutables[i]).toString(16).padStart(length * 2, '0') + runtime.slice((start + length) * 2);
  });
  return `0x${runtime}`;
}

/** Code hash, size and relationship readbacks of every reused dependency at one block. Never a receipt. */
export async function checkDependencies(pub: PublicClient, c: Constants, blockNumber: bigint, outDir = 'out') {
  const bad: string[] = [];
  // A reverting getter is a finding, not a crash: the record is still written.
  const read = <T>(address: Address, functionName: string) => (pub.readContract({ address, abi, functionName, blockNumber } as never) as Promise<T>)
    .catch(() => { bad.push(`${address}.${functionName}() reverted`); return null; });
  const want = (label: string, got: unknown, expected: unknown) => {
    const norm = (v: unknown) => typeof v === 'string' ? v.toLowerCase() : String(v);
    if (norm(got) !== norm(expected)) bad.push(`${label} = ${got}, expected ${expected}`);
  };
  const code: Record<string, { address: Address; codeHash: Hex; codeBytes: number; recordedCodeHash: Hex }> = {};
  const runtimes: Record<string, Hex> = {};
  for (const [name, address, recorded] of [['shapes', c.shapes, c.shapesCodehash], ['packs', c.packs, c.packsCodehash], ['renderer', c.renderer, c.rendererCodehash],
    ['fwaFactory', c.fwaFactory, c.fwaFactoryCodehash], ['fwaImplementation', c.fwaImpl, c.fwaCodehash]] as const) {
    const runtime = (await pub.getCode({ address, blockNumber })) ?? '0x';
    if (runtime === '0x') bad.push(`${name}: no code at ${address}`);
    runtimes[name] = runtime;
    code[name] = { address, codeHash: keccak256(runtime), codeBytes: (runtime.length - 2) / 2, recordedCodeHash: recorded };
    want(`${name} code hash`, code[name].codeHash, recorded);
  }
  const readbacks = {
    packsShapes: await read<Address>(c.packs, 'shapes'), packsRenderer: await read<Address>(c.packs, 'renderer'),
    packsMinimumWei: await read<bigint>(c.packs, 'MIN_PACK_VALUE'), packsAdmin: await read<Address>(c.packs, 'admin'),
    packsPresentationLocked: await read<boolean>(c.packs, 'presentationLocked'), packsName: await read<string>(c.packs, 'name'),
    packsSymbol: await read<string>(c.packs, 'symbol'), rendererShapes: await read<Address>(c.renderer, 'shapes'),
    fwaFactoryImplementation: await read<Address>(c.fwaFactory, 'implementation'), fwaMaxAcquisitionsPerTx: await read<number>(c.fwaFactory, 'maxAcquisitionsPerTx'),
    shapesMintFeeWei: await read<bigint>(c.shapes, 'mintFee'),
  };
  want('packs.shapes()', readbacks.packsShapes, c.shapes);
  want('packs.renderer()', readbacks.packsRenderer, c.renderer);
  want('packs.MIN_PACK_VALUE()', readbacks.packsMinimumWei, 2n * 10n ** 16n);
  want('packs.name()', readbacks.packsName, c.packsName);
  want('packs.symbol()', readbacks.packsSymbol, c.packsSymbol);
  want('renderer.shapes()', readbacks.rendererShapes, c.shapes);
  want('fwaFactory.implementation()', readbacks.fwaFactoryImplementation, c.fwaImpl);
  want('fwaFactory.maxAcquisitionsPerTx()', readbacks.fwaMaxAcquisitionsPerTx, 5);
  // The reused Packs and renderer are exactly the pinned lib/shape-packs source built by this repository.
  const localBuild = {
    packs: keccak256(expectedRuntime(`${outDir}/ShapePacks.sol/ShapePacks.json`, [c.shapes, 2n * 10n ** 16n])) === code.packs.codeHash,
    renderer: keccak256(expectedRuntime(`${outDir}/ShapePackRenderer.sol/ShapePackRenderer.json`, [c.shapes])) === code.renderer.codeHash,
  };
  if (!localBuild.packs) bad.push('packs runtime differs from the local lib/shape-packs build');
  if (!localBuild.renderer) bad.push('renderer runtime differs from the local lib/shape-packs build');
  return { bad, dependencies: { code, readbacks, matchesLocalBuild: localBuild } };
}

/** Every function selector of `abi` appears as a PUSH4 operand in `runtime` (the dispatcher's comparisons). */
export function missingSelectors(abiItems: Abi, runtime: Hex): string[] {
  const code = runtime.toLowerCase();
  return abiItems.filter(i => i.type === 'function').map(i => toFunctionSelector(i as never)).filter(s => !code.includes(`63${s.slice(2)}`));
}

/** All BalancerCreated logs of one factory in [fromBlock, toBlock], in chain order, each checked against isBalancer. */
export async function scanFactory(pub: PublicClient, factory: Address, fromBlock: bigint, toBlock: bigint) {
  const pools = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK) {
    const end = start + LOG_CHUNK - 1n < toBlock ? start + LOG_CHUNK - 1n : toBlock;
    const logs = await pub.getLogs({ address: factory, event: created, fromBlock: start, toBlock: end, strict: true });
    for (const l of logs) pools.push({
      balancer: getAddress(l.args.balancer), creator: getAddress(l.args.creator), pool: getAddress(l.args.pool), salt: l.args.salt,
      blockNumber: l.blockNumber.toString(), transactionHash: l.transactionHash, logIndex: l.logIndex,
    });
  }
  const bad: string[] = [];
  for (const p of pools)
    if (!await pub.readContract({ address: factory, abi, functionName: 'isBalancer', args: [p.balancer], blockNumber: toBlock })) bad.push(`${factory}: logged balancer ${p.balancer} is not registered`);
  return { pools, bad };
}

export async function preflight(pub: PublicClient, blockNumber: bigint | undefined, deploySource: string, legacyConfig: any, outDir = 'out') {
  const block = await pub.getBlock(blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber });
  const at = block.number!;
  const c = scriptConstants(deploySource);
  const deps = await checkDependencies(pub, c, at, outDir);
  const bad = [...deps.bad];
  const legacyFactories = [];
  for (const f of legacyConfig.legacyFactories) {
    const factory = getAddress(f.balancerFactory);
    const scan = await scanFactory(pub, factory, BigInt(f.deploymentBlock), at);
    bad.push(...scan.bad);
    const abis = f.abiName ? legacyConfig.abis[f.abiName] : undefined;
    const abiCheck: Record<string, string[]> = {};
    if (abis) for (const [label, address, items] of [['balancerFactory', factory, abis.balancerFactory], ['poolBalancer', f.poolBalancerImplementation, abis.poolBalancer],
      ['keeperPolicyV1', f.keeperPolicy, abis.keeperPolicyV1]] as const) {
      // community-v2 and later have no keeper policy contract (R95).
      if (label === 'keeperPolicyV1' && !address && !items) continue;
      abiCheck[label] = missingSelectors(items, (await pub.getCode({ address: getAddress(address), blockNumber: at })) ?? '0x');
      if (abiCheck[label].length) bad.push(`${f.label} ${label} ABI: selectors ${abiCheck[label].join(',')} absent from ${address}`);
    } else if (scan.pools.length) bad.push(`${f.label}: ${scan.pools.length} pool(s) found but no ABI is packaged in the legacy config`);
    const implementation = await pub.readContract({ address: factory, abi, functionName: 'implementation', blockNumber: at });
    if (getAddress(implementation) !== getAddress(f.poolBalancerImplementation)) bad.push(`${f.label}: implementation ${implementation}, config ${f.poolBalancerImplementation}`);
    legacyFactories.push({ label: f.label, balancerFactory: factory, scannedFromBlock: String(f.deploymentBlock), scannedToBlock: at.toString(),
      poolCount: scan.pools.length, pools: scan.pools, abiName: f.abiName, missingAbiSelectors: abis ? abiCheck : null });
  }
  return {
    schema: 'community-deployment-preflight-v1', chainId: await pub.getChainId(),
    checkedBlock: { number: at.toString(), hash: block.hash, timestamp: block.timestamp.toString() },
    ok: bad.length === 0, problems: bad, legacyFactories, reusedDependencies: deps.dependencies,
  };
}

async function main(argv: string[]) {
  const arg = (n: string) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
  const rpc = arg('--rpc-url') ?? MAINNET;
  const pub = createPublicClient({ transport: http(rpc, { timeout: 60_000 }) }) as PublicClient;
  const result = await preflight(pub, arg('--block') === undefined ? undefined : BigInt(arg('--block')!), readFileSync('script/Deploy.s.sol', 'utf8'),
    JSON.parse(readFileSync('deployments/1.legacy.json', 'utf8')));
  const out = arg('--out') ?? `deployments/${result.chainId}.preflight.json`;
  writeFileSync(out, JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
  console.log(JSON.stringify({ rpc, out, checkedBlock: result.checkedBlock, ok: result.ok, problems: result.problems,
    legacyPools: Object.fromEntries(result.legacyFactories.map(f => [f.balancerFactory, f.poolCount])) }, null, 2));
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2)).then(c => process.exit(c), e => { console.error((e as Error).message); process.exit(2); });
