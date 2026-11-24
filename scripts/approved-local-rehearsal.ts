// Authorized local diagnostic only. Never starts/stops a node or changes production code.
// Coordinator impersonation is the retained owner exception, not a real VRF delivery test.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPublicClient, createTestClient, createWalletClient, decodeFunctionData, getContractAddress,
  http, keccak256, parseAbi, parseAbiItem, toHex, TransactionReceiptNotFoundError, type Address, type Hash, type TransactionReceipt,
} from 'viem';
import { Keeper, MAX_TRANSACTION_GAS } from '../keeper/keeper';
import { balancerFactoryAbi, erc721Abi, fwaPoolAbi, poolBalancerAbi, shapesAbi } from '../shared/abi';
import { SHAPES_IN, prizeBase, restockFeeAt } from '../shared/planner';

const RPC = 'http://127.0.0.1:18554';
const FORK_URL = 'https://mainnet.gateway.tenderly.co';
const FORK_BLOCK = 26437802n;
const REVISION = '9b45f915fcaa27bc24d6125cf4a0062117ef576c';
const ETH = 10n ** 18n;
const CREATORS = ['0x000000000000000000000000000000000001d005', '0x000000000000000000000000000000000001d006'] as const;
const KEEPER = '0x00000000000000000000000000000000000ce3e5' as Address;
const VRF = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d' as Address;
const TARGET = 5n | (3n << 16n) | (2n << 32n);
const ZERO_SALT = `0x${'00'.repeat(32)}` as Hash;
const DIR = resolve('docs/receipts/launch-preparation');
const FILE = resolve(DIR, 'rehearsal-receipts.json');
const STATE_FILE = resolve(DIR, 'rehearsal-keeper-state.json');
const ARTIFACTS = '/private/tmp/launch-prep-deploy-9hvd2spp';
const serviceAbi = parseAbi(['function coordinator() view returns (address)', 'function rawFulfillRandomWords(uint256 requestId,uint256[] randomWords)', 'function deliverRandomness(uint256 requestId) returns(bool)', 'function requestStatus(uint256 requestId) view returns(uint8)', 'function requestPool(uint256 requestId) view returns(address)', 'function storedRandomWord(uint256 requestId) view returns(uint256)']);
const demoAbi = parseAbi(['function mint(address to,uint256 id)']);
const packAbi = parseAbi(['function contentsOf(uint256 id) view returns (uint256[])']);
const pub = createPublicClient({ transport: http(RPC, { timeout: 60_000 }), cacheTime: 0 });
const test = createTestClient({ mode: 'anvil', transport: http(RPC, { timeout: 60_000 }) });
const wallet = createWalletClient({ transport: http(RPC, { timeout: 60_000 }) });
const stringify = (x: unknown) => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const equalAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const read = <T,>(address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>;
interface Entry { hash: Hash; function: string; actor: Address; category: string; value: string; gasLimit: string; gasUsed: string; basefee: string; effectiveGasPrice: string; cost: string; status: string; block: string }
interface Pool { balancer: Address; pool: Address; demo: Address; creator: Address }
interface Draw { pool: Address; id: string; buyer: Address; word: string; outcome?: string; refundWei?: string }
interface Journal {
  rpc: string; forkBlock: string; factory: Address; revision: string; receipts: Entry[]; seeded: Record<string, string>;
  pools: Pool[]; inFlight?: unknown; failure?: string; completed?: boolean; activeRound?: number; round: number; seed: string;
  draws: Draw[]; relistings: number; markupChanges: number; creatorEdits: number; restarts: number;
  keeperStartBalance?: string; keeperStartBlock?: string; periods: Record<string, number>; summary?: unknown;
}
let journal: Journal;
let level = 80_000_000n;
let fatal: unknown;
let coordinator: Address;
const save = () => { writeFileSync(`${FILE}.tmp`, stringify(journal)); renameSync(`${FILE}.tmp`, FILE); };
const paid = () => journal.receipts.reduce((n, r) => n + BigInt(r.cost), 0n);
const hold = () => test.setNextBlockBaseFeePerGas({ baseFeePerGas: level });
async function nodeCheck() {
  assert.equal(await pub.getChainId(), 31337, 'local chain only');
  const info = await pub.request({ method: 'anvil_nodeInfo' as never }) as unknown as { environment: { chainId: number }; forkConfig: { forkUrl: string; forkBlockNumber: number } };
  assert.equal(Number(info.environment.chainId), 31337);
  assert.equal(info.forkConfig.forkUrl, FORK_URL);
  assert.equal(BigInt(info.forkConfig.forkBlockNumber), FORK_BLOCK);
}
async function setLevel(base: bigint) { level = base; await hold(); await test.mine({ blocks: 1 }); await hold(); }
async function record(hash: Hash, fn: string, category: string, expectedBase?: bigint) {
  // Poll the exact hash on this automining diagnostic node. A block watcher timed out
  // on an already-mined callback; do not require another block or replay a send.
  let receipt: TransactionReceipt | undefined;
  for (let n = 0; n < 60; n++) {
    try { receipt = await pub.getTransactionReceipt({ hash }); break; }
    catch (e) { if (!(e instanceof TransactionReceiptNotFoundError)) throw e; }
    await delay(500);
  }
  assert.ok(receipt, `local receipt unavailable: ${hash}`);
  const [tx, block] = await Promise.all([pub.getTransaction({ hash }), pub.getBlock({ blockNumber: receipt.blockNumber })]);
  assert.ok(!journal.receipts.some(r => r.hash === hash), 'receipt recorded exactly once');
  journal.receipts.push({ hash, function: fn, actor: tx.from, category, value: tx.value.toString(), gasLimit: tx.gas.toString(), gasUsed: receipt.gasUsed.toString(), basefee: String(block.baseFeePerGas), effectiveGasPrice: receipt.effectiveGasPrice.toString(), cost: String(receipt.gasUsed * receipt.effectiveGasPrice), status: receipt.status, block: receipt.blockNumber.toString() });
  save(); // Preserve failures and billed gas before any assertion or subsequent send.
  assert.equal(block.hash, receipt.blockHash, 'receipt is on the canonical local chain');
  assert.ok(paid() <= ETH, 'actual gas budget <= 1 ETH');
  assert.ok(tx.gas <= MAX_TRANSACTION_GAS, 'per-transaction gas limit');
  if (expectedBase !== undefined) assert.equal(block.baseFeePerGas, expectedBase, 'actual inclusion basefee');
  assert.equal(receipt.status, 'success', `failed ${fn}: ${hash}`);
  return receipt;
}
async function seedActor(actor: Address, amount: bigint) {
  assert.ok(amount <= (equalAddress(actor, KEEPER) ? ETH : 10n * ETH));
  if (journal.seeded[actor.toLowerCase()]) { await test.impersonateAccount({ address: actor }); return; }
  await nodeCheck();
  assert.ok(!(await pub.getCode({ address: actor })), 'only fresh code-free actor funding');
  assert.equal(await pub.getTransactionCount({ address: actor }), 0, 'fresh actor nonce');
  assert.equal(await pub.getBalance({ address: actor }), 0n, 'fresh actor balance');
  journal.inFlight = { funding: actor, amount }; save();
  await test.impersonateAccount({ address: actor });
  await test.setBalance({ address: actor, value: amount });
  journal.seeded[actor.toLowerCase()] = amount.toString(); delete journal.inFlight; save();
}
async function guardedWrite(params: Record<string, unknown>, category: string, original: (p: never) => Promise<Hash>) {
  if (fatal) throw fatal;
  await nodeCheck();
  assert.ok(!journal.inFlight, 'no replay of an interrupted action');
  const actor = (typeof params.account === 'string' ? params.account : (params.account as { address?: Address })?.address) as Address;
  assert.ok(actor);
  if (category === 'keeper') {
    assert.ok(equalAddress(actor, KEEPER));
    assert.equal(params.functionName, 'performUpkeep');
    assert.ok(journal.pools.some(p => equalAddress(p.balancer, String(params.address))));
    assert.ok(level <= 5_000_000_000n, 'keeper must skip above cap');
  } else {
    assert.ok(equalAddress(actor, coordinator) || journal.seeded[actor.toLowerCase()], 'authorized caller');
    const allowed: Record<string, string[]> = {
      mint: journal.pools.map(p => p.demo), approve: journal.pools.map(p => p.demo),
      listCuratedBatch: journal.pools.map(p => p.balancer), configure: journal.pools.map(p => p.balancer),
      updateCuratedPrice: journal.pools.map(p => p.balancer), acquireBatch: journal.pools.map(p => p.pool),
      rawFulfillRandomWords: [VRF], deliverRandomness: [VRF],
    };
    assert.ok(allowed[String(params.functionName)]?.some(a => equalAddress(a, String(params.address))), 'bounded caller function and destination');
    if (equalAddress(actor, coordinator)) assert.equal(params.functionName, 'rawFulfillRandomWords');
  }
  const maxFeePerGas = category === 'keeper' ? BigInt(String(params.maxFeePerGas)) : 20_000_000_000n;
  const maxPriorityFeePerGas = category === 'keeper' ? BigInt(String(params.maxPriorityFeePerGas)) : 0n;
  await hold();
  const offer = { ...params, account: actor, chain: null, maxFeePerGas, maxPriorityFeePerGas };
  await pub.simulateContract(offer as never);
  const gas = params.gas !== undefined ? BigInt(String(params.gas)) : ((await pub.estimateContractGas(offer as never)) * 13n + 9n) / 10n;
  assert.ok(gas <= MAX_TRANSACTION_GAS);
  assert.ok(paid() + gas * maxFeePerGas <= ETH, 'reserve worst-case gas before broadcast');
  assert.ok(await pub.getBalance({ address: actor }) >= BigInt(String(params.value ?? 0)) + gas * maxFeePerGas, 'actor funds, no hidden top-up');
  journal.inFlight = { category, actor, function: params.functionName, gas, maxFeePerGas }; save();
  await hold();
  const hash = await original({ ...offer, gas } as never);
  journal.inFlight = { ...journal.inFlight as object, hash }; save();
  const receipt = await record(hash, String(params.functionName), category, level);
  delete journal.inFlight; save();
  return { hash, receipt };
}
const send = async (p: Record<string, unknown>, category = 'creator') =>
  (await guardedWrite(p, category, p => wallet.writeContract(p))).receipt;

async function setupPool(creator: Address) {
  await seedActor(creator, 10n * ETH);
  await setLevel(80_000_000n);
  const nonce = await pub.getTransactionCount({ address: creator });
  assert.equal(nonce, 0, 'new creator setup only');
  const balancer = await read<Address>(journal.factory, balancerFactoryAbi, 'predictBalancer', [creator, ZERO_SALT]);
  const demo = getContractAddress({ from: creator, nonce: BigInt(nonce) });
  assert.ok(!(await pub.getCode({ address: balancer })));
  const args = ['script', 'script/DevSetup.s.sol', '--tc', 'DevSetup', '--rpc-url', RPC, '--unlocked', '--sender', creator, '--with-gas-price', '500000000', '--slow', '--out', `${ARTIFACTS}/out`, '--cache-path', `${ARTIFACTS}/cache`];
  const env = { ...process.env, FACTORY: journal.factory, SALT: '0' };
  const execute = (broadcast: boolean) => {
    try {
      const log = execFileSync('forge', [...args, ...(broadcast ? ['--broadcast'] : [])], { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      writeFileSync(resolve(DIR, `setup-${creator}-${broadcast ? 'broadcast' : 'dry-run'}.log`), log);
    } catch (e) {
      writeFileSync(resolve(DIR, `setup-${creator}-failure.log`), String((e as { stdout?: unknown }).stdout ?? '') + String((e as { stderr?: unknown }).stderr ?? '') + String(e)); throw e;
    }
  };
  execute(false);
  type Action = { transactionType: string; contractAddress: Address; transaction: { from: Address; to?: Address; input: Hash; nonce: string; gas: string; value: string } };
  const dry = JSON.parse(readFileSync('broadcast/DevSetup.s.sol/31337/dry-run/run-latest.json', 'utf8')) as { transactions: Action[] };
  assert.equal(dry.transactions.length, 9, 'unchanged DevSetup actions');
  const expected = ['CREATE', 'createBalancer', 'configure', 'mint', 'approve', 'mint', 'approve', 'listCuratedBatch', 'open'];
  let reserve = 0n;
  for (const [i, a] of dry.transactions.entries()) {
    const tx = a.transaction;
    assert.ok(equalAddress(tx.from, creator));
    assert.equal(BigInt(tx.nonce), BigInt(nonce + i));
    const gas = BigInt(tx.gas); assert.ok(gas > 0n && gas <= MAX_TRANSACTION_GAS);
    reserve += gas * 500_000_000n;
    assert.equal(BigInt(tx.value ?? '0'), i === 1 ? 3n * ETH : 0n);
    if (i === 0) {
      assert.equal(a.transactionType, 'CREATE'); assert.ok(!tx.to); assert.ok(equalAddress(a.contractAddress, demo));
      const artifact = JSON.parse(readFileSync(`${ARTIFACTS}/out/DevSetup.s.sol/DemoNFT.json`, 'utf8'));
      assert.equal(tx.input.toLowerCase(), artifact.bytecode.object.toLowerCase());
      continue;
    }
    const abi = i === 1 ? balancerFactoryAbi : i === 3 || i === 5 ? demoAbi : i === 4 || i === 6 ? erc721Abi : poolBalancerAbi;
    const d = decodeFunctionData({ abi, data: tx.input });
    assert.equal(d.functionName, expected[i]);
    assert.ok(equalAddress(tx.to!, i === 1 ? journal.factory : [3, 4, 5, 6].includes(i) ? demo : balancer));
    const v = (d.args ?? []) as readonly unknown[];
    if (i === 1) assert.deepEqual(v, [ZERO_SALT]);
    if (i === 2) assert.deepEqual(v, [1500, TARGET]);
    if (i === 3 || i === 5) { assert.ok(equalAddress(String(v[0]), creator)); assert.equal(v[1], i === 3 ? 1n : 2n); }
    if (i === 4 || i === 6) { assert.ok(equalAddress(String(v[0]), balancer)); assert.equal(v[1], i === 4 ? 1n : 2n); }
    if (i === 7) {
      const items = v[0] as { collection: Address; tokenId: bigint; base: bigint }[];
      assert.equal(items.length, 2);
      items.forEach((item, n) => { assert.ok(equalAddress(item.collection, demo)); assert.equal(item.tokenId, BigInt(n + 1)); assert.equal(item.base, BigInt(n + 1) * ETH / 4n); });
    }
    if (i === 8) assert.equal(v.length, 0);
  }
  assert.ok(paid() + reserve <= ETH, 'entire setup worst-case gas reserved');
  await nodeCheck();
  journal.inFlight = { setup: creator, balancer, demo, worstCaseGasWei: reserve }; save();
  let broadcastFailure: unknown;
  try { execute(true); } catch (e) { broadcastFailure = e; }
  const actual = JSON.parse(readFileSync('broadcast/DevSetup.s.sol/31337/run-latest.json', 'utf8')) as { transactions: (Action & { hash: Hash })[]; receipts: TransactionReceipt[] };
  if (!broadcastFailure) assert.equal(actual.transactions.length, 9);
  for (const [i, a] of actual.transactions.entries()) {
    if (!a.hash) { assert.ok(broadcastFailure, 'actual mined setup hash'); break; }
    const mined = await pub.getTransactionReceipt({ hash: a.hash }).catch(() => null);
    if (!mined) { assert.ok(broadcastFailure, 'actual mined setup receipt'); break; }
    const tx = await pub.getTransaction({ hash: a.hash });
    assert.ok(equalAddress(tx.from, creator)); assert.equal(tx.nonce, nonce + i);
    assert.equal(tx.input, dry.transactions[i].transaction.input);
    assert.equal(tx.value, i === 1 ? 3n * ETH : 0n);
    assert.ok((tx.maxFeePerGas ?? tx.gasPrice) <= 500_000_000n);
    assert.ok(tx.gas <= BigInt(dry.transactions[i].transaction.gas), 'submitted gas within reserved limit');
    await record(a.hash, expected[i], 'setup');
  }
  if (broadcastFailure) throw broadcastFailure;
  const pool = await read<Address>(balancer, poolBalancerAbi, 'pool');
  assert.ok(equalAddress(await read<Address>(balancer, poolBalancerAbi, 'creator'), creator));
  assert.ok(equalAddress(await read<Address>(balancer, poolBalancerAbi, 'factory'), journal.factory));
  assert.ok(equalAddress(await read<Address>(pool, fwaPoolAbi, 'owner'), balancer));
  assert.equal(await read<bigint>(balancer, poolBalancerAbi, 'target'), TARGET);
  assert.equal(await read<number>(balancer, poolBalancerAbi, 'markupBps'), 1500);
  assert.equal(await pub.getBalance({ address: balancer }), 3n * ETH);
  journal.pools.push({ creator, balancer, pool, demo }); delete journal.inFlight; save();
}
async function stocked(p: Pool) {
  const [t, have, reconciled, issued, status] = await Promise.all([
    read<bigint>(p.balancer, poolBalancerAbi, 'target'), read<readonly number[]>(p.balancer, poolBalancerAbi, 'getActiveShapes'),
    read<bigint>(p.balancer, poolBalancerAbi, 'reconciledSequence'), read<bigint>(p.pool, fwaPoolAbi, 'lastIssuedSequence'), read<number>(p.balancer, poolBalancerAbi, 'admissionStatus'),
  ]);
  assert.equal(t, TARGET, 'full approved target retained');
  return Number(status) === 0 && reconciled === issued && have.every((n, d) => BigInt(n) === ((t >> BigInt(16 * d)) & 0xffffn));
}
function makeKeeper() {
  const k = new Keeper({ rpcUrl: RPC, factory: journal.factory, fromBlock: BigInt(JSON.parse(readFileSync(resolve(DIR, 'actual-deployment.json'), 'utf8')).fromBlock), stateFile: STATE_FILE, account: KEEPER, reorgWindow: 4096, log: (message, extra) => console.log(stringify({ message, ...extra })) });
  const original = k.wallet.writeContract.bind(k.wallet);
  k.wallet.writeContract = (async (params: Record<string, unknown>) => {
    try { assert.deepEqual(k.errors, {}, 'earlier pool error stops dependent writes'); return (await guardedWrite(params, 'keeper', original)).hash; }
    catch (e) { fatal = e; throw e; }
  }) as typeof k.wallet.writeContract;
  return k;
}
async function tick(k: Keeper) {
  await setLevel(level);
  await k.tick();
  if (fatal) throw fatal;
  assert.deepEqual(k.errors, {}, 'known keeper errors stop the diagnostic');
  assert.equal(k.state.stats.reverted, 0);
}
async function settle(k: Keeper) {
  for (let n = 0; n < 24; n++) {
    await tick(k);
    if ((await Promise.all(journal.pools.map(stocked))).every(Boolean) && !Object.keys(k.state.pending).length && !Object.keys(k.state.accounting).length) return;
    // A depleted curated set is an explicit new creator contribution.
    for (const p of journal.pools) {
      const st = Number(await read<number>(p.balancer, poolBalancerAbi, 'admissionStatus'));
      const ids = await read<bigint[]>(p.balancer, poolBalancerAbi, 'getActiveIds');
      let curated = 0;
      for (const id of ids) if (Number((await read<readonly unknown[]>(p.balancer, poolBalancerAbi, 'items', [id]))[0]) === 1) curated++;
      if ((st === 0 || st === 3) && curated < 2) {
        for (let i = curated; i < 2; i++) {
          const id = 100n + BigInt(journal.relistings);
          await send({ address: p.demo, abi: demoAbi, functionName: 'mint', args: [p.creator, id], account: p.creator });
          await send({ address: p.demo, abi: erc721Abi, functionName: 'approve', args: [p.balancer, id], account: p.creator });
          await send({ address: p.balancer, abi: poolBalancerAbi, functionName: 'listCuratedBatch', args: [[{ collection: p.demo, tokenId: id, base: ETH / 4n }]], account: p.creator });
          journal.relistings++; save();
        }
      }
    }
  }
  assert.fail('full target and pending reconciliation not restored within 24 actual keeper ticks');
}
function period(round: number) {
  if (round >= 20 && round < 24) return { name: 'below', base: 3_000_000_000n };
  if (round >= 28 && round < 32) return { name: 'near', base: 4_900_000_000n };
  if (round >= 35 && round < 39) return { name: 'above', base: 8_000_000_000n };
  return { name: 'normal', base: 80_000_000n };
}
function rand() { const seed = BigInt(keccak256(toHex(BigInt(journal.seed)))); journal.seed = seed.toString(); return Number(seed % 1_000_000n) / 1_000_000; }
async function buy(p: Pool, count: number, buyer: Address, round: number) {
  assert.ok(journal.draws.length + count <= 252);
  await seedActor(buyer, 10n * ETH);
  const [fee, vrf, total] = await read<readonly [bigint, bigint, bigint]>(p.pool, fwaPoolAbi, 'quoteAcquisitionPrice', [BigInt(count)]);
  assert.ok(total > 0n && total >= fee + vrf, 'nonzero real purchase quote');
  const version = await read<bigint>(p.pool, fwaPoolAbi, 'inventoryVersion');
  const sequence = await read<bigint>(p.pool, fwaPoolAbi, 'lastIssuedSequence');
  const deadline = (await pub.getBlock()).timestamp + 600n;
  const value = total * 3n + ETH / 10n;
  assert.ok(value <= 10n * ETH, 'buyer maximum synthetic funding');
  await send({ address: p.pool, abi: fwaPoolAbi, functionName: 'acquireBatch', args: [buyer, BigInt(count), fee, 0n, 10_000n, version, deadline], value, account: buyer }, 'buyer');
  for (let n = 0; n < 3; n++) { await hold(); await test.mine({ blocks: 1 }); }
  for (let n = 0; n < count; n++) {
    const id = await read<bigint>(p.pool, fwaPoolAbi, 'requestIdAtSequence', [sequence + BigInt(n + 1)]);
    const word = BigInt(keccak256(toHex(BigInt(round) * 10n + BigInt(n))));
    journal.draws.push({ pool: p.pool, id: id.toString(), buyer, word: word.toString() }); save();
    // A successful low-gas service call can merely store the word without forwarding it to FWA.
    await send({ address: VRF, abi: serviceAbi, functionName: 'rawFulfillRandomWords', args: [id, [word]], account: coordinator, gas: 5_000_000n }, 'coordinator-exception');
  }
}
async function verifyDraws() {
  const refundEvent = parseAbiItem('event AcquisitionRefundedSlippage(uint256 indexed requestId,address indexed purchaser,uint256 refund,uint256 escrowedFee,uint256 liveFee)');
  const refunds = new Map<string, { purchaser: Address; refund: bigint; escrowedFee: bigint; liveFee: bigint }>();
  for (const p of journal.pools) for (const log of await pub.getLogs({ address: p.pool, event: refundEvent, fromBlock: FORK_BLOCK, toBlock: 'latest' })) {
    refunds.set(`${p.pool.toLowerCase()}:${log.args.requestId}`, log.args as { purchaser: Address; refund: bigint; escrowedFee: bigint; liveFee: bigint });
  }
  const credits = new Map<string, { pool: Address; buyer: Address; amount: bigint }>();
  let fulfilled = 0, refunded = 0;
  for (const d of journal.draws) {
    assert.equal(await read<number>(VRF, serviceAbi, 'requestStatus', [BigInt(d.id)]), 4, 'every authenticated word delivered to real FWA');
    const acquisition = await read<readonly unknown[]>(d.pool, fwaPoolAbi, 'acquisitions', [BigInt(d.id)]);
    assert.ok(equalAddress(String(acquisition[0]), d.buyer));
    if (Number(acquisition[4]) === 2) {
      const listing = await read<readonly unknown[]>(d.pool, fwaPoolAbi, 'listings', [acquisition[3]]);
      const owner = await read<Address>(listing[0] as Address, erc721Abi, 'ownerOf', [listing[3]]);
      assert.ok(equalAddress(owner, d.buyer), 'winning NFT actually owned by buyer');
      d.outcome = 'fulfilled'; fulfilled++;
    } else {
      assert.equal(Number(acquisition[4]), 4, 'only actual slippage refunds allowed, never missing/late delivery');
      assert.equal(acquisition[3], 0n);
      const event = refunds.get(`${d.pool.toLowerCase()}:${d.id}`);
      assert.ok(event && equalAddress(event.purchaser, d.buyer), 'actual FWA slippage event for exact request/buyer');
      assert.equal(event.refund, acquisition[2]); assert.equal(event.escrowedFee, acquisition[2]);
      assert.ok(event.liveFee > event.escrowedFee + event.escrowedFee / 10n, 'FWA positive-price drift exceeds10%');
      const key = `${d.pool.toLowerCase()}:${d.buyer.toLowerCase()}`;
      const credit = credits.get(key) ?? { pool: d.pool, buyer: d.buyer, amount: 0n };
      credit.amount += event.refund; credits.set(key, credit);
      d.outcome = 'slippage-refund'; d.refundWei = event.refund.toString(); refunded++;
    }
  }
  const abi = parseAbi(['function acquisitionRefundCredit(address) view returns(uint256)']);
  let refundCreditWei = 0n;
  for (const credit of credits.values()) {
    assert.equal(await read<bigint>(credit.pool, abi, 'acquisitionRefundCredit', [credit.buyer]), credit.amount, 'entire purchaser acquisition refund remains claimable');
    refundCreditWei += credit.amount;
  }
  return { fulfilled, refunded, refundCreditWei };
}
async function snapshot(p: Pool) {
  const ids = await read<bigint[]>(p.balancer, poolBalancerAbi, 'getActiveIds');
  const shapes = await read<Address>(p.balancer, poolBalancerAbi, 'SHAPES');
  const packs = await read<Address>(p.balancer, poolBalancerAbi, 'PACKS');
  let actualBacking = 0n;
  const listings = [];
  for (const id of ids) {
    const item = await read<readonly unknown[]>(p.balancer, poolBalancerAbi, 'items', [id]);
    const listing = await read<readonly unknown[]>(p.pool, fwaPoolAbi, 'listings', [id]);
    assert.ok(equalAddress(await read<Address>(listing[0] as Address, erc721Abi, 'ownerOf', [listing[3]]), p.pool), 'active NFT actual FWA custody');
    if (Number(item[0]) === 2) {
      if (equalAddress(listing[0] as Address, shapes)) actualBacking += await read<bigint>(shapes, shapesAbi, 'backingOf', [listing[3]]);
      else {
        assert.ok(equalAddress(listing[0] as Address, packs));
        for (const token of await read<bigint[]>(packs, packAbi, 'contentsOf', [listing[3]])) {
          assert.ok(equalAddress(await read<Address>(shapes, erc721Abi, 'ownerOf', [token]), packs));
          actualBacking += await read<bigint>(shapes, shapesAbi, 'backingOf', [token]);
        }
      }
    }
    listings.push({ id, kind: item[0], denom: item[1], base: item[3], price: item[4], collection: listing[0], tokenId: listing[3] });
  }
  assert.equal(await read<bigint>(p.pool, fwaPoolAbi, 'unsettledAcquisitionCount'), 0n);
  assert.equal(await read<bigint>(p.balancer, poolBalancerAbi, 'reconciledSequence'), await read<bigint>(p.pool, fwaPoolAbi, 'lastIssuedSequence'));
  assert.equal(await read<bigint>(p.pool, fwaPoolAbi, 'activeListingCount'), BigInt(ids.length));
  assert.equal(actualBacking, 4n * ETH / 10n, 'full target real Shape backing is 0.4 ETH');
  return { ...p, balance: await pub.getBalance({ address: p.balancer }), profit: await read<bigint>(p.balancer, poolBalancerAbi, 'profit'), reserve: await read<bigint>(p.balancer, poolBalancerAbi, 'requiredReserve'), surplus: await read<bigint>(p.balancer, poolBalancerAbi, 'withdrawableSurplus'), fwaOwnerProceeds: await read<bigint>(p.pool, fwaPoolAbi, 'ownerProceeds'), actualBacking, activeCounts: await read<readonly number[]>(p.balancer, poolBalancerAbi, 'getActiveShapes'), listings };
}
async function recoverStoredFirstWord() {
  await nodeCheck();
  journal = JSON.parse(readFileSync(FILE, 'utf8'));
  assert.equal(journal.round, 0); assert.equal(journal.activeRound, 0);
  assert.equal(journal.draws.length, 1); assert.equal(journal.pools.length, 2);
  assert.match(journal.failure ?? '', /full target and pending reconciliation not restored/);
  assert.equal(journal.inFlight, undefined);
  const draw = journal.draws[0]; const id = BigInt(draw.id);
  assert.equal(await read<number>(VRF, serviceAbi, 'requestStatus', [id]), 2, 'real service has authenticated stored word');
  assert.equal(await read<bigint>(VRF, serviceAbi, 'storedRandomWord', [id]), BigInt(draw.word));
  assert.ok(equalAddress(await read<Address>(VRF, serviceAbi, 'requestPool', [id]), draw.pool));
  const metaAbi = parseAbi(['function acquisitionMeta(uint256) view returns(uint64,uint64,uint64,uint16,uint16,uint256)']);
  const meta = await read<readonly bigint[]>(draw.pool, metaAbi, 'acquisitionMeta', [id]);
  assert.ok((await pub.getBlockNumber()) + 1n <= meta[1], 'original draw remains before its word deadline');
  writeFileSync(resolve(DIR, 'rehearsal-before-delivery-recovery.json'), readFileSync(FILE));
  coordinator = await read<Address>(VRF, serviceAbi, 'coordinator');
  await test.impersonateAccount({ address: draw.buyer });
  // Retry the same authenticated word through the real permissionless service route; never replay the purchase.
  await send({ address: VRF, abi: serviceAbi, functionName: 'deliverRandomness', args: [id], account: draw.buyer, gas: 5_000_000n }, 'service-retry');
  assert.equal(await read<number>(VRF, serviceAbi, 'requestStatus', [id]), 4);
  const k = makeKeeper(); await settle(k); await verifyDraws();
  journal.round = 1; journal.periods.normal = 1;
  delete journal.activeRound; delete journal.failure; save();
  console.log('Recovered original authenticated word and actual keeper reconciliation; round0 completed without repurchase.');
}
async function verifyObservedRefundRound() {
  await nodeCheck(); journal = JSON.parse(readFileSync(FILE, 'utf8'));
  assert.equal(journal.round, 2); assert.equal(journal.activeRound, 2);
  assert.equal(journal.draws.length, 6); assert.equal(journal.inFlight, undefined);
  assert.match(journal.failure ?? '', /every expected deterministic word fulfilled/);
  writeFileSync(resolve(DIR, 'rehearsal-before-refund-verification.json'), readFileSync(FILE));
  const outcomes = await verifyDraws(); assert.equal(outcomes.fulfilled, 4); assert.equal(outcomes.refunded, 2);
  for (const p of journal.pools) assert.ok(await stocked(p));
  journal.round = 3; journal.periods.normal = 3;
  delete journal.activeRound; delete journal.failure; save();
  console.log(stringify({ reason: 'real FWA slippage refunds and exact purchaser credits verified; no transaction or replay', outcomes }));
}
async function recoverMinedCallbackRound() {
  await nodeCheck(); journal = JSON.parse(readFileSync(FILE, 'utf8'));
  assert.equal(journal.round, 6); assert.equal(journal.activeRound, 6);
  assert.match(journal.failure ?? '', /WaitForTransactionReceiptTimeoutError/);
  const inflight = journal.inFlight as { hash: Hash; function: string; category: string };
  assert.equal(inflight.hash, '0xb0893a7ea801f40afad9ca082b2dc3ac6fde4b54e9779cefd0d9aa94b0ec346e');
  assert.equal(inflight.function, 'rawFulfillRandomWords');
  assert.equal(inflight.category, 'coordinator-exception');
  writeFileSync(resolve(DIR, 'rehearsal-before-receipt-recovery.json'), readFileSync(FILE));
  await record(inflight.hash, inflight.function, inflight.category, 80_000_000n);
  const buyer = '0x00000000000000000000000000000000b0b00006' as Address;
  const draws = journal.draws.filter(d => equalAddress(d.buyer, buyer));
  assert.equal(draws.length, 3);
  coordinator = await read<Address>(VRF, serviceAbi, 'coordinator');
  await test.impersonateAccount({ address: coordinator });
  for (const d of draws) assert.equal(await read<number>(VRF, serviceAbi, 'requestStatus', [BigInt(d.id)]), 4);
  const pool = draws[0].pool;
  assert.equal(await read<bigint>(pool, fwaPoolAbi, 'lastIssuedSequence'), 9n);
  const id = await read<bigint>(pool, fwaPoolAbi, 'requestIdAtSequence', [9n]);
  const acquisition = await read<readonly unknown[]>(pool, fwaPoolAbi, 'acquisitions', [id]);
  assert.ok(equalAddress(String(acquisition[0]), buyer));
  assert.equal(Number(acquisition[4]), 1, 'only remaining original request is pending');
  assert.ok(!journal.draws.some(d => d.id === String(id)));
  const word = BigInt(keccak256(toHex(63n))); // Original round6, draw index3.
  journal.draws.push({ pool, id: String(id), buyer, word: String(word) });
  delete journal.inFlight; save();
  await send({ address: VRF, abi: serviceAbi, functionName: 'rawFulfillRandomWords', args: [id, [word]], account: coordinator, gas: 5_000_000n }, 'coordinator-exception');
  const k = makeKeeper(); await settle(k); const outcomes = await verifyDraws();
  journal.round = 7; journal.periods.normal = 7;
  delete journal.activeRound; delete journal.failure; save();
  console.log(stringify({ reason: 'mined callback receipt reconciled; only remaining original request delivered; no repurchase', outcomes }));
}
async function main() {
  const rounds = Number(process.argv[process.argv.indexOf('--rounds') + 1] ?? 50);
  const requested = process.argv.includes('--rounds') ? rounds : 50;
  assert.ok(Number.isInteger(requested) && requested > 0 && requested <= 50);
  await nodeCheck();
  execFileSync('git', ['diff', '--exit-code', REVISION, '--', 'src', 'keeper', 'shared', 'script', 'foundry.toml', 'package-lock.json'], { stdio: 'pipe' });
  mkdirSync(DIR, { recursive: true });
  const deployment = JSON.parse(readFileSync(resolve(DIR, 'actual-deployment.json'), 'utf8')) as { factory: Address; impl: Address; packs: Address; policy: Address; deployGasWei: string; fromBlock: string; receipts: ({ transactionHash?: Hash; hash?: Hash } | Hash)[] };
  assert.ok(await pub.getCode({ address: deployment.factory }));
  assert.ok(equalAddress(await read<Address>(deployment.factory, balancerFactoryAbi, 'implementation'), deployment.impl));
  assert.ok(equalAddress(await read<Address>(deployment.factory, balancerFactoryAbi, 'defaultKeeperPolicy'), deployment.policy));
  assert.ok(equalAddress(await read<Address>(deployment.impl, poolBalancerAbi, 'PACKS'), deployment.packs));
  if (existsSync(FILE)) {
    journal = JSON.parse(readFileSync(FILE, 'utf8'));
    assert.equal(journal.rpc, RPC); assert.equal(journal.forkBlock, FORK_BLOCK.toString());
    assert.ok(equalAddress(journal.factory, deployment.factory)); assert.equal(journal.revision, REVISION);
    assert.ok(!journal.inFlight && journal.activeRound === undefined, 'interrupted action or round: inspect actual chain and journal before any replay');
    assert.ok(!journal.failure, 'prior failure retained: manual diagnosis required');
    if (journal.completed) { console.log(stringify(journal.summary)); return; }
  } else {
    assert.ok(!existsSync(STATE_FILE), 'no unjournaled previous keeper state');
    journal = { rpc: RPC, forkBlock: FORK_BLOCK.toString(), factory: deployment.factory, revision: REVISION, receipts: [], seeded: {}, pools: [], round: 0, seed: '7', draws: [], relistings: 0, markupChanges: 0, creatorEdits: 0, restarts: 0, periods: {} }; save();
    assert.equal(deployment.receipts.length, 8);
    for (const entry of deployment.receipts) await record(typeof entry === 'string' ? entry : (entry.transactionHash ?? entry.hash)!, 'Deploy', 'deployment');
    assert.equal(paid(), BigInt(deployment.deployGasWei), 'actual deployment gas included');
  }
  assert.ok(journal.pools.length <= 2);
  for (let i = journal.pools.length; i < 2; i++) await setupPool(CREATORS[i]);
  await seedActor(KEEPER, ETH);
  coordinator = await read<Address>(VRF, serviceAbi, 'coordinator');
  await test.impersonateAccount({ address: coordinator }); // No funding/state changes to coordinator or protocol.
  assert.ok(await pub.getBalance({ address: coordinator }) > 0n, 'existing coordinator balance must fund exception gas');
  if (!journal.keeperStartBalance) {
    journal.keeperStartBalance = String(await pub.getBalance({ address: KEEPER }));
    journal.keeperStartBlock = String(await pub.getBlockNumber()); save();
  }
  let k = makeKeeper();
  await setLevel(80_000_000n); await settle(k);
  for (let round = journal.round; round < requested; round++) {
    // Mark the whole round: an interruption between transactions must never repeat a purchase.
    journal.activeRound = round; save();
    await setLevel(80_000_000n); await settle(k);
    if (round === 16 || round === 33) { k.save(); k = makeKeeper(); journal.restarts++; save(); await tick(k); }
    const markupProbe = round === 12 || round === 44;
    const p = markupProbe ? journal.pools[1] : journal.pools[Math.floor(rand() * 2)];
    if (markupProbe) {
      await send({ address: p.balancer, abi: poolBalancerAbi, functionName: 'configure', args: [round === 12 ? 1000 : 1500, TARGET, await read<bigint>(p.balancer, poolBalancerAbi, 'mintFeeCap')], account: p.creator });
      journal.markupChanges++; save(); assert.ok(await stocked(p));
    }
    const gasPeriod = period(round); await setLevel(gasPeriod.base);
    assert.ok(await stocked(p), 'buyer sees admitted full target');
    const count = markupProbe ? 1 : 1 + Math.floor(rand() * 5);
    await buy(p, count, `0x${(0xb0b00000 + round).toString(16).padStart(40, '0')}` as Address, round);
    if (gasPeriod.name === 'above') {
      const sent = k.state.stats.sent;
      await tick(k); await tick(k);
      assert.equal(k.state.stats.sent, sent, 'actual keeper skipped above 5 gwei');
      await setLevel(80_000_000n);
    }
    await settle(k); await verifyDraws();
    if (markupProbe) {
      const markup = round === 12 ? 1000 : 1500;
      const shapes = await read<Address>(p.balancer, poolBalancerAbi, 'SHAPES');
      const fee = await read<bigint>(shapes, shapesAbi, 'mintFee');
      const ids = await read<bigint[]>(p.balancer, poolBalancerAbi, 'getActiveIds');
      const item = await read<readonly unknown[]>(p.balancer, poolBalancerAbi, 'items', [ids.reduce((a, b) => a > b ? a : b)]);
      if (Number(item[0]) === 2) {
        const base = item[3] as bigint; const price = item[4] as bigint; const units = BigInt(SHAPES_IN[Number(item[1])]);
        assert.equal(base, prizeBase(Number(item[1]), fee, markup));
        assert.equal((price - base) % units, 0n);
        assert.ok((price - base) / units >= restockFeeAt(0n) && (price - base) / units <= restockFeeAt(5_000_000_000n));
      }
    }
    if (round === 39) {
      const p = journal.pools[0];
      for (const id of await read<bigint[]>(p.balancer, poolBalancerAbi, 'getActiveIds')) {
        const item = await read<readonly unknown[]>(p.balancer, poolBalancerAbi, 'items', [id]);
        if (Number(item[0]) !== 1) continue;
        await send({ address: p.balancer, abi: poolBalancerAbi, functionName: 'updateCuratedPrice', args: [id, (item[3] as bigint) + 10n ** 15n], account: p.creator });
        journal.creatorEdits++; assert.ok(await stocked(p)); break;
      }
    }
    journal.periods[gasPeriod.name] = (journal.periods[gasPeriod.name] ?? 0) + 1;
    journal.round = round + 1; delete journal.activeRound; save();
    console.log(`completed local diagnostic round ${journal.round}/${requested}, draws ${journal.draws.length}`);
  }
  await setLevel(80_000_000n); await settle(k); await tick(k); const drawOutcomes = await verifyDraws();
  assert.deepEqual(k.errors, {}); assert.equal(k.state.accountingCoverage, 'journal');
  assert.equal(k.state.balancers.length, 2, 'factory-wide keeper discovered exactly approved pools');
  for (const p of journal.pools) assert.ok(k.state.balancers.some(b => equalAddress(b, p.balancer)));
  assert.equal(Object.keys(k.state.pending).length, 0); assert.equal(Object.keys(k.state.accounting).length, 0);
  const keeperReceipts = journal.receipts.filter(r => r.category === 'keeper');
  assert.equal(k.state.receipts.length, keeperReceipts.length, 'keeper journal coverage');
  for (const r of keeperReceipts) assert.ok(k.state.receipts.some(x => x.hash === r.hash));
  const startBlock = BigInt(journal.keeperStartBlock!);
  const endBlock = await pub.getBlockNumber();
  let externalIn = 0n; let externalOut = 0n;
  const covered = new Set(journal.receipts.map(r => r.hash));
  for (let block = startBlock + 1n; block <= endBlock; block++) {
    for (const tx of (await pub.getBlock({ blockNumber: block, includeTransactions: true })).transactions) {
      assert.ok(typeof tx !== 'string');
      assert.ok(covered.has(tx.hash), 'all actual local transactions covered by journal');
      if (tx.to && equalAddress(tx.to, KEEPER)) externalIn += tx.value;
      if (equalAddress(tx.from, KEEPER)) externalOut += tx.value;
    }
  }
  const rewardEvent = parseAbiItem('event KeeperPaid(address indexed keeper,uint256 amount,uint256 gasUsed)');
  let rewards = 0n;
  for (const p of journal.pools) for (const log of await pub.getLogs({ address: p.balancer, event: rewardEvent, args: { keeper: KEEPER }, fromBlock: startBlock, toBlock: endBlock })) rewards += log.args.amount!;
  const keeperGas = keeperReceipts.reduce((sum, r) => sum + BigInt(r.cost), 0n);
  const net = await pub.getBalance({ address: KEEPER }) - BigInt(journal.keeperStartBalance!);
  assert.equal(net, rewards - keeperGas + externalIn - externalOut, 'actual keeper balance delta');
  assert.equal(BigInt(k.state.stats.spentWei), keeperGas); assert.equal(BigInt(k.state.stats.earnedWei), rewards);
  assert.ok(net > 0n, 'keeper actual net positive');
  const gasByCategory: Record<string, bigint> = {};
  for (const r of journal.receipts) gasByCategory[r.category] = (gasByCategory[r.category] ?? 0n) + BigInt(r.cost);
  journal.summary = { diagnosticOnly: true, revision: REVISION, rpc: RPC, forkBlock: FORK_BLOCK, rounds: journal.round, draws: journal.draws.length, drawOutcomes, keeperMode: 'real Keeper class, controlled ticks and guarded signer; not a CLI launcher repeat', journalWindowBlocks: 4096, gasByActorCategoryWei: gasByCategory, totalGasWei: paid(), keeper: { netWei: net, rewardWei: rewards, gasWei: keeperGas, externalIn, externalOut, coverage: k.state.accountingCoverage }, restarts: journal.restarts, periods: journal.periods, creatorMarkupChanges: journal.markupChanges, curatedRelistings: journal.relistings, creatorPriceEdits: journal.creatorEdits, pools: await Promise.all(journal.pools.map(snapshot)), limitations: ['3 ETH per pool overfunded plumbing diagnostic; not minimum-capital proof', 'Forced fee steps do not prove EIP-1559 reachability', 'Owner-retained deterministic coordinator impersonation; no real VRF timing/failure proof', 'No real extension wallet or site publication proof', 'Audit findings remain open; not release proof'], thingsThatDontMakeSense: [] };
  journal.completed = true; save(); console.log(stringify(journal.summary));
}

if (import.meta.url === `file://${process.argv[1]}`) (process.argv.includes('--recover-stored-first-word') ? recoverStoredFirstWord() : process.argv.includes('--verify-observed-refunds') ? verifyObservedRefundRound() : process.argv.includes('--recover-mined-callback') ? recoverMinedCallbackRound() : main()).catch(e => {
  if (journal) { journal.failure = String(e); save(); }
  console.error(e); process.exitCode = 1;
});
