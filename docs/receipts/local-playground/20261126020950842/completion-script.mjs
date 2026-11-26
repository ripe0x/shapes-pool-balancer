import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createPublicClient,createWalletClient,createTestClient,http,encodeFunctionData,parseAbi,keccak256} from '/Users/dd/CascadeProjects/fwa-pool-balancer/node_modules/viem/_esm/index.js';
import {balancerFactoryAbi,poolBalancerAbi} from '/Users/dd/CascadeProjects/fwa-pool-balancer/shared/abi.ts';
const root='/Users/dd/CascadeProjects/fwa-pool-balancer';
const ref=JSON.parse(readFileSync('/tmp/fwa-fresh-playground-packet-ref.json','utf8'));
const p=JSON.parse(readFileSync(ref.planFile,'utf8')).plan, dir=dirname(ref.planFile);
const original=JSON.parse(readFileSync(join(dir,'journal.json'),'utf8'));
const progress=join(dir,'completion.json');
assert.equal(original.receipts.length,4);
const receipts=original.receipts.slice();
assert.ok(!readFileSync(join(dir,'journal.json'),'utf8').includes('"complete": true'));
const rpc='http://127.0.0.1:8545', pub=createPublicClient({transport:http(rpc,{retryCount:0}),cacheTime:0});
const wallet=createWalletClient({transport:http(rpc)}), test=createTestClient({mode:'anvil',transport:http(rpc)});
const roles={deployer:'0x000000000000000000000000000000000001e001',admin:'0x000000000000000000000000000000000001e004'};
async function identity(){
 assert.equal(await pub.getChainId(),31337);
 assert.equal(execFileSync('lsof',['-nP','-iTCP:8545','-sTCP:LISTEN','-t'],{encoding:'utf8'}).trim(),String(p.node.pid));
 assert.equal(execFileSync('ps',['-p',String(p.node.pid),'-o','command='],{encoding:'utf8'}).trim(),p.node.command);
 const info=await pub.request({method:'anvil_nodeInfo'});assert.equal(info.forkConfig.forkUrl,'https://mainnet.gateway.tenderly.co');assert.equal(info.forkConfig.forkBlockNumber,p.node.forkBlock);
}
await identity();
for(const a of p.deployment)assert.equal(keccak256(await pub.getCode({address:a.predictedAddress})),a.runtimeCodeHash);
for(const r of receipts)assert.equal((await pub.getTransactionReceipt({hash:r.hash})).status,'success');
async function send(from,to,data,gas,nonce){
 await identity();assert.equal(await pub.getTransactionCount({address:from,blockTag:'pending'}),nonce);
 assert.ok(receipts.length<p.maxTransactions);assert.ok(receipts.reduce((s,r)=>s+BigInt(r.gasWei),0n)+gas*20000000000n<=BigInt(p.gasCapWei));
 const offer={account:from,to:to??undefined,data,value:0n,nonce,gas,maxFeePerGas:20000000000n,maxPriorityFeePerGas:50000000n};
 await pub.call(offer);const hash=await wallet.sendTransaction({...offer,chain:null});
 const r=await pub.waitForTransactionReceipt({hash,pollingInterval:25});assert.equal(r.status,'success');
 receipts.push({hash,from,nonce,to,gasUsed:String(r.gasUsed),gasPrice:String(r.effectiveGasPrice),gasWei:String(r.gasUsed*r.effectiveGasPrice),block:String(r.blockNumber)});
 writeFileSync(progress,JSON.stringify({complete:false,receipts},null,2)+'\n');return r;
}
assert.equal(await pub.readContract({address:p.factory,abi:balancerFactoryAbi,functionName:'creationPaused'}),true);
assert.equal((await pub.readContract({address:p.factory,abi:balancerFactoryAbi,functionName:'policyAdmin'})).toLowerCase(),roles.admin.toLowerCase());
await send(roles.admin,p.factory,encodeFunctionData({abi:balancerFactoryAbi,functionName:'setCreationPaused',args:[false]}),100000n,0);
const ripe='0xCB43078C32423F5348Cab5885911C3B5faE217F9';
const balance=await pub.getBalance({address:ripe});await test.setBalance({address:ripe,value:balance+1000n*10n**18n});
assert.equal(await pub.getBalance({address:ripe}),balance+1000n*10n**18n);
const art=JSON.parse(readFileSync(join(root,'out/DevSetup.s.sol/DemoNFT.json'),'utf8'));assert.ok(art.bytecode.object.length>10);
assert.equal(await pub.getCode({address:p.demo})??'0x','0x');
await send(roles.deployer,null,art.bytecode.object,2000000n,p.demoNonce);
const abi=parseAbi(['function mint(address,uint256)','function ownerOf(uint256) view returns(address)']);
for(const id of [1n,2n]){await send(roles.deployer,p.demo,encodeFunctionData({abi,functionName:'mint',args:[roles.admin,id]}),150000n,p.demoNonce+Number(id));assert.equal((await pub.readContract({address:p.demo,abi,functionName:'ownerOf',args:[id]})).toLowerCase(),roles.admin.toLowerCase());}
const implementation=await pub.readContract({address:p.factory,abi:balancerFactoryAbi,functionName:'implementation'});
assert.equal(await pub.readContract({address:implementation,abi:poolBalancerAbi,functionName:'profitAccountingVersion'}),2n);
assert.equal(await pub.readContract({address:p.factory,abi:balancerFactoryAbi,functionName:'creationPaused'}),false);
const result={complete:true,rpc,chainId:31337,nodePid:p.node.pid,factory:p.factory,implementation,fromBlock:receipts[0].block,demo:p.demo,publicCreationPaused:false,wallet:ripe,addedTestETH:'1000',walletBalanceWei:String(await pub.getBalance({address:ripe})),receipts,gasWei:String(receipts.reduce((s,r)=>s+BigInt(r.gasWei),0n)),originalPartialJournal:'journal.json',checkpoint:'/tmp/fwa-8545-fresh-current-state.json'};
writeFileSync(join(dir,'fresh-playground.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({complete:true,nodePid:p.node.pid,factory:p.factory,implementation,creationPaused:false,gasWei:result.gasWei,walletTestETHAdded:1000}));
