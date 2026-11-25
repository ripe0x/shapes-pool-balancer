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
  createPublicClient, decodeEventLog, encodeAbiParameters, encodeFunctionData, getAddress, getContractAddress, http, keccak256, parseAbi, parseAbiParameters, parseEther, parseGwei, slice, zeroAddress,
  type Address, type Hex, type PublicClient,
} from 'viem';
import { balancerFactoryAbi } from '../shared/abi';

const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
export const LIBRARIES = ['KeeperPolicyCalls', 'PoolPage', 'PoolInventory'];
/** Contracts Deploy.s.sol creates, in order. Reuse mode creates no Packs or renderer; any library may already be on chain.
 *  No keeper policy contract: the payment formula is in KeeperPolicyCalls (owner decision R95). */
export const creationOrder = (reuse: boolean, implementationOnly = false) => [...LIBRARIES, ...(reuse ? [] : ['ShapePackRenderer', 'ShapePacks']), 'PoolBalancer', ...(implementationOnly ? [] : ['BalancerFactory'])];
/** Reuse mode is a dry run that creates no Packs instance. */
export const isReuse = (dry: { contractName: string }[]) => !dry.some(t => t.contractName === 'ShapePacks');
const abi = parseAbi([
  'function implementation() view returns (address)', 'function keeperAdmin() view returns (address)', 'function policyAdmin() view returns (address)',
  'function keepersRestricted() view returns (bool)', 'function pendingKeeperAdmin() view returns (address)',
  'function pendingPolicyAdmin() view returns (address)', 'function creator() view returns (address)',
  'function defaultBucketCapacity() view returns (uint128)', 'function defaultBucketRefill() view returns (uint96)', 'function mintFee() view returns (uint256)',
  'function creationSettingsHash() view returns (bytes32)',
  'function FWA_FACTORY() view returns (address)', 'function FWA_IMPLEMENTATION() view returns (address)', 'function SHAPES() view returns (address)',
  'function PACKS() view returns (address)', 'function ENS() view returns (address)', 'function shapes() view returns (address)', 'function MIN_PACK_VALUE() view returns (uint256)',
  'function admin() view returns (address)', 'function renderer() view returns (address)', 'function presentationLocked() view returns (bool)',
  'function name() view returns (string)', 'function symbol() view returns (string)',
]);

/** Reviewed initial factory settings (docs/CONFIG-INVENTORY.md section 0), stated independently of the factory constructor and
 *  of Deploy.s.sol `initialEconomics`. Economics fields in struct order. */
export const INITIAL_SETTINGS = {
  economics: {
    workFee: parseEther('0.00002'), maxGas: 3_200_000, overheadGas: 60_000, gasPriceCeiling: parseGwei('5'), priorityAllowance: parseGwei('0.05'),
    restockGas: 910_000, restockFlat: parseEther('0.0002'), baseGas: 200_000, processGas: 1_800_000, reconcileGas: 150_000, shapeGas: 700_000, prizeGas: 150_000,
    processGraceBlocks: 50, pausedProcessGraceBlocks: 10,
  },
  bucketCapacity: parseEther('0.622'), bucketRefill: parseEther('0.05') / 12n, productLimits: [1000, 1000, 10000] as const,
};
/** `BalancerFactory.creationSettingsHash`: a new pool's `KeeperPolicyCalls.settingsHash` (follows the factory, source 0,
 *  generation 0, paid upkeep on, at `mintFee`) bound to the default bucket it copies and the implementation it clones. */
