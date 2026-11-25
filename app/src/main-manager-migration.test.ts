import { encodeAbiParameters, encodeFunctionData, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { packManagerAbi } from '../../shared/main-pool-abi';
import { assertMigrationIdentity, assertMigrationIntent, managerCloneCode, migrationAbi, migrationIdPage, migrationRecoveryPage, sealedMigrationRecovery, boundedMigrationContents, migrationPackCustody, migrationCalls, migrationSpendKey, assertMigrationReady, changeMigrationDetails, invalidateMigrationObservation, migrationObservations, migrationPendingContext, replaceMigrationReceipt, type MigrationReceipt, type Migration } from './main-manager-migration';
import { assertTransactionIntent } from './tx';
import { checkExitSpend, reserveExitSpend, reserveExitReplacement, type SavedExitSpend } from './main-pool-exit';
const addr = (n: number) => `0x${String(n).padStart(40, '0')}` as Address;
const owner=addr(1),source=addr(2),destination=addr(3),fwa=addr(4),implementation=addr(5);
const migration: Migration={destination,packIds:['11'],ethAmount:'100',ethSent:false};
const m={manager:source,owner,fwa,exiting:false,listingPaused:true,balance:0n,book:{ids:[8n],openCount:1n,idle:0,recovery:0,pendingReceipts:0n,credit:0n,witness:8n}};
const input=(functionName:string,args:readonly unknown[])=>encodeFunctionData({abi:[...packManagerAbi,...migrationAbi],functionName,args} as never);
describe('pack-preserving manager migration',()=>{
 it('requires recognized exact Solady clones, same owner and canonical assets',()=>{
  const facts={source,destination,owner,owners:[owner,owner],factory:addr(9),implementations:[implementation,implementation],codes:[managerCloneCode(implementation),managerCloneCode(implementation)] as Hex[],recognized:[true,true],assets:[[fwa,addr(6),addr(7)],[fwa,addr(6),addr(7)]]};
  expect((managerCloneCode(implementation).length-2)/2).toBe(44);
  expect(()=>assertMigrationIdentity(facts)).not.toThrow();
  expect(()=>assertMigrationIdentity({...facts,owners:[owner,addr(8)]})).toThrow('belong');
  expect(()=>assertMigrationIdentity({...facts,recognized:[true,false]})).toThrow('recognized');
  expect(()=>assertMigrationIdentity({...facts,codes:[facts.codes[0],'0x363d3d' as Hex]})).toThrow('recognized');
  expect(()=>assertMigrationIdentity({...facts,assets:[facts.assets[0],[addr(8),addr(6),addr(7)]]})).toThrow('canonical');
  expect(()=>assertMigrationIdentity({...facts,exiting:true})).toThrow('liquidation');
 });
 it('pauses, reuses intact transfers and imports before any later operation',()=>{
  expect(migrationCalls({...m,listingPaused:false} as never,owner,migration,[],[], '0x11',false)[0].functionName).toBe('setListingPaused');
  expect(migrationCalls(m as never,owner,migration,[11n],[], '0x11',false)[0]).toEqual({label:'Transfer idle packs intact to destination',functionName:'withdrawPacks',args:[destination,1n]});
  expect(migrationCalls(m as never,owner,migration,[],[11n], '0x11',false)[0].functionName).toBe('importPacks');
  expect(()=>migrationCalls({...m,exiting:true} as never,owner,migration,[],[],'0x11',true)).toThrow('exit mode');
  expect(migrationCalls({...m,book:{...m.book,openCount:0n,recovery:3}} as never,owner,migration,[],[],'0x11',false,{index:0n,packId:11n})[0]).toEqual({label:'Transfer selected sealed recovery pack intact',functionName:'withdrawRecoveryPack',args:[destination,0n,11n]});
  const calls=migrationCalls(m as never,owner,migration,[],[],'0x11',true);
  expect(calls.map(c=>c.functionName)).toEqual(['recover','unlistForWithdrawal','processAcquisitions']);
  expect(calls.some(c=>['setExiting','recoverLiquidate','liquidate','redeem'].includes(c.functionName))).toBe(false);
 });
 it('selects sealed recovery A without touching the unsealed partial-claim tail B',()=>{
  const zero=addr(0);
  const a={index:0n,packId:11n,unsealed:false,claimant:zero,holder:source,importable:true};
  const b={index:1n,packId:12n,unsealed:true,claimant:source};
  expect(sealedMigrationRecovery(source,[a,b])).toBe(a);
  const recovery={...m,book:{...m.book,ids:[],openCount:0n,recovery:2}};
  const calls=migrationCalls(recovery as never,owner,migration,[],[],'0x11',false,a);
  expect(calls.map(c=>c.functionName)).toEqual(['withdrawRecoveryPack']);
  expect(calls[0].args).toEqual([destination,0n,11n]);
  expect(sealedMigrationRecovery(source,[b])).toBeUndefined();
  expect(()=>migrationCalls({...recovery,book:{...recovery.book,recovery:1}} as never,owner,migration,[],[],'0x11',false)).toThrow('Recovery inventory remains');
  expect(sealedMigrationRecovery(source,[{...a,claimant:owner}])).toBeUndefined();
  expect(sealedMigrationRecovery(source,[{...a,holder:owner}])).toBeUndefined();
 });
 it('leaves a sealed 34-Shape pack tracked at source and selects a supported pack instead',()=>{
  const oversized={index:0n,packId:34n,unsealed:false,claimant:addr(0),holder:source,importable:false};
  const supported={index:1n,packId:3n,unsealed:false,claimant:addr(0),holder:source,importable:true};
  expect(sealedMigrationRecovery(source,[oversized,supported])).toBe(supported);
  expect(sealedMigrationRecovery(source,[oversized])).toBeUndefined();
  const recovery={...m,book:{...m.book,ids:[],openCount:0n,recovery:2}};
  const calls=migrationCalls(recovery as never,owner,migration,[],[],'0x11',false,sealedMigrationRecovery(source,[oversized,supported]));
  expect(calls[0].args).toEqual([destination,1n,3n]);
  expect(()=>migrationCalls(recovery as never,owner,migration,[],[],'0x11',false,sealedMigrationRecovery(source,[oversized]))).toThrow('Recovery inventory remains');
  expect(()=>migrationCalls({...recovery,book:{...recovery.book,recovery:0,idle:1}} as never,owner,migration,[],[],'0x11',false)).toThrow('Unsupported ordinary idle pack');
 });
 it('bounds raw contents before constructing an array and verifies actual backing/custody',()=>{
  const encoded=(count:number)=>encodeAbiParameters([{type:'uint256[]'}],[Array.from({length:count},(_,i)=>BigInt(i+1))]);
  expect(boundedMigrationContents(encoded(3))).toEqual([1n,2n,3n]);
  expect(boundedMigrationContents(encoded(30))).toHaveLength(30);
  expect(boundedMigrationContents(encoded(31))).toBeUndefined();
  expect(boundedMigrationContents(encoded(34))).toBeUndefined();
  expect(boundedMigrationContents(encoded(0))).toBeUndefined();
  expect(boundedMigrationContents(encodeAbiParameters([{type:'uint256[]'}],[[1n,1n]]))).toBeUndefined();
  const packs=addr(7),unit=10000000000000000n;
  const actual=Array.from({length:3},()=>({holder:packs,packId:11n,backing:unit}));
  expect(migrationPackCustody(11n,packs,3n*unit,actual)).toBe(true);
  expect(migrationPackCustody(11n,packs,4n*unit,actual)).toBe(false);
  expect(migrationPackCustody(11n,packs,3n*unit,[{...actual[0],holder:owner},...actual.slice(1)])).toBe(false);
  expect(migrationPackCustody(11n,packs,3n*unit,[{...actual[0],packId:12n},...actual.slice(1)])).toBe(false);
  expect(migrationPackCustody(11n,packs,3n*unit,[{...actual[0],backing:0n},...actual.slice(1)])).toBe(false);
 });
 it('continues bounded recovery pages and never treats one empty page as a whole-book proof',()=>{
  const first=migrationRecoveryPage(18n);
  expect(first.indexes).toHaveLength(16);expect(first.next).toBe(16n);
  expect(sealedMigrationRecovery(source,first.indexes.map(index=>({index,packId:index+1n,unsealed:true,claimant:source})))).toBeUndefined();
  const second=migrationRecoveryPage(18n,String(first.next));
  expect(second.indexes).toEqual([16n,17n]);expect(second.next).toBe(0n);
  const selected=sealedMigrationRecovery(source,[{index:16n,packId:99n,unsealed:false,claimant:addr(0),holder:source,importable:true}]);
  expect(selected?.index).toBe(16n);
  const huge=migrationRecoveryPage(10n**30n,String(10n**29n));
  expect(huge.indexes).toHaveLength(16);expect(huge.indexes[0]).toBe(10n**29n);
  expect(migrationRecoveryPage(1n,'16').start).toBe(0n);
 });
 it('binds recovery recipient, checked index and expected pack identity in signed calldata',()=>{
  const expected={chainId:31337,from:owner,to:source,input:input('withdrawRecoveryPack',[destination,0n,11n]),value:0n};
  expect(()=>assertMigrationIntent(source,owner,migration,fwa,expected)).not.toThrow();
  expect(()=>assertMigrationIntent(source,owner,migration,fwa,{...expected,input:input('withdrawRecoveryPack',[owner,0n,11n])})).toThrow('recipients');
  expect(()=>assertTransactionIntent(expected,{...expected,input:input('withdrawRecoveryPack',[destination,1n,11n])})).toThrow('different transaction');
  expect(()=>assertTransactionIntent(expected,{...expected,input:input('withdrawRecoveryPack',[destination,0n,12n])})).toThrow('different transaction');
 });
 it('checks later preserved-ID batches without rescanning the whole history',()=>{
  const many={...migration,packIds:Array.from({length:40},(_,i)=>String(i+1))};
  expect(migrationIdPage(many)).toEqual(Array.from({length:16},(_,i)=>BigInt(i+1)));
  expect(migrationIdPage({...many,proofCursor:16})).toEqual(Array.from({length:16},(_,i)=>BigInt(i+17)));
  expect(migrationIdPage({...many,proofCursor:32})).toEqual(Array.from({length:8},(_,i)=>BigInt(i+33)));
  expect(migrationIdPage({...many,proofCursor:40})).toEqual([]);
 });
 it('binds token recipient and IDs and rejects liquidating or unrelated migration calls',()=>{
  const intent={from:owner,to:source,input:input('withdrawPacks',[destination,1n]),value:0n};
  expect(()=>assertMigrationIntent(source,owner,migration,fwa,intent)).not.toThrow();
  expect(()=>assertMigrationIntent(source,owner,migration,fwa,{...intent,input:input('withdrawPacks',[owner,1n])})).toThrow('redeem');
  expect(()=>assertMigrationIntent(source,owner,migration,fwa,{...intent,input:input('setExiting',[true])})).toThrow('redeem');
  expect(()=>assertMigrationIntent(source,owner,migration,fwa,{...intent,input:input('recoverLiquidate',[1n])})).toThrow('redeem');
  expect(()=>assertMigrationIntent(source,owner,migration,fwa,{...intent,to:destination,input:input('importPacks',[[12n],`0x${'00'.repeat(32)}`])})).toThrow('IDs');
 });
 it('binds explicit ETH transfer and reserves it plus gas without replenishing replacement allowance',()=>{
  const intent={from:owner,to:destination,input:'0x' as Hex,value:100n};
  expect(()=>assertMigrationIntent(source,owner,migration,fwa,intent)).not.toThrow();
  expect(()=>assertMigrationIntent(source,owner,migration,fwa,{...intent,to:owner})).toThrow('recipient');
  expect(()=>assertMigrationIntent(source,owner,migration,fwa,{...intent,value:101n})).toThrow('amount');
  expect(()=>assertMigrationIntent(source,owner,{...migration,ethSent:true},fwa,intent)).toThrow('recipient');
  const initial:SavedExitSpend={chainId:31337,vault:source,holder:owner,limit:'1000',debited:'0',temporaryFunding:'0',actualGas:'0',migration};
  const max=checkExitSpend({limit:1000n,debited:0n,temporaryFunding:0n,actualGas:0n},100n,8n,100n);
  const reserved=reserveExitSpend(initial,1000n,max,{id:'migration',minimumNonce:0,input:'0x',to:destination,value:'100',maximumDebit:String(max)});
  expect(reserved.debited).toBe('900');expect(reserveExitReplacement(reserved,1000n).debited).toBe('1000');
  expect(()=>reserveExitReplacement(reserved,1001n)).toThrow('explicitly raise');
  expect(migrationSpendKey(31337,source,owner,destination)).not.toBe(migrationSpendKey(31337,source,owner,addr(8)));
 });
 it('invalidates orphaned pack/ETH observations, restores the exact nonce and retains every signed maximum',()=>{
  const receipt:MigrationReceipt={pending:{id:'eth',minimumNonce:4,nonce:4,hash:`0x${'11'.repeat(32)}`,maximumDebit:'900',value:'100',input:'0x',to:destination},blockNumber:'12',blockHash:`0x${'22'.repeat(32)}`,success:true,packIds:[]};
  const pack:MigrationReceipt={...receipt,pending:{...receipt.pending,id:'packs',nonce:3,input:input('withdrawPacks',[destination,1n]),value:'0'},packIds:['11']};
  const canonical=migrationObservations({...migration,manualIds:[],packIds:[]},[pack,receipt],true);
  expect(canonical.ethSent).toBe(true);expect(canonical.packIds).toEqual(['11']);
  const spent:SavedExitSpend={chainId:31337,vault:source,holder:owner,limit:'2000',debited:'1800',temporaryFunding:'100',actualGas:'30',migration:canonical};
  const orphaned=invalidateMigrationObservation(spent,receipt);
  expect(orphaned.debited).toBe('1800');expect(orphaned.pending?.nonce).toBe(4);expect(orphaned.pending?.hash).toBe(receipt.pending.hash);
  expect(orphaned.migration?.ethSent).toBe(false);expect(orphaned.migration?.packIds).toEqual([]);
  expect(()=>assertMigrationReady(orphaned)).toThrow('unresolved');
  expect(()=>reserveExitSpend(orphaned,2000n,1n,{...receipt.pending,id:'duplicate'})).toThrow('unresolved');
  const partial={...orphaned,pending:undefined,migration:{...orphaned.migration!,blocked:undefined,recheck:{cursor:16,head:{number:'20',hash:`0x${'33'.repeat(32)}` as Hex}}}};
  expect(()=>assertMigrationReady(partial)).toThrow('bounded page');
  expect(JSON.parse(JSON.stringify(orphaned))).toEqual(orphaned);
 });
 it('derives effects only from successful canonical receipts and deduplicates replacements by nonce',()=>{
  const receipt:MigrationReceipt={pending:{id:'eth',minimumNonce:4,nonce:4,hash:`0x${'11'.repeat(32)}`,maximumDebit:'900',value:'100',input:'0x',to:destination},blockNumber:'12',blockHash:`0x${'22'.repeat(32)}`,success:true,packIds:[]};
  const reverted={...receipt,success:false,packIds:['11']};
  expect(migrationObservations(migration,[reverted],true).ethSent).toBe(false);
  expect(migrationObservations({...migration,manualIds:[]},[reverted],true).packIds).toEqual([]);
  expect(migrationObservations(migration,[receipt],false).ethSent).toBe(false);
  const replaced={...receipt,pending:{...receipt.pending,hash:`0x${'44'.repeat(32)}` as Hex},blockHash:`0x${'55'.repeat(32)}` as Hex};
  const records=replaceMigrationReceipt({...migration,receipts:[receipt]},replaced);
  expect(records).toHaveLength(1);expect(records[0].pending.hash).toBe(replaced.pending.hash);
  expect(migrationObservations(migration,records,true).ethSent).toBe(true);
 });
 it('cannot retry a reverted ETH intent at a new nonce or reset its amount after a receipt observation',()=>{
  const receipt:MigrationReceipt={pending:{id:'eth',minimumNonce:4,nonce:4,hash:`0x${'11'.repeat(32)}`,maximumDebit:'900',value:'100',input:'0x',to:destination},blockNumber:'12',blockHash:`0x${'22'.repeat(32)}`,success:false,packIds:[]};
  const failed=migrationObservations(migration,[receipt],true);
  const empty={...m,balance:0n,book:{...m.book,ids:[],openCount:0n,idle:0,recovery:0,pendingReceipts:0n,credit:0n}};
  expect(()=>migrationCalls(empty as never,owner,failed,[],[],'0x11',false)).toThrow('No automatic retry');
  expect(()=>changeMigrationDetails(failed,{...migration,ethAmount:'101'})).toThrow('fixed after');
  const successful=migrationObservations(migration,[{...receipt,success:true}],true);
  expect(migrationCalls(empty as never,owner,successful,[],[],'0x11',false)).toEqual([]);
  const resolving=migrationPendingContext(successful,receipt.pending);
  expect(()=>assertMigrationIntent(source,owner,resolving,fwa,{from:owner,to:destination,input:'0x',value:100n})).not.toThrow();
 });

});
