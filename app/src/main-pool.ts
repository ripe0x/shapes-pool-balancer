import { decodeEventLog, getAddress, parseAbi, parseAbiItem, parseEther, type Address, type Hash, type PublicClient } from 'viem';
import { simulateCalls } from 'viem/actions';
import { fwaV2Abi, packManagerAbi, packManagerFactoryAbi, packVaultAbi } from '../../shared/main-pool-abi';
import { shapesAbi } from '../../shared/abi';
import { incrementalRange } from './ledger';
import { decodeMix, sizesOf } from '../../shared/manager-design';

/** FWA main pool products (ripe0x/shapes-fwa-pool). Each is hidden while its address is unset. */
/** Launch switch: while false the main pool pages show their content but take no deposits or creations, and the app
 * lands on Community pools instead of Home. */
export const MAIN_POOL_OPEN = false;
export const VAULT = (import.meta.env?.VITE_VAULT as string | undefined || undefined) as Address | undefined;
export const MANAGER_FACTORY = (import.meta.env?.VITE_MANAGER_FACTORY as string | undefined || undefined) as Address | undefined;
/** Block the manager factory was deployed in: manager discovery scans its events from here. */
export const MAIN_FROM_BLOCK = BigInt(import.meta.env?.VITE_MAIN_FROM_BLOCK as string | undefined ?? 0);

const SHAPES: Address = '0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0';
export const FWA: Address = '0x958C41181182e76F221331b2755b77D9e1426A98';

/** The main pool's total listing weight and its draw price (FWA acquisitionFee). */
export async function readMainPool(pub: Pub, fwa: Address = FWA, blockNumber?: bigint) {
  const r = (functionName: 'totalWeight' | 'acquisitionFee') => pub.readContract({ address: fwa, abi: fwaV2Abi, functionName, blockNumber }) as Promise<bigint>;
  const [totalWeight, drawPrice] = await Promise.all([r('totalWeight'), r('acquisitionFee')]);
  return { totalWeight, drawPrice };
}
/** VaultLib constants: the reference pack (one 0.05 and one 0.01 ETH Shape) and the position value charges scale by. */
export const PACK_UNITS = 6n;
export const PACK_VALUE = parseEther('0.06');
export const POSITION_VALUE = parseEther('0.1248');
/** PackVault.MIN_DEPOSIT: deposits must carry at least this plus the request charge. */
export const MIN_DEPOSIT = parseEther('0.01');
const ACTIVE = 1, ALLOCATED = 2, OWED = 3;

/** deploy/manager.json in shapes-fwa-pool: the default PackManagerFactory.create parameters. The designer sets
 *  packUnitsMask from the chosen mix. */
export const MANAGER_PARAMS = {
  minEdgeBps: 100, distributionBps: 0, keeperShareBps: 2500, upliftBoundBps: 25,
  packUnitsMask: 8n, gasCeiling: 500000000n, essentialCeiling: 500000000n, maxTip: 50000000n,
  workFee: 20000000000000n, routineCap: 30000000000000000n, routineRate: 10000000000000000n,
  reserve: 6000000000000000n, tvlCap: 0n,
  backingRatioBps: 11053, acceptedMintFee: 500000000000000n, minDeposit: 10000000000000000n,
  minDistribution: 10000000000000000n,
  gasSchedule: { checkpoint: 500000, allocationEntry: 6000, allocationRead: 30000, build: 540000, buildPack: 300000, buildShape: 130000, list: 380000, listed: 825000, sync: 125000, requiredTail: 120000, distributionProof: 80000, journal: 22000, scan: 30000, selected: 225000, synced: 285000, pruned: 45000, unlist: 340000, unlisted: 285000, harvested: 80000, credit: 40000, fund: 40000, overhead: 50000 },
} as const;

