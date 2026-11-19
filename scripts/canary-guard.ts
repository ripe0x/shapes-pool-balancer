// Cumulative gross gas guard for the owner's canary. Read-only: it never signs or sends.
// Spent gas is summed from the canonical receipt of every nonce each participating account has used since the plan's
// start nonces, so reverted transactions and transactions sent by any tool count. Keeper compensation is never netted.
// A send is allowed only when spent + in-flight maximums + the next transaction's maximum + the maximums of every
// planned action after the current one fit the plan's budget.
import { createHash } from 'node:crypto';
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

export const planHash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Parse and sanity-check a plan file (for init and hashing). Execution uses loadApprovedPlan. */
export function loadPlan(path: string): CanaryPlan {
  const p = JSON.parse(readFileSync(path, 'utf8')) as CanaryPlan;
  if (!p.rpcUrl || !p.chainId || BigInt(p.budgetWei) <= 0n) throw new Error('plan needs rpcUrl, chainId and a positive budgetWei');
  if (!p.actions?.length || new Set(p.actions.map(a => a.id)).size !== p.actions.length) throw new Error('plan needs uniquely named actions');
  for (const [name, a] of Object.entries(p.accounts)) if (!/^0x[0-9a-fA-F]{40}$/.test(a.address)) throw new Error(`account ${name} has no address`);
  wallets(p);
  return p;
}

/** The exact file the owner approved: its SHA-256 must equal `approved`, and every start nonce must be recorded. */
export function loadApprovedPlan(path: string, approved: string | undefined): CanaryPlan {
  if (!approved || !/^[0-9a-f]{64}$/.test(approved)) throw new Error('the approved plan SHA-256 is required');
  const actual = planHash(readFileSync(path));
  if (actual !== approved) throw new Error(`plan file ${path} has SHA-256 ${actual}, not the approved ${approved}`);
  const p = loadPlan(path);
  if (Object.values(p.accounts).some(a => a.startNonce === null)) throw new Error('approved plan lacks start nonces');
  return p;
}

