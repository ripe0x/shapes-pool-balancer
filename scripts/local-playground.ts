// Existing-node local playground setup. Preparation is read-only; execution requires its exact approved plan hash.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cpSync,existsSync,readdirSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createPublicClient,createTestClient,createWalletClient,decodeFunctionData,encodeFunctionData,getContractAddress,http,keccak256,parseAbi,type Address,type Hex} from 'viem';
import {ARTIFACTS,ROOT,ROLES,copyStagedDependencies,dependencyState,digest,json,manifest,runtimeState,sourceCheck} from './current-local-rehearsal';
import {verifyActions} from './prepare-local-rehearsal';
import {balancerFactoryAbi} from '../shared/abi';
export const RPC='http://127.0.0.1:8545';
const UPSTREAM='https://mainnet.gateway.tenderly.co';
export const FUNDING={deployer:'1000000000000000000',policyAdmin:'100000000000000000000',buyer:'100000000000000000000'};
const MAX_GAS=10n**18n;
const pub=createPublicClient({transport:http(RPC,{retryCount:0,timeout:20000}),cacheTime:0});
export const DEPLOYMENT_VALUES={REUSE_DEPENDENCIES:'true',KEEPER_ADMIN:ROLES.keeperAdmin,POLICY_ADMIN:ROLES.policyAdmin};
const env=()=>({PATH:process.env.PATH,HOME:process.env.HOME,...DEPLOYMENT_VALUES});
export function validateDeploymentEnvironment(values:Record<string,string|undefined>){
 for(const [key,value]of Object.entries(DEPLOYMENT_VALUES))assert.equal(values[key],value,`reviewed ${key}`);
 for(const key of Object.keys(values))if(/^(FOUNDRY_|DAPP_|ETH_|SOLC_)/.test(key)||['IMPLEMENTATION_ONLY','EXISTING_FACTORY','EXPECTED_IMPLEMENTATION','NEW_IMPLEMENTATION','PACKS_ADMIN'].includes(key))assert.fail(`unreviewed deployment environment key: ${key}`);
}
export function stage(p:any){
 const dir=mkdtempSync(join(tmpdir(),'fwa-playground-'));
 for(const i of p.inputs){mkdirSync(dirname(join(dir,i.path)),{recursive:true});cpSync(join(ROOT,i.path),join(dir,i.path),{preserveTimestamps:true});}
 for(const n of ['out','cache'])cpSync(join(ROOT,n),join(dir,n),{recursive:true,preserveTimestamps:true});
 copyStagedDependencies(p,dir);symlinkSync(realpathSync(join(ROOT,'node_modules')),join(dir,'node_modules'));sourceCheck(p,dir);return dir;
}
export async function node(p?:any, expectedUpstream=UPSTREAM){
 assert.equal(await pub.getChainId(),31337,'local chain only');
 const info:any=await pub.request({method:'anvil_nodeInfo' as any});
 assert.ok(expectedUpstream===UPSTREAM || (!!process.env.ALCHEMY_MAINNET_URL && expectedUpstream===process.env.ALCHEMY_MAINNET_URL),'unapproved fork upstream');
 assert.ok(info.forkConfig.forkUrl===expectedUpstream,'unexpected fork upstream');
 if(p?.node?.upstreamHash)assert.equal(digest(info.forkConfig.forkUrl),p.node.upstreamHash);
 const ids=execFileSync('lsof',['-nP','-iTCP:8545','-sTCP:LISTEN','-Fp'],{encoding:'utf8'}).split('\n').filter(s=>s.startsWith('p'));
 assert.equal(ids.length,1);const pid=Number(ids[0].slice(1));
 const command=execFileSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}).trim();
 assert.match(command,/^anvil /);assert.ok(command.includes(`--fork-url ${UPSTREAM}`));assert.ok(command.includes('--chain-id 31337'));assert.ok(command.includes('--port 8545'));
 if(p){assert.equal(pid,p.node.pid);assert.equal(command,p.node.command);assert.equal(info.forkConfig.forkBlockNumber,p.node.forkBlock);}
 return {pid,command,forkBlock:info.forkConfig.forkBlockNumber,upstreamHash:digest(info.forkConfig.forkUrl)};
}
export function bounds(p:any){
 assert.equal(p.schema,'local-playground-8545-v1');assert.equal(p.rpc,RPC);assert.equal(p.chainId,31337);
 assert.deepEqual(p.roles,ROLES);assert.deepEqual(p.funding,FUNDING);assert.deepEqual(p.deploymentEnvironment,DEPLOYMENT_VALUES);assert.equal(p.gasCapWei,String(MAX_GAS));
 assert.equal(p.maxTransactions,12);assert.equal(p.publicCreationPaused,true);assert.equal(p.draws,0);
 assert.deepEqual(p.forgeArguments,['--rpc-url',RPC,'--unlocked','--sender',ROLES.deployer,'--with-gas-price','20000000000','--priority-gas-price','50000000','--slow','--broadcast']);
 assert.equal(realpathSync(p.repositoryRoot),p.repositoryRoot);assert.ok(p.planFile.startsWith(join(p.repositoryRoot,'docs/receipts/local-playground/')));assert.equal(dirname(p.planFile),p.directory);
}
export async function validate(packet:any,approved:string,executedRoot=ROOT){
 assert.equal(packet.planHash,approved,'exact owner-approved playground plan');assert.equal(digest(json(packet.plan)),approved);bounds(packet.plan);sourceCheck(packet.plan,executedRoot);await node(packet.plan);return packet.plan;
}
async function prepare(){
 const identity=await node();
 for(const role of Object.keys(FUNDING)){const address=ROLES[role];assert.equal(await pub.getCode({address})??'0x','0x','clean synthetic account');assert.equal(await pub.getTransactionCount({address,blockTag:'pending'}),0);assert.equal(await pub.getBalance({address}),0n);}
 const directory=join(ROOT,'docs/receipts/local-playground',new Date().toISOString().replace(/[^0-9]/g,''));mkdirSync(directory,{recursive:true});
 const p:any={schema:'local-playground-8545-v1',rpc:RPC,chainId:31337,repositoryRoot:ROOT,revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),directory,planFile:join(directory,'bounded-plan.json'),node:identity,roles:ROLES,funding:FUNDING,deploymentEnvironment:DEPLOYMENT_VALUES,gasCapWei:String(MAX_GAS),maxTransactions:12,publicCreationPaused:true,draws:0,inputs:manifest(),dependencies:dependencyState(),runtime:runtimeState(),artifacts:Object.fromEntries(ARTIFACTS.map(path=>[path,digest(readFileSync(join(ROOT,path)))]))};
 p.sourceFingerprint=digest(json(p.inputs));p.forgeArguments=['--rpc-url',RPC,'--unlocked','--sender',ROLES.deployer,'--with-gas-price','20000000000','--priority-gas-price','50000000','--slow','--broadcast'];
 const scratch=stage(p);const output=execFileSync('forge',['script','script/Deploy.s.sol',...p.forgeArguments.filter((x:string)=>x!=='--broadcast')],{cwd:scratch,env:env(),encoding:'utf8',maxBuffer:64*1024*1024});
 writeFileSync(join(directory,'simulation.log'),output);p.simulationRoot=scratch;p.deployment=verifyActions(scratch).actions;
 const last=p.deployment.at(-1);assert.equal(last.name,'BalancerFactory');p.factory=last.predictedAddress;
 p.demoNonce=p.deployment.length;p.demo=getContractAddress({from:ROLES.deployer,nonce:BigInt(p.demoNonce)});
 assert.ok(p.deployment.reduce((n:bigint,a:any)=>n+BigInt(a.gasLimit)*20000000000n,0n)+10n**17n<MAX_GAS);
 const packet={planHash:digest(json(p)),plan:p};writeFileSync(p.planFile,json(packet));await validate(packet,packet.planHash);console.log(json({planHash:packet.planHash,planFile:p.planFile,factory:p.factory,demo:p.demo,node:p.node,funding:p.funding,actions:p.deployment.map((a:any)=>({name:a.name,address:a.predictedAddress,gasLimit:a.gasLimit})),draws:0,broadcast:false}));
}
async function execute(packet:any,approved:string){
 const p=await validate(packet,approved);const journalFile=join(p.directory,'journal.json');assert.ok(!existsSync(journalFile),'one-shot setup; reconcile any interrupted journal');
 const journal:any={planHash:approved,receipts:[],funded:[],complete:false};const save=()=>writeFileSync(journalFile,json(journal));save();
 const test=createTestClient({mode:'anvil',transport:http(RPC)});const wallet=createWalletClient({transport:http(RPC)});
 async function record(hash:Hex,from:Address,nonce:number,to:Address|null,input:Hex,value:bigint){
  const receipt=await pub.waitForTransactionReceipt({hash,timeout:60000});const tx=await pub.getTransaction({hash});const b=await pub.getBlock({blockNumber:receipt.blockNumber});
  journal.observed={receipt,transaction:tx};save();assert.equal(receipt.status,'success');assert.equal(receipt.blockHash,b.hash);assert.equal(tx.from.toLowerCase(),from.toLowerCase());assert.equal(tx.nonce,nonce);assert.equal(tx.to?.toLowerCase()??null,to?.toLowerCase()??null);assert.equal(tx.input,input);assert.equal(tx.value,value);
  journal.receipts.push({hash,from,nonce,to,input,value,gasUsed:receipt.gasUsed,gasPrice:receipt.effectiveGasPrice,gasWei:receipt.gasUsed*receipt.effectiveGasPrice,block:receipt.blockNumber,blockHash:receipt.blockHash});delete journal.observed;
  assert.ok(journal.receipts.length<=p.maxTransactions);assert.ok(journal.receipts.reduce((n:bigint,r:any)=>n+BigInt(r.gasWei),0n)<=MAX_GAS);save();
 }
 try{
  for(const [role,value]of Object.entries(FUNDING)){const address=ROLES[role];assert.equal(await pub.getCode({address})??'0x','0x');assert.equal(await pub.getTransactionCount({address,blockTag:'pending'}),0);assert.equal(await pub.getBalance({address}),0n);await test.setBalance({address,value:BigInt(value)});await test.impersonateAccount({address});journal.funded.push({role,address,value});save();}
  const scratch=stage(p);journal.scratch=scratch;save();
  const output=execFileSync('bash',[join(scratch,'script/deploy.sh'),'--local-playground-plan',p.planFile,'--approved-plan-hash',approved,...p.forgeArguments],{cwd:scratch,env:env(),encoding:'utf8',maxBuffer:64*1024*1024});writeFileSync(join(p.directory,'deployment.log'),output);
  const raw=JSON.parse(readFileSync(join(scratch,'broadcast/Deploy.s.sol/31337/run-latest.json'),'utf8'));assert.equal(raw.transactions.length,p.deployment.length);
  for(let i=0;i<raw.transactions.length;i++){const a=raw.transactions[i],expected=p.deployment[i];assert.equal(keccak256(a.transaction.input),expected.inputHash);await record(a.hash,ROLES.deployer,i,a.transaction.to??null,a.transaction.input,BigInt(a.transaction.value??0));assert.equal(keccak256((await pub.getCode({address:a.contractAddress}))!),expected.runtimeCodeHash);}
  const art=JSON.parse(readFileSync(join(ROOT,'out/DevSetup.s.sol/DemoNFT.json'),'utf8'));const input=art.bytecode.object as Hex;
  assert.equal(await pub.getTransactionCount({address:ROLES.deployer,blockTag:'pending'}),p.demoNonce);assert.equal(await pub.getCode({address:p.demo})??'0x','0x');
  const h=await wallet.sendTransaction({account:ROLES.deployer,chain:null,data:input,nonce:p.demoNonce,gas:2000000n,maxFeePerGas:20000000000n,maxPriorityFeePerGas:50000000n});await record(h,ROLES.deployer,p.demoNonce,null,input,0n);
  const abi=parseAbi(['function mint(address,uint256)','function ownerOf(uint256) view returns(address)']);
  for(const id of [1n,2n]){const nonce=p.demoNonce+Number(id);await node(p);assert.equal(await pub.getTransactionCount({address:ROLES.deployer,blockTag:"pending"}),nonce);const data=encodeFunctionData({abi,functionName:'mint',args:[ROLES.policyAdmin,id]});console.log(decodeFunctionData({abi,data}));await pub.call({account:ROLES.deployer,to:p.demo,data});const hash=await wallet.sendTransaction({account:ROLES.deployer,chain:null,to:p.demo,data,nonce,gas:150000n,maxFeePerGas:20000000000n,maxPriorityFeePerGas:50000000n});await record(hash,ROLES.deployer,nonce,p.demo,data,0n);assert.equal((await pub.readContract({address:p.demo,abi,functionName:'ownerOf',args:[id]})).toLowerCase(),ROLES.policyAdmin.toLowerCase());}
  assert.equal(await pub.readContract({address:p.factory,abi:balancerFactoryAbi,functionName:'creationPaused'}),true);
  assert.equal((await pub.readContract({address:p.factory,abi:balancerFactoryAbi,functionName:'policyAdmin'})).toLowerCase(),ROLES.policyAdmin.toLowerCase());
  journal.complete=true;save();const values={rpc:RPC,chainId:31337,factory:p.factory,fromBlock:String(journal.receipts[0].block),demo:p.demo,creator:ROLES.policyAdmin,buyer:ROLES.buyer,directory:p.directory};writeFileSync(join(p.directory,'playground.json'),json(values));console.log(json(values));
 }catch(e){journal.failure=String(e);save();throw e;}
}
async function main(){const a=process.argv.slice(2);if(a.length===1&&a[0]==='--prepare'){await prepare();return;}assert.ok((a[0]==='--execute'||a[0]==='--gate')&&a[2]==='--approved-plan-hash');const packet=JSON.parse(readFileSync(resolve(a[1]),'utf8'));if(a[0]==='--gate'){validateDeploymentEnvironment(process.env);assert.notEqual(realpathSync('.'),packet.plan.repositoryRoot,'deployment requires staged sources');assert.ok(!readdirSync('.').some(n=>n==='.env'||n.startsWith('.env.')),'staged deployment must not load hidden environment values');const p=await validate(packet,a[3],resolve('.'));assert.equal(a[4],'--');assert.deepEqual(a.slice(5),p.forgeArguments);assert.equal(await pub.getTransactionCount({address:ROLES.deployer,blockTag:'pending'}),0);return;}assert.equal(a.length,4);await execute(packet,a[3]);}
if(process.argv[1]&&realpathSync(process.argv[1])===realpathSync(new URL(import.meta.url)))main().catch(e=>{console.error(e);process.exitCode=1});