// Events the strategy libraries emit by DELEGATECALL: they are logged by the account but absent from its ABI.
const KEEPER_PAID = parseAbiItem('event KeeperPaid(address indexed keeper, uint256 amount)');
const TOKENS_BURNED = parseAbiItem('event TokensBurned(uint256 amount)');
const POSITION_UPDATED = parseAbiItem('event PositionUpdated(uint256 indexed listingId, uint256 packId, uint256 value, uint256 backing, uint256 feeDebt, uint64 allocatedAt, uint8 state)');
const CASH_RECEIPT = parseAbiItem('event CashReceipt(uint256 indexed listingId, uint8 outcome, uint256 amount)');
const CHECKPOINT = parseAbiItem('event Checkpoint(uint256 indexed epoch, uint256 nav, uint256 supply, uint256 filledShares, uint256 paid, uint256 distributed)');
const WITHDRAWN = parseAbiItem('event Withdrawn(address indexed to, uint256 amount)');
const MANAGER_CREATED = parseAbiItem('event ManagerCreated(address indexed manager, address indexed owner, uint256 indexed index, uint256 funding)');
const OWNERSHIP_TRANSFERRED = parseAbiItem('event OwnershipTransferred(address indexed oldOwner, address indexed newOwner)');
const claimedAbi = parseAbi(['event Claimed(address indexed holder, uint256 amount)']);

type Pub = PublicClient;
type Params = { reserve: bigint; tvlCap: bigint; gasCeiling: bigint; essentialCeiling: bigint; workFee: bigint; minEdgeBps: number;
  routineCap: bigint; routineRate: bigint; maxTip: bigint; packUnitsMask: bigint; backingRatioBps: number };

/** Account logs from `from`, fetched once and then only past the last fetched block less a reorg window. */
type EventLog = { eventName?: string; blockNumber: bigint | null; args?: unknown };
const logCache = new Map<string, { through: bigint; logs: EventLog[] }>();
async function accountLogs(pub: Pub, address: Address, events: readonly unknown[], from: bigint, to: bigint): Promise<EventLog[]> {
  const key = `${pub.chain?.id}:${address.toLowerCase()}`;
  const cached = logCache.get(key);
  if (cached && cached.through >= to) return cached.logs.filter((l) => l.blockNumber! <= to);
  const range = incrementalRange(cached?.through, from, 64n);
  const fresh = await pub.getLogs({ address, events: events as never, fromBlock: range.from, toBlock: to }) as unknown as EventLog[];
  const logs = [...(cached?.logs.filter((l) => l.blockNumber! <= range.keepThrough) ?? []), ...fresh];
  logCache.set(key, { through: to, logs });
  return logs;
}
const argsOf = <T,>(l: unknown) => (l as { args: T }).args;
const named = (logs: EventLog[], name: string) => logs.filter((l) => l.eventName === name);

/** The account's book at `blockNumber`: open positions by state, idle packs, and the NAV terms of SYSTEM-MAP.md. */
async function readBook(pub: Pub, address: Address, abi: typeof packVaultAbi | typeof packManagerAbi, fwa: Address, blockNumber: bigint) {
  const r = <T,>(functionName: string, args: unknown[] = []) =>
    pub.readContract({ address, abi, functionName: functionName as never, args: args as never, blockNumber }) as Promise<T>;
  const [totals, openCount, idlePacks, freeEth, credit] = await Promise.all([
    r<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>('totals'), r<bigint>('openListingCount'), r<bigint>('idlePackCount'),
    r<bigint>('freeEth'),
    pub.readContract({ address: fwa, abi: fwaV2Abi, functionName: 'feeCredit', args: [address], blockNumber }),
  ]);
  const ids = await Promise.all(Array.from({ length: Number(openCount) }, (_, i) => r<bigint>('openListingAt', [BigInt(i)])));
  const positions = await Promise.all(ids.map((id) => r<{ packId: bigint; value: bigint; backing: bigint; state: number }>('position', [id])));
  const fees = await Promise.all(ids.map((id, i) => positions[i].state === ACTIVE
    ? pub.readContract({ address: fwa, abi: fwaV2Abi, functionName: 'pendingFees', args: [id], blockNumber })
    : Promise.resolve(0n)));
  const [tracked, , backing, activeCount, , allocated] = totals;
  const pendingFees = fees.reduce((a, b) => a + b, 0n);
  const sum = (state: number, f: (p: (typeof positions)[number]) => bigint) => positions.filter((p) => p.state === state).reduce((a, p) => a + f(p), 0n);
  return {
    ids, positions: ids.map((id, i) => ({ id, ...positions[i] })), active: positions.filter((p) => p.state === ACTIVE), listed: Number(activeCount), bought: positions.filter((p) => p.state === ALLOCATED || p.state === OWED).length, idle: Number(idlePacks),
    inListed: sum(ACTIVE, (p) => p.value + p.backing), inBought: sum(ALLOCATED, (p) => p.value) + sum(OWED, (p) => p.value),
    // NAV = free ETH + tracked Shapes backing + active FWA backing + pending active fees + live FWA fee credit.
    freeEth, tracked, backing, fees: pendingFees + credit, allocated, nav: freeEth + tracked + backing + pendingFees + credit,
  };
}