/** Distinct wallets: one wallet may hold several roles, and its gas must be counted once. */
export function wallets(plan: CanaryPlan): { address: Address; startNonce: number | null }[] {
  const byAddress = new Map<string, { address: Address; startNonce: number | null }>();
  for (const [name, a] of Object.entries(plan.accounts)) {
    const address = getAddress(a.address);
    const seen = byAddress.get(address);
    if (seen && seen.startNonce !== a.startNonce) throw new Error(`role ${name} shares wallet ${address} with a different start nonce`);
    byAddress.set(address, { address, startNonce: a.startNonce });
  }
  return [...byAddress.values()];
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


  /** Gross wei paid for every included transaction since the start nonces, reverted ones included. */
  async spent(): Promise<bigint> {
    if (await this.pub.getChainId() !== this.plan.chainId) throw new Error('RPC chain does not match the plan');
    const head = await this.pub.getBlockNumber();
    let total = 0n;
    for (const { address, startNonce } of wallets(this.plan)) {
      if (startNonce === null) throw new Error(`start nonce for ${address} not recorded; run init first`);
      const mined = await this.pub.getTransactionCount({ address, blockTag: 'latest' });
      for (let n = startNonce; n < mined; n++) {
        const key = `${address}:${n}`;
        let cost = this.cache.get(key);
        if (cost === undefined) {
          const r = await this.minedReceipt(address, n);
          cost = r.gasUsed * r.effectiveGasPrice + (r.blobGasUsed ?? 0n) * (r.blobGasPrice ?? 0n);
          if (head - r.blockNumber >= FINAL) this.cache.set(key, cost);
        }
        total += cost;
      }
    }
    return total;
  }

  /** The included transaction at (sender, nonce). Providers differ on this method, so the answer is checked against
   *  the transaction by hash and its receipt; any disagreement fails closed. */
  async minedReceipt(sender: Address, nonce: number) {
    const tx = await this.pub.request({ method: 'eth_getTransactionBySenderAndNonce' as any, params: [sender, toHex(nonce)] as any }) as { hash?: Hash } | null;
    if (!tx?.hash) throw new Error(`no canonical transaction for ${sender} nonce ${nonce}; cannot account its gas`);
    const [byHash, r] = await Promise.all([this.pub.getTransaction({ hash: tx.hash }), this.pub.getTransactionReceipt({ hash: tx.hash })]);
    if (getAddress(byHash.from) !== sender || byHash.nonce !== nonce || getAddress(r.from) !== sender || r.transactionHash !== tx.hash || byHash.blockHash !== r.blockHash)
      throw new Error(`provider returned an inconsistent transaction for ${sender} nonce ${nonce}`);
    return r;
  }

  /** Unconfirmed sends. Known ones come from `known` (the keeper's state); any other pending nonce fails closed. */
  async inFlight(known: InFlight[]): Promise<InFlight[]> {
    const out = [...known];
    for (const { address } of wallets(this.plan)) {
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
  if (command === 'preflight') {
    // Read-only check that the RPC answers eth_getTransactionBySenderAndNonce consistently for a real mined transaction.
    const rpc = arg('--rpc-url'), sender = arg('--sender'), nonce = arg('--nonce');
    if (!rpc || !sender || nonce === undefined) { console.error('usage: preflight --rpc-url <url> --sender <address> --nonce <n>'); return 2; }
    const pub = createPublicClient({ transport: http(rpc, { timeout: 60_000 }) }) as PublicClient;
    const g = new CanaryGuard({ rpcUrl: rpc, chainId: await pub.getChainId(), budgetWei: '1', accounts: {}, actions: [{ id: 'x', gasLimit: '0', maxFeePerGas: '0' }] }, pub);
    const r = await g.minedReceipt(getAddress(sender), Number(nonce));
    console.log(JSON.stringify({ rpc, sender, nonce: Number(nonce), hash: r.transactionHash, block: r.blockNumber.toString(), status: r.status, costWei: (r.gasUsed * r.effectiveGasPrice).toString(), consistent: true }, null, 2));
    return 0;
  }
  if (!path || !['init', 'hash', 'check'].includes(command)) {
    console.error('usage: canary-guard.ts preflight --rpc-url <url> --sender <a> --nonce <n> | init --plan <file> | hash --plan <file> | check --plan <file> --approved-plan-hash <sha256> --action <id>');
    return 2;
  }
  if (command === 'hash') {
    const plan = loadPlan(path);
    if (Object.values(plan.accounts).some(a => a.startNonce === null)) throw new Error('run init first: start nonces are part of the approved plan');
    console.log(planHash(readFileSync(path)));
    return 0;
  }
  if (command === 'init') {
    const plan = loadPlan(path);
    const guard = new CanaryGuard(plan);
    const nonces = new Map<string, number>();
    for (const a of Object.values(plan.accounts)) {
      if (a.startNonce !== null) continue;
      const address = getAddress(a.address);
      if (!nonces.has(address)) {
        const [mined, pending] = await Promise.all([guard.pub.getTransactionCount({ address, blockTag: 'latest' }), guard.pub.getTransactionCount({ address, blockTag: 'pending' })]);
        if (mined !== pending) throw new Error(`${address} has a pending transaction; record start nonces when idle`);
        nonces.set(address, mined);
      }
      a.startNonce = nonces.get(address)!;
    }
    wallets(plan);
    writeFileSync(path, JSON.stringify(plan, null, 2) + '\n');
    console.log(JSON.stringify(plan.accounts, null, 2));
    return 0;
  }
  const plan = loadApprovedPlan(path, arg('--approved-plan-hash'));
  const guard = new CanaryGuard(plan);
  const id = arg('--action')!;
  const action = plan.actions.find(a => a.id === id);
  if (!action) throw new Error(`unknown action ${id}`);
  if (!action.account || !plan.accounts[action.account]) throw new Error(`action ${id} names no plan account`);
  // The approved action's own gas limit and max fee: the transaction must be sent with exactly these.
  const c = await guard.check(id, { account: getAddress(plan.accounts[action.account].address), gas: BigInt(action.gasLimit), maxFeePerGas: BigInt(action.maxFeePerGas) });
  console.log(JSON.stringify({ action: id, account: action.account, gasLimit: action.gasLimit, maxFeePerGas: action.maxFeePerGas, ...fmt(c), remainingAfterWorstCaseWei: (c.budgetWei - c.totalWei).toString() }, null, 2));
  return c.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error((e as Error).message); process.exit(2); });
