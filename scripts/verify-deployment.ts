// Verifies a broadcast deployment from canonical chain data before any canary funding. Read-only.
// `deployments/<chainId>.json` is written by Deploy.s.sol during its simulation (dry run included) and its `block` is the
// simulation block, so it proves nothing. This check reads every broadcast transaction's receipt from the RPC, requires
// its calldata to equal the reviewed dry run, and writes `deployments/<chainId>.verified.json` only when all checks pass.
// The record separates contracts this broadcast created (each matched to its creation receipt) from reused dependencies
// (reuse mode: verified by code hash and getter readbacks at the checked block, never given a receipt).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkDependencies } from './deployment-preflight';
import {
  createPublicClient, getAddress, getContractAddress, http, keccak256, parseAbi, slice, zeroAddress, type Address, type Hex, type PublicClient,
} from 'viem';

const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
export const LIBRARIES = ['KeeperPolicyCalls', 'PoolPage', 'PoolInventory'];
/** Contracts Deploy.s.sol creates, in order. Reuse mode creates no Packs or renderer; any library may already be on chain. */
export const creationOrder = (reuse: boolean) => [...LIBRARIES, ...(reuse ? [] : ['ShapePackRenderer', 'ShapePacks']), 'PoolBalancer', 'KeeperPolicyV1', 'BalancerFactory'];
/** Reuse mode is a dry run that creates no Packs instance. */
export const isReuse = (dry: { contractName: string }[]) => !dry.some(t => t.contractName === 'ShapePacks');
const abi = parseAbi([
  'function implementation() view returns (address)', 'function keeperAdmin() view returns (address)', 'function policyAdmin() view returns (address)',
  'function defaultKeeperPolicy() view returns (address)', 'function keepersRestricted() view returns (bool)', 'function pendingKeeperAdmin() view returns (address)',
  'function pendingPolicyAdmin() view returns (address)', 'function pendingDefaultKeeperPolicy() view returns (address)', 'function creator() view returns (address)',
  'function FWA_FACTORY() view returns (address)', 'function FWA_IMPLEMENTATION() view returns (address)', 'function SHAPES() view returns (address)',
  'function PACKS() view returns (address)', 'function ENS() view returns (address)', 'function shapes() view returns (address)', 'function MIN_PACK_VALUE() view returns (uint256)',
  'function admin() view returns (address)', 'function renderer() view returns (address)', 'function presentationLocked() view returns (bool)',
  'function name() view returns (string)', 'function symbol() view returns (string)',
]);

/** Deployment constants come from Deploy.s.sol itself, so the verifier cannot drift from the reviewed script. */
export function scriptConstants(source: string) {
  const get = (name: string) => {
    const m = source.match(new RegExp(`constant\\s+${name}\\s*=\\s*("?)([^";]+)\\1;`));
    if (!m) throw new Error(`Deploy.s.sol constant ${name} not found`);
    return m[2].trim();
  };
  const hash = (name: string) => get(name).toLowerCase() as Hex;
  return {
    fwaFactory: getAddress(get('FWA_FACTORY')), fwaImpl: getAddress(get('FWA_IMPL')), shapes: getAddress(get('SHAPES')), ens: getAddress(get('ENS')),
    packsName: get('PACKS_NAME'), packsSymbol: get('PACKS_SYMBOL'),
    packs: getAddress(get('PACKS')), renderer: getAddress(get('RENDERER')), fwaCodehash: hash('FWA_CODEHASH'), shapesCodehash: hash('SHAPES_CODEHASH'),
    packsCodehash: hash('PACKS_CODEHASH'), rendererCodehash: hash('RENDERER_CODEHASH'), fwaFactoryCodehash: hash('FWA_FACTORY_CODEHASH'),
  };
}

interface ArtifactTx { hash?: Hex; contractName: string; contractAddress: Address; transactionType: string; transaction: { from: Address; to?: Address | null; nonce: Hex; input: Hex } }
const txs = (path: string) => (JSON.parse(readFileSync(path, 'utf8')).transactions as ArtifactTx[]);

/** Linked library addresses from a Forge artifact's `libraries` entries ("path:Name:0x…"). */
export function linkedLibraries(path: string): Record<string, Address> {
  const entries = (JSON.parse(readFileSync(path, 'utf8')).libraries ?? []) as string[];
  return Object.fromEntries(entries.map(e => { const [, name, address] = e.split(':'); return [name, getAddress(address)]; }));
}

/** The broadcast must be the reviewed dry run, transaction for transaction: same sender, nonce, kind, target and calldata.
 *  Forge skips a library whose CREATE2 address already holds code; that address commits to the library's exact init code,
 *  so a dry run may omit libraries, and verify() then requires code at each omitted library's linked address. */