/** Lifetime keep and bid outcomes from position events: a selection (Allocated) resolves either by a keep receipt
 *  or by the pack coming back. */
export function outcomes(updates: { listingId: bigint; state: number }[], keepReceipts: bigint[]) {
  const kept = new Set(keepReceipts.map(String));
  const selected = new Set<string>();
  let bids = 0;
  for (const u of updates) {
    const id = String(u.listingId);
    if (u.state === ALLOCATED) selected.add(id);
    else if (selected.has(id)) { selected.delete(id); if (!kept.has(id)) bids++; }
  }
  return { keeps: kept.size, bids };
}

export type Vault = Awaited<ReturnType<typeof readVault>>;
export async function readVault(pub: Pub, vault: Address, me?: Address) {
  const block = await pub.getBlock();
  const blockNumber = block.number;
  const r = <T,>(functionName: string, args: unknown[] = []) =>
    pub.readContract({ address: vault, abi: packVaultAbi, functionName: functionName as never, args: args as never, blockNumber }) as Promise<T>;
  const fwa = await r<Address>('fwa');
  const [totalShares, lastNav, epoch, highWaterMark, depositsPaused, windingDown, pendingDepositTotal, lockedShares,
    redemptionReserve, claimableTotal, distributionReserve, lastCheckpointInterval, requestCharge, deployCharge,
    params, budget, deploymentBlock, edge] = await Promise.all([
    r<bigint>('totalShares'), r<bigint>('lastNav'), r<bigint>('epoch'), r<bigint>('highWaterMark'), r<boolean>('depositsPaused'),
    r<boolean>('windingDown'), r<bigint>('pendingDepositTotal'), r<bigint>('lockedShares'), r<bigint>('redemptionReserve'),
    r<bigint>('claimableTotal'), r<bigint>('distributionReserve'), r<bigint>('lastCheckpointInterval'), r<bigint>('requestCharge'),
    r<bigint>('deployCharge'), r<Params>('getParams'), r<bigint>('budget'),
    r<bigint>('deploymentBlock'), r<readonly [bigint, bigint, boolean]>('edge', [PACK_UNITS]),
  ]);
  const book = await readBook(pub, vault, packVaultAbi, fwa, blockNumber);
  // The price of one share (1e18 units) at the last checkpoint; before the first, the seed's price.
  const pricePerShare = epoch > 0n && totalShares > 0n ? (lastNav * 10n ** 18n) / totalShares : highWaterMark;
  const logs = await accountLogs(pub, vault, [CHECKPOINT, KEEPER_PAID, TOKENS_BURNED], deploymentBlock, blockNumber);
  const checkpoints = named(logs, 'Checkpoint');
  const last = checkpoints[checkpoints.length - 1];
  const lastCheckpoint = last ? { block: last.blockNumber!, at: (await pub.getBlock({ blockNumber: last.blockNumber! })).timestamp } : undefined;
  const keeperPaySince = named(logs, 'KeeperPaid').filter((l) => !last || l.blockNumber! > last.blockNumber!)
    .reduce((t, l) => t + argsOf<{ amount: bigint }>(l).amount, 0n);
  const tokensBurned = named(logs, 'TokensBurned').reduce((t, l) => t + argsOf<{ amount: bigint }>(l).amount, 0n);
  return {
    vault, fwa, blockNumber, now: block.timestamp, totalShares, lastNav, epoch, highWaterMark, depositsPaused, windingDown,
    pendingDepositTotal, lockedShares, claims: redemptionReserve + claimableTotal + distributionReserve, lastCheckpointInterval,
    requestCharge, deployCharge, params, budget, edge, book, pricePerShare, lastCheckpoint, keeperPaySince, tokensBurned,
    holder: me ? await readHolder(pub, vault, me, blockNumber, epoch) : undefined,
  };
}

