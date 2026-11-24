import { getAddress, parseAbiItem, parseEther, type Address, type Hash, type Hex, type PublicClient } from 'viem';
import { fwaV2Abi, packManagerAbi, packManagerFactoryAbi, packVaultAbi } from '../../shared/main-pool-abi';
import { shapesAbi } from '../../shared/abi';
import { defaultManagerParams } from '../../shared/main-pool-defaults';
import { incrementalRange } from './ledger';

/** FWA main pool products (ripe0x/shapes-fwa-pool). Each is hidden while its address is unset. */
/** Launch switch: while false the main pool pages show their content but take no deposits or creations, and the app
 * lands on Community pools instead of Home. */
export const MAIN_POOL_OPEN = false;
export const MAIN_MANAGER_OPEN = false;
export const localMainPoolPreview = (chainId: number, requested: string | undefined) => chainId === 31337 && requested === 'true';
export const VAULT = (import.meta.env?.VITE_VAULT as string | undefined || undefined) as Address | undefined;
export const MANAGER_FACTORY = (import.meta.env?.VITE_MANAGER_FACTORY as string | undefined || undefined) as Address | undefined;
export function mainProductAccess(input: { chainId: number; vault?: Address; factory?: Address; vaultOpen: boolean; managerOpen: boolean; vaultPreview?: string; managerPreview?: string }) {
  return {
    visible: !!input.vault || !!input.factory,
    vault: !!input.vault && (input.vaultOpen || localMainPoolPreview(input.chainId, input.vaultPreview)),
    manager: !!input.factory && (input.managerOpen || localMainPoolPreview(input.chainId, input.managerPreview)),
  };
}
const access = mainProductAccess({ chainId: Number(import.meta.env?.VITE_CHAIN_ID ?? 1), vault: VAULT, factory: MANAGER_FACTORY,
  vaultOpen: MAIN_POOL_OPEN, managerOpen: MAIN_MANAGER_OPEN, vaultPreview: import.meta.env?.VITE_MAIN_POOL_PREVIEW,
  managerPreview: import.meta.env?.VITE_MAIN_MANAGER_PREVIEW });
export const MAIN_POOL_INTERACTIVE = access.vault;
export const MAIN_MANAGER_INTERACTIVE = access.manager;
export const MAIN_POOL_VISIBLE = access.visible;
export function mainTabForProducts<T extends 'overview' | 'vault' | 'manager'>(tab: T, vault: boolean, manager: boolean): T | 'vault' | 'manager' {
  return !vault && manager ? 'manager' : vault && !manager ? 'vault' : tab;
}
/** Block the manager factory was deployed in: manager discovery scans its events from here. */
export const MAIN_FROM_BLOCK = BigInt(import.meta.env?.VITE_MAIN_FROM_BLOCK as string | undefined ?? 0);

const SHAPES: Address = '0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0';
/** Selected launch defaults; account views determine the active recipe and charge reference. */
export const PACK_UNITS = 3n;
export const PACK_VALUE = parseEther('0.03');
const ACTIVE = 1, ALLOCATED = 2, OWED = 3;

export const GAS_FIELDS = ['checkpoint', 'allocationEntry', 'allocationRead', 'build', 'buildPack', 'buildShape', 'list', 'listed',
  'sync', 'requiredTail', 'distributionProof', 'journal', 'scan', 'selected', 'synced', 'pruned', 'unlist', 'unlisted', 'liquidate',
  'liquidatePack', 'redeemShape', 'recoveryBase', 'recoveryShape', 'recoveryUnseal', 'harvest', 'harvested', 'credit', 'fund'] as const;
export type GasSchedule = Record<(typeof GAS_FIELDS)[number], number>;
export interface Params {
  minEdgeBps: number; bufferBps: number; distributionBps: number; payMarkupBps: number; keeperShareBps: number; upliftBoundBps: number;
  packUnitsMask: bigint; gasCeiling: bigint; essentialCeiling: bigint; maxTip: bigint; workFee: bigint;
  routineCap: bigint; routineRate: bigint; essentialCap: bigint; essentialRate: bigint; reserve: bigint; tvlCap: bigint;
  backingRatioBps: number; renewalMode: number; renewalFloatCount: number; acceptedMintFee: bigint;
  minDeposit: bigint; minDistribution: bigint; gasSchedule: GasSchedule;
}
/** Exact defaults are exported with the ABI from the same main repository checkout. */
export const MANAGER_PARAMS: Params = defaultManagerParams;

