// Shared permissionless keeper for every Balancer created by one BalancerFactory.
// Each tick: discover Balancers and failed Shape deliveries from events (re-scanning a reorg window),
// then for each Balancer simulate `performUpkeep` (or `recoverRefundedShape`) at the gas price it would
// bid. The simulation returns the contract's reward; the call is sent only when that reward covers the
// estimated cost under the configured policy. Expected reverts (NoUpkeepNeeded, PoolBusy) mean "nothing
// to do"; any other revert is reported as a pool error. One in-flight tx per Balancer, replaced with
// bumped fees only while still profitable. State persists to a JSON file so restarts resume safely.
import { createServer } from 'node:http';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, decodeEventLog, getAddress, http, parseAbiItem,
  type Account, type Address, type Hash, type PublicClient, type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { fwaPoolAbi, poolBalancerAbi } from '../shared/abi';

const CREATED = parseAbiItem('event BalancerCreated(address indexed creator, address indexed balancer, address indexed pool, bytes32 salt)');
const DRAWN = parseAbiItem('event ItemDrawn(uint256 indexed listingId, uint8 kind, uint8 denom, bool delivered)');
const GWEI = 10n ** 9n;
/** Reverts that only mean "no work right now". */
export const EXPECTED_REVERTS = new Set(['NoUpkeepNeeded', 'PoolBusy']);
/** Contract constants (src/PoolBalancer.sol). */
export const KEEPER_MAX_GAS = 3_200_000n;
const SHAPE = 2;
const PENDING = 2;
const L_DELIVERY_REFUNDED = 7;

type Fn = 'performUpkeep' | 'recoverRefundedShape';

export interface Policy {
  /** Gas units from `eth_estimateGas` (pre-refund execution gas: an upper bound on the billed gas). */
  gasEstimate: bigint;
  /** Reward returned by simulating the call at the bid gas price. */
  expectedReward: bigint;
  baseFee: bigint;
  priorityFee: bigint;
  /** Loss the operator accepts per call (e.g. gas-only reconciliations that keep pools open). */
  maxLossWei: bigint;
}

/** Send only when the contract's reward covers the estimated cost (within `maxLossWei`). */
export function decide(p: Policy): { send: boolean; reason: string } {
  if (p.gasEstimate > KEEPER_MAX_GAS) return { send: false, reason: 'estimate above reimbursable maximum' };
  const cost = p.gasEstimate * (p.baseFee + p.priorityFee);
  if (p.expectedReward + p.maxLossWei < cost) return { send: false, reason: 'unprofitable at current gas' };
  return { send: true, reason: 'ok' };
}

export interface KeeperConfig {
  rpcUrl: string;
  factory: Address;
  fromBlock: bigint;
  stateFile: string;
  account: Account | Address; // Address = unlocked dev node account
  reorgWindow?: number; // blocks re-scanned every tick
  maxGasPriceGwei?: number; // never bid above this; the contract reimburses at most 5 gwei
  priorityGwei?: number; // the contract reimburses at most 0.05 gwei over basefee
  maxLossWei?: bigint;
  replaceAfterBlocks?: number;
  maxReplacements?: number;
  logChunk?: bigint;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

interface Pending { fn: Fn; args: string[]; hashes: Hash[]; nonce: number; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string; sentBlock: string; replacements: number }
interface State {
  lastScanned: string;
  balancers: Address[];
  /** Shape listing ids whose FWA delivery failed, per Balancer, until recovered or settled. */
  refundWatch: Record<string, string[]>;
  pending: Record<string, Pending>;
  stats: { sent: number; mined: number; reverted: number; replaced: number; skippedUnprofitable: number; spentWei: string; earnedWei: string };
}
export interface AuditEntry { balancer: Address; fn: Fn; hash: Hash; gasUsed: bigint; reimbursedGas: bigint; reward: bigint; cost: bigint }

export class Keeper {
  readonly pub: PublicClient;
  readonly wallet: WalletClient;
  state: State;
  errors: Record<string, string> = {};
  audit: AuditEntry[] = [];
  lastTick = 0;
  lastBlock = 0n;
  private readonly c: Required<Omit<KeeperConfig, 'log'>> & Pick<KeeperConfig, 'log'>;

  constructor(cfg: KeeperConfig) {
    this.c = { reorgWindow: 64, maxGasPriceGwei: 5, priorityGwei: 0.05, maxLossWei: 2n * 10n ** 14n, replaceAfterBlocks: 3, maxReplacements: 5, logChunk: 10_000n, ...cfg };
    const transport = http(cfg.rpcUrl);
    this.pub = createPublicClient({ transport }) as PublicClient;
    this.wallet = createWalletClient({ transport, account: cfg.account });
    this.state = this.load();
  }

  private log(msg: string, extra?: Record<string, unknown>) {
    (this.c.log ?? ((m, e) => console.log(JSON.stringify({ t: new Date().toISOString(), msg: m, ...e }))))(msg, extra);
  }

