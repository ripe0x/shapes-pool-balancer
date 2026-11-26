// Read-only metered access to the preserved playground; campaign mutations occur only on its child fork.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createPublicClient,http,keccak256} from 'viem';
import {poolBalancerAbi,balancerFactoryAbi} from '../shared/abi';

export const SOURCE='http://127.0.0.1:8545',PROXY_PORT=18557,BRANCH_PORT=18555;
export const MAX_SOURCE_READS=5000,MAX_RUN_MS=30*60*1000;
const ROOT=resolve(import.meta.dirname,'..');
const FACTORY='0xbe49677a403f77136e81498e5681f8dc22aa1181' as const;
const IMPL='0xc02d40577880fa2c489fc5461ce3830d4eed7724' as const;
const METHODS=new Set(['eth_chainId','net_version','web3_clientVersion','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash','eth_getBalance','eth_getTransactionCount','eth_getCode','eth_getStorageAt','eth_getProof','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getBlockReceipts','eth_getLogs','eth_feeHistory']);
export function validateRead(method:string){assert.ok(METHODS.has(method),'read-only fork source method required');}
export function pinnedParams(method:string,params:any[],anchor:bigint,anchorHash?:string){
 const p=structuredClone(params),tag='0x'+anchor.toString(16);
 function block(value:any):any{
  if(value===undefined||['latest','pending','safe','finalized'].includes(value))return tag;
  if(value==='earliest')return '0x0';
  if(typeof value==='object'&&value!==null){
   if(value.blockHash!==undefined){assert.ok(anchorHash&&value.blockHash.toLowerCase()===anchorHash.toLowerCase(),'unanchored state hash');return value;}
   assert.ok(value.blockNumber!==undefined,'invalid block selector');return {...value,blockNumber:block(value.blockNumber)};
  }
  assert.ok(typeof value==='string'&&/^0x[0-9a-f]+$/i.test(value),'invalid block selector');
  assert.ok(BigInt(value)<=anchor,'source block exceeds campaign anchor');return value;
 }
 const position:Record<string,number>={eth_getBalance:1,eth_getTransactionCount:1,eth_getCode:1,eth_getStorageAt:2,eth_getProof:2,eth_getBlockByNumber:0,eth_getBlockReceipts:0,eth_feeHistory:1};
 const i=position[method];if(i!==undefined)p[i]=block(p[i]);
 if(method==='eth_getLogs'&&p[0]){
  if(p[0].blockHash)assert.ok(anchorHash&&p[0].blockHash.toLowerCase()===anchorHash.toLowerCase(),'unanchored log hash');
  else for(const k of ['fromBlock','toBlock'])p[0][k]=block(p[0][k]);
 }
 return p;
}
function freePort(port:number){
 let used='';try{used=execFileSync('lsof',['-nP',`-iTCP:${port}`,'-sTCP:LISTEN','-t'],{encoding:'utf8'}).trim();}catch(e:any){if(e.status!==1)throw e;}
 assert.equal(used,'','campaign port already in use: '+port);
}
const json=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?String(x):x,2);
export async function start(directory:string,resume=false,maxReads=MAX_SOURCE_READS){
 directory=resolve(directory);assert.ok(directory.startsWith(join(ROOT,'docs/receipts/local-stress/')),'campaign receipt directory required');mkdirSync(directory,{recursive:true});
 freePort(PROXY_PORT);if(!resume)freePort(BRANCH_PORT);
 const statsFile=join(directory,'source-meter.json');assert.equal(existsSync(statsFile),resume,'fresh start or explicit metered continuation required');
 assert.ok(Number.isSafeInteger(maxReads)&&maxReads>=MAX_SOURCE_READS&&maxReads<=12000,'bounded source read ceiling');
 const previous:any=resume?JSON.parse(readFileSync(statsFile,'utf8')):undefined;
 if(previous){assert.equal(previous.schema,'local-stress-source-meter-v1');assert.equal(previous.source,SOURCE);assert.equal(previous.sourcePid,28171);assert.ok(!previous.closed,'finished source meter cannot reopen');assert.ok(maxReads>=previous.maxForwardedReads&&previous.forwarded<=maxReads,'source ceiling or spent counter cannot decrease');}
 let deadline=previous?.deadline?Date.parse(previous.deadline):0;
 const stats:any=previous??{schema:'local-stress-source-meter-v1',source:SOURCE,sourcePid:28171,maxForwardedReads:MAX_SOURCE_READS,maxExecutionMs:MAX_RUN_MS,forwarded:0,preflightReads:0,cacheHits:0,refused:0,errors:0,denied:0,exhausted:0,deniedMethods:{},methods:{},closed:false,startedAt:new Date().toISOString()};
 if(previous&&maxReads>previous.maxForwardedReads){(stats.extensions??=[]).push({at:new Date().toISOString(),from:previous.maxForwardedReads,to:maxReads,spent:previous.forwarded,reason:'Initial agent-selected ceiling reached; owner broadly authorized completing the local campaign. Preserve cumulative reads and original deadline; reuse snapshot pool addresses to reduce archive work.'});}
 stats.maxForwardedReads=maxReads;
 const save=()=>writeFileSync(statsFile,json({...stats,deadline:deadline?new Date(deadline).toISOString():null})+'\n');save();
 async function preflight<T>(method:string,fn:()=>Promise<T>){assert.ok(stats.forwarded<maxReads&&(!deadline||Date.now()<deadline),'source preflight budget exhausted');++stats.forwarded;++stats.preflightReads;stats.methods[method]=(stats.methods[method]??0)+1;save();return fn();}
 const p=createPublicClient({transport:http(SOURCE,{retryCount:0,timeout:10000}),cacheTime:0});
 assert.equal(await preflight('eth_chainId',()=>p.getChainId()),31337);const info:any=await preflight('anvil_nodeInfo',()=>p.request({method:'anvil_nodeInfo' as any}));assert.equal(info.forkConfig.forkBlockNumber,26485619);assert.ok(info.forkConfig.forkUrl===process.env.ALCHEMY_MAINNET_URL,'approved configured upstream required');
 const pids=execFileSync('lsof',['-nP','-iTCP:8545','-sTCP:LISTEN','-Fp'],{encoding:'utf8'}).split('\n').filter(x=>x.startsWith('p'));assert.deepEqual(pids,['p28171']);
 const command=execFileSync('ps',['-p','28171','-o','command='],{encoding:'utf8'}).trim();assert.ok(command==='anvil --fork-url https://mainnet.gateway.tenderly.co --chain-id 31337 --port 8545 --silent','source process changed');
 const head=await preflight('eth_getBlockByNumber',()=>p.getBlock(resume?{blockNumber:BigInt(previous.anchor)}:{}));const anchor=head.number;if(resume)assert.equal(head.hash,previous.anchorHash,'original source anchor changed');
 assert.equal((await preflight('eth_call',()=>p.readContract({address:FACTORY,abi:balancerFactoryAbi,functionName:'implementation',blockNumber:anchor}))).toLowerCase(),IMPL);
 assert.equal(await preflight('eth_call',()=>p.readContract({address:IMPL,abi:poolBalancerAbi,functionName:'profitAccountingVersion',blockNumber:anchor})),2n);
 const implementationCodeHash=keccak256((await preflight('eth_getCode',()=>p.getCode({address:IMPL,blockNumber:anchor})))!);
 assert.equal(implementationCodeHash,'0xc281a95f89740fc88e6211a26ce36a2ae9290fddcbc11008f69ba6efab0f57e1');
 assert.equal((await preflight('eth_getBlockByNumber',()=>p.getBlock({blockNumber:anchor}))).hash,head.hash);
 Object.assign(stats,{anchor:String(anchor),anchorHash:head.hash,implementation:IMPL,implementationCodeHash});save();
 const cache=new Map<string,any>(),pending=new Map<string,Promise<any>>();let active=0;const waiters:Array<()=>void>=[];
 async function forward(method:string,params:any[]){
  if(active>=4)await new Promise<void>(done=>waiters.push(done));else ++active;
  try{
   if(stats.closed||stats.forwarded>=maxReads||(deadline&&Date.now()>=deadline)){++stats.exhausted;throw new Error('source budget exhausted');}
   if(!deadline&&stats.forwarded>=100){++stats.exhausted;throw new Error('activate bounded campaign before further reads');}
   ++stats.forwarded;stats.methods[method]=(stats.methods[method]??0)+1;save();
   const r=await fetch(SOURCE,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});
   assert.ok(r.ok,'source HTTP failure');const body:any=await r.json();assert.ok(!body.error,'source RPC failure');
   if(['eth_getBlockByHash','eth_getTransactionByHash','eth_getTransactionReceipt'].includes(method)&&body.result){const n=body.result.blockNumber??body.result.number;assert.ok(n!==null&&n!==undefined&&BigInt(n)<=anchor,'source result beyond anchor');}
   return body.result;
  }catch(e){++stats.errors;throw e;}finally{const next=waiters.shift();if(next)next();else --active;save();}
 }
 async function request(body:any):Promise<any>{
  const id=body?.id??null,method=body?.method;
  // Do not forward Anvil metadata: it contains the source's credential-bearing upstream URL.
  if(method==='anvil_nodeInfo'||method==='anvil_metadata')return {jsonrpc:'2.0',id,error:{code:-32601,message:'Source metadata unavailable'}};
  try{
   try{validateRead(method);}catch(e){++stats.denied;stats.deniedMethods[String(method)]=(stats.deniedMethods[String(method)]??0)+1;throw e;}const params=pinnedParams(method,body.params??[],anchor,head.hash);
   if(method==='eth_blockNumber')return {jsonrpc:'2.0',id,result:'0x'+anchor.toString(16)};
   const key=JSON.stringify([method,params]);let result;
   if(cache.has(key)){++stats.cacheHits;result=cache.get(key);}
   else{let running=pending.get(key);if(!running){running=forward(method,params).then(value=>{cache.set(key,value);return value;}).finally(()=>pending.delete(key));pending.set(key,running);}result=await running;}
   return {jsonrpc:'2.0',id,result};
  }catch{++stats.refused;save();return {jsonrpc:'2.0',id,error:{code:-32090,message:'Read-only source request failed or campaign budget exhausted'}};}
 }
 const server=createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/status'){res.setHeader('content-type','application/json');res.end(json({...stats,deadline:deadline?new Date(deadline).toISOString():null}));return;}
  if(req.method==='POST'&&req.url==='/activate'){deadline ||= Date.now()+MAX_RUN_MS;stats.executionStartedAt ||= new Date().toISOString();save();res.end(json({deadline:new Date(deadline).toISOString()}));return;}
  if(req.method==='POST'&&req.url==='/finish'){stats.closed=true;save();res.end('{"closed":true}');return;}
  if(req.method!=='POST'||req.url!=='/'){res.writeHead(405);res.end();return;}
  let raw='';try{for await(const chunk of req){raw+=chunk;if(raw.length>131072)throw new Error('large source request');}const body=JSON.parse(raw);const out=Array.isArray(body)?await Promise.all(body.map(request)):await request(body);res.setHeader('content-type','application/json');res.end(JSON.stringify(out));}catch{res.writeHead(400);res.end('{"error":"Invalid source request"}');}
 });
 await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(PROXY_PORT,'127.0.0.1',done);});
 const existing:any=resume?JSON.parse(readFileSync(join(directory,'branch.json'),'utf8')):undefined;
 const child=resume?undefined:spawn('anvil',['--fork-url',`http://127.0.0.1:${PROXY_PORT}`,'--fork-block-number',String(anchor),'--fork-chain-id','31337','--chain-id','31337','--port',String(BRANCH_PORT),'--host','127.0.0.1','--accounts','0','--retries','1','--silent'],{cwd:ROOT,stdio:['ignore','ignore','pipe']});
 const branchPid=existing?.branchPid??child?.pid;
 child?.stderr?.on('data',()=>{++stats.errors;save();});child?.once('exit',code=>{stats.branchExit=code;save();});
 try{
 const c=createPublicClient({transport:http(`http://127.0.0.1:${BRANCH_PORT}`,{retryCount:0,timeout:2000}),cacheTime:0});
 let ready=false;for(let i=0;i<100;i++){if(child)assert.ok(child.exitCode===null&&child.signalCode===null,'child fork exited');try{if(await c.getChainId()===31337){ready=true;break;}}catch{}await new Promise(done=>setTimeout(done,100));}
 assert.ok(ready,'child fork did not start');assert.equal(execFileSync('lsof',['-nP',`-iTCP:${BRANCH_PORT}`,'-sTCP:LISTEN','-t'],{encoding:'utf8'}).trim(),String(branchPid),'prepared fork must own branch port');const branchInfo:any=await c.request({method:'anvil_nodeInfo' as any});assert.equal(branchInfo.forkConfig.forkUrl,`http://127.0.0.1:${PROXY_PORT}`);assert.equal(branchInfo.forkConfig.forkBlockNumber,Number(anchor));
 assert.equal(keccak256((await c.getCode({address:IMPL}))!),implementationCodeHash);
 const metadata:any=await c.request({method:'anvil_metadata' as any});
 if(existing)assert.equal(metadata.instanceId,existing.branchInstanceId,'same funded child instance required');
 const output={branchInstanceId:metadata.instanceId,rpc:`http://127.0.0.1:${BRANCH_PORT}`,chainId:31337,branchPid,sourceProxy:`http://127.0.0.1:${PROXY_PORT}`,source:SOURCE,sourcePid:28171,sourceAnchor:String(anchor),sourceAnchorHash:head.hash,factory:FACTORY,implementation:IMPL,implementationCodeHash,directory};writeFileSync(join(directory,'branch.json'),json(output)+'\n');console.log(json(output));
 }catch(e){child?.kill('SIGTERM');server.close();throw e;}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 const args=process.argv.slice(2);assert.ok(args[0]==='--start'||args[0]==='--resume');assert.equal(args[1],'--directory');
 const max=args.length>3?(assert.equal(args[3],'--max-source-reads'),Number(args[4])):MAX_SOURCE_READS;
 start(args[2],args[0]==='--resume',max).catch(()=>{console.error('Stress branch preparation failed; inspect source meter and port ownership.');process.exitCode=1;});
}
