// Read-only approval preflight for this isolated rehearsal; never signs, sends or changes chain state.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, http, type Address } from 'viem';

const ENDPOINT = 'http://127.0.0.1:18556';
const ARCHIVE = '04bc760d506fd29329a3a819c7f2e4a1480377dd';
const ETH = 10n ** 18n;
const SHA = /^[0-9a-f]{64}$/;
const MATERIAL = [
  'script/deploy.sh', 'scripts/local-rehearsal-gate.ts',
  'scripts/prepare-local-rehearsal.ts', 'scripts/run-local-rehearsal.ts', 'docs/RELEASE-REHEARSAL.md',
  ...['deployment-actions.json', 'node.json', 'preflight.json', 'opening-preview.json', 'deployment-code-hashes.json', 'demo-nft.json']
    .map(name => `docs/receipts/rehearsal-04bc760-preparation/${name}`),
];
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function requireThat(condition: unknown, message: string): asserts condition { assert.ok(condition, message); }
type Packet = { planHash: string; plan: Record<string, any> };

export function validatePlan(packet: Packet, approved: string) {
  requireThat(SHA.test(approved) && approved === packet.planHash && approved === digest(JSON.stringify(packet.plan, null, 2)), 'exact approved plan hash required');
  const p = packet.plan;
  requireThat(p.route === 'local-rehearsal-plan' && p.rpc === ENDPOINT && p.chainId === 31337, 'only the named isolated local fork');
  requireThat(p.revision === ARCHIVE && p.archiveRevision === ARCHIVE, 'frozen deployment candidate');
  requireThat(isAbsolute(p.repositoryRoot) && realpathSync(p.repositoryRoot) === p.repositoryRoot, 'canonical original repository path');
  requireThat(p.sourceFingerprint === 'ca02fb070a2a839cccc9fced15b3116613f6d7727d4e50133693dd63a4c92eda', 'archived production/evidence fingerprint');
  const expectedRoles = Object.fromEntries(['deployer','packsAdmin','keeperAdmin','policyAdmin','creatorA','creatorB','keeper','buyer'].map((name, i) => [name, `0x000000000000000000000000000000000001e00${i + 1}`]));
  requireThat(JSON.stringify(p.roles) === JSON.stringify(expectedRoles), 'only the named synthetic signers');
  const funding = [ETH, ETH/100n, ETH/100n, ETH/100n, 31n*ETH/10n, 31n*ETH/10n, ETH/5n, 40n*ETH];
  Object.keys(expectedRoles).forEach((name,i) => requireThat(BigInt(p.funding[name]) === funding[i], 'fixed synthetic funding ceilings'));
  const caps = {deposits:6n*ETH,gas:ETH,buyer:40n*ETH,edge:ETH,vrf:5n*ETH,draws:252n,rounds:50n,replacementCuratedNfts:252n};
  for (const [key,value] of Object.entries(caps)) requireThat(BigInt(p.caps[key]) === value, 'unchanged shared spending/activity caps');
  requireThat(BigInt(p.maxFeePerGas) === 20_000_000_000n && BigInt(p.maxPriorityFeePerGas) === 50_000_000n && BigInt(p.perTransactionGas) === 16_777_216n && BigInt(p.closeoutGasReserveWei) === ETH/10n, 'fee, transaction and closeout limits');
  requireThat(p.plannedDriverDraws === 152 && p.timeJumpSeconds === 172801 && p.coordinatorException === true, 'explicit diagnostic actions');
  requireThat(JSON.stringify(Object.keys(p.materialHashes).sort()) === JSON.stringify([...MATERIAL].sort()), 'exact material allowlist');
  for (const path of MATERIAL) requireThat(SHA.test(p.materialHashes[path]) && digest(readFileSync(join(p.repositoryRoot,path))) === p.materialHashes[path], 'plan material changed');
  requireThat(digest(readFileSync(import.meta.filename)) === p.materialHashes['scripts/local-rehearsal-gate.ts'], 'executed verifier matches approved material');
  return p;
}

