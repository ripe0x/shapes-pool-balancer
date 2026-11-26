// Owner-approved UI walkthrough only: simulated oracle callbacks, real fork purchases/NFTs/restocking.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createPublicClient, createTestClient, createWalletClient, decodeErrorResult, decodeFunctionData, encodePacked, getAddress, http, keccak256, parseAbi, parseAbiItem, type Abi, type Address, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { balancerFactoryAbi, fwaPoolAbi, poolBalancerAbi } from '../shared/abi';
import { Keeper } from '../keeper/keeper';

export const SCOPE = {
  rpc: 'http://127.0.0.1:8545', chainId: 31337, forkBlock: 26485619, nodePid: 28171,
  factory: getAddress('0xbe49677a403f77136e81498e5681f8dc22aa1181'),
  balancer: getAddress('0xE0C94BA1ECD2380df5b90eB515D115a3365BB8F4'),
  pool: getAddress('0x802d4E8D7315a4B7ceA1ba97e8BbE271fAa3F581'),
  buyer: getAddress('0x000000000000000000000000000000000001e008'),
  coordinator: getAddress('0xD7f86b4b8Cae7D942340FF628F82735b7a20893a'),
  service: getAddress('0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d'),
  count: 20, maxTransactions: 100, purchaseCapWei: 10n ** 18n, gasCapWei: 10n ** 18n,
} as const;
const UPSTREAM = 'https://mainnet.gateway.tenderly.co';
const ROOT = resolve(import.meta.dirname, '..');
const DIRECTORY = resolve(ROOT, 'docs/receipts/local-playground/20261125174335482/simulated-draws');
const JOURNAL = resolve(DIRECTORY, 'journal.json');
const KEEPER_FILE = resolve(DIRECTORY, 'keeper-state.json');
export const KEEPER_ADDRESS = getAddress('0x000000000000000000000000000000000001e004');
export const TOPUP_WEI = 5n * 10n ** 17n;
const extraPoolAbi = parseAbi([
  'function acquisitionRefundCredit(address) view returns(uint256)',
  'function unfulfilledVrfCount() view returns(uint256)',
]);
const poolAbi: Abi = [...fwaPoolAbi, ...extraPoolAbi];
const serviceAbi = parseAbi([
  'function coordinator() view returns(address)',
  'function rawFulfillRandomWords(uint256,uint256[])',
  'function requestPool(uint256) view returns(address)',
  'function requestStatus(uint256) view returns(uint8)',
  'function coordinatorOutstandingFor(address) view returns(uint256)',
  'function totalCoordinatorOutstanding() view returns(uint256)',
  'function subscriptionNativeBalance() view returns(uint256)',
  'function serviceGasEstimate() view returns(uint256)',
  'function serviceMarginBps() view returns(uint256)',
  'function serviceFlatWei() view returns(uint256)',
]);
const coordinatorAbi = parseAbi(['function s_requestCommitments(uint256) view returns(bytes32)']);
const nftAbi = parseAbi(['function ownerOf(uint256) view returns(address)']);
const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? String(x) : x, 2);
const equalAddress = (a: string, b: string) => assert.equal(getAddress(a), getAddress(b));
export function validateScope(rpc: string, chainId: number, pool: string, count: number) {
  assert.equal(rpc, SCOPE.rpc); assert.equal(chainId, SCOPE.chainId);
  equalAddress(pool, SCOPE.pool); assert.equal(count, SCOPE.count);
}
export function validateWrite(from: Address, to: Address, name: string, args: readonly any[], value: bigint, approvedTopup = false) {
  if (getAddress(from) === SCOPE.coordinator) {
    equalAddress(to, SCOPE.service); assert.equal(name, 'rawFulfillRandomWords');
    assert.equal(args.length, 2); assert.ok(args[0] > 0n); assert.equal(args[1].length, 1);
  } else {
    equalAddress(from, SCOPE.buyer);
    if (getAddress(to) === SCOPE.balancer) {
      assert.equal(name, approvedTopup && name === 'depositETH' ? 'depositETH' : 'performUpkeepUnpaid'); assert.equal(args.length, 0);
      if (name === 'depositETH') assert.equal(value, TOPUP_WEI);
    }
    else {
      equalAddress(to, SCOPE.pool);
      if (name === 'acquireBatch') { equalAddress(args[0], SCOPE.buyer); assert.equal(args[1], 1n); assert.equal(args.length, 7); }
      else { assert.equal(name, 'processAcquisitions'); assert.deepEqual(args, [1n]); }
    }
  }
  assert.ok(value >= 0n && value <= SCOPE.purchaseCapWei);
  if (name !== 'acquireBatch' && name !== 'depositETH') assert.equal(value, 0n);
}
export const testWord = (id: bigint) => BigInt(keccak256(encodePacked(['string', 'uint256'], ['owner-approved-local-8545-simulation-v1', id])));
export const fullyRestocked = (counts: readonly number[], expected: readonly number[]) => counts.length === expected.length && counts.every((n, i) => n === expected[i]);
export const requestDeadline = (chainTime: bigint, wallTime: bigint) => (chainTime > wallTime ? chainTime : wallTime) + 600n;
interface DrawExtension { count: number; startWins: number; targetWins: number; drawsComplete?: boolean }
export function additionalDrawTarget(wins: number, extensions: readonly DrawExtension[], count: number) {
  assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= 10, 'additional draws must be 1..10 within the existing budget');
  assert.ok(Number.isSafeInteger(wins) && wins >= SCOPE.count, 'finish the original twenty wins first');
  const last = extensions.at(-1);
  if (last && !last.drawsComplete) {
    assert.equal(last.count, count, 'resume the same additional count; do not create a second target');
    assert.equal(last.targetWins, last.startWins + last.count); assert.ok(wins >= last.startWins && wins <= last.targetWins);
    return { ...last, resume: true };
  }
  return { count, startWins: wins, targetWins: wins + count, resume: false };
}
export function validateCalldata(abi: Abi, data: Hex, name: string, args: readonly unknown[]) {
  const decoded = decodeFunctionData({ abi, data }); assert.equal(decoded.functionName, name); assert.deepEqual(decoded.args ?? [], args);
}
export function keeperBudget(state: any) {
  const reserved = new Map<number, bigint>();
  for (const item of [...Object.values(state.pending ?? {}), ...Object.values(state.accounting ?? {}).map((v: any) => v.pending)] as any[]) {
    const cost = BigInt(item.gas) * BigInt(item.maxFeePerGas);
    if (cost > (reserved.get(item.nonce) ?? 0n)) reserved.set(item.nonce, cost);
  }
  return { gas: BigInt(state.stats?.spentWei ?? 0) + [...reserved.values()].reduce((a, b) => a + b, 0n), transactions: Number(state.stats?.sent ?? 0) + Number(state.stats?.replaced ?? 0) };
}
export function keeperGateAcknowledged(gateMtimeNs: bigint, keeperMtimeNs: bigint, state: { pending: Record<string, unknown>; accounting: Record<string, unknown> }) {
  return keeperMtimeNs > gateMtimeNs && Object.keys(state.pending).length === 0 && Object.keys(state.accounting).length === 0;
}
const currentKeeperBudget = () => keeperBudget(existsSync(KEEPER_FILE) ? JSON.parse(readFileSync(KEEPER_FILE, 'utf8')) : {});
function createLocalKeeper() {
  const keeper: Keeper = new Keeper({ rpcUrl: SCOPE.rpc, factory: SCOPE.factory, fromBlock: 26485861n, account: KEEPER_ADDRESS,
    stateFile: KEEPER_FILE, legacyFactories: [], priorityGwei: 0.05, maxGasPriceGwei: 5, maxLossWei: 0n,
    log: (message, data) => { if (message !== 'tick complete') console.log(json({ keeper: message, ...data })); },
    beforeSend: async (next): Promise<boolean> => {
      assert.equal(await keeper.pub.getChainId(), 31337);
      const info: any = await keeper.pub.request({ method: 'anvil_nodeInfo' as any }); assert.equal(info.forkConfig.forkUrl, UPSTREAM); assert.equal(info.forkConfig.forkBlockNumber, SCOPE.forkBlock);
      assert.equal(execFileSync('ps', ['-p', String(SCOPE.nodePid), '-o', 'command='], { encoding: 'utf8' }).trim(), `anvil --fork-url ${UPSTREAM} --chain-id 31337 --port 8545 --silent`);
      assert.equal(await keeper.pub.getCode({ address: KEEPER_ADDRESS }) ?? '0x', '0x');
      assert.ok([...keeper.state.balancers, ...Object.keys(keeper.state.pending), ...Object.values(keeper.state.accounting).map(v => v.balancer)].every(a => getAddress(a) === SCOPE.balancer), 'keeper may service only this pool');
      equalAddress(await keeper.pub.readContract({ address: SCOPE.balancer, abi: poolBalancerAbi, functionName: 'factory' }), SCOPE.factory);
      const journal = JSON.parse(readFileSync(JOURNAL, 'utf8')); if (journal.nextAction || journal.pendingHash) return false;
      for (const address of [SCOPE.factory, SCOPE.balancer]) assert.equal(keccak256((await keeper.pub.getCode({ address }))!), journal.plan.codeHashes[address]);
      const own = keeperBudget(keeper.state);
      return BigInt(journal.gasWei) + own.gas + next.gas * next.maxFeePerGas <= SCOPE.gasCapWei
        && journal.transactions.length + own.transactions < SCOPE.maxTransactions;
    },
  });
  return keeper;
}

