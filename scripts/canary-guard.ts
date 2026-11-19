// Cumulative gross gas guard for the owner's canary. Read-only: it never signs or sends.
// Spent gas is summed from the canonical receipt of every nonce each participating account has used since the plan's
// start nonces, so reverted transactions and transactions sent by any tool count. Keeper compensation is never netted.
// A send is allowed only when spent + in-flight maximums + the next transaction's maximum + the maximums of every
// planned action after the current one fit the plan's budget.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPublicClient, getAddress, http, toHex, type Address, type Hash, type PublicClient } from 'viem';

export interface PlannedAction { id: string; account?: string; gasLimit: string; maxFeePerGas: string }
export interface CanaryPlan {
  rpcUrl: string;
  chainId: number;
  budgetWei: string;
  /** Every owner-controlled account that sends canary transactions, with its nonce before the first one. */
  accounts: Record<string, { address: string; startNonce: number | null }>;
  /** The keeper's state file, read for its in-flight transactions when the check runs outside the keeper. */
  keeperStateFile?: string;
  /** Ordered. Every action after the current position is reserved at gasLimit x maxFeePerGas. */
  actions: PlannedAction[];
}
export interface InFlight { account: Address; nonce: number; gas: bigint; maxFeePerGas: bigint }
export interface Next { account: Address; gas: bigint; maxFeePerGas: bigint; nonce?: number }
export interface Check { spentWei: bigint; inFlightWei: bigint; nextWei: bigint; reservedWei: bigint; totalWei: bigint; budgetWei: bigint; ok: boolean }

const FINAL = 64n; // receipts this deep are cached; shallower ones are re-read every check

export function loadPlan(path: string): CanaryPlan {
  const p = JSON.parse(readFileSync(path, 'utf8')) as CanaryPlan;
  if (!p.rpcUrl || !p.chainId || BigInt(p.budgetWei) <= 0n) throw new Error('plan needs rpcUrl, chainId and a positive budgetWei');
  if (!p.actions?.length || new Set(p.actions.map(a => a.id)).size !== p.actions.length) throw new Error('plan needs uniquely named actions');
  for (const [name, a] of Object.entries(p.accounts)) if (!/^0x[0-9a-fA-F]{40}$/.test(a.address)) throw new Error(`account ${name} has no address`);
  return p;
}

/** Maximum still owed by the plan from `position` on: every later action at its gas limit x max fee. */
export function reservedAfter(plan: CanaryPlan, position: string): bigint {
  const i = plan.actions.findIndex(a => a.id === position);
  if (i < 0) throw new Error(`unknown action ${position}`);
  return plan.actions.slice(i + 1).reduce((s, a) => s + BigInt(a.gasLimit) * BigInt(a.maxFeePerGas), 0n);
}

/** Only one transaction per (account, nonce) can be included, so a replacement owes the larger of the two maximums. */
export function commitments(inFlight: InFlight[], next: Next): { inFlightWei: bigint; nextWei: bigint } {
  const byNonce = new Map<string, bigint>();
  for (const t of inFlight) {
    const k = `${t.account.toLowerCase()}:${t.nonce}`;
    const w = t.gas * t.maxFeePerGas;
    if ((byNonce.get(k) ?? -1n) < w) byNonce.set(k, w);
  }
  let nextWei = next.gas * next.maxFeePerGas;
  if (next.nonce !== undefined) {
    const k = `${next.account.toLowerCase()}:${next.nonce}`;
    const old = byNonce.get(k);
    if (old !== undefined) { byNonce.delete(k); if (old > nextWei) nextWei = old; }
  }
  return { inFlightWei: [...byNonce.values()].reduce((a, b) => a + b, 0n), nextWei };
}

export function evaluate(plan: CanaryPlan, position: string, spentWei: bigint, inFlight: InFlight[], next: Next): Check {
  const { inFlightWei, nextWei } = commitments(inFlight, next);
  const reservedWei = reservedAfter(plan, position);
  const totalWei = spentWei + inFlightWei + nextWei + reservedWei;
  const budgetWei = BigInt(plan.budgetWei);
  return { spentWei, inFlightWei, nextWei, reservedWei, totalWei, budgetWei, ok: totalWei <= budgetWei };
}

/** The keeper's own unconfirmed sends, from its state: pending upkeeps and evicted sends whose fate is unknown. */
export function keeperInFlight(state: any, keeper: Address): InFlight[] {
  const rows = [...Object.values(state?.pending ?? {}), ...Object.values(state?.accounting ?? {}).map((r: any) => r.pending)] as any[];
  return rows.map(p => ({ account: keeper, nonce: Number(p.nonce), gas: BigInt(p.gas), maxFeePerGas: BigInt(p.maxFeePerGas) }));
}

export class CanaryGuard {
  readonly pub: PublicClient;
  private cache = new Map<string, bigint>();
  constructor(readonly plan: CanaryPlan, pub?: PublicClient) {
    this.pub = pub ?? createPublicClient({ transport: http(plan.rpcUrl, { timeout: 60_000 }) }) as PublicClient;
  }

  private addresses(): Address[] { return Object.values(this.plan.accounts).map(a => getAddress(a.address)); }

