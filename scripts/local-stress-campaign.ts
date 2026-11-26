// Local diagnostic: actual FWA, Shapes, Packs and Keeper.tick; coordinator callbacks are simulated.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createPublicClient, createTestClient, createWalletClient, decodeEventLog, decodeFunctionData, encodePacked, getAddress, http, keccak256, parseAbi, type Abi, type Address, type Hash, type TransactionReceipt } from 'viem';
import { Keeper } from '../keeper/keeper';
import { balancerFactoryAbi, fwaPoolAbi, poolBalancerAbi } from '../shared/abi';
import { DENOMS, SHAPES_IN, requiredReserveAt, type Economics } from '../shared/planner';

const ROOT = resolve(import.meta.dirname, '..');
export const STRESS_SCOPE = {
  rpc: 'http://127.0.0.1:18555', upstream: 'http://127.0.0.1:18557', chainId: 31337,
  factory: getAddress('0xbe49677a403f77136e81498e5681f8dc22aa1181'),
  implementation: getAddress('0xc02d40577880fa2c489fc5461ce3830d4eed7724'),
  creator: getAddress('0x00000000000000000000000000000000000c5501'),
  buyer: getAddress('0x00000000000000000000000000000000000c5502'),
  keeper: getAddress('0x00000000000000000000000000000000000c5503'),
  demo: getAddress('0x8B4087D01443ba7619BB3A6E2a8668C5AF0d1955'),
  service: getAddress('0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d'),
  coordinator: getAddress('0xD7f86b4b8Cae7D942340FF628F82735b7a20893a'),
} as const;
const ETH = 10n ** 18n, BASE = 500_000_000n, BID = 550_000_000n;
const CAPS = { maxScenarios: 24, maxDraws: 3000, maxTransactions: 25000, maxMilliseconds: 30 * 60_000, gasWei: 500n * ETH, purchasesWei: 2000n * ETH };
const serviceAbi = parseAbi(['function coordinator() view returns(address)', 'function requestPool(uint256) view returns(address)', 'function requestStatus(uint256) view returns(uint8)', 'function rawFulfillRandomWords(uint256,uint256[])']);
const demoAbi = parseAbi(['function mint(address,uint256)', 'function approve(address,uint256)', 'function ownerOf(uint256) view returns(address)']);
const commitmentAbi = parseAbi(['function s_requestCommitments(uint256) view returns(bytes32)']);
const nftAbi = parseAbi(['function ownerOf(uint256) view returns(address)', 'function backingOf(uint256) view returns(uint256)', 'function valueOf(uint256) view returns(uint256)', 'function mintFee() view returns(uint256)']);
const fwaBucketsAbi = parseAbi(['function acquisitionEscrowTotal() view returns(uint256)', 'function deliveryEscrowTotal() view returns(uint256)', 'function acquisitionRefundCreditTotal() view returns(uint256)', 'function accruedProtocolFees() view returns(uint256)', 'function acquisitionRefundCredit(address) view returns(uint256)']);
const requestEventsAbi = parseAbi(['event AcquisitionRequested(uint256 indexed requestId,address indexed purchaser,uint256 acquisitionFee,uint256 totalWeight)']);
const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2);
const max = (a: bigint, b: bigint) => a > b ? a : b;
export function requestOwnerBase(weight: bigint, weightedValue: bigint, escrowedFee: bigint) {
  assert.ok(weight > 0n, 'request inventory weight must be positive');
  const base = weightedValue / weight; return base < escrowedFee ? base : escrowedFee;
}
export function acquisitionOutcome(status: number): 'nft' | 'expired' | 'refunded' {
  if (status === 2) return 'nft'; if (status === 3) return 'expired'; if (status === 4) return 'refunded';
  throw new Error(`acquisition not settled as delivery or pull refund: ${status}`);
}
export function bankrollValues(cash: bigint, backing: bigint, fees: bigint, capital: bigint) {
  assert.ok(cash >= fees, 'creator fees exceed cash');
  const signed = cash + backing - fees - capital; return { operating: cash - fees, signed, clipped: max(0n, signed) };
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function target(entries: [number, number][]) { const counts = Array<number>(16).fill(0); for (const [d, n] of entries) counts[d] = n; return counts; }
// Every scenario reverts the child to the same base, so one CREATE2 salt reuses the already warm clone storage.
export const STRESS_CREATION_SALT = keccak256(encodePacked(['string'], ['local-stress-v2:small']));
export function resumeEvidence(previous: any, source: string) {
  assert.equal(previous.schema, 'local-stress-v2'); assert.equal(previous.chainId, 31337); assert.equal(previous.randomness, 'simulated');
  const retained = previous.scenarios.filter((scenario: { status: string }) => ['complete', 'paused'].includes(scenario.status));
  const retainedIds = new Set(retained.map((scenario: { id: string }) => scenario.id));
  return { scenarios: retained, findings: (previous.findings ?? []).map((finding: any) => ({ ...finding, attemptSource: source, historical: Boolean(finding.scenarioId && !retainedIds.has(finding.scenarioId)) })), priorAttempts: [...(previous.priorAttempts ?? []), { source, status: previous.status, startedAt: previous.startedAt, finishedAt: previous.finishedAt, revision: previous.revision, budget: previous.budget, scenarios: previous.scenarios.filter((scenario: { id: string }) => !retainedIds.has(scenario.id)) }] };
}
const DESIGNS = [
  { name: 'small', counts: target([[0, 20]]), markup: 1500 },
  { name: 'balanced', counts: target([[0, 12], [1, 4], [2, 1], [9, 2]]), markup: 2500 },
  { name: 'topheavy', counts: target([[0, 4], [1, 2], [3, 1]]), markup: 2500 },
  { name: 'jackpot', counts: target([[0, 24], [1, 6], [2, 2], [4, 1], [9, 2]]), markup: 2500 },
  { name: 'zeroFee', counts: target([[0, 20], [9, 2]]), markup: 1000 },
  { name: 'pack', counts: target([[0, 10], [9, 3], [10, 2], [12, 1]]), markup: 2500 },
];
export function stressPlan() {
  const baseline = DESIGNS.flatMap(d => [10, 240, 86400].map(rate => ({ id: `${d.name}-${rate}`, design: d, rate, mode: 'baseline', seed: 1 })));
  return [...baseline, ...['keeperOutage', 'gasSpike', 'forcedLargest', 'feeReinvestOnGap', 'feeWithdrawEvery20', 'zeroDemandWinddown'].map(mode => ({ id: `balanced-${mode}`, design: DESIGNS[1], rate: 240, mode, seed: 1 }))];
}
type Plan = ReturnType<typeof stressPlan>[number];
type Flows = { buyerGrossPaidWei: bigint; drawChargeWei: bigint; vrfChargesWei: bigint; ownerReceiptsWei: bigint; mintFeesWei: bigint; keeperPayWei: bigint; creatorFeesAccruedWei: bigint; feesReinvestedWei: bigint; withdrawnFeesWei: bigint; wonBackingWei: bigint; additionalCapitalWei: bigint; totalWithdrawnWei: bigint };
const flows = (): Flows => ({ buyerGrossPaidWei: 0n, drawChargeWei: 0n, vrfChargesWei: 0n, ownerReceiptsWei: 0n, mintFeesWei: 0n, keeperPayWei: 0n, creatorFeesAccruedWei: 0n, feesReinvestedWei: 0n, withdrawnFeesWei: 0n, wonBackingWei: 0n, additionalCapitalWei: 0n, totalWithdrawnWei: 0n });
interface Snapshot { fwaCashWei: bigint; fwaAcquisitionEscrowWei: bigint; fwaDeliveryEscrowWei: bigint; fwaRefundCreditTotalWei: bigint; fwaProtocolFeesWei: bigint; buyerRefundCreditWei: bigint; block: bigint; timestamp: bigint; cashWei: bigint; operatingWei: bigint; reservedFeesWei: bigint; bankrollProfitWei: bigint; capitalWei: bigint; backingWei: bigint; reserveWei: bigint; shortfallWei: bigint; bankrollPnlWei: bigint; admission: number; issued: bigint; reconciled: bigint; unsettled: bigint; ownerProceeds: bigint; counts: readonly number[] }
interface Scenario {
  mintFeeWei?: bigint; curatedNftWins: number; actualDrawsPerDay: number;
  id: string; design: string; drawsPerDay: number; seed: number; mode: string; status: string; error?: string; target: number[]; markupBps: number; initialDepositWei: bigint;
  drawsAttempted: number; drawsSettled: number; nftWins: number; refunds: number; expiredRefunds: number; selectionRefunds: number; expectedRefundCreditWei: bigint; keeperTransactions: number; shortfallEvents: number; elapsedSimSeconds: number;
  flows: Flows; final?: Snapshot; trace: object[]; tierWins: number[]; notes: string[]; initial?: Snapshot; setupFlows?: Flows; balancer?: Address; pool?: Address;
}
interface ReceiptEntry { scenarioId: string; hash: Hash; actor: Address; target: Address; function: string; valueWei: bigint; gasUsed: bigint; gasPriceWei: bigint; baseFeeWei: bigint; block: bigint; status: string }

class Campaign {
  readonly pub = createPublicClient({ transport: http(STRESS_SCOPE.rpc, { retryCount: 0, timeout: 30_000 }), cacheTime: 0 });
  readonly test = createTestClient({ mode: 'anvil', transport: http(STRESS_SCOPE.rpc, { retryCount: 0, timeout: 30_000 }) });
  readonly wallet = createWalletClient({ transport: http(STRESS_SCOPE.rpc, { retryCount: 0, timeout: 30_000 }) });
  readonly started: number;
  ledger: any;
  readonly results: any;
  readonly receipts: ReceiptEntry[] = [];
  readonly recorded = new Set<string>();
  readonly drawnItems = new Map<string, { kind: number; denom: number }>();
  active?: Scenario;
  keeper?: Keeper;
  balancer?: Address;
  pool?: Address;
  baseFee = BASE;
  gas = 0n;
  purchases = 0n;
  transactions = 0;
  admitted = 0;
  constructor(readonly directory: string, readonly maxDraws: number, readonly ledgerPath: string, readonly branch: any, readonly resumeSource?: string) {
    assert.equal(branch.rpc, STRESS_SCOPE.rpc); assert.equal(branch.sourceProxy, STRESS_SCOPE.upstream); assert.equal(branch.chainId, STRESS_SCOPE.chainId);
    assert.deepEqual(execFileSync('lsof', ['-nP', '-iTCP:18555', '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' }).trim().split('\n').filter(x => x.startsWith('p')), [`p${branch.branchPid}`], 'isolated child PID must match prepared branch');
    this.ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { startedAt: Date.now(), transactions: 0, admitted: 0, gasWei: '0', purchasesWei: '0', receipts: [] };
    assert.equal(this.ledger.rpc ?? STRESS_SCOPE.rpc, STRESS_SCOPE.rpc);
    this.started = this.ledger.startedAt; this.transactions = this.ledger.transactions; this.admitted = this.ledger.admitted; this.gas = BigInt(this.ledger.gasWei); this.purchases = BigInt(this.ledger.purchasesWei); this.receipts.push(...this.ledger.receipts);
    assert.ok(!this.ledger.branchInstanceId || this.ledger.branchInstanceId === branch.branchInstanceId, 'budget ledger belongs to this exact child instance'); this.ledger.branchInstanceId = branch.branchInstanceId;
    this.results = { branch, schema: 'local-stress-v2', status: 'running', startedAt: new Date(this.started).toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), chainId: 31337, rpcLabel: 'isolated Anvil 18555; capped parent read proxy', randomness: 'simulated', budget: {}, scenarios: [], findings: [], limitations: [
      'Coordinator impersonation supplies synthetic words. This does not test Chainlink proof validation, authentic delivery, timing reliability or coordinator commitment consumption.',
      'Fixed admitted-draw caps; elapsedSimSeconds is the actual simulated horizon, not a measured 30-day operating claim.',
      'Gas/transaction and draw caps include conservative reservations for a send whose result is uncertain; repairs never release an uncertain physical-work budget.',
      'One deterministic seed. Local transactions omit competing users, the gas market and mainnet keeper availability.',
      'Topheavy and Pack designs include one existing local DemoNFT at a creator price of 0.2 ETH; no invented curated NFT cost basis. Other curated collections, dependency-paused and parameter-width extremes are not covered.',
      'Draw-rate labels are nominal schedules. Maintenance serializes batches; actualDrawsPerDay reports observed throughput over the actual simulated horizon.',
      'The 30-day zero-demand interval is inactivity, not 30 days of measured sales. This is diagnostic evidence, not release readiness.',
    ] };
    if (resumeSource) {
      const previous = JSON.parse(readFileSync(resumeSource, 'utf8'));
      assert.equal(previous.branch.branchInstanceId, branch.branchInstanceId, 'resume evidence belongs to this exact child');
      assert.equal(previous.startedAt, new Date(this.started).toISOString(), 'resume must preserve the original budget clock');
      assert.ok(previous.budget.transactions <= this.transactions && previous.budget.admittedDraws <= this.admitted, 'resume counters must already be in the durable budget ledger');
      Object.assign(this.results, resumeEvidence(previous, resumeSource));
    }
  }
  save() {
    Object.assign(this.ledger, { rpc: STRESS_SCOPE.rpc, transactions: this.transactions, admitted: this.admitted, gasWei: String(this.gas), purchasesWei: String(this.purchases), receipts: this.receipts });
    mkdirSync(dirname(this.ledgerPath), { recursive: true }); writeFileSync(this.ledgerPath + '.tmp', json(this.ledger) + '\n'); renameSync(this.ledgerPath + '.tmp', this.ledgerPath);
    this.results.budget = { limits: CAPS, transactions: this.transactions, admittedDraws: this.admitted, gasWei: this.gas, purchasesWei: this.purchases, elapsedMilliseconds: Date.now() - this.started };
    for (const file of [resolve(this.directory, 'results.json'), resolve(ROOT, 'app/public/stress-results/results.json')]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file + '.tmp', json(this.results) + '\n'); renameSync(file + '.tmp', file); }
    writeFileSync(resolve(this.directory, 'receipts.json'), json(this.receipts) + '\n');
  }
  check(gas = 0n, price = BID, purchase = 0n, count = 1) {
    assert.ok(Date.now() - this.started < CAPS.maxMilliseconds, 'campaign wall-clock budget reached');
    assert.ok(this.transactions + count <= CAPS.maxTransactions, 'transaction cap reached');
    assert.ok(this.gas + gas * price <= CAPS.gasWei, 'gas cap reached');
    assert.ok(this.purchases + purchase <= CAPS.purchasesWei, 'purchase cap reached');
    assert.ok(this.admitted <= CAPS.maxDraws, 'draw cap reached');
  }
  async identity() {
    assert.equal(await this.pub.getChainId(), STRESS_SCOPE.chainId);
    const info: any = await this.pub.request({ method: 'anvil_nodeInfo' as never });
    assert.equal(info.forkConfig.forkUrl, STRESS_SCOPE.upstream, 'writes require isolated child fork');
    assert.equal(BigInt(info.forkConfig.forkBlockNumber), BigInt(this.branch.sourceAnchor), 'fork source anchor must remain fixed');
    const metadata: any = await this.pub.request({ method: 'anvil_metadata' as never }); assert.equal(metadata.instanceId, this.branch.branchInstanceId, 'child process was reset/replaced');
    assert.equal(getAddress(await this.read(STRESS_SCOPE.factory, balancerFactoryAbi, 'implementation')), STRESS_SCOPE.implementation);
  }
  read(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint): Promise<any> {
    return this.pub.readContract({ address, abi, functionName, args, blockNumber } as never);
  }
  b(fn: string, args: readonly unknown[] = [], block?: bigint) { assert.ok(this.balancer); return this.read(this.balancer, poolBalancerAbi, fn, args, block); }
  p(fn: string, args: readonly unknown[] = [], block?: bigint) { assert.ok(this.pool); return this.read(this.pool, fwaPoolAbi, fn, args, block); }
  async hold() { this.check(0n, BID, 0n, 0); await this.test.setNextBlockBaseFeePerGas({ baseFeePerGas: this.baseFee }); }
  async mine(seconds = 1) {
    await this.hold(); const block = await this.pub.getBlock();
    await this.test.setNextBlockTimestamp({ timestamp: block.timestamp + BigInt(Math.max(1, Math.ceil(seconds))) });
    await this.test.mine({ blocks: 1 }); await this.hold();
  }
  validateWrite(actor: Address, address: Address, fn: string, args: readonly unknown[] = []) {
    if (same(address, STRESS_SCOPE.demo)) {
      assert.ok(same(actor, STRESS_SCOPE.creator)); assert.ok(['mint', 'approve'].includes(fn)); assert.equal(args[1], 900001n);
      assert.ok(same(String(args[0]), fn === 'mint' ? STRESS_SCOPE.creator : this.balancer!)); return;
    }
    if (same(actor, STRESS_SCOPE.coordinator)) { assert.ok(same(address, STRESS_SCOPE.service)); assert.equal(fn, 'rawFulfillRandomWords'); return; }
    if (same(actor, STRESS_SCOPE.keeper)) { assert.ok(this.balancer && same(address, this.balancer)); assert.equal(fn, 'performUpkeep'); return; }
    if (same(actor, STRESS_SCOPE.buyer)) { assert.ok(this.pool && same(address, this.pool)); assert.equal(fn, 'acquireBatch'); return; }
    assert.ok(same(actor, STRESS_SCOPE.creator));
    if (fn === 'createBalancer') assert.ok(same(address, STRESS_SCOPE.factory));
    else { assert.ok(this.balancer && same(address, this.balancer)); assert.ok(['reinvestCreatorFees', 'claimSurplus', 'close', 'unlistShapes', 'depositETH'].includes(fn)); }
  }
  async record(hash: Hash, expectedActor: Address, expectedTarget: Address, fn: string, value: bigint, reservation: bigint) {
    const r = await this.pub.waitForTransactionReceipt({ hash, pollingInterval: 25, timeout: 30_000 });
    const receiptKey = `${this.active!.id}:${hash}`; assert.ok(!this.recorded.has(receiptKey)); this.recorded.add(receiptKey);
    const [tx, block] = await Promise.all([this.pub.getTransaction({ hash }), this.pub.getBlock({ blockNumber: r.blockNumber })]);
    this.gas += r.gasUsed * r.effectiveGasPrice - reservation;
    if (fn === 'acquireBatch' && r.status !== 'success') this.purchases -= value;
    this.receipts.push({ scenarioId: this.active!.id, hash, actor: tx.from, target: expectedTarget, function: fn, valueWei: value, gasUsed: r.gasUsed, gasPriceWei: r.effectiveGasPrice, baseFeeWei: block.baseFeePerGas!, block: r.blockNumber, status: r.status });
    this.save();
    assert.ok(same(tx.from, expectedActor)); assert.ok(tx.to && same(tx.to, expectedTarget)); assert.equal(tx.value, value); assert.equal(block.baseFeePerGas, this.baseFee); assert.equal(r.blockHash, block.hash);
    assert.equal(r.status, 'success', `reverted ${fn}: ${hash}`);
    const f = this.active!.flows;
    if (fn === 'acquireBatch') {
      const decoded = decodeFunctionData({ abi: fwaPoolAbi, data: tx.input }); assert.equal(decoded.functionName, 'acquireBatch');
      const args = decoded.args as readonly [Address, bigint, bigint, bigint, bigint, bigint, bigint]; const count = args[1];
      assert.ok(count > 0n && count <= 5n); f.buyerGrossPaidWei += value; f.drawChargeWei += count * args[2]; f.vrfChargesWei += value - count * args[2];
      assert.ok(value > count * args[2], 'actual all-in payment includes positive charged VRF fee');
    }
    if (fn === 'depositETH') f.additionalCapitalWei += value;
    for (const log of r.logs) {
      if (!this.balancer || !same(log.address, this.balancer)) continue;
      let event: any; try { event = decodeEventLog({ abi: poolBalancerAbi, data: log.data, topics: log.topics }); } catch { continue; }
      const a = event.args;
      if (event.eventName === 'ProceedsCollected') f.ownerReceiptsWei += a.amount;
      if (event.eventName === 'KeeperPaid') f.keeperPayWei += a.amount;
      if (event.eventName === 'CreatorFeesAccrued') f.creatorFeesAccruedWei += a.amount;
      if (event.eventName === 'CreatorFeesReinvested') f.feesReinvestedWei += a.amount;
      if (event.eventName === 'ItemDrawn' && a.delivered) { assert.ok(a.kind === 1 || a.kind === 2); this.drawnItems.set(String(a.listingId), { kind: Number(a.kind), denom: Number(a.denom) }); }
      if (event.eventName === 'SurplusClaimed') f.totalWithdrawnWei += a.amount;
      if (event.eventName === 'ShapesMinted') {
        const fee = a.cost - BigInt(a.quantity) * DENOMS[a.denom];
        assert.equal(fee, BigInt(a.quantity) * BigInt(SHAPES_IN[a.denom]) * this.active!.mintFeeWei!, 'mint fees equal actual frozen Shapes fee per underlying Shape'); f.mintFeesWei += fee;
      }
    }
    if (same(expectedActor, STRESS_SCOPE.keeper)) this.active!.keeperTransactions++;
    this.save(); return r;
  }
  async send(actor: Address, address: Address, abi: Abi, fn: string, args: readonly unknown[] = [], value = 0n, gas = 5_000_000n): Promise<TransactionReceipt> {
    await this.identity(); this.validateWrite(actor, address, fn, args);
    const gasPrice = this.baseFee === BASE ? BID : this.baseFee + 50_000_000n;
    this.check(gas, gasPrice, fn === 'acquireBatch' ? value : 0n);
    assert.ok(await this.pub.getBalance({ address: actor }) >= value + gas * gasPrice, 'actor requires real local gas balance; protocol balances cannot be faked');
    await this.hold();
    const offer = { address, abi, functionName: fn, args, value, gas, gasPrice, account: actor, chain: null };
    await this.pub.simulateContract(offer as never);
    const reservation = gas * gasPrice; this.transactions++; this.gas += reservation; if (fn === 'acquireBatch') { this.purchases += value; this.admitted += Number(args[1]); assert.ok(this.admitted <= CAPS.maxDraws); } this.save();
    const hash = await this.wallet.writeContract(offer as never);
    return this.record(hash, actor, address, fn, value, reservation);
  }
  async snapshot(): Promise<Snapshot> {
    const block = await this.pub.getBlock(), at = block.number;
    const [cash, capital, fees, profit, reserve, issued, reconciled, unsettled, admission, ids, counts, proceeds, shapes, packs] = await Promise.all([
      this.pub.getBalance({ address: this.balancer!, blockNumber: at }), this.b('operatingCapital', [], at), this.b('creatorCredit', [], at), this.b('bankrollProfit', [], at), this.b('requiredReserve', [], at), this.p('lastIssuedSequence', [], at), this.b('reconciledSequence', [], at), this.p('unsettledAcquisitionCount', [], at), this.b('admissionStatus', [], at), this.b('getActiveIds', [], at), this.b('getActiveShapes', [], at), this.p('ownerProceeds', [], at), this.b('SHAPES', [], at), this.b('PACKS', [], at),
    ]);
    const [fwaCash, bucket, refundCredit] = await Promise.all([
      this.pub.getBalance({ address: this.pool!, blockNumber: at }),
      Promise.all(['acquisitionEscrowTotal', 'deliveryEscrowTotal', 'acquisitionRefundCreditTotal', 'accruedProtocolFees'].map(fn => this.read(this.pool!, fwaBucketsAbi, fn, [], at))) as Promise<bigint[]>,
      this.read(this.pool!, fwaBucketsAbi, 'acquisitionRefundCredit', [STRESS_SCOPE.buyer], at),
    ]);
    assert.equal(fwaCash, bucket.reduce((sum, value) => sum + value, proceeds), 'every actual FWA wei has a named obligation');
    let backing = 0n;
    for (const id of ids) {
      const [item, listing] = await Promise.all([this.b('items', [id], at), this.p('listings', [id], at)]);
      if (item[0] === 1) { assert.ok(same(listing[0], STRESS_SCOPE.demo)); const owner = await this.read(listing[0], nftAbi, 'ownerOf', [listing[3]], at); assert.ok(same(owner, this.pool!) || issued !== reconciled, 'settled curated NFT must be in pool custody'); continue; }
      assert.equal(item[0], 2);
      const collection = getAddress(listing[0]); assert.ok(same(collection, item[1] < 9 ? shapes : packs));
      const custodian = await this.read(collection, nftAbi, 'ownerOf', [listing[3]], at);
      if (!same(custodian, this.pool!)) { assert.ok(issued !== reconciled, 'settled inventory must be in actual pool custody'); continue; }
      const actual = await this.read(collection, nftAbi, item[1] < 9 ? 'backingOf' : 'valueOf', [listing[3]], at);
      assert.equal(actual, DENOMS[item[1]], 'actual redeemable backing equals denomination'); backing += actual;
    }
    assert.ok(cash >= fees, 'creator fees remain fully protected');
    const { operating, signed: pnl } = bankrollValues(cash, backing, fees, capital);
    return { fwaCashWei: fwaCash, fwaAcquisitionEscrowWei: bucket[0], fwaDeliveryEscrowWei: bucket[1], fwaRefundCreditTotalWei: bucket[2], fwaProtocolFeesWei: bucket[3], buyerRefundCreditWei: refundCredit, block: at, timestamp: block.timestamp, cashWei: cash, operatingWei: operating, reservedFeesWei: fees, bankrollProfitWei: profit, capitalWei: capital, backingWei: backing, reserveWei: reserve, shortfallWei: max(0n, reserve - operating), bankrollPnlWei: pnl, admission: Number(admission), issued, reconciled, unsettled, ownerProceeds: proceeds, counts };
  }
  assertSettled(s: Snapshot) {
    assert.equal(s.unsettled, 0n); assert.equal(s.issued, s.reconciled); assert.equal(s.ownerProceeds, 0n);
    assert.equal(s.bankrollProfitWei, max(0n, s.bankrollPnlWei), 'clipped bankroll profit uses cash + actual backing - protected fees - capital');
    if (s.shortfallWei > 0n) this.active!.shortfallEvents++;
  }
  point(s: Snapshot) { this.active!.final = s; this.active!.elapsedSimSeconds = Number(s.timestamp - this.active!.initial!.timestamp); this.active!.actualDrawsPerDay = this.active!.elapsedSimSeconds ? this.active!.drawsSettled * 86400 / this.active!.elapsedSimSeconds : 0; this.active!.trace.push({ draw: this.active!.drawsSettled, timeSeconds: this.active!.elapsedSimSeconds, ...s }); this.save(); }
  checkCycle(before: Snapshot, after: Snapshot, previous: Flows) {
    const f = this.active!.flows;
    const delta = (key: keyof Flows) => f[key] - previous[key];
    assert.equal(after.cashWei + after.backingWei - before.cashWei - before.backingWei, delta('additionalCapitalWei') - delta('totalWithdrawnWei') + delta('ownerReceiptsWei') - delta('wonBackingWei') - delta('mintFeesWei') - delta('keeperPayWei'), 'settled actual NAV delta reconciles all external flows');
    assert.equal(after.reservedFeesWei - before.reservedFeesWei, delta('creatorFeesAccruedWei') - delta('feesReinvestedWei') - delta('withdrawnFeesWei'), 'fee ledger conservation');
    this.assertSettled(after);
  }
  async makeKeeper(fromBlock: bigint) {
    const k = new Keeper({ rpcUrl: STRESS_SCOPE.rpc, factory: STRESS_SCOPE.factory, fromBlock, stateFile: resolve(this.directory, `${this.active!.id}-keeper.json`), account: STRESS_SCOPE.keeper, legacyFactories: [], maxGasPriceGwei: 5, priorityGwei: 0.05, maxLossWei: 0n, reorgWindow: 1,
      beforeSend: async (next, inFlight) => {
        await this.identity();
        assert.ok(k.state.balancers.every(x => same(x, this.balancer!)), 'keeper services only the scenario clone');
        const held = inFlight.filter(x => x.nonce !== next.nonce).reduce((s, x) => s + x.gas * x.maxFeePerGas, 0n);
        this.check(next.gas, next.maxFeePerGas, 0n, inFlight.length + 1);
        assert.ok(this.gas + held + next.gas * next.maxFeePerGas <= CAPS.gasWei); return true;
      }, log: (message, extra) => { if (!['tick complete', 'nothing to do', 'discovered'].includes(message)) this.active!.notes.push(`${message}: ${json(extra ?? {})}`); },
    });
    const original = k.wallet.writeContract.bind(k.wallet);
    k.wallet.writeContract = (async (offer: any) => {
      await this.identity(); const actor = typeof offer.account === 'string' ? offer.account : offer.account?.address ?? k.address;
      this.validateWrite(actor, offer.address, offer.functionName, offer.args); assert.equal(offer.value ?? 0n, 0n);
      this.check(offer.gas, offer.maxFeePerGas); await this.hold();
      const reservation = BigInt(offer.gas) * BigInt(offer.maxFeePerGas); this.transactions++; this.gas += reservation; this.save();
      const hash = await original(offer); await this.record(hash, actor, offer.address, offer.functionName, 0n, reservation); return hash;
    }) as typeof k.wallet.writeContract;
    this.keeper = k;
  }
  async maintain() {
    let unchanged = 0, previous = -1;
    for (let n = 0; n < 90; n++) {
      await this.hold(); await this.keeper!.tick();
      assert.ok(Object.keys(this.keeper!.errors).length === 0, `keeper errors: ${json(this.keeper!.errors)}`);
      const s = await this.snapshot();
      const clean = !Object.keys(this.keeper!.state.pending).length && !Object.keys(this.keeper!.state.accounting).length;
      const full = s.counts.every((count, d) => count >= this.active!.target[d]);
      if (clean && s.unsettled === 0n && s.issued === s.reconciled && s.ownerProceeds === 0n && (full || s.shortfallWei > 0n)) return s;
      unchanged = this.transactions === previous ? unchanged + 1 : 0; previous = this.transactions;
      assert.ok(unchanged < 65, 'keeper stalled despite timing progression');
      await this.mine(1);
    }
    throw new Error('keeper did not drain queue/accounting within bounded ticks');
  }
  async forcedLargestWord(): Promise<{ word: bigint; denom: number }> {
    const listings = [];
    for (const id of await this.b('getActiveIds')) { const [l, item] = await Promise.all([this.p('listings', [id]), this.b('items', [id])]); if (l[7] === 1 && item[0] === 2) listings.push({ slot: l[6] as bigint, weight: l[4] as bigint, denom: Number(item[1]) }); }
    assert.ok(listings.length);
    const largest = listings.reduce((a, b) => DENOMS[a.denom] >= DENOMS[b.denom] ? a : b);
    return { word: listings.filter(l => l.slot < largest.slot).reduce((a, l) => a + l.weight, 0n), denom: largest.denom };
  }
  async fulfill(id: bigint, word: bigint) {
    assert.ok(same(await this.read(STRESS_SCOPE.service, serviceAbi, 'requestPool', [id]), this.pool!));
    assert.equal(await this.read(STRESS_SCOPE.service, serviceAbi, 'requestStatus', [id]), 1);
    const commitment = await this.read(STRESS_SCOPE.coordinator, commitmentAbi, 's_requestCommitments', [id]);
    assert.notEqual(commitment, '0x' + '0'.repeat(64));
    await this.send(STRESS_SCOPE.coordinator, STRESS_SCOPE.service, serviceAbi, 'rawFulfillRandomWords', [id, [word]]);
    assert.equal(await this.read(STRESS_SCOPE.coordinator, commitmentAbi, 's_requestCommitments', [id]), commitment, 'simulated delivery leaves authentic proof commitment untouched');
  }
  async purchaseOwnerBase(receipt: TransactionReceipt, count: number, expectedFee: bigint): Promise<bigint> {
    // acquireBatch activates idle staging before requests. No callback ran in this automined purchase block.
    const [weight, weightedValue]: bigint[] = await Promise.all([this.p('totalWeight', [], receipt.blockNumber), this.p('weightedBackingTotal', [], receipt.blockNumber)]);
    const base = requestOwnerBase(weight, weightedValue, expectedFee);
    const requests: any[] = [];
    for (const log of receipt.logs) {
      if (!same(log.address, this.pool!)) continue;
      try { requests.push(decodeEventLog({ abi: requestEventsAbi, data: log.data, topics: log.topics }).args); } catch { /* other genuine pool events */ }
    }
    assert.equal(requests.length, count, 'one genuine request event per admitted acquisition');
    for (const request of requests) { assert.ok(same(request.purchaser, STRESS_SCOPE.buyer)); assert.equal(request.totalWeight, weight); assert.equal(request.acquisitionFee, expectedFee); }
    return base;
  }
  async accountDraw(id: bigint, forcedDenom?: number) {
    const a = await this.p('acquisitions', [id]);
    const outcome = acquisitionOutcome(Number(a[4]));
    if (outcome !== 'nft') {
      this.active!.refunds++; this.active!.drawsSettled++; this.active!.expectedRefundCreditWei += a[2];
      if (outcome === 'expired') this.active!.expiredRefunds++; else this.active!.selectionRefunds++;
      return;
    }
    const l = await this.p('listings', [a[3]]);
    assert.equal(l[7], 4); assert.ok(same(await this.read(l[0], nftAbi, 'ownerOf', [l[3]]), STRESS_SCOPE.buyer), 'winner owns actual NFT');
    // Successful reconciliation deletes the item; denomination comes from its actual ItemDrawn event.
    const drawn = this.drawnItems.get(String(a[3])); assert.ok(drawn !== undefined, 'actual reconciled draw event required');
    if (drawn.kind === 1) { assert.ok(same(l[0], STRESS_SCOPE.demo)); this.active!.curatedNftWins++; this.active!.nftWins++; this.active!.drawsSettled++; return; }
    const d = drawn.denom;
    if (forcedDenom !== undefined) assert.equal(d, forcedDenom, 'controlled adverse first win reached largest tier');
    assert.equal(await this.read(l[0], nftAbi, d < 9 ? 'backingOf' : 'valueOf', [l[3]]), DENOMS[d]);
    this.active!.flows.wonBackingWei += DENOMS[d]; this.active!.tierWins[d]++; this.active!.nftWins++; this.active!.drawsSettled++;
  }
  async creatorAction(fn: string, args: readonly unknown[], value = 0n) {
    const before = await this.snapshot(), f = { ...this.active!.flows };
    const creatorBefore = await this.pub.getBalance({ address: STRESS_SCOPE.creator });
    const r = await this.send(STRESS_SCOPE.creator, this.balancer!, poolBalancerAbi, fn, args, value);
    const after = await this.snapshot();
    if (fn === 'claimSurplus') {
      const amount = args[0] as bigint;
      this.active!.flows.withdrawnFeesWei += amount < before.reservedFeesWei ? amount : before.reservedFeesWei;
      assert.equal(await this.pub.getBalance({ address: STRESS_SCOPE.creator }) - creatorBefore, amount - r.gasUsed * r.effectiveGasPrice, 'withdrawal arrives at creator wallet');
    }
    if (fn === 'reinvestCreatorFees') {
      const used = this.active!.flows.feesReinvestedWei - f.feesReinvestedWei;
      assert.ok(used > 0n && used <= before.shortfallWei && used <= before.reservedFeesWei && used <= (args[0] as bigint));
      assert.equal(after.cashWei, before.cashWei, 'reinvestment transfers no ETH'); assert.equal(after.capitalWei - before.capitalWei, used, 'reinvestment becomes contributed capital');
      assert.equal(after.bankrollPnlWei, before.bankrollPnlWei, 'reinvestment creates no extra earnings');
    }
    this.checkCycle(before, after, f); return after;
  }
  async runScenario(plan: Plan) {
    const s: Scenario = { id: plan.id, design: plan.design.name, drawsPerDay: plan.rate, seed: plan.seed, mode: plan.mode, status: 'running', target: plan.design.counts, markupBps: plan.design.markup, initialDepositWei: 0n, drawsAttempted: 0, drawsSettled: 0, nftWins: 0, curatedNftWins: 0, actualDrawsPerDay: 0, refunds: 0, expiredRefunds: 0, selectionRefunds: 0, expectedRefundCreditWei: 0n, keeperTransactions: 0, shortfallEvents: 0, elapsedSimSeconds: 0, flows: flows(), trace: [], tierWins: Array(16).fill(0), notes: [] };
    this.active = s; this.drawnItems.clear(); this.results.scenarios.push(s); this.balancer = this.pool = undefined; this.baseFee = BASE; this.save();
    try {
      const [econ, shapes] = await Promise.all([this.read(STRESS_SCOPE.factory, balancerFactoryAbi, 'economics'), this.read(STRESS_SCOPE.implementation, poolBalancerAbi, 'SHAPES')]);
      const fee: bigint = await this.read(shapes, nftAbi, 'mintFee'); assert.ok(fee > 0n, 'observed Shapes mint fee must be positive'); s.mintFeeWei = fee;
      const backing = s.target.reduce((a, n, d) => a + BigInt(n) * DENOMS[d], 0n);
      const mintCost = s.target.reduce((a, n, d) => a + BigInt(n * SHAPES_IN[d]) * fee, 0n);
      const reserve = requiredReserveAt(s.target, Array(16).fill(0), fee, 0, econ as Economics, BASE);
      s.initialDepositWei = max(backing + mintCost + backing / 5n + ETH / 100n, reserve + ETH / 100n);
      const salt = STRESS_CREATION_SALT;
      this.balancer = getAddress(await this.read(STRESS_SCOPE.factory, balancerFactoryAbi, 'predictBalancer', [STRESS_SCOPE.creator, salt])); s.balancer = this.balancer;
      const curated: { collection: Address; tokenId: bigint; base: bigint }[] = [];
      if (['topheavy', 'pack'].includes(plan.design.name)) {
        assert.ok((await this.pub.getCode({ address: STRESS_SCOPE.demo })) !== '0x', 'existing real local DemoNFT required');
        await this.send(STRESS_SCOPE.creator, STRESS_SCOPE.demo, demoAbi, 'mint', [STRESS_SCOPE.creator, 900001n]);
        assert.ok(same(await this.read(STRESS_SCOPE.demo, demoAbi, 'ownerOf', [900001n]), STRESS_SCOPE.creator));
        await this.send(STRESS_SCOPE.creator, STRESS_SCOPE.demo, demoAbi, 'approve', [this.balancer, 900001n]);
        curated.push({ collection: STRESS_SCOPE.demo, tokenId: 900001n, base: ETH / 5n });
        s.notes.push('One actual existing local DemoNFT is listed at creator value 0.2 ETH; curated NFTs create no ETH capital or backing cost basis.');
      }
      const settingsHash = await this.read(STRESS_SCOPE.factory, balancerFactoryAbi, 'creationSettingsHash');
      const receipt = await this.send(STRESS_SCOPE.creator, STRESS_SCOPE.factory, balancerFactoryAbi, 'createBalancer', [salt, { markupBps: s.markupBps, creatorRevenueBps: 0, target: s.target.reduce((a, n, d) => a | BigInt(n) << BigInt(16 * d), 0n), mintFeeCap: fee, curatedRequired: false, settingsHash }, curated], s.initialDepositWei, 12_000_000n);
      this.pool = getAddress(await this.b('pool')); s.pool = this.pool;
      assert.equal(await this.b('profitAccountingVersion'), 2n); assert.ok(same(await this.p('owner'), this.balancer));
      assert.ok((await this.pub.getCode({ address: this.balancer }))!.toLowerCase().includes(STRESS_SCOPE.implementation.slice(2).toLowerCase()));
      await this.makeKeeper(receipt.blockNumber);
      const initial = await this.maintain(); this.assertSettled(initial);
      assert.ok(initial.counts.every((n, d) => n === s.target[d]), 'initial board fully listed'); assert.equal(initial.reservedFeesWei, 0n);
      assert.equal(initial.capitalWei, s.initialDepositWei, 'deposit creates capital, no earnings'); assert.equal(initial.bankrollProfitWei, 0n);
      assert.equal(initial.cashWei + initial.backingWei, s.initialDepositWei - s.flows.mintFeesWei - s.flows.keeperPayWei, 'actual setup NAV after mint fees and keeper pay');
      assert.equal(s.flows.mintFeesWei, mintCost, 'absolute setup mint-fee check');
      s.setupFlows = { ...s.flows }; s.initial = initial; this.point(initial);
      if (plan.mode === 'zeroDemandWinddown') {
        const f = { ...s.flows }; await this.mine(30 * 86400); const idle = await this.maintain(); this.checkCycle(initial, idle, f); this.point(idle);
        await this.creatorAction('close', []);
        while ((await this.b('getActiveIds')).length) {
          const ids: bigint[] = (await this.b('getActiveIds')).slice(0, 20); const before = await this.snapshot(); const f = { ...s.flows };
          await this.send(STRESS_SCOPE.creator, this.balancer, poolBalancerAbi, 'unlistShapes', [ids]); const after = await this.snapshot(); this.checkCycle(before, after, f);
          assert.ok(after.backingWei < before.backingWei); assert.equal(after.cashWei - before.cashWei, before.backingWei - after.backingWei, 'redeemed backing returns exactly to Balancer cash');
        }
        const amount: bigint = await this.b('withdrawableSurplus'); await this.creatorAction('claimSurplus', [amount, STRESS_SCOPE.creator]);
        const final = await this.snapshot(); assert.equal(final.cashWei, 0n); assert.equal(final.backingWei, 0n); assert.equal(final.ownerProceeds, 0n); this.point(final); s.status = 'complete'; return;
      }
      let current = initial;
      const burst = plan.rate === 86400 ? 5 : 1, interval = 86400 * burst / plan.rate;
      const limit = Math.min(this.maxDraws, 120);
      for (let window = 0; window < 180 && s.drawsAttempted < limit; window++) {
        this.check(0n, BID, 0n, 0);
        if (current.shortfallWei > 0n && plan.mode === 'feeReinvestOnGap' && current.reservedFeesWei > 0n) {
          const amount: bigint = await this.b('creatorFeeTopUpAvailable');
          if (amount > 0n) { await this.creatorAction('reinvestCreatorFees', [amount]); current = await this.maintain(); this.point(current); }
        }
        if (current.admission !== 0) { s.notes.push(`Admission paused with status ${current.admission}; no automatic external capital top-up.`); s.status = 'paused'; break; }
        if (window) { assert.equal(current.unsettled, 0n); await this.mine(interval); }
        const before = await this.snapshot(), f = { ...s.flows };
        const n = Math.min(burst, limit - s.drawsAttempted); assert.ok(this.admitted + n <= CAPS.maxDraws);
        const quote: readonly bigint[] = await this.pub.readContract({ address: this.pool, abi: fwaPoolAbi, functionName: 'quoteAcquisitionPrice', args: [BigInt(n)], account: STRESS_SCOPE.buyer, gasPrice: BID } as never) as readonly bigint[];
        const [version, block] = await Promise.all([this.p('inventoryVersion'), this.pub.getBlock()]);
        assert.ok(quote[0] > 0n && quote[1] > 0n); assert.equal(quote[2], BigInt(n) * (quote[0] + quote[1]));
        const purchaseReceipt = await this.send(STRESS_SCOPE.buyer, this.pool, fwaPoolAbi, 'acquireBatch', [STRESS_SCOPE.buyer, BigInt(n), quote[0], 0n, 10000n, version, block.timestamp + 600n], quote[2], 10_000_000n);
        const ownerBase = await this.purchaseOwnerBase(purchaseReceipt, n, quote[0]);
        s.drawsAttempted += n; this.save();
        await this.mine(2);
        const requests: { id: bigint; forced?: number; ownerBase: bigint }[] = [];
        for (let k = 1; k <= n; k++) {
          const id = await this.p('requestIdAtSequence', [before.issued + BigInt(k)]);
          const forced = plan.mode === 'forcedLargest' && s.drawsAttempted === n && k === 1 ? await this.forcedLargestWord() : undefined;
          const word = forced?.word ?? BigInt(keccak256(encodePacked(['string', 'uint256', 'uint256'], ['local-stress-v2', BigInt(plan.seed), id])));
          await this.fulfill(id, word); requests.push({ id, forced: forced?.denom, ownerBase });
        }
        if ((plan.mode === 'keeperOutage' || plan.mode === 'gasSpike') && window === 10) {
          const sent = this.keeper!.state.stats.sent;
          if (plan.mode === 'gasSpike') { this.baseFee = 8_000_000_000n; await this.mine(1); await this.keeper!.tick(); assert.equal(this.keeper!.state.stats.sent, sent, 'keeper waits above 5 gwei ceiling'); }
          // Words arrived within timeout. Only paid queue/reconciliation maintenance is unavailable here.
          await this.mine(3600);
          for (let probe = 0; probe < 2 && s.drawsAttempted < limit; probe++) {
            const admission = Number(await this.b('admissionStatus'));
            if (admission !== 0) { s.notes.push(`During ${plan.mode}, continued purchase ${probe + 1} refused by admission status ${admission}; resume awaits keeper.`); break; }
            const price = this.baseFee + 50_000_000n;
            const q = await this.pub.readContract({ address: this.pool, abi: fwaPoolAbi, functionName: 'quoteAcquisitionPrice', args: [1n], account: STRESS_SCOPE.buyer, gasPrice: price } as never) as readonly bigint[];
            const issued: bigint = await this.p('lastIssuedSequence'); const version: bigint = await this.p('inventoryVersion'); const now = await this.pub.getBlock();
            assert.ok(this.admitted < CAPS.maxDraws);
            const probeReceipt = await this.send(STRESS_SCOPE.buyer, this.pool, fwaPoolAbi, 'acquireBatch', [STRESS_SCOPE.buyer, 1n, q[0], 0n, 10000n, version, now.timestamp + 600n], q[2], 10_000_000n);
            const ownerBase = await this.purchaseOwnerBase(probeReceipt, 1, q[0]);
            s.drawsAttempted++; this.save(); await this.mine(2);
            const id: bigint = await this.p('requestIdAtSequence', [issued + 1n]);
            const word = BigInt(keccak256(encodePacked(['string', 'uint256'], ['local-stress-disruption', id])));
            await this.fulfill(id, word); requests.push({ id, ownerBase });
            s.notes.push(`During ${plan.mode}, continued purchase ${probe + 1} admitted and received simulated randomness before keeper resumed.`);
          }
          if (plan.mode === 'keeperOutage') assert.equal(this.keeper!.state.stats.sent, sent);
          this.baseFee = BASE; await this.mine(1); s.notes.push(`${plan.mode}: one-hour disruption removed, then actual keeper resumed.`);
        }
        current = await this.maintain();
        let expectedReceipts = 0n;
        for (const request of requests) { await this.accountDraw(request.id, request.forced); if ((await this.p('acquisitions', [request.id]))[4] === 2) expectedReceipts += request.ownerBase; }
        assert.equal(current.buyerRefundCreditWei, s.expectedRefundCreditWei, 'every actual expiry/selection refund remains in buyer pull credit');
        assert.equal(current.fwaRefundCreditTotalWei, s.expectedRefundCreditWei, 'fresh pool refund bucket contains exactly buyer refunds');
        assert.equal(s.flows.ownerReceiptsWei - f.ownerReceiptsWei, expectedReceipts, 'absolute owner receipts equal genuine request base prices for delivered NFTs');
        this.checkCycle(before, current, f); this.point(current);
        if (plan.mode === 'feeWithdrawEvery20' && s.drawsSettled % 20 === 0) {
          const available: bigint = await this.b('withdrawableSurplus'); const amount = available < current.reservedFeesWei ? available : current.reservedFeesWei;
          if (amount > 0n) { current = await this.creatorAction('claimSurplus', [amount, STRESS_SCOPE.creator]); this.point(current); }
          else s.notes.push(`Draw ${s.drawsSettled}: fees not withdrawable under current reserve.`);
        }
      }
      if (s.status === 'running') s.status = s.drawsAttempted === limit ? 'complete' : 'attempt-limit';
      if (['keeperOutage', 'gasSpike'].includes(plan.mode) && !s.notes.some(note => note.includes('one-hour disruption removed'))) s.notes.push(`${plan.mode} disruption not reached: admission paused or the admitted-draw cap ended before window 10.`);
      if (plan.mode === 'feeReinvestOnGap' && s.flows.feesReinvestedWei === 0n) s.notes.push('Reinvestment was not reached: no eligible refill gap with creator fees arose within the admitted-draw cap.');
      if (plan.mode === 'feeWithdrawEvery20' && s.flows.withdrawnFeesWei === 0n) s.notes.push('Fee withdrawal was not reached within the admitted-draw cap and reserve conditions.');
      if (plan.mode === 'forcedLargest') s.notes.push('Controlled adverse first outcome selects the largest active tier; this regime is not an unbiased sample.');
      if (s.refunds) this.results.findings.push({ severity: 'info', scenarioId: s.id, text: `${s.refunds} actual pull refunds: ${s.expiredRefunds} status-3 expiries, ${s.selectionRefunds} status-4 selection/slippage refunds. Buyer credit ${s.expectedRefundCreditWei} wei remains at FWA.` });
      if (current.shortfallWei) this.results.findings.push({ severity: 'warning', scenarioId: s.id, text: `Final operating reserve shortfall ${current.shortfallWei} wei; protected creator fees ${current.reservedFeesWei} wei.` });
    } catch (e) { s.status = 'failed'; s.error = String(e); this.results.findings.push({ severity: 'error', scenarioId: s.id, text: String(e) }); throw e; }
    finally { this.save(); }
  }
  async run(plans: Plan[]) {
    mkdirSync(this.directory, { recursive: true }); assert.ok(!existsSync(resolve(this.directory, 'results.json')), 'use a new receipt directory; existing budget/evidence must not be overwritten');
    this.save();
    try {
      await this.identity();
      assert.ok(same(await this.read(STRESS_SCOPE.service, serviceAbi, 'coordinator'), STRESS_SCOPE.coordinator));
      const anchor = await this.pub.getBlock(); this.results.anchor = { block: anchor.number, hash: anchor.hash, timestamp: anchor.timestamp };
      if (this.ledger.baseSnapshot) { await this.test.revert({ id: this.ledger.baseSnapshot }); }
      else for (const actor of [STRESS_SCOPE.creator, STRESS_SCOPE.buyer, STRESS_SCOPE.keeper]) {
        assert.equal(await this.pub.getCode({ address: actor }) ?? '0x', '0x'); assert.equal(await this.pub.getBalance({ address: actor }), 0n); assert.equal(await this.pub.getTransactionCount({ address: actor }), 0);
        await this.test.setBalance({ address: actor, value: 5000n * ETH }); await this.test.impersonateAccount({ address: actor });
      }
      for (const actor of [STRESS_SCOPE.creator, STRESS_SCOPE.buyer, STRESS_SCOPE.keeper, STRESS_SCOPE.coordinator]) await this.test.impersonateAccount({ address: actor });
      let snapshot = await this.test.snapshot(); this.ledger.baseSnapshot = snapshot; this.save();
      const retainedIds = new Set(this.results.scenarios.map((scenario: Scenario) => scenario.id));
      for (const plan of plans.filter(candidate => !retainedIds.has(candidate.id))) {
        this.check(0n, BID, 0n, 0); assert.ok(this.results.scenarios.length < CAPS.maxScenarios);
        try { await this.runScenario(plan); }
        catch (e) { throw e; } // Stop at the first systemic failure; repairs share the durable ledger and deadline.
        await this.test.revert({ id: snapshot }); snapshot = await this.test.snapshot(); this.ledger.baseSnapshot = snapshot;
        this.save();
      }
      this.results.status = this.results.scenarios.some((s: Scenario) => s.status === 'failed') ? 'completed-with-failures' : 'complete';
    } catch (e) { this.results.status = 'stopped'; this.results.error = String(e); throw e; }
    finally { this.results.finishedAt = new Date().toISOString(); this.save(); }
  }
}