  private load(): State {
    const fresh: State = {
      lastScanned: (this.c.fromBlock - 1n).toString(), balancers: [], refundWatch: {}, pending: {},
      stats: { sent: 0, mined: 0, reverted: 0, replaced: 0, skippedUnprofitable: 0, spentWei: '0', earnedWei: '0' },
    };
    if (!existsSync(this.c.stateFile)) return fresh;
    const s = JSON.parse(readFileSync(this.c.stateFile, 'utf8'));
    return { ...fresh, ...s, stats: { ...fresh.stats, ...s.stats } };
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
      if (this.state.balancers.length) {
        const drawn = await this.pub.getLogs({ address: this.state.balancers, event: DRAWN, fromBlock: start, toBlock: end });
        for (const l of drawn) {
          if (l.args.delivered || l.args.kind !== SHAPE) continue;
          const w = (this.state.refundWatch[getAddress(l.address)] ??= []); // logs carry lowercase addresses
          const id = l.args.listingId!.toString();
          if (!w.includes(id)) w.push(id);
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
        delete this.state.pending[b];
        delete this.state.refundWatch[b];
      }
    }
    this.state.balancers = kept;
    this.state.lastScanned = head.toString();
  }

  async tick() {
    const block = await this.pub.getBlock();
    const head = block.number!;
    this.lastBlock = head;
    await this.discover(head);
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

  private fees(baseFee: bigint) {
    const priority = this.gwei(this.c.priorityGwei);
    const cap = this.gwei(this.c.maxGasPriceGwei);
    const max = baseFee * 2n + priority > cap ? cap : baseFee * 2n + priority;
    return { priority, max, cap };
  }

  private async service(b: Address, head: bigint, baseFee: bigint) {
    const p = this.state.pending[b];
    if (p && (await this.resolvePending(b, p, head, baseFee))) return; // still in flight
    const { priority, max, cap } = this.fees(baseFee);
    if (baseFee + priority > cap) {
      this.log('skip: basefee above bid cap', { balancer: b, baseFeeGwei: Number(baseFee) / 1e9 });
      return;
    }
    if (await this.attempt(b, 'performUpkeep', [], head, baseFee, max, priority)) return;
    // Refunded Shapes: recover and redeem (gas-only reward).
    const watch = this.state.refundWatch[b] ?? [];
    if (!watch.length) return;
    const pool = (await this.pub.readContract({ address: b, abi: poolBalancerAbi, functionName: 'pool' })) as Address;
    for (const id of [...watch]) {
      const item = (await this.pub.readContract({ address: b, abi: poolBalancerAbi, functionName: 'items', args: [BigInt(id)] })) as readonly unknown[];
      if (Number(item[2]) !== PENDING) {
        this.state.refundWatch[b] = this.state.refundWatch[b].filter((x) => x !== id); // recovered or forgotten
        continue;
      }
      const listing = (await this.pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'listings', args: [BigInt(id)] })) as readonly unknown[];
      if (Number(listing[7]) === L_DELIVERY_REFUNDED && (await this.attempt(b, 'recoverRefundedShape', [id], head, baseFee, max, priority))) return;
    }
  }

  /** Simulate, apply the profitability policy and send. Returns true if a tx was sent. */
  private async attempt(b: Address, fn: Fn, args: string[], head: bigint, baseFee: bigint, maxFeePerGas: bigint, priority: bigint): Promise<boolean> {
    const callArgs = args.map(BigInt);
    const call = { address: b, abi: poolBalancerAbi, functionName: fn, args: callArgs, account: this.address, maxFeePerGas, maxPriorityFeePerGas: priority } as const;
    let reward: bigint;
    try {
      reward = (await this.pub.simulateContract(call as never)).result as bigint;
    } catch (e) {
      const name = revertName(e);
      if (name && EXPECTED_REVERTS.has(name)) return false;
      if (fn === 'recoverRefundedShape' && name === 'InvalidItem') return false; // not refunded yet
      throw e; // unexpected: surface as a pool error
    }
    const gasEstimate = await this.pub.estimateContractGas(call as never);
    const verdict = decide({ gasEstimate, expectedReward: reward, baseFee, priorityFee: priority, maxLossWei: this.c.maxLossWei });
    if (!verdict.send) {
      this.state.stats.skippedUnprofitable++;
      this.log(`skip: ${verdict.reason}`, { balancer: b, fn, gasEstimate: gasEstimate.toString(), rewardWei: reward.toString() });
      return false;
    }
    // Shapes mint gas varies with the block seed: the limit has 30% headroom. Only gas actually used is
    // billed, and the contract reimburses measured gas, never the limit.
    const gas = (gasEstimate * 13n) / 10n;
    const nonce = await this.pub.getTransactionCount({ address: this.address, blockTag: 'pending' });
    const hash = await this.send(b, fn, callArgs, nonce, maxFeePerGas, priority, gas);
    this.state.pending[b] = { fn, args, hashes: [hash], nonce, gas: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: priority.toString(), sentBlock: head.toString(), replacements: 0 };
    this.state.stats.sent++;
    this.log(`sent ${fn}`, { balancer: b, hash, nonce, gasEstimate: gasEstimate.toString(), expectedRewardWei: reward.toString() });
    return true;
  }