// Events the strategy libraries emit by DELEGATECALL: they are logged by the account but absent from its ABI.
const PRIMARY_MINTED = parseAbiItem('event PrimaryMinted(uint256 packs, uint256 shapes, uint256 principal, uint256 mintFees)');
const KEEPER_PAID = parseAbiItem('event KeeperPaid(address indexed keeper, uint256 amount)');
const TOKENS_BURNED = parseAbiItem('event TokensBurned(uint256 amount)');
const POSITION_UPDATED = parseAbiItem('event PositionUpdated(uint256 indexed listingId, uint256 packId, uint256 value, uint256 backing, uint256 feeDebt, uint64 allocatedAt, uint8 state)');
const CASH_RECEIPT = parseAbiItem('event CashReceipt(uint256 indexed listingId, uint8 outcome, uint256 amount)');
const CHECKPOINT = parseAbiItem('event Checkpoint(uint256 indexed epoch, uint256 nav, uint256 supply, uint256 filledShares, uint256 paid, uint256 distributed)');
const WITHDRAWN = parseAbiItem('event Withdrawn(address indexed to, uint256 amount)');
const MANAGER_CREATED = parseAbiItem('event ManagerCreated(address indexed manager, address indexed owner, uint256 indexed index, uint256 funding)');
const OWNERSHIP_TRANSFERRED = parseAbiItem('event OwnershipTransferred(address indexed oldOwner, address indexed newOwner)');

type Pub = PublicClient;
/** Account logs from `from`, fetched once and then only past the last fetched block less a reorg window. */
type EventLog = { eventName?: string; blockNumber: bigint | null; args?: unknown };
export const HISTORY_BLOCKS_PER_READ = 2000n;
const logCache = new Map<string, { through: bigint; logs: EventLog[] }>();
export function historyRange(from: bigint, to: bigint) {
  return { fromBlock: from, toBlock: from + HISTORY_BLOCKS_PER_READ - 1n < to ? from + HISTORY_BLOCKS_PER_READ - 1n : to };
}
async function accountLogs(pub: Pub, address: Address, events: readonly unknown[], from: bigint, to: bigint): Promise<EventLog[]> {
  const key = `${pub.chain?.id}:${address.toLowerCase()}`;
  const cached = logCache.get(key);
  const range = incrementalRange(cached && cached.through > to ? to : cached?.through, from, 64n);
  const bounded = historyRange(range.from, to);
  const fresh = bounded.fromBlock <= bounded.toBlock ? await pub.getLogs({ address, events: events as never, ...bounded }) as unknown as EventLog[] : [];
  const logs = [...(cached?.logs.filter((l) => l.blockNumber! <= range.keepThrough) ?? []), ...fresh];
  logCache.set(key, { through: bounded.toBlock, logs });
  return logs;
}
const argsOf = <T,>(l: unknown) => (l as { args: T }).args;
const named = (logs: EventLog[], name: string) => logs.filter((l) => l.eventName === name);

