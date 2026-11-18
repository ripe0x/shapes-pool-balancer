import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  it('accepts current real material and exact intended arguments in both read-only phases',()=>{
    const p=validatePlan(proposed,proposed.planHash);
    validateForgeArgs(p,p.forgeArguments,'prepare'); validateForgeArgs(p,p.forgeArguments,'deploy');
  });
  it('rejects a stale approval before material or node access',()=>{
    assert.throws(()=>validatePlan(proposed,'0'.repeat(64)),/exact approved plan hash/);
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
    const before=execFileSync('git',['show','04bc760:script/deploy.sh'],{cwd:root,encoding:'utf8'});
    const after=readFileSync(resolve(root,'script/deploy.sh'),'utf8');
    assert.equal(after.slice(after.indexOf('GATE=')),before.slice(before.indexOf('GATE=')));
    assert.match(after,/unset ASSET_GATE_PASSED\s+exec forge script script\/Deploy.s.sol "\$@"/);
    assert.match(after,/--require-review/);
  });
  it('rejects incomplete or misplaced local wrapper flags before any deployment',()=>{
    for(const args of [['--local-rehearsal-plan'],['--rpc-url','https://mainnet.gateway.tenderly.co','--approved-plan-hash','invalid']]) {
      assert.throws(()=>execFileSync('bash',['script/deploy.sh',...args],{cwd:root,stdio:'pipe'}));
    }
  });
});
