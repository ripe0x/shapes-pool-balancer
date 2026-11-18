// Local diagnostic executor. A matching reviewed plan hash is required before any node mutation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createTestClient, createWalletClient, decodeFunctionData,
  encodeFunctionData, getContractAddress, http, keccak256, parseAbi, parseAbiItem, toHex,
  type Address, type Hash, type Hex,
} from 'viem';
import { Keeper, MAX_TRANSACTION_GAS, revertName } from '../keeper/keeper';
import { balancerFactoryAbi, erc721Abi, fwaPoolAbi, poolBalancerAbi, shapesAbi } from '../shared/abi';
import { MAX_KEEPER_REWARD, requiredReserveAt, type Counts } from '../shared/planner';

const ROOT = resolve(import.meta.dirname, '..');
const EVIDENCE = join(ROOT, 'docs/receipts/rehearsal-04bc760-preparation');
const prepared = JSON.parse(readFileSync(join(EVIDENCE, 'deployment-actions.json'), 'utf8'));
const REVISION = '04bc760d506fd29329a3a819c7f2e4a1480377dd';
const SOURCE_FINGERPRINT = 'ca02fb070a2a839cccc9fced15b3116613f6d7727d4e50133693dd63a4c92eda';
const codeHashes = JSON.parse(readFileSync(join(EVIDENCE,'deployment-code-hashes.json'),'utf8'));
const demoMaterial = JSON.parse(readFileSync(join(EVIDENCE,'demo-nft.json'),'utf8'));
const ETH = 10n ** 18n, MAX_FEE = 20_000_000_000n, TIP = 50_000_000n, EXIT_RESERVE = ETH / 10n;
const ZERO = `0x${'00'.repeat(32)}` as Hash;
const VRF = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d' as Address;
const FWA = '0x8919814D825a5Af238cC04DE06b1C18c9eaA477C' as Address;
const roles = prepared.actors as Record<'deployer'|'packsAdmin'|'keeperAdmin'|'policyAdmin'|'creatorA'|'creatorB'|'keeper'|'buyer', Address>;
const caps = { deposits: 6n * ETH, gas: ETH, buyer: 40n * ETH, edge: ETH, vrf: 5n * ETH, draws: 252, rounds: 50, replacementCuratedNfts: 252 };
const funding = { deployer: ETH, packsAdmin: ETH / 100n, keeperAdmin: ETH / 100n, policyAdmin: ETH / 100n, creatorA: 31n * ETH / 10n, creatorB: 31n * ETH / 10n, keeper: ETH / 5n, buyer: 40n * ETH };
const serviceAbi = parseAbi(['function coordinator() view returns(address)', 'function rawFulfillRandomWords(uint256,uint256[])', 'function deliverRandomness(uint256) returns(bool)', 'function requestStatus(uint256) view returns(uint8)']);
const demoAbi = parseAbi(['function mint(address,uint256)']);
const extraPoolAbi = parseAbi(['function accruedProtocolFees() view returns(uint256)', 'function weightedBackingTotal() view returns(uint256)', 'function totalWeight() view returns(uint256)', 'function vrfServiceFee() view returns(uint256)', 'function withdrawAcquisitionRefund() returns(uint256)', 'function acquisitionRefundCredit(address) view returns(uint256)']);
const edgeAbi = parseAbi(['function edgeBps() view returns(uint256)']);
const stringify = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? String(x) : x, 2);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const eq = (a: string, b: string) => assert.equal(a.toLowerCase(), b.toLowerCase());
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const route = 'local-rehearsal-plan';
const frozenPlanPath=join(EVIDENCE,'bounded-plan.json');
assert.ok(!flag('--route') && !flag('--owner-approved-local-deploy-waiver'), 'use the explicit local-plan wrapper route only');
const gateConfig = JSON.parse(readFileSync(join(ROOT,'asset-flow.json'),'utf8'));
delete gateConfig.approval; // production approval remains separate; local execution requires exact plan approval
const protectedPaths = [...gateConfig.source_paths,...gateConfig.evidence_paths,'keeper','shared','lib','package.json','package-lock.json','tsconfig.json','test/fixtures/keeper-policy-v1.json'];
const git = (...a:string[]) => execFileSync('git',a,{cwd:ROOT,encoding:'utf8'});
const reportOnlyMissingSourcePaths: string[] = [];
function sourceFingerprint(root=ROOT, archivedWrapper=false, reportOnly=false) {
  const files=execFileSync('git',['ls-files','-z','--',...gateConfig.source_paths,...gateConfig.evidence_paths],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean).sort();
  const hash=createHash('sha256');
  for(const file of files){
    hash.update(`${file}\0`);
    // Missing tracked paths are report data only; guarded modes retain strict reads.
    if(reportOnly && !existsSync(join(root,file))){
      reportOnlyMissingSourcePaths.push(file);
      hash.update('\0deleted tracked source\0');
    } else hash.update(archivedWrapper&&file==='script/deploy.sh'?execFileSync('git',['show',`${REVISION}:script/deploy.sh`],{cwd:ROOT}):readFileSync(join(root,file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}
function sourceCheck() {
  git('merge-base','--is-ancestor',REVISION,'HEAD');
  git('diff','--exit-code','--ignore-submodules=none',REVISION,'--',...protectedPaths,':(exclude)script/deploy.sh');
  assert.equal(git('ls-files','--others','--exclude-standard','--',...protectedPaths).trim(),'','no unreviewed protected input');
  assert.equal(sourceFingerprint(ROOT,true),SOURCE_FINGERPRINT,'exact archived inputs; only material-bound local wrapper overlay is allowed');
}
const materialPaths=['script/deploy.sh','scripts/local-rehearsal-gate.ts','scripts/prepare-local-rehearsal.ts','scripts/run-local-rehearsal.ts','docs/RELEASE-REHEARSAL.md',...['deployment-actions.json','node.json','preflight.json','opening-preview.json','deployment-code-hashes.json','demo-nft.json'].map(n=>`docs/receipts/rehearsal-04bc760-preparation/${n}`)];
const materialHashes=Object.fromEntries(materialPaths.map(path=>[path,sha(readFileSync(join(ROOT,path),'utf8'))]));
const forgeArguments=['--rpc-url',prepared.rpc,'--unlocked','--sender',roles.deployer,'--with-gas-price',String(MAX_FEE),'--priority-gas-price',String(TIP),'--slow','--broadcast'];
const plan = { repositoryRoot:ROOT, archiveRevision:REVISION, forgeArguments, sourceFingerprintScope:'archive04 before material-bound local wrapper overlay; not a new production review seal', localOverlaySourceFingerprint:sourceFingerprint(ROOT,false,args.length===0), sourceFingerprint: SOURCE_FINGERPRINT, materialHashes, plannedDriverDraws:152, uiWrites:'not supported or authorized; separate uncompleted requirement', syntheticContributions: { initialCuratedNfts:4, replacementLimit:caps.replacementCuratedNfts, initialNotionalWei:3n*ETH/2n, replacementNotionalWei:ETH/4n, realMarketValue:'unmeasured; no creator net-profit claim' }, gateConfigHash: sha(stringify(gateConfig)), revision: REVISION, rpc: prepared.rpc, chainId: 31337, forkBlock: prepared.forkBlock, forkHash: prepared.forkHash, roles, funding, caps, route, maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: TIP, perTransactionGas: MAX_TRANSACTION_GAS, closeoutGasReserveWei: EXIT_RESERVE, coordinatorException: true, timeJumpSeconds: 172801, baseline: 'natural EIP-1559', stress: ['3 gwei', '4.9 gwei', '8 gwei'], keeper: 'production Keeper class; controlled ticks and persisted health, not CLI', deployment: prepared.actions, driverHash: sha(readFileSync(import.meta.filename, 'utf8')), documentHash: sha(readFileSync(join(ROOT, 'docs/RELEASE-REHEARSAL.md'), 'utf8')) };
const planHash = sha(stringify(plan));
const pub = createPublicClient({ transport: http(prepared.rpc, { timeout: 60_000 }), cacheTime: 0 });
const test = createTestClient({ mode: 'anvil', transport: http(prepared.rpc, { timeout: 60_000 }) });
const wallet = createWalletClient({ transport: http(prepared.rpc, { timeout: 60_000 }) });
const read = <T,>(address: Address, abi: readonly unknown[], functionName: string, a: unknown[] = [], opts: Record<string, unknown> = {}) => pub.readContract({ address, abi, functionName, args: a, ...opts } as never) as Promise<T>;
type Pool = { creator: Address; demo: Address; balancer: Address; pool: Address; target: bigint; counts: Counts; opening?: unknown };
type Draw = { pool: Address; id: string; buyer: Address; word: string; feeWei: string; edgeReserveWei: string; outcome?: number };
type Receipt = { hash: Hash; function: string; category: string; actor: Address; nonce: number; to: Address|null; value: string; gas: string; gasUsed: string; cost: string; basefee: string; gasPrice: string; status: string };
let dir = '', file = '', coordinator: Address, keeper: Keeper, scratch = '';
let stress: bigint | undefined, closing = false;
let journal: { planHash: string; plan: typeof plan; funded: Record<string,string>; pools: Pool[]; receipts: Receipt[]; draws: Draw[]; deposits: string; buyer: string; edge: string; vrf: string; round: number; nonces: Record<string,number>; checkedBlock: string; checkedHash: Hash; inFlight?: unknown; failure?: string; completed?: boolean; health?: unknown; mutationCount: number; nextNft: number; curatedContributions: {creator:Address;demo:Address;tokenId:string;notionalWei:string;initial:boolean}[]; reports: unknown[] };
const save = () => { writeFileSync(`${file}.tmp`, stringify(journal)); renameSync(`${file}.tmp`, file); };
const paid = () => journal.receipts.reduce((n, r) => n + BigInt(r.cost), 0n);
function budget(cost: bigint, spent = paid(), exit = closing ? 0n : EXIT_RESERVE) { assert.ok(spent + cost + exit <= caps.gas, 'aggregate gas ceiling and closeout reserve'); }
async function nodeCheck(fresh = false) {
  assert.equal(await pub.getChainId(), 31337);
  const info = await pub.request({ method: 'anvil_nodeInfo' as never }) as any;
  assert.equal(info.environment.chainId, 31337);
  assert.equal(info.forkConfig.forkUrl, 'https://mainnet.gateway.tenderly.co');
  assert.equal(String(info.forkConfig.forkBlockNumber), prepared.forkBlock);
  sourceCheck();
  if (fresh) assert.equal((await pub.getBlock()).hash, prepared.forkHash, 'prepared node must still be untouched');
  if(journal && !journal.inFlight){
    assert.equal((await pub.getBlock({blockNumber:BigInt(journal.checkedBlock)})).hash,journal.checkedHash,'no local reorg');
    const tip=await pub.getBlockNumber(), covered=new Set(journal.receipts.map(r=>r.hash));
    for(let number=BigInt(journal.checkedBlock)+1n;number<=tip;number++){
      const block=await pub.getBlock({blockNumber:number,includeTransactions:true});
      for(const tx of block.transactions){assert.ok(typeof tx!=='string');assert.ok(covered.has(tx.hash),'unknown transaction stops shared-budget batch');}
      journal.checkedBlock=String(number);journal.checkedHash=block.hash;
    }
    save();
  }
}
async function mutate(label: string, action: () => Promise<unknown>) {
  await nodeCheck(); assert.ok(!journal.inFlight, 'interrupted action requires manual reconciliation');
  journal.inFlight = { nodeMutation: label }; journal.mutationCount++; save();
  await action(); delete journal.inFlight; save();
}
async function hold() { if (stress !== undefined) await mutate(`stress next basefee ${stress}`, () => test.setNextBlockBaseFeePerGas({ baseFeePerGas: stress! })); }
async function mine(blocks = 1) { for (let i = 0; i < blocks; i++) { await hold(); await mutate('advance service-timing block', () => test.mine({ blocks: 1 })); } }
async function fees() { const b = await pub.getBlock(); const price=(stress ?? b.baseFeePerGas ?? 0n)+TIP; assert.ok(price<=MAX_FEE); return { maxFeePerGas: price, maxPriorityFeePerGas: TIP, quoteGasPrice: price }; }
type ExpectedTransaction = { to:Address|null; value:bigint; kind:'CALL'|'CREATE'|'CREATE2'; created?:Address; runtimeCodeHash?:Hash };
function checkMined(tx:{to:Address|null;value:bigint}, expected:ExpectedTransaction, receiptCreated:Address|null) {
  if(expected.to===null)assert.equal(tx.to,null,'creation target');else {assert.ok(tx.to);eq(tx.to,expected.to);}
  assert.equal(tx.value,expected.value,'reviewed native value');
  if(expected.kind==='CREATE'){assert.ok(expected.created&&receiptCreated);eq(receiptCreated,expected.created);}
  else assert.equal(receiptCreated,null,'CALL/CREATE2 outer receipt must not be CREATE');
}
async function record(hash: Hash, fn: string, category: string, nonce: number, inputHash: Hash, actor: Address, expected:ExpectedTransaction) {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 30_000, pollingInterval: 100 });
  assert.equal(r.transactionHash, hash, 'only the submitted transaction may satisfy this receipt');
  const [tx, block] = await Promise.all([pub.getTransaction({ hash }), pub.getBlock({ blockNumber: r.blockNumber })]);
  assert.ok(!journal.receipts.some(x => x.hash === hash));
  journal.receipts.push({ hash, function: fn, category, actor: tx.from, nonce: tx.nonce, to: tx.to, value: String(tx.value), gas: String(tx.gas), gasUsed: String(r.gasUsed), cost: String(r.gasUsed * r.effectiveGasPrice), basefee: String(block.baseFeePerGas), gasPrice: String(r.effectiveGasPrice), status: r.status }); save();
  eq(tx.from, actor); assert.equal(tx.nonce, nonce); assert.equal(tx.nonce,journal.nonces[actor.toLowerCase()],'expected actor nonce'); assert.equal(keccak256(tx.input), inputHash);
  assert.equal(r.blockHash, block.hash); assert.equal(r.status, 'success', `failed receipt ${hash}`);
  checkMined(tx,expected,r.contractAddress??null);
  if(expected.created){const code=await pub.getCode({address:expected.created,blockNumber:r.blockNumber});assert.ok(code&&code!=='0x','created contract code');assert.equal(keccak256(code),expected.runtimeCodeHash,'reviewed exact runtime codehash');journal.reports.push({created:expected.created,runtimeCodeHash:keccak256(code),block:r.blockNumber});save();}
  assert.ok(tx.gas <= MAX_TRANSACTION_GAS && r.effectiveGasPrice <= MAX_FEE && paid() <= caps.gas);
  if (stress !== undefined) assert.equal(block.baseFeePerGas, stress, 'stress inclusion label');
  journal.nonces[actor.toLowerCase()]=nonce+1;save();
  return { receipt: r, tx, block };
}
function permitted(actor: Address, to: Address|undefined, fn: string, data: Hex, value: bigint) {
  const pool = journal.pools.find(p => to && p.balancer.toLowerCase() === to.toLowerCase());
  const creatorFns = ['configure','listCuratedBatch','depositETH','open','close','withdrawCurated','unlistShapes','claimSurplus','proposeKeeperPolicy','cancelKeeperPolicy','setPaidUpkeepEnabled','performUpkeepUnpaid'];
  if (!to) { assert.ok([roles.creatorA, roles.creatorB].includes(actor)); assert.equal(fn, 'DemoNFT CREATE'); assert.equal(value, 0n); assert.equal(data, demoBytecode()); return; }
  if (pool && creatorFns.includes(fn)) { eq(actor, pool.creator); return; }
  if (pool && fn === 'activateKeeperPolicy') { eq(actor, roles.keeper); assert.equal(value, 0n); return; }
  if (pool && fn === 'performUpkeep') { eq(actor, roles.keeper); assert.equal(value, 0n); return; }
  if (journal.pools.some(p => p.demo.toLowerCase() === to.toLowerCase())) { assert.ok(fn === 'mint' || fn === 'approve'); eq(actor, journal.pools.find(p => p.demo.toLowerCase() === to.toLowerCase())!.creator); assert.equal(value, 0n); return; }
  if (to.toLowerCase() === factory().toLowerCase()) {
    if (fn === 'createBalancer') assert.ok([roles.creatorA,roles.creatorB].includes(actor));
    else if (fn === 'activateDefaultKeeperPolicy') eq(actor, roles.keeper);
    else { assert.ok(['proposeDefaultKeeperPolicy','cancelDefaultKeeperPolicy'].includes(fn)); eq(actor, roles.policyAdmin); }
    assert.equal(value, 0n); return;
  }
  if (journal.pools.some(p => p.pool.toLowerCase() === to.toLowerCase())) { assert.ok(['acquireBatch','withdrawAcquisitionRefund'].includes(fn)); eq(actor, roles.buyer); return; }
  eq(to, VRF); assert.ok(fn === 'rawFulfillRandomWords' || fn === 'deliverRandomness'); eq(actor, fn === 'rawFulfillRandomWords' ? coordinator : roles.buyer); assert.equal(value, 0n);
}
async function submit(actor: Address, to: Address|undefined, data: Hex, fn: string, category: string, value = 0n, gasHint?: bigint, original?: (p: never)=>Promise<Hash>, contract?: Record<string,unknown>) {
  await nodeCheck(); assert.ok(!journal.inFlight, 'no replay after interrupted send'); permitted(actor,to,fn,data,value);
  const quoted = await fees();
  const f = original ? { maxFeePerGas: BigInt(String(contract!.maxFeePerGas)), maxPriorityFeePerGas: BigInt(String(contract!.maxPriorityFeePerGas)) } : quoted;
  assert.ok(f.maxFeePerGas <= MAX_FEE && f.maxPriorityFeePerGas <= TIP);
  const nonce = await pub.getTransactionCount({ address: actor, blockTag: 'pending' });
  assert.equal(nonce,journal.nonces[actor.toLowerCase()],'no unjournaled actor transaction');
  const request = { account: actor, to, data, value, nonce, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas, chain: null };
  await hold(); await pub.call({ ...request, gas: gasHint } as never);
  const gas = gasHint ?? ((await pub.estimateGas(request as never)) * 13n + 9n) / 10n;
  assert.ok(gas <= MAX_TRANSACTION_GAS); budget(gas * f.maxFeePerGas);
  assert.ok(await pub.getBalance({ address: actor }) >= value + gas * f.maxFeePerGas, 'no hidden actor top-up');
  if (fn === 'depositETH') assert.ok(BigInt(journal.deposits) + value <= caps.deposits);
  if (fn === 'acquireBatch') assert.ok(BigInt(journal.buyer) + value <= caps.buyer);
  journal.inFlight = { actor, to, fn, category, nonce, data, value, gas, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas }; save();
  // No mutation other than this send may occur while the journal marks the transaction in flight.
  const hash = original ? await original({ ...contract, ...request, gas } as never) : await wallet.sendTransaction({ ...request, gas } as never);
  journal.inFlight = { ...journal.inFlight as object, hash }; save();
  const result = await record(hash, fn, category, nonce, keccak256(data), actor, {to:to??null,value,kind:to?'CALL':'CREATE',...(!to?{created:getContractAddress({from:actor,nonce:BigInt(nonce)}),runtimeCodeHash:demoMaterial.runtimeCodeHash}: {})});
  if (fn === 'depositETH') journal.deposits = String(BigInt(journal.deposits) + value);
  if (fn === 'acquireBatch') journal.buyer = String(BigInt(journal.buyer) + value);
  delete journal.inFlight; save(); return result;
}
async function send(actor: Address, address: Address, abi: readonly unknown[], fn: string, a: unknown[] = [], value = 0n, category = 'creator', gas?: bigint) {
  const data = encodeFunctionData({ abi, functionName: fn, args: a } as never);
  const decoded = decodeFunctionData({ abi, data } as never); assert.equal(decoded.functionName,fn);
  const result=await submit(actor,address,data,fn,category,value,gas);
  if(fn==='performUpkeepUnpaid')assert.ok(!result.receipt.logs.some(l=>l.address.toLowerCase()===address.toLowerCase()&&l.topics[0]===keccak256(toHex('KeeperPaid(address,uint256,uint256)'))),'unpaid upkeep emitted no payment');
  return result;
}
const factory = () => prepared.actions.find((a: any) => a.name === 'BalancerFactory').predictedAddress as Address;
const policy = () => prepared.actions.find((a: any) => a.name === 'KeeperPolicyV1').predictedAddress as Address;
const demoBytecode = () => demoMaterial.bytecode as Hex;
async function seed(role: keyof typeof funding) {
  const address=roles[role], amount=funding[role];
  assert.ok(!journal.funded[address], 'fund once only');
  assert.ok(!(await pub.getCode({address}))); assert.equal(await pub.getTransactionCount({address}),0); assert.equal(await pub.getBalance({address}),0n);
  await mutate(`fund fresh synthetic ${role}: ${amount}`,()=>test.setBalance({address,value:amount}));
  journal.funded[address]=String(amount); save();
  await mutate(`unlock synthetic ${role}`,()=>test.impersonateAccount({address}));
}
function stage() {
  scratch=mkdtempSync(join(tmpdir(),'fwa-approved-rehearsal-04bc760-'));
  const basePaths=['src','script','foundry.toml','.gitmodules','test','keeper','shared','sim','package.json','package-lock.json','tsconfig.json','asset-flow.json','OWNER-REQUIREMENTS.md','audit','docs/receipts/flow'];
  const paths=[...new Set([...basePaths,...gateConfig.source_paths,...gateConfig.evidence_paths])];
  for(const path of paths)assert.ok(!path.startsWith('/')&&!path.split('/').includes('..')&&!path.split('/').some((part:string)=>/^\.env($|\.)/.test(part)),'safe exact archive path');
  const manifest=git('ls-tree','-r','--name-only',REVISION,'--',...paths).trim().split('\n');
  assert.ok(manifest.every(path=>!path.split('/').some(part=>/^\.env($|\.)/.test(part))),'archive never copies .env files');
  for(const path of gateConfig.evidence_paths)assert.ok(manifest.includes(path),`required evidence is in candidate archive: ${path}`);
  const archive=execFileSync('git',['archive',REVISION,'--',...manifest],{cwd:ROOT,maxBuffer:128*1024*1024});
  execFileSync('tar',['-x','-C',scratch],{input:archive});
  cpSync(join(ROOT,'asset-flow.json'),join(scratch,'asset-flow.json'));
  for(const name of ['audit','docs/receipts/flow']) cpSync(join(ROOT,name),join(scratch,name),{recursive:true,filter:path=>!path.split('/').some(part=>/^\.env($|\.)/.test(part))});
  for(const name of ['out','cache']) cpSync(join(ROOT,name),join(scratch,name),{recursive:true});
  symlinkSync(join(ROOT,'lib'),join(scratch,'lib'));
  const dependencies=realpathSync(dirname(dirname(fileURLToPath(import.meta.resolve('tsx/package.json')))));
  assert.equal(realpathSync(dirname(dirname(fileURLToPath(import.meta.resolve('viem/package.json'))))),dependencies,'tsx and viem share the installed dependency tree');
  symlinkSync(dependencies,join(scratch,'node_modules'));
  execFileSync('git',['init','-q'],{cwd:scratch});
  const cfg=JSON.parse(readFileSync(join(scratch,'asset-flow.json'),'utf8'));
  execFileSync('git',['add','-f','--',...cfg.source_paths,...cfg.evidence_paths],{cwd:scratch});
  assert.equal(sourceFingerprint(scratch),SOURCE_FINGERPRINT,'staged gate inputs match reviewed candidate');
  writeFileSync(join(scratch,'archive-manifest.json'),stringify({revision:REVISION,manifest,requiredEvidence:cfg.evidence_paths,sourceFingerprint:sourceFingerprint(scratch)}));
  // Validate archive04 first; this authorized local-only overlay does not inherit its production review seal.
  cpSync(join(ROOT,'script/deploy.sh'),join(scratch,'script/deploy.sh'));
  cpSync(join(ROOT,'scripts/local-rehearsal-gate.ts'),join(scratch,'scripts/local-rehearsal-gate.ts'));
  assert.equal(sourceFingerprint(scratch),plan.localOverlaySourceFingerprint,'exact local wrapper overlay fingerprint');
  writeFileSync(join(scratch,'local-overlay.json'),stringify({archiveFingerprint:SOURCE_FINGERPRINT,localOverlayFingerprint:sourceFingerprint(scratch),wrapperHash:materialHashes['script/deploy.sh'],verifierHash:materialHashes['scripts/local-rehearsal-gate.ts']}));
  return scratch;
}
const deploymentEnvironment=()=>({PATH:process.env.PATH,HOME:process.env.HOME,PACKS_ADMIN:roles.packsAdmin,KEEPER_ADMIN:roles.keeperAdmin,POLICY_ADMIN:roles.policyAdmin});
function forge(broadcast: boolean) {
  const flags=broadcast?forgeArguments:forgeArguments.filter(arg=>arg!=='--broadcast');
  const command=broadcast?join(scratch,'script/deploy.sh'):'forge';
  const argv=broadcast?['--local-rehearsal-plan',frozenPlanPath,'--approved-plan-hash',planHash,...flags]:['script','script/Deploy.s.sol',...flags];
  try { const out=execFileSync(command,argv,{cwd:scratch,env:deploymentEnvironment(),encoding:'utf8',maxBuffer:64*1024*1024}); writeFileSync(join(dir,`deployment-${broadcast?'broadcast':'simulation'}.log`),out); }
  catch(error) { const e=error as any; writeFileSync(join(dir,`deployment-${broadcast?'broadcast':'simulation'}-failure.log`),String(e.stdout??'')+String(e.stderr??'')); throw error; }
}
async function deploy() {
  forge(false);
  const raw=JSON.parse(readFileSync(join(scratch,'broadcast/Deploy.s.sol/31337/dry-run/run-latest.json'),'utf8'));
  assert.equal(raw.transactions.length,8);
  let reserve=0n;
  raw.transactions.forEach((a:any,i:number)=>{ const tx=a.transaction, expected=prepared.actions[i]; eq(tx.from,roles.deployer);assert.equal(BigInt(tx.nonce),BigInt(i));assert.equal(keccak256(tx.input),expected.inputHash);eq(a.contractAddress,expected.predictedAddress);assert.equal(a.transactionType,expected.type);if(expected.to===null)assert.ok(!tx.to);else eq(tx.to,expected.to);assert.equal(BigInt(tx.value??0),BigInt(expected.valueWei));assert.ok(BigInt(tx.gas)>0n&&BigInt(tx.gas)<=MAX_TRANSACTION_GAS);reserve+=BigInt(tx.gas)*MAX_FEE; });
  budget(reserve); await nodeCheck();
  journal.inFlight={deployment:true,route,transactions:raw.transactions}; save();
  let failure:unknown; try { forge(true); } catch(e) { failure=e; }
  const path=join(scratch,'broadcast/Deploy.s.sol/31337/run-latest.json');
  if(existsSync(path)) { const actual=JSON.parse(readFileSync(path,'utf8')); for(const [i,a]of actual.transactions.entries()) { if(!a.hash) break; if(!(await pub.getTransactionReceipt({hash:a.hash}).catch(()=>null)))break; const expected=prepared.actions[i], code=codeHashes.contracts[i];eq(code.predictedAddress,expected.predictedAddress);await record(a.hash,'Deploy','deployment',i,expected.inputHash,roles.deployer,{to:expected.to,value:BigInt(expected.valueWei),kind:expected.type,created:expected.predictedAddress,runtimeCodeHash:code.runtimeCodeHash}); } }
  if(failure)throw failure;
  assert.equal(journal.receipts.length,8); delete journal.inFlight;save();
  eq(await read<Address>(factory(),balancerFactoryAbi,'defaultKeeperPolicy'),policy());
  eq(await read<Address>(factory(),balancerFactoryAbi,'keeperAdmin'),roles.keeperAdmin);eq(await read<Address>(factory(),balancerFactoryAbi,'policyAdmin'),roles.policyAdmin);
}
async function setup(creator:Address, counts:Counts) {
  const demo=getContractAddress({from:creator,nonce:0n});
  const balancer=await read<Address>(factory(),balancerFactoryAbi,'predictBalancer',[creator,ZERO]);
  const p:Pool={creator,demo,balancer,pool:ZERO.slice(0,42) as Address,target:counts.reduce((t,n,d)=>t|(BigInt(n)<<BigInt(16*d)),0n),counts};
  journal.pools.push(p);save();
  await submit(creator,undefined,demoBytecode(),'DemoNFT CREATE','setup');
  await send(creator,factory(),balancerFactoryAbi,'createBalancer',[ZERO]);
  p.pool=await read<Address>(balancer,poolBalancerAbi,'pool');save();
  eq(await read<Address>(balancer,poolBalancerAbi,'creator'),creator);eq(await read<Address>(p.pool,fwaPoolAbi,'owner'),balancer);
  await send(creator,balancer,poolBalancerAbi,'configure',[1500,p.target]);
  for(let id=1n;id<=2n;id++) { journal.curatedContributions.push({creator,demo,tokenId:String(id),notionalWei:String(id*ETH/4n),initial:true});save();await send(creator,demo,demoAbi,'mint',[creator,id]);await send(creator,demo,erc721Abi,'approve',[balancer,id]); }
  await send(creator,balancer,poolBalancerAbi,'listCuratedBatch',[[{collection:demo,tokenId:1n,base:ETH/4n},{collection:demo,tokenId:2n,base:ETH/2n}]]);
  const b=await pub.getBlock(),fee=await read<bigint>(await read<Address>(balancer,poolBalancerAbi,'SHAPES'),shapesAbi,'mintFee');
  const amount=requiredReserveAt(counts,Array(16).fill(0),fee,0,MAX_KEEPER_REWARD,b.baseFeePerGas??0n);
  await send(creator,balancer,poolBalancerAbi,'depositETH',[],amount);
  const opened=await send(creator,balancer,poolBalancerAbi,'open');
  const actual=await read<bigint>(balancer,poolBalancerAbi,'requiredReserve',[],{blockNumber:opened.receipt.blockNumber});
  assert.ok(amount>=actual,'minimum-targeted open inclusion requirement');
  p.opening={quoteBlock:b.number,quoteBasefee:b.baseFeePerGas,mintFee:fee,deposit:amount,inclusionBlock:opened.receipt.blockNumber,inclusionBasefee:opened.block.baseFeePerGas,requirement:actual,excess:amount-actual};save();
  if(amount>actual)await send(creator,balancer,poolBalancerAbi,'claimSurplus',[amount-actual,creator]);
}
function newKeeper() {
  const k=new Keeper({rpcUrl:prepared.rpc,factory:factory(),fromBlock:BigInt(prepared.forkBlock),stateFile:join(dir,'keeper-state.json'),account:roles.keeper,reorgWindow:4096,priorityGwei:.05,log:(message,extra)=>writeFileSync(join(dir,'keeper-health.json'),stringify({message,...extra,health:k.health()}))});
  const original=k.wallet.writeContract.bind(k.wallet);
  k.wallet.writeContract=(async(params:Record<string,unknown>)=>{assert.deepEqual(k.errors,{});const data=encodeFunctionData(params as never);return(await submit(roles.keeper,params.address as Address,data,String(params.functionName),'keeper',0n,BigInt(String(params.gas)),original,params)).tx.hash;}) as typeof k.wallet.writeContract;
  return k;
}
async function tick() { await hold();await keeper.tick();assert.deepEqual(keeper.errors,{});assert.equal(keeper.state.stats.reverted,0);journal.health=keeper.health();save(); }
async function settled(p:Pool) {return await read<bigint>(p.pool,fwaPoolAbi,'unsettledAcquisitionCount')===0n&&await read<bigint>(p.pool,fwaPoolAbi,'lastIssuedSequence')===await read<bigint>(p.balancer,poolBalancerAbi,'reconciledSequence');}
async function restockCurated(p:Pool) {
  if(closing)return;
  const ids=await read<bigint[]>(p.balancer,poolBalancerAbi,'getActiveIds');let n=0;
  for(const id of ids)if(Number((await read<any[]>(p.balancer,poolBalancerAbi,'items',[id]))[0])===1)n++;
  if(n===0){assert.ok(journal.curatedContributions.filter(c=>!c.initial).length<caps.replacementCuratedNfts,'synthetic replacement NFT cap');const id=BigInt(journal.nextNft++);journal.curatedContributions.push({creator:p.creator,demo:p.demo,tokenId:String(id),notionalWei:String(ETH/4n),initial:false});save();await send(p.creator,p.demo,demoAbi,'mint',[p.creator,id]);await send(p.creator,p.demo,erc721Abi,'approve',[p.balancer,id]);await send(p.creator,p.balancer,poolBalancerAbi,'listCuratedBatch',[[{collection:p.demo,tokenId:id,base:ETH/4n}]]);}
}
async function settle() {
  for(let i=0;i<32;i++){await tick();for(const p of journal.pools)await restockCurated(p);let done=true;for(const p of journal.pools){const have=await read<readonly number[]>(p.balancer,poolBalancerAbi,'getActiveShapes');if(!await settled(p)||(!closing&&have.some((v,d)=>v!==p.counts[d])))done=false;}if(done&&!Object.keys(keeper.state.pending).length&&!Object.keys(keeper.state.accounting).length)return;}
  throw new Error('keeper did not restore/reconcile within bounded ticks');
}
async function snapshot(label:string) {
  const pools=[];
  for(const p of journal.pools){
    const ids=await read<bigint[]>(p.balancer,poolBalancerAbi,'getActiveIds');let backing=0n;
    const shapes=await read<Address>(p.balancer,poolBalancerAbi,'SHAPES');
    for(const id of ids){const item=await read<any[]>(p.balancer,poolBalancerAbi,'items',[id]),l=await read<any[]>(p.pool,fwaPoolAbi,'listings',[id]);eq(await read<Address>(l[0],erc721Abi,'ownerOf',[l[3]]),p.pool);if(Number(item[0])===2){eq(l[0],shapes);backing+=await read<bigint>(shapes,shapesAbi,'backingOf',[l[3]]);}}
    const expected=p.creator===roles.creatorA?ETH/5n:2n*ETH/5n;assert.equal(backing,expected,'absolute real stocked Shape backing');
    pools.push({balancer:p.balancer,fund:await pub.getBalance({address:p.balancer}),profit:await read<bigint>(p.balancer,poolBalancerAbi,'profit'),reserve:await read<bigint>(p.balancer,poolBalancerAbi,'requiredReserve'),fwaOwnerProceeds:await read<bigint>(p.pool,fwaPoolAbi,'ownerProceeds'),actualBacking:backing});
  }
  journal.reports.push({label,block:(await pub.getBlock()).number,basefee:(await pub.getBlock()).baseFeePerGas,pools,gasWei:paid(),buyerSubmittedWei:journal.buyer,edgeReservedWei:journal.edge,vrfActualWei:journal.vrf});save();
}
async function buy(p:Pool,count:number) {
  assert.ok(journal.draws.length+count<=caps.draws); assert.ok(await settled(p));
  const f=await fees();
  const [fee,vrf,total]=await read<readonly[bigint,bigint,bigint]>(p.pool,fwaPoolAbi,'quoteAcquisitionPrice',[BigInt(count)],{account:roles.buyer,gasPrice:f.quoteGasPrice});
  assert.equal(total,BigInt(count)*(fee+vrf));assert.ok(total>0n);
  const w=await read<bigint>(p.pool,extraPoolAbi,'totalWeight'),v=await read<bigint>(p.pool,extraPoolAbi,'weightedBackingTotal'),edge=await read<bigint>(FWA,edgeAbi,'edgeBps');
  const base=v/w;assert.equal(fee,base*(10000n+edge)/10000n,'real FWA edge formula on settled board');
  const edgeReserve=BigInt(count)*(fee-base);assert.ok(BigInt(journal.edge)+edgeReserve<=caps.edge);assert.ok(BigInt(journal.vrf)+BigInt(count)*vrf<=caps.vrf);
  const sequence=await read<bigint>(p.pool,fwaPoolAbi,'lastIssuedSequence'),version=await read<bigint>(p.pool,fwaPoolAbi,'inventoryVersion'),b=await pub.getBlock();
  const before=await pub.getBalance({address:roles.buyer});
  const result=await send(roles.buyer,p.pool,fwaPoolAbi,'acquireBatch',[roles.buyer,BigInt(count),fee,0n,10000n,version,b.timestamp+600n],total,'buyer');
  const actualVrf=await read<bigint>(p.pool,extraPoolAbi,'vrfServiceFee',[],{gasPrice:result.receipt.effectiveGasPrice,blockNumber:result.receipt.blockNumber});
  assert.ok(actualVrf<=vrf,'quoted gas-price upper bound');
  const actualPayment=before-(await pub.getBalance({address:roles.buyer}))-result.receipt.gasUsed*result.receipt.effectiveGasPrice;
  assert.equal(actualPayment,BigInt(count)*(fee+actualVrf),'absolute actual buyer spend including immediate overpayment refund');
  journal.vrf=String(BigInt(journal.vrf)+BigInt(count)*actualVrf);journal.edge=String(BigInt(journal.edge)+edgeReserve);
  for(let n=1;n<=count;n++){const id=await read<bigint>(p.pool,fwaPoolAbi,'requestIdAtSequence',[sequence+BigInt(n)]);journal.draws.push({pool:p.pool,id:String(id),buyer:roles.buyer,word:String(BigInt(keccak256(toHex(BigInt(journal.draws.length+7))))),feeWei:String(fee),edgeReserveWei:String(fee-base)});}save();
}
async function deliver() {
  await mine(3);
  for(const d of journal.draws.filter(d=>d.outcome===undefined)){
    let status=Number(await read<number>(VRF,serviceAbi,'requestStatus',[BigInt(d.id)]));
    if(status===1){await send(coordinator,VRF,serviceAbi,'rawFulfillRandomWords',[BigInt(d.id),[BigInt(d.word)]],0n,'coordinator-exception',5_000_000n);status=Number(await read<number>(VRF,serviceAbi,'requestStatus',[BigInt(d.id)]));}
    if(status===2)await send(roles.buyer,VRF,serviceAbi,'deliverRandomness',[BigInt(d.id)],0n,'service-retry',5_000_000n);
    assert.equal(Number(await read<number>(VRF,serviceAbi,'requestStatus',[BigInt(d.id)])),4,'authenticated word delivered');
  }
}
async function outcomes() {
  const protocol=new Map<string,bigint>(),refunds=new Map<string,bigint>();
  for(const p of journal.pools){
    const edgeLogs=await pub.getLogs({address:p.pool,event:parseAbiItem('event ProtocolFeesAccrued(uint256 indexed requestId,uint256 amount,uint256 total)'),fromBlock:BigInt(prepared.forkBlock),toBlock:'latest'});
    for(const l of edgeLogs)protocol.set(`${p.pool.toLowerCase()}:${l.args.requestId}`,l.args.amount!);
    const refundLogs=await pub.getLogs({address:p.pool,event:parseAbiItem('event AcquisitionRefundedSlippage(uint256 indexed requestId,address indexed purchaser,uint256 refund,uint256 escrowedFee,uint256 liveFee)'),fromBlock:BigInt(prepared.forkBlock),toBlock:'latest'});
    for(const l of refundLogs){eq(l.args.purchaser!,roles.buyer);assert.equal(l.args.refund,l.args.escrowedFee);refunds.set(`${p.pool.toLowerCase()}:${l.args.requestId}`,l.args.refund!);}
  }
  for(const d of journal.draws){const a=await read<any[]>(d.pool,fwaPoolAbi,'acquisitions',[BigInt(d.id)]);const status=Number(a[4]);assert.ok(status===2||status===4,'actual fulfilled or slippage-refunded draw');
    if(status===2){const l=await read<any[]>(d.pool,fwaPoolAbi,'listings',[a[3]]);eq(await read<Address>(l[0],erc721Abi,'ownerOf',[l[3]]),d.buyer);assert.equal(protocol.get(`${d.pool.toLowerCase()}:${d.id}`),BigInt(d.edgeReserveWei),'actual protocol edge accrued');}else assert.equal(refunds.get(`${d.pool.toLowerCase()}:${d.id}`),BigInt(d.feeWei),'exact player slippage refund credit event');d.outcome=status;}save();
}
async function policies() {
  const p=journal.pools[0];
  for(const fn of ['proposeKeeperPolicy','cancelKeeperPolicy','proposeKeeperPolicy'])await send(p.creator,p.balancer,poolBalancerAbi,fn,fn==='cancelKeeperPolicy'?[]:[policy()]);
  for(const fn of ['proposeDefaultKeeperPolicy','cancelDefaultKeeperPolicy','proposeDefaultKeeperPolicy'])await send(roles.policyAdmin,factory(),balancerFactoryAbi,fn,fn==='cancelDefaultKeeperPolicy'?[]:[policy()]);
  for(const [address,abi,fn]of [[p.balancer,poolBalancerAbi,'activateKeeperPolicy'],[factory(),balancerFactoryAbi,'activateDefaultKeeperPolicy']] as const){await assert.rejects(pub.simulateContract({account:roles.keeper,address,abi,functionName:fn,...await fees()} as never),(e:unknown)=>revertName(e)==='PolicyNotReady','early activation must revert with PolicyNotReady');}
  await mutate('approved single policy time jump 172801 seconds',()=>test.increaseTime({seconds:172801}));await mine();
  await send(roles.keeper,p.balancer,poolBalancerAbi,'activateKeeperPolicy');await send(roles.keeper,factory(),balancerFactoryAbi,'activateDefaultKeeperPolicy');
  eq(await read<Address>(p.balancer,poolBalancerAbi,'keeperPolicy'),policy());eq(await read<Address>(journal.pools[1].balancer,poolBalancerAbi,'keeperPolicy'),policy());
  await send(p.creator,p.balancer,poolBalancerAbi,'setPaidUpkeepEnabled',[false]);
  const settings=await read<Hash>(p.balancer,poolBalancerAbi,'settingsHash');
  await assert.rejects(pub.simulateContract({account:roles.keeper,address:p.balancer,abi:poolBalancerAbi,functionName:'performUpkeep',args:[settings,0n],...await fees()} as never),(e:unknown)=>revertName(e)==='PaymentUnavailable','disabled paid path must reject payment');
  await buy(p,1);await deliver();
  for(let n=0;n<12&&!await settled(p);n++)await send(p.creator,p.balancer,poolBalancerAbi,'performUpkeepUnpaid');
  assert.ok(await settled(p));
}
async function closeout() {
  closing=true;stress=undefined;
  for(const p of journal.pools)await send(p.creator,p.balancer,poolBalancerAbi,'close');
  for(const p of journal.pools){for(let n=0;n<16&&!await settled(p);n++)await send(p.creator,p.balancer,poolBalancerAbi,'performUpkeepUnpaid');assert.ok(await settled(p));
    const ids=await read<bigint[]>(p.balancer,poolBalancerAbi,'getActiveIds'),shapes:bigint[]=[];
    for(const id of ids){const item=await read<any[]>(p.balancer,poolBalancerAbi,'items',[id]);if(Number(item[0])===1){const listing=await read<any[]>(p.pool,fwaPoolAbi,'listings',[id]);await send(p.creator,p.balancer,poolBalancerAbi,'withdrawCurated',[id,p.creator]);eq(await read<Address>(listing[0],erc721Abi,'ownerOf',[listing[3]]),p.creator);}else shapes.push(id);}
    for(let i=0;i<shapes.length;i+=20)await send(p.creator,p.balancer,poolBalancerAbi,'unlistShapes',[shapes.slice(i,i+20)]);
    const claim=await read<bigint>(p.balancer,poolBalancerAbi,'withdrawableSurplus');if(claim)await send(p.creator,p.balancer,poolBalancerAbi,'claimSurplus',[claim,p.creator]);
    const refund=await read<bigint>(p.pool,extraPoolAbi,'acquisitionRefundCredit',[roles.buyer]);if(refund)await send(roles.buyer,p.pool,extraPoolAbi,'withdrawAcquisitionRefund',[],0n,'buyer-refund');
    assert.equal(await pub.getBalance({address:p.balancer}),0n);assert.equal(await read<bigint>(p.pool,fwaPoolAbi,'ownerProceeds'),0n);assert.equal((await read<bigint[]>(p.balancer,poolBalancerAbi,'getActiveIds')).length,0);
    assert.equal(await read<bigint>(p.pool,extraPoolAbi,'acquisitionRefundCredit',[roles.buyer]),0n);
    const issued=await read<bigint>(p.pool,fwaPoolAbi,'lastIssuedSequence'),reconciled=await read<bigint>(p.balancer,poolBalancerAbi,'reconciledSequence'),unsettled=await read<bigint>(p.pool,fwaPoolAbi,'unsettledAcquisitionCount');
    assert.equal(issued,reconciled,'final issued/reconciled gap is zero');assert.equal(unsettled,0n,'final unsettled count');assert.equal(await read<bigint>(p.pool,fwaPoolAbi,'activeListingCount'),0n);assert.equal(await read<boolean>(p.balancer,poolBalancerAbi,'enabled'),false);
    journal.reports.push({closeoutPool:p.pool,issued,reconciled,unsettled});save();
  }
  await outcomes();assert.ok(journal.draws.some(d=>d.outcome===2),'at least one real fulfilled draw');
  let rewards=0n;for(const p of journal.pools){const logs=await pub.getLogs({address:p.balancer,event:parseAbiItem('event KeeperPaid(address indexed keeper,uint256 amount,uint256 gasUsed)'),args:{keeper:roles.keeper},fromBlock:BigInt(prepared.forkBlock),toBlock:'latest'});for(const l of logs)rewards+=l.args.amount!;}
  const keeperGas=journal.receipts.filter(r=>r.actor.toLowerCase()===roles.keeper.toLowerCase()).reduce((n,r)=>n+BigInt(r.cost),0n);
  assert.equal(await pub.getBalance({address:roles.keeper}),funding.keeper+rewards-keeperGas,'keeper actual balance reconciles including policy activation gas');
  journal.reports.push({keeperRewardsWei:rewards,keeperAllGasWei:keeperGas,keeperNetWei:rewards-keeperGas});
  journal.reports.push({curatedContributions:journal.curatedContributions,syntheticNftNotionalWei:journal.curatedContributions.reduce((n,c)=>n+BigInt(c.notionalWei),0n),creatorProfitClaim:'not measured; synthetic NFT contributions are not real market value'});
  journal.reports.push({closed:true,gasWei:paid(),depositsWei:journal.deposits,buyerSubmittedWei:journal.buyer,edgeReservedWei:journal.edge,edgeActualWei:journal.draws.filter(d=>d.outcome===2).reduce((n,d)=>n+BigInt(d.edgeReserveWei),0n),vrfActualWei:journal.vrf,fulfilled:journal.draws.filter(d=>d.outcome===2).length,refunded:journal.draws.filter(d=>d.outcome===4).length,keeperHealth:keeper.health(),limitations:['controlled Keeper ticks, not CLI','coordinator impersonation, not real randomness','development unlocked accounts, not real wallet signatures','UI writes not executed by this driver']});journal.completed=true;save();
}
async function execute() {
  assert.equal(option('--approved-plan-hash'),planHash,'explicit approved plan hash must match exact reviewed driver/doc/route');
  const frozen=JSON.parse(readFileSync(frozenPlanPath,'utf8'));assert.equal(frozen.planHash,planHash);assert.equal(sha(stringify(frozen.plan)),planHash,'absolute frozen plan file matches reviewed driver');

  await nodeCheck(true);
  for(const action of prepared.actions)assert.ok(!(await pub.getCode({address:action.predictedAddress})), 'prepared deployment destination must remain vacant');
  for(const address of Object.values(roles)){assert.ok(!(await pub.getCode({address})));assert.equal(await pub.getBalance({address}),0n);assert.equal(await pub.getTransactionCount({address}),0);}
  dir=mkdtempSync(join(tmpdir(),'fwa-rehearsal-journal-04bc760-'));file=join(dir,'journal.json');stage();
  journal={planHash,plan,funded:{},pools:[],receipts:[],draws:[],deposits:'0',buyer:'0',edge:'0',vrf:'0',round:0,nonces:Object.fromEntries(Object.values(roles).map(address=>[address.toLowerCase(),0])),checkedBlock:prepared.forkBlock,checkedHash:prepared.forkHash,mutationCount:0,nextNft:100,curatedContributions:[],reports:[]};save();console.log(stringify({dir,scratch,planHash}));
  // The owner authorized this local gate change, but this batch still needs its separate exact-hash approval.
  try {
    const result=execFileSync(process.execPath,['--import','tsx',join(scratch,'scripts/local-rehearsal-gate.ts'),'--plan',frozenPlanPath,'--approved-plan-hash',planHash,'--phase','prepare','--',...forgeArguments],{cwd:scratch,env:deploymentEnvironment(),encoding:'utf8'});
    const proof=JSON.parse(result);
    assert.equal(proof.planHash,planHash);assert.equal(proof.localPreflight.phase,'prepare');
    assert.equal(proof.localPreflight.chainId,31337);assert.equal(proof.localPreflight.rpc,prepared.rpc);
    writeFileSync(join(dir,'local-plan-prepare.log'),result);
  } catch(error) { const e=error as any; writeFileSync(join(dir,'local-plan-prepare-failed.log'),String(e.stdout??'')+String(e.stderr??'')); throw error; }
  for(const role of Object.keys(funding) as (keyof typeof funding)[])await seed(role);
  await deploy();
  await setup(roles.creatorA,[20,...Array(15).fill(0)]);await setup(roles.creatorB,[5,3,2,...Array(13).fill(0)]);
  coordinator=await read<Address>(VRF,serviceAbi,'coordinator');journal.nonces[coordinator.toLowerCase()]=await pub.getTransactionCount({address:coordinator,blockTag:'pending'});save();assert.ok(await pub.getBalance({address:coordinator})>0n,'existing coordinator funds diagnostic gas');
  await mutate('retained coordinator exception unlock only; no funding',()=>test.impersonateAccount({address:coordinator}));
  keeper=newKeeper();await settle();await snapshot('natural opening fill');
  for(let round=0;round<caps.rounds;round++){
    const nextStress=round>=20&&round<24?3_000_000_000n:round>=28&&round<32?4_900_000_000n:round>=35&&round<39?8_000_000_000n:undefined;
    if(stress!==undefined && nextStress===undefined)await mine(); // consume the last one-block override before natural mode
    stress=nextStress; if(stress!==undefined)await mine();
    if(round===16||round===33){keeper.save();keeper=newKeeper();}
    await buy(journal.pools[round%2],1+round%5);
    // Both pools have pending purchases concurrently, before coordinator delivery or keeper settlement.
    if(round===0)await buy(journal.pools[1],1);
    await deliver();
    if(stress===8_000_000_000n){const sent=keeper.state.stats.sent;await tick();assert.equal(keeper.state.stats.sent,sent,'keeper skipped above V1 gas ceiling');await mine();stress=undefined;for(let n=0;n<16&&((await pub.getBlock()).baseFeePerGas??0n)>4_900_000_000n;n++)await mine();}
    await settle();await outcomes();if([19,23,31,38,49].includes(round))await snapshot(`round ${round+1}, ${stress===undefined?'natural basefee':'controlled gas stress'}`);journal.round=round+1;save();
  }
  stress=undefined;await policies();await closeout();console.log(stringify(journal.reports));
}
if(flag('--check-stage')){sourceCheck();const directory=stage();console.log(stringify({stageCheck:'pass',directory,manifest:JSON.parse(readFileSync(join(directory,'archive-manifest.json'),'utf8')),mutationCount:0}));}
else if(flag('--self-check')){
  sourceCheck();
  const target=roles.creatorA,other=roles.creatorB;
  checkMined({to:target,value:1n},{to:target,value:1n,kind:'CALL'},null);
  assert.throws(()=>checkMined({to:other,value:1n},{to:target,value:1n,kind:'CALL'},null));
  assert.throws(()=>checkMined({to:target,value:2n},{to:target,value:1n,kind:'CALL'},null));
  checkMined({to:null,value:0n},{to:null,value:0n,kind:'CREATE',created:target},target);
  assert.throws(()=>checkMined({to:null,value:0n},{to:null,value:0n,kind:'CREATE',created:target},other));
  assert.equal(Object.values(funding).reduce((a,b)=>a+b,0n),4743n*ETH/100n);
  assert.ok(caps.rounds*5+2<=caps.draws);assert.ok(prepared.actions.every((a:any)=>BigInt(a.gasLimit)<=MAX_TRANSACTION_GAS));
  assert.ok(BigInt(prepared.deploymentGasReserveWei)+EXIT_RESERVE<caps.gas);
  budget(1n,0n);assert.throws(()=>budget(caps.gas,0n),'reserve cannot be spent by normal calls');
  assert.equal(decodeFunctionData({abi:poolBalancerAbi,data:encodeFunctionData({abi:poolBalancerAbi,functionName:'configure',args:[1500,20n]})}).functionName,'configure');
  console.log(stringify({selfCheck:'pass',planHash,route,caps,mutationCount:0}));
}else if(option('--approved-plan-hash'))execute().catch(e=>{if(journal){journal.failure=String(e);save();}console.error(e);process.exitCode=1;});
else console.log(stringify({planHash,plan,reportOnlyMissingSourcePaths,sourceVerification:'not performed; execution requires exact frozen archive inputs',execution:'not authorized; no node requests or writes made'}));