/** Each refresh examines one bounded page to find a NAV witness, regardless of the position count. */
export const BOOK_PAGE_SIZE = 32n;
const bookPages = new Map<string, { next: bigint; witness?: bigint }>();
const renewalPages = new Map<string, bigint>();
export function bookPage(count: bigint, next = 0n) {
  const start = next < count ? next : 0n;
  const end = start + BOOK_PAGE_SIZE < count ? start + BOOK_PAGE_SIZE : count;
  return { indexes: Array.from({ length: Number(end - start) }, (_, i) => start + BigInt(i)), next: end < count ? end : 0n };
}
export function navWitnessCandidates(ids: bigint[], positions: { state: number; feeDebt: bigint }[]) {
  return ids.map((id, i) => ({ id, ...positions[i] })).filter((position) => position.state === ACTIVE)
    .sort((a, b) => a.feeDebt < b.feeDebt ? -1 : a.feeDebt > b.feeDebt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map((position) => position.id);
}

/** Aggregate book values never require a complete inventory scan. NAV is labelled unavailable until its proof succeeds. */
async function readBook(pub: Pub, address: Address, abi: typeof packVaultAbi | typeof packManagerAbi, fwa: Address, blockNumber: bigint) {
  const r = <T,>(functionName: string, args: unknown[] = []) =>
    pub.readContract({ address, abi, functionName: functionName as never, args: args as never, blockNumber }) as Promise<T>;
  const [totals, openCount, idlePacks, recoveryPacks, freeEth, credit, pendingReceipts] = await Promise.all([
    r<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>('totals'), r<bigint>('openListingCount'), r<bigint>('idlePackCount'),
    r<bigint>('recoveryPackCount'),
    r<bigint>('freeEth'), pub.readContract({ address: fwa, abi: fwaV2Abi, functionName: 'feeCredit', args: [address], blockNumber }),
    r<bigint>('pendingReceipts'),
  ]);
  const [tracked, idleValue, backing, activeCount, , allocated] = totals;
  const key = `${pub.chain?.id}:${address.toLowerCase()}`;
  const previous = bookPages.get(key);
  const page = bookPage(openCount, previous?.next);
  const ids = await Promise.all(page.indexes.map((i) => r<bigint>('openListingAt', [i])));
  const candidates = [...new Set([...(previous?.witness === undefined ? [] : [previous.witness]), ...ids])];
  const positions = await Promise.all(candidates.map((id) => r<{ state: number; feeDebt: bigint }>('position', [id])));
  let witness: bigint | undefined;
  let provenNav: bigint | undefined;
  // Lower fee debt avoids the zero-pending-fee witness when another listing has accrued fees.
  // Failed proofs are never cached; every candidate in this bounded page gets a chance.
  for (const id of activeCount === 0n ? [0n] : navWitnessCandidates(candidates, positions)) {
    try { provenNav = await r<bigint>('accountedNav', [id]); witness = id; break; }
    catch { /* The book may need reconciliation, or another fee witness. */ }
  }
  bookPages.set(key, { next: page.next, witness });
  const principal = freeEth + tracked + backing + credit;
  return {
    ids, openCount, credit, pendingReceipts, listed: Number(activeCount), bought: Number(openCount - activeCount), idle: Number(idlePacks), recovery: Number(recoveryPacks),
    tracked, idleValue, backing, freeEth, allocated, witness, navCurrent: provenNav !== undefined,
    nav: provenNav ?? principal, fees: provenNav === undefined ? credit : provenNav - freeEth - tracked - backing,
    // Allocated Shapes are known exactly; detailed position values are shown only in the bounded inventory page.
    inBought: allocated, inListed: backing,
  };
}

/** Display-only activity: absence of a callback is not proof of a bid. Accounting uses the contract's authenticated book. */
export function observedResolutions(updates: { listingId: bigint; state: number }[], keepReceipts: bigint[]) {
  const kept = new Set(keepReceipts.map(String));
  const selected = new Set<string>();
  let bids = 0;
  for (const u of updates) {
    const id = String(u.listingId);
    if (u.state === ALLOCATED) selected.add(id);
    else if (selected.has(id)) { selected.delete(id); if (!kept.has(id)) bids++; }
  }
  return { recordedKeeps: kept.size, otherResolved: bids };
}

export async function readAccountConfig(pub: Pub, address: Address, abi: typeof packVaultAbi | typeof packManagerAbi, blockNumber: bigint) {
  const r = <T,>(functionName: string, args: unknown[] = []) =>
    pub.readContract({ address, abi, functionName: functionName as never, args: args as never, blockNumber }) as Promise<T>;
  const [params, configHash, referenceUnits, referencePositionValue, owner, operatingReserve, renewalState, keeperCash, liveMintFee] = await Promise.all([
    r<Params>('getParams'), r<Hex>('configurationHash'), r<bigint>('referenceUnits'), r<bigint>('referencePositionValue'),
    r<Address>('owner'), r<bigint>('operatingReserve'),
    r<readonly [bigint, bigint, bigint, bigint]>('renewalState'),
    r<bigint>('keeperCash'),
    pub.readContract({ address: SHAPES, abi: shapesAbi, functionName: 'mintFee', blockNumber }),
  ]);
  const n = primaryMintCount(referenceUnits);
  const [edge, buildCost] = await Promise.all([
    r<readonly [bigint, bigint, boolean]>('edge', [referenceUnits]), r<bigint>('buildCost', [referenceUnits]),
  ]);
  let renewalPack: bigint | undefined = renewalState[1] > 0n ? 0n : undefined;
  let returnedPrincipal = 0n;
  if (renewalPack === undefined && renewalState[0] > 0n && params.renewalMode === 0 && params.packUnitsMask !== 0n) {
    const count = await r<bigint>('idlePackCount');
    const key = `${pub.chain?.id}:${address.toLowerCase()}`;
    const remembered = renewalPages.get(key);
    const end = remembered !== undefined && remembered > 0n && remembered <= count ? remembered : count;
    const start = end > BOOK_PAGE_SIZE ? end - BOOK_PAGE_SIZE : 0n;
    const ids = await Promise.all(Array.from({ length: Number(end - start) }, (_, i) => r<bigint>('idlePackAt', [end - BigInt(i) - 1n])));
    const eligible = await Promise.all(ids.map((id) => r<boolean>('renewalEligible', [id])));
    renewalPack = ids.find((_, i) => eligible[i]);
    renewalPages.set(key, renewalPack === undefined ? start : end);
    if (renewalPack !== undefined) returnedPrincipal = await r<bigint>('idleValueOf', [renewalPack]);
  }
  const minimumRenewalQuote = renewalPack !== undefined && params.renewalMode === 0 && params.packUnitsMask !== 0n
    ? await r<bigint>('renewalQuote', [renewalPack, 0n, false]) : 0n;
  const packValue = referenceUnits * parseEther('0.01');
  const targetBacking = edge[2] ? edge[1] : packValue * BigInt(params.backingRatioBps) / 10_000n / 10_000n * 10_000n;
  const renewalCost = packValue + targetBacking + n * liveMintFee + minimumRenewalQuote;
  const renewalCashRequired = renewalPack === undefined ? undefined : renewalCost > returnedPrincipal ? renewalCost - returnedPrincipal : 0n;
  return { params, configHash, referenceUnits, referencePositionValue, owner, operatingReserve, renewalState, keeperCash,
    minimumRenewalQuote, renewalCashRequired, renewalInventoryReady: renewalPack !== undefined,
    mintCount: n, mintFee: liveMintFee, packValue, buildCost, edge };
}

export type Vault = Awaited<ReturnType<typeof readVault>>;
export async function readVault(pub: Pub, vault: Address, me?: Address) {
  const block = await pub.getBlock();
  const blockNumber = block.number;
  const r = <T,>(functionName: string, args: unknown[] = []) =>
    pub.readContract({ address: vault, abi: packVaultAbi, functionName: functionName as never, args: args as never, blockNumber }) as Promise<T>;
  const fwa = await r<Address>('fwa');
  const [totalShares, lastNav, epoch, highWaterMark, depositsPaused, windingDown, pendingDepositTotal, lockedShares,
    redemptionReserve, claimableTotal, distributionReserve, lastCheckpointInterval, requestCharge, deployCharge, unwindCharge,
    budget, deploymentBlock, config] = await Promise.all([
    r<bigint>('totalShares'), r<bigint>('lastNav'), r<bigint>('epoch'), r<bigint>('highWaterMark'), r<boolean>('depositsPaused'),
    r<boolean>('windingDown'), r<bigint>('pendingDepositTotal'), r<bigint>('lockedShares'), r<bigint>('redemptionReserve'),
    r<bigint>('claimableTotal'), r<bigint>('distributionReserve'), r<bigint>('lastCheckpointInterval'), r<bigint>('requestCharge'),
    r<bigint>('deployCharge'), r<bigint>('unwindCharge'), r<readonly [bigint, bigint]>('budget'),
    r<bigint>('deploymentBlock'), readAccountConfig(pub, vault, packVaultAbi, blockNumber),
  ]);
  const book = await readBook(pub, vault, packVaultAbi, fwa, blockNumber);
  // The price of one share (1e18 units) at the last checkpoint; before the first, the seed's price.
  const pricePerShare = epoch > 0n && totalShares > 0n ? (lastNav * 10n ** 18n) / totalShares : highWaterMark;
  const logs = await accountLogs(pub, vault, [CHECKPOINT, KEEPER_PAID, TOKENS_BURNED, PRIMARY_MINTED], deploymentBlock, blockNumber);
  const checkpoints = named(logs, 'Checkpoint');
  const last = checkpoints[checkpoints.length - 1];
  const lastCheckpoint = last ? { block: last.blockNumber!, at: (await pub.getBlock({ blockNumber: last.blockNumber! })).timestamp } : undefined;
  const keeperPaySince = named(logs, 'KeeperPaid').filter((l) => !last || l.blockNumber! > last.blockNumber!)
    .reduce((t, l) => t + argsOf<{ amount: bigint }>(l).amount, 0n);
  const tokensBurned = named(logs, 'TokensBurned').reduce((t, l) => t + argsOf<{ amount: bigint }>(l).amount, 0n);
  return {
    vault, fwa, blockNumber, now: block.timestamp, totalShares, lastNav, epoch, highWaterMark, depositsPaused, windingDown,
    pendingDepositTotal, lockedShares, claims: redemptionReserve + claimableTotal + distributionReserve, lastCheckpointInterval,
    requestCharge, deployCharge, unwindCharge, ...config, budget, book, pricePerShare, lastCheckpoint, keeperPaySince, tokensBurned,
    historyComplete: logCache.get(`${pub.chain?.id}:${vault.toLowerCase()}`)?.through === blockNumber,
    actualMintFees: named(logs, 'PrimaryMinted').reduce((t, l) => t + argsOf<{ mintFees: bigint }>(l).mintFees, 0n),
    holder: me ? await readHolder(pub, vault, me, blockNumber, epoch) : undefined,
  };
}

/** Exact lazy holder settlement uses the contract's bounded view, without eth_simulateV1. */
async function readHolder(pub: Pub, vault: Address, me: Address, blockNumber: bigint, epoch: bigint) {
  const r = <T,>(functionName: string) =>
    pub.readContract({ address: vault, abi: packVaultAbi, functionName: functionName as never, args: [me] as never, blockNumber }) as Promise<T>;
  const [state, pending, wallet] = await Promise.all([
    r<readonly [bigint, bigint, bigint]>('holderState'), r<readonly [bigint, bigint]>('pendingDeposits'), pub.getBalance({ address: me, blockNumber }),
  ]);
  const [shares, redeeming, claimable] = state;
  return { shares, wallet, pendingDeposit: pending[0] !== 0n && pending[1] >= epoch ? pending[0] : 0n, redeeming, claimable };
}

/** Shares a deposit of `value` buys at `pricePerShare`, after the request and deployment charges (PackVault.deposit). */
export function depositShares(value: bigint, v: Pick<Vault, 'requestCharge' | 'deployCharge' | 'pricePerShare' | 'referencePositionValue'>) {
  if (value <= v.requestCharge || v.pricePerShare === 0n) return 0n;
  const net = value - v.requestCharge;
  const charge = (net * v.deployCharge) / (v.referencePositionValue + v.deployCharge);
  return ((net - charge) * 10n ** 18n) / v.pricePerShare;
}

/** ETH a redemption request must carry (PackVault.requestRedeem): the request charge plus the unwind charge on the
 *  shares' value at the last checkpoint. */
export function redeemCharge(shares: bigint, v: Pick<Vault, 'requestCharge' | 'unwindCharge' | 'lastNav' | 'totalShares' | 'referencePositionValue'>) {
  if (v.totalShares === 0n) return v.requestCharge;
  return v.requestCharge + (((shares * v.lastNav) / v.totalShares) * v.unwindCharge) / v.referencePositionValue;
}

export function vaultStatus(v: Pick<Vault, 'windingDown' | 'depositsPaused' | 'pendingDepositTotal' | 'lockedShares' | 'lastCheckpointInterval' | 'now'>) {
  if (v.windingDown) return { head: 'Winding down.', body: "The vault is returning every holder's share. Claims stay open." };
  if (v.depositsPaused) return { head: 'Deposits paused.', body: 'Redemptions and claims still work.' };
  const waiting = v.pendingDepositTotal > 0n || v.lockedShares > 0n;
  if (waiting && v.now / (12n * 3600n) > v.lastCheckpointInterval) return { head: 'Checkpoint due.', body: "Pricing runs in FWA's next quiet window." };
  return { head: 'Open.', body: 'Requests wait for an eligible quiet-window checkpoint. Settlement can delay pricing.' };
}

export const primaryMintCount = (units: bigint) => units / 10n + units % 10n / 5n + units % 5n;
export function renewalWaits(account: Pick<Manager, 'params' | 'mintFee' | 'renewalState' | 'budget' | 'minimumRenewalQuote'> & { renewalCashRequired?: bigint }) {
  const [returned, kept, float, cash] = account.renewalState;
  const freshPending = account.params.renewalMode === 0 && account.params.packUnitsMask !== 0n && returned + kept > 0n;
  return {
    feeNotAccepted: account.mintFee > account.params.acceptedMintFee,
    cashShort: freshPending && cash < (account.renewalCashRequired ?? float),
    allowanceTooSmall: freshPending && account.budget[0] < account.minimumRenewalQuote,
  };
}

/** ETH one more pack takes: its Shapes, the backing it posts and the work of building and listing it. */
export const packCost = (value: bigint, backing: bigint, buildCost: bigint) => value + backing + buildCost;
export const packsFor = (eth: bigint, reserve: bigint, cost: bigint) => (cost > 0n && eth > reserve ? (eth - reserve) / cost : 0n);

export type Manager = Awaited<ReturnType<typeof readManager>>;
export async function readManager(pub: Pub, manager: Address) {
  const block = await pub.getBlock();
  const blockNumber = block.number;
  const r = <T,>(functionName: string, args: unknown[] = []) =>
    pub.readContract({ address: manager, abi: packManagerAbi, functionName: functionName as never, args: args as never, blockNumber }) as Promise<T>;
  const fwa = await r<Address>('fwa');
  const [listingPaused, exiting, budget, deploymentBlock, config] = await Promise.all([
    r<boolean>('listingPaused'), r<boolean>('windingDown'), r<readonly [bigint, bigint]>('budget'),
    r<bigint>('deploymentBlock'), readAccountConfig(pub, manager, packManagerAbi, blockNumber),
  ]);
  const book = await readBook(pub, manager, packManagerAbi, fwa, blockNumber);
  const logs = await accountLogs(pub, manager, [POSITION_UPDATED, CASH_RECEIPT, KEEPER_PAID, TOKENS_BURNED, WITHDRAWN, PRIMARY_MINTED], deploymentBlock, blockNumber);
  const updates = named(logs, 'PositionUpdated').map((l) => argsOf<{ listingId: bigint; state: number }>(l));
  const keeps = named(logs, 'CashReceipt').map((l) => argsOf<{ listingId: bigint; outcome: number }>(l)).filter((a) => a.outcome === 1).map((a) => a.listingId);
  const total = (name: string) => named(logs, name).reduce((t, l) => t + argsOf<{ amount: bigint }>(l).amount, 0n);
  return {
    manager, fwa, blockNumber, listingPaused, exiting, ...config, budget, book, balance: book.freeEth,
    historyComplete: logCache.get(`${pub.chain?.id}:${manager.toLowerCase()}`)?.through === blockNumber,
    actualMintFees: named(logs, 'PrimaryMinted').reduce((t, l) => t + argsOf<{ mintFees: bigint }>(l).mintFees, 0n),
    ...observedResolutions(updates, keeps), keeperPay: total('KeeperPaid'), tokensBurned: total('TokensBurned'), withdrawn: total('Withdrawn'),
  };
}

/** `cost` is one more pack's ETH (`packCost`), undefined when unknown. */
export function managerStatus(m: Pick<Manager, 'exiting' | 'listingPaused' | 'edge' | 'book' | 'balance' | 'operatingReserve' | 'params'>, cost: bigint | undefined) {
  if (m.exiting) return { head: 'Exiting.', body: 'Review owner-paid closeout steps below. FWA settlement can require waiting.' };
  if (m.listingPaused) return { head: 'Listing paused.', body: 'Listed packs stay listed. New packs are not built.' };
  if (m.params.packUnitsMask === 0n) return { head: 'Fresh minting disabled.', body: 'Existing unselected packs may still be relisted. Withdrawals remain available.' };
  if (!m.edge[2]) return { head: 'New investment paused.', body: "FWA conditions don't allow new packs right now. Withdrawals still work." };
  const need = cost === undefined ? 0n : cost + m.operatingReserve;
  if (m.book.listed === 0 && m.book.idle === 0 && cost !== undefined && m.balance < need) {
    return { head: 'Not enough ETH to list.', body: `Add at least ${trim(need - m.balance)} ETH to build a pack.`, short: need - m.balance };
  }
  return { head: 'Listing.', body: `${m.book.listed} pack${m.book.listed === 1 ? '' : 's'} on FWA's main pool. Account settings govern further work.` };
}
const trim = (wei: bigint) => (Number(wei) / 1e18).toFixed(4).replace(/\.?0+$/, '');

/** Factory discovery advances by at most 32 managers per refresh; it never scans the full factory in one call. */
const managerPages = new Map<string, { next: bigint; owned: Set<Address> }>();
const managerLogPages = new Map<string, { through: bigint; logs: Awaited<ReturnType<Pub['getLogs']>> }>();
export async function findManagers(pub: Pub, factory: Address, me: Address) {
  const blockNumber = await pub.getBlockNumber();
  const key = `${pub.chain?.id}:${factory.toLowerCase()}:${me.toLowerCase()}`;
  const previous = managerPages.get(key);
  const count = await pub.readContract({ address: factory, abi: packManagerFactoryAbi, functionName: 'managerCount', blockNumber });
  const page = bookPage(count, previous?.next);
  const pageManagers = await Promise.all(page.indexes.map((i) => pub.readContract({ address: factory, abi: packManagerFactoryAbi, functionName: 'managerAt', args: [i], blockNumber })));
  const owners = await Promise.all(pageManagers.map((m) => pub.readContract({ address: m, abi: packManagerAbi, functionName: 'owner', blockNumber })));
  const owned = new Set(previous?.owned);
  pageManagers.forEach((m, i) => { if (owners[i].toLowerCase() === me.toLowerCase()) owned.add(getAddress(m)); else owned.delete(getAddress(m)); });
  managerPages.set(key, { next: page.next, owned });
  const cached = managerLogPages.get(key);
  const range = incrementalRange(cached?.through, MAIN_FROM_BLOCK, 64n);
  const bounded = historyRange(range.from, blockNumber);
  const fresh = await pub.getLogs({ address: factory, event: MANAGER_CREATED, args: { owner: me }, ...bounded });
  const logs = [...(cached?.logs.filter((l) => l.blockNumber! <= range.keepThrough) ?? []), ...fresh];
  managerLogPages.set(key, { through: bounded.toBlock, logs });
  return { managers: [...owned], created: logs as typeof fresh, discoveryPending: count > BOOK_PAGE_SIZE && page.next !== 0n };
}

export async function previewManager(pub: Pub, factory: Address, params: Params) {
  const block = await pub.getBlock();
  const [preview, mintFee] = await Promise.all([
    pub.readContract({ address: factory, abi: packManagerFactoryAbi, functionName: 'preview' as never, args: [params] as never, blockNumber: block.number }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint, Hex]>,
    pub.readContract({ address: SHAPES, abi: shapesAbi, functionName: 'mintFee', blockNumber: block.number }),
  ]);
  const [units, principal, backing, mintCost, floatRequired, openingCash, configHash] = preview;
  return { units, principal, backing, mintCost, floatRequired, openingCash, configHash, mintFee, blockNumber: block.number };
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