/** One holder's position. Redemption fills and distributions settle lazily, so `claim` is simulated: its Claimed event
 *  is the exact amount ready, and the redemption left after it is what still waits. */
async function readHolder(pub: Pub, vault: Address, me: Address, blockNumber: bigint, epoch: bigint) {
  const r = <T,>(functionName: string) =>
    pub.readContract({ address: vault, abi: packVaultAbi, functionName: functionName as never, args: [me] as never, blockNumber }) as Promise<T>;
  const [shares, pending, stored, wallet] = await Promise.all([
    r<bigint>('shareBalance'), r<readonly [bigint, number, bigint, number]>('pendingDeposits'),
    r<readonly [bigint, bigint, bigint, bigint]>('redemptions'), pub.getBalance({ address: me, blockNumber }),
  ]);
  const settled = await simulateCalls(pub, { account: me, blockNumber, calls: [
    { to: vault, abi: packVaultAbi, functionName: 'claim' },
    { to: vault, abi: packVaultAbi, functionName: 'redemptions', args: [me] },
  ] }).then(({ results: [claim, after] }) => {
    const log = claim.status === 'success' ? claim.logs?.find((l) => l.address.toLowerCase() === vault.toLowerCase()) : undefined;
    const claimable = log ? (decodeEventLog({ abi: claimedAbi, ...log }).args as { amount: bigint }).amount : 0n;
    const waiting = after.status === 'success' ? (after.result as readonly [bigint, bigint, bigint, bigint])[0] : undefined;
    return { claimable, redeeming: waiting };
  }).catch(() => ({ claimable: undefined, redeeming: undefined }));
  return {
    shares, wallet,
    // A deposit counts as waiting until the checkpoint that prices it; after that it is part of `shares`.
    pendingDeposit: pending[0] !== 0n && BigInt(pending[1]) >= epoch ? pending[0] : 0n,
    redeeming: settled.redeeming ?? stored[0], claimable: settled.claimable,
  };
}

/** Shares a deposit of `value` buys at `pricePerShare`, after the request and deployment charges (PackVault.deposit). */
export function depositShares(value: bigint, v: Pick<Vault, 'requestCharge' | 'deployCharge' | 'pricePerShare'>) {
  if (value <= v.requestCharge || v.pricePerShare === 0n) return 0n;
  const net = value - v.requestCharge;
  const charge = (net * v.deployCharge) / (POSITION_VALUE + v.deployCharge);
  return ((net - charge) * 10n ** 18n) / v.pricePerShare;
}

export function vaultStatus(v: Pick<Vault, 'windingDown' | 'depositsPaused' | 'pendingDepositTotal' | 'lockedShares' | 'lastCheckpointInterval' | 'now'>) {
  if (v.windingDown) return { head: 'Winding down.', body: "The vault is returning every holder's share. Claims stay open." };
  if (v.depositsPaused) return { head: 'Deposits paused.', body: 'Redemptions and claims still work.' };
  const waiting = v.pendingDepositTotal > 0n || v.lockedShares > 0n;
  if (waiting && v.now / (12n * 3600n) > v.lastCheckpointInterval) return { head: 'Checkpoint due.', body: "Pricing runs in FWA's next quiet window." };
  return { head: 'Open.', body: 'The next checkpoint, within 12 h, prices deposits and redemptions.' };
}

/** ETH one more pack takes: its Shapes, the backing it posts and the work of building and listing it. */
export const packCost = (backing: bigint, deployCharge: bigint) => PACK_VALUE + backing + deployCharge;
export const packsFor = (eth: bigint, reserve: bigint, cost: bigint) => (cost > 0n && eth > reserve ? (eth - reserve) / cost : 0n);