export function matchPlan(dry: ArtifactTx[], sent: ArtifactTx[]): string[] {
  const bad: string[] = [];
  const names = dry.map(t => t.contractName);
  if (JSON.stringify(names) !== JSON.stringify(creationOrder(isReuse(dry)).filter(n => names.includes(n) || !LIBRARIES.includes(n)))) bad.push(`reviewed dry run is not the deployment order: ${names}`);
  if (sent.length !== dry.length) bad.push(`broadcast has ${sent.length} transactions, reviewed dry run ${dry.length}`);
  sent.forEach((t, i) => {
    const d = dry[i];
    if (!d) return;
    if (!t.hash) bad.push(`${t.contractName}: no transaction hash (not a broadcast artifact)`);
    for (const [k, a, b] of [['contract', t.contractName, d.contractName], ['type', t.transactionType, d.transactionType], ['sender', t.transaction.from, d.transaction.from],
      ['nonce', t.transaction.nonce, d.transaction.nonce], ['address', t.contractAddress, d.contractAddress], ['calldata', keccak256(t.transaction.input), keccak256(d.transaction.input)]] as const)
      if (String(a).toLowerCase() !== String(b).toLowerCase()) bad.push(`${d.contractName}: ${k} differs from the reviewed dry run`);
  });
  return bad;
}

export async function verify(pub: PublicClient, dryPath: string, sentPath: string, roles: { deployer: Address; packsAdmin: Address; keeperAdmin: Address; policyAdmin: Address }, deploySource: string, outDir = 'out') {
  const c = scriptConstants(deploySource);
  const dry = txs(dryPath), sent = txs(sentPath);
  const bad = matchPlan(dry, sent);
  const reuse = isReuse(dry);
  if (!reuse && await pub.getChainId() === 1) bad.push('mainnet deployment must reuse the community dependencies');
  if (bad.length) return { bad };
  const at: Record<string, Address> = {};
  const deployed: Record<string, { address: Address; hash: Hex; block: string; blockHash: Hex; gasUsed: string; effectiveGasPrice: string }> = {};
  for (const t of sent) {
    const r = await pub.getTransactionReceipt({ hash: t.hash! });
    const tx = await pub.getTransaction({ hash: t.hash! });
    const canonical = (await pub.getBlock({ blockNumber: r.blockNumber })).hash;
    const name = t.contractName;
    if (r.status !== 'success') bad.push(`${name}: receipt status ${r.status}`);
    if (canonical !== r.blockHash) bad.push(`${name}: receipt block is not canonical`);
    if (getAddress(r.from) !== roles.deployer || getAddress(tx.from) !== roles.deployer) bad.push(`${name}: sender is not DEPLOYER`);
    if (keccak256(tx.input) !== keccak256(t.transaction.input)) bad.push(`${name}: mined calldata differs from the reviewed dry run`);
    let address: Address;
    if (t.transactionType === 'CREATE2') {
      if (!tx.to || getAddress(tx.to) !== getAddress(CREATE2_DEPLOYER)) bad.push(`${name}: not sent to the CREATE2 deployer`);
      address = getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt: slice(tx.input, 0, 32), bytecode: slice(tx.input, 32) });
    } else {
      if (tx.to) bad.push(`${name}: not a contract creation`);
      address = getContractAddress({ opcode: 'CREATE', from: roles.deployer, nonce: BigInt(tx.nonce) });
      if (!r.contractAddress || getAddress(r.contractAddress) !== address) bad.push(`${name}: receipt created a different address`);
    }
    if (address !== getAddress(t.contractAddress)) bad.push(`${name}: deployed at ${address}, plan ${t.contractAddress}`);
    const code = await pub.getCode({ address });
    if (!code || code === '0x') bad.push(`${name}: no code at ${address}`);
    at[name] = address;
    deployed[name] = { address, hash: t.hash!, block: r.blockNumber.toString(), blockHash: r.blockHash, gasUsed: r.gasUsed.toString(), effectiveGasPrice: r.effectiveGasPrice.toString() };
  }
  const preexistingLibraries: Record<string, Address> = {};
  const linked = linkedLibraries(dryPath);
  for (const name of LIBRARIES.filter(n => !at[n])) {
    const address = linked[name];
    if (!address) { bad.push(`${name}: neither deployed nor linked in the reviewed dry run`); continue; }
    const code = await pub.getCode({ address });
    if (!code || code === '0x') bad.push(`${name}: skipped by the dry run but no code at ${address}`);
    preexistingLibraries[name] = address;
  }
  if (bad.length) return { bad };
  const read =(address: Address, functionName: string) => pub.readContract({ address, abi, functionName } as never) as Promise<any>;
  const eq = async (label: string, address: Address, fn: string, want: unknown) => {
    const got = await read(address, fn);
    const norm = (v: unknown) => typeof v === 'string' && v.startsWith('0x') ? v.toLowerCase() : String(v);
    if (norm(got) !== norm(want)) bad.push(`${label}.${fn} = ${got}, expected ${want}`);
  };
  const [f, impl] = [at.BalancerFactory, at.PoolBalancer];
  const [packs, renderer] = reuse ? [c.packs, c.renderer] : [at.ShapePacks, at.ShapePackRenderer];
  const head = await pub.getBlockNumber();
  // Reused dependencies are checked at the same block as the record, after every created contract's receipt.
  const reused = reuse ? await checkDependencies(pub, c, head, outDir) : undefined;
  bad.push(...(reused?.bad ?? []));
  await eq('factory', f, 'implementation', impl);
  await eq('factory', f, 'keeperAdmin', roles.keeperAdmin);
  await eq('factory', f, 'policyAdmin', roles.policyAdmin);
  await eq('factory', f, 'defaultKeeperPolicy', at.KeeperPolicyV1);
  await eq('factory', f, 'keepersRestricted', false);
  for (const fn of ['pendingKeeperAdmin', 'pendingPolicyAdmin', 'pendingDefaultKeeperPolicy']) await eq('factory', f, fn, zeroAddress);
  await eq('implementation', impl, 'creator', '0x0000000000000000000000000000000000000001');
  await eq('implementation', impl, 'FWA_FACTORY', c.fwaFactory);
  await eq('implementation', impl, 'FWA_IMPLEMENTATION', c.fwaImpl);
  await eq('implementation', impl, 'SHAPES', c.shapes);
  await eq('implementation', impl, 'PACKS', packs);
  await eq('implementation', impl, 'ENS', c.ens);
  await eq('packs', packs, 'shapes', c.shapes);
  await eq('packs', packs, 'MIN_PACK_VALUE', 2n * 10n ** 16n);
  await eq('packs', packs, 'admin', roles.packsAdmin);
  await eq('packs', packs, 'renderer', renderer);
  await eq('packs', packs, 'presentationLocked', false);
  await eq('packs', packs, 'name', c.packsName);
  await eq('packs', packs, 'symbol', c.packsSymbol);
  if (bad.length) return { bad };
  return {
    bad,
    record: {
      verified: true, source: 'canonical receipts and contract reads', chainId: await pub.getChainId(), checkedAtBlock: head.toString(),
      checkedAtBlockHash: (await pub.getBlock({ blockNumber: head })).hash,
      factoryDeploymentBlock: deployed.BalancerFactory.block, balancerFactory: f, poolBalancerImplementation: impl, packs, renderer, keeperPolicy: at.KeeperPolicyV1,
      roles, transactions: deployed, preexistingLibraries, reusedDependencies: reused?.dependencies ?? null,
      deploymentGasWei: Object.values(deployed).reduce((s, d) => s + BigInt(d.gasUsed) * BigInt(d.effectiveGasPrice), 0n).toString(),
    },
  };
}

