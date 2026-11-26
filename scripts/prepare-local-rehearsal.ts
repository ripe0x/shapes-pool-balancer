// Preparation only: no transaction sender, test client, funding or node mutation API exists here.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, openSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPublicClient, decodeDeployData, getContractAddress, http, keccak256, type Address, type Hex } from 'viem';
import { creationOrder, isReuse, LIBRARIES } from './verify-deployment';

const REVISION = '04bc760d506fd29329a3a819c7f2e4a1480377dd';
const MAINNET = 'https://mainnet.gateway.tenderly.co';
const GAS_LIMIT = 16_777_216n;
const MAX_FEE = 20_000_000_000n;
const ETH = 10n ** 18n;
const ROOT = resolve(import.meta.dirname, '..');
const actors = {
  deployer: '0x000000000000000000000000000000000001e001',
  packsAdmin: '0x000000000000000000000000000000000001e002',
  keeperAdmin: '0x000000000000000000000000000000000001e003',
  policyAdmin: '0x000000000000000000000000000000000001e004',
  creatorA: '0x000000000000000000000000000000000001e005',
  creatorB: '0x000000000000000000000000000000000001e006',
  keeper: '0x000000000000000000000000000000000001e007',
  buyer: '0x000000000000000000000000000000000001e008',
} as const;
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v, 2);
const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const equal = (a: string, b: string) => assert.equal(a.toLowerCase(), b.toLowerCase());
async function freePort() {
  for (let port = 18556; port < 18566; port++) {
    const free = await new Promise<boolean>((done) => {
      const server = createServer();
      server.once('error', () => done(false));
      server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
    });
    if (free) return port;
  }
  throw new Error('No free preparation port 18556..18565; existing services preserved');
}
export function verifyActions(dir: string, options: { implementationOnly?: boolean; startNonce?: number } = {}) {
  const startNonce = options.startNonce ?? 0;
  assert.ok(Number.isSafeInteger(startNonce) && startNonce >= 0);
  type Action = { transactionType: string; contractName: string; contractAddress: Address; transaction: { from: Address; to?: Address; input: Hex; nonce: Hex; gas: Hex; value: Hex } };
  const raw = JSON.parse(readFileSync(join(dir, 'broadcast/Deploy.s.sol/31337/dry-run/run-latest.json'), 'utf8')) as { transactions: Action[]; libraries?: string[] };
  // Full mode creates eight contracts; reuse mode creates no Packs or renderer, and Forge skips a library already on chain.
  const reuse = isReuse(raw.transactions);
  const created = raw.transactions.map(a => a.contractName);
  assert.deepEqual(created, creationOrder(reuse, options.implementationOnly).filter(n => created.includes(n) || !LIBRARIES.includes(n)), 'review linked libraries plus the created deployment contracts');
  const linked = Object.fromEntries((raw.libraries ?? []).map(e => { const [, name, address] = e.split(':'); return [name, address as Address]; }));
  const libraryAddress = (library: string) => (raw.transactions.find(t => t.contractName === library)?.contractAddress ?? linked[library])!;
  let gasReserve = 0n;
  const actions = raw.transactions.map((a, index) => {
    const tx = a.transaction;
    equal(tx.from, actors.deployer);
    assert.equal(BigInt(tx.nonce), BigInt(startNonce + index));
    assert.equal(BigInt(tx.value ?? '0'), 0n);
    const gas = BigInt(tx.gas);
    assert.ok(gas > 0n && gas <= GAS_LIMIT);
    gasReserve += gas * MAX_FEE;
    const artifactPath = `out/${a.contractName}.sol/${a.contractName}.json`;
    const artifact = JSON.parse(readFileSync(join(dir, artifactPath), 'utf8'));
    let initcode = artifact.bytecode.object.slice(2) as string;
    for (const refs of Object.values(artifact.bytecode.linkReferences ?? {}) as any[]) for (const [library, locations] of Object.entries(refs)) {
      const address = libraryAddress(library).slice(2).toLowerCase();
      for (const ref of locations as any[]) { assert.equal(address.length, ref.length * 2); initcode = initcode.slice(0, ref.start * 2) + address + initcode.slice((ref.start + ref.length) * 2); }
    }
    const creationData = a.transactionType === 'CREATE2' ? tx.input.slice(66) : tx.input.slice(2);
    assert.equal(creationData.slice(0, initcode.length).toLowerCase(), initcode.toLowerCase(), 'reviewed creation bytecode matches frozen action');
    let constructorArguments: readonly unknown[] = [];
    if (a.transactionType === 'CREATE') {
      assert.ok(!tx.to);
      equal(a.contractAddress, getContractAddress({ from: actors.deployer, nonce: BigInt(startNonce + index) }));
      // Linked bytecode is supplied in the raw script action; constructor ABI decodes its trailing data.
      const byteLength = (artifact.bytecode.object.length - 2) / 2;
      const linkedBytecode = tx.input.slice(0, 2 + byteLength * 2) as Hex;
      constructorArguments = decodeDeployData({ abi: artifact.abi, bytecode: linkedBytecode, data: tx.input }).args ?? [];
    } else {
      assert.equal(a.transactionType, 'CREATE2');
      equal(tx.to!, '0x4e59b44847b379578588920ca78fbf26c0b4956c');
      const salt = tx.input.slice(0, 66) as Hex;
      const bytecode = `0x${tx.input.slice(66)}` as Hex;
      equal(a.contractAddress, getContractAddress({ opcode: 'CREATE2', from: tx.to!, salt, bytecode }));
    }
    let runtime = artifact.deployedBytecode.object.slice(2) as string;
    const patch = (start: number, length: number, value: string | bigint) => {
      const word = BigInt(value).toString(16).padStart(length * 2, '0');
      assert.equal(word.length, length * 2); runtime = runtime.slice(0, start * 2) + word + runtime.slice((start + length) * 2);
    };
    for (const refs of Object.values(artifact.deployedBytecode.linkReferences ?? {}) as any[]) for (const [library, locations] of Object.entries(refs)) {
      const address = libraryAddress(library);
      for (const ref of locations as any[]) patch(ref.start, ref.length, address);
    }
    const immutable = artifact.deployedBytecode.immutableReferences ?? {};
    const values: Record<string, readonly (string | bigint)[]> = {
      PoolBalancer: [constructorArguments[0], constructorArguments[1], constructorArguments[3], constructorArguments[4], constructorArguments[5]] as string[],
      BalancerFactory: Object.keys(artifact.deployedBytecode.immutableReferences ?? {}).length ? [constructorArguments[0]] as string[] : [],
      ShapePackRenderer: [constructorArguments[0]] as string[],
      ShapePacks: a.contractName === 'ShapePacks' ? [constructorArguments[0] as string, BigInt(String(constructorArguments[5])) * 10n ** 16n] : [],
    };
    const ids = Object.keys(immutable).sort((a,b) => Number(a)-Number(b));
    if (ids.includes('library_deploy_address')) {
      for (const ref of immutable.library_deploy_address) patch(ref.start, ref.length, a.contractAddress);
    } else {
      assert.equal(ids.length, values[a.contractName]?.length ?? 0, 'reviewed immutable declaration mapping');
      ids.forEach((id,i) => { for (const ref of immutable[id]) patch(ref.start, ref.length, values[a.contractName][i]); });
    }
    assert.match(runtime, /^[0-9a-f]+$/i, 'all runtime links and immutables resolved');
    const runtimeCodeHash = keccak256(`0x${runtime}` as Hex);
    assert.ok((artifact.deployedBytecode.object.length - 2) / 2 <= 24_576, 'EIP-170 runtime size');
    return { index, nonce: BigInt(tx.nonce), type: a.transactionType, name: a.contractName, from: tx.from, to: tx.to ?? null, predictedAddress: a.contractAddress, constructorArguments, gasLimit: gas, valueWei: 0n, inputHash: keccak256(tx.input), runtimeCodeHash, runtimeBytes: (artifact.deployedBytecode.object.length - 2) / 2 };
  });
  assert.ok(gasReserve <= ETH, 'deployment reserved gas alone is below batch gas ceiling');
  const at = (name: string) => actions.find(a => a.name === name)!;
  const shapes = '0x6fe9193276bf7abcbee44ab7afd717d637d6faf0';
  if (!reuse) {
    equal(String(at('ShapePackRenderer').constructorArguments[0]), shapes);
    const packs = at('ShapePacks').constructorArguments;
    equal(String(packs[0]), shapes); equal(String(packs[1]), at('ShapePackRenderer').predictedAddress);
    equal(String(packs[2]), actors.packsAdmin);
    assert.deepEqual(packs.slice(3), ['Pool Prize Packs', 'PRIZEPACK', 2n]);
  }
  // Constructor-dependent: the PoolBalancer and BalancerFactory argument positions below follow Deploy.s.sol _deploySystem.
  const impl = at('PoolBalancer').constructorArguments;
  equal(String(impl[0]), '0x8919814D825a5Af238cC04DE06b1C18c9eaA477C');
  equal(String(impl[1]), '0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7');
  equal(String(impl[2]), '0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02');
  equal(String(impl[3]), shapes); equal(String(impl[4]), reuse ? '0xfE11c0E794475fd86801fb3020d779bd7887cB2D' : at('ShapePacks').predictedAddress);
  equal(String(impl[5]), '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e');
  if (!options.implementationOnly) {
  const factory = at('BalancerFactory').constructorArguments;
  const expectedFactory = [at('PoolBalancer').predictedAddress, actors.keeperAdmin, actors.policyAdmin];
  if (factory.length === 4) expectedFactory.push(at('KeeperPolicyV1').predictedAddress);
  assert.equal(factory.length, expectedFactory.length);
  expectedFactory.forEach((value, i) => equal(String(factory[i]), value));
  }
  return { actions, gasReserve, reuse };
}
async function main() {
  assert.equal(process.argv.length, 2, 'no execution/broadcast flags are accepted');
  git('merge-base', '--is-ancestor', REVISION, 'HEAD');
  assert.equal(git('diff', REVISION, '--', 'src', 'script', 'foundry.toml'), '', 'candidate source must remain unchanged');
  const started = new Date().toISOString();
  const dir = mkdtempSync(join(tmpdir(), 'fwa-rehearsal-preparation-04bc760-'));
  const save = (name: string, value: unknown) => writeFileSync(join(dir, name), json(value));
  const chain = createPublicClient({ transport: http(MAINNET), cacheTime: 0 });
  assert.equal(await chain.getChainId(), 1);
  const block = await chain.getBlock();
  const port = await freePort();
  const rpc = `http://127.0.0.1:${port}`;
  const args = ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--accounts', '0', '--fork-url', MAINNET, '--fork-block-number', String(block.number), '--silent'];
  const log = openSync(join(dir, 'anvil.log'), 'a');
  const node = spawn('anvil', args, { detached: true, stdio: ['ignore', log, log] });
  node.unref();
  save('node.json', { pid: node.pid, command: ['anvil', ...args], rpc, started, revision: REVISION, forkBlock: block.number, forkHash: block.hash, baseFeePerGas: block.baseFeePerGas });
  console.log(json({ preparation: dir, rpc, pid: node.pid, forkBlock: block.number }));
  const local = createPublicClient({ transport: http(rpc, { timeout: 60_000 }), cacheTime: 0 });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { await local.getChainId(); ready = true; break; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  assert.ok(ready, 'owned node ready');
  assert.equal(await local.getChainId(), 31337);
  const info = await local.request({ method: 'anvil_nodeInfo' as never }) as unknown as { environment: { chainId: number }; forkConfig: { forkUrl: string; forkBlockNumber: number } };
  assert.equal(info.environment.chainId, 31337);
  assert.equal(info.forkConfig.forkUrl, MAINNET);
  assert.equal(BigInt(info.forkConfig.forkBlockNumber), block.number);
  const before = await local.getBlock();
  assert.equal(before.hash, block.hash);
  const fresh = [];
  for (const [role, address] of Object.entries(actors)) {
    const [code, nonce, balance] = await Promise.all([local.getCode({ address }), local.getTransactionCount({ address }), local.getBalance({ address })]);
    assert.ok(!code || code === '0x', `${role}: code-free`);
    assert.equal(nonce, 0, `${role}: fresh nonce`);
    assert.equal(balance, 0n, `${role}: unfunded`);
    fresh.push({ role, address, code: code ?? '0x', nonce, balance });
  }
  save('preflight.json', { nodeInfo: info, block: { number: before.number, hash: before.hash, timestamp: before.timestamp, baseFeePerGas: before.baseFeePerGas }, actors: fresh });
  // Isolate all Forge-generated deployment and broadcast files; never copy .env or existing receipts.
  for (const name of ['src', 'script', 'out', 'cache']) cpSync(join(ROOT, name), join(dir, name), { recursive: true });
  cpSync(join(ROOT, 'foundry.toml'), join(dir, 'foundry.toml'));
  symlinkSync(join(ROOT, 'lib'), join(dir, 'lib'));
  const forgeArgs = ['script', 'script/Deploy.s.sol', '--rpc-url', rpc, '--unlocked', '--sender', actors.deployer, '--with-gas-price', String(MAX_FEE), '--slow'];
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, PACKS_ADMIN: actors.packsAdmin, KEEPER_ADMIN: actors.keeperAdmin, POLICY_ADMIN: actors.policyAdmin };
  save('command.json', { command: ['forge', ...forgeArgs], environment: { PACKS_ADMIN: env.PACKS_ADMIN, KEEPER_ADMIN: env.KEEPER_ADMIN, POLICY_ADMIN: env.POLICY_ADMIN }, cwd: dir, broadcast: false });
  const compileStart = Date.now();
  try {
    const result = execFileSync('forge', forgeArgs, { cwd: dir, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    writeFileSync(join(dir, 'deploy-simulation.log'), result);
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    writeFileSync(join(dir, 'deploy-simulation-failed.log'), String(e.stdout ?? '') + String(e.stderr ?? ''));
    save('failure.json', { phase: 'deployment simulation', exitStatus: e.status, elapsedMs: Date.now() - compileStart });
    throw error;
  }
  const simulationMs = Date.now() - compileStart;
  const { actions, gasReserve } = verifyActions(dir);
  const after = await local.getBlock();
  assert.equal(after.hash, before.hash, 'simulation did not mine');
  for (const address of Object.values(actors)) {
    assert.equal(await local.getBalance({ address }), 0n);
    assert.equal(await local.getTransactionCount({ address }), 0);
  }
  for (const a of actions) assert.ok(!(await local.getCode({ address: a.predictedAddress })), 'no deployment written to node');
  const evidence = { revision: REVISION, rpc, forkBlock: block.number, forkHash: block.hash, started, completed: new Date().toISOString(), simulationMs, commandExitStatus: 0, beforeHash: before.hash, afterHash: after.hash, broadcast: false, mutationCount: 0, actors, caps: { pools: 2, initialPoolDepositsWei: 6n * ETH, rounds: 50, draws: 252, totalGasWei: ETH, perTransactionGas: GAS_LIMIT, maxFeePerGas: MAX_FEE }, deploymentGasReserveWei: gasReserve, actions };
  save('deployment-actions.json', evidence);
  console.log(json(evidence));
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
if (process.argv[2] === '--check' && process.argv.length === 4) {
  const result = verifyActions(resolve(process.argv[3]));
  console.log(json({ checkedExistingSimulation: true, directory: resolve(process.argv[3]), ...result }));
} else {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

}