export function validateForgeArgs(p: Record<string, any>, args: string[], phase: string) {
  requireThat(phase === 'prepare' || phase === 'deploy', 'known preflight phase');
  const expected = ['--rpc-url',p.rpc,'--unlocked','--sender',p.roles.deployer,'--with-gas-price',p.maxFeePerGas,'--priority-gas-price',p.maxPriorityFeePerGas,'--slow','--broadcast'];
  requireThat(JSON.stringify(p.forgeArguments) === JSON.stringify(expected), 'plan binds exact deployment arguments');
  requireThat(JSON.stringify(args) === JSON.stringify(expected), 'only the exact reviewed Forge arguments; no other signer, RPC, script, resume or relay');
}

function sourceCheck(p: Record<string, any>, executedRoot: string) {
  const git=(...args:string[])=>execFileSync('git',args,{cwd:p.repositoryRoot,encoding:'utf8'});
  const cfg=JSON.parse(readFileSync(join(p.repositoryRoot,'asset-flow.json'),'utf8')); delete cfg.approval;
  requireThat(digest(JSON.stringify(cfg,null,2)) === p.gateConfigHash, 'unchanged proposed release outcomes/settings');
  const paths=[...cfg.source_paths,...cfg.evidence_paths];
  const protectedPaths=[...paths,'keeper','shared','lib','package.json','package-lock.json','tsconfig.json','test/fixtures/keeper-policy-v1.json'];
  git('merge-base','--is-ancestor',ARCHIVE,'HEAD');
  git('diff','--exit-code','--ignore-submodules=none',ARCHIVE,'--',...protectedPaths,':(exclude)script/deploy.sh');
  requireThat(git('ls-files','--others','--exclude-standard','--',...protectedPaths).trim() === '', 'no unreviewed protected inputs');
  const files=git('ls-files','-z','--',...paths).split('\0').filter(Boolean).sort();
  const archivedWrapper=git('show',`${ARCHIVE}:script/deploy.sh`);
  const fingerprint=(root:string,archived:boolean)=>{
    const hash=createHash('sha256');
    for(const file of files){hash.update(`${file}\0`);hash.update(archived&&file==='script/deploy.sh'?archivedWrapper:readFileSync(join(root,file)));hash.update('\0');}
    return hash.digest('hex');
  };
  requireThat(fingerprint(p.repositoryRoot,true) === p.sourceFingerprint, 'runtime/evidence inputs still match frozen archive');
  requireThat(fingerprint(executedRoot,false) === p.localOverlaySourceFingerprint, 'exact executed source with local gate overlay');
}

function ownership(p: Record<string, any>) {
  const n = JSON.parse(readFileSync(join(p.repositoryRoot,'docs/receipts/rehearsal-04bc760-preparation/node.json'),'utf8'));
  requireThat(n.rpc === ENDPOINT && n.forkBlock === p.forkBlock && n.forkHash === p.forkHash && Number.isSafeInteger(n.pid) && n.pid > 0, 'prepared node identity');
  const listeners = execFileSync('lsof',['-nP','-iTCP:18556','-sTCP:LISTEN','-Fp'],{encoding:'utf8'}).split('\n').filter(x=>x.startsWith('p'));
  requireThat(listeners.length === 1 && listeners[0] === `p${n.pid}`, 'owned Anvil listener PID');
  const command = execFileSync('ps',['-p',String(n.pid),'-o','command='],{encoding:'utf8'}).trim().split(/\s+/);
  requireThat(basename(command[0]) === 'anvil' && JSON.stringify(command.slice(1)) === JSON.stringify(n.command.slice(1)), 'listener is the prepared Anvil process, not a proxy');
  requireThat(n.command.join(' ') === `anvil --host 127.0.0.1 --port 18556 --chain-id 31337 --accounts 0 --fork-url https://mainnet.gateway.tenderly.co --fork-block-number ${p.forkBlock} --silent`, 'isolated node command');
  return n.pid;
}

