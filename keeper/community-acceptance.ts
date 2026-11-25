// Focused acceptance against the owner's existing fork. Never starts, resets, or stops Anvil.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPublicClient, createTestClient, createWalletClient, decodeEventLog, decodeFunctionData,
  encodeFunctionData, getAddress, http, parseAbi, parseAbiItem,
  type Abi, type Address, type Hash, type Hex, type TransactionReceipt,
} from 'viem';
import { balancerFactoryAbi, erc721Abi, fwaPoolAbi, poolBalancerAbi, shapesAbi } from '../shared/abi';

const RPC = 'http://127.0.0.1:8545';
const FACTORY = '0x6F018fF718Ab5A4287F937e4e4729Aa65610f53b';
const SHAPES = '0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0';
const VRF = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d';
const GWEI = 1_000_000_000n;
const ETH = 10n ** 18n;
const INITIAL_KEEPER_ETH = ETH / 100n;
const HIGH = 1_100_000_000n;
const LOW = 300_000_000n;
const FEES = { maxFeePerGas: 1_500_000_000n, maxPriorityFeePerGas: 50_000_000n };
const more = parseAbi([
  'function acquisitionMeta(uint256) view returns(uint64,uint64,uint64,uint16,uint16,uint256)',
  'function acquisitionEscrowTotal() view returns(uint256)',
  'function deliveryEscrowTotal() view returns(uint256)',
  'function acquisitionRefundCreditTotal() view returns(uint256)',
  'function accruedProtocolFees() view returns(uint256)',
  'function acquisitionRefundCredit(address) view returns(uint256)',
  'function withdrawAcquisitionRefund() returns(uint256)',
]);
const service = parseAbi([
  'function coordinator() view returns(address)',
  'function requestStatus(uint256) view returns(uint8)',
  'function rawFulfillRandomWords(uint256,uint256[])',
  'function deliverRandomness(uint256) returns(bool)',
]);
const paidEvent = parseAbiItem('event KeeperPaid(address indexed keeper,uint256 amount,uint256 gasUsed)');
const mintedEvent = parseAbiItem('event ShapesMinted(uint8 indexed denom,uint256 firstTokenId,uint256 quantity,uint256 cost)');
const vrfEvent = parseAbiItem('event VrfServiceFeePaid(address indexed payer,uint256 amount)');
const requestedEvent = parseAbiItem('event AcquisitionRequested(uint256 indexed requestId,address indexed purchaser,uint256 acquisitionFee,uint256 totalWeight)');
const pub = createPublicClient({ transport: http(RPC, { timeout: 60_000 }), pollingInterval: 100, cacheTime: 0 });
const test = createTestClient({ mode: 'anvil', transport: http(RPC, { timeout: 60_000 }) });
const wallet = createWalletClient({ transport: http(RPC, { timeout: 60_000 }) });
const read = <T,>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v);
const note = (stage: string, value: unknown) => console.log(json({ stage, ...value as object }));
const fresh = () => getAddress(`0x${randomBytes(20).toString('hex')}`);
const dir = mkdtempSync(join(tmpdir(), 'community-keeper-acceptance-'));
const logFile = join(dir, 'keeper.log');
const stateFile = join(dir, 'state.json');
const actors = { creator: fresh(), buyer: fresh(), keeper: fresh() };
const impersonated: Address[] = [];
let keeper: ChildProcess | undefined;
let healthPort: number;
let logText = '';
let balancer: Address;
let pool: Address;
let fromBlock: bigint;
let level = LOW;