  private async send(b: Address, fn: Fn, args: bigint[], nonce: number, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint, gas: bigint) {
    return this.wallet.writeContract({
      address: b, abi: poolBalancerAbi, functionName: fn, args, account: this.c.account, chain: null,
      nonce, maxFeePerGas, maxPriorityFeePerGas, gas,
    } as never);
  }

  /** Returns true while a tx for `b` remains in flight. */
  private async resolvePending(b: Address, p: Pending, head: bigint, baseFee: bigint): Promise<boolean> {
    for (const h of p.hashes) {
      const r = await this.pub.getTransactionReceipt({ hash: h }).catch(() => null);
      if (!r) continue;
      if (r.status === 'success') this.state.stats.mined++;
      else this.state.stats.reverted++;
      const cost = r.gasUsed * r.effectiveGasPrice;
      let reward = 0n;
      let reimbursedGas = 0n;
      for (const l of r.logs) {
        try {
          const ev = decodeEventLog({ abi: poolBalancerAbi, data: l.data, topics: l.topics });
          if (ev.eventName === 'KeeperPaid') ({ amount: reward, gasUsed: reimbursedGas } = ev.args as { amount: bigint; gasUsed: bigint });
        } catch {} // other contracts' events
      }
      this.state.stats.spentWei = (BigInt(this.state.stats.spentWei) + cost).toString();
      this.state.stats.earnedWei = (BigInt(this.state.stats.earnedWei) + reward).toString();
      this.audit.push({ balancer: b, fn: p.fn, hash: h, gasUsed: r.gasUsed, reimbursedGas, reward, cost });
      this.log(r.status === 'success' ? 'mined' : 'reverted', { balancer: b, fn: p.fn, hash: h, gasUsed: r.gasUsed.toString(), reimbursedGas: reimbursedGas.toString(), rewardWei: reward.toString(), costWei: cost.toString() });
      delete this.state.pending[b];
      return false;
    }
    const confirmedNonce = await this.pub.getTransactionCount({ address: this.address, blockTag: 'latest' });
    if (confirmedNonce > p.nonce) {
      // Nonce consumed by a tx we did not see (e.g. replaced outside this process): stop tracking.
      delete this.state.pending[b];
      return false;
    }
    if (head - BigInt(p.sentBlock) < BigInt(this.c.replaceAfterBlocks)) return true;
    if (p.replacements >= this.c.maxReplacements) return true;
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
      const call = { address: b, abi: poolBalancerAbi, functionName: p.fn, args: p.args.map(BigInt), account: this.address, maxFeePerGas: max, maxPriorityFeePerGas: prio } as const;
      const reward = (await this.pub.simulateContract(call as never)).result as bigint;
      const verdict = decide({ gasEstimate: BigInt(p.gas) * 10n / 13n, expectedReward: reward, baseFee, priorityFee: prio, maxLossWei: this.c.maxLossWei });
      if (!verdict.send) {
        this.log(`waiting: replacement ${verdict.reason}`, { balancer: b });
        return true;
      }
      const hash = await this.send(b, p.fn, p.args.map(BigInt), p.nonce, max, prio, BigInt(p.gas));
      p.hashes.push(hash);
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
      ok: Date.now() - this.lastTick < 120_000,
      lastTick: new Date(this.lastTick).toISOString(),
      block: this.lastBlock.toString(),
      keeper: this.address,
      balancers: this.state.balancers.length,
      pending: Object.keys(this.state.pending),
      errors: this.errors,
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
  const k = new Keeper({
    rpcUrl: env('RPC_URL', 'https://mainnet.gateway.tenderly.co'),
    factory: env('FACTORY') as Address,
    fromBlock: BigInt(env('FROM_BLOCK')),
    stateFile: env('STATE_FILE', 'keeper/state.json'),
    account,
    maxGasPriceGwei: Number(env('MAX_GAS_PRICE_GWEI', '5')),
    priorityGwei: Number(env('PRIORITY_GWEI', '0.05')),
    // Default covers gas-only paid calls at the 5 gwei cap (worst measured loss 0.00017 ETH) and unpaid
    // re-checkpoints (155k gas) up to ~1.2 gwei; set 0 for a strictly profitable keeper.
    maxLossWei: BigInt(env('MAX_LOSS_WEI', '200000000000000')),
  });
  k.serveHealth(Number(env('HEALTH_PORT', '8787')));
  process.on('SIGINT', () => { k.save(); process.exit(0); });
  process.on('SIGTERM', () => { k.save(); process.exit(0); });
  k.runForever(Number(env('POLL_MS', '12000')));
}

export { GWEI };