export async function preflight(p: Record<string, any>, phase: string) {
  const pid = ownership(p);
  const client = createPublicClient({transport:http(p.rpc,{timeout:15_000,retryCount:0}),cacheTime:0});
  requireThat(await client.getChainId() === 31337, 'local chain ID');
  const info = await client.request({method:'anvil_nodeInfo' as never}) as any;
  requireThat(info.environment.chainId === 31337 && info.forkConfig.forkUrl === 'https://mainnet.gateway.tenderly.co' && String(info.forkConfig.forkBlockNumber) === p.forkBlock, 'expected actual Anvil fork');
  const block = await client.getBlock();
  requireThat(block.hash === p.forkHash && String(block.number) === p.forkBlock, 'no unapproved mining, sends or time changes before deployment');
  const prepared = JSON.parse(readFileSync(join(p.repositoryRoot,'docs/receipts/rehearsal-04bc760-preparation/deployment-actions.json'),'utf8'));
  requireThat(JSON.stringify(p.deployment) === JSON.stringify(prepared.actions) && p.deployment.length === 8, 'exact eight decoded creations');
  requireThat(p.deployment.reduce((total:bigint,a:any)=>total+BigInt(a.gasLimit)*BigInt(p.maxFeePerGas),0n) + BigInt(p.closeoutGasReserveWei) <= BigInt(p.caps.gas), 'deployment and closeout gas fit shared cap');
  for (const a of p.deployment) requireThat(!(await client.getCode({address:a.predictedAddress})), 'deployment destination must remain vacant');
  for (const [role,address] of Object.entries(p.roles)) {
    const a = address as Address;
    requireThat(!(await client.getCode({address:a})) && await client.getTransactionCount({address:a,blockTag:'pending'}) === 0, 'fresh synthetic signer');
    requireThat(await client.getBalance({address:a}) === (phase === 'prepare' ? 0n : BigInt(p.funding[role])), 'only the approved one-time actor funding');
  }
  requireThat(ownership(p) === pid, 'node process stayed unchanged during preflight');
  return {phase,chainId:31337,rpc:p.rpc,pid,block:p.forkBlock,hash:p.forkHash,transactionsSent:0};
}

async function main() {
  const args=process.argv.slice(2);
  requireThat(args.length >= 7 && args[0] === '--plan' && args[2] === '--approved-plan-hash' && args[4] === '--phase' && args[6] === '--', 'strict local preflight arguments');
  requireThat(isAbsolute(args[1]), 'absolute frozen plan path');
  const p=validatePlan(JSON.parse(readFileSync(args[1],'utf8')),args[3]);
  requireThat(realpathSync(args[1]) === join(p.repositoryRoot,'docs/receipts/rehearsal-04bc760-preparation/bounded-plan.json'), 'canonical frozen plan file');
  validateForgeArgs(p,args.slice(7),args[5]);
  sourceCheck(p,resolve('.'));
  if (args[5] === 'deploy') {
    requireThat(['PACKS_ADMIN','KEEPER_ADMIN','POLICY_ADMIN'].every((name,i)=>process.env[name]?.toLowerCase() === p.roles[['packsAdmin','keeperAdmin','policyAdmin'][i]].toLowerCase()), 'decoded deployment administrators');
    requireThat(digest(readFileSync(resolve('script/deploy.sh'))) === p.materialHashes['script/deploy.sh'], 'executed wrapper matches approved material');
  }
  console.log(JSON.stringify({localPreflight:await preflight(p,args[5]),planHash:args[3],releaseApproval:false},null,2));
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) main().catch(error=>{console.error(error instanceof Error ? error.message : 'local preflight rejected');process.exitCode=1;});