export function creationSettingsHash(economics: typeof INITIAL_SETTINGS.economics, mintFee: bigint,
  bucketCapacity: bigint, bucketRefill: bigint, implementation: Address): Hex {
  const e = economics;
  const pool = keccak256(encodeAbiParameters(
    parseAbiParameters('(uint64,uint32,uint32,uint64,uint64,uint32,uint64,uint32,uint32,uint32,uint32,uint32,uint16,uint16), uint8, uint64, bool, uint256'),
    [[e.workFee, e.maxGas, e.overheadGas, e.gasPriceCeiling, e.priorityAllowance, e.restockGas, e.restockFlat, e.baseGas, e.processGas, e.reconcileGas, e.shapeGas, e.prizeGas, e.processGraceBlocks, e.pausedProcessGraceBlocks],
      0, 0n, true, mintFee]));
  return keccak256(encodeAbiParameters(parseAbiParameters('bytes32, uint128, uint96, address'), [pool, bucketCapacity, bucketRefill, implementation]));
}

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
export function matchPlan(dry: ArtifactTx[], sent: ArtifactTx[], implementationOnly = false): string[] {
  const bad: string[] = [];
  const names = dry.map(t => t.contractName);
  if (JSON.stringify(names) !== JSON.stringify(creationOrder(isReuse(dry), implementationOnly).filter(n => names.includes(n) || !LIBRARIES.includes(n)))) bad.push(`reviewed dry run is not the deployment order: ${names}`);
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

export async function verify(pub: PublicClient, dryPath: string, sentPath: string, roles: { deployer: Address; packsAdmin: Address; keeperAdmin: Address; policyAdmin: Address }, deploySource: string, outDir = 'out', existing?: { factory: Address; deploymentBlock: string; snapshot: Record<string, any> }) {
  const c = scriptConstants(deploySource);
  const dry = txs(dryPath), sent = txs(sentPath);
  const bad = matchPlan(dry, sent, !!existing);
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
  const [f, impl] = [existing?.factory ?? at.BalancerFactory, at.PoolBalancer];
  const [packs, renderer] = reuse ? [c.packs, c.renderer] : [at.ShapePacks, at.ShapePackRenderer];
  const head = await pub.getBlockNumber();
  // Reused dependencies are checked at the same block as the record, after every created contract's receipt.
  const reused = reuse ? await checkDependencies(pub, c, head, outDir) : undefined;
  bad.push(...(reused?.bad ?? []));
  const want = INITIAL_SETTINGS.economics;
  const mintFee = await read(c.shapes, 'mintFee') as bigint;
  if (existing) {
    const after = await factorySnapshot(pub, f, head);
    if (JSON.stringify(after) !== JSON.stringify(existing.snapshot)) bad.push('existing factory changed since reviewed snapshot');
  } else {
  await eq('factory', f, 'implementation', impl);
  await eq('factory', f, 'keeperAdmin', roles.keeperAdmin);
  await eq('factory', f, 'policyAdmin', roles.policyAdmin);
  await eq('factory', f, 'keepersRestricted', false);
  for (const fn of ['pendingKeeperAdmin', 'pendingPolicyAdmin']) await eq('factory', f, fn, zeroAddress);
  const economics = await pub.readContract({ address: f, abi: balancerFactoryAbi, functionName: 'economics' });
  for (const [k, v] of Object.entries(want)) if (String(economics[k as keyof typeof economics]).toLowerCase() !== String(v).toLowerCase())
    bad.push(`factory.economics().${k} = ${economics[k as keyof typeof economics]}, expected ${v}`);
  if (Object.keys(economics).length !== Object.keys(want).length) bad.push(`factory.economics() has fields ${Object.keys(economics)}, expected ${Object.keys(want)}`);
  await eq('factory', f, 'defaultBucketCapacity', INITIAL_SETTINGS.bucketCapacity);
  await eq('factory', f, 'defaultBucketRefill', INITIAL_SETTINGS.bucketRefill);
  const limits = await pub.readContract({ address: f, abi: balancerFactoryAbi, functionName: 'productLimits' });
  if (limits.join() !== INITIAL_SETTINGS.productLimits.join()) bad.push(`factory.productLimits() = ${limits}, expected ${INITIAL_SETTINGS.productLimits}`);
  await eq('factory', f, 'creationSettingsHash', creationSettingsHash(want, mintFee, INITIAL_SETTINGS.bucketCapacity, INITIAL_SETTINGS.bucketRefill, impl));
  }
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
      factoryDeploymentBlock: existing?.deploymentBlock ?? deployed.BalancerFactory.block, balancerFactory: f, poolBalancerImplementation: impl, packs, renderer,
      initialSettings: existing ? existing.snapshot : { economics: want, defaultBucketCapacity: INITIAL_SETTINGS.bucketCapacity, defaultBucketRefill: INITIAL_SETTINGS.bucketRefill,
        productLimits: INITIAL_SETTINGS.productLimits, creationSettingsHash: creationSettingsHash(want, mintFee, INITIAL_SETTINGS.bucketCapacity, INITIAL_SETTINGS.bucketRefill, impl), shapesMintFeeWei: mintFee },
      roles, transactions: deployed, preexistingLibraries, reusedDependencies: reused?.dependencies ?? null,
      deploymentGasWei: Object.values(deployed).reduce((s, d) => s + BigInt(d.gasUsed) * BigInt(d.effectiveGasPrice), 0n).toString(),
    },
  };
}

