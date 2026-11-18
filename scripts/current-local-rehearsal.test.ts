import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { ARTIFACTS, CAPS, CurrentRehearsal, FUNDING, MAINNET, ROLES, ROOT, SCENARIO, assertStagedDependencies, copyStagedDependencies, dependencyState, digest, forgeArguments, json, manifest, runtimeState, sourceCheck, validateCurrentBounds, validateCurrentForgeArguments, validateCurrentPlan } from './current-local-rehearsal';
const names = ['KeeperPolicyCalls', 'PoolPage', 'PoolInventory', 'ShapePackRenderer', 'ShapePacks', 'PoolBalancer', 'KeeperPolicyV1', 'BalancerFactory'];
const bounds = () => ({ schema: 'protected-revenue-local-rehearsal-v1', repositoryRoot: ROOT, chainId: 31337, rpc: 'http://127.0.0.1:18786', upstream: MAINNET, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), roles: ROLES, funding: JSON.parse(json(FUNDING)), caps: JSON.parse(json(CAPS)), scenario: SCENARIO, maxFeePerGas: '20000000000', maxPriorityFeePerGas: '50000000', perTransactionGas: '16777216', evidenceDirectory: join(ROOT, 'docs/receipts/current-rehearsal/test-input-only'), planFile: join(ROOT, 'docs/receipts/current-rehearsal/test-input-only/bounded-plan.json'), artifacts: Object.fromEntries(ARTIFACTS.map(path => [path, digest(readFileSync(join(ROOT, path)))])), deployment: names.map(name => ({ name, gasLimit: '1000000' })) });
describe('current local rehearsal control inputs, without node mutation', () => {
    it('keeps the fixed scope separate from any deployment or owner approval', () => {
        const p = { ...bounds(), forgeArguments: [] as string[] };
        p.forgeArguments = forgeArguments(p);
        validateCurrentBounds(p);
        validateCurrentForgeArguments(p, p.forgeArguments);
        // These are local plan-input values, not fabricated successful RPC answers or a deployment claim.
        assert.ok(p.caps.draws >= 150 + 7);
        assert.equal(p.scenario.creationReceiptProbe.expectedReceipt, 'reverted');
        assert.equal(p.scenario.initialDeposits.map(BigInt).reduce((a, b) => a + b, 0n), BigInt(p.caps.deposits));
    });
    it.each([
        ['mainnet', (p: any) => p.chainId = 1], ['testnet', (p: any) => p.chainId = 11155111],
        ['remote RPC', (p: any) => p.rpc = MAINNET], ['old owned node', (p: any) => p.rpc = 'http://127.0.0.1:18556'],
        ['arbitrary signer', (p: any) => p.roles = { ...p.roles, deployer: '0x0000000000000000000000000000000000000001' }],
        ['higher spending', (p: any) => p.caps = { ...p.caps, gas: '2000000000000000000' }],
        ['second time jump', (p: any) => p.scenario = { ...p.scenario, maximumTimeJumps: 2 }],
        ['different negative action', (p: any) => p.scenario = { ...p.scenario, creationReceiptProbe: { ...p.scenario.creationReceiptProbe, valueWei: '1' } }],
        ['different action count', (p: any) => p.deployment = p.deployment.slice(1)],
        ['parent-path evidence', (p: any) => p.evidenceDirectory = join(ROOT, 'docs/receipts/current-rehearsal/../old')],
    ])('rejects %s independent of a plan hash', (_name, edit) => {
        const p: any = { ...bounds(), forgeArguments: [] };
        p.forgeArguments = forgeArguments(p);
        edit(p);
        assert.throws(() => validateCurrentBounds(p));
    });
    it('enforces the actual sender budget boundary before any mutation or submission', () => {
        // Direct numeric inputs exercise the shared validator without constructing a node, service or RPC response.
        const validate = Reflect.get(CurrentRehearsal.prototype, 'budget') as (this: {plan:{maxFeePerGas:string};gas:()=>bigint;closing:boolean}, gas:bigint, price:bigint) => void;
        const state = {plan:{maxFeePerGas:'20000000000'},gas:()=>0n,closing:false};
        assert.doesNotThrow(() => validate.call(state,5_000_000n,20_000_000_000n));
        assert.throws(() => validate.call(state,5_000_000n,24_050_000_000n), /per-transaction fee ceiling/);
        assert.throws(() => validate.call(state,1n,20_000_000_001n), /per-transaction fee ceiling/);
        assert.throws(() => validate.call({...state,gas:()=>850_000_000_000_000_000n},5_000_000n,20_000_000_000n), /retained closeout reserve/);
        assert.doesNotThrow(() => validate.call({...state,closing:true,gas:()=>900_000_000_000_000_000n},5_000_000n,20_000_000_000n));
    });
    it('rejects stale approval before touching a node or preparation file', () => {
        const p: any = { ...bounds(), forgeArguments: [] };
        p.forgeArguments = forgeArguments(p);
        assert.throws(() => validateCurrentPlan({ plan: p, planHash: digest(json(p)) }, '0'.repeat(64)), /exact reviewed current plan hash/);
    });
    it('rejects altered command arguments, signer, relay and resume paths', () => {
        const p: any = { ...bounds() };
        p.forgeArguments = forgeArguments(p);
        for (const args of [[...p.forgeArguments, '--resume'], [...p.forgeArguments, '--account', 'production'], [...p.forgeArguments, '--rpc-url', MAINNET]])
            assert.throws(() => validateCurrentForgeArguments(p, args));
    });
    it('binds every current app helper and actual artifact while excluding evidence outputs', () => {
        const inputs = manifest();
        const p = { ...bounds(), inputs, sourceFingerprint: digest(json(inputs)), dependencies: dependencyState(), runtime: runtimeState() };
        sourceCheck(p);
        assert.ok(p.runtime.binaries.some(binary => binary.path.endsWith('/.svm/0.8.28/solc-0.8.28') && binary.sha256 === digest(readFileSync(binary.path))), 'installed solc executable is bound with its actual file hash');
        assert.ok(p.runtime.binaries.some(binary => binary.path.endsWith('/forge') && binary.sha256 === digest(readFileSync(binary.path))), 'actual Forge executable remains bound even when the invoked command is guarded');
        for (const name of ['app/src/creation.ts', 'app/src/refresh.ts', 'app/src/revenue-rate.ts', 'app/src/App.tsx'])
            assert.ok(inputs.some(i => i.path === name), name);
        assert.ok(!inputs.some(i => i.path.startsWith('docs/receipts/') || i.path.startsWith('docs/verification/')));
        const changed = structuredClone(p);
        changed.inputs[0].sha256 = '0'.repeat(64);
        assert.throws(() => sourceCheck(changed));
    });
    it('stages real pinned dependency source bytes without library symlinks or Git metadata', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fwa-current-dependency-copy-test-'));
        const p = {repositoryRoot:ROOT,dependencies:dependencyState()};
        const paths = copyStagedDependencies(p, dir);
        assert.ok(paths.includes('lib/shape-packs/lib/shapes/lib/openzeppelin-contracts/contracts/token/ERC721/ERC721.sol'));
        assert.ok(lstatSync(join(dir,'lib')).isDirectory()); assert.equal(lstatSync(join(dir,'lib')).isSymbolicLink(),false);
        assert.ok(paths.every(path => path.endsWith('.sol') && !path.split('/').some(part => part === '.git' || part.startsWith('.env'))));
        assert.equal(existsSync(join(dir,'lib/forge-std/.git')),false);
        assert.deepEqual(assertStagedDependencies(p,dir),paths);
        const source = paths[0];
        assert.equal(Math.trunc(statSync(join(dir,source)).mtimeMs),Math.trunc(statSync(join(ROOT,source)).mtimeMs));
        writeFileSync(join(dir,source),'// modified staging input');
        assert.throws(() => assertStagedDependencies(p,dir), /staged pinned dependency source/);
    });
    it('preserves the production gate tail exactly and requires an explicit new local route', () => {
        const wrapper = readFileSync(join(ROOT, 'script/deploy.sh'), 'utf8');
        assert.equal(digest(wrapper.slice(wrapper.indexOf('GATE='))), '34d5e5f61b2ea38bfaf92fc4cc841a5f4e113f6d53d9b47975a324e8d78a5e0d');
        assert.match(wrapper, /--current-local-rehearsal-plan/);
        assert.match(wrapper, /--phase deploy/);
        assert.match(wrapper, /--require-review/);
        assert.throws(() => execFileSync('bash', ['script/deploy.sh', '--current-local-rehearsal-plan'], { cwd: ROOT, stdio: 'pipe' }));
    });
});
