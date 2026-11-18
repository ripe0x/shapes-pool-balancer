import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'vitest';
import { digest, validateForgeArgs, validatePlan } from './local-rehearsal-gate';

const root=resolve(import.meta.dirname,'..');
const packet=()=>JSON.parse(execFileSync(process.execPath,['--import','tsx','scripts/run-local-rehearsal.ts'],{cwd:root,encoding:'utf8'}));
// These are plan-input attacks, not substitutes for successful external-service responses.
function changed(plan:Record<string,any>, edit:(p:Record<string,any>)=>void) {
  const p=structuredClone(plan); edit(p); return {plan:p,planHash:digest(JSON.stringify(p,null,2))};
}
describe('local rehearsal gate without chain mutations',()=>{
  const proposed=packet();
  it('validates reported material and arguments without approving the changed candidate source',()=>{
    const p=validatePlan(proposed,proposed.planHash);
    validateForgeArgs(p,p.forgeArguments,'prepare'); validateForgeArgs(p,p.forgeArguments,'deploy');
  });
  it('reports deleted tracked inputs without treating the report as source approval',()=>{
    const cfg=JSON.parse(readFileSync(join(root,'asset-flow.json'),'utf8'));
    const missing=execFileSync('git',['ls-files','--deleted','-z','--',...cfg.source_paths,...cfg.evidence_paths],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean).sort();
    assert.deepEqual(proposed.reportOnlyMissingSourcePaths,missing);
    assert.equal(proposed.sourceVerification,'not performed; execution requires exact frozen archive inputs');
    assert.equal(proposed.execution,'not authorized; no node requests or writes made');
  });
  it('keeps guarded checks fail-closed for inputs outside the frozen archive',()=>{
    const result=spawnSync(process.execPath,['--import','tsx','scripts/run-local-rehearsal.ts','--self-check'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/Settings\.sol|Command failed: git|exact archived inputs/);
    assert.doesNotMatch(result.stdout,/'selfCheck': 'pass'|"selfCheck": "pass"/);
  });
  it('rejects a stale approval before material or node access',()=>{
    assert.throws(()=>validatePlan(proposed,'0'.repeat(64)),/exact approved plan hash/);
  });
  it('runs the CLI through an absolute symlink instead of silently exiting successfully',()=>{
    const alias=join(mkdtempSync(join(tmpdir(),'local-gate-entrypoint-')),'gate.ts');
    symlinkSync(resolve(root,'scripts/local-rehearsal-gate.ts'),alias);
    assert.throws(()=>execFileSync(process.execPath,['--import','tsx',alias,'--plan',resolve(root,'docs/receipts/rehearsal-04bc760-preparation/bounded-plan.json'),'--approved-plan-hash','0'.repeat(64),'--phase','prepare','--',...proposed.plan.forgeArguments],{cwd:root,stdio:'pipe'}));
  });
  it.each([
    ['mainnet', (p:Record<string,any>)=>{p.chainId=1;}],
    ['testnet', (p:Record<string,any>)=>{p.chainId=11155111;}],
    ['remote endpoint', (p:Record<string,any>)=>{p.rpc='https://mainnet.gateway.tenderly.co';}],
    ['other loopback', (p:Record<string,any>)=>{p.rpc='http://127.0.0.1:18554';}],
    ['changed sender', (p:Record<string,any>)=>{p.roles.deployer='0x0000000000000000000000000000000000000001';}],
    ['higher budget', (p:Record<string,any>)=>{p.caps.gas='2000000000000000000';}],
    ['changed material', (p:Record<string,any>)=>{p.materialHashes['script/deploy.sh']='0'.repeat(64);}],
  ] as const)('rejects %s even with a recomputed plan hash',(_name,edit)=>{
    const bad=changed(proposed.plan,edit); assert.throws(()=>validatePlan(bad,bad.planHash));
  });
  it('rejects extra or altered Forge arguments',()=>{
    for(const args of [
      [...proposed.plan.forgeArguments,'--resume'],
      [...proposed.plan.forgeArguments,'--account','production'],
      proposed.plan.forgeArguments.map((arg:string)=>arg===proposed.plan.rpc?'https://mainnet.gateway.tenderly.co':arg),
      [...proposed.plan.forgeArguments,'--rpc-url','https://mainnet.gateway.tenderly.co'],
    ]) assert.throws(()=>validateForgeArgs(proposed.plan,args,'deploy'));
  });
  it('preserves every byte of the original production gate and Forge tail',()=>{
    const after=readFileSync(resolve(root,'script/deploy.sh'),'utf8');
    // Frozen 04bc760 production tail; shallow CI checkouts need no historical commit objects.
    assert.equal(digest(after.slice(after.indexOf('GATE='))),'34d5e5f61b2ea38bfaf92fc4cc841a5f4e113f6d53d9b47975a324e8d78a5e0d');
    assert.match(after,/unset ASSET_GATE_PASSED\s+exec forge script script\/Deploy.s.sol "\$@"/);
    assert.match(after,/--require-review/);
  });
  it('rejects incomplete or misplaced local wrapper flags before any deployment',()=>{
    for(const args of [['--local-rehearsal-plan'],['--rpc-url','https://mainnet.gateway.tenderly.co','--approved-plan-hash','invalid']]) {
      assert.throws(()=>execFileSync('bash',['script/deploy.sh',...args],{cwd:root,stdio:'pipe'}));
    }
  });
});