async function main(argv: string[]) {
  const arg = (n: string) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
  const rpc = arg('--rpc-url'), dry = arg('--reviewed-dry-run'), sent = arg('--broadcast');
  const dryHash = arg('--reviewed-dry-run-sha256');
  if (!rpc || !dry || !sent || !dryHash) { console.error('usage: verify-deployment.ts --rpc-url <url> --reviewed-dry-run <json> --reviewed-dry-run-sha256 <from the approved plan> --broadcast <run-latest.json> [--out <file>]  (env DEPLOYER, PACKS_ADMIN, KEEPER_ADMIN, POLICY_ADMIN)'); return 2; }
  const actual = createHash('sha256').update(readFileSync(dry)).digest('hex');
  if (actual !== dryHash) { console.error(`reviewed dry run ${dry} has SHA-256 ${actual}, not the approved ${dryHash}`); return 1; }
  const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return getAddress(v); };
  const roles = { deployer: env('DEPLOYER'), packsAdmin: env('PACKS_ADMIN'), keeperAdmin: env('KEEPER_ADMIN'), policyAdmin: env('POLICY_ADMIN') };
  const pub = createPublicClient({ transport: http(rpc, { timeout: 60_000 }) }) as PublicClient;
  console.log(JSON.stringify({ rpc }));
  const result = await verify(pub, dry, sent, roles, readFileSync('script/Deploy.s.sol', 'utf8'));
  if (result.bad.length) { console.error('DEPLOYMENT NOT VERIFIED\n' + result.bad.map(b => '  ' + b).join('\n')); return 1; }
  const out = arg('--out') ?? `deployments/${result.record!.chainId}.verified.json`;
  writeFileSync(out, JSON.stringify(result.record, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
  console.log(`DEPLOYMENT VERIFIED: ${out}\n` + JSON.stringify({ factory: result.record!.balancerFactory, factoryDeploymentBlock: result.record!.factoryDeploymentBlock, deploymentGasWei: result.record!.deploymentGasWei }, null, 2));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2)).then(c => process.exit(c), e => { console.error((e as Error).message); process.exit(2); });
