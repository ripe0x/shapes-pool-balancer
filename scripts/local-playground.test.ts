import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {bounds,FUNDING,RPC,DEPLOYMENT_VALUES,validateDeploymentEnvironment} from './local-playground';
import {ROLES,ROOT,digest} from './current-local-rehearsal';
const plan=()=>({schema:'local-playground-8545-v1',rpc:RPC,chainId:31337,roles:ROLES,funding:FUNDING,deploymentEnvironment:DEPLOYMENT_VALUES,gasCapWei:'1000000000000000000',maxTransactions:12,publicCreationPaused:true,draws:0,repositoryRoot:ROOT,directory:join(ROOT,'docs/receipts/local-playground/test-input'),planFile:join(ROOT,'docs/receipts/local-playground/test-input/bounded-plan.json'),forgeArguments:['--rpc-url',RPC,'--unlocked','--sender',ROLES.deployer,'--with-gas-price','20000000000','--priority-gas-price','50000000','--slow','--broadcast']});
it('permits only the explicitly bounded existing-node local playground inputs',()=>{expect(()=>bounds(plan())).not.toThrow();});
it('rejects another network, signer, endpoint, funding or authority without calling any RPC',()=>{
 for(const edit of [(p:any)=>p.rpc='https://mainnet.gateway.tenderly.co',(p:any)=>p.chainId=1,(p:any)=>p.roles={...p.roles,deployer:ROLES.buyer},(p:any)=>p.funding={...p.funding,buyer:'1000000000000000000000'},(p:any)=>p.gasCapWei='2000000000000000000',(p:any)=>p.maxTransactions=13,(p:any)=>p.publicCreationPaused=false,(p:any)=>p.draws=1,(p:any)=>p.forgeArguments.push('--resume')]){const p=structuredClone(plan());edit(p);expect(()=>bounds(p)).toThrow();}
});
it('leaves the signed focused production gate unchanged behind the new local route',()=>{
 const s=readFileSync(join(ROOT,'script/deploy.sh'),'utf8');expect(digest(s.slice(s.indexOf('GATE=')))).toBe('e41bd1be39034eff5724190c55477c8033ff07c73061baf27d9e447f68399cd8');expect(s).toContain('scripts/local-playground.ts --gate');expect(s).toContain('--config asset-flow-focused.json --require-review');
});

it('binds deployment mode/admins and rejects environment-only Forge or setter overrides',()=>{
 expect(()=>validateDeploymentEnvironment({...DEPLOYMENT_VALUES})).not.toThrow();
 for(const change of [{REUSE_DEPENDENCIES:'false'},{POLICY_ADMIN:ROLES.buyer},{KEEPER_ADMIN:ROLES.buyer},{IMPLEMENTATION_ONLY:'true'},{NEW_IMPLEMENTATION:ROLES.buyer},{FOUNDRY_PROFILE:'other'},{ETH_PRIVATE_KEY:'presence-only-test-input'}])expect(()=>validateDeploymentEnvironment({...DEPLOYMENT_VALUES,...change})).toThrow();
});