async function run(execute: boolean, resume: boolean, approvedTopup: boolean, additional?: number) {
  const c = createPublicClient({ chain: foundry, transport: http(SCOPE.rpc, { retryCount: 0 }), cacheTime: 0 });
  const wallet = createWalletClient({ chain: foundry, transport: http(SCOPE.rpc, { retryCount: 0 }) });
  const test = createTestClient({ mode: 'anvil', transport: http(SCOPE.rpc, { retryCount: 0 }) });
  const read = async <T,>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], gasPrice?: bigint, blockNumber?: bigint) =>
    await c.readContract({ address, abi, functionName, args, account: SCOPE.buyer, blockNumber, ...(gasPrice === undefined ? {} : { gasPrice }) }) as T;
  const b = <T,>(name: string, args: readonly unknown[] = []) => read<T>(SCOPE.balancer, poolBalancerAbi, name, args);
  const p = <T,>(name: string, args: readonly unknown[] = []) => read<T>(SCOPE.pool, poolAbi, name, args);
  const s = <T,>(name: string, args: readonly unknown[] = []) => read<T>(SCOPE.service, serviceAbi, name, args);
  const deployment = JSON.parse(readFileSync(resolve(DIRECTORY, '../postflight.json'), 'utf8'));
  const target = await b<bigint>('target');
  const shapes = await b<Address>('SHAPES'), packs = await b<Address>('PACKS');
  const codeHashes = new Map<Address, string>();
  for (const address of [SCOPE.factory, SCOPE.balancer, SCOPE.pool, SCOPE.service, SCOPE.coordinator, shapes, packs]) {
    const code = await c.getCode({ address }); assert.ok(code && code !== '0x'); codeHashes.set(address, keccak256(code));
  }
  assert.equal(codeHashes.get(SCOPE.factory), deployment.codeHashes[SCOPE.factory.toLowerCase()]);
  assert.equal(codeHashes.get(SCOPE.service), '0x8b9c188904c22b874ac930fe8775d0d3e926ba9f48bccd8079ca1f1084eae2f2');
  assert.equal(codeHashes.get(SCOPE.coordinator), '0xbe4ae0321fb1c74c80eea0c14c9c7b28c69ce17df15222e27b1e934cc98f5f61');
  async function identity() {
    validateScope(SCOPE.rpc, await c.getChainId(), await b<Address>('pool'), SCOPE.count);
    const info: any = await c.request({ method: 'anvil_nodeInfo' as any });
    assert.equal(info.forkConfig.forkUrl, UPSTREAM); assert.equal(info.forkConfig.forkBlockNumber, SCOPE.forkBlock);
    const pids = execFileSync('lsof', ['-nP', '-iTCP:8545', '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' }).split('\n').filter(line => line.startsWith('p'));
    assert.deepEqual(pids, [`p${SCOPE.nodePid}`]);
    assert.equal(execFileSync('ps', ['-p', String(SCOPE.nodePid), '-o', 'command='], { encoding: 'utf8' }).trim(), `anvil --fork-url ${UPSTREAM} --chain-id 31337 --port 8545 --silent`);
    equalAddress(await b<Address>('factory'), SCOPE.factory); equalAddress(await p<Address>('owner'), SCOPE.balancer);
    equalAddress(await s<Address>('coordinator'), SCOPE.coordinator); assert.equal(await b<bigint>('target'), target);
    assert.equal(await c.getCode({ address: SCOPE.buyer }) ?? '0x', '0x');
    for (const [address, hash] of codeHashes) assert.equal(keccak256((await c.getCode({ address }))!), hash);
  }
  async function snapshot() {
    const block = await c.getBlock(); const balances: Record<string, bigint> = {};
    const atB = <T,>(name: string) => read<T>(SCOPE.balancer, poolBalancerAbi, name, [], undefined, block.number);
    const atP = <T,>(name: string, args: readonly unknown[] = []) => read<T>(SCOPE.pool, poolAbi, name, args, undefined, block.number);
    const atS = <T,>(name: string, args: readonly unknown[] = []) => read<T>(SCOPE.service, serviceAbi, name, args, undefined, block.number);
    for (const [name, address] of Object.entries({ buyer: SCOPE.buyer, balancer: SCOPE.balancer, pool: SCOPE.pool, service: SCOPE.service, coordinator: SCOPE.coordinator, shapes, packs })) balances[name] = await c.getBalance({ address, blockNumber: block.number });
    return { block: block.number, baseFee: block.baseFeePerGas, balances, creatorCredit: await atB<bigint>('creatorCredit'), requiredReserve: await atB<bigint>('requiredReserve'), ownerProceeds: await atP<bigint>('ownerProceeds'), unsettled: await atP<bigint>('unsettledAcquisitionCount'), sequence: await atP<bigint>('lastIssuedSequence'), reconciled: await atB<bigint>('reconciledSequence'), activeShapes: await atB<readonly number[]>('getActiveShapes'), admission: await atB<number>('admissionStatus'), servicePoolOutstanding: await atS<bigint>('coordinatorOutstandingFor', [SCOPE.pool]), serviceGlobalOutstanding: await atS<bigint>('totalCoordinatorOutstanding'), subscriptionNativeBalance: await atS<bigint>('subscriptionNativeBalance'), poolUnfulfilled: await atP<bigint>('unfulfilledVrfCount'), refundCredit: await atP<bigint>('acquisitionRefundCredit', [SCOPE.buyer]) };
  }
  await identity(); const initial = await snapshot(); assert.equal(initial.unsettled, 0n); assert.equal(initial.admission, 0);
  const expectedCounts = Array.from({ length: 16 }, (_, i) => Number(target >> BigInt(16 * i) & 65535n));
  if (!resume) assert.deepEqual(initial.activeShapes, expectedCounts, 'initial board must match the saved target');
  const expired: bigint[] = [];
  assert.ok(initial.sequence <= 100n, 'refusing unbounded historical cleanup scan');
  for (let sequence = 1n; sequence <= initial.sequence; sequence++) {
    const id = await p<bigint>('requestIdAtSequence', [sequence]);
    if (Number(await s<number>('requestStatus', [id])) !== 1) continue;
    equalAddress(await s<Address>('requestPool', [id]), SCOPE.pool);
    assert.notEqual(await read<string>(SCOPE.coordinator, coordinatorAbi, 's_requestCommitments', [id]), `0x${'0'.repeat(64)}`);
    assert.equal(Number((await p<readonly any[]>('acquisitions', [id]))[4]), 3, 'only already expired own-pool requests can be cleaned'); expired.push(id);
  }
  assert.ok(expired.length <= 5); assert.equal(initial.servicePoolOutstanding, BigInt(expired.length));
  const plan = { ...SCOPE, target, expectedCounts, expired, codeHashes: Object.fromEntries(codeHashes), initial, oracle: 'SIMULATED callbacks; genuine coordinator commitments/billing are not completed', sourceSHA256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex') };
  if (!execute) {
    const existing = additional === undefined ? undefined : JSON.parse(readFileSync(JOURNAL, 'utf8'));
    const extension = existing ? additionalDrawTarget(existing.wins.length, existing.extensions ?? [], additional!) : undefined;
    console.log(json({ plan, additional: extension, broadcast: false, execute: additional === undefined ? 'node --import tsx scripts/local-simulated-draws.ts --execute --allow-simulated-randomness' : `node --import tsx scripts/local-simulated-draws.ts --execute --allow-simulated-randomness --resume --additional ${additional}` })); return;
  }
  assert.equal(existsSync(JOURNAL), resume, 'existing journal requires explicit reconciled --resume'); mkdirSync(DIRECTORY, { recursive: true });
  const journal: any = resume ? JSON.parse(readFileSync(JOURNAL, 'utf8'), (_, v) => typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : v)
    : { plan, complete: false, transactions: [], cleanup: [], wins: [], forwardPurchaseWei: 0n, gasWei: 0n };
  if (resume) {
    if (additional === undefined) { assert.equal(journal.complete, false); assert.ok(!journal.extensions?.length, 'additional batches require --additional'); }
    assert.ok(!journal.pendingHash && !journal.nextAction, 'reconcile any uncertain broadcast before resuming');
    for (const [key, value] of Object.entries(SCOPE)) assert.deepEqual(journal.plan[key], value);
    assert.equal(journal.plan.target, target); assert.deepEqual(journal.plan.codeHashes, plan.codeHashes);
    assert.equal(initial.sequence, journal.plan.initial.sequence + BigInt(journal.wins.length));
    let gas = 0n, purchases = 0n;
    for (const action of journal.transactions) {
      const tx = await c.getTransaction({ hash: action.hash }), receipt = await c.getTransactionReceipt({ hash: action.hash });
      validateWrite(action.from, action.to, action.name, action.args, action.value, action.name === 'depositETH');
      equalAddress(tx.from, action.from); equalAddress(tx.to!, action.to); assert.equal(tx.nonce, action.nonce); assert.equal(tx.value, action.value);
      const abi = action.to === SCOPE.service ? serviceAbi : action.to === SCOPE.pool ? poolAbi : poolBalancerAbi;
      validateCalldata(abi, tx.input, action.name, action.args); assert.equal(receipt.blockHash, action.receipt.blockHash);
      if (receipt.status !== 'success') {
        assert.equal(action.name, 'acquireBatch'); assert.equal(action.receipt.status, 'reverted');
        const trace: any = await c.request({ method: 'debug_traceTransaction' as any, params: [action.hash, { tracer: 'callTracer' }] as any });
        const reason = decodeErrorResult({ abi: parseAbi(['error TransactionExpired(uint256 deadline)']), data: trace.output });
        assert.equal(reason.errorName, 'TransactionExpired'); assert.equal(reason.args[0], action.args[6]);
      }
      gas += receipt.gasUsed * receipt.effectiveGasPrice; if (action.name === 'acquireBatch') purchases += action.value;
    }
    assert.equal(gas, journal.gasWei); assert.equal(purchases, journal.forwardPurchaseWei);
    for (const win of journal.wins) equalAddress(await read<Address>(win.collection, nftAbi, 'ownerOf', [win.tokenId]), SCOPE.buyer);
    journal.resumes ??= []; journal.resumes.push({ sourceSHA256: plan.sourceSHA256, before: initial, previousFailure: journal.failure }); if (additional === undefined) delete journal.failure;
  }
  let extension: any;
  if (additional !== undefined) {
    assert.ok(resume && !approvedTopup, '--additional uses the existing keeper and never adds capital');
    const next = additionalDrawTarget(journal.wins.length, journal.extensions ?? [], additional);
    const remaining = next.targetWins - journal.wins.length;
    assert.ok(journal.transactions.length + currentKeeperBudget().transactions + remaining * 3 <= SCOPE.maxTransactions, 'existing transaction budget cannot fit this batch');
    journal.extensions ??= [];
    if (next.resume) extension = journal.extensions.at(-1);
    else { extension = { count: additional, startWins: next.startWins, targetWins: next.targetWins, createdAt: new Date().toISOString(), sourceSHA256: plan.sourceSHA256, before: initial, drawsComplete: false }; journal.extensions.push(extension); }
  }
  const targetWins = extension?.targetWins ?? SCOPE.count;
  const save = () => writeFileSync(JOURNAL, json(journal) + '\n'); save();
  const keeper = additional === undefined ? createLocalKeeper() : undefined;
  const unlocked = (await wallet.getAddresses()).map(a => getAddress(a));
  assert.ok(unlocked.includes(SCOPE.buyer), 'approved buyer must already be unlocked');
  const newlyUnlocked = !unlocked.includes(SCOPE.coordinator);
  const nonces = new Map<Address, number>();
  for (const address of [SCOPE.buyer, SCOPE.coordinator]) nonces.set(address, await c.getTransactionCount({ address, blockTag: 'pending' }));
  async function price() { const block = await c.getBlock(); const v = (block.baseFeePerGas ?? 0n) + 1_000_000_000n; assert.ok(v <= 5_000_000_000n, 'local gas spike exceeds bound'); return v; }
  async function send(from: Address, to: Address, abi: Abi, name: string, args: readonly any[], value = 0n, gasPrice?: bigint) {
    validateWrite(from, to, name, args, value, approvedTopup); await identity();
    if (name === 'depositETH') assert.equal(journal.transactions.filter((t: any) => t.name === 'depositETH').length, 0, 'one approved contribution only');
    if (name === 'rawFulfillRandomWords') { equalAddress(await s<Address>('requestPool', [args[0]]), SCOPE.pool); assert.equal(Number(await s<number>('requestStatus', [args[0]])), 1); }
    const nonce = nonces.get(from)!; assert.equal(await c.getTransactionCount({ address: from, blockTag: 'pending' }), nonce);
    const gas = name === 'rawFulfillRandomWords' ? 5_000_000n : name === 'performUpkeepUnpaid' ? 8_000_000n : name === 'acquireBatch' ? 1_500_000n : 3_000_000n;
    let broadcastAttempted = false;
    try {
      if (extension) {
        // The already-running keeper honors nextAction. Wait for a later drained tick before reserving gas.
        journal.nextAction = { from, to, name, args, value, nonce, gas, broadcastAttempted: false, phase: 'awaiting-keeper' }; save();
        const gateMtimeNs = statSync(JOURNAL, { bigint: true }).mtimeNs, until = Date.now() + 30_000;
        let acknowledged = false;
        while (Date.now() < until) {
          const fd = openSync(KEEPER_FILE, 'r');
          try {
            const state = JSON.parse(readFileSync(fd, 'utf8'));
            if (keeperGateAcknowledged(gateMtimeNs, fstatSync(fd, { bigint: true }).mtimeNs, state)) { acknowledged = true; break; }
          } finally { closeSync(fd); }
          await new Promise(done => setTimeout(done, 100));
        }
        assert.ok(acknowledged, 'keeper did not acknowledge the draw gate with a drained tick; no draw transaction sent');
      }
      const keeperCost = currentKeeperBudget();
      gasPrice ??= await price(); assert.ok(journal.transactions.length + keeperCost.transactions < SCOPE.maxTransactions); assert.ok(journal.gasWei + keeperCost.gas + gas * gasPrice <= SCOPE.gasCapWei);
      if (name === 'acquireBatch') assert.ok(journal.forwardPurchaseWei + value <= SCOPE.purchaseCapWei);
      assert.ok(await c.getBalance({ address: from }) >= value + gas * gasPrice, 'no funding or top-ups are authorized');
      const simulation = await c.simulateContract({ address: to, abi, functionName: name, args, account: from, value, nonce, gas, gasPrice });
      const action = { from, to, name, args, value, nonce, gas, gasPrice }; journal.nextAction = { ...action, broadcastAttempted: false }; save(); console.log(json(action));
      broadcastAttempted = true; journal.nextAction.broadcastAttempted = true; save();
      const hash = await wallet.writeContract(simulation.request); journal.pendingHash = hash; save();
      const receipt = await c.waitForTransactionReceipt({ hash, timeout: 60000 }); const tx = await c.getTransaction({ hash });
      const entry = { ...action, hash, receipt }; journal.transactions.push(entry); journal.gasWei += receipt.gasUsed * receipt.effectiveGasPrice;
      if (name === 'acquireBatch') journal.forwardPurchaseWei += value;
      delete journal.pendingHash; delete journal.nextAction; save();
      assert.equal(receipt.status, 'success'); equalAddress(tx.from, from); equalAddress(tx.to!, to); assert.equal(tx.value, value); assert.equal(tx.nonce, nonce);
      validateCalldata(abi, tx.input, name, args);
      nonces.set(from, nonce + 1); return receipt;
    } catch (error) {
      if (extension && !broadcastAttempted) { delete journal.nextAction; save(); }
      throw error;
    }
  }
  async function callback(id: bigint) {
    const commitment = await read<string>(SCOPE.coordinator, coordinatorAbi, 's_requestCommitments', [id]);
    assert.notEqual(commitment, `0x${'0'.repeat(64)}`);
    await send(SCOPE.coordinator, SCOPE.service, serviceAbi, 'rawFulfillRandomWords', [id, [testWord(id)]]);
    assert.equal(Number(await s<number>('requestStatus', [id])), 4, 'actual service delivery must complete');
    assert.equal(await read<string>(SCOPE.coordinator, coordinatorAbi, 's_requestCommitments', [id]), commitment, 'simulation does not consume authentic commitment');
    return { id, simulatedWord: testWord(id), genuineCommitmentStillPending: commitment };
  }
  async function maintain() {
    for (let work = 0; work < (keeper ? 8 : 30); work++) {
      if (keeper) await keeper.tick();
      else assert.ok(existsSync(KEEPER_FILE) && Date.now() - statSync(KEEPER_FILE).mtimeMs < 10_000, 'existing keeper is not ticking; no second keeper will be started');
      const state = await snapshot();
      const keeperState = keeper?.state ?? JSON.parse(readFileSync(KEEPER_FILE, 'utf8'));
      assert.ok([...keeperState.balancers, ...Object.keys(keeperState.pending), ...Object.values(keeperState.accounting).map((v: any) => v.balancer)].every((a: string) => getAddress(a) === SCOPE.balancer), 'existing keeper scope differs');
      const pending = Object.keys(keeperState.pending).length + Object.keys(keeperState.accounting).length;
      if (!pending && state.reconciled === state.sequence && (fullyRestocked(state.activeShapes, expectedCounts) || state.requiredReserve > state.balances.balancer - state.creatorCredit)) break;
      if (keeper) assert.equal(Object.keys(keeper.errors).length, 0, json(keeper.errors));
      else await new Promise(done => setTimeout(done, 1000));
    }
    const state = await snapshot(); assert.equal(state.reconciled, state.sequence); assert.equal(state.ownerProceeds, 0n);
    const shortfall = state.requiredReserve - (state.balances.balancer - state.creatorCredit);
    const full = fullyRestocked(state.activeShapes, expectedCounts);
    assert.ok(full || shortfall > 0n, 'unexplained incomplete restocking');
    const keeperState = keeper?.state ?? JSON.parse(readFileSync(KEEPER_FILE, 'utf8'));
    (extension ?? journal).keeper = { address: KEEPER_ADDRESS, stats: keeperState.stats, receipts: keeperState.receipts }; save();
    return { state, full, shortfall: shortfall > 0n ? shortfall : 0n };
  }
  try {
    if (newlyUnlocked) await test.impersonateAccount({ address: SCOPE.coordinator });
    if (approvedTopup) {
      assert.ok(resume, 'extra contribution is only authorized for this interrupted run'); const before = await snapshot();
      await send(SCOPE.buyer, SCOPE.balancer, poolBalancerAbi, 'depositETH', [], TOPUP_WEI);
      const after = await snapshot(); assert.equal(after.balances.balancer - before.balances.balancer, TOPUP_WEI); assert.equal(after.creatorCredit, before.creatorCredit);
      journal.additionalCapital = { amountWei: TOPUP_WEI, before, after }; save();
    }
    if (resume && additional === undefined && journal.wins.length && !journal.wins.at(-1).restored) {
      const maintenance = await maintain(); assert.equal(maintenance.state.creatorCredit, initial.creatorCredit);
      journal.wins.at(-1).maintenance = maintenance; if (maintenance.full) journal.wins.at(-1).restored = maintenance.state; save();
    }
    for (const id of expired) {
      const before = await snapshot(), acquisition = await p<readonly any[]>('acquisitions', [id]); const proof = await callback(id); const after = await snapshot();
      assert.deepEqual(await p<readonly any[]>('acquisitions', [id]), acquisition); assert.equal(after.ownerProceeds, before.ownerProceeds); assert.equal(after.refundCredit, before.refundCredit); assert.equal(after.servicePoolOutstanding, before.servicePoolOutstanding - 1n);
      journal.cleanup.push({ ...proof, before, after }); save();
    }
    if (extension) await maintain();
    for (let i = journal.wins.length; i < targetWins; i++) {
      const before = await snapshot(); assert.equal(before.admission, 0, 'actual contract admission must allow the next draw'); assert.equal(before.unsettled, 0n);
      const gasPrice = await price();
      const [fee, vrf, total] = await read<readonly [bigint, bigint, bigint]>(SCOPE.pool, poolAbi, 'quoteAcquisitionPrice', [1n], gasPrice);
      assert.equal(total, fee + vrf); assert.ok(fee > 0n && vrf > 0n);
      const expectedVrf = await s<bigint>('serviceGasEstimate') * gasPrice * (10000n + await s<bigint>('serviceMarginBps')) / 10000n + await s<bigint>('serviceFlatWei'); assert.equal(vrf, expectedVrf);
      const ids = await b<readonly bigint[]>('getActiveIds'); let weight = 0n, weightedPrice = 0n;
      for (const lid of ids) { const listing = await p<readonly any[]>('listings', [lid]); weight += BigInt(listing[4]); weightedPrice += BigInt(listing[4]) * BigInt(listing[5]); }
      const ownerBase = weightedPrice / weight;
      const version = await p<bigint>('inventoryVersion'), block = await c.getBlock(); const walletBefore = await c.getBalance({ address: SCOPE.buyer });
      const purchase = await send(SCOPE.buyer, SCOPE.pool, poolAbi, 'acquireBatch', [SCOPE.buyer, 1n, fee, 0n, 10000n, version, requestDeadline(block.timestamp, BigInt(Math.floor(Date.now() / 1000)))], total, gasPrice);
      assert.equal(walletBefore - await c.getBalance({ address: SCOPE.buyer }), total + purchase.gasUsed * purchase.effectiveGasPrice);
      assert.equal(await p<bigint>('lastIssuedSequence'), before.sequence + 1n); const id = await p<bigint>('requestIdAtSequence', [before.sequence + 1n]);
      const proof = await callback(id);
      if (await p<bigint>('unsettledAcquisitionCount')) await send(SCOPE.buyer, SCOPE.pool, poolAbi, 'processAcquisitions', [1n]);
      const acquisition = await p<readonly any[]>('acquisitions', [id]); assert.equal(Number(acquisition[4]), 2, 'must win, not refund/expire'); equalAddress(acquisition[0], SCOPE.buyer);
      const listing = await p<readonly any[]>('listings', [acquisition[3]]); equalAddress(listing[2], SCOPE.buyer); assert.equal(Number(listing[7]), 4); equalAddress(await read<Address>(listing[0], nftAbi, 'ownerOf', [listing[3]]), SCOPE.buyer);
      const settled = await snapshot(); assert.equal(settled.unsettled, 0n); assert.equal(settled.refundCredit, before.refundCredit);
      // A running keeper can collect between delivery and this snapshot; include actual collection events.
      const collectedLogs = await c.getLogs({ address: SCOPE.balancer, event: parseAbiItem('event ProceedsCollected(uint256 amount)'), fromBlock: before.block + 1n, toBlock: settled.block });
      const collected = collectedLogs.reduce((sum, log) => sum + log.args.amount!, 0n);
      assert.equal(settled.ownerProceeds - before.ownerProceeds + collected, ownerBase);
      const win: any = { index: i + 1, ...proof, fee, vrf, total, ownerBase, collectedBeforeSnapshot: collected, collection: listing[0], tokenId: listing[3], listingId: acquisition[3], before, settled }; journal.wins.push(win); save();
      const creditBefore = extension ? before.creatorCredit : settled.creatorCredit, rate = BigInt(await b<number>('creatorRevenueBps'));
      const maintenance = await maintain(); assert.equal(maintenance.state.creatorCredit - creditBefore, ownerBase * rate / 10000n);
      win.maintenance = maintenance; if (maintenance.full) win.restored = maintenance.state; save(); console.log(json({ wins: i + 1, collection: win.collection, tokenId: win.tokenId, restocked: maintenance.full, shortfallWei: maintenance.shortfall }));
    }
    for (const win of journal.wins) equalAddress(await read<Address>(win.collection, nftAbi, 'ownerOf', [win.tokenId]), SCOPE.buyer);
    assert.equal(new Set(journal.wins.map((w: any) => `${w.collection}:${w.tokenId}`)).size, targetWins);
    if (extension) {
      extension.final = await snapshot(); assert.equal(extension.final.servicePoolOutstanding, 0n);
      extension.drawsComplete = journal.wins.length === targetWins; extension.fullTargetRestored = fullyRestocked(extension.final.activeShapes, expectedCounts); delete extension.failure; save();
      const operating = extension.final.balances.balancer - extension.final.creatorCredit;
      console.log(json({ additionalDrawsCompleted: extension.count, totalVerifiedWins: journal.wins.length, fullyRestocked: extension.fullTargetRestored, shortfallWei: extension.final.requiredReserve > operating ? extension.final.requiredReserve - operating : 0n, missingPrizesByDenomination: expectedCounts.map((n, i) => Math.max(0, n - extension.final.activeShapes[i])), transactions: journal.transactions.length + currentKeeperBudget().transactions, forwardPurchaseWei: journal.forwardPurchaseWei, gasWei: journal.gasWei + currentKeeperBudget().gas, journal: JOURNAL })); return;
    }
    journal.final = await snapshot(); save(); assert.equal(journal.final.servicePoolOutstanding, 0n); assert.deepEqual(journal.final.activeShapes, expectedCounts, 'draws completed but final target remains underfunded'); journal.complete = true; save();
    console.log(json({ complete: true, wins: journal.wins.length, transactions: journal.transactions.length + currentKeeperBudget().transactions, forwardPurchaseWei: journal.forwardPurchaseWei, gasWei: journal.gasWei + currentKeeperBudget().gas, journal: JOURNAL }));
  } catch (error) { (extension ?? journal).failure = String(error); save(); throw error; }
  finally { if (newlyUnlocked) await test.stopImpersonatingAccount({ address: SCOPE.coordinator }); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--keeper') {
    assert.ok(existsSync(JOURNAL)); mkdirSync(DIRECTORY, { recursive: true });
    const keeper = createLocalKeeper(); console.log(json({ message: 'local paid keeper watching authorized pool', rpc: SCOPE.rpc, balancer: SCOPE.balancer, signer: KEEPER_ADDRESS, gasCapWei: SCOPE.gasCapWei })); await keeper.runForever(1000); return;
  }
  if (args.length === 2 && args[0] === '--additional') {
    await run(false, true, false, Number(args[1])); return;
  }
  if (args.length === 5 && args[0] === '--execute' && args[1] === '--allow-simulated-randomness' && args[2] === '--resume' && args[3] === '--additional') {
    // Keeper reads the draw journal; only one draw process may append to it at a time.
    const lock = `${KEEPER_FILE}.draw-lock`, fd = openSync(lock, 'wx');
    try { writeFileSync(fd, String(process.pid)); await run(true, true, false, Number(args[4])); }
    finally { closeSync(fd); unlinkSync(lock); }
    return;
  }
  assert.ok(args.length === 0 || (args[0] === '--execute' && args[1] === '--allow-simulated-randomness' && (args.length === 2 || (args[2] === '--resume' && (args.length === 3 || (args.length === 4 && args[3] === '--approved-topup-0.5'))))), 'invalid arguments');
  await run(args.length > 0, args.includes('--resume'), args.includes('--approved-topup-0.5'));
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url))) main().catch(e => { console.error(e); process.exitCode = 1; });