export async function factorySnapshot(pub: PublicClient, factory: Address, blockNumber: bigint) {
  const names = ['implementation', 'keeperAdmin', 'policyAdmin', 'keepersRestricted', 'pendingKeeperAdmin',
    'pendingPolicyAdmin', 'economics', 'defaultBucketCapacity', 'defaultBucketRefill', 'productLimits'] as const;
  const values = await Promise.all(names.map(functionName => pub.readContract({ address: factory,
    abi: balancerFactoryAbi, functionName, blockNumber } as never)));
  return JSON.parse(JSON.stringify(Object.fromEntries(names.map((name, i) => [name, values[i]])),
    (_, v) => typeof v === 'bigint' ? v.toString() : v));
}

/** Checks a separately confirmed pointer update against the already verified deployment and factory snapshot. */
export async function verifyImplementationUpdate(pub: PublicClient, hash: Hex, deployment: any) {
  if (deployment.verified !== true || deployment.transactions?.BalancerFactory) throw new Error('verified implementation-only deployment required');
  const factory = getAddress(deployment.balancerFactory), implementation = getAddress(deployment.poolBalancerImplementation);
  const before = deployment.initialSettings;
  if (await pub.getChainId() !== deployment.chainId) throw new Error('implementation update network differs from verified deployment');
  const [receipt, tx] = await Promise.all([pub.getTransactionReceipt({ hash }), pub.getTransaction({ hash })]);
  if (receipt.status !== 'success' || !tx.to || getAddress(tx.to) !== factory || tx.value !== 0n
    || getAddress(tx.from) !== getAddress(before.policyAdmin)
    || tx.input.toLowerCase() !== encodeFunctionData({ abi: balancerFactoryAbi, functionName: 'setImplementation', args: [implementation] }).toLowerCase())
    throw new Error('pointer update does not match the reviewed factory, implementation, admin and zero value');
  const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash !== receipt.blockHash) throw new Error('pointer update receipt is not canonical');
  if (tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber) throw new Error('setter transaction and receipt differ');
  const changes = receipt.logs.filter(log => getAddress(log.address) === factory).flatMap(log => {
    try {
      const event = decodeEventLog({ abi: balancerFactoryAbi, data: log.data, topics: log.topics });
      return event.eventName === 'ImplementationChanged' ? [event.args] : [];
    } catch { return []; }
  });
  if (changes.length !== 1 || getAddress(changes[0].previousImplementation) !== getAddress(before.implementation)
    || getAddress(changes[0].newImplementation) !== implementation) throw new Error('implementation change event differs from reviewed transition');
  const after = await factorySnapshot(pub, factory, receipt.blockNumber);
  if (JSON.stringify(after) !== JSON.stringify({ ...before, implementation })) throw new Error('factory state differs beyond implementation');
  const current = await pub.getBlock();
  const active = await factorySnapshot(pub, factory, current.number);
  if (JSON.stringify(active) !== JSON.stringify({ ...before, implementation })) throw new Error('implementation or factory settings changed after the setter receipt');
  if ((await pub.getBlock({ blockNumber: current.number })).hash !== current.hash) throw new Error('activation readback block changed');
  return { verified: true, operation: 'implementation-update', chainId: await pub.getChainId(),
    balancerFactory: factory, factoryDeploymentBlock: deployment.factoryDeploymentBlock, previousImplementation: before.implementation,
    poolBalancerImplementation: implementation, activeAtBlock: current.number.toString(), activeAtBlockHash: current.hash, transactionHash: hash, block: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
    gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString(), factoryState: after };
}

