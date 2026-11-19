// Shared permissionless keeper for every Balancer created by one BalancerFactory.
// Each tick: discover Balancers from events (re-scanning a reorg window), then for each Balancer simulate
// `performUpkeep` at the gas price it would bid. The simulation returns the contract's reward; the call is
// sent only when that reward covers the estimated cost under the configured policy. NoUpkeepNeeded means
// "nothing to do"; any other revert is reported as a pool error. One in-flight tx per Balancer, replaced with
// bumped fees only while still profitable. State persists to a JSON file so restarts resume safely.
import { createServer } from 'node:http';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  BaseError, ContractFunctionRevertedError, TransactionNotFoundError, createPublicClient, createWalletClient, decodeEventLog, decodeFunctionData, encodeFunctionData, getAddress, http, parseAbiItem, toHex,
  type Account, type Address, type Hash, type PublicClient, type TransactionReceipt, type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { poolBalancerAbi } from '../shared/abi';

const CREATED = parseAbiItem('event BalancerCreated(address indexed creator, address indexed balancer, address indexed pool, bytes32 salt)');
/** Reverts that only mean this keeper has nothing to do there now: no work, or the pool's creator has restricted
 *  upkeep to keepers that do not include this one. */
export const EXPECTED_REVERTS = new Set(['NoUpkeepNeeded', 'KeeperNotApproved', 'StaleSettings', 'PaymentUnavailable', 'MinimumPaymentNotMet']);
/** Least gas limit for any upkeep. A draw that settles between the estimate and inclusion adds its reconcile and
 *  restock to the call (+536k measured for one draw), so 30% over a small estimate can run out of gas. The heaviest
 *  upkeeps measure around 3.2M on historical forks: 5 reconciles + 5 Shape units in 4 sizes, and two processed draws that
 *  each reserved FWA's maximum six listings + 5 reconciles, 2.98M to 3.22M (a call that processes skips restocking).
 *  Processing that fails
 *  for want of gas reverts the whole upkeep (InsufficientGas), so a limit too small to process never succeeds; this
 *  floor adds headroom for Shapes mint gas varying by block. Only gas used is billed. */
export const UPKEEP_GAS_FLOOR = 4_000_000n;

/** Gas limit for an upkeep estimated at `estimate`: 30% headroom, never below UPKEEP_GAS_FLOOR. */
export const MAX_TRANSACTION_GAS = 16_777_216n; // EIP-7825
export const gasLimitFor = (estimate: bigint) => {
  const g = (estimate * 13n) / 10n;
  const limit = g > UPKEEP_GAS_FLOOR ? g : UPKEEP_GAS_FLOOR;
  if (limit > MAX_TRANSACTION_GAS) throw new Error('upkeep exceeds EIP-7825 gas limit');
  return limit;
};

export interface Policy {
  /** Executable limit estimate, used as a conservative expense budget. It is not the actual billed gas. */
  gasEstimate: bigint;
  /** Post-refund transaction gas from a successful trace, when supported; otherwise the executable estimate. */
  expenseGas?: bigint;
  /** Operator's amortized operating and failed-attempt expense per send. */
  operatingCostWei?: bigint;
  /** Inclusion fee ceiling used to bound the loss allowance under fee changes. */
  maxFeePerGas?: bigint;
  /** Actual offer returned by simulating the pool, regardless of policy version or formula. */
  expectedReward: bigint;
  baseFee: bigint;
  priorityFee: bigint;
  maxLossWei: bigint;
}

export interface PaymentFloor { minimumReward: bigint; minimumGas: bigint }

/** The gas-denominated floor follows the actual inclusion price. Its modeled gas subsidy is at most maxLossWei
 *  for every inclusion price at or below maxFeePerGas; fixed operating costs remain a separate minimum. */
export function paymentFloor(p: { expenseGas: bigint; maxFeePerGas: bigint; maxLossWei: bigint; operatingCostWei?: bigint }): PaymentFloor {
  const lossGas = p.maxFeePerGas > 0n ? p.maxLossWei / p.maxFeePerGas : 0n;
  return { minimumReward: p.operatingCostWei ?? 0n, minimumGas: p.expenseGas > lossGas ? p.expenseGas - lossGas : 0n };
}

export const paymentAt = (p: PaymentFloor, gasPrice: bigint) => p.minimumReward + p.minimumGas * gasPrice;

export const minimumPayment = (p: Omit<Policy, 'expectedReward'>): bigint => paymentAt(paymentFloor({
  expenseGas: p.expenseGas ?? p.gasEstimate, maxFeePerGas: p.maxFeePerGas ?? p.baseFee + p.priorityFee,
  maxLossWei: p.maxLossWei, operatingCostWei: p.operatingCostWei,
}), p.baseFee + p.priorityFee);

/** No reward inversion: a trace prices actual simulated execution when supported, and an executable estimate
 *  supplies a conservative fallback. Receipts calibrate both estimates against the transaction actually mined. */
export function decide(p: Policy): { send: boolean; reason: string } {
  if (p.expectedReward < minimumPayment(p)) return { send: false, reason: 'unprofitable at current gas' };
  return { send: true, reason: 'ok' };
}