export async function main(args = process.argv.slice(2)) {
  assert.equal(args[0], '--execute', 'usage: tsx scripts/local-stress-campaign.ts --execute --directory PATH --budget-ledger PATH [--resume-results PATH] [--draws-per-scenario 1..120] [--scenario ID]');
  let directory: string | undefined, ledger: string | undefined, branchMetadata: string | undefined, resumeSource: string | undefined, draws = 120, id: string | undefined;
  for (let i = 1; i < args.length; i += 2) { assert.ok(args[i + 1], 'missing argument value'); if (args[i] === '--directory') directory = args[i + 1]; else if (args[i] === '--resume-results') resumeSource = resolve(ROOT, args[i + 1]); else if (args[i] === '--branch-metadata') branchMetadata = args[i + 1]; else if (args[i] === '--budget-ledger') ledger = args[i + 1]; else if (args[i] === '--draws-per-scenario') draws = Number(args[i + 1]); else if (args[i] === '--scenario') id = args[i + 1]; else throw new Error(`unknown argument ${args[i]}`); }
  assert.ok(directory, '--directory is required'); assert.ok(ledger, '--budget-ledger is required to preserve physical budgets across repairs'); assert.ok(Number.isSafeInteger(draws) && draws >= 1 && draws <= 120);
  const path = resolve(ROOT, directory); assert.ok(relative(ROOT, path) && !relative(ROOT, path).startsWith('..'), 'receipt directory must be inside repository');
  mkdirSync(path, { recursive: true }); assert.ok(!relative(realpathSync(ROOT), realpathSync(path)).startsWith('..'), 'receipt directory cannot escape through a symlink');
  const plans = stressPlan().filter(p => !id || p.id === id); assert.ok(plans.length > 0); assert.ok(plans.length <= 24); assert.ok(plans.length * draws <= 3000);
  const ledgerPath = resolve(ROOT, ledger); assert.ok(relative(ROOT, ledgerPath) && !relative(ROOT, ledgerPath).startsWith('..'), 'budget ledger must stay in repository');
  const branch = JSON.parse(readFileSync(resolve(ROOT, branchMetadata ?? resolve(path, 'branch.json')), 'utf8'));
  await new Campaign(path, draws, ledgerPath, branch, resumeSource).run(plans);
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url))) main().catch(e => { console.error(e); process.exitCode = 1; });