async function main(argv: string[]) {
  const arg = (n: string) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
  const rpc = arg('--rpc-url');
  if (arg('--update-tx')) {
    const record = arg('--verified-implementation'), digest = arg('--verified-implementation-sha256');
    if (!rpc || !record || !digest || !arg('--out')) throw new Error('update verification requires RPC, verified implementation record/hash and separate output');
    if (createHash('sha256').update(readFileSync(record)).digest('hex') !== digest) throw new Error('verified implementation record hash differs');
    const update = await verifyImplementationUpdate(createPublicClient({ transport: http(rpc) }) as PublicClient, arg('--update-tx')! as Hex, JSON.parse(readFileSync(record, 'utf8')));
    writeFileSync(arg('--out')!, JSON.stringify(update, null, 2) + '\n');
    console.log('IMPLEMENTATION UPDATE VERIFIED');
    return 0;
  }
  const dry = arg('--reviewed-dry-run'), sent = arg('--broadcast');
  const dryHash = arg('--reviewed-dry-run-sha256');
  if (!rpc || !dry || !sent || !dryHash) { console.error('usage: verify-deployment.ts --rpc-url <url> --reviewed-dry-run <json> --reviewed-dry-run-sha256 <from the approved plan> --broadcast <run-latest.json> [--out <file>]  (env DEPLOYER, PACKS_ADMIN, KEEPER_ADMIN, POLICY_ADMIN)'); return 2; }
  const actual = createHash('sha256').update(readFileSync(dry)).digest('hex');
  if (actual !== dryHash) { console.error(`reviewed dry run ${dry} has SHA-256 ${actual}, not the approved ${dryHash}`); return 1; }
  const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return getAddress(v); };
  const roles = { deployer: env('DEPLOYER'), packsAdmin: env('PACKS_ADMIN'), keeperAdmin: env('KEEPER_ADMIN'), policyAdmin: env('POLICY_ADMIN') };
  const pub = createPublicClient({ transport: http(rpc, { timeout: 60_000 }) }) as PublicClient;
  console.log(JSON.stringify({ rpc }));
  const snapshotPath = arg('--factory-snapshot');
  const snapshot = snapshotPath ? JSON.parse(readFileSync(snapshotPath, 'utf8')) : undefined;
  if (arg('--existing-factory') && (!snapshot || !arg('--factory-deployment-block') || !arg('--out'))) throw new Error('implementation-only verification requires factory snapshot, original deployment block and separate --out');
  const existing = arg('--existing-factory') ? { factory: getAddress(arg('--existing-factory')!), deploymentBlock: arg('--factory-deployment-block')!, snapshot } : undefined;
  const result = await verify(pub, dry, sent, roles, readFileSync('script/Deploy.s.sol', 'utf8'), 'out', existing);
  if (result.bad.length) { console.error('DEPLOYMENT NOT VERIFIED\n' + result.bad.map(b => '  ' + b).join('\n')); return 1; }
  const out = arg('--out') ?? `deployments/${result.record!.chainId}.verified.json`;
  writeFileSync(out, JSON.stringify(result.record, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
  console.log(`DEPLOYMENT VERIFIED: ${out}\n` + JSON.stringify({ factory: result.record!.balancerFactory, factoryDeploymentBlock: result.record!.factoryDeploymentBlock, deploymentGasWei: result.record!.deploymentGasWei }, null, 2));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2)).then(c => process.exit(c), e => { console.error((e as Error).message); process.exit(2); });