/** Reject incomplete, failed or impossible traces; never treat missing data as a zero-cost successful execution. */
export function traceGasUsed(value: unknown, gasLimit: bigint): bigint {
  const t = value as { error?: unknown; gasUsed?: unknown } | null;
  if (!t || t.error || typeof t.gasUsed !== 'string' || !/^0x[0-9a-f]+$/i.test(t.gasUsed)) throw new Error('invalid execution trace');
  const used = BigInt(t.gasUsed);
  if (used < 21_000n || used > gasLimit) throw new Error('invalid execution trace gas');
  return used;
}

export const tracingUnsupported = (e: unknown): boolean => e instanceof BaseError
  && Boolean(e.walk((x) => typeof x === 'object' && x !== null && 'code' in x && (x.code === -32601 || x.code === -32004)));

export interface KeeperConfig {
  rpcUrl: string;
  factory: Address;
  fromBlock: bigint;
  stateFile: string;
  account: Account | Address; // Address = unlocked dev node account
  reorgWindow?: number; // blocks re-scanned every tick
  maxGasPriceGwei?: number; // operator bid ceiling; compensation is checked by complete simulation
  priorityGwei?: number; // operator's bid, independent of a policy's reimbursement formula
  maxLossWei?: bigint;
  operatingCostWei?: bigint;
  replaceAfterBlocks?: number;
  maxReplacements?: number;
  logChunk?: bigint;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Optional operator spending guard (scripts/canary-guard.ts). Called before every send and fee replacement with the
   *  transaction's maximum and this keeper's unconfirmed sends; false withholds the transaction. */
  beforeSend?: (next: { gas: bigint; maxFeePerGas: bigint; nonce: number }, inFlight: { account: Address; nonce: number; gas: bigint; maxFeePerGas: bigint }[]) => Promise<boolean>;
}

interface Offer { policy?: Address; minimumReward?: string; minimumGas?: string; gas: string; estimate: string; expenseGas?: string; expenseSource?: 'trace' | 'estimate' }
interface Pending extends Offer { hashes: Hash[]; offers?: Record<string, Offer>; nonce: number; settingsHash?: Hash; gas: string; estimate: string; maxFeePerGas: string; maxPriorityFeePerGas: string; sentBlock: string; replacements: number }
interface ReceiptRecord { balancer: Address; nonce: number; hash: Hash; block: string; blockHash: Hash; status: 'success' | 'reverted'; cost: string; reward: string; pending: Pending }
interface AccountingRetry { balancer: Address; pending: Pending }
interface PolicyContext { policy: Address; paid: boolean; settingsHash: Hash }
interface State {
  lastScanned: string;
  balancers: Address[];
  /** The upkeep transaction in flight per Balancer, until mined or its nonce is used. */
  pending: Record<string, Pending>;
  accounting: Record<string, AccountingRetry>;
  receipts: ReceiptRecord[];
  accountingAnchor?: { block: string; hash: Hash };
  accountingCoverage: 'journal' | 'legacy-unverified' | 'history-unverified';
  journalPrunedThrough: string;
  journalPrunedAnchor?: { block: string; hash: Hash };
  stats: { sent: number; mined: number; reverted: number; replaced: number; skippedUnprofitable: number; spentWei: string; earnedWei: string };
}
/** Mined upkeeps kept in memory for inspection (the e2e run reads them); older entries are dropped. */
const AUDIT_KEEP = 1_000;
export interface AuditEntry { balancer: Address; hash: Hash; status: 'success' | 'reverted'; gasUsed: bigint; measuredGas: bigint; reward: bigint; cost: bigint; gasEstimate: bigint; expenseGas: bigint; expenseSource: 'trace' | 'estimate'; minimumReward: bigint; minimumGas: bigint; policy?: Address }

export class Keeper {
  readonly pub: PublicClient;
  readonly wallet: WalletClient;
  state: State;
  errors: Record<string, string> = {};
  audit: AuditEntry[] = [];
  lastTick = 0;
  lastBlock = 0n;
  policies: Record<string, { address: Address; paid: boolean }> = {};
  private traceAvailable = true;
  private blockHashes = new Map<string, Hash>();
  private accountingErrors: Record<string, string> = {};
  private readonly c: Required<Omit<KeeperConfig, 'log' | 'beforeSend'>> & Pick<KeeperConfig, 'log' | 'beforeSend'>;

  constructor(cfg: KeeperConfig) {
    this.c = { reorgWindow: 64, maxGasPriceGwei: 50, priorityGwei: 0.05, maxLossWei: 2n * 10n ** 14n, operatingCostWei: 0n, replaceAfterBlocks: 3, maxReplacements: 5, logChunk: 10_000n, ...cfg };
    // Public RPCs can take ~30s on eth_getLogs (Tenderly, measured 27.5s); viem's default gives up after 10s.
    const transport = http(cfg.rpcUrl, { timeout: 60_000 });
    this.pub = createPublicClient({ transport }) as PublicClient;
    this.wallet = createWalletClient({ transport, account: cfg.account });
    this.state = this.load();
  }

  private log(msg: string, extra?: Record<string, unknown>) {
    (this.c.log ?? ((m, e) => console.log(JSON.stringify({ t: new Date().toISOString(), msg: m, ...e }))))(msg, extra);
  }