async function nextFee() { await test.setNextBlockBaseFeePerGas({ baseFeePerGas: level }); }
async function pinFee(baseFeePerGas: bigint) {
  level = baseFeePerGas;
  await nextFee();
  await test.mine({ blocks: 1 });
  await nextFee();
  assert.equal((await pub.getBlock()).baseFeePerGas, baseFeePerGas);
}
async function impersonate(address: Address) {
  const accounts = await wallet.getAddresses();
  if (!accounts.some(a => a.toLowerCase() === address.toLowerCase())) {
    await test.impersonateAccount({ address });
    impersonated.push(address);
  }
}
async function send(account: Address, address: Address, abi: Abi, functionName: string, args: unknown[] = [], value = 0n, gas = 5_000_000n) {
  const code = await pub.getCode({ address });
  assert.ok(code && code !== '0x', `target ${address} has code`);
  const data = encodeFunctionData({ abi, functionName, args } as never);
  assert.equal(decodeFunctionData({ abi, data }).functionName, functionName);
  await nextFee();
  const hash = await wallet.sendTransaction({ account, chain: null, to: address, data, value, gas, ...FEES });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `${functionName} receipt ${hash}`);
  const [tx, block] = await Promise.all([pub.getTransaction({ hash }), pub.getBlock({ blockNumber: receipt.blockNumber })]);
  assert.equal(tx.input, data);
  assert.equal(tx.from.toLowerCase(), account.toLowerCase());
  assert.equal(tx.to?.toLowerCase(), address.toLowerCase());
  assert.equal(tx.value, value);
  assert.equal(block.baseFeePerGas, level);
  assert.equal(receipt.effectiveGasPrice, level + FEES.maxPriorityFeePerGas);
  assert.ok(receipt.gasUsed > 21_000n);
  note('transaction', { functionName, hash, block: receipt.blockNumber, baseFeeWei: block.baseFeePerGas, gasPriceWei: receipt.effectiveGasPrice, gasUsed: receipt.gasUsed, costWei: receipt.gasUsed * receipt.effectiveGasPrice, valueWei: value });
  await nextFee();
  return receipt;
}
async function health() {
  const response = await fetch(`http://127.0.0.1:${healthPort}/health`);
  return response.json() as Promise<any>;
}
async function until(label: string, predicate: () => Promise<boolean>, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (keeper && keeper.exitCode !== null) throw Error(`keeper exited ${keeper.exitCode}; ${logText.split('\n').slice(-12).join('\n')}; see ${logFile}`);
    if (await predicate()) return;
    await pause(200);
  }
  throw Error(`${label} timed out; ${logText.split('\n').slice(-12).join('\n')}; keeper log ${logFile}`);
}
async function startKeeper() {
  const env = { ...process.env };
  for (const key of ['KEEPER_PRIVATE_KEY', 'CANARY_PLAN', 'CANARY_PLAN_SHA256', 'KEEPER_EXPECTED_ADDRESS', 'EXPECTED_CHAIN_ID']) delete env[key];
  Object.assign(env, {
    RPC_URL: RPC, FACTORY, FROM_BLOCK: String(fromBlock), STATE_FILE: stateFile,
    KEEPER_ADDRESS: actors.keeper, KEEPER_EXPECTED_ADDRESS: actors.keeper, EXPECTED_CHAIN_ID: '31337',
    MAX_LOSS_WEI: '0', MAX_GAS_PRICE_GWEI: '1.5', PRIORITY_GWEI: '0.05', OPERATING_COST_WEI: '0',
    SETUP_MAX_BASEFEE_WEI: String(GWEI), LEGACY_FACTORIES: '0', POLL_MS: '300', HEALTH_PORT: String(healthPort),
    LOW_BALANCE_WEI: '7000000000000000', HEALTH_STALE_MS: '120000',
  });
  keeper = spawn('npm', ['run', 'keeper'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [keeper.stdout, keeper.stderr]) stream!.on('data', data => {
    logText += String(data);
    appendFileSync(logFile, data);
  });
  await until('health server startup', async () => {
    try { return (await health()).keeper.toLowerCase() === actors.keeper.toLowerCase(); }
    catch { return false; }
  });
}
async function stopKeeper() {
  const child = keeper;
  if (!child?.pid) return;
  const exited = new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
  // Only this invocation's npm/tsx process group is stopped; the shared fork is never signalled.
  try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
  await Promise.race([exited, pause(5_000).then(() => { throw Error('keeper child did not stop within 5 seconds'); })]);
  keeper = undefined;
}
async function settledAndStocked() {
  const [have, admission, reconciled, issued, unsettled] = await Promise.all([
    read<readonly number[]>(balancer, poolBalancerAbi, 'getActiveShapes'),
    read<number>(balancer, poolBalancerAbi, 'admissionStatus'),
    read<bigint>(balancer, poolBalancerAbi, 'reconciledSequence'),
    read<bigint>(pool, fwaPoolAbi, 'lastIssuedSequence'),
    read<bigint>(pool, fwaPoolAbi, 'unsettledAcquisitionCount'),
  ]);
  return have[0] === 12 && have.slice(1).every(n => n === 0) && admission === 0 && reconciled === issued && unsettled === 0n;
}
async function cash(stage: string) {
  const [balance, credit, reserve, proceeds, fwaBalance, keeperBalance] = await Promise.all([
    pub.getBalance({ address: balancer }), read<bigint>(balancer, poolBalancerAbi, 'creatorCredit'),
    read<bigint>(balancer, poolBalancerAbi, 'requiredReserve'), read<bigint>(pool, fwaPoolAbi, 'ownerProceeds'),
    pub.getBalance({ address: pool }), pub.getBalance({ address: actors.keeper }),
  ]);
  const buckets = await Promise.all(['acquisitionEscrowTotal', 'deliveryEscrowTotal', 'acquisitionRefundCreditTotal', 'accruedProtocolFees'].map(fn => read<bigint>(pool, more, fn)));
  assert.equal(fwaBalance, buckets.reduce((sum, n) => sum + n, proceeds), 'actual FWA cash equals every named obligation');
  assert.ok(balance >= credit, 'creator credit remains backed');
  note(stage, { block: await pub.getBlockNumber(), poolOperatingWei: balance - credit, creatorCreditWei: credit, reserveWei: reserve, operatingSurplusWei: balance - credit - reserve, fwaBalanceWei: fwaBalance, fwaOwnerProceedsWei: proceeds, purchaserEscrowWei: buckets[0] + buckets[1], purchaserRefundWei: buckets[2], protocolFeeWei: buckets[3], keeperBalanceWei: keeperBalance });
}
async function request() {
  const block = await pub.getBlock();
  const quote = await pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'quoteAcquisitionPrice', args: [1n], account: actors.buyer, gasPrice: level + FEES.maxPriorityFeePerGas } as never);
  const [fee, vrf, total] = quote as readonly [bigint, bigint, bigint];
  assert.equal(total, fee + vrf);
  assert.ok(fee >= 10n ** 16n, 'draw price includes at least the 0.01 ETH Shape backing');
  assert.ok(vrf > 0n, 'VRF fee is priced with a nonzero real transaction gas price');
  const before = await pub.getBalance({ address: actors.buyer });
  const version = await read<bigint>(pool, fwaPoolAbi, 'inventoryVersion');
  const receipt = await send(actors.buyer, pool, fwaPoolAbi, 'acquireBatch', [actors.buyer, 1n, fee, 0n, 10_000n, version, block.timestamp + 600n], total, 3_000_000n);
  const requested = receipt.logs.flatMap(log => {
    if (log.address.toLowerCase() !== pool.toLowerCase()) return [];
    try { return [decodeEventLog({ abi: [requestedEvent], data: log.data, topics: log.topics }).args]; } catch { return []; }
  });
  const vrfPaid = receipt.logs.flatMap(log => {
    if (log.address.toLowerCase() !== pool.toLowerCase()) return [];
    try { return [decodeEventLog({ abi: [vrfEvent], data: log.data, topics: log.topics }).args]; } catch { return []; }
  });
  assert.equal(requested.length, 1);
  assert.equal(vrfPaid.length, 1);
  assert.equal(requested[0].acquisitionFee, fee);
  const after = await pub.getBalance({ address: actors.buyer });
  assert.equal(before - after - receipt.gasUsed * receipt.effectiveGasPrice, fee + vrfPaid[0].amount, 'buyer debit is actual acquisition escrow plus VRF payment');
  note('draw-requested', { requestId: requested[0].requestId, acquisitionFeeWei: fee, quotedVrfWei: vrf, actualVrfWei: vrfPaid[0].amount });
  return { id: requested[0].requestId, fee, receipt };
}
async function selectedShape() {
  const ids = await read<bigint[]>(balancer, poolBalancerAbi, 'getActiveIds');
  const listings = [];
  for (const id of ids) {
    const item = await read<readonly [number, number, number, bigint, bigint]>(balancer, poolBalancerAbi, 'items', [id]);
    const listing = await read<readonly [Address, Address, Address, bigint, bigint, bigint, bigint, number]>(pool, fwaPoolAbi, 'listings', [id]);
    if (listing[7] === 1) listings.push({ id, item, listing });
  }
  const chosen = listings.find(x => x.item[0] === 2 && x.item[1] === 0);
  assert.ok(chosen, 'a real active 0.01 ETH Shape is selectable');
  const word = listings.filter(x => x.listing[6] < chosen.listing[6]).reduce((sum, x) => sum + x.listing[4], 0n);
  return { ...chosen, word };
}
async function assertExecutedFees(hash: Hash, receipt: TransactionReceipt) {
  const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
  const trace = await pub.request({ method: 'debug_traceTransaction', params: [hash, { disableStorage: true, disableMemory: true, enableReturnData: false }] } as never) as { structLogs: { op: string; stack?: string[] }[] };
  if (trace.structLogs.length === 0) {
    note('opcode-trace-gap', { hash, reason: 'Owner fork was started without opcode step tracing; preserved without restart. Actual KeeperPaid amounts are checked against nonzero mined fees.' });
    return false;
  }
  const values = (op: string) => trace.structLogs.flatMap((entry, i) => {
    if (entry.op !== op) return [];
    const top = trace.structLogs[i + 1]?.stack?.at(-1);
    assert.ok(top, `trace result after ${op}`);
    return [BigInt(top.startsWith('0x') ? top : `0x${top}`)];
  });
  const basefees = values('BASEFEE'), prices = values('GASPRICE');
  assert.ok(basefees.length > 0 && prices.length > 0, 'actual upkeep executes BASEFEE and GASPRICE');
  for (const v of basefees) assert.equal(v, block.baseFeePerGas, 'BASEFEE inside execution matches mined header');
  for (const v of prices) assert.equal(v, receipt.effectiveGasPrice, 'GASPRICE inside execution matches paid receipt');
  assert.ok(block.baseFeePerGas! > 0n && receipt.effectiveGasPrice > 0n);
  note('executed-fees', { hash, block: receipt.blockNumber, baseFeeWei: block.baseFeePerGas, gasPriceWei: receipt.effectiveGasPrice, basefeeOpcodes: basefees.length, gaspriceOpcodes: prices.length });
  return true;
}

