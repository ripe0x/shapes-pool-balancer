// Shared permissionless keeper for every Balancer created by one BalancerFactory.
// Discovers Balancers from factory events (re-scanning a reorg window), asks each Balancer whether
// upkeep is needed, simulates performUpkeep, and sends it only when the simulation succeeds and the
// gas price is within the contract's reimbursement cap. One in-flight tx per Balancer, replaced
// with bumped fees if not mined. State persists to a JSON file so restarts resume safely.
import { createServer } from 'node:http';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, http, parseAbiItem, type Account, type Address, type Hash, type PublicClient, type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { poolBalancerAbi } from '../shared/abi';

const CREATED = parseAbiItem('event BalancerCreated(address indexed creator, address indexed balancer, address indexed pool, bytes32 salt)');
const GWEI = 10n ** 9n;

export interface KeeperConfig {
  rpcUrl: string;
  factory: Address;
  fromBlock: bigint;
  stateFile: string;
  account: Account | Address; // Address = unlocked dev node account
  reorgWindow?: number; // blocks re-scanned every tick
  maxGasPriceGwei?: number; // contract reimburses at most 10 gwei
  priorityGwei?: number;
  replaceAfterBlocks?: number;
  maxReplacements?: number;
  logChunk?: bigint;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

interface Pending { hashes: Hash[]; nonce: number; maxFeePerGas: string; maxPriorityFeePerGas: string; sentBlock: string; replacements: number }
interface State { lastScanned: string; balancers: Address[]; pending: Record<string, Pending>; stats: { sent: number; mined: number; reverted: number; replaced: number } }

export class Keeper {
  readonly pub: PublicClient;
  readonly wallet: WalletClient;
  state: State;
  errors: Record<string, string> = {};
  lastTick = 0;
  lastBlock = 0n;
  private readonly c: Required<Omit<KeeperConfig, 'log'>> & Pick<KeeperConfig, 'log'>;

  constructor(cfg: KeeperConfig) {
    this.c = { reorgWindow: 64, maxGasPriceGwei: 10, priorityGwei: 0.1, replaceAfterBlocks: 3, maxReplacements: 5, logChunk: 10_000n, ...cfg };
    const transport = http(cfg.rpcUrl);
    this.pub = createPublicClient({ transport }) as PublicClient;
    this.wallet = createWalletClient({ transport, account: cfg.account });
    this.state = this.load();
  }

  private log(msg: string, extra?: Record<string, unknown>) {
    (this.c.log ?? ((m, e) => console.log(JSON.stringify({ t: new Date().toISOString(), msg: m, ...e }))))(msg, extra);
  }

  private load(): State {
    if (existsSync(this.c.stateFile)) return JSON.parse(readFileSync(this.c.stateFile, 'utf8'));
    return { lastScanned: (this.c.fromBlock - 1n).toString(), balancers: [], pending: {}, stats: { sent: 0, mined: 0, reverted: 0, replaced: 0 } };
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
          this.state.balancers.push(b);
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
        delete this.state.pending[b];
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

  private async service(b: Address, head: bigint, baseFee: bigint) {
    const p = this.state.pending[b];
    if (p) {
      if (await this.resolvePending(b, p, head, baseFee)) return; // still in flight
    }
    const needs = await this.pub.readContract({ address: b, abi: poolBalancerAbi, functionName: 'needsUpkeep' });
    if (!needs) return;
    try {
      await this.pub.simulateContract({ address: b, abi: poolBalancerAbi, functionName: 'performUpkeep', account: this.address });
    } catch {
      return; // NoUpkeepNeeded, PoolBusy or infeasible: nothing to do now
    }
    const priority = BigInt(Math.round(this.c.priorityGwei * 1e9));
    const cap = BigInt(Math.round(this.c.maxGasPriceGwei * 1e9));
    if (baseFee + priority > cap) {
      this.log('skip: gas above reimbursement cap', { balancer: b, baseFeeGwei: Number(baseFee) / 1e9 });
      return;
    }
    const maxFeePerGas = baseFee * 2n + priority > cap ? cap : baseFee * 2n + priority;
    const nonce = await this.pub.getTransactionCount({ address: this.address, blockTag: 'pending' });
    const hash = await this.send(b, nonce, maxFeePerGas, priority);
    this.state.pending[b] = { hashes: [hash], nonce, maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: priority.toString(), sentBlock: head.toString(), replacements: 0 };
    this.state.stats.sent++;
    this.log('sent performUpkeep', { balancer: b, hash, nonce });
  }

  private async send(b: Address, nonce: number, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint) {
    return this.wallet.writeContract({
      address: b, abi: poolBalancerAbi, functionName: 'performUpkeep', account: this.c.account, chain: null,
      nonce, maxFeePerGas, maxPriorityFeePerGas, gas: 3_500_000n,
    });
  }

  /** Returns true while a tx for `b` remains in flight. */
  private async resolvePending(b: Address, p: Pending, head: bigint, baseFee: bigint): Promise<boolean> {
    for (const h of p.hashes) {
      const r = await this.pub.getTransactionReceipt({ hash: h }).catch(() => null);
      if (r) {
        if (r.status === 'success') this.state.stats.mined++;
        else this.state.stats.reverted++;
        this.log(r.status === 'success' ? 'mined' : 'reverted', { balancer: b, hash: h, block: r.blockNumber.toString(), gasUsed: r.gasUsed.toString() });
        delete this.state.pending[b];
        return false;
      }
    }
    const confirmedNonce = await this.pub.getTransactionCount({ address: this.address, blockTag: 'latest' });
    if (confirmedNonce > p.nonce) {
      // Nonce consumed by a tx we did not see (e.g. replaced outside this process): stop tracking.
      delete this.state.pending[b];
      return false;
    }
    if (head - BigInt(p.sentBlock) < BigInt(this.c.replaceAfterBlocks)) return true;
    if (p.replacements >= this.c.maxReplacements) return true;
    // Replace with the same nonce, +25% fees, still within the reimbursement cap.
    const cap = BigInt(Math.round(this.c.maxGasPriceGwei * 1e9));
    let prio = (BigInt(p.maxPriorityFeePerGas) * 125n) / 100n + 1n;
    let max = (BigInt(p.maxFeePerGas) * 125n) / 100n + 1n;
    if (max < baseFee + prio) max = baseFee + prio;
    if (max > cap) max = cap;
    if (prio > max) prio = max;
    try {
      const hash = await this.send(b, p.nonce, max, prio);
      p.hashes.push(hash);
      p.maxFeePerGas = max.toString();
      p.maxPriorityFeePerGas = prio.toString();
      p.sentBlock = head.toString();
      p.replacements++;
      this.state.stats.replaced++;
      this.log('replaced', { balancer: b, hash, nonce: p.nonce, maxFeeGwei: Number(max) / 1e9 });
    } catch (e) {
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
    maxGasPriceGwei: Number(env('MAX_GAS_PRICE_GWEI', '10')),
    priorityGwei: Number(env('PRIORITY_GWEI', '0.1')),
  });
  k.serveHealth(Number(env('HEALTH_PORT', '8787')));
  process.on('SIGINT', () => { k.save(); process.exit(0); });
  process.on('SIGTERM', () => { k.save(); process.exit(0); });
  k.runForever(Number(env('POLL_MS', '12000')));
}