  private load(): State {
    const fresh: State = {
      lastScanned: (this.c.fromBlock - 1n).toString(), balancers: [], pending: {}, accounting: {}, receipts: [], accountingCoverage: 'journal', journalPrunedThrough: '0',
      stats: { sent: 0, mined: 0, reverted: 0, replaced: 0, skippedUnprofitable: 0, spentWei: '0', earnedWei: '0' },
    };
    if (!existsSync(this.c.stateFile)) return fresh;
    const s = JSON.parse(readFileSync(this.c.stateFile, 'utf8'));
    if (!s.accountingCoverage) this.log('legacy receipt totals are unverified before the accounting journal');
    return { ...fresh, ...s, accountingCoverage: s.accountingCoverage ?? 'legacy-unverified', stats: { ...fresh.stats, ...s.stats } };
  }

  save() {
    const tmp = `${this.c.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.c.stateFile); // atomic replace
  }

  get address(): Address {
    const a = this.c.account;
    return typeof a === 'string' ? a : a.address;
  }

  private gwei(x: number) {
    return BigInt(Math.round(x * 1e9));
  }

  /** Re-scan from `lastScanned - reorgWindow` so events dropped or added by a reorg are reconciled. */
  async discover(head: bigint) {
    let from = BigInt(this.state.lastScanned) - BigInt(this.c.reorgWindow) + 1n;
    if (from < this.c.fromBlock) from = this.c.fromBlock;
    const seen = new Set(this.state.balancers.map((b) => b.toLowerCase()));
    for (let start = from; start <= head; start += this.c.logChunk) {
      const end = start + this.c.logChunk - 1n > head ? head : start + this.c.logChunk - 1n;
      const logs = await this.pub.getLogs({ address: this.c.factory, event: CREATED, fromBlock: start, toBlock: end });
      for (const l of logs) {
        const b = l.args.balancer!;
        if (!seen.has(b.toLowerCase())) {
          seen.add(b.toLowerCase());
          this.state.balancers.push(getAddress(b));
          this.log('discovered', { balancer: b, block: l.blockNumber?.toString() });
        }
      }
    }
    // A Balancer whose creation was reorged out has no code; forget it.
    const kept: Address[] = [];
    for (const b of this.state.balancers) {
      const code = await this.pub.getCode({ address: b });
      if (code && code !== '0x') kept.push(b);
      else {
        this.log('dropped (no code, reorged)', { balancer: b });
        const pending = this.state.pending[b];
        if (pending) this.state.accounting[String(pending.nonce)] = { balancer: b, pending };
        delete this.state.pending[b];
      }
    }
    this.state.balancers = kept;
    for (const b of Object.keys(this.policies)) if (!kept.some((address) => address.toLowerCase() === b.toLowerCase())) delete this.policies[b];
    this.state.lastScanned = head.toString();
  }

  async tick() {
    const block = await this.pub.getBlock();
    const head = block.number!;
    this.lastBlock = head;
    this.blockHashes = new Map([[head.toString(), block.hash!]]);
    await this.reconcileReceipts(head, block.hash!, block.parentHash);
    await this.discover(head);
    for (const [nonce, retry] of Object.entries(this.state.accounting)) {
      try {
        if (await this.accountPending(retry.balancer, retry.pending)) {
          delete this.state.accounting[nonce];
          delete this.accountingErrors[nonce];
        } else if (head >= BigInt(retry.pending.sentBlock) + BigInt(this.c.replaceAfterBlocks)) {
          const known = await Promise.all(retry.pending.hashes.map(async (hash) => {
            try { return await this.pub.getTransaction({ hash }); }
            catch (e) { if (e instanceof TransactionNotFoundError) return null; throw e; }
          }));
          if (!known.some((tx) => tx && tx.blockHash === null)) {
            this.accountingErrors[nonce] = 'orphaned upkeep nonce requires operator rebroadcast or cancellation; accounting queue never broadcasts';
            this.log('orphaned nonce requires operator action', { nonce, balancer: retry.balancer });
          } else delete this.accountingErrors[nonce];
        } else delete this.accountingErrors[nonce];
      } catch (e) {
        this.accountingErrors[nonce] = (e as Error).message.split('\n')[0];
        this.log('receipt accounting deferred', { nonce, error: this.accountingErrors[nonce] });
      }
    }
    for (const b of this.state.balancers) {
      try {
        await this.service(b, head, block.baseFeePerGas ?? 0n);
        delete this.errors[b];
      } catch (e) {
        this.errors[b] = (e as Error).message.split('\n')[0];
        this.log('pool error', { balancer: b, error: this.errors[b] });
      }
    }
    this.lastTick = Date.now();
    this.save();
  }

  /** Local operator bidding limits. The selected policy makes no promise to reimburse this bid. */
  private fees(baseFee: bigint) {
    const priority = this.gwei(this.c.priorityGwei);
    const cap = this.gwei(this.c.maxGasPriceGwei);
    const max = baseFee * 2n + priority > cap ? cap : baseFee * 2n + priority;
    return { priority, max, cap };
  }

  private async service(b: Address, head: bigint, baseFee: bigint) {
    const [policy, paid, settingsHash] = await Promise.all([
      this.pub.readContract({ address: b, abi: poolBalancerAbi, functionName: 'keeperPolicy', blockNumber: head } as never) as Promise<Address>,
      this.pub.readContract({ address: b, abi: poolBalancerAbi, functionName: 'paidUpkeepEnabled', blockNumber: head } as never) as Promise<boolean>,
      this.pub.readContract({ address: b, abi: poolBalancerAbi, functionName: 'settingsHash', blockNumber: head }) as Promise<Hash>,
    ]);
    this.policies[b] = { address: policy, paid };
    const context = { policy, paid, settingsHash };
    const pending = this.state.pending[b];
    if (pending && (await this.resolvePending(b, pending, head, baseFee, context))) return;
    if (!paid) return;
    const { priority, max, cap } = this.fees(baseFee);
    if (baseFee + priority > cap) {
      this.log('skip: basefee above bid cap', { balancer: b, baseFeeGwei: Number(baseFee) / 1e9 });
      return;
    }
    await this.attempt(b, head, baseFee, max, priority, context);
  }

  /** A top-level callTracer reports transaction gas after refunds on Geth. Providers without this capability
   *  fall back to the executable estimate. No state overrides or formula-specific reward interpretation are used. */
  private async traceExpense(b: Address, maxFeePerGas: bigint, priority: bigint, settingsHash: Hash, gas: bigint): Promise<bigint | undefined> {
    if (!this.traceAvailable) return undefined;
    try {
      const input = encodeFunctionData({ abi: poolBalancerAbi, functionName: 'performUpkeep', args: [settingsHash, 0n, 0n] } as never);
      const trace = await this.pub.request({ method: 'debug_traceCall', params: [
        { from: this.address, to: b, data: input, gas: toHex(gas), maxFeePerGas: toHex(maxFeePerGas), maxPriorityFeePerGas: toHex(priority) },
        'latest', { tracer: 'callTracer', tracerConfig: { onlyTopCall: true } },
      ] } as never);
      return traceGasUsed(trace, gas);
    } catch (e) {
      // A race or one pool's failed trace must not disable tracing for unrelated pools.
      const unavailable = tracingUnsupported(e);
      if (unavailable) this.traceAvailable = false;
      this.log(unavailable ? 'trace unavailable: using conservative execution expense budget' : 'trace failed for this offer: using conservative execution expense budget');
      return undefined;
    }
  }

  /** Simulate the actual offer, estimate an executable limit and trace expected expense separately. */
  private async quote(b: Address, baseFee: bigint, maxFeePerGas: bigint, priority: bigint, settingsHash: Hash) {
    const call = { address: b, abi: poolBalancerAbi, functionName: 'performUpkeep', args: [settingsHash, 0n, 0n], account: this.address, maxFeePerGas, maxPriorityFeePerGas: priority, blockTag: 'latest' } as const;
    const gasEstimate = await this.pub.estimateContractGas(call as never);
    const gas = gasLimitFor(gasEstimate);
    const reward = (await this.pub.simulateContract({ ...call, gas } as never)).result as bigint;
    const traced = await this.traceExpense(b, maxFeePerGas, priority, settingsHash, gas);
    // Two nonzero 32-byte floors add at most 2 x 32 x (16-4) = 768 intrinsic calldata gas versus the zero quote.
    // The executable limit's 30% headroom covers this; both simulations use the exact gas limit we will send.
    const expenseGas = (traced ?? gasEstimate) + 768n;
    const economics = { gasEstimate, expenseGas, maxFeePerGas, operatingCostWei: this.c.operatingCostWei, expectedReward: reward, baseFee, priorityFee: priority, maxLossWei: this.c.maxLossWei };
    if (!decide(economics).send) return undefined;
    const { minimumReward, minimumGas } = paymentFloor({ expenseGas, maxFeePerGas, maxLossWei: this.c.maxLossWei, operatingCostWei: this.c.operatingCostWei });
    const guarded = await this.pub.simulateContract({ ...call, args: [settingsHash, minimumReward, minimumGas], gas } as never);
    return { reward: guarded.result as bigint, gasEstimate, expenseGas, expenseSource: traced === undefined ? 'estimate' as const : 'trace' as const, minimumReward, minimumGas, gas };
  }

  private async attempt(b: Address, head: bigint, baseFee: bigint, maxFeePerGas: bigint, priority: bigint, context: PolicyContext): Promise<boolean> {
    let quote;
    try {
      quote = await this.quote(b, baseFee, maxFeePerGas, priority, context.settingsHash);
    } catch (e) {
      const name = revertName(e);
      if (name && EXPECTED_REVERTS.has(name)) return false;
      throw e;
    }
    if (!quote) {
      this.state.stats.skippedUnprofitable++;
      this.log('skip: unprofitable at current gas', { balancer: b, policy: context.policy });
      return false;
    }
    const { reward, gasEstimate, expenseGas, expenseSource, minimumReward, minimumGas, gas } = quote;
    const nonce = await this.pub.getTransactionCount({ address: this.address, blockTag: 'pending' });
    if (!(await this.allowed({ gas, maxFeePerGas, nonce }))) return false;
    this.state.pending[b] = { hashes: [], nonce, settingsHash: context.settingsHash, policy: context.policy, minimumReward: minimumReward.toString(), minimumGas: minimumGas.toString(), offers: {}, gas: gas.toString(), estimate: gasEstimate.toString(), expenseGas: expenseGas.toString(), expenseSource, maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: priority.toString(), sentBlock: head.toString(), replacements: 0 };
    this.save();
    // A lost response may still have broadcast. Preserve its nonce until receipts or eviction establish its fate.
    const hash = await this.send(b, nonce, maxFeePerGas, priority, gas, context.settingsHash, minimumReward, minimumGas);
    this.state.pending[b].hashes.push(hash);
    this.state.pending[b].offers![hash] = { policy: context.policy, minimumReward: minimumReward.toString(), minimumGas: minimumGas.toString(), gas: gas.toString(), estimate: gasEstimate.toString(), expenseGas: expenseGas.toString(), expenseSource };
    this.save();
    this.state.stats.sent++;
    this.log('sent performUpkeep', { balancer: b, policy: context.policy, hash, nonce, gasEstimate: gasEstimate.toString(), expenseGas: expenseGas.toString(), expenseSource, expectedRewardWei: reward.toString(), minimumFixedWei: minimumReward.toString(), minimumGas: minimumGas.toString(), minimumRewardWei: paymentAt({ minimumReward, minimumGas }, baseFee + priority).toString(), expectedExpenseWei: (expenseGas * (baseFee + priority) + this.c.operatingCostWei).toString(), expectedNetWei: (reward - expenseGas * (baseFee + priority) - this.c.operatingCostWei).toString() });
    return true;
  }

  /** The operator guard's verdict; without a guard every send is allowed. */
  private async allowed(next: { gas: bigint; maxFeePerGas: bigint; nonce: number }): Promise<boolean> {
    if (!this.c.beforeSend) return true;
    const inFlight = [...Object.values(this.state.pending), ...Object.values(this.state.accounting).map((r) => r.pending)]
      .map((p) => ({ account: this.address, nonce: p.nonce, gas: BigInt(p.gas), maxFeePerGas: BigInt(p.maxFeePerGas) }));
    const ok = await this.c.beforeSend(next, inFlight);
    if (!ok) this.log('withheld by spending guard', { nonce: next.nonce, maxCostWei: (next.gas * next.maxFeePerGas).toString() });
    return ok;
  }

  private async send(b: Address, nonce: number, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint, gas: bigint, settingsHash: Hash, minimumReward: bigint, minimumGas: bigint) {
    return this.wallet.writeContract({
      address: b, abi: poolBalancerAbi, functionName: 'performUpkeep', args: [settingsHash, minimumReward, minimumGas], account: this.c.account, chain: null,
      nonce, maxFeePerGas, maxPriorityFeePerGas, gas,
    } as never);
  }

  private async canonicalHash(block: bigint): Promise<Hash> {
    const key = block.toString();
    const known = this.blockHashes.get(key);
    if (known) return known;
    const hash = (await this.pub.getBlock({ blockNumber: block })).hash!;
    this.blockHashes.set(key, hash);
    return hash;
  }

  private async reconcileReceipts(head: bigint, hash: Hash, parentHash: Hash) {
    const anchor = this.state.accountingAnchor;
    if (anchor && !(BigInt(anchor.block) === head && anchor.hash === hash)
      && !(BigInt(anchor.block) + 1n === head && anchor.hash === parentHash)) {
      const changed = BigInt(anchor.block) > head || await this.canonicalHash(BigInt(anchor.block)) !== anchor.hash;
      if (changed) {
        this.log('reorg: verifying bounded receipt journal', { window: this.c.reorgWindow, journalPrunedThrough: this.state.journalPrunedThrough });
        const pruned = this.state.journalPrunedAnchor;
        if (BigInt(this.state.journalPrunedThrough) > 0n && (!pruned || BigInt(pruned.block) > head || await this.canonicalHash(BigInt(pruned.block)) !== pruned.hash)) {
          this.state.accountingCoverage = 'history-unverified';
          this.log('reorg crossed pruned receipt history: totals require an external canonical reconciliation');
        }
        const blocks = [...new Set(this.state.receipts.map((r) => r.block))].filter((b) => BigInt(b) <= head);
        await Promise.all(blocks.map((b) => this.canonicalHash(BigInt(b))));
        const canonical: ReceiptRecord[] = [];
        for (const r of this.state.receipts) {
          if (BigInt(r.block) <= head && this.blockHashes.get(r.block) === r.blockHash) { canonical.push(r); continue; }
          if (r.status === 'success') this.state.stats.mined--; else this.state.stats.reverted--;
          this.state.stats.spentWei = (BigInt(this.state.stats.spentWei) - BigInt(r.cost)).toString();
          this.state.stats.earnedWei = (BigInt(this.state.stats.earnedWei) - BigInt(r.reward)).toString();
          this.audit = this.audit.filter((a) => a.hash !== r.hash);
          this.state.accounting[String(r.nonce)] = { balancer: r.balancer, pending: r.pending };
          this.log('orphaned receipt rolled back', { hash: r.hash, nonce: r.nonce, balancer: r.balancer });
        }
        this.state.receipts = canonical;
      }
    }
    this.state.accountingAnchor = { block: head.toString(), hash };
    const cutoff = head > BigInt(this.c.reorgWindow) ? head - BigInt(this.c.reorgWindow) : 0n;
    this.state.receipts.sort((a, b) => Number(BigInt(a.block) - BigInt(b.block)) || a.nonce - b.nonce);
    while (this.state.receipts.length && (BigInt(this.state.receipts[0].block) < cutoff || this.state.receipts.length > AUDIT_KEEP)) {
      const pruned = this.state.receipts.shift()!;
      if (BigInt(pruned.block) >= BigInt(this.state.journalPrunedThrough)) {
        this.state.journalPrunedThrough = pruned.block;
        this.state.journalPrunedAnchor = { block: pruned.block, hash: pruned.blockHash };
      }
      if (BigInt(pruned.block) >= cutoff) {
        this.state.accountingCoverage = 'history-unverified';
        this.log('receipt journal entry limit reached: earlier canonical history is no longer verified', { journalPrunedThrough: this.state.journalPrunedThrough });
      }
    }
  }

  /** Locate a consumed nonce without scanning every block. Unsupported historical reads retain pending accounting. */
  private async recoverReceipt(b: Address, p: Pending): Promise<TransactionReceipt | null | undefined> {
    const head = (await this.pub.getBlock()).number!;
    if (await this.pub.getTransactionCount({ address: this.address, blockNumber: head }) <= p.nonce) return undefined;
    let low = BigInt(p.sentBlock) > 0n ? BigInt(p.sentBlock) - 1n : 0n;
    let high = head;
    if (await this.pub.getTransactionCount({ address: this.address, blockNumber: low }) > p.nonce) {
      throw new Error('receipt nonce predates saved send block; accounting requires investigation');
    }
    for (let steps = 0; high - low > 1n; steps++) {
      if (steps === 64) throw new Error('receipt nonce search exceeds 64 steps');
      const mid = (low + high) / 2n;
      if (await this.pub.getTransactionCount({ address: this.address, blockNumber: mid }) > p.nonce) high = mid;
      else low = mid;
    }
    const block = await this.pub.getBlock({ blockNumber: high, includeTransactions: true });
    const tx = block.transactions.find((t) => typeof t !== 'string' && t.from.toLowerCase() === this.address.toLowerCase() && t.nonce === p.nonce);
    if (!tx || typeof tx === 'string') throw new Error('consumed nonce transaction absent from located block; retry receipt accounting');
    let ours = tx.to?.toLowerCase() === b.toLowerCase() && tx.value === 0n;
    if (ours) {
      try {
        const decoded = decodeFunctionData({ abi: poolBalancerAbi, data: tx.input });
        ours = decoded.functionName === 'performUpkeep';
        if (ours && decoded.functionName === 'performUpkeep') {
          const args = decoded.args as readonly [Hash, bigint, bigint];
          const knownOffer = p.offers?.[tx.hash];
          (p.offers ??= {})[tx.hash] = { ...(knownOffer ?? { policy: args[0] === p.settingsHash ? p.policy : undefined, gas: p.gas, estimate: p.estimate, expenseGas: p.expenseGas, expenseSource: p.expenseSource }), minimumReward: args[1].toString(), minimumGas: args[2].toString() };
        }
      }
      catch { ours = false; }
    }
    if (!ours) {
      this.log('nonce consumed outside tracked upkeep', { balancer: b, nonce: p.nonce, hash: tx.hash });
      return null;
    }
    return this.pub.getTransactionReceipt({ hash: tx.hash });
  }

  private clearAccountedNonce(nonce: number) {
    delete this.state.accounting[String(nonce)];
    delete this.accountingErrors[String(nonce)];
    for (const [balancer, pending] of Object.entries(this.state.pending)) {
      if (pending.nonce === nonce) delete this.state.pending[balancer];
    }
  }

  private async recordReceipt(b: Address, p: Pending, r: TransactionReceipt): Promise<boolean> {
    const h = r.transactionHash;
    if (await this.canonicalHash(r.blockNumber) !== r.blockHash) return false;
    const recorded = this.state.receipts.find((entry) => entry.nonce === p.nonce);
    if (recorded) {
      if (recorded.hash !== h) throw new Error('conflicting canonical receipt nonce; retry after journal reconciliation');
      this.clearAccountedNonce(p.nonce);
      return true;
    }
    if (r.status === 'success') this.state.stats.mined++;
    else this.state.stats.reverted++;
    const cost = r.gasUsed * r.effectiveGasPrice;
    const offer = p.offers?.[h] ?? p;
    let reward = 0n;
    let measuredGas = 0n;
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== b.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: poolBalancerAbi, data: l.data, topics: l.topics });
        if (ev.eventName === 'KeeperPaid' && ev.args.keeper.toLowerCase() === this.address.toLowerCase()) { reward += ev.args.amount; measuredGas += ev.args.gasUsed; }
      } catch {} // other contracts' events
    }
    this.state.stats.spentWei = (BigInt(this.state.stats.spentWei) + cost).toString();
    this.state.stats.earnedWei = (BigInt(this.state.stats.earnedWei) + reward).toString();
    this.audit.push({ balancer: b, hash: h, status: r.status, gasUsed: r.gasUsed, measuredGas, reward, cost, gasEstimate: BigInt(offer.estimate), expenseGas: BigInt(offer.expenseGas ?? offer.estimate), expenseSource: offer.expenseSource ?? 'estimate', minimumReward: paymentAt({ minimumReward: BigInt(offer.minimumReward ?? '0'), minimumGas: BigInt(offer.minimumGas ?? '0') }, r.effectiveGasPrice), minimumGas: BigInt(offer.minimumGas ?? '0'), policy: offer.policy });
    if (this.audit.length > AUDIT_KEEP) this.audit.splice(0, this.audit.length - AUDIT_KEEP);
    this.log(r.status === 'success' ? 'mined' : 'reverted', { balancer: b, hash: h, gasUsed: r.gasUsed.toString(), gasLimit: offer.gas, measuredGas: measuredGas.toString(), rewardWei: reward.toString(), costWei: cost.toString(), netWei: (reward - cost).toString(), effectiveGasPriceWei: r.effectiveGasPrice.toString(), gasEstimate: offer.estimate, estimateMinusBilled: (BigInt(offer.estimate) - r.gasUsed).toString(), expenseGas: offer.expenseGas ?? offer.estimate, expenseSource: offer.expenseSource ?? 'estimate', expenseMinusBilled: (BigInt(offer.expenseGas ?? offer.estimate) - r.gasUsed).toString(), minimumFixedWei: offer.minimumReward ?? '0', minimumGas: offer.minimumGas ?? '0', minimumRewardWei: paymentAt({ minimumReward: BigInt(offer.minimumReward ?? '0'), minimumGas: BigInt(offer.minimumGas ?? '0') }, r.effectiveGasPrice).toString(), policy: offer.policy });
    this.state.receipts.push({ balancer: b, nonce: p.nonce, hash: h, block: r.blockNumber.toString(), blockHash: r.blockHash,
      status: r.status, cost: cost.toString(), reward: reward.toString(), pending: structuredClone(p) });
    this.clearAccountedNonce(p.nonce);
    return true;
  }

  /** True only when accounting is complete or a different transaction consumed this nonce. */
  private async accountPending(b: Address, p: Pending): Promise<boolean> {
    const confirmedNonce = await this.pub.getTransactionCount({ address: this.address, blockTag: 'latest' });
    for (const hash of p.hashes) {
      const receipt = await this.pub.getTransactionReceipt({ hash }).catch(() => null);
      if (receipt && await this.recordReceipt(b, p, receipt)) return true;
    }
    if (confirmedNonce <= p.nonce) return false;
    const recovered = await this.recoverReceipt(b, p);
    if (recovered === null) return true;
    return recovered ? this.recordReceipt(b, p, recovered) : false;
  }

  /** Returns true while a tx for `b` remains in flight. */
  private async resolvePending(b: Address, p: Pending, head: bigint, baseFee: bigint, context: PolicyContext): Promise<boolean> {
    if (await this.accountPending(b, p)) { delete this.state.pending[b]; return false; }
    if (head - BigInt(p.sentBlock) < BigInt(this.c.replaceAfterBlocks)) return true;
    // Evicted: the node holds no transaction of ours at this nonce (pending count not above it) and none of our hashes.
    // Release the send slot but retain accounting: a peer can mine the old send after these reads. attempt()
    // re-prices against the current pending nonce. A copy still known to the node keeps the send slot.
    const pendingNonce = await this.pub.getTransactionCount({ address: this.address, blockTag: 'pending' });
    if (pendingNonce <= p.nonce) {
      const known = await Promise.all(p.hashes.map((h) => this.pub.getTransaction({ hash: h }).then(() => true, () => false)));
      if (!known.some(Boolean)) {
        this.log('evicted: releasing send slot while retaining accounting', { balancer: b, nonce: p.nonce });
        this.state.accounting[String(p.nonce)] = { balancer: b, pending: p };
        delete this.state.pending[b];
        return false;
      }
    }
    if (!context.paid || p.replacements >= this.c.maxReplacements) return true;
    // Replace with the same nonce and +25% fees, only while the bid stays under the cap and profitable.
    const { cap } = this.fees(baseFee);
    const prio = (BigInt(p.maxPriorityFeePerGas) * 125n) / 100n + 1n;
    let max = (BigInt(p.maxFeePerGas) * 125n) / 100n + 1n;
    if (max < baseFee + prio) max = baseFee + prio;
    if (max > cap || prio > max) {
      this.log('waiting: replacement would exceed bid cap', { balancer: b, baseFeeGwei: Number(baseFee) / 1e9 });
      return true;
    }
    try {
      // Re-simulate changed work and policy at the same nonce, with a fresh executable limit and payment floor.
      const quote = await this.quote(b, baseFee, max, prio, context.settingsHash);
      if (!quote) {
        this.log('waiting: replacement unprofitable at current gas', { balancer: b });
        return true;
      }
      if (!(await this.allowed({ gas: quote.gas, maxFeePerGas: max, nonce: p.nonce }))) return true;
      const hash = await this.send(b, p.nonce, max, prio, quote.gas, context.settingsHash, quote.minimumReward, quote.minimumGas);
      p.hashes.push(hash);
      p.settingsHash = context.settingsHash;
      p.policy = context.policy;
      p.minimumReward = quote.minimumReward.toString();
      p.minimumGas = quote.minimumGas.toString();
      p.gas = quote.gas.toString();
      p.estimate = quote.gasEstimate.toString();
      p.expenseGas = quote.expenseGas.toString();
      p.expenseSource = quote.expenseSource;
      (p.offers ??= {})[hash] = { policy: p.policy, minimumReward: p.minimumReward, minimumGas: p.minimumGas, gas: p.gas, estimate: p.estimate, expenseGas: p.expenseGas, expenseSource: p.expenseSource };
      p.maxFeePerGas = max.toString();
      p.maxPriorityFeePerGas = prio.toString();
      p.sentBlock = head.toString();
      p.replacements++;
      this.state.stats.replaced++;
      this.log('replaced', { balancer: b, hash, nonce: p.nonce, maxFeeGwei: Number(max) / 1e9 });
    } catch (e) {
      const name = revertName(e);
      if (name && EXPECTED_REVERTS.has(name)) return true; // someone else did the work; the old tx will revert or be dropped
      this.log('replace failed', { balancer: b, error: (e as Error).message.split('\n')[0] });
    }
    return true;
  }

  health() {
    return {
      ok: Date.now() - this.lastTick < 120_000 && Object.keys(this.accountingErrors).length === 0,
      lastTick: new Date(this.lastTick).toISOString(),
      block: this.lastBlock.toString(),
      keeper: this.address,
      balancers: this.state.balancers.length,
      pending: Object.keys(this.state.pending),
      errors: this.errors,
      policies: this.policies,
      expenseEstimator: this.traceAvailable ? 'trace when supported' : 'conservative estimate',
      accounting: { coverage: this.state.accountingCoverage, journalEntries: this.state.receipts.length, retryNonces: Object.keys(this.state.accounting), reorgWindow: this.c.reorgWindow, journalPrunedThrough: this.state.journalPrunedThrough, errors: this.accountingErrors },
      stats: this.state.stats,
    };
  }

  serveHealth(port: number) {
    return createServer((req, res) => {
      const h = this.health();
      res.writeHead(req.url === '/health' && h.ok ? 200 : req.url === '/health' ? 503 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(h));
    }).listen(port);
  }

  async runForever(pollMs: number) {
    for (;;) {
      try {
        await this.tick();
      } catch (e) {
        this.log('tick failed', { error: (e as Error).message.split('\n')[0] });
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

/** Custom error name of a contract revert, if the error carries one. */
export function revertName(e: unknown): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  return r?.data?.errorName;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = (k: string, d?: string) => {
    const v = process.env[k] ?? d;
    if (v === undefined) throw new Error(`missing env ${k}`);
    return v;
  };
  // KEEPER_PRIVATE_KEY is read from the environment only and never written anywhere.
  const pk = process.env.KEEPER_PRIVATE_KEY as `0x${string}` | undefined;
  const account = pk ? privateKeyToAccount(pk) : (env('KEEPER_ADDRESS') as Address);
  const plan = process.env.CANARY_PLAN;
  const canary = plan ? await import('../scripts/canary-guard') : undefined;
  const guard = canary && plan ? new canary.CanaryGuard(canary.loadPlan(plan)) : undefined;
  const address = typeof account === 'string' ? account : account.address;
  if (guard && !guard.plan.accounts.keeper) throw new Error('CANARY_PLAN has no keeper account');
  if (guard && guard.plan.accounts.keeper.address.toLowerCase() !== address.toLowerCase()) throw new Error('CANARY_PLAN keeper account differs from this signer');
  const k = new Keeper({
    rpcUrl: env('RPC_URL', 'https://mainnet.gateway.tenderly.co'),
    factory: env('FACTORY') as Address,
    fromBlock: BigInt(env('FROM_BLOCK')),
    stateFile: env('STATE_FILE', 'keeper/state.json'),
    account,
    maxGasPriceGwei: Number(env('MAX_GAS_PRICE_GWEI', '50')),
    priorityGwei: Number(env('PRIORITY_GWEI', '0.05')),
    // Explicit operator subsidy allowance against the conservative execution budget; actual spend is in receipts.
    maxLossWei: BigInt(env('MAX_LOSS_WEI', '200000000000000')),
    operatingCostWei: BigInt(env('OPERATING_COST_WEI', '0')),
    beforeSend: guard?.keeperHook(address, 'keeper-run', (m, e) => console.log(JSON.stringify({ t: new Date().toISOString(), msg: m, ...e }))),
  });
  k.serveHealth(Number(env('HEALTH_PORT', '8787')));
  process.on('SIGINT', () => { k.save(); process.exit(0); });
  process.on('SIGTERM', () => { k.save(); process.exit(0); });
  k.runForever(Number(env('POLL_MS', '12000')));
}

