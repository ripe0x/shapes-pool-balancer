// Existing 8545 playground only. Deploy.s.sol remains the deployment and switch path.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createPublicClient,http,keccak256,type Address} from 'viem';
import {ARTIFACTS,ROOT,ROLES,dependencyState,digest,json,manifest,runtimeState,sourceCheck} from './current-local-rehearsal';
import {node,stage,RPC} from './local-playground';
import {verifyActions} from './prepare-local-rehearsal';
import {factorySnapshot,matchPlan,verifyImplementationUpdate} from './verify-deployment';
import {balancerFactoryAbi,poolBalancerAbi} from '../shared/abi';
export const FACTORY='0xbe49677a403f77136e81498e5681f8dc22aa1181' as Address;
export const PREVIOUS='0x940815eE17aa44E861bEfe77e6812EB0f2da9710' as Address;
const CAP=10n**18n;
const pub=createPublicClient({transport:http(RPC,{retryCount:0}),cacheTime:0});
const baseEnv={REUSE_DEPENDENCIES:'true',IMPLEMENTATION_ONLY:'true',EXISTING_FACTORY:FACTORY,EXPECTED_IMPLEMENTATION:PREVIOUS,KEEPER_ADMIN:ROLES.keeperAdmin,POLICY_ADMIN:ROLES.policyAdmin};
export function args(phase:'deploy'|'switch') {return ['--rpc-url',RPC,'--unlocked','--sender',phase==='deploy'?ROLES.deployer:ROLES.policyAdmin,'--with-gas-price','20000000000','--priority-gas-price','50000000','--slow',...(phase==='switch'?['--sig','switchImplementation()']:[]),'--broadcast'];}
export const broadcastFile=(root:string,phase:'deploy'|'switch',dry=false)=>join(root,'broadcast/Deploy.s.sol/31337',...(dry?['dry-run']:[]),phase==='switch'?'switchImplementation-latest.json':'run-latest.json');
const environment=(implementation?:Address)=>({PATH:process.env.PATH,HOME:process.env.HOME,...baseEnv,...(implementation?{NEW_IMPLEMENTATION:implementation}:{})});
export function bounds(p:any){
 assert.equal(p.schema,'local-implementation-8545-v1');assert.equal(p.rpc,RPC);assert.equal(p.chainId,31337);assert.equal(p.factory,FACTORY);assert.equal(p.previous,PREVIOUS);
 assert.equal(p.deployer,ROLES.deployer);assert.equal(p.admin,ROLES.policyAdmin);assert.equal(p.gasCapWei,String(CAP));assert.equal(p.maxTransactions,5);assert.equal(p.fundingWei,'0');assert.equal(p.draws,0);
 assert.equal(realpathSync(p.repositoryRoot),p.repositoryRoot);assert.equal(p.planFile,join(p.directory,'bounded-plan.json'));assert.ok(p.directory.startsWith(join(p.repositoryRoot,'docs/receipts/local-playground/implementation-')));
 assert.deepEqual(p.deploymentEnvironment,baseEnv);assert.deepEqual(p.forgeArguments,args('deploy'));assert.deepEqual(p.switchArguments,args('switch'));
 assert.ok(p.deployment.length>0&&p.deployment.length+1<=p.maxTransactions);assert.equal(p.deployment.at(-1).name,'PoolBalancer');assert.ok(!p.deployment.some((a:any)=>a.name==='BalancerFactory'));
 assert.equal(p.implementation,p.deployment.at(-1).predictedAddress);assert.ok(p.deployment.reduce((sum:bigint,a:any)=>sum+BigInt(a.gasLimit)*20000000000n,0n)+500000n*20000000000n<=CAP);
}
async function validate(packet:any,approved:string,root=ROOT){
 assert.equal(packet.planHash,approved);assert.equal(digest(json(packet.plan)),approved);const p=packet.plan;bounds(p);sourceCheck(p,root);await node(p);
 assert.equal((await pub.readContract({address:FACTORY,abi:balancerFactoryAbi,functionName:'policyAdmin'})).toLowerCase(),p.admin.toLowerCase());
 return p;
}
function run(dir:string,argv:string[],env:any,file:string){
 try{const out=execFileSync('forge',['script','script/Deploy.s.sol',...argv],{cwd:dir,env,encoding:'utf8',maxBuffer:64*1024*1024});writeFileSync(file,out);}
 catch(e:any){writeFileSync(file,String(e.stdout??'')+'\n'+String(e.stderr??''));throw e;}
}
async function prepare(){
 const identity=await node();const block=await pub.getBlockNumber();const snapshot=await factorySnapshot(pub,FACTORY,block);
 assert.equal(snapshot.implementation.toLowerCase(),PREVIOUS.toLowerCase());assert.equal(snapshot.creationPaused,false);
 const nonce=await pub.getTransactionCount({address:ROLES.deployer,blockTag:'pending'});
 for(const address of [ROLES.deployer,ROLES.policyAdmin])assert.equal(await pub.getCode({address})??'0x','0x','synthetic EOA only');
 const directory=join(ROOT,'docs/receipts/local-playground/implementation-'+new Date().toISOString().replace(/[^0-9]/g,''));mkdirSync(directory,{recursive:true});
 const p:any={schema:'local-implementation-8545-v1',repositoryRoot:ROOT,revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),directory,planFile:join(directory,'bounded-plan.json'),rpc:RPC,chainId:31337,node:identity,factory:FACTORY,previous:PREVIOUS,deployer:ROLES.deployer,admin:ROLES.policyAdmin,nonce,gasCapWei:String(CAP),maxTransactions:5,fundingWei:'0',draws:0,deploymentEnvironment:baseEnv,forgeArguments:args('deploy'),switchArguments:args('switch'),factorySnapshot:snapshot,inputs:manifest(),dependencies:dependencyState(),runtime:runtimeState(),artifacts:Object.fromEntries(ARTIFACTS.map(path=>[path,digest(readFileSync(join(ROOT,path)))]))};p.sourceFingerprint=digest(json(p.inputs));
 const scratch=stage(p);run(scratch,p.forgeArguments.filter((a:string)=>a!=='--broadcast'),environment(),join(directory,'simulation.log'));
 p.simulationRoot=scratch;p.deployment=verifyActions(scratch,{implementationOnly:true,startNonce:nonce}).actions;p.implementation=p.deployment.at(-1).predictedAddress;
 p.simulationHash=digest(readFileSync(join(scratch,'broadcast/Deploy.s.sol/31337/dry-run/run-latest.json')));
 const packet={planHash:digest(json(p)),plan:p};writeFileSync(p.planFile,json(packet));await validate(packet,packet.planHash);
 execFileSync('node',['--import','tsx','scripts/local-implementation-update.ts','--gate',p.planFile,'--approved-plan-hash',packet.planHash,'--',...args('deploy')],{cwd:scratch,env:environment(),encoding:'utf8'});writeFileSync(join(directory,'staged-gate.json'),json({passed:true,broadcast:false,planHash:packet.planHash}));
 console.log(json({planHash:packet.planHash,planFile:p.planFile,factory:p.factory,previous:p.previous,implementation:p.implementation,actions:p.deployment.map((a:any)=>({name:a.name,address:a.predictedAddress,gasLimit:a.gasLimit})),switch:{from:p.admin,to:FACTORY,function:'setImplementation',args:[p.implementation],value:0},funding:0,gasCapWei:p.gasCapWei}));
}
async function execute(packet:any,approved:string){
 const p=await validate(packet,approved);const file=join(p.directory,'journal.json');assert.ok(!existsSync(file),'one-shot; reconcile existing journal');
 assert.deepEqual(await factorySnapshot(pub,FACTORY,await pub.getBlockNumber()),p.factorySnapshot);assert.equal(await pub.getTransactionCount({address:p.deployer,blockTag:'pending'}),p.nonce);
 const dryPath=join(p.simulationRoot,'broadcast/Deploy.s.sol/31337/dry-run/run-latest.json');assert.equal(digest(readFileSync(dryPath)),p.simulationHash);
 assert.deepEqual(JSON.parse(json(verifyActions(p.simulationRoot,{implementationOnly:true,startNonce:p.nonce}).actions)),p.deployment);
 const journal:any={planHash:approved,receipts:[],complete:false};const save=()=>writeFileSync(file,json(journal));save();
 const scratch=stage(p);journal.executionRoot=scratch;save();
 const invoke=(phase:'deploy'|'switch')=>{try{const out=execFileSync('bash',[join(scratch,'script/deploy.sh'),'--local-implementation-plan',p.planFile,'--approved-plan-hash',approved,...args(phase)],{cwd:scratch,env:environment(phase==='switch'?p.implementation:undefined),encoding:'utf8',maxBuffer:64*1024*1024});writeFileSync(join(p.directory,phase+'.log'),out);}catch(e:any){writeFileSync(join(p.directory,phase+'.log'),String(e.stdout??'')+'\n'+String(e.stderr??''));throw e;}};
 async function receipts(raw:any,phase:string){
  for(const item of raw.transactions){const r=await pub.getTransactionReceipt({hash:item.hash});const tx=await pub.getTransaction({hash:item.hash});journal.receipts.push({phase,hash:item.hash,gasUsed:r.gasUsed,gasPrice:r.effectiveGasPrice,gasWei:r.gasUsed*r.effectiveGasPrice,block:r.blockNumber,status:r.status,from:tx.from,nonce:tx.nonce,to:tx.to,value:tx.value});save();assert.equal(r.status,'success');assert.equal(tx.value,0n);assert.equal((await pub.getBlock({blockNumber:r.blockNumber})).hash,r.blockHash);assert.equal(tx.input,item.transaction.input);assert.equal(tx.from.toLowerCase(),(phase==='deploy'?p.deployer:p.admin).toLowerCase());assert.equal(tx.nonce,Number(BigInt(item.transaction.nonce)));}
  assert.ok(journal.receipts.length<=p.maxTransactions);assert.ok(journal.receipts.reduce((sum:bigint,r:any)=>sum+BigInt(r.gasWei),0n)<=CAP);save();
 }
 try{
  invoke('deploy');const path=broadcastFile(scratch,'deploy');const raw=JSON.parse(readFileSync(path,'utf8'));assert.deepEqual(matchPlan(JSON.parse(readFileSync(dryPath,'utf8')).transactions,raw.transactions,true),[]);await receipts(raw,'deploy');
  for(const a of p.deployment)assert.equal(keccak256((await pub.getCode({address:a.predictedAddress}))!),a.runtimeCodeHash);
  assert.equal(await pub.readContract({address:p.implementation,abi:poolBalancerAbi,functionName:'profitAccountingVersion'}),1n);assert.equal(await pub.readContract({address:p.implementation,abi:poolBalancerAbi,functionName:'creator'}),'0x0000000000000000000000000000000000000001');
  assert.deepEqual(await factorySnapshot(pub,FACTORY,await pub.getBlockNumber()),p.factorySnapshot);
  run(scratch,args('switch').filter(a=>a!=='--broadcast'),environment(p.implementation),join(p.directory,'switch-simulation.log'));
  const switchDry=JSON.parse(readFileSync(broadcastFile(scratch,'switch',true),'utf8'));assert.equal(switchDry.transactions.length,1);journal.switchNonce=Number(BigInt(switchDry.transactions[0].transaction.nonce));save();
  assert.equal(await pub.getTransactionCount({address:p.admin,blockTag:'pending'}),journal.switchNonce);invoke('switch');const sent=JSON.parse(readFileSync(broadcastFile(scratch,'switch'),'utf8'));assert.equal(sent.transactions.length,1);assert.equal(sent.transactions[0].transaction.input,switchDry.transactions[0].transaction.input);await receipts(sent,'switch');
  const verified=await verifyImplementationUpdate(pub,sent.transactions[0].hash,{verified:true,transactions:{},chainId:31337,balancerFactory:FACTORY,poolBalancerImplementation:p.implementation,initialSettings:p.factorySnapshot});assert.equal(verified.verified,true);journal.postflight=verified;journal.complete=true;save();console.log(json({factory:FACTORY,implementation:p.implementation,receipts:journal.receipts,creationPaused:await pub.readContract({address:FACTORY,abi:balancerFactoryAbi,functionName:'creationPaused'})}));
 }catch(e){journal.failure=String(e);save();throw e;}
}
async function main(){const a=process.argv.slice(2);if(a[0]==='--prepare'){assert.equal(a.length,1);await prepare();return;}assert.ok(a[0]==='--execute'||a[0]==='--gate');assert.equal(a[2],'--approved-plan-hash');const p=await validate(JSON.parse(readFileSync(resolve(a[1]),'utf8')),a[3],a[0]==='--gate'?realpathSync('.'):ROOT);
 if(a[0]==='--gate'){
  assert.notEqual(realpathSync('.'),p.repositoryRoot);assert.ok(!readdirSync('.').some(n=>n==='.env'||n.startsWith('.env.')));assert.equal(a[4],'--');const switchMode=a.slice(5).includes('switchImplementation()');assert.deepEqual(a.slice(5),args(switchMode?'switch':'deploy'));
  for(const [key,value]of Object.entries(baseEnv))assert.equal(process.env[key],value);
  for(const key of Object.keys(process.env))if(/^(FOUNDRY_|DAPP_|ETH_|SOLC_)/.test(key)||key==='PACKS_ADMIN')assert.fail('unexpected deployment environment: '+key);
  assert.equal(process.env.NEW_IMPLEMENTATION,switchMode?p.implementation:undefined);
  assert.deepEqual(await factorySnapshot(pub,FACTORY,await pub.getBlockNumber()),p.factorySnapshot);
  if(!switchMode)assert.equal(await pub.getTransactionCount({address:p.deployer,blockTag:'pending'}),p.nonce);
  else {const journal=JSON.parse(readFileSync(join(p.directory,'journal.json'),'utf8'));assert.equal(journal.planHash,a[3]);assert.equal(await pub.getTransactionCount({address:p.admin,blockTag:'pending'}),journal.switchNonce);assert.equal(keccak256((await pub.getCode({address:p.implementation}))!),p.deployment.at(-1).runtimeCodeHash);}
  return;
 }assert.equal(a.length,4);await execute(JSON.parse(readFileSync(resolve(a[1]),'utf8')),a[3]);}
if(process.argv[1]&&realpathSync(process.argv[1])===realpathSync(new URL(import.meta.url)))main().catch(e=>{console.error(e);process.exitCode=1});