async function main() {
  const [version, info, chain, original] = await Promise.all([
    pub.request({ method: 'web3_clientVersion' }),
    pub.request({ method: 'anvil_nodeInfo' } as never) as Promise<{ forkConfig?: { forkUrl?: string; forkBlockNumber?: number } }>,
    pub.getChainId(), pub.getBlock(),
  ]);
  assert.match(version, /anvil/i, 'the endpoint is the real local Anvil node');
  assert.equal(chain, 31337, 'never run this against mainnet');
  assert.ok(info.forkConfig, 'the local Anvil is a fork');
  assert.ok(original.number >= 26_482_707n, 'fork includes deployed community factory');
  const factoryCode = await pub.getCode({ address: FACTORY });
  assert.ok(factoryCode && factoryCode !== '0x', 'community factory exists on this fork');
  note('fork', { rpc: RPC, chain, startingBlock: original.number, originalBaseFeeWei: original.baseFeePerGas, actors, evidenceDirectory: dir });
  try {
    for (const [name, address] of Object.entries(actors)) {
      assert.ok(!await pub.getCode({ address }), `fresh ${name} has no delegation/code`);
      assert.equal(await pub.getTransactionCount({ address }), 0, `fresh ${name} nonce`);
      await impersonate(address);
      await test.setBalance({ address, value: name === 'keeper' ? INITIAL_KEEPER_ETH : ETH });
    }
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    healthPort = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await pinFee(LOW);
    const fee = await read<bigint>(SHAPES, shapesAbi, 'mintFee');
    const salt = `0x${randomBytes(32).toString('hex')}` as Hex;
    balancer = await read<Address>(FACTORY, balancerFactoryAbi, 'predictBalancer', [actors.creator, salt]);
    const initialDeposit = 3n * ETH / 10n;
    const creatorBefore = await pub.getBalance({ address: actors.creator });
    const creation = await send(actors.creator, FACTORY, balancerFactoryAbi, 'createBalancer', [salt, {
      markupBps: 2500, creatorRevenueBps: 400, target: 12n, mintFeeCap: fee, curatedRequired: false,
      settingsHash: await read<Hex>(FACTORY, balancerFactoryAbi, 'creationSettingsHash'),
    }, []], initialDeposit, 10_000_000n);
    assert.equal(creatorBefore - await pub.getBalance({ address: actors.creator }) - creation.gasUsed * creation.effectiveGasPrice, initialDeposit);
    assert.equal(await pub.getBalance({ address: balancer }), initialDeposit, 'all 0.3 ETH creation funding is in the pool');
    pool = await read<Address>(balancer, poolBalancerAbi, 'pool');
    fromBlock = creation.blockNumber;
    // An owner's long-lived fork can predate an admin update. Align only our pool through its real creator path.
    const mainnet = createPublicClient({ transport: http('https://mainnet.gateway.tenderly.co', { timeout: 60_000 }) });
    assert.equal(await mainnet.getChainId(), 1);
    const liveBlock = await mainnet.getBlockNumber();
    const liveEconomics = await mainnet.readContract({ address: FACTORY, abi: balancerFactoryAbi, functionName: 'economics', blockNumber: liveBlock });
    assert.equal(BigInt(liveEconomics.gasPriceCeiling), FEES.maxFeePerGas, 'current mainnet ceiling still matches the approved 1.5 gwei');
    assert.equal(BigInt(liveEconomics.workFee), 20_000_000_000_000n);
    const forkEconomics = await read<typeof liveEconomics>(FACTORY, balancerFactoryAbi, 'economics');
    const aligned = json(liveEconomics) !== json(forkEconomics);
    if (aligned) await send(actors.creator, balancer, poolBalancerAbi, 'setLocalEconomics', [liveEconomics]);
    assert.deepEqual(await read(balancer, poolBalancerAbi, 'effectiveEconomics'), liveEconomics);
    note('economics-environment', { mainnetReadBlock: liveBlock, forkFactoryEconomics: forkEconomics, testedEconomics: liveEconomics, source: aligned ? 'test pool local values copied from mainnet; shared fork factory preserved' : 'fork factory matches mainnet' });
    assert.equal(await read<bigint>(balancer, poolBalancerAbi, 'listedShapePrizes'), 0n);
    assert.equal(await read<number>(balancer, poolBalancerAbi, 'admissionStatus'), 2);
    await cash('created-unstocked');
    await pinFee(HIGH);
    await startKeeper();
    await until('high gas first-listing skip', async () => logText.includes('skip: first listing waits for lower gas'));
    assert.equal((await health()).stats.sent, 0);
    assert.equal(await read<bigint>(balancer, poolBalancerAbi, 'listedShapePrizes'), 0n);
    await cash('high-gas-wait');
    await pinFee(LOW);
    await until('initial stocking and opening', async () => await settledAndStocked() && Object.keys((await health()).pending).length === 0);
    await stopKeeper();
    const firstStock = JSON.parse(readFileSync(stateFile, 'utf8'));
    const initialReceipts = firstStock.receipts as { hash: Hash }[];
    assert.ok(initialReceipts.length >= 3, 'twelve Shapes are stocked in at least three bounded batches');
    const initialEconomics = await read<Record<string, bigint | number>>(balancer, poolBalancerAbi, 'effectiveEconomics');
    const e = (key: string) => BigInt(initialEconomics[key]);
    assert.equal(e('workFee'), 20_000_000_000_000n);
    assert.equal(e('gasPriceCeiling'), FEES.maxFeePerGas);
    let quantity = 0n, mintCost = 0n;
    for (const entry of initialReceipts) {
      const receipt = await pub.getTransactionReceipt({ hash: entry.hash });
      const mints = receipt.logs.flatMap(log => {
        if (log.address.toLowerCase() !== balancer.toLowerCase()) return [];
        try { return [decodeEventLog({ abi: [mintedEvent], data: log.data, topics: log.topics }).args]; } catch { return []; }
      });
      const batch = mints.reduce((n, m) => n + m.quantity, 0n);
      assert.ok(batch > 0n && batch <= 5n, 'each initial keeper call lists at most five Shape units');
      const payment = receipt.logs.flatMap(log => {
        if (log.address.toLowerCase() !== balancer.toLowerCase()) return [];
        try { return [decodeEventLog({ abi: [paidEvent], data: log.data, topics: log.topics }).args]; } catch { return []; }
      });
      assert.equal(payment.length, 1);
      const header = await pub.getBlock({ blockNumber: receipt.blockNumber });
      const measured = [payment[0].gasUsed, e('maxGas'), e('baseGas') + batch * (e('shapeGas') + e('prizeGas'))].reduce((a, b) => a < b ? a : b);
      const price = [receipt.effectiveGasPrice, header.baseFeePerGas! + e('priorityAllowance'), e('gasPriceCeiling')].reduce((a, b) => a < b ? a : b);
      assert.equal(payment[0].amount, (measured + e('overheadGas')) * price + batch * 20_000_000_000_000n, 'actual listing pay includes exactly 0.00002 ETH per Shape plus bounded gas reimbursement');
      assert.ok(price > 0n);
      note('listing-payment', { hash: receipt.transactionHash, measuredGasFromEvent: payment[0].gasUsed, rewardWei: payment[0].amount, workFeeWei: batch * 20_000_000_000_000n, executedPriceFromPaymentWei: (payment[0].amount - batch * 20_000_000_000_000n) / (measured + e('overheadGas')), expectedPriceWei: price });
      quantity += batch;
      mintCost += mints.reduce((n, m) => n + m.cost, 0n);
    }
    assert.equal(quantity, 12n);
    assert.equal(mintCost, 12n * (10n ** 16n + fee), 'absolute backing plus live mint fee for twelve Shapes');
    const opcodeTraceVerified = await assertExecutedFees(initialReceipts[0].hash, await pub.getTransactionReceipt({ hash: initialReceipts[0].hash }));
    await cash('initially-open');
    const draw = await request();
    const shape = await selectedShape();
    const coordinator = await read<Address>(VRF, service, 'coordinator');
    await impersonate(coordinator);
    const coordinatorBalance = await pub.getBalance({ address: coordinator });
    assert.ok(coordinatorBalance >= ETH / 100n, 'the real coordinator must already have gas funding; never fake protocol balances');
    await test.mine({ blocks: 3 });
    await pinFee(LOW);
    assert.equal(await read<number>(VRF, service, 'requestStatus', [draw.id]), 1);
    await send(coordinator, VRF, service, 'rawFulfillRandomWords', [draw.id, [shape.word]]);
    if (await read<number>(VRF, service, 'requestStatus', [draw.id]) === 2) await send(actors.buyer, VRF, service, 'deliverRandomness', [draw.id]);
    assert.equal(await read<number>(VRF, service, 'requestStatus', [draw.id]), 4);
    const acquisition = await read<readonly [Address, bigint, bigint, bigint, number, boolean]>(pool, fwaPoolAbi, 'acquisitions', [draw.id]);
    assert.equal(acquisition[4], 2, 'actual fulfilled Shape win, not a timeout/refund');
    assert.equal(acquisition[3], shape.id);
    assert.equal((await read<Address>(SHAPES, erc721Abi, 'ownerOf', [shape.listing[3]])).toLowerCase(), actors.buyer.toLowerCase());
    assert.equal(await settledAndStocked(), false, 'keeper work remains after the real win');
    await cash('won-before-restock');
    await startKeeper();
    await until('reconcile and restock the won Shape', async () => await settledAndStocked() && Object.keys((await health()).pending).length === 0);
    await stopKeeper();
    await cash('restocked-open');
    const stuck = await request();
    const beforeRefund = await read<bigint>(pool, more, 'acquisitionRefundCredit', [actors.buyer]);
    const metadata = await read<readonly [bigint, bigint, bigint, number, number, bigint]>(pool, more, 'acquisitionMeta', [stuck.id]);
    const economics = await read<{ processGraceBlocks: number }>(balancer, poolBalancerAbi, 'effectiveEconomics');
    const eligible = metadata[1] + 1n > stuck.receipt.blockNumber + BigInt(economics.processGraceBlocks)
      ? metadata[1] + 1n : stuck.receipt.blockNumber + BigInt(economics.processGraceBlocks);
    const head = await pub.getBlockNumber();
    assert.ok(eligible - head < 256n, 'bounded local timeout/grace mining');
    if (eligible > head) await test.mine({ blocks: Number(eligible - head) });
    // Empty mined blocks decay basefee. Keep the quote block and next inclusion block in the stated regime.
    await pinFee(LOW);
    assert.equal((await read<readonly unknown[]>(pool, fwaPoolAbi, 'acquisitions', [stuck.id]))[4], 1, 'the expired head still requires a processor');
    await cash('stuck-unprocessed');
    await startKeeper();
    await until('keeper processes the expired draw', async () => await settledAndStocked() && Object.keys((await health()).pending).length === 0);
    assert.equal((await read<readonly unknown[]>(pool, fwaPoolAbi, 'acquisitions', [stuck.id]))[4], 3, 'keeper expired the undelivered draw');
    const refunded = await read<bigint>(pool, more, 'acquisitionRefundCredit', [actors.buyer]) - beforeRefund;
    assert.equal(refunded, stuck.fee, 'the full acquisition fee becomes purchaser pull credit');
    const finalHealth = await health();
    assert.equal(finalHealth.ok, true);
    assert.equal(finalHealth.balancers, 1, 'the keeper acceptance services only its newly created pool');
    await stopKeeper();
    const buyerBeforeClaim = await pub.getBalance({ address: actors.buyer });
    const withdrawal = await send(actors.buyer, pool, more, 'withdrawAcquisitionRefund');
    assert.equal(await pub.getBalance({ address: actors.buyer }) - buyerBeforeClaim + withdrawal.gasUsed * withdrawal.effectiveGasPrice, beforeRefund + refunded, 'refund round trip returns cash to the buyer');
    assert.equal(await read<bigint>(pool, more, 'acquisitionRefundCredit', [actors.buyer]), 0n);
    await cash('stuck-resolved-refund-claimed');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.deepEqual(state.pending, {});
    assert.deepEqual(state.accounting, {});
    assert.equal(state.stats.reverted, 0);
    const paid = await pub.getLogs({ address: balancer, event: paidEvent, args: { keeper: actors.keeper }, fromBlock, toBlock: 'latest' });
    let reward = 0n, gasCost = 0n;
    for (const event of paid) {
      const receipt = await pub.getTransactionReceipt({ hash: event.transactionHash });
      const tx = await pub.getTransaction({ hash: event.transactionHash });
      assert.equal(tx.from.toLowerCase(), actors.keeper.toLowerCase());
      assert.equal(tx.value, 0n);
      assert.equal(decodeFunctionData({ abi: poolBalancerAbi, data: tx.input }).functionName, 'performUpkeep');
      assert.ok(receipt.effectiveGasPrice > 0n && receipt.effectiveGasPrice <= FEES.maxFeePerGas);
      reward += event.args.amount!;
      gasCost += receipt.gasUsed * receipt.effectiveGasPrice;
      note('keeper-receipt', { hash: event.transactionHash, block: receipt.blockNumber, gasUsed: receipt.gasUsed, gasPriceWei: receipt.effectiveGasPrice, rewardWei: event.args.amount, gasCostWei: receipt.gasUsed * receipt.effectiveGasPrice });
    }
    assert.equal(await pub.getTransactionCount({ address: actors.keeper }), paid.length, 'every keeper nonce has a successful paid receipt');
    const endingBalance = await pub.getBalance({ address: actors.keeper });
    assert.equal(endingBalance - INITIAL_KEEPER_ETH, reward - gasCost, 'the original 0.01 ETH reconciles exactly without extra funding');
    assert.equal(BigInt(state.stats.earnedWei), reward);
    assert.equal(BigInt(state.stats.spentWei), gasCost);
    assert.ok(endingBalance >= INITIAL_KEEPER_ETH, 'the chosen no-subsidy policy did not consume principal in this run');
    note('scorecard', { initialKeeperWei: INITIAL_KEEPER_ETH, endingKeeperWei: endingBalance, keeperRewardWei: reward, keeperGasCostWei: gasCost, keeperNetWei: reward - gasCost, initialMintUnits: quantity, initialMintCostWei: mintCost, initialBackingWei: 12n * 10n ** 16n, highGasWaitBaseFeeWei: HIGH, lowGasResumeBaseFeeWei: LOW, deliveredShapes: 1, expiredDraws: 1, purchaserRefundWei: refunded, keeperTransactions: paid.length, opcodeTraceVerified, balancer, pool, evidenceDirectory: dir, limitations: 'Controlled fork randomness and gas; local pool economics copied from current mainnet when needed. Opcode tracing may be unavailable and is reported explicitly. No live inclusion, market timing, production alert delivery, or exhaustive economic regimes proven.' });
    console.log('COMMUNITY KEEPER ACCEPTANCE PASSED');
  } finally {
    await stopKeeper();
    for (const address of impersonated.reverse()) await test.stopImpersonatingAccount({ address });
    if (original.baseFeePerGas !== null) await test.setNextBlockBaseFeePerGas({ baseFeePerGas: original.baseFeePerGas });
  }
}

main().catch(error => { console.error((error as Error).message); console.error(`Evidence: ${dir}`); process.exitCode = 1; });
