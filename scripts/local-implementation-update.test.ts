import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {args,bounds,broadcastFile,FACTORY,PREVIOUS} from './local-implementation-update';
import {ROOT,ROLES,digest} from './current-local-rehearsal';
const impl='0x0000000000000000000000000000000000001111';
const plan=()=>({schema:'local-implementation-8545-v1',rpc:'http://127.0.0.1:8545',chainId:31337,factory:FACTORY,previous:PREVIOUS,deployer:ROLES.deployer,admin:ROLES.policyAdmin,gasCapWei:'1000000000000000000',maxTransactions:5,fundingWei:'0',draws:0,repositoryRoot:ROOT,directory:join(ROOT,'docs/receipts/local-playground/implementation-test'),planFile:join(ROOT,'docs/receipts/local-playground/implementation-test/bounded-plan.json'),deploymentEnvironment:{REUSE_DEPENDENCIES:'true',IMPLEMENTATION_ONLY:'true',EXISTING_FACTORY:FACTORY,EXPECTED_IMPLEMENTATION:PREVIOUS,KEEPER_ADMIN:ROLES.keeperAdmin,POLICY_ADMIN:ROLES.policyAdmin},forgeArguments:args('deploy'),switchArguments:args('switch'),deployment:[{name:'PoolBalancer',predictedAddress:impl,gasLimit:'6000000'}],implementation:impl});
it('permits bounded implementation-only deployment and separate admin switch, not a factory redeployment',()=>{expect(()=>bounds(plan())).not.toThrow();expect(args('switch')).toContain('switchImplementation()');expect(args('switch')).toContain(ROLES.policyAdmin);});
it('rejects network, signer, value, funding, factory and gas expansion without an RPC call',()=>{
 for(const edit of [(p:any)=>p.rpc='https://mainnet.gateway.tenderly.co',(p:any)=>p.chainId=1,(p:any)=>p.factory=ROLES.buyer,(p:any)=>p.previous=ROLES.buyer,(p:any)=>p.admin=ROLES.buyer,(p:any)=>p.deployer=ROLES.buyer,(p:any)=>p.fundingWei='1',(p:any)=>p.draws=1,(p:any)=>p.maxTransactions=6,(p:any)=>p.gasCapWei='2000000000000000000',(p:any)=>p.deployment.push({name:'BalancerFactory',predictedAddress:impl,gasLimit:'1000'}),(p:any)=>p.switchArguments.push('--resume'),(p:any)=>p.deployment[0].gasLimit='60000000',(p:any)=>p.deploymentEnvironment.NEW_IMPLEMENTATION=ROLES.buyer]){const p=plan();edit(p);expect(()=>bounds(p)).toThrow();}
});
it('preserves the signed production gate and routes local updates through the same deployment script',()=>{
 const s=readFileSync(join(ROOT,'script/deploy.sh'),'utf8');expect(digest(s.slice(s.indexOf('GATE=')))).toBe('e41bd1be39034eff5724190c55477c8033ff07c73061baf27d9e447f68399cd8');expect(s).toContain('scripts/local-implementation-update.ts --gate');expect(s).toContain('exec forge script script/Deploy.s.sol');
});

it('reads Forge artifacts named after the actual entrypoint when resuming a separate switch',()=>{
 expect(broadcastFile('/stage','deploy')).toBe('/stage/broadcast/Deploy.s.sol/31337/run-latest.json');
 expect(broadcastFile('/stage','switch',true)).toBe('/stage/broadcast/Deploy.s.sol/31337/dry-run/switchImplementation-latest.json');
 expect(broadcastFile('/stage','switch')).toBe('/stage/broadcast/Deploy.s.sol/31337/switchImplementation-latest.json');
});
