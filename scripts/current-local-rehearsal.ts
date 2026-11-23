// Current-candidate local rehearsal. Preparation/preflight never fund, unlock, mine or broadcast.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createTestClient, createWalletClient, decodeFunctionData, encodeFunctionData, decodeErrorResult, getContractAddress, http, keccak256, TransactionReceiptNotFoundError, WaitForTransactionReceiptTimeoutError, type Address, type Hash, type Hex } from 'viem';
import { verifyActions } from './prepare-local-rehearsal';
import { recoverCreation, canRetryCreation, type CreationAttempt } from '../app/src/creation';
import { Keeper, MAX_TRANSACTION_GAS } from '../keeper/keeper';
import { balancerFactoryAbi, erc721Abi, poolBalancerAbi } from '../shared/abi';
export const ROOT = realpathSync(resolve(import.meta.dirname, '..'));
export const MAINNET = 'https://mainnet.gateway.tenderly.co';
const ETH = 10n ** 18n;
export const ROLES = Object.fromEntries(['deployer', 'packsAdmin', 'keeperAdmin', 'policyAdmin', 'creatorA', 'creatorB', 'keeper', 'buyer'].map((name, i) => [name, `0x${(0x1e001 + i).toString(16).padStart(40, '0')}`])) as Record<string, Address>;
export const FUNDING = { deployer: ETH, packsAdmin: ETH / 100n, keeperAdmin: ETH / 100n, policyAdmin: ETH / 100n, creatorA: 17n * ETH / 10n, creatorB: 7n * ETH / 10n, keeper: ETH / 5n, buyer: 5n * ETH };
export const CAPS = { deposits: 2n * ETH, gas: ETH, buyer: 5n * ETH, edge: ETH, vrf: ETH, draws: 160, rounds: 50, replacementCuratedNfts: 8 };
export const SCENARIO = { targets: [String(20n + (1n << 64n)), String(17n + (3n << 144n))], initialDeposits: [String(15n * ETH / 10n), String(ETH / 2n)], markupBps: 1500, creatorRevenueBps: 400, curatedValues: [String(ETH / 4n), String(ETH / 2n)], curatedRequired: [true, false], curatedPerPool: [2, 0], oracle: 'controlled real-service callbacks selecting small prizes, then the explicit one-ETH prize', timeJumpSeconds: 172801, maximumTimeJumps: 1, maximumMinedBlocks: 1000, closeoutGasReserveWei: String(ETH / 10n), curatedProofRecovery: { round: 0, pool: 0, callerRole: 'buyer', maximumRefreshes: 1, resumedDraws: 1 }, creationReceiptProbe: { creatorRole: 'creatorA', salt: `0x${'00'.repeat(31)}01`, creatorRevenueBps: 10001, valueWei: '0', gasLimit: '5000000', expectedReceipt: 'reverted' } };
const PREFIX = 'docs/receipts/current-rehearsal/';
const INPUTS = ['src', 'script', 'keeper', 'shared', 'app', 'scripts', 'test', 'foundry.toml', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', '.gitmodules', '.gitignore', 'asset-flow.json', 'OWNER-REQUIREMENTS.md', 'README.md', 'docs/SPEC.md', 'docs/OPERATIONS.md', 'docs/KEEPER-POLICIES.md', 'docs/RESERVES.md'];
const SYSTEM_NAMES = ['KeeperPolicyCalls', 'PoolPage', 'PoolInventory', 'ShapePackRenderer', 'ShapePacks', 'PoolBalancer', 'KeeperPolicyV1', 'BalancerFactory'];
export const ARTIFACTS = [...SYSTEM_NAMES.map(n => `out/${n}.sol/${n}.json`), 'out/DevSetup.s.sol/DemoNFT.json', 'out/Settings.t.sol/KeeperPolicyV2.json'];
export const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v, 2);
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const gitAt = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const git = (...args: string[]) => gitAt(ROOT, ...args);
const eq = (a: string, b: string) => assert.equal(a.toLowerCase(), b.toLowerCase());
function files(root = ROOT) { return gitAt(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...INPUTS).split('\0').filter(Boolean).filter(p => !p.split('/').some(v => /^\.env($|\.)/.test(v))).sort(); }
export function manifest(root = ROOT) { return files(root).map(path => { assert.ok(statSync(join(root, path)).isFile(), `ordinary frozen input ${path}`); return { path, sha256: digest(readFileSync(join(root, path))) }; }); }
export function dependencyState(root = ROOT) { gitAt(root, 'submodule', 'foreach', '--recursive', 'git diff --quiet && git diff --cached --quiet'); return gitAt(root, 'submodule', 'status', '--recursive').split('\n').map(s => { assert.ok(!/^[+\-U]/.test(s), 'initialized pinned submodules'); return s.trim(); }); }
const DEPENDENCY_SOURCE_ROOTS = ['lib/forge-std/src/', 'lib/solady/src/', 'lib/shape-packs/src/', 'lib/shape-packs/lib/shapes/src/', 'lib/shape-packs/lib/shapes/lib/openzeppelin-contracts/contracts/'];
function dependencySourcePaths(p: any) {
    return p.dependencies.flatMap((state: string) => {
        const match = state.match(/^[0-9a-f]{40} ([^ ]+)/); assert.ok(match, 'pinned dependency path');
        const base = match[1];
        return gitAt(p.repositoryRoot, '-C', base, 'ls-files', '--cached', '-z').split('\0').filter(Boolean).map(path => `${base}/${path}`);
    }).filter((path: string) => path.endsWith('.sol') && DEPENDENCY_SOURCE_ROOTS.some(prefix => path.startsWith(prefix))).sort() as string[];
}
export function assertStagedDependencies(p: any, dir: string) {
    const paths = dependencySourcePaths(p); assert.ok(paths.length > 0);
    for (const path of paths) {
        assert.ok(lstatSync(join(dir, path)).isFile(), `ordinary staged dependency source ${path}`);
        assert.equal(digest(readFileSync(join(dir, path))), digest(readFileSync(join(p.repositoryRoot, path))), `staged pinned dependency source ${path}`);
    }
    return paths;
}
function copySource(source: string, destination: string) {
    const info = statSync(source);
    cpSync(source, destination, { preserveTimestamps: true });
    // cpSync rounds through Date on this filesystem; retain fractional milliseconds used by Forge's cache.
    utimesSync(destination, info.atimeMs / 1000, info.mtimeMs / 1000);
}
export function copyStagedDependencies(p: any, dir: string) {
    // Only tracked Solidity inputs are needed; Git metadata, tests, secrets and build outputs stay outside the stage.
    for (const path of dependencySourcePaths(p)) {
        assert.ok(lstatSync(join(p.repositoryRoot, path)).isFile());
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        copySource(join(p.repositoryRoot, path), join(dir, path));
    }
    return assertStagedDependencies(p, dir);
}
export function runtimeState() {
    const forge = execFileSync('which', ['forge'], { encoding: 'utf8' }).trim();
    const binaries = [process.execPath, forge, execFileSync('which', ['anvil'], { encoding: 'utf8' }).trim(), join(homedir(), '.svm', '0.8.28', 'solc-0.8.28')];
    if (basename(realpathSync(forge)) === 'agent-guard') {
        // The installed guard skips its own directory before dispatch. Hash its target without invoking or bypassing it.
        const guardDirectory = realpathSync(dirname(forge));
        const delegated = execFileSync('which', ['-a', 'forge'], { encoding: 'utf8' }).trim().split('\n').find(path => realpathSync(dirname(path)) !== guardDirectory);
        assert.ok(delegated, 'guarded Forge has an identifiable delegated executable');
        binaries.push(delegated);
    }
    return { node: process.version, binaries: binaries.map(path => ({ path: realpathSync(path), sha256: digest(readFileSync(path)) })), installedLock: digest(readFileSync(join(ROOT, 'node_modules/.package-lock.json'))) };
}
export function sourceCheck(p: any, executedRoot = ROOT) {
    assert.deepEqual(manifest(p.repositoryRoot), p.inputs, 'current runtime/build/app/driver inputs changed');
    assert.equal(digest(json(p.inputs)), p.sourceFingerprint);
    assert.deepEqual(dependencyState(p.repositoryRoot), p.dependencies, 'dependency revisions changed');
    if (realpathSync(executedRoot) !== p.repositoryRoot) assertStagedDependencies(p, executedRoot);
    assert.deepEqual(runtimeState(), p.runtime, 'runtime binaries or installed dependency lock changed');
    for (const i of p.inputs)
        assert.equal(digest(readFileSync(join(executedRoot, i.path))), i.sha256, `executed frozen input ${i.path}`);
    for (const [path, hash] of Object.entries(p.artifacts))
        assert.equal(digest(readFileSync(join(executedRoot, path))), hash, `frozen artifact ${path}`);
    gitAt(p.repositoryRoot, 'merge-base', '--is-ancestor', p.revision, 'HEAD');
}
export function forgeArguments(p: any) { return ['--rpc-url', p.rpc, '--unlocked', '--sender', p.roles.deployer, '--with-gas-price', p.maxFeePerGas, '--priority-gas-price', p.maxPriorityFeePerGas, '--slow', '--broadcast']; }
export function validateCurrentBounds(p: any) {
    assert.equal(p.schema, 'protected-revenue-local-rehearsal-v1');
    assert.equal(realpathSync(p.repositoryRoot), p.repositoryRoot);
    assert.equal(p.chainId, 31337);
    assert.match(p.rpc, /^http:\/\/127\.0\.0\.1:187(?:8[6-9]|9[0-5])$/);
    assert.equal(p.upstream, MAINNET);
    assert.match(p.revision, /^[0-9a-f]{40}$/);
    assert.deepEqual(p.roles, ROLES);
    assert.deepEqual(p.funding, JSON.parse(json(FUNDING)));
    assert.deepEqual(p.caps, JSON.parse(json(CAPS)));
    assert.deepEqual(p.scenario, SCENARIO);
    assert.equal(p.maxFeePerGas, '20000000000');
    assert.equal(p.maxPriorityFeePerGas, '50000000');
    assert.equal(p.perTransactionGas, String(MAX_TRANSACTION_GAS));
    assert.ok(p.evidenceDirectory.startsWith(`${p.repositoryRoot}/${PREFIX}`));
    assert.equal(resolve(p.evidenceDirectory), p.evidenceDirectory);
    assert.equal(dirname(p.planFile), p.evidenceDirectory);
    assert.equal(basename(p.planFile), 'bounded-plan.json');
    assert.deepEqual(Object.keys(p.artifacts), ARTIFACTS);
    assert.deepEqual(p.forgeArguments, forgeArguments(p));
    assert.ok(p.deployment.reduce((n: bigint, a: any) => n + BigInt(a.gasLimit) * BigInt(p.maxFeePerGas), 0n) + BigInt(SCENARIO.closeoutGasReserveWei) <= CAPS.gas, 'deployment reserves fit shared gas cap');
    assert.equal(p.deployment.length, 8);
    assert.deepEqual(p.deployment.map((a: any) => a.name), SYSTEM_NAMES);
}
export function validateCurrentPlan(packet: any, approved: string, executedRoot = ROOT) {
    const p = packet.plan;
    assert.match(approved, /^[0-9a-f]{64}$/);
    assert.equal(packet.planHash, approved, 'exact reviewed current plan hash');
    assert.equal(digest(json(p)), approved, 'exact frozen current plan content');
    validateCurrentBounds(p);
    const prepared = JSON.parse(readFileSync(join(p.evidenceDirectory, 'deployment-actions.json'), 'utf8'));
    assert.deepEqual(p.deployment, prepared.actions);
    assert.equal(digest(json(prepared)), p.preparationHash);
    const rawPath = join(p.simulationRoot, 'broadcast/Deploy.s.sol/31337/dry-run/run-latest.json');
    assert.equal(digest(readFileSync(rawPath)), p.simulationHash, 'exact read-only deployment simulation');
    for (const [path, hash] of Object.entries(p.artifacts))
        assert.equal(digest(readFileSync(join(p.simulationRoot, path))), hash, 'simulation used exact frozen artifact');
    assert.deepEqual(JSON.parse(json(verifyActions(p.simulationRoot).actions)), p.deployment, 'independently decode source-bound deployment actions');
    sourceCheck(p, executedRoot);
    return p;
}
export function validateCurrentForgeArguments(p: any, args: string[]) { assert.deepEqual(args, forgeArguments(p), 'only exact local deployment arguments'); }
function ownership(p: any) {
    const n = p.node;
    const port = new URL(p.rpc).port;
    assert.ok(Number.isSafeInteger(n.pid) && n.pid > 0);
    const expected = ['anvil', '--host', '127.0.0.1', '--port', port, '--chain-id', '31337', '--accounts', '0', '--fork-url', MAINNET, '--fork-block-number', p.forkBlock, '--silent'];
    assert.deepEqual(n.command, expected);
    const listeners = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' }).split('\n').filter(s => s.startsWith('p'));
    assert.deepEqual(listeners, [`p${n.pid}`], 'exact task-owned listener, never a proxy');
    const command = execFileSync('ps', ['-p', String(n.pid), '-o', 'command='], { encoding: 'utf8' }).trim().split(/\s+/);
    assert.equal(basename(command[0]), 'anvil');
    assert.deepEqual(command.slice(1), expected.slice(1));
}
export async function currentPreflight(p: any, phase: 'prepare' | 'deploy') {
    ownership(p);
    const pub = createPublicClient({ transport: http(p.rpc, { retryCount: 0, timeout: 15000 }), cacheTime: 0 });
    assert.equal(await pub.getChainId(), 31337);
    const info = await pub.request({ method: 'anvil_nodeInfo' as never }) as any;
    assert.equal(info.forkConfig.forkUrl, MAINNET);
    assert.equal(String(info.forkConfig.forkBlockNumber), p.forkBlock);
    const block = await pub.getBlock();
    assert.equal(String(block.number), p.forkBlock);
    assert.equal(block.hash, p.forkHash, 'fresh untouched node before deployment');
    for (const [role, address] of Object.entries(p.roles)) {
        const a = address as Address;
        assert.ok(!await pub.getCode({ address: a }));
        assert.equal(await pub.getTransactionCount({ address: a, blockTag: 'pending' }), 0);
        assert.equal(await pub.getBalance({ address: a }), phase === 'prepare' ? 0n : BigInt(p.funding[role]));
    }
    for (const a of p.deployment)
        assert.ok(!await pub.getCode({ address: a.predictedAddress }));
    ownership(p);
    return { phase, rpc: p.rpc, chainId: 31337, pid: p.node.pid, block: p.forkBlock, hash: p.forkHash, transactionsSent: 0, productionApproval: false };
}
async function freePort() { for (let port = 18786; port <= 18795; port++) {
    const free = await new Promise<boolean>(done => { const s = createServer(); s.once('error', () => done(false)); s.listen(port, '127.0.0.1', () => s.close(() => done(true))); });
    if (free)
        return port;
} throw Error('fresh current rehearsal ports busy; preserve existing services'); }
function stage(p: any) {
    const dir = mkdtempSync(join(tmpdir(), 'fwa-current-rehearsal-stage-'));
    for (const i of p.inputs) {
        mkdirSync(dirname(join(dir, i.path)), { recursive: true });
        copySource(join(ROOT, i.path), join(dir, i.path));
    }
    for (const name of ['out', 'cache'])
        cpSync(join(ROOT, name), join(dir, name), { recursive: true, preserveTimestamps: true });
    copyStagedDependencies(p, dir);
    symlinkSync(realpathSync(join(ROOT, 'node_modules')), join(dir, 'node_modules'));
    sourceCheck(p, dir);
    return dir;
}
export async function prepareCurrentPlan() {
    assert.equal(process.argv.length, 3, 'prepare accepts no endpoint, signer or budget overrides');
    const chain = createPublicClient({ transport: http(MAINNET, { timeout: 60000 }), cacheTime: 0 });
    assert.equal(await chain.getChainId(), 1);
    const block = await chain.getBlock();
    const mintFee = await chain.readContract({ address: '0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0', abi: [{ type: 'function', name: 'mintFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }], functionName: 'mintFee', blockNumber: block.number });
    const port = await freePort();
    const revision = git('rev-parse', 'HEAD'), inputs = manifest();
    const evidenceDirectory = join(ROOT, PREFIX, `${new Date().toISOString().replace(/[^0-9]/g, '')}-${revision.slice(0, 7)}`);
    mkdirSync(evidenceDirectory, { recursive: true });
    const command = ['anvil', '--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--accounts', '0', '--fork-url', MAINNET, '--fork-block-number', String(block.number), '--silent'];
    const log = openSync(join(evidenceDirectory, 'anvil.log'), 'a');
    const child = spawn(command[0], command.slice(1), { detached: true, stdio: ['ignore', log, log] });
    child.unref();
    const p: any = { schema: 'protected-revenue-local-rehearsal-v1', repositoryRoot: ROOT, revision, inputs, sourceFingerprint: digest(json(inputs)), dependencies: dependencyState(), runtime: runtimeState(), artifacts: Object.fromEntries(ARTIFACTS.map(path => [path, digest(readFileSync(join(ROOT, path)))])), evidenceDirectory, planFile: join(evidenceDirectory, 'bounded-plan.json'), rpc: `http://127.0.0.1:${port}`, chainId: 31337, upstream: MAINNET, forkBlock: String(block.number), forkHash: block.hash, parameters: { mintFeeWei: String(mintFee) }, node: { pid: child.pid, command }, roles: ROLES, funding: JSON.parse(json(FUNDING)), caps: JSON.parse(json(CAPS)), scenario: SCENARIO, maxFeePerGas: '20000000000', maxPriorityFeePerGas: '50000000', perTransactionGas: String(MAX_TRANSACTION_GAS) };
    const local = createPublicClient({ transport: http(p.rpc, { timeout: 1000, retryCount: 0 }), cacheTime: 0 });
    let ready = false;
    for (let n = 0; n < 120; n++) {
        try {
            await local.getChainId();
            ready = true;
            break;
        }
        catch {
            await new Promise(r => setTimeout(r, 250));
        }
    }
    assert.ok(ready);
    p.forgeArguments = forgeArguments(p);
    const scratch = stage(p);
    const args = ['script', 'script/Deploy.s.sol', ...p.forgeArguments.filter((a: string) => a !== '--broadcast')];
    const output = execFileSync('forge', args, { cwd: scratch, env: { PATH: process.env.PATH, HOME: process.env.HOME, PACKS_ADMIN: ROLES.packsAdmin, KEEPER_ADMIN: ROLES.keeperAdmin, POLICY_ADMIN: ROLES.policyAdmin }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(join(evidenceDirectory, 'deployment-simulation.log'), output);
    p.simulationRoot = scratch;
    p.simulationHash = digest(readFileSync(join(scratch, 'broadcast/Deploy.s.sol/31337/dry-run/run-latest.json')));
    const result = verifyActions(scratch);
    p.deployment = JSON.parse(json(result.actions));
    const preparation = { revision, rpc: p.rpc, forkBlock: p.forkBlock, forkHash: p.forkHash, actors: ROLES, actions: p.deployment, deploymentGasReserveWei: String(result.gasReserve), broadcast: false, mutationCount: 0 };
    writeFileSync(join(evidenceDirectory, 'deployment-actions.json'), json(preparation));
    p.preparationHash = digest(json(preparation));
    assert.ok(result.gasReserve + ETH / 10n < BigInt(p.caps.gas));
    const packet = { planHash: digest(json(p)), plan: p };
    writeFileSync(p.planFile, json(packet));
    validateCurrentPlan(packet, packet.planHash);
    const preflight = await currentPreflight(p, 'prepare');
    writeFileSync(join(evidenceDirectory, 'preflight.json'), json(preflight));
    console.log(json({ planFile: p.planFile, planHash: packet.planHash, sourceFingerprint: p.sourceFingerprint, preflight, authority: 'new explicit fresh-local request; no historical approval or production signature is inherited', actions: p.deployment, caps: p.caps, scenario: p.scenario }));
    return packet;
}
export class CurrentRehearsal {
    readonly pub;
    private readonly test;
    private readonly wallet;
    readonly plan: any;
    readonly roles = ROLES;
    readonly factory: Address;
    readonly v1: Address;
    readonly directory: string;
    readonly journal: any;
    keeper!: Keeper;
    private stress: bigint | undefined;
    private closing = false;
    constructor(readonly packet: any) {
        this.plan = validateCurrentPlan(packet, packet.planHash);
        this.directory = this.plan.evidenceDirectory;
        this.pub = createPublicClient({ transport: http(this.plan.rpc, { timeout: 60000, retryCount: 0 }), cacheTime: 0 });
        this.test = createTestClient({ mode: 'anvil', transport: http(this.plan.rpc, { timeout: 60000, retryCount: 0 }) });
        this.wallet = createWalletClient({ transport: http(this.plan.rpc, { timeout: 60000, retryCount: 0 }) });
        this.factory = this.plan.deployment.find((a: any) => a.name === 'BalancerFactory').predictedAddress;
        this.v1 = this.plan.deployment.find((a: any) => a.name === 'KeeperPolicyV1').predictedAddress;
        assert.ok(!existsSync(join(this.directory, 'journal.json')), 'fresh one-shot batch; reconcile interrupted journal instead of replaying');
        this.journal = { planHash: packet.planHash, sourceFingerprint: this.plan.sourceFingerprint, receipts: [], mutations: [], pools: [], draws: [], reports: [], contributions: [], spent: { deposits: '0', buyer: '0', edge: '0', vrf: '0' }, nonces: Object.fromEntries(Object.values(ROLES).map(a => [a.toLowerCase(), 0])), funded: {}, checkedBlock: this.plan.forkBlock, checkedHash: this.plan.forkHash, inFlight: null, completed: false };
        this.save();
    }
    save() { const path = join(this.directory, 'journal.json'); writeFileSync(`${path}.tmp`, json(this.journal)); renameSync(`${path}.tmp`, path); }
    report(value: unknown) { this.journal.reports.push(value); this.save(); }
    gas() { return this.journal.receipts.reduce((n: bigint, r: any) => n + BigInt(r.gasWei), 0n); }
    async read<T>(address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = [], options: Record<string, unknown> = {}): Promise<T> { return this.pub.readContract({ address, abi, functionName, args, ...options } as never) as Promise<T>; }
    async check() {
        sourceCheck(this.plan);
        ownership(this.plan);
        assert.equal(await this.pub.getChainId(), 31337);
        const info = await this.pub.request({ method: 'anvil_nodeInfo' as never }) as any;
        assert.equal(info.forkConfig.forkUrl, MAINNET);
        assert.equal(String(info.forkConfig.forkBlockNumber), this.plan.forkBlock);
        assert.equal((await this.pub.getBlock({ blockNumber: BigInt(this.journal.checkedBlock) })).hash, this.journal.checkedHash, 'no reorg or unknown actor transaction');
        const tip = await this.pub.getBlockNumber();
        const known = new Set(this.journal.receipts.map((r: any) => r.hash));
        for (let n = BigInt(this.journal.checkedBlock) + 1n; n <= tip; n++) {
            const b = await this.pub.getBlock({ blockNumber: n, includeTransactions: true });
            for (const tx of b.transactions) {
                assert.ok(typeof tx !== 'string');
                assert.ok(known.has(tx.hash), 'unreviewed transaction on owned node');
            }
            this.journal.checkedBlock = String(n);
            this.journal.checkedHash = b.hash;
        }
        this.save();
    }
    private budget(gas: bigint, price: bigint) {
        assert.ok(price <= BigInt(this.plan.maxFeePerGas), 'per-transaction fee ceiling before node mutation or submission');
        assert.ok(this.gas() + gas * price + (this.closing ? 0n : BigInt(SCENARIO.closeoutGasReserveWei)) <= CAPS.gas, 'shared gas ceiling and retained closeout reserve');
    }
    private async mutation(label: string, action: () => Promise<unknown>) { await this.check(); assert.equal(this.journal.inFlight, null); this.journal.inFlight = { mutation: label }; this.save(); await action(); this.journal.mutations.push(label); this.journal.inFlight = null; this.save(); }
    async basefee(value: bigint | undefined) { this.stress = value; if (value !== undefined) {
        await this.mutation(`pin next basefee ${value}`, () => this.test.setNextBlockBaseFeePerGas({ baseFeePerGas: value }));
        await this.mine(1);
    } }
    private async hold() { if (this.stress !== undefined)
        await this.mutation(`pin next inclusion basefee ${this.stress}`, () => this.test.setNextBlockBaseFeePerGas({ baseFeePerGas: this.stress! })); }
    async mine(count = 1) { assert.ok(this.journal.mutations.filter((s: string) => s === 'mine timing block').length + count <= SCENARIO.maximumMinedBlocks); for (let n = 0; n < count; n++) {
        await this.hold();
        await this.mutation('mine timing block', () => this.test.mine({ blocks: 1 }));
    } }
    async jump() { assert.equal(this.journal.mutations.filter((s: string) => s === 'one approved policy delay').length, 0); await this.mutation('one approved policy delay', () => this.test.increaseTime({ seconds: SCENARIO.timeJumpSeconds })); await this.mine(); }
    async coordinator(address: Address) { assert.ok(await this.pub.getBalance({ address }) > 0n, 'existing coordinator pays its own exception gas'); this.journal.coordinator = address; this.journal.nonces[address.toLowerCase()] = await this.pub.getTransactionCount({ address, blockTag: 'pending' }); this.save(); await this.mutation('unlock real coordinator only; no funding or protocol storage changes', () => this.test.impersonateAccount({ address })); }
    private permitted(actor: Address, to: Address | undefined, fn: string, args: readonly unknown[], value: bigint) {
        const role = Object.keys(ROLES).find(k => ROLES[k].toLowerCase() === actor.toLowerCase());
        if (!to) {
            assert.ok(fn === 'DemoNFT' && (role === 'creatorA' || role === 'creatorB') || fn === 'KeeperPolicyV2' && role === 'deployer');
            assert.equal(value, 0n);
            return;
        }
        const pool = this.journal.pools.find((p: any) => p.balancer.toLowerCase() === to.toLowerCase());
        if (pool) {
            assert.equal(value, 0n);
            if (fn === 'performUpkeep')
                eq(actor, ROLES.keeper);
            else if (fn === 'refreshCuratedWitness') {
                eq(actor, ROLES[SCENARIO.curatedProofRecovery.callerRole]);
                assert.equal(pool, this.journal.pools[SCENARIO.curatedProofRecovery.pool]);
                assert.equal(args.length, 1);
                assert.ok(typeof args[0] === 'bigint' && args[0] > 0n, 'one positive listing ID');
                assert.ok(this.journal.receipts.filter((r: any) => r.function === fn).length < SCENARIO.curatedProofRecovery.maximumRefreshes, 'one planned caller-paid proof refresh');
            }
            else {
                eq(actor, pool.creator);
                assert.ok(['collectProceeds', 'configure', 'listCuratedBatch', 'updateCuratedPrice', 'open', 'close', 'retire', 'withdrawCurated', 'unlistShapes', 'claimSurplus', 'setKeeperPolicy', 'setPaidUpkeepEnabled', 'setCreatorRevenueBps', 'performUpkeepUnpaid'].includes(fn));
            }
            return;
        }
        const fwaPool = this.journal.pools.find((p: any) => p.pool?.toLowerCase() === to.toLowerCase());
        if (fwaPool) {
            eq(actor, ROLES.buyer);
            assert.ok(fn === 'acquireBatch' || fn === 'withdrawAcquisitionRefund');
            if (fn === 'acquireBatch')
                assert.ok(BigInt(this.journal.spent.buyer) + value <= CAPS.buyer);
            return;
        }
        if (to.toLowerCase() === this.factory.toLowerCase()) {
            assert.equal(fn, 'createBalancer');
            assert.ok(role === 'creatorA' || role === 'creatorB');
            const index = role === 'creatorA' ? 0 : 1;
            assert.equal(value, BigInt(SCENARIO.initialDeposits[index]));
            assert.ok(BigInt(this.journal.spent.deposits) + value <= CAPS.deposits);
            assert.equal(String((args[1] as any).target), SCENARIO.targets[index]);
            assert.equal((args[1] as any).creatorRevenueBps, SCENARIO.creatorRevenueBps);
            assert.equal((args[1] as any).curatedRequired, SCENARIO.curatedRequired[index]);
            assert.equal((args[2] as unknown[]).length, SCENARIO.curatedPerPool[index]);
            return;
        }
        const demo = this.journal.pools.find((p: any) => p.demo.toLowerCase() === to.toLowerCase());
        if (demo) {
            eq(actor, demo.creator);
            assert.equal(value, 0n);
            assert.ok(fn === 'mint' || fn === 'approve');
            return;
        }
        eq(to, '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d');
        assert.equal(value, 0n);
        assert.ok(fn === 'rawFulfillRandomWords' || fn === 'deliverRandomness');
        eq(actor, fn === 'rawFulfillRandomWords' ? this.journal.coordinator : ROLES.buyer);
    }
    private async waitForReceipt(hash: Hash) {
        const deadline = Date.now() + 60000;
        // An idle automining fork may index its receipt without producing another block notification.
        while (Date.now() < deadline) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                return await Promise.race([
                    this.pub.getTransactionReceipt({ hash }),
                    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WaitForTransactionReceiptTimeoutError({ hash })), deadline - Date.now()); }),
                ]);
            } catch (error) {
                if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
            } finally {
                clearTimeout(timer);
            }
            await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
        }
        throw new WaitForTransactionReceiptTimeoutError({ hash });
    }
    private async record(hash: Hash, actor: Address, nonce: number, input: Hex, value: bigint, to: Address | undefined, fn: string, category: string, gas: bigint, expectedStatus: 'success' | 'reverted' = 'success') {
        const receipt = await this.waitForReceipt(hash);
        const [tx, block] = await Promise.all([this.pub.getTransaction({ hash }), this.pub.getBlock({ blockNumber: receipt.blockNumber })]);
        if (this.journal.inFlight) {
            this.journal.inFlight.observedReceipt = { ...receipt, transaction: tx, basefee: block.baseFeePerGas };
            this.save();
        }
        eq(tx.from, actor);
        assert.equal(tx.nonce, nonce);
        assert.equal(tx.input, input);
        assert.equal(tx.value, value);
        assert.equal(tx.gas, gas);
        if (to)
            eq(tx.to!, to);
        else
            assert.equal(tx.to, null);
        assert.equal(receipt.blockHash, block.hash);
        assert.equal(receipt.status, expectedStatus, `unexpected ${fn} receipt remains in journal`);
        assert.ok(receipt.effectiveGasPrice <= BigInt(this.plan.maxFeePerGas));
        if (this.stress !== undefined)
            assert.equal(block.baseFeePerGas, this.stress);
        assert.ok(!this.journal.receipts.some((r: any) => r.hash === hash));
        this.journal.receipts.push({ hash, actor, nonce, to: to ?? null, function: fn, category, input, inputHash: keccak256(input), valueWei: String(value), gasLimit: String(gas), gasUsed: String(receipt.gasUsed), gasPrice: String(receipt.effectiveGasPrice), basefee: String(block.baseFeePerGas), gasWei: String(receipt.gasUsed * receipt.effectiveGasPrice), block: String(receipt.blockNumber), blockHash: receipt.blockHash, status: receipt.status });
        this.journal.nonces[actor.toLowerCase()] = nonce + 1;
        this.save();
        return receipt;
    }
    async send(actor: Address, address: Address, abi: readonly unknown[], fn: string, args: unknown[] = [], value = 0n, category = 'creator', gasHint?: bigint, original?: ((p: any) => Promise<Hash>), keeperRequest?: any) {
        const data = encodeFunctionData({ abi, functionName: fn, args } as never);
        const decoded = decodeFunctionData({ abi, data } as never);
        assert.equal(decoded.functionName, fn);
        this.permitted(actor, address, fn, args, value);
        await this.check();
        assert.equal(this.journal.inFlight, null);
        await this.hold();
        const block = await this.pub.getBlock();
        const base = this.stress ?? block.baseFeePerGas ?? 0n;
        const price = base * 2n + 50000000n;
        assert.ok(price <= BigInt(this.plan.maxFeePerGas));
        const fees = original ? { maxFeePerGas: BigInt(keeperRequest.maxFeePerGas), maxPriorityFeePerGas: BigInt(keeperRequest.maxPriorityFeePerGas) } : { maxFeePerGas: price, maxPriorityFeePerGas: 50000000n };
        const nonce = await this.pub.getTransactionCount({ address: actor, blockTag: 'pending' });
        assert.equal(nonce, this.journal.nonces[actor.toLowerCase()]);
        const request = { account: actor, to: address, data, value, nonce, chain: null, ...fees };
        await this.pub.call({ ...request, gas: gasHint } as never);
        const gas = gasHint ?? (await this.pub.estimateGas(request as never)) * 13n / 10n;
        assert.ok(gas <= MAX_TRANSACTION_GAS);
        assert.ok(fees.maxFeePerGas <= BigInt(this.plan.maxFeePerGas));
        this.budget(gas, fees.maxFeePerGas);
        assert.ok(await this.pub.getBalance({ address: actor }) >= value + gas * fees.maxFeePerGas, 'no actor top-ups');
        this.journal.inFlight = { actor, nonce, address, fn, args, value: String(value), gas: String(gas), ...fees };
        this.save();
        const hash = original ? await original({ ...keeperRequest, ...request, gas }) : await this.wallet.sendTransaction({ ...request, gas } as never);
        this.journal.inFlight.hash = hash;
        this.save();
        const receipt = await this.record(hash, actor, nonce, data, value, address, fn, category, gas);
        if (fn === 'createBalancer')
            this.journal.spent.deposits = String(BigInt(this.journal.spent.deposits) + value);
        if (fn === 'acquireBatch')
            this.journal.spent.buyer = String(BigInt(this.journal.spent.buyer) + value);
        this.journal.inFlight = null;
        this.save();
        return receipt;
    }
    async create(actor: Address, name: 'DemoNFT' | 'KeeperPolicyV2') {
        this.permitted(actor, undefined, name, [], 0n);
        await this.check();
        assert.equal(this.journal.inFlight, null);
        await this.hold();
        const path = name === 'DemoNFT' ? 'out/DevSetup.s.sol/DemoNFT.json' : 'out/Settings.t.sol/KeeperPolicyV2.json';
        const artifact = JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
        const data = artifact.bytecode.object as Hex;
        const nonce = await this.pub.getTransactionCount({ address: actor, blockTag: 'pending' });
        assert.equal(nonce, this.journal.nonces[actor.toLowerCase()]);
        const created = getContractAddress({ from: actor, nonce: BigInt(nonce) });
        assert.ok(!await this.pub.getCode({ address: created }));
        const block = await this.pub.getBlock();
        const fees = { maxFeePerGas: (this.stress ?? block.baseFeePerGas ?? 0n) * 2n + 50000000n, maxPriorityFeePerGas: 50000000n };
        const gas = (await this.pub.estimateGas({ account: actor, data, ...fees })) * 13n / 10n;
        assert.ok(gas <= MAX_TRANSACTION_GAS);
        assert.ok(fees.maxFeePerGas <= BigInt(this.plan.maxFeePerGas));
        this.budget(gas, fees.maxFeePerGas);
        this.journal.inFlight = { actor, nonce, fn: name, created, data };
        this.save();
        const hash = await this.wallet.sendTransaction({ account: actor, data, nonce, gas, ...fees, chain: null });
        this.journal.inFlight.hash = hash;
        this.save();
        await this.record(hash, actor, nonce, data, 0n, undefined, name, 'setup', gas);
        assert.equal(keccak256((await this.pub.getCode({ address: created }))!), keccak256(artifact.deployedBytecode.object));
        this.journal.inFlight = null;
        this.save();
        return created;
    }
    async creationReceiptProbe(actor: Address, curated: {
        collection: Address;
        tokenId: bigint;
        base: bigint;
    }[], mintFeeCap: bigint) {
        const probe = SCENARIO.creationReceiptProbe;
        eq(actor, ROLES[probe.creatorRole]);
        assert.ok(!this.journal.creationReceiptProbe, 'one explicit negative creation only');
        await this.check();
        assert.equal(this.journal.inFlight, null);
        const salt = probe.salt as Hash, predicted = await this.read<Address>(this.factory, balancerFactoryAbi, 'predictBalancer', [actor, salt]);
        const config = { markupBps: SCENARIO.markupBps, creatorRevenueBps: probe.creatorRevenueBps, target: BigInt(SCENARIO.targets[0]), mintFeeCap, curatedRequired: true };
        const data = encodeFunctionData({ abi: balancerFactoryAbi, functionName: 'createBalancer', args: [salt, config, curated] });
        // uint16 encodes 10001, so the real factory/initializer must reject its semantic bound.
        let rejected = false;
        try {
            await this.pub.call({ account: actor, to: this.factory, data, value: 0n });
        }
        catch (error) {
            const cause = (error as any).walk?.((e: any) => typeof e.data === 'string' && e.data.startsWith('0x'));
            if (cause?.data) {
                assert.equal(decodeErrorResult({ abi: poolBalancerAbi, data: cause.data }).errorName, 'InvalidConfig');
                rejected = true;
            }
        }
        assert.ok(rejected, 'real atomic initializer rejects the invalid creator rate before the declared negative submission');
        const nonce = await this.pub.getTransactionCount({ address: actor, blockTag: 'pending' });
        assert.equal(nonce, this.journal.nonces[actor.toLowerCase()]);
        await this.hold();
        const block = await this.pub.getBlock();
        const fees = { maxFeePerGas: (this.stress ?? block.baseFeePerGas ?? 0n) * 2n + 50000000n, maxPriorityFeePerGas: 50000000n };
        const gas = BigInt(probe.gasLimit);
        this.budget(gas, fees.maxFeePerGas);
        await this.mutation('pause automine for the one declared negative creation', () => this.test.setAutomine(false));
        this.journal.inFlight = { creationReceiptProbe: true, actor, nonce, data, value: '0', expected: 'reverted' };
        this.save();
        // The sole deliberate negative submission is fully specified in the frozen plan; successful sends still simulate.
        const hash = await this.wallet.sendTransaction({ account: actor, to: this.factory, data, value: 0n, gas, nonce, ...fees, chain: null });
        this.journal.inFlight.hash = hash;
        this.save();
        const attempt: CreationAttempt = { chainId: 31337, factory: this.factory, creator: actor, salt, predicted, hash, config: { ...config, target: String(config.target), mintFeeCap: String(mintFeeCap) }, curated: curated.map(n => ({ ...n, tokenId: String(n.tokenId), base: String(n.base) })), value: '0' };
        const context = { chainId: 31337, factory: this.factory, creator: actor };
        assert.equal(await recoverCreation(this.pub, attempt, context), 'pending');
        assert.equal(canRetryCreation('pending', attempt, context), false);
        this.journal.creationReceiptProbe = { attempt, context, pendingObserved: true };
        this.save();
        await this.test.mine({ blocks: 1 });
        this.journal.mutations.push('mine exactly the declared pending negative creation');
        this.save();
        const receipt = await this.record(hash, actor, nonce, data, 0n, this.factory, 'createBalancer-negative', 'creation-receipt-probe', gas, 'reverted');
        assert.equal(await recoverCreation(this.pub, attempt, context), 'reverted');
        assert.equal(canRetryCreation('reverted', attempt, context), true);
        assert.ok(!await this.pub.getCode({ address: predicted }));
        assert.equal(await this.read<boolean>(this.factory, balancerFactoryAbi, 'isBalancer', [predicted]), false);
        for (const n of curated)
            eq(await this.read<Address>(n.collection, erc721Abi, 'ownerOf', [n.tokenId]), actor);
        this.journal.creationReceiptProbe.revertedObserved = true;
        this.journal.creationReceiptProbe.receipt = receipt;
        this.journal.inFlight = null;
        this.save();
        await this.mutation('restore automine after exact negative receipt reconciliation', () => this.test.setAutomine(true));
        writeFileSync(join(this.directory, 'creation-recovery-probes.json'), json(this.journal.creationReceiptProbe));
    }
    newKeeper() { const k = new Keeper({ rpcUrl: this.plan.rpc, factory: this.factory, fromBlock: BigInt(this.plan.forkBlock), stateFile: join(this.directory, 'keeper-state.json'), account: ROLES.keeper, reorgWindow: 4096, priorityGwei: .05, maxLossWei: 0n, log: (message, extra) => writeFileSync(join(this.directory, 'keeper-health.json'), json({ message, ...extra })) }); const original = k.wallet.writeContract.bind(k.wallet); k.wallet.writeContract = (async (p: any) => { const r = await this.send(ROLES.keeper, p.address, p.abi, p.functionName, p.args ?? [], 0n, 'keeper', BigInt(p.gas), original, p); return r.transactionHash; }) as typeof k.wallet.writeContract; this.keeper = k; return k; }
    async tick() { await this.hold(); await this.keeper.tick(); assert.deepEqual(this.keeper.errors, {}); assert.equal(this.keeper.state.stats.reverted, 0); this.journal.keeperHealth = this.keeper.health(); this.save(); }
    async start() {
        await currentPreflight(this.plan, 'prepare');
        for (const [role, value] of Object.entries(FUNDING)) {
            const address = ROLES[role];
            await this.mutation(`fund once synthetic ${role} ${value}`, () => this.test.setBalance({ address, value }));
            await this.mutation(`unlock synthetic ${role}`, () => this.test.impersonateAccount({ address }));
            this.journal.funded[role] = String(value);
            this.save();
        }
        const scratch = stage(this.plan);
        this.journal.scratch = scratch;
        this.save();
        this.journal.inFlight = { deployment: true };
        this.save();
        const args = ['--current-local-rehearsal-plan', this.plan.planFile, '--approved-plan-hash', this.packet.planHash, ...this.plan.forgeArguments];
        try {
            const output = execFileSync('bash', [join(scratch, 'script/deploy.sh'), ...args], { cwd: scratch, env: { PATH: process.env.PATH, HOME: process.env.HOME, PACKS_ADMIN: ROLES.packsAdmin, KEEPER_ADMIN: ROLES.keeperAdmin, POLICY_ADMIN: ROLES.policyAdmin }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
            writeFileSync(join(this.directory, 'canonical-deployment.log'), output);
        }
        catch (e) {
            const err = e as any;
            writeFileSync(join(this.directory, 'canonical-deployment-failure.log'), String(err.stdout ?? '') + String(err.stderr ?? ''));
            throw e;
        }
        const raw = JSON.parse(readFileSync(join(scratch, 'broadcast/Deploy.s.sol/31337/run-latest.json'), 'utf8'));
        assert.equal(raw.transactions.length, 8);
        for (let i = 0; i < 8; i++) {
            const a = raw.transactions[i], expected = this.plan.deployment[i], tx = a.transaction;
            assert.equal(keccak256(tx.input), expected.inputHash);
            eq(a.contractAddress, expected.predictedAddress);
            assert.ok(a.hash);
            assert.ok(BigInt(tx.gas) <= BigInt(expected.gasLimit), 'actual deployment stays within frozen per-action gas limit');
            const receipt = await this.record(a.hash, ROLES.deployer, i, tx.input, BigInt(tx.value ?? 0), tx.to ?? undefined, 'Deploy', 'deployment', BigInt(tx.gas));
            assert.equal(keccak256((await this.pub.getCode({ address: a.contractAddress }))!), expected.runtimeCodeHash);
            assert.ok(receipt.status === 'success');
        }
        this.journal.inFlight = null;
        this.save();
        eq(await this.read<Address>(this.factory, balancerFactoryAbi, 'defaultKeeperPolicy'), this.v1);
        this.newKeeper();
    }
    beginCloseout() { this.closing = true; }
    async finish() { this.closing = true; await this.check(); assert.equal(this.journal.inFlight, null); assert.ok(this.gas() <= CAPS.gas); this.journal.completed = true; this.save(); }
    fail(error: unknown) { this.journal.failure = String(error); this.save(); }
}
async function main() {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--prepare') {
        await prepareCurrentPlan();
        return;
    }
    assert.ok(args[0] === '--plan' && args[2] === '--approved-plan-hash', 'exact plan and hash flags');
    const packet = JSON.parse(readFileSync(args[1], 'utf8'));
    const p = validateCurrentPlan(packet, args[3], resolve('.'));
    assert.equal(realpathSync(args[1]), p.planFile);
    if (args[4] === '--phase') {
        assert.ok(args[5] === 'prepare' || args[5] === 'deploy');
        assert.equal(args[6], '--');
        validateCurrentForgeArguments(p, args.slice(7));
        if (args[5] === 'deploy')
            for (const [name, role] of [['PACKS_ADMIN', 'packsAdmin'], ['KEEPER_ADMIN', 'keeperAdmin'], ['POLICY_ADMIN', 'policyAdmin']])
                eq(process.env[name] ?? '', ROLES[role]);
        console.log(json(await currentPreflight(p, args[5])));
        return;
    }
    assert.deepEqual(args.slice(4), ['--execute'], 'explicit bounded execution only');
    assert.equal(process.env.CANDIDATE_RUN, '1', 'frozen candidate execution only');
    const run = new CurrentRehearsal(packet);
    try {
        await run.start();
        const { runPreparedRehearsal } = await import('../keeper/rehearsal');
        await runPreparedRehearsal(run);
        await run.finish();
        console.log(json({ completed: true, planHash: packet.planHash, evidenceDirectory: p.evidenceDirectory, gasWei: String(run.gas()), productionApproval: false }));
    }
    catch (error) {
        run.fail(error);
        throw error;
    }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
    main().catch(error => { console.error(error); process.exitCode = 1; });