export type Manager = Awaited<ReturnType<typeof readManager>>;
export async function readManager(pub: Pub, manager: Address) {
  const block = await pub.getBlock();
  const blockNumber = block.number;
  const r = <T,>(functionName: string, args: unknown[] = []) =>
    pub.readContract({ address: manager, abi: packManagerAbi, functionName: functionName as never, args: args as never, blockNumber }) as Promise<T>;
  const fwa = await r<Address>('fwa');
  const [owner, listingPaused, exiting, params, budget, edge, deploymentBlock, mintFee] = await Promise.all([
    r<Address>('owner'), r<boolean>('listingPaused'), r<boolean>('windingDown'), r<Params>('getParams'),
    r<bigint>('budget'), r<readonly [bigint, bigint, boolean]>('edge', [PACK_UNITS]), r<bigint>('deploymentBlock'),
    pub.readContract({ address: SHAPES, abi: shapesAbi, functionName: 'mintFee', blockNumber }) as Promise<bigint>,
  ]);
  const book = await readBook(pub, manager, packManagerAbi, fwa, blockNumber);
  const design = await r<bigint>('design');
  const pool = await readMainPool(pub, fwa, blockNumber);
  const held = Object.fromEntries(await Promise.all(sizesOf(decodeMix(design)).map(async (u) => [u, Number(await r<bigint>('recipeCount', [BigInt(u)]))] as const)));
  const logs = await accountLogs(pub, manager, [POSITION_UPDATED, CASH_RECEIPT, KEEPER_PAID, TOKENS_BURNED, WITHDRAWN], deploymentBlock, blockNumber);
  const updates = named(logs, 'PositionUpdated').map((l) => argsOf<{ listingId: bigint; state: number }>(l));
  const keeps = named(logs, 'CashReceipt').map((l) => argsOf<{ listingId: bigint; outcome: number }>(l)).filter((a) => a.outcome === 1).map((a) => a.listingId);
  const total = (name: string) => named(logs, name).reduce((t, l) => t + argsOf<{ amount: bigint }>(l).amount, 0n);
  return {
    manager, owner, blockNumber, pool, listingPaused, exiting, params, budget, edge, mintFee, book, balance: book.freeEth, design, held,
    ...outcomes(updates, keeps), keeperPay: total('KeeperPaid'), tokensBurned: total('TokensBurned'), withdrawn: total('Withdrawn'),
  };
}

/** `cost` is one more pack's ETH (`packCost`), undefined when unknown. */
/** `target`: packs below the owner's counts and the ETH short of building them with the reserve, when counts are set. */
export function managerStatus(m: Pick<Manager, 'exiting' | 'listingPaused' | 'edge' | 'book' | 'balance' | 'params'>, cost: bigint | undefined,
  target?: { missing: number; short: bigint }) {
  if (m.exiting) return { head: 'Exiting.', body: 'Packs are being unlisted and turned back into ETH.' };
  if (m.listingPaused) return { head: 'Listing paused.', body: 'Listed packs stay listed. New packs are not built.' };
  if (!m.edge[2]) return { head: 'New investment paused.', body: "FWA conditions don't allow new packs right now. Withdrawals still work." };
  const need = cost === undefined ? 0n : cost + m.params.reserve;
  if (m.book.listed === 0 && m.book.idle === 0 && cost !== undefined && m.balance < need) {
    return { head: 'Not enough ETH to list.', body: `Add at least ${trim(need - m.balance)} ETH to build a pack.`, short: need - m.balance };
  }
  if (target && target.missing > 0) {
    const packs = `${target.missing} pack${target.missing === 1 ? '' : 's'}`;
    return target.short > 0n
      ? { head: 'Not enough ETH.', body: `${packs} in your target ${target.missing === 1 ? "isn't" : "aren't"} built. Add ${trim(target.short)} ETH or lower the counts.`, short: target.short }
      : { head: 'Building.', body: `${packs} in your target ${target.missing === 1 ? 'is' : 'are'} funded and wait for the next keeper run.` };
  }
  return { head: 'Listing.', body: `${m.book.listed} pack${m.book.listed === 1 ? '' : 's'} on FWA's main pool. Nothing needs attention.` };
}
const trim = (wei: bigint) => (Number(wei) / 1e18).toFixed(4).replace(/\.?0+$/, '');

