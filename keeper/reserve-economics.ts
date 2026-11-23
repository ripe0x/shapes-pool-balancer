// Isolated actual-receipt economic review. No keys, external writes, or fabricated protocol state.
// Run after compiling test/ReserveEconomicReview.t.sol: npx tsx keeper/reserve-economics.ts
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, parseEventLogs, toHex, type Address, type Hex } from 'viem';

const RPC='http://127.0.0.1:18552';
const FORK=26382349n;
const A={deployer:'0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',creator:'0x00000000000000000000000000000000000ec001',buyer:'0x00000000000000000000000000000000000ec002',keeper:'0x00000000000000000000000000000000000ec003'} as const;
const VRF='0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d' as const;
const SHAPES='0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0' as const;
const FWA='0x8919814D825a5Af238cC04DE06b1C18c9eaA477C' as const;
const artifacts=(file:string,name:string)=>JSON.parse(readFileSync(`out/${file}.sol/${name}.json`,'utf8'));
const bAbi=artifacts('PoolBalancer','PoolBalancer').abi;
const fAbi=artifacts('BalancerFactory','BalancerFactory').abi;
const nArt=artifacts('ReserveEconomicReview.t','ReserveReviewNFT');
const pArt=artifacts('ReserveEconomicReview.t','ReserveReviewMaxPolicy');
const cArt=artifacts('ReserveEconomicReview.t','ReserveReviewContext');
const poolAbi=parseAbi([
 'event NFTDeliveryFailed(uint256 indexed listingId,address indexed recipient,address collection,uint256 tokenId)',
 'function quoteAcquisitionPrice(uint256 count) view returns(uint256 fee,uint256 vrf,uint256 total)',
 'function inventoryVersion() view returns(uint256)','function lastIssuedSequence() view returns(uint64)',
 'function requestIdAtSequence(uint64) view returns(uint256)','function nextSequenceToProcess() view returns(uint64)',
 'function acquireBatch(address,uint256,uint256,uint256,uint256,uint256,uint256) payable returns(uint256[])',
 'function acquisitionRefundCredit(address) view returns(uint256)','function withdrawAcquisitionRefund() returns(uint256)',
 'function refundFailedDelivery(uint256)','function retired() view returns(bool)','function DELIVERY_WINDOW() view returns(uint256)',
 'function selectionTimeoutBlocks() view returns(uint256)','function ownerProceeds() view returns(uint256)',
 'function accruedProtocolFees() view returns(uint256)','function unsettledAcquisitionCount() view returns(uint256)',
 'function listings(uint256) view returns(address,address,address,uint256,uint256,uint256,uint256,uint8)',
 'function acquisitions(uint256) view returns(address,uint256,uint256,uint256,uint8,bool)',
]);
const serviceAbi=parseAbi(['function coordinator() view returns(address)','function rawFulfillRandomWords(uint256,uint256[])']);
const shapeAbi=parseAbi(['function redeemBatch(uint256[]) returns(uint256)','function mintFee() view returns(uint256)','function ownerOf(uint256) view returns(address)']);
const pub=createPublicClient({transport:http(RPC)});
const test=createTestClient({mode:'anvil',transport:http(RPC)});
const wallet=createWalletClient({transport:http(RPC)});
const bid=BigInt(process.env.REVIEW_BID_WEI ?? "1000000"),base=BigInt(process.env.REVIEW_BASE_WEI ?? "500000");
assert.ok(bid>=base&&base>=0n);
const receipts:{label:string;from:string;gasUsed:bigint;gasPrice:bigint;gasCost:bigint;hash:Hex}[]=[];
const read=async(address:Address,abi:any,functionName:string,args:any[]=[])=>pub.readContract({address,abi,functionName,args,gasPrice:bid} as any) as Promise<any>;
async function ready(){for(let n=0;n<200;n++){try{await pub.getChainId();return;}catch{await new Promise(r=>setTimeout(r,100));}}throw Error('isolated node unavailable');}
async function record(hash:Hex,label:string){
 let r;for(let n=0;!r;n++){try{r=await pub.getTransactionReceipt({hash});}catch(e){if(n===100)throw e;await new Promise(resolve=>setTimeout(resolve,50));}}assert.equal(r.status,'success',label);
 const tx=await pub.getTransaction({hash});const block=await pub.getBlock({blockNumber:r.blockNumber});
 assert.equal(block.baseFeePerGas,base,`included basefee: ${label}`);
 assert.equal(r.effectiveGasPrice,bid,`included bid: ${label}`);
 receipts.push({label,from:tx.from,gasUsed:r.gasUsed,gasPrice:r.effectiveGasPrice,gasCost:BigInt(r.gasUsed)*BigInt(r.effectiveGasPrice),hash});
 return r;
}
async function send(account:Address,address:Address,abi:any,functionName:string,args:any[]=[],value=0n,label=functionName){
 assert.equal(await pub.getChainId(),31337);assert.ok(await pub.getCode({address}),`${label} target has code`);
 await test.setNextBlockBaseFeePerGas({baseFeePerGas:base});
 const hash=await wallet.writeContract({chain:null,account,address,abi,functionName,args,value,gas:8_000_000n,gasPrice:bid} as any);
 return record(hash,label);
}
async function deploy(art:any,label:string,account:Address=A.creator){
 await test.setNextBlockBaseFeePerGas({baseFeePerGas:base});
 const hash=await wallet.deployContract({chain:null,account,abi:art.abi,bytecode:art.bytecode.object,gas:8_000_000n,gasPrice:bid});
 const r=await record(hash,label);assert.ok(r.contractAddress);return r.contractAddress!;
}
async function balance(address:Address){return pub.getBalance({address});}
async function context(probe:Address){
 await send(A.creator,probe,cArt.abi,'record');
 assert.equal(await read(probe,cArt.abi,'observedBaseFee'),base);
 assert.equal(await read(probe,cArt.abi,'observedGasPrice'),bid);
}
async function wealth(){return {creator:await balance(A.creator),buyer:await balance(A.buyer),keeper:await balance(A.keeper)};}
const sum=(s:{creator:bigint;buyer:bigint;keeper:bigint})=>s.creator+s.buyer+s.keeper;
const gasSince=(start:number,actor?:Address)=>receipts.slice(start).filter(r=>!actor||r.from.toLowerCase()===actor.toLowerCase()).reduce((a,r)=>a+r.gasCost,0n);
const scalar=(v:any):any=>typeof v==='bigint'?v.toString():Array.isArray(v)?v.map(scalar):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,scalar(x)])):v;
async function main(){
 assert.notEqual(process.env.RPC_URL,'https://mainnet.gateway.tenderly.co');
 assert.equal(spawnSync('lsof',['-nP','-iTCP:18552','-sTCP:LISTEN'],{stdio:'ignore'}).status,1,'isolated diagnostic port must be free');
 const prior=existsSync('deployments/31337.json')?readFileSync('deployments/31337.json'):null;
 const node=spawn('anvil',['--fork-url','https://mainnet.gateway.tenderly.co','--fork-block-number',FORK.toString(),'--port','18552','--chain-id','31337','--silent'],{stdio:'ignore'});
 try{
  await ready();assert.equal(await pub.getChainId(),31337);
  assert.equal(await pub.getBlockNumber(),FORK,'fresh node, not an existing service');
  assert.equal(String(await pub.request({method:'web3_clientVersion'})).toLowerCase().includes('anvil'),true);
  execFileSync('forge',['script','script/Deploy.s.sol','--rpc-url',RPC,'--unlocked','--sender',A.deployer,'--broadcast','--skip','test'],{env:{...process.env,PACKS_ADMIN:A.deployer,KEEPER_ADMIN:A.deployer,POLICY_ADMIN:A.deployer},stdio:['ignore','pipe','pipe']});
  const factory=JSON.parse(readFileSync('deployments/31337.json','utf8')).balancerFactory as Address;
  assert.ok(await pub.getCode({address:factory}));
  assert.equal((await read(factory,fAbi,'keeperAdmin')).toLowerCase(),A.deployer.toLowerCase());
  for(const a of [A.creator,A.buyer,A.keeper]){
   assert.equal(await pub.getCode({address:a}),undefined,'fresh actor has no delegation');
   await test.impersonateAccount({address:a});await test.setBalance({address:a,value:1000n*10n**18n});
  }
  const start=await wealth();const startReceipts=receipts.length;
  const nft=await deploy(nArt,'creator collection deployment');const policy=await deploy(pArt,'creator hostile policy deployment');const probe=await deploy(cArt,'execution gas probe deployment');
  await context(probe);
  const totals:any[]=[];
  for(const [i,mode] of (process.argv.includes('--failed-only')?['failedDelivery']:['expired','shape','curated','unlist','failedDelivery']).entries()){
   const r0=receipts.length,begin=await wealth();
   const salt=toHex(BigInt(i+1),{size:32});
   const b=await read(factory,fAbi,'predictBalancer',[A.creator,salt]) as Address;
   await send(A.creator,nft,nArt.abi,'mint',[A.creator,BigInt(i+1)]);
   await send(A.creator,nft,nArt.abi,'approve',[b,BigInt(i+1)]);
   const initial=[{collection:nft,tokenId:BigInt(i+1),base:200_000_000_000_000_000n}];
   const config={markupBps:1500,creatorRevenueBps:400,target:20n,mintFeeCap:await read(SHAPES,shapeAbi,'mintFee'),curatedRequired:true};
   await send(A.creator,factory,fAbi,'createBalancer',[salt,config,initial],10n**18n,'atomic create/deposit1ETH');
   const pool=await read(b,bAbi,'pool') as Address;
   await send(A.creator,b,bAbi,'setKeeperPolicy',[policy]);
   for(let j=0;j<4;j++)await send(A.keeper,b,bAbi,'performUpkeep',[await read(b,bAbi,'settingsHash'),0n,0n],0n,'setup 5Shapes');
   assert.equal((await read(b,bAbi,'getActiveShapes'))[0],20);
   assert.equal(await read(b,bAbi,'requiredReserve'),5_300_000n*(base+100_000_000n)+500_000_000_000_000n);
   assert.equal(await read(b,bAbi,'admissionStatus'),0);

   const cycleStart=await wealth();const cycR=receipts.length;
   const fundBefore=await balance(b);let price=0n,vrf=0n,refund=0n,redeemed=0n,edge=0n,newMint=0n;let failedDeliveryEvent:unknown=null;
   if(mode==='unlist'){
    const ids=await read(b,bAbi,'getActiveIds') as bigint[];
    let lid=0n;for(const id of ids){if((await read(b,bAbi,'items',[id]))[0]===2){lid=id;break;}}
    await send(A.creator,b,bAbi,'unlistShapes',[[lid]]);
    assert.equal(await balance(b),fundBefore+10_000_000_000_000_000n);
    await send(A.keeper,b,bAbi,'performUpkeep',[await read(b,bAbi,'settingsHash'),0n,0n]);newMint=1_000_000_000_000_000n;
   }else{
    if(mode==='failedDelivery')await send(A.creator,nft,nArt.abi,'setRefused',[A.buyer]);
    const quote=await read(pool,poolAbi,'quoteAcquisitionPrice',[1n]);[price,vrf]=quote;
    assert.equal(vrf,2_340_000n*bid);
    const version=await read(pool,poolAbi,'inventoryVersion');
    await send(A.buyer,pool,poolAbi,'acquireBatch',[A.buyer,1n,0n,0n,10000n,version,(await pub.getBlock()).timestamp+600n],quote[2]);
    const request=await read(pool,poolAbi,'requestIdAtSequence',[1n]);
    if(mode==='expired'){
     await test.mine({blocks:Number(await read(pool,poolAbi,'selectionTimeoutBlocks'))+1});
    }else{
     // Curated is the first active slot, word zero; the following slot starts after curated's exact weight.
     const curatedListing=await read(pool,poolAbi,'listings',[1n]);
     const word=mode==='curated'||mode==='failedDelivery'?0n:curatedListing[4];
     await test.mine({blocks:3});
     const coordinator=await read(VRF,serviceAbi,'coordinator') as Address;
     await test.impersonateAccount({address:coordinator});
     const delivered=await send(coordinator,VRF,serviceAbi,'rawFulfillRandomWords',[request,[word]],0n,'permitted coordinator delivery');
     if(mode==='failedDelivery'){
      const events=parseEventLogs({abi:poolAbi,logs:delivered.logs,eventName:'NFTDeliveryFailed'});
      assert.equal(events.length,1,'real FWA emits one failed-transfer event');
      failedDeliveryEvent=events[0].args;
      assert.equal(events[0].args.listingId,1n);
      assert.equal(events[0].args.recipient?.toLowerCase(),A.buyer.toLowerCase());
      assert.equal(events[0].args.collection?.toLowerCase(),nft.toLowerCase());
     }
    }
    await send(A.keeper,b,bAbi,'performUpkeep',[await read(b,bAbi,'settingsHash'),0n,0n]);
    assert.equal(await read(b,bAbi,'reconciledSequence'),1n);
    assert.equal(await read(pool,poolAbi,'unsettledAcquisitionCount'),0n);
    const acquisition=await read(pool,poolAbi,'acquisitions',[request]);
    if(mode==='expired'){
     refund=await read(pool,poolAbi,'acquisitionRefundCredit',[A.buyer]);assert.equal(refund,price);
     await send(A.buyer,pool,poolAbi,'withdrawAcquisitionRefund');
     assert.equal(await read(pool,poolAbi,'acquisitionRefundCredit',[A.buyer]),0n);
    }else if(mode==='failedDelivery'){
     assert.equal(acquisition[4],7,'actual refused transfer left delivery pending');
     assert.equal((await read(pool,poolAbi,'listings',[1n]))[7],6,'Listing.status DeliveryPending');
     assert.equal((await read(nft,nArt.abi,'ownerOf',[BigInt(i+1)])).toLowerCase(),pool.toLowerCase(),'failed transfer kept actual NFT in FWA custody');
     assert.equal(await read(pool,poolAbi,'DELIVERY_WINDOW'),604800n,'deployed dependency requires seven days');
     assert.equal((await read(b,bAbi,'items',[1n]))[2],2,'reconciled into pending custody');
     assert.equal(await read(pool,poolAbi,'ownerProceeds'),0n,'escrow never becomes creator income');
     await test.increaseTime({seconds:604801});await test.mine({blocks:1});
     await send(A.buyer,pool,poolAbi,'refundFailedDelivery',[1n]);
     refund=await read(pool,poolAbi,'acquisitionRefundCredit',[A.buyer]);assert.equal(refund,price);
     const buyerBeforeRefund=await balance(A.buyer);
     const refundReceipt=await send(A.buyer,pool,poolAbi,'withdrawAcquisitionRefund');
     assert.equal((await balance(A.buyer))-buyerBeforeRefund+BigInt(refundReceipt.gasUsed)*BigInt(refundReceipt.effectiveGasPrice),price,'buyer received the exact escrow refund after real gas');
     await send(A.creator,b,bAbi,'recoverRefunded',[1n,A.creator]);
     assert.equal(await read(pool,poolAbi,'acquisitionRefundCredit',[A.buyer]),0n);
     assert.equal((await read(b,bAbi,'items',[1n]))[2],0);
     assert.equal((await read(nft,nArt.abi,'ownerOf',[BigInt(i+1)])).toLowerCase(),A.creator.toLowerCase());
    }else{
     assert.equal(acquisition[4],2,'real draw fulfilled');
     const won=await read(pool,poolAbi,'listings',[acquisition[3]]);
     if(mode==='shape'){
      assert.equal(won[0].toLowerCase(),SHAPES.toLowerCase());assert.equal((await read(SHAPES,shapeAbi,'ownerOf',[won[3]])).toLowerCase(),A.buyer.toLowerCase());
      await send(A.buyer,SHAPES,shapeAbi,'redeemBatch',[[won[3]]]);redeemed=10_000_000_000_000_000n;newMint=1_000_000_000_000_000n;
     }else{
      assert.equal(won[0].toLowerCase(),nft.toLowerCase());
      assert.equal(await read(b,bAbi,'admissionStatus'),3,'last curated win honestly pauses');
      await send(A.buyer,nft,nArt.abi,'transferFrom',[A.buyer,A.creator,won[3]],0n,'coalition returns curated prize');
     }
     edge=await read(pool,poolAbi,'accruedProtocolFees');assert.ok(edge>0n);
    }
   }
   const cycleEnd=await wealth();const fundAfter=await balance(b);
   const creatorCredit=await read(b,bAbi,'creatorCredit') as bigint;
   const operatingCash=fundAfter-creatorCredit;
   assert.ok(operatingCash>=0n,'actual cash backs creator credit');
   const cycleGasByActor={creator:gasSince(cycR,A.creator),buyer:gasSince(cycR,A.buyer),keeper:gasSince(cycR,A.keeper)};
   const cycleGas=cycleGasByActor.creator+cycleGasByActor.buyer+cycleGasByActor.keeper;
   const rewards=receipts.slice(cycR).filter(r=>r.from.toLowerCase()===A.keeper.toLowerCase());
   const rewardTotal=cycleEnd.keeper-cycleStart.keeper+gasSince(cycR,A.keeper);
   const buyerKeeperDelta=cycleEnd.buyer+cycleEnd.keeper-cycleStart.buyer-cycleStart.keeper;
   const cycleCoalition=sum(cycleEnd)+fundAfter-sum(cycleStart)-fundBefore;
   assert.equal(cycleCoalition,-(cycleGas+vrf+edge+newMint),'complete coalition gas/VRF/edge/mint reconciliation');
   if(mode==='expired'){if(bid===1_000_000n)assert.ok(buyerKeeperDelta>0n);assert.equal(fundBefore-fundAfter,rewardTotal);}
   await send(A.creator,b,bAbi,'close');
   assert.equal(await read(b,bAbi,'requiredReserve'),0n);
   const active=await read(b,bAbi,'getActiveIds') as bigint[];const shapeIds:bigint[]=[];let remainingCurated=0n;
   for(const id of active){if((await read(b,bAbi,'items',[id]))[0]===2)shapeIds.push(id);else remainingCurated=id;}
   if(shapeIds.length)await send(A.creator,b,bAbi,'unlistShapes',[shapeIds]);
   if(remainingCurated)await send(A.creator,b,bAbi,'withdrawCurated',[remainingCurated,A.creator]);
   await send(A.creator,b,bAbi,'collectProceeds');
   const claim=await read(b,bAbi,'withdrawableSurplus');await send(A.creator,b,bAbi,'claimSurplus',[claim,A.creator]);
   assert.equal(await balance(b),0n);assert.equal(await read(pool,poolAbi,'ownerProceeds'),0n);
   assert.equal((await read(b,bAbi,'getActiveIds')).length,0);
   assert.equal(await balance(pool),edge,'only non-coalition FWA protocol fees remain');
   assert.equal((await read(nft,nArt.abi,'ownerOf',[BigInt(i+1)])).toLowerCase(),A.creator.toLowerCase());
   await send(A.creator,b,bAbi,'retire');assert.equal(await read(pool,poolAbi,'retired'),true);
   const end=await wealth();const actorGas=gasSince(r0,A.creator)+gasSince(r0,A.buyer)+gasSince(r0,A.keeper);
   assert.equal(sum(end)-sum(begin),-(actorGas+20_000_000_000_000_000n+newMint+vrf+edge),'full setup and closeout coalition wealth');
   const result={mode,bid,base,pool,b,creatorRevenueBps:400,creatorCredit,operatingCash,creatorCapitalContribution:10n**18n,additionalCapitalContribution:0n,failedDeliveryEvent,price,vrf,refund,redeemed,edge,initialMintFees:20_000_000_000_000_000n,newMintFees:newMint,cycle:{buyerKeeperDelta,creatorFundCost:fundBefore-fundAfter,keeperReward:rewardTotal,coalitionDelta:cycleCoalition,actorGas:cycleGas,gasByActor:cycleGasByActor,keeperTransactions:rewards.length},fullLifecycle:{creatorDelta:end.creator-begin.creator,buyerDelta:end.buyer-begin.buyer,keeperDelta:end.keeper-begin.keeper,coalitionDelta:sum(end)-sum(begin),actorGas,endingBalancerBalance:await balance(b),endingFwaBalance:await balance(pool)}};
   totals.push(result);console.log(JSON.stringify(scalar(result)));
  }
  const end=await wealth();
  const fullActorGas=gasSince(startReceipts,A.creator)+gasSince(startReceipts,A.buyer)+gasSince(startReceipts,A.keeper);
  const externalFees=totals.reduce((a,t)=>a+t.initialMintFees+t.newMintFees+t.vrf+t.edge,0n);
  assert.equal(sum(end)-sum(start),-(fullActorGas+externalFees),'all creator/buyer/keeper costs including common policy and collection deployments');
  console.log(JSON.stringify(scalar({fork:FORK,rpcSource:'https://mainnet.gateway.tenderly.co',factory,mode:'complete run incl creator collection/policy/probe deployments',coalitionDelta:sum(end)-sum(start),actorGas:gasSince(startReceipts,A.creator)+gasSince(startReceipts,A.buyer)+gasSince(startReceipts,A.keeper),totals,receipts})));
 }finally{
  if(prior)writeFileSync('deployments/31337.json',prior);else if(existsSync('deployments/31337.json'))unlinkSync('deployments/31337.json');
  node.kill();
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
