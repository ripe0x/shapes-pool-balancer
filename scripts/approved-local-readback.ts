// Read-only confirmation of the explicitly approved isolated rehearsal; no broadcasts.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createPublicClient,http,parseAbi,keccak256} from 'viem';
import {balancerFactoryAbi,poolBalancerAbi,fwaPoolAbi} from '../shared/abi';
const dir='docs/receipts/launch-preparation';
const p=createPublicClient({transport:http('http://127.0.0.1:18554',{retryCount:0,timeout:20000}),cacheTime:0});
const more=parseAbi(['function acquisitionEscrowTotal() view returns(uint256)','function deliveryEscrowTotal() view returns(uint256)','function acquisitionRefundCreditTotal() view returns(uint256)','function accruedProtocolFees() view returns(uint256)','function ownerProceeds() view returns(uint256)','function unsettledAcquisitionCount() view returns(uint256)','function acquisitionRefundCredit(address) view returns(uint256)']);
const json=(v:any)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x,2);
async function main(){
 const raw=readFileSync(`${dir}/rehearsal-receipts.json`);const j=JSON.parse(raw.toString());const d=JSON.parse(readFileSync(`${dir}/actual-deployment.json`,'utf8'));
 assert.equal(j.completed,true);assert.equal(j.round,50);assert.equal(j.failure,undefined);assert.equal(j.inFlight,undefined);assert.equal(j.activeRound,undefined);
 assert.equal(await p.getChainId(),31337);const info:any=await p.request({method:'anvil_nodeInfo' as any});assert.equal(info.forkConfig.forkUrl,'https://mainnet.gateway.tenderly.co');assert.equal(info.forkConfig.forkBlockNumber,26437802);
 assert.equal(j.pools.length,2);assert.ok(j.draws.length<=252);assert.equal(new Set(j.receipts.map((x:any)=>x.hash)).size,j.receipts.length);
 let gas=0n,deposit=0n,maxGas=0n;const categories:Record<string,bigint>={};const counts:Record<string,number>={};
 for(let i=0;i<j.receipts.length;i+=8) await Promise.all(j.receipts.slice(i,i+8).map(async(x:any)=>{
  const [tx,r]=await Promise.all([p.getTransaction({hash:x.hash}),p.getTransactionReceipt({hash:x.hash})]);const b=await p.getBlock({blockNumber:r.blockNumber});
  assert.equal(r.status,'success');assert.equal(r.blockHash,b.hash);assert.equal(r.gasUsed,BigInt(x.gasUsed));assert.equal(r.effectiveGasPrice,BigInt(x.effectiveGasPrice));assert.equal(tx.value,BigInt(x.value));assert.equal(tx.gas,BigInt(x.gasLimit));assert.equal(b.baseFeePerGas,BigInt(x.basefee));assert.equal(r.gasUsed*r.effectiveGasPrice,BigInt(x.cost));
  assert.ok(tx.gas<=16777216n);if(tx.gas>maxGas)maxGas=tx.gas;gas+=BigInt(x.cost);categories[x.category]=(categories[x.category]??0n)+BigInt(x.cost);counts[x.category]=(counts[x.category]??0)+1;
  if(x.function==='createBalancer'){assert.equal(tx.value,3n*10n**18n);deposit+=tx.value;}else if(x.category!=='buyer') assert.equal(tx.value,0n);
 }));
 assert.equal(deposit,6n*10n**18n);assert.ok(gas<=10n**18n);assert.equal(gas,BigInt(j.summary.totalGasWei));assert.equal(counts.deployment,8);
 const code=await p.getCode({address:d.impl});assert.ok(code);assert.equal((code!.length-2)/2,24449);assert.equal(keccak256(code!),d.implementationCodehash);
 const read=(address:any,abi:any,functionName:any,args:any[]=[])=>p.readContract({address,abi,functionName,args} as any);
 assert.equal(String(await read(d.factory,balancerFactoryAbi,'keeperAdmin')).toLowerCase(),'0x000000000000000000000000000000000001d003');assert.equal(String(await read(d.factory,balancerFactoryAbi,'policyAdmin')).toLowerCase(),'0x000000000000000000000000000000000001d004');assert.equal(String(await read(d.factory,balancerFactoryAbi,'defaultKeeperPolicy')).toLowerCase(),d.policy.toLowerCase());
 const pools=[];let actualIssued=0n;const journalIds=new Set(j.draws.map((x:any)=>`${x.pool.toLowerCase()}:${x.id}`));assert.equal(journalIds.size,j.draws.length);
 for(const pool of j.pools){
  const vals:any={...pool};const issued=BigInt(String(await read(pool.pool,fwaPoolAbi,'lastIssuedSequence')));actualIssued+=issued;for(let seq=1n;seq<=issued;seq++){const id=await read(pool.pool,fwaPoolAbi,'requestIdAtSequence',[seq]);assert.ok(journalIds.has(`${pool.pool.toLowerCase()}:${id}`),'every actual issued draw is covered exactly once');}vals.issuedDraws=issued;for(const fn of ['acquisitionEscrowTotal','deliveryEscrowTotal','acquisitionRefundCreditTotal','accruedProtocolFees','ownerProceeds','unsettledAcquisitionCount'])vals[fn]=await read(pool.pool,more,fn);
  vals.fwaBalance=await p.getBalance({address:pool.pool});const named=vals.acquisitionEscrowTotal+vals.deliveryEscrowTotal+vals.acquisitionRefundCreditTotal+vals.accruedProtocolFees+vals.ownerProceeds;assert.equal(vals.fwaBalance,named,'every FWA wei has a named obligation');assert.equal(vals.unsettledAcquisitionCount,0n);assert.equal(vals.acquisitionEscrowTotal,0n);assert.equal(vals.deliveryEscrowTotal,0n);
  const refunds=new Map<string,bigint>();for(const draw of j.draws.filter((x:any)=>x.pool.toLowerCase()===pool.pool.toLowerCase()&&x.outcome==='slippage-refund'))refunds.set(draw.buyer,(refunds.get(draw.buyer)??0n)+BigInt(draw.refundWei));let credits=0n;for(const [buyer,amount]of refunds){assert.equal(await read(pool.pool,more,'acquisitionRefundCredit',[buyer]),amount);credits+=amount;}assert.equal(credits,vals.acquisitionRefundCreditTotal);
  vals.balancerBalance=await p.getBalance({address:pool.balancer});for(const fn of ['profit','requiredReserve','withdrawableSurplus','admissionStatus','keeperPolicy'])vals[fn]=await read(pool.balancer,poolBalancerAbi,fn);assert.equal(Number(vals.admissionStatus),0);assert.equal(String(vals.keeperPolicy).toLowerCase(),d.policy.toLowerCase());
  pools.push(vals);
 }
 assert.equal(actualIssued,BigInt(j.draws.length));assert.ok(actualIssued<=252n);const outcomes=j.summary.drawOutcomes;assert.equal(outcomes.fulfilled+outcomes.refunded,j.draws.length);assert.equal(pools.reduce((n,x)=>n+x.acquisitionRefundCreditTotal,0n),BigInt(outcomes.refundCreditWei));
 const keeper='0x00000000000000000000000000000000000ce3e5';const keeperBalance=await p.getBalance({address:keeper});assert.equal(keeperBalance-10n**18n,BigInt(j.summary.keeper.rewardWei)-BigInt(j.summary.keeper.gasWei));
 const result={revision:j.revision,checkedUTC:new Date().toISOString(),chainId:31337,forkBlock:26437802,head:await p.getBlockNumber(),journalSha256:createHash('sha256').update(raw).digest('hex'),readOnly:true,passed:true,receipts:j.receipts.length,rounds:j.round,draws:j.draws.length,outcomes,depositWei:deposit,totalGasWei:gas,maxTransactionGasLimit:maxGas,gasByCategoryWei:categories,transactionsByCategory:counts,runtimeBytes:24449,keeperBalanceWei:keeperBalance,pools,limitations:['Independent receipt/readback calculation by lead, not an independent security audit','No request-board creator entitlement reconciliation; E1 remains open','No actual surcharge-receipt coverage calculation; E2 remains open','No refund withdrawals, closing, retirement, policy changes or real-wallet transactions in this batch']};
 writeFileSync(`${dir}/final-readback.json`,json(result));console.log(json(result));
}
main().catch(e=>{console.error(e);process.exitCode=1});