/** Managers `me` owns: created for it or handed over to it, confirmed on chain (isManager and owner()). */
export async function findManagers(pub: Pub, factory: Address, me: Address) {
  const all = await pub.getLogs({ address: factory, event: MANAGER_CREATED, fromBlock: MAIN_FROM_BLOCK });
  const managers = all.map((l) => l.args.manager!);
  const received = managers.length ? await pub.getLogs({ address: managers, event: OWNERSHIP_TRANSFERRED, args: { newOwner: me }, fromBlock: MAIN_FROM_BLOCK }) : [];
  // initialize() emits OwnershipTransferred(0, owner) too; log addresses are lowercase, so dedupe by checksum.
  const candidates = [...new Set([...all.filter((l) => l.args.owner?.toLowerCase() === me.toLowerCase()).map((l) => l.args.manager!),
    ...received.map((l) => l.address)].map((a) => getAddress(a)))];
  const owned = await Promise.all(candidates.map(async (m) => {
    const [ours, owner] = await Promise.all([
      pub.readContract({ address: factory, abi: packManagerFactoryAbi, functionName: 'isManager', args: [m] }),
      pub.readContract({ address: m, abi: packManagerAbi, functionName: 'owner' }),
    ]).catch(() => [false, undefined] as const);
    return ours && owner?.toLowerCase() === me.toLowerCase() ? m : undefined;
  }));
  return { managers: owned.filter(Boolean) as Address[], created: all };
}

/** A manager creation sent from this browser, kept until its outcome is known so a reload resumes it. */
export interface ManagerCreation { chainId: number; factory: Address; owner: Address; value: string; fromBlock: string; since: number; hash?: Hash; nonce?: number }
const CREATION_KEY = 'manager-creation';
export const loadManagerCreation = (): ManagerCreation | undefined => { try { return JSON.parse(localStorage.getItem(CREATION_KEY) ?? 'null') ?? undefined; } catch { return undefined; } };
/** Throws when storage fails: the wallet must not open for a creation this page could not resume. */
export const saveManagerCreation = (c: ManagerCreation) => localStorage.setItem(CREATION_KEY, JSON.stringify(c));
export const clearManagerCreation = () => { try { localStorage.removeItem(CREATION_KEY); } catch { /* storage unavailable */ } };

export type CreationState = { state: 'created'; manager: Address } | { state: 'pending' } | { state: 'failed'; reason: string } | { state: 'unknown' };
/** Decide a saved creation from what the chain shows: a ManagerCreated for this owner and amount since it was saved,
 *  else the sent transaction's receipt. A transaction never seen keeps the outcome unknown for a day. */
export function creationState(c: ManagerCreation, facts: { created?: Address; receipt?: 'success' | 'reverted'; seen: boolean; nonceUsed: boolean; now: number }): CreationState {
  if (facts.created) return { state: 'created', manager: facts.created };
  if (facts.receipt === 'reverted') return { state: 'failed', reason: 'Creation reverted. Nothing was created.' };
  if (facts.receipt === 'success') return { state: 'unknown' };
  if (c.hash && facts.nonceUsed && !facts.seen) return { state: 'failed', reason: 'Creation was replaced or cancelled in your wallet.' };
  if (c.hash || facts.now - c.since < 24 * 3600 * 1000) return c.hash ? { state: 'pending' } : { state: 'unknown' };
  return { state: 'failed', reason: 'No creation was seen within a day.' };
}

export async function checkCreation(pub: Pub, c: ManagerCreation, created: Awaited<ReturnType<typeof findManagers>>['created']): Promise<CreationState> {
  const match = created.find((l) => l.args.owner?.toLowerCase() === c.owner.toLowerCase() && l.args.funding === BigInt(c.value)
    && l.blockNumber! >= BigInt(c.fromBlock));
  const tx = c.hash ? await pub.getTransaction({ hash: c.hash }).catch((e: Error) => {
    if (e.name === 'TransactionNotFoundError') return undefined;
    throw e;
  }) : undefined;
  const receipt = tx?.blockNumber != null ? (await pub.getTransactionReceipt({ hash: c.hash! })).status : undefined;
  // A transaction the node no longer shows whose nonce the account has since used was replaced or cancelled.
  const nonceUsed = !!c.hash && !tx && c.nonce !== undefined && (await pub.getTransactionCount({ address: c.owner, blockTag: 'latest' })) > c.nonce;
  return creationState(c, { created: match?.args.manager, receipt, seen: !!tx, nonceUsed, now: Date.now() });
}