  /** Gross wei paid for every included transaction since the start nonces, reverted ones included. */
  async spent(): Promise<bigint> {
    if (await this.pub.getChainId() !== this.plan.chainId) throw new Error('RPC chain does not match the plan');
    const head = await this.pub.getBlockNumber();
    let total = 0n;
    for (const a of Object.values(this.plan.accounts)) {
      if (a.startNonce === null) throw new Error(`start nonce for ${a.address} not recorded; run init first`);
      const address = getAddress(a.address);
      const mined = await this.pub.getTransactionCount({ address, blockTag: 'latest' });
      for (let n = a.startNonce; n < mined; n++) {
        const key = `${address}:${n}`;
        let cost = this.cache.get(key);
        if (cost === undefined) {
          const tx = await this.pub.request({ method: 'eth_getTransactionBySenderAndNonce' as any, params: [address, toHex(n)] as any }) as { hash: Hash } | null;
          if (!tx?.hash) throw new Error(`no canonical transaction for ${address} nonce ${n}; cannot account its gas`);
          const r = await this.pub.getTransactionReceipt({ hash: tx.hash });
          cost = r.gasUsed * r.effectiveGasPrice + (r.blobGasUsed ?? 0n) * (r.blobGasPrice ?? 0n);
          if (head - r.blockNumber >= FINAL) this.cache.set(key, cost);
        }
        total += cost;
      }
    }
    return total;
  }

  /** Unconfirmed sends. Known ones come from `known` (the keeper's state); any other pending nonce fails closed. */
  async inFlight(known: InFlight[]): Promise<InFlight[]> {
    const out = [...known];
    for (const address of this.addresses()) {
      const [mined, pending] = await Promise.all([
        this.pub.getTransactionCount({ address, blockTag: 'latest' }),
        this.pub.getTransactionCount({ address, blockTag: 'pending' }),
      ]);
      for (let n = mined; n < pending; n++)
        if (!known.some(k => k.account.toLowerCase() === address.toLowerCase() && k.nonce === n))
          throw new Error(`unaccounted pending transaction ${address} nonce ${n}; wait for it to be included`);
    }
    return out;
  }

  async check(position: string, next: Next, known: InFlight[] = []): Promise<Check> {
    if (!known.length && this.plan.keeperStateFile && existsSync(this.plan.keeperStateFile)) {
      const keeper = this.plan.accounts.keeper?.address;
      if (keeper) known = keeperInFlight(JSON.parse(readFileSync(this.plan.keeperStateFile, 'utf8')), getAddress(keeper));
    }
    return evaluate(this.plan, position, await this.spent(), await this.inFlight(known), next);
  }

  /** Keeper hook: refuse a send that would breach the budget, and refuse when the budget cannot be read. */
  keeperHook(keeper: Address, position = 'keeper-run', log: (m: string, e?: object) => void = () => {}) {
    return async (next: { gas: bigint; maxFeePerGas: bigint; nonce: number }, known: InFlight[]): Promise<boolean> => {
      try {
        const c = await this.check(position, { account: keeper, ...next }, known);
        if (!c.ok) log('canary budget: refusing send', fmt(c));
        return c.ok;
      } catch (e) {
        log('canary budget: unreadable, refusing send', { error: (e as Error).message.split('\n')[0] });
        return false;
      }
    };
  }
}

const fmt = (c: Check) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));

async function main(argv: string[]) {
  const arg = (name: string) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  const [command] = argv;
  const path = arg('--plan');
  if (!path || (command !== 'init' && command !== 'check')) {
    console.error('usage: canary-guard.ts init --plan <file> | check --plan <file> --action <id> [--account <name>] [--gas <limit>] [--max-fee <wei>]');
    return 2;
  }
  const plan = loadPlan(path);
  const guard = new CanaryGuard(plan);
  if (command === 'init') {
    for (const a of Object.values(plan.accounts)) {
      if (a.startNonce !== null) continue;
      const address = getAddress(a.address);
      const [mined, pending] = await Promise.all([guard.pub.getTransactionCount({ address, blockTag: 'latest' }), guard.pub.getTransactionCount({ address, blockTag: 'pending' })]);
      if (mined !== pending) throw new Error(`${address} has a pending transaction; record start nonces when idle`);
      a.startNonce = mined;
    }
    writeFileSync(path, JSON.stringify(plan, null, 2) + '\n');
    console.log(JSON.stringify(plan.accounts, null, 2));
    return 0;
  }
  const id = arg('--action')!;
  const action = plan.actions.find(a => a.id === id);
  if (!action) throw new Error(`unknown action ${id}`);
  const who = arg('--account') ?? action.account;
  if (!who || !plan.accounts[who]) throw new Error('name the sending account (--account or the action\'s account)');
  const c = await guard.check(id, { account: getAddress(plan.accounts[who].address), gas: BigInt(arg('--gas') ?? action.gasLimit), maxFeePerGas: BigInt(arg('--max-fee') ?? action.maxFeePerGas) });
  console.log(JSON.stringify({ action: id, ...fmt(c), remainingAfterWorstCaseWei: (c.budgetWei - c.totalWei).toString() }, null, 2));
  return c.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error((e as Error).message); process.exit(2); });
