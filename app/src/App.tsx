import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useConnect, usePublicClient, useSendTransaction, useWriteContract } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { formatEther, formatGwei, parseAbi, parseAbiItem, parseEther, type Address, type Hash, type Hex } from 'viem';
import { normalize } from 'viem/ens';
import { balancerFactoryAbi, erc721Abi, fwaPoolAbi, poolBalancerAbi, shapesAbi } from '../../shared/abi';
import {
  BY_VALUE, DENOMS, MAX_BATCH, capitalOf, economics, evaluate, packPlan, requiredReserveAt, reserveBreakdownAt, pendingDrawsAdmitted, prizeLabel, shapeCount, suggestedCreatorRevenueBps, unpackPlan, type Counts,
} from '../../shared/planner';
import { BIG_WIN_SHARE, JACKPOT_MULTIPLE, ethNeeded, mixOf, playerView, presetCounts, presetMaxSmall, type DesignInputs, type Style } from '../../shared/design';
import { APP_NAME, chain, FACTORY, FROM_BLOCK, FWA_POOL_URL } from './chain';
import { confirmAction, prepareTransfer, prepareWrite, reviewedIntent, runTransactionSteps, transferKey, transferState, type PendingTransfer, type TransactionIntent, type TransactionStep } from './tx';
import { incrementalRange, poolEthLedger } from './ledger';
import { canRetryCreation, creationContextMatches, creationStatus, recoverCreation, sameCreation, sameSubmission, submitCreation, waitForCreation, type CreationAttempt, type CreationOutcome } from './creation';
import { explain } from './errors';
import { HowItWorks, HowItWorksMain } from './HowItWorks';
import { Home, MainPool, mainTabFor, type MainTab } from './MainPool';
import { MAIN_POOL_OPEN, VAULT } from './main-pool';
import { maxPaymentOf, maxSurchargeOf, policyEconomics, type Economics } from './policy';
import { activationBatch, curatedWitness, isHeld, isSelectable, isStaged, listedShapeCounts } from './inventory';
import { collectionTokens, nftImage, openSeaAsset, walletCollections, type Collection, type WalletNft } from './wallet';
import { applyRefreshEvent, createLatestRefresh, type RefreshState } from './refresh';
import { AutomaticPauses, LegacyKeeperPay, LegacyTag, LimitsNote, Maintenance, SRow, poolGeneration, readKeeper, readProductLimits } from './PoolSettings';
import { FILL_GATE_DEFAULT_BPS, INITIAL_LIMITS, markupAllowed, markupSliderRange, prizeLimit, refillPerDay } from './limits';
import { LEGACY_FACTORIES, legacyEconomics, legacyFactory } from '../../shared/legacy';

const SHAPES: Address = '0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0';
const FWA_FACTORY: Address = '0x8919814D825a5Af238cC04DE06b1C18c9eaA477C';
const fwaActivationAbi = parseAbi(['function activateListings(uint256 maxCount)']);
const fwaFactoryAbi = parseAbi(['function edgeBps() view returns (uint16)', 'function poolCreationEnabled() view returns (bool)', 'function implementation() view returns (address)']);
const CREATED = parseAbiItem('event BalancerCreated(address indexed creator, address indexed balancer, address indexed pool, bytes32 salt)');
const CREATOR_TRANSFERRED = parseAbiItem('event CreatorTransferred(address indexed oldCreator, address indexed newCreator)');
const DRAWN = parseAbiItem('event ItemDrawn(uint256 indexed listingId, uint8 kind, uint8 denom, bool delivered)');
/** Pool lifetime activity, independent of the current creator or connected viewer. */
const LEDGER = [
  DRAWN,
  parseAbiItem('event Deposited(address indexed from, uint256 amount)'),
  parseAbiItem('event SurplusClaimed(address indexed to, uint256 amount)'),
  parseAbiItem('event ProceedsCollected(uint256 amount)'),
  parseAbiItem('event KeeperPaid(address indexed keeper, uint256 amount, uint256 gasUsed)'),
  parseAbiItem('event ShapesMinted(uint8 indexed denom, uint256 firstTokenId, uint256 quantity, uint256 cost)'),
  parseAbiItem('event CuratedListed(uint256 indexed listingId, address indexed collection, uint256 tokenId, uint256 base, uint256 price)'),
  parseAbiItem('event CuratedRepriced(uint256 indexed listingId, uint256 base, uint256 price)'),
] as const;

type Claim = { to: Address; amount: bigint; block: bigint; hash: Hash; index: number };
type Win = { listingId: bigint; kind: number; denom: number; block: bigint; index: number };
type Ledger = ReturnType<typeof poolEthLedger> & { throughBlock: bigint; nftsWon: number; nftValues: bigint; claims: Claim[]; wins: Win[] };
const L_DELIVERY_PENDING = 6;
const L_DELIVERY_REFUNDED = 7;
const nameAbi = parseAbi(['function name() view returns (string)']);

/** PoolBalancer.admissionStatus codes. */
export const STATUS: Record<number, string> = {
  0: 'Open',
  1: 'Closed by pool creator',
  2: 'Stocking the prizes',
  3: 'No NFTs listed',
  4: 'Busy: draws settling',
  5: 'Shapes mint fee rose',
  6: 'Prizes running low',
  7: 'Curated proof needs refresh',
};

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

interface Listing { id: bigint; kind: number; denom: number; state: number; base: bigint; price: bigint; collection: Address; tokenId: bigint; weight: bigint; fwaStatus: number }

/** FWA's per-draw VRF service fee, paid by the player on top of the draw price: the service's own formula and live
 *  settings (serviceGasEstimate x gas price x (1 + serviceMarginBps) + serviceFlatWei) at the current gas price. */
const VRF_SERVICE: Address = '0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d';
const vrfServiceAbi = ['serviceGasEstimate', 'serviceMarginBps', 'serviceFlatWei'].map((name) => (
  { type: 'function', name, inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' } as const));
const liveVrfFee = (pub: NonNullable<ReturnType<typeof usePublicClient>>) =>
  Promise.all([
    pub.getGasPrice(),
    ...vrfServiceAbi.map((f) => pub.readContract({ address: VRF_SERVICE, abi: [f], functionName: f.name }) as Promise<bigint>),
  ]).then(([g, gasEst, marginBps, flat]) => (gasEst * g * (10_000n + marginBps)) / 10_000n + flat as bigint | undefined)
    // A failed read is unknown, not zero: the app then withholds the all-in price.
    .catch(() => undefined);

function useBalancer(b?: Address) {
  const pub = usePublicClient();
  const [current, setCurrent] = useState<{ client: typeof pub; snapshot: Awaited<ReturnType<typeof load>> }>();
  const [failure, setFailure] = useState<{ client: typeof pub; balancer: Address; message: string }>();
  const load = useCallback(async () => {
    if (!pub || !b) throw new Error('no client');
    const block = await pub.getBlock();
    const blockNumber = block.number;
    const r = <T,>(functionName: string, args: unknown[] = []) =>
      pub.readContract({ address: b, abi: poolBalancerAbi, functionName: functionName as never, args: args as never, blockNumber }) as Promise<T>;
    const pool = await r<Address>('pool');
    const p = <T,>(functionName: string, args: unknown[] = []) =>
      pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: functionName as never, args: args as never, blockNumber }) as Promise<T>;
    const [creator, pendingCreator, markupBps, target, enabled, admission, required, surplus, activeIds, activeShapes, balance, mintFeeCap, reconciled, creatorCredit, creatorRevenueBps, curatedRequired] =
      await Promise.all([
        r<Address>('creator'), r<Address>('pendingCreator'), r<number>('markupBps'), r<bigint>('target'),
        r<boolean>('enabled'), r<number>('admissionStatus').catch(() => 255),
        r<bigint>('requiredReserve').catch(() => undefined), r<bigint>('withdrawableSurplus').catch(() => undefined), r<bigint[]>('getActiveIds'),
        r<number[]>('getActiveShapes'), pub.getBalance({ address: b, blockNumber }), r<bigint>('mintFeeCap'), r<bigint>('reconciledSequence'),
        r<bigint>('creatorCredit'), r<number>('creatorRevenueBps'),
        // Pools from the first release always require a curated NFT and have no such view.
        r<boolean>('curatedRequired').catch(() => undefined),
      ]);
    // Upkeep is needed exactly when simulating it succeeds: as the creator (always allowed, whatever the keeper list) at
    // current fees (the reward bound it must leave unspent grows with the gas price).
    const fees = await pub.estimateFeesPerGas().catch(() => ({}));
    const upkeep = await pub.simulateContract({ address: b, abi: poolBalancerAbi, functionName: 'performUpkeepUnpaid', account: creator, ...fees })
      .then(() => ({ needed: true }), () => ({ needed: false }));
    // The keeper list is on the factory that deployed this Balancer.
    const factoryAddr = await r<Address>('factory');
    const keepersRestricted = await pub.readContract({ address: factoryAddr, abi: balancerFactoryAbi, functionName: 'keepersRestricted' }) as boolean;
    // A legacy factory's pool (shared/legacy.ts) is managed with its own ABI, limits and fixed admission settings.
    const generation = await poolGeneration(pub, b, factoryAddr, blockNumber);
    // Only legacy (community-v1) pools have a keeper policy contract; current pools pay by the in-library formula.
    const legacy = generation.legacy;
    const [paidUpkeepEnabled, policyMaxReward, legacyPolicy] = await Promise.all([
      r<boolean>('paidUpkeepEnabled'), r<bigint>('policyMaxReward'),
      legacy ? Promise.all([
        pub.readContract({ address: b, abi: legacy.poolBalancerAbi, functionName: 'keeperPolicy', blockNumber }),
        pub.readContract({ address: factoryAddr, abi: legacy.balancerFactoryAbi, functionName: 'defaultKeeperPolicy', blockNumber }),
      ]) as Promise<[Address, Address]> : undefined,
    ]);
    const [keeperPolicy, recommendedPolicy] = legacyPolicy ?? [undefined, undefined];
    // A legacy pool has no economics getter: its reserve previews use its fixed schedule under its stored maximum.
    const keeper = legacy ? undefined : await readKeeper(pub, b, factoryAddr, block);
    const economics = keeper?.economics ?? legacyEconomics(policyMaxReward);
    const policyCosts = await policyEconomics(pub, economics, b, block).catch(() => ({
      baseFee: block.baseFeePerGas ?? 0n, gasPrice: undefined, keeperQuotes: undefined,
      economics, chainTimestamp: block.timestamp, restockFee: undefined, restockFees: undefined,
      restockQuoteVerified: false, policyUnavailable: true,
    }));
    const [fee, proceeds, totalWeight, retired, unsettled, lastIssued, mintFee, edgeBps, vrfFee] = await Promise.all([
      p<bigint>('acquisitionFee'), p<bigint>('ownerProceeds'), p<bigint>('totalWeight'), p<boolean>('retired'),
      p<bigint>('unsettledAcquisitionCount'), p<bigint>('lastIssuedSequence'),
      pub.readContract({ address: SHAPES, abi: shapesAbi, functionName: 'mintFee', blockNumber }).catch(() => undefined) as Promise<bigint | undefined>,
      pub.readContract({ address: FWA_FACTORY, abi: fwaFactoryAbi, functionName: 'edgeBps', blockNumber }) as Promise<number>,
      liveVrfFee(pub),
    ]);
    const listing = async (id: bigint): Promise<Listing> => {
      const [it, l] = await Promise.all([r<readonly [number, number, number, bigint, bigint]>('items', [id]), p<readonly [Address, Address, Address, bigint, bigint, bigint, bigint, number]>('listings', [id])]);
      return { id, kind: it[0], denom: it[1], state: it[2], base: it[3], price: it[4], collection: l[0], tokenId: l[3], weight: l[7] === 1 ? l[4] : 0n, fwaStatus: l[7] };
    };
    const listings = await Promise.all(activeIds.map(listing));
    const collections = [...new Set(listings.filter((l) => l.kind === 1).map((l) => l.collection))];
    const names: Record<string, string> = Object.fromEntries(await Promise.all(collections.map(async (c) =>
      [c, await (pub.readContract({ address: c, abi: nameAbi, functionName: 'name' }) as Promise<string>).catch(() => short(c))] as const)));
    const ensName = await pub.getEnsName({ address: b }).catch(() => null);
    return {
      balancer: b, pool, creator, pendingCreator, enabled, admission, upkeep, required, surplus, creatorCredit, creatorRevenueBps: Number(creatorRevenueBps), curatedRequired, balance, target, markupBps: Number(markupBps),
      activeShapes: activeShapes.map(Number), mintFeeCap, awaitingUpkeep: Number(lastIssued - reconciled),
      fee, proceeds, totalWeight, retired, unsettled, mintFee: mintFee ?? mintFeeCap, mintFeeUnavailable: mintFee === undefined, edgeBps, ...policyCosts, policyMaxReward, vrfFee, listings, names, ensName,
      keepersRestricted, keeperPolicy, paidUpkeepEnabled, recommendedPolicy, factoryAddr, blockNumber, ...generation, keeper,
    };
  }, [pub, b]);
  type Snapshot = Awaited<ReturnType<typeof load>>;
  type HistoryInput = Parameters<typeof loadHistory>[1];
  type HistoryValue = Awaited<ReturnType<typeof loadHistory>>;
  const currentRefresh = useRef<ReturnType<typeof createLatestRefresh<void, Snapshot>>>();
  const historyRefresh = useRef<ReturnType<typeof createLatestRefresh<HistoryInput, HistoryValue>>>();
  const data = current && current.client === pub && current.snapshot.balancer === b ? current.snapshot : undefined;
  const error = failure && failure.client === pub && failure.balancer === b ? failure.message : undefined;
  const refresh = useCallback(() => currentRefresh.current?.request(), []);

  useEffect(() => {
    if (!pub || !b) return;
    const queue = createLatestRefresh<void, Snapshot>(() => load(), (event) => {
      if (event.state === 'ready') { setCurrent({ client: pub, snapshot: event.value }); setFailure(undefined); }
      if (event.state === 'error') setFailure({ client: pub, balancer: b, message: explain(event.error) });
    });
    currentRefresh.current = queue;
    queue.request();
    // Public RPC endpoints limit bursts: refresh every 30 s while the tab is visible, and at once when it returns.
    const timer = setInterval(() => { if (!document.hidden) queue.request(); }, 30_000);
    const onVisible = () => { if (!document.hidden) queue.request(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); queue.dispose();
      if (currentRefresh.current === queue) currentRefresh.current = undefined;
    };
  }, [pub, b, load]);

  const [history, setHistory] = useState<{
    client?: typeof pub; balancer?: Address; state: RefreshState<HistoryInput, HistoryValue>;
  }>({ state: { loading: true } });
  useEffect(() => {
    if (!pub || !b) return;
    setHistory({ client: pub, balancer: b, state: { loading: true } });
    const queue = createLatestRefresh<HistoryInput, HistoryValue>((snapshot) => loadHistory(pub, snapshot), (event) => {
      setHistory((h) => h.client === pub && h.balancer === b ? { ...h, state: applyRefreshEvent(h.state, event) } : h);
    });
    historyRefresh.current = queue;
    return () => {
      queue.dispose();
      if (historyRefresh.current === queue) historyRefresh.current = undefined;
    };
  }, [pub, b]);
  useEffect(() => { if (data) historyRefresh.current?.request(data); }, [data]);
  const historical = history.client === pub && history.balancer === b ? history.state : undefined;
  return { data: data && { ...data, pending: historical?.value?.pending ?? [], ledger: historical?.value?.ledger,
    historyLoading: historical?.loading ?? true,
    historyError: historical?.error === undefined ? undefined : explain(historical.error),
  }, error, refresh };
}

/** Ledger events from FROM_BLOCK, fetched once and then only from the last fetched block (less a reorg window, whose
 *  events are replaced), instead of rescanning the whole range on every refresh. */
const ledgerCache = new Map<string, { through: bigint; logs: Awaited<ReturnType<typeof fetchLedger>> }>();
const REORG_WINDOW = 64n;
const fetchLedger = (pub: NonNullable<ReturnType<typeof usePublicClient>>, balancer: Address, fromBlock: bigint, toBlock: bigint) =>
  pub.getLogs({ address: balancer, events: LEDGER, fromBlock, toBlock });
async function ledgerLogs(pub: NonNullable<ReturnType<typeof usePublicClient>>, balancer: Address, toBlock: bigint) {
  const key = `${pub.chain?.id}:${balancer.toLowerCase()}`;
  const cached = ledgerCache.get(key);
  if (cached && cached.through >= toBlock) return cached.logs.filter((l) => l.blockNumber! <= toBlock);
  const { from, keepThrough } = incrementalRange(cached?.through, FROM_BLOCK, REORG_WINDOW);
  const fresh = await fetchLedger(pub, balancer, from, toBlock);
  const logs = [...(cached?.logs.filter((l) => l.blockNumber! <= keepThrough) ?? []), ...fresh];
  ledgerCache.set(key, { through: toBlock, logs });
  return logs;
}

async function loadHistory(pub: NonNullable<ReturnType<typeof usePublicClient>>, d: {
  balancer: Address; pool: Address; listings: Listing[]; balance: bigint; proceeds: bigint; blockNumber: bigint;
}) {
  const { listings, balance, proceeds, blockNumber } = d;
  const events = await ledgerLogs(pub, d.balancer, blockNumber);
  const drawn = events.filter((l) => l.eventName === 'ItemDrawn') as unknown as { args: { listingId?: bigint; kind?: number; denom?: number; delivered?: boolean } }[];
  const failedIds = [...new Set(drawn.filter((l) => !l.args.delivered).map((l) => l.args.listingId!))];
  const listing = async (id: bigint): Promise<Listing> => {
    const [it, l] = await Promise.all([
      pub.readContract({ address: d.balancer, abi: poolBalancerAbi, functionName: 'items', args: [id], blockNumber }),
      pub.readContract({ address: d.pool, abi: fwaPoolAbi, functionName: 'listings', args: [id], blockNumber }),
    ]);
    return { id, kind: it[0], denom: it[1], state: it[2], base: it[3], price: it[4], collection: l[0], tokenId: l[3], weight: l[7] === 1 ? l[4] : 0n, fwaStatus: l[7] };
  };
  const pending = (await Promise.all(failedIds.map(listing))).filter((l) => l.state === 2);
    const sum = (name: string, f: (a: Record<string, unknown>) => bigint) => events.filter((l) => l.eventName === name).reduce((t, l) => t + f(l.args as Record<string, unknown>), 0n);
    const values = new Map<bigint, bigint>();
    for (const l of events) if (l.eventName === 'CuratedListed' || l.eventName === 'CuratedRepriced') values.set((l.args as { listingId: bigint }).listingId, (l.args as { base: bigint }).base);
    const nftWins = drawn.filter((l) => l.args.kind === 1 && l.args.delivered);
    const backingOf = (ls: Listing[]) => ls.filter((l) => l.kind === 2).reduce((t, l) => t + DENOMS[l.denom], 0n);
    const capitalFlows = (name: string, participant: string) => events.filter((l) => l.eventName === name).map((l) => {
      const args = l.args as Record<string, unknown>;
      return { participant: args[participant] as Address, amount: args.amount as bigint };
    });
    // FWA status 1 is selectable, 5 staged, 6 a failed delivery awaiting retry or refund, 7 refunded (the creator recovers it). Any
    // other status on a prize the Balancer still tracks means FWA delivered it: before upkeep reconciled the draw, or
    // on a retry after a failed delivery (which the Balancer never revisits).
    const tracked = [...listings, ...pending];
    const stillHeld = isHeld;
    const delivered = tracked.filter((l) => !stillHeld(l));
    const deliveredNfts = delivered.filter((l) => l.kind === 1);
    const held = balance + backingOf(tracked.filter(stillHeld)) + proceeds;
    const sales = sum('ProceedsCollected', (a) => a.amount as bigint) + proceeds;
    const prizesWon = drawn.filter((l) => l.args.kind === 2 && l.args.delivered).reduce((t, l) => t + DENOMS[l.args.denom!], 0n) + backingOf(delivered);
    const mintFees = sum('ShapesMinted', (a) => (a.cost as bigint) - (a.quantity as bigint) * DENOMS[Number(a.denom)]);
    const keeperPay = sum('KeeperPaid', (a) => a.amount as bigint);
    const ledger: Ledger = {
      throughBlock: blockNumber,
      ...poolEthLedger({ deposits: capitalFlows('Deposited', 'from'), withdrawals: capitalFlows('SurplusClaimed', 'to'),
        held, sales, prizesWon, mintFees, keeperPay }),
      nftsWon: nftWins.length + deliveredNfts.length,
      nftValues: nftWins.reduce((t, l) => t + (values.get(l.args.listingId!) ?? 0n), 0n) + deliveredNfts.reduce((t, l) => t + l.base, 0n),
      // Creator withdrawals, newest first.
      claims: events.filter((l) => l.eventName === 'SurplusClaimed').map((l) => {
        const args = l.args as { to: Address; amount: bigint };
        return { to: args.to, amount: args.amount, block: l.blockNumber!, hash: l.transactionHash!, index: l.logIndex! };
      }).reverse(),
      // The last four prizes delivered to players, newest first.
      wins: events.filter((l) => l.eventName === 'ItemDrawn' && (l.args as { delivered?: boolean }).delivered).slice(-4).reverse().map((l) => {
        const args = l.args as { listingId: bigint; kind: number; denom: number };
        return { listingId: args.listingId, kind: args.kind, denom: args.denom, block: l.blockNumber!, index: l.logIndex! };
      }),
    };
  return { pending, ledger };
}

// The transfer guard fails closed: without working browser storage and cross-tab locks, ETH transfers are refused.
const NO_STORAGE = 'Browser storage is unavailable, so ETH transfers are blocked: a duplicate transfer could not be prevented.';
const loadPending = (key: string): PendingTransfer | undefined => {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? undefined; } catch { throw new Error(NO_STORAGE); }
};
const savePending = (key: string, p: PendingTransfer) => { try { localStorage.setItem(key, JSON.stringify(p)); } catch { throw new Error(NO_STORAGE); } };
/** Remove this attempt's reservation only, never one another tab wrote. */
const releasePending = (key: string, id: string) => {
  try { if (loadPending(key)?.id === id) localStorage.removeItem(key); } catch { /* the reservation stays and blocks */ }
};

export function useTx(onDone: () => void) {
  const pub = usePublicClient();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const submitted = useRef<{ hash: Hash; intent: TransactionIntent }>();
  const { sendTransactionAsync } = useSendTransaction();
  /** Every reviewed send: an ETH transfer first passes the pending-transfer guard, then the wallet submits. */
  const submit = async (intent: TransactionIntent, send: () => Promise<Hash>, beforeWallet?: () => void) => {
    const key = intent.value > 0n ? transferKey(intent) : undefined;
    const reservation = { chainId: intent.chainId, from: intent.from, to: intent.to, since: Date.now(), id: crypto.randomUUID() };
    if (key) {
      if (!navigator.locks) throw new Error(NO_STORAGE);
      // Check and reserve as one step across this site's tabs, so two tabs cannot both find no earlier transfer.
      await navigator.locks.request(key, async () => {
        const earlier = loadPending(key);
        const state = earlier && await transferState(pub!, earlier);
        if (earlier && state?.unresolved) {
          if (state.nonce !== undefined && earlier.nonce === undefined) savePending(key, { ...earlier, nonce: state.nonce });
          throw new Error(earlier.hash
            ? `An earlier ETH transfer to this contract is unconfirmed (${earlier.hash}). Wait for it, or cancel it in your wallet.`
            : 'An earlier ETH transfer to this contract may have been sent from another tab or before a reload. Wait for it to confirm; if none was sent, try again in 24 hours.');
        }
        // Reserve before the wallet opens, so another tab or a reload sees this transfer while it is unconfirmed.
        savePending(key, reservation);
      });
    }
    beforeWallet?.();
    let hash: Hash;
    try {
      hash = await send();
    } catch (e) {
      if (key) releasePending(key, reservation.id);
      throw e;
    }
    if (key) {
      // The wallet chooses the nonce; keep it once a node shows the transaction. If saving fails now, the hashless
      // reservation still blocks.
      const seen = await pub!.getTransaction({ hash }).catch(() => undefined);
      try { if (loadPending(key)?.id === reservation.id) savePending(key, { ...reservation, hash, nonce: seen?.nonce }); } catch { /* reservation stays */ }
    }
    submitted.current = { hash, intent };
    setHash(hash);
    return hash;
  };
  // Simulate before sending so a revert is reported by name, and send with 30% gas-limit headroom over the estimate.
  const write = (async (params: Record<string, unknown>, beforeWallet?: () => void) => {
    const prepared = await prepareWrite(pub!, address, params);
    return submit(reviewedIntent(prepared), () => writeContractAsync(prepared as never), beforeWallet);
  }) as typeof writeContractAsync & ((params: Record<string, unknown>, beforeWallet: () => void) => Promise<Hash>);
  /** A plain ETH transfer (to a contract's receive function), reviewed and guarded like `write`. */
  const transfer = async (to: Address, value: bigint) => {
    const { prepared, intent } = await prepareTransfer(pub!, address, to, value);
    return submit(intent, () => sendTransactionAsync(prepared as never));
  };
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  // The last transaction the wallet submitted in the current or latest `send`, for its explorer link.
  const [hash, setHash] = useState<Hash>();
  // The last failure, readable right after `send` resolves (state updates land a render later).
  const failure = useRef<string>();
  // A step may carry its own label (shown as "label (2 of 5)") and may return undefined to skip itself.
  const send = async (label: string, calls: Step[], confirmationTimeout?: number) => {
    let current = label;
    setBusy(label);
    setMsg(undefined);
    setHash(undefined);
    try {
      await runTransactionSteps(label, calls, (name, k) => {
        current = name;
        setBusy(Array.isArray(calls[k]) && calls.length > 1 ? `${name} (${k + 1} of ${calls.length})` : name);
      }, async (hash) => {
        const reviewed = submitted.current;
        if (reviewed?.hash !== hash) throw new Error('Confirmation is unverified: the reviewed transaction is unavailable.');
        await confirmAction(pub!, hash, reviewed.intent, confirmationTimeout);
        if (submitted.current === reviewed) submitted.current = undefined;
      });
      setMsg({ ok: true, text: `${label}: confirmed` });
      failure.current = undefined;
      return true;
    } catch (e) {
      failure.current = `${current}: ${explain(e)}`;
      setMsg({ ok: false, text: failure.current });
      return false;
    } finally {
      setBusy(undefined);
      onDone();
    }
  };
  return { send, busy, msg, hash, write, transfer, failure };
}

const txUrl = (hash: Hash) => (chain.id === 1 ? `https://etherscan.io/tx/${hash}` : undefined);
/** The current or last transaction: what it is waiting for or how it ended, with a link to it. Stays in view. */
function TxLine({ tx }: { tx: Tx }) {
  if (!tx.busy && !tx.msg) return null;
  const url = tx.hash && txUrl(tx.hash);
  return <p className={`txline sticky-tx${tx.msg && !tx.msg.ok ? ' bad' : ''}`} aria-live="polite">
    {tx.busy ? `${tx.busy}${tx.hash ? ': waiting for confirmation' : ': confirm in your wallet'}…` : tx.msg!.text}
    {tx.hash && (url ? <> · <a href={url} target="_blank" rel="noreferrer">View transaction ↗</a></> : <> · <span title={tx.hash}>{short(tx.hash)}</span></>)}
  </p>;
}

type Step = TransactionStep;
type D = NonNullable<ReturnType<typeof useBalancer>['data']>;
type Tx = ReturnType<typeof useTx>;
const activateListings = (d: D, tx: Tx) => tx.send('Activate staged listings', [() => {
  if (activationBatch(d.listings, d.unsettled) === 0n) throw new Error('Staged activation unavailable');
  return tx.write({ address: d.pool, abi: fwaActivationAbi, functionName: 'activateListings', args: [activationBatch(d.listings, d.unsettled)] });
}]);

type Tab = 'overview' | 'nfts' | 'mix' | 'settings';
const TAB_LABELS: Record<Tab, string> = { overview: 'Overview', nfts: 'NFTs', mix: 'Prices & mix', settings: 'Settings' };
const ZERO: Counts = DENOMS.map(() => 0);
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
export const eth = (wei: bigint | undefined, d = 3) => (wei === undefined ? '–' : Number(formatEther(wei)).toFixed(d));
const E5 = 10n ** 13n;
/** Five decimals rounded up: a label for an amount to add never shows less than is sent. */
const ethUp = (wei: bigint) => eth(((wei + E5 - 1n) / E5) * E5, 5);
/** Five decimals rounded down: a label for an amount to withdraw never shows more than is sent. */
const ethDown = (wei: bigint) => eth((wei / E5) * E5, 5);
/** A signed five-decimal amount; zero carries no sign. */
const signedEth = (wei: bigint) => (wei === 0n ? '0.00000' : `${wei < 0n ? '−' : '+'}${eth(wei < 0n ? -wei : wei, 5)}`);
const signed = (x: number, d = 5) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
/** A per-draw amount: "0" when it rounds to nothing, else signed. */
const perDraw = (x: number) => (Math.abs(x) < 5e-6 ? '0' : signed(x));
const oneIn = (p: number) => (p <= 0 ? '–' : p >= 0.995 ? 'every draw' : `1 in ${1 / p < 10 ? (1 / p).toFixed(1) : Math.round(1 / p).toLocaleString()}`);
const pctOf = (p: number) => `${(p * 100).toFixed(p < 0.01 ? 2 : 1)}%`;
const ethOr = (s: string, fallback: bigint) => { try { return parseEther(s || '0'); } catch { return fallback; } };
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const word = (n: number) => WORDS[n] ?? String(n);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "Three 0.01 ETH Shapes and one 0.25 ETH Pack": every size in the mix, smallest value first. */
const mixText = (c: Counts) => {
  const parts = BY_VALUE.filter((i) => c[i]).map((i) => `${word(c[i])} ${prizeLabel(i)}${c[i] > 1 ? 's' : ''}`);
  if (!parts.length) return 'No Shapes';
  return cap(parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]);
};
const poolName = (d: D) => d.ensName ?? `Pool ${short(d.balancer)}`;

/** One sentence for the pool's state, and the action or tab that resolves it. */
function statusLine(d: D): { head: string; body: string; act?: 'upkeep' | 'activate' | 'proof' | 'open' | 'fund' | Tab; label?: string } {
  if (d.retired) return { head: 'Retired.', body: 'The pool no longer sells draws. Withdrawals still work.' };
  const fund = d.balance - d.creatorCredit;
  const shortfall = d.required !== undefined && d.required > fund ? d.required - fund : 0n;
  const target = unpackPlan(d.target);
  const listed = listedShapeCounts(d.listings);
  const missing = target.reduce((total, n, i) => total + Math.max(0, n - listed[i]), 0);
  const firstGone = target.findIndex((n, i) => n > listed[i]);
  const staged = d.listings.filter(isStaged).length;
  // Upkeep mints nothing above the accepted fee; listed prizes keep selling.
  const feeRose = !d.mintFeeUnavailable && d.mintFee > d.mintFeeCap;
  if (d.admission === 7 && curatedWitness(d.listings)) {
    return { head: 'Curated proof needs refresh.', body: 'Purchases are paused.', act: 'proof' };
  }
  if (d.enabled && staged > 0 && (shortfall === 0n || [2, 3, 6, 7].includes(d.admission))) {
    return d.unsettled > 0n
      ? { head: d.admission === 0 ? 'Open · prizes staged.' : 'Waiting for draws.', body: `${staged} prize${staged === 1 ? ' is' : 's are'} staged until draws settle.` }
      : { head: d.admission === 0 ? 'Open · prizes await activation.' : 'Inventory awaits activation.', body: `${staged} prize${staged === 1 ? ' is' : 's are'} staged.`, act: 'activate' };
  }
  switch (d.admission) {
    case 7: return { head: 'No curated NFT is selectable.', body: 'This pool requires one. Purchases are paused.',
      ...(d.upkeep.needed ? { act: 'upkeep' as const } : { act: 'nfts' as const, label: 'View NFTs' }) };
    case 0: return feeRose
      ? { head: 'Open · restocking paused.', body: 'The Shapes mint fee rose above the one you accepted. Listed prizes still sell; save the design again to restock at the new fee.', act: 'mix', label: 'Prices & mix' }
      : missing > 0 && shortfall > 0n && !d.upkeep.needed
      ? { head: 'Open · partially stocked.', body: `${missing === 1 ? `The ${prizeLabel(firstGone)} stays` : 'The missing prizes stay'} unlisted until operating ETH is topped up. Draws use the prizes listed now.`, act: 'fund', label: 'Add ETH' }
      : missing > 0
      ? { head: 'Open · partially stocked.', body: `${missing} target prize${missing === 1 ? ' is' : 's are'} missing. Draws use the current inventory and odds.`, ...(d.upkeep.needed ? { act: 'upkeep' as const } : {}) }
      : shortfall > 0n
        ? { head: 'Open.', body: `Operating ETH is ${ethUp(shortfall)} ETH short. Maintenance uses what's available until this is topped up.`, act: 'fund', label: 'Add ETH' }
        : { head: 'Open.', body: 'Players can buy draws. Nothing needs attention.' };
    case 1: {
      const opening = requiredReserveAt(target, d.activeShapes, d.mintFeeCap, d.awaitingUpkeep, d.paidUpkeepEnabled ? d.economics : undefined, d.baseFee);
      const needed = opening > fund ? opening - fund : 0n;
      return needed > 0n
        ? { head: 'Closed.', body: `Opening requires ${ethUp(needed)} ETH more operating ETH.`, act: 'fund', label: 'Add ETH' }
        : { head: 'Closed.', body: 'You closed purchases.', act: 'open' };
    }
    case 2: return d.upkeep.needed
      ? { head: 'Stocking.', body: 'Purchases open once every target prize is listed.', act: 'upkeep' }
      : shortfall > 0n
        ? { head: 'Stocking.', body: `Add ${ethUp(shortfall)} ETH to fund ${d.paidUpkeepEnabled ? 'the target and paid maintenance' : 'the target inventory'}.`, act: 'fund', label: 'Add ETH' }
        : { head: 'Stocking.', body: 'Purchases open once every target prize is listed.', act: 'upkeep' };
    case 3: return { head: 'Paused · no curated NFTs.', body: 'This pool requires a curated NFT. List one, or stop requiring one in Settings.', act: 'nfts', label: 'Add an NFT' };
    case 4: return { head: 'Busy.', body: 'Draws are settling on FWA. Purchases wait for settlement.' };
    // First-release pools only: they pause purchases while the mint fee is above the accepted one.
    case 5: return { head: 'Paused.', body: 'The Shapes mint fee rose. Save the design again to accept it.', act: 'mix', label: 'Prices & mix' };
    case 6: return feeRose
      ? { head: 'Paused · low inventory.', body: 'The Shapes mint fee rose above the one you accepted, so won prizes are not restocked. Save the design again to accept it.', act: 'mix', label: 'Prices & mix' }
      : d.upkeep.needed
      ? { head: 'Paused · low inventory.', body: 'Maintenance is available. Purchases resume when the inventory gate allows them.', act: 'upkeep' }
      : shortfall > 0n
        ? { head: 'Paused · low inventory.', body: 'Add ETH or reduce the target mix. New sales cannot refill the pool while purchases are paused.', act: 'fund', label: 'Add ETH' }
        : { head: 'Paused · low inventory.', body: 'Run maintenance to replenish available prizes.', act: 'upkeep' };
    default: return { head: 'Admission status unavailable.', body: 'Current balances and recovery actions remain available.' };
  }
}

type Page = 'home' | 'list' | 'pool' | 'new' | 'main';
// 'list' falls through to the Design page when disconnected or once the pool list loads empty.
const LANDING: Page = MAIN_POOL_OPEN ? 'home' : 'list';
// #how-<section> opens How it works at that section; #how-main is the main pool's page.
const helpOf = (hash: string) => (hash === '#how-main' ? 'how-main' : /^#how(-[a-z]+)?$/.test(hash) ? 'how' : undefined);
/** The main pool tab a hash route names, or undefined when it names none. */
const routeOf = (hash: string): MainTab | undefined => {
  const m = /^#main(?:\/(vault|manager))?$/.exec(hash);
  return m ? mainTabFor((m[1] as MainTab | undefined) ?? 'overview') : undefined;
};

export function App() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const pub = usePublicClient();
  const [mine, setMine] = useState<Address[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Address>();
  // Everyone lands on Home (Community pools until the main pool opens), except a pool creation in progress (or a connect
  // from the Design preview), which resumes.
  const [page, setPage] = useState<Page>(() => (loadDraft()?.creation ? 'new' : routeOf(location.hash) ? 'main' : LANDING));
  const [mainTab, setMainTab] = useState<MainTab>(() => routeOf(location.hash) ?? 'overview');
  const [tab, setTab] = useState<Tab>('overview');
  const [prereq, setPrereq] = useState<{ creation: boolean; impl: boolean }>();
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [poolAddress, setPoolAddress] = useState('');
  const [openingAddress, setOpeningAddress] = useState(false);
  const [addressError, setAddressError] = useState<string>();
  // How it works lives at #how and #how-main, and the main pool at #main, #main/vault and #main/manager, so each can be
  // linked to and the back button leaves it.
  const [help, setHelpState] = useState(() => helpOf(location.hash));
  useEffect(() => {
    const h = () => {
      const on = helpOf(location.hash);
      const tab = routeOf(location.hash);
      setHelpState(on);
      if (tab) { setPage('main'); setMainTab(tab); } else if (!on) setPage((p) => (p === 'main' ? LANDING : p));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  const go = (p: Page, t: MainTab = 'overview') => {
    const tab = mainTabFor(t);
    const hash = p === 'main' ? (tab === 'overview' ? 'main' : `main/${tab}`) : '';
    setHelpState(undefined); setPage(p); setMainTab(tab);
    if (location.hash.replace(/^#/, '') !== hash) location.hash = hash;
    window.scrollTo(0, 0);
  };

  const loadMine = useCallback(async () => {
    if (!pub || !address || !FACTORY) return;
    // Pools this wallet created, plus pools transferred to it (CreatorTransferred is emitted by each Balancer). The
    // current on-chain creator() is authoritative, so reorg or duplicate logs are harmless and transferred-away pools
    // (and offers not yet accepted) drop out.
    // Every pool this factory created, then transfers to this wallet among only those pools: an address-filtered scan
    // stays within public RPC limits, where an unfiltered one would search every contract on chain.
    // Legacy factories' pools are listed too and open through the legacy route (their own ABI, marked Legacy).
    const sources = [{ factory: FACTORY, fromBlock: FROM_BLOCK }, ...LEGACY_FACTORIES];
    const all = (await Promise.all(sources.map((s) => pub.getLogs({ address: s.factory, event: CREATED, fromBlock: s.fromBlock })))).flat();
    const factoryOf = new Map(all.map((l) => [l.args.balancer!.toLowerCase(), l.address as Address]));
    const created = all.filter((l) => chain.id === 31337 || l.args.creator?.toLowerCase() === address.toLowerCase());
    const pools = all.map((l) => l.args.balancer!);
    const received = pools.length ? await pub.getLogs({ address: pools, event: CREATOR_TRANSFERRED, args: { newCreator: address }, fromBlock: sources.reduce((m, s) => (s.fromBlock < m ? s.fromBlock : m), FROM_BLOCK) }) : [];
    const candidates = [...new Set([...created.map((l) => l.args.balancer!), ...received.map((l) => l.address as Address)])];
    // Any contract can emit CreatorTransferred: only Balancers this dashboard's factories deployed are listed.
    const owned = await Promise.all(candidates.map(async (b) => {
      const [ours, c] = await Promise.all([
        pub.readContract({ address: factoryOf.get(b.toLowerCase())!, abi: balancerFactoryAbi, functionName: 'isBalancer', args: [b] }) as Promise<boolean>,
        pub.readContract({ address: b, abi: poolBalancerAbi, functionName: 'creator' }) as Promise<Address>,
      ]).catch(() => [false, undefined] as const);
      return ours && c?.toLowerCase() === address.toLowerCase() ? b : undefined;
    }));
    const list = owned.filter(Boolean) as Address[];
    setMine(list);
    // Direct address recovery is independent of event discovery. Wallet/context changes clear the selection.
    setSelected((s) => s ?? (list.length === 1 ? list[0] : undefined));
    // Connecting from the preview continues the design being worked on, even for a wallet that already has pools.
    // Your community pools with none to list opens the Design preview instead.
    const intent = takeConnectIntent();
    setPage((p) => (loadDraft()?.creation || intent ? 'new' : p === 'list' && !list.length ? 'new' : p));
    setLoaded(true);
    const ens = await Promise.all(list.map((b) => pub.getEnsName({ address: b }).catch(() => null)));
    setNames(Object.fromEntries(list.flatMap((b, i) => (ens[i] ? [[b, ens[i]!]] : []))));
  }, [pub, address]);
  // A failed discovery still opens the designer; the address field above it is the way into an existing pool.
  const reload = useCallback(() => { setLoadFailed(false); loadMine().catch(() => setLoadFailed(true)); }, [loadMine]);
  useEffect(() => { setLoaded(false); setPage((p) => (loadDraft()?.creation ? 'new' : p === 'pool' ? 'list' : p)); setSelected(undefined); reload(); }, [reload]);
  useEffect(() => {
    if (!pub) return;
    Promise.all([
      pub.readContract({ address: FWA_FACTORY, abi: fwaFactoryAbi, functionName: 'poolCreationEnabled' }),
      pub.readContract({ address: FWA_FACTORY, abi: fwaFactoryAbi, functionName: 'implementation' }),
    ]).then(([c, i]) => setPrereq({ creation: c as boolean, impl: (i as string).toLowerCase() === '0x85faf92967705dc45535ebca74d6333f6bcbfee7' })).catch(() => undefined);
  }, [pub]);

  const dev = connectors.filter((c) => c.type === 'mock');
  // A wallet's own pages need a wallet: without one, Community pools is the Design preview.
  const view: Page = !isConnected && (page === 'list' || page === 'pool') ? 'new' : page;
  const community = view === 'list' || view === 'pool' || view === 'new';
  const fresh = view === 'new' && (!isConnected || loaded || loadFailed || !!loadDraft()?.creation);
  const toCommunity = () => go(!isConnected || (loaded && !mine.length) ? 'new' : 'list');
  const intent = () => { if (view === 'new') markConnectIntent(); };
  const open = (b: Address) => { setTab('overview'); setSelected(b); setPage('pool'); };
  const openAddress = async () => {
    if (!pub || !/^0x[0-9a-fA-F]{40}$/.test(poolAddress)) return;
    setOpeningAddress(true); setAddressError(undefined);
    try {
      const valid = await Promise.all([FACTORY, ...LEGACY_FACTORIES.map((f) => f.factory)].map((factory) =>
        pub.readContract({ address: factory, abi: balancerFactoryAbi, functionName: 'isBalancer', args: [poolAddress as Address] })));
      if (!valid.some(Boolean)) throw new Error('Neither the current nor a legacy factory created that pool.');
      open(poolAddress as Address);
    } catch (e) { setAddressError(explain(e)); }
    finally { setOpeningAddress(false); }
  };
  return (
    <>
      <header className="topbar">
        <a className="wordmark" href="/" onClick={(e) => { e.preventDefault(); if (MAIN_POOL_OPEN) go('home'); else toCommunity(); }}>{APP_NAME}</a>
        <nav className="topnav" aria-label="Main">
          <button aria-current={!help && community ? 'page' : undefined} onClick={toCommunity}>Community pools</button>
          {VAULT && <button aria-current={!help && view === 'main' ? 'page' : undefined} onClick={() => go('main')}>Main pool</button>}
          <button aria-current={help ? 'page' : undefined} onClick={() => { location.hash = 'how'; }}>How it works</button>
        </nav>
        {!isConnected && (
          <div className="right">
            {dev.map((c) => <button key={c.uid} className="btn sec" onClick={() => { intent(); connect({ connector: c, chainId: chain.id }); }}>Local dev account</button>)}
            <ConnectButton.Custom>{({ openConnectModal }) => <button className="btn" onClick={() => { intent(); openConnectModal(); }}>Connect wallet</button>}</ConnectButton.Custom>
          </div>
        )}
        {isConnected && (
          <div className="right">
            <ConnectButton.Custom>
              {({ account, openAccountModal }) => <button className="account" onClick={openAccountModal}>{account ? short(account.address) : ''}</button>}
            </ConnectButton.Custom>
          </div>
        )}
      </header>
      {!FACTORY && <p className="txline bad">VITE_FACTORY is not set. See app/.env.example.</p>}
      {help === 'how' && <HowItWorks onDesign={() => go('new')} />}
      {help === 'how-main' && <HowItWorksMain />}
      <div hidden={!!help}>
      {view === 'home' && <Home hasPools={isConnected && loaded && mine.length > 0} onNew={() => go('new')} onList={() => go('list')} onMain={(t) => go('main', t)} />}
      {view === 'main' && <MainPool tab={mainTab} setTab={(t) => go('main', t)} />}
      {isConnected && (view === 'list' || view === 'new') && (loadFailed || !loaded) && <main className="page narrow-page">
        {loadFailed ? <p className="txline bad">Pool discovery unavailable. <button className="link" onClick={reload}>Retry discovery</button></p> : <p className="txline">Discovering your community pools…</p>}
        {/* Opening a pool by address is the way in only while discovery is failing. */}
        {loadFailed && <>
          <label htmlFor="open-pool-address" className="form-label">Pool address</label>
          <div className="field"><input id="open-pool-address" value={poolAddress} onChange={(e) => setPoolAddress(e.target.value)} placeholder="0x…" spellCheck={false} /></div>
          <button className="btn" disabled={openingAddress || !/^0x[0-9a-fA-F]{40}$/.test(poolAddress)} onClick={openAddress}>{openingAddress ? 'Opening…' : 'Open pool'}</button>
          {addressError && <p className="note error">{addressError}</p>}
        </>}
      </main>}
      {fresh && (
        <NewPool me={isConnected ? address : undefined} prereq={prereq}
          onCreated={(b) => { open(b); reload(); }} />
      )}
      {isConnected && loaded && view === 'list' && <PoolList pools={mine} names={names} onOpen={open} onNew={() => { setPage('new'); }} />}
      {isConnected && view === 'pool' && selected && <PoolView key={selected} balancer={selected} me={address!} tab={tab} setTab={setTab} onBack={() => setPage('list')} />}
      </div>
    </>
  );
}

/** The current admission state shown in the pool list. */
const HEADS: Record<number, string> = { 0: 'Open', 1: 'Closed', 2: 'Stocking', 3: 'Paused: no curated NFT', 4: 'Busy', 5: 'Paused: mint fee', 6: 'Paused: low prizes', 7: 'Paused: curated proof' };

/** Every pool this wallet created, with its state and ETH, and the way to start another. */
function PoolList({ pools, names, onOpen, onNew }: { pools: Address[]; names: Record<string, string>; onOpen: (b: Address) => void; onNew: () => void }) {
  const pub = usePublicClient();
  const [info, setInfo] = useState<Record<string, { head: string; eth: bigint; factory: Address }>>({});
  useEffect(() => {
    if (!pub) return;
    let live = true;
    Promise.all(pools.map(async (b) => {
      const r = <T,>(functionName: string) => pub.readContract({ address: b, abi: poolBalancerAbi, functionName: functionName as never }) as Promise<T>;
      const [admission, target, shapes, balance, factory] = await Promise.all([r<number>('admissionStatus'), r<bigint>('target'), r<number[]>('getActiveShapes'), pub.getBalance({ address: b }), r<Address>('factory')]);
      const backing = shapes.reduce((s, n, i) => s + BigInt(n) * DENOMS[i], 0n);
      return [b, { head: target ? HEADS[admission] ?? 'Check the pool' : 'Not set up', eth: balance + backing, factory }] as const;
    })).then((rows) => live && setInfo(Object.fromEntries(rows))).catch(() => undefined);
    return () => { live = false; };
  }, [pub, pools]);
  return (
    <main className="page narrow-page">
      <div className="section-head"><h1 className="title t2">Your community pools</h1><button className="btn" onClick={onNew}>New community pool</button></div>
      {!pools.length && <p className="note" style={{ marginTop: 16 }}>You have no community pools yet.</p>}
      <div className="poollist">
        {[...pools].reverse().map((b) => (
          <button key={b} onClick={() => onOpen(b)}>
            <span className="pl-id"><span className="t">{names[b] ?? `Pool ${short(b)}`}</span>{names[b] && <span className="mono muted">{short(b)}</span>}<LegacyTag legacy={legacyFactory(info[b]?.factory)} /></span>
            <span className="pl-state">{info[b]?.head ?? '…'}</span>
            <span className="pl-eth mono">{info[b] ? `${eth(info[b].eth)} ETH` : ''}</span>
            <span aria-hidden="true" className="muted">→</span>
          </button>
        ))}
      </div>
    </main>
  );
}

function PoolView({ balancer, me, tab, setTab, onBack }: { balancer: Address; me: Address; tab: Tab; setTab: (t: Tab) => void; onBack: () => void }) {
  const { data: d, error, refresh } = useBalancer(balancer);
  const tx = useTx(refresh);
  if (error) return <p className="txline bad">{error}</p>;
  if (!d) return <p className="txline">Loading…</p>;
  const isCreator = d.creator.toLowerCase() === me.toLowerCase();
  const B = { address: balancer, abi: poolBalancerAbi } as const;
  const st = statusLine(d);
  const tabs: Tab[] = ['overview', 'nfts', 'mix', 'settings'];
  const upkeep = () => tx.send('Run maintenance', [async () => tx.write({ ...B, functionName: 'performUpkeepUnpaid' })]);
  const action = st.act === 'activate' ? <button className="link" disabled={!!tx.busy} onClick={() => activateListings(d, tx)}>Activate staged listings</button>
    : st.act === 'proof' ? <button className="link" disabled={!!tx.busy} onClick={() => tx.send('Refresh curated proof', [() => {
      const witness = curatedWitness(d.listings);
      if (!witness) throw new Error('No selectable curated listing is available.');
      return tx.write({ ...B, functionName: 'refreshCuratedWitness', args: [witness.id] });
    }])}>Refresh curated proof</button>
    : st.act === 'upkeep' ? <button className="link" disabled={!!tx.busy} onClick={upkeep}>Run maintenance</button>
    : st.act === 'fund' ? <button className="link" onClick={() => {
      setTab('overview');
      requestAnimationFrame(() => document.getElementById('operating-eth')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }}>{st.label}</button>
    : st.act === 'open' && isCreator ? <button className="link" disabled={!!tx.busy} onClick={() => tx.send('Open purchases', [() => tx.write({ ...B, functionName: 'open' })])}>Open purchases</button>
      : st.act && st.act !== tab && st.act !== 'open' ? <button className="link" onClick={() => setTab(st.act as Tab)}>{st.label}</button>
        : null;
  return (
    <div className="pp">
      <div className="poolhead">
        <div className="ph-row">
          <div className="ph-id">
            <span className="crumb"><button className="link quiet" onClick={onBack}>Community pools</button> /</span>
            <h1 className="ph-name">{poolName(d)}</h1>
            <div className="ph-meta">
              <span className="mono">{d.balancer}</span>
              <button className="link quiet" onClick={() => navigator.clipboard?.writeText(d.balancer)}>Copy address</button>
              <a href={FWA_POOL_URL(d.pool)} target="_blank" rel="noreferrer">Pool on FWA ↗</a>
              <LegacyTag legacy={d.legacy} />
            </div>
          </div>
        </div>
        <nav className="tabs" aria-label="Sections">
          {tabs.map((t) => <button key={t} aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>{TAB_LABELS[t]}</button>)}
        </nav>
      </div>
      <div className="status" role="status">
        <span><b>{st.head}</b> {st.body}</span>
        <span className="actions">
          {action}
          {d.upkeep.needed && st.act !== 'upkeep' && <button className="link quiet" disabled={!!tx.busy} onClick={upkeep}>Run maintenance</button>}
        </span>
      </div>
      <TxLine tx={tx} />
      {d.pendingCreator.toLowerCase() === me.toLowerCase() && (
        <p className="txline">You were offered this pool. <button className="link" disabled={!!tx.busy} onClick={() => tx.send('Accept pool', [() => tx.write({ ...B, functionName: 'acceptCreator' })])}>Accept</button></p>
      )}
      {!isCreator && <p className="txline">You are not the pool creator. You can run upkeep; other changes need the pool creator.</p>}
      {tab === 'overview' && <Overview d={d} tx={tx} isCreator={isCreator} me={me} setTab={setTab} />}
      {tab === 'nfts' && <Nfts d={d} tx={tx} isCreator={isCreator} me={me} setTab={setTab} />}
      {tab === 'mix' && (isCreator ? <Design d={d} tx={tx} mode="pool" me={me} /> : <main className="page"><p className="lead">Only the pool creator can change prices and the mix.</p></main>)}
      {tab === 'settings' && (isCreator ? <Settings d={d} tx={tx} /> : <main className="page"><p className="lead">Only the pool creator can change settings.</p></main>)}
    </div>
  );
}

/** An NFT row on the Design page: its value, and once a wallet is connected, which token it is. */
type DraftNft = { value: string; collection?: Address; tokenId?: string; name?: string; image?: string; floor?: number; slug?: string };
/** A chosen NFT's starting value: its collection's floor, or empty when there is none. */
const floorValue = (floor?: number) => (floor && floor >= 0.000001 ? floor.toFixed(6).replace(/\.?0+$/, '') : '');
/** Design work before submission, retained across wallet connection and reloads. */
type Draft = { salt?: Hash; creation?: CreationAttempt; curatedRequired?: boolean; markup: number; counts?: Counts; style?: Style | null; nfts?: DraftNft[];
  /** Drafts saved before `counts`: 0.01 ETH Shapes and the other sizes, kept apart. Read once, never written. */
  small?: number; bonus?: Counts };
const draftKey = () => 'pool-design-draft';
const loadDraft = (): Draft | undefined => { try { return JSON.parse(localStorage.getItem(draftKey()) ?? 'null') ?? undefined; } catch { return undefined; } };
const saveDraft = (x: Draft) => { try { localStorage.setItem(draftKey(), JSON.stringify({ ...x, creation: loadDraft()?.creation })); } catch { /* storage unavailable */ } };
const clearDraft = () => { try { if (!loadDraft()?.creation) localStorage.removeItem(draftKey()); } catch { /* storage unavailable */ } };
const storeCreation = (attempt: CreationAttempt, previous?: CreationAttempt) => {
  const draft = loadDraft();
  if (!draft) throw new Error('Save the design before submitting creation.');
  if (draft.creation && !sameCreation(draft.creation, attempt)) throw new Error('Another creation still needs confirmation.');
  if (previous && !sameSubmission(draft.creation, previous)) return false;
  // Persistence must succeed before asking the wallet to submit.
  localStorage.setItem(draftKey(), JSON.stringify({ ...draft, creation: attempt }));
  return true;
};
const forgetCreation = (attempt: CreationAttempt) => {
  const draft = loadDraft();
  if (!sameSubmission(draft?.creation, attempt)) return false;
  localStorage.setItem(draftKey(), JSON.stringify({ ...draft, creation: undefined }));
  return true;
};
const INTENT_KEY = 'connect-from-preview';
const markConnectIntent = () => { try { sessionStorage.setItem(INTENT_KEY, '1'); } catch { /* storage unavailable */ } };
const takeConnectIntent = () => { try { const v = sessionStorage.getItem(INTENT_KEY); sessionStorage.removeItem(INTENT_KEY); return !!v; } catch { return false; } };
const DEFAULT_NFT: DraftNft = { value: '0.050' };
const DEFAULT_MARKUP = 25;
const DEFAULT_SMALL = 10;
/** A new design: the Balanced preset at ten 0.01 ETH Shapes (Balanced depends only on that count). */
/** Drafts saved before `counts` used older preset keys: steady, board (Balanced) and balanced (More big wins). */
const draftStyle = (d?: Draft) => (d && !d.counts ? ({ steady: 'lowPrice', board: 'balanced', balanced: 'bigWins' } as Record<string, Style>)[d.style ?? ''] ?? d.style : d?.style);
const defaultCounts = (d: DesignInputs) => presetCounts('balanced', d, DEFAULT_SMALL);
const GAME_STYLES: { key: Style; label: string; hint: string }[] = [
  { key: 'lowPrice', label: 'Low draw price', hint: 'Cheapest draws. Curated NFTs are the big prizes.' },
  { key: 'balanced', label: 'Balanced', hint: 'Prizes in steady steps, 0.01 to 0.1 ETH.' },
  { key: 'bigWins', label: 'More big wins', hint: `About 1 in ${Math.round(1 / BIG_WIN_SHARE)} draws wins 2× the price.` },
  { key: 'jackpot', label: 'Jackpot', hint: `Adds one Shape worth about ${JACKPOT_MULTIPLE}× the price.` },
];
/** Prize sizes offered for adjusting by hand, smallest first: 0.05 to 25 ETH (Shapes and Packs), plus any size a style
 *  picked. */
const nftKey = (collection: string, tokenId: bigint | string) => `${collection}:${tokenId}`.toLowerCase();
const approvalAbi = parseAbi(['function getApproved(uint256 tokenId) view returns (address)', 'function isApprovedForAll(address owner, address operator) view returns (bool)']);
type Prereq = { creation: boolean; impl: boolean };

/** The Design page for a pool that does not exist yet: live fees from chain; NFTs and budget from the draft. */
function NewPool({ me, prereq, onCreated }: { me?: Address; prereq?: Prereq; onCreated: Create['onCreated'] }) {
  const pub = usePublicClient();
  const tx = useTx(() => undefined);
  const { chainId: walletChainId } = useAccount();
  const [attempt, setAttempt] = useState<CreationAttempt | undefined>(() => loadDraft()?.creation);
  const [outcome, setOutcome] = useState<CreationOutcome>('unknown');
  const [checking, setChecking] = useState(false);
  const [recheck, setRecheck] = useState(0);
  const created = useRef(onCreated);
  created.current = onCreated;
  const recoveryContext = useRef({ chainId: walletChainId, creator: me, factory: FACTORY, pub });
  recoveryContext.current = { chainId: walletChainId, creator: me, factory: FACTORY, pub };
  const trackCreation = (next: CreationAttempt, previous?: CreationAttempt) => {
    if (storeCreation(next, previous)) { setAttempt(next); setOutcome('unknown'); }
  };
  const rejectCreation = (rejected: CreationAttempt) => { if (forgetCreation(rejected)) setAttempt(undefined); };
  useEffect(() => {
    if (!pub || !attempt || tx.busy) return;
    let current = true;
    let inFlight = false;
    const check = async () => {
      if (inFlight) return;
      inFlight = true;
      setChecking(true);
      try {
        let checked = attempt;
        const next = await recoverCreation(pub, attempt, { chainId: walletChainId, creator: me, factory: FACTORY }, (updated, previous) => {
          if (storeCreation(updated, previous)) checked = updated;
        });
        if (!current || recoveryContext.current.pub !== pub) return;
        if (!creationContextMatches(attempt, recoveryContext.current)) { setOutcome('context'); return; }
        const saved = loadDraft()?.creation;
        if (!sameCreation(saved, attempt)) return;
        if (!sameSubmission(saved, checked)) { setAttempt(saved); setOutcome('unknown'); return; }
        if (saved!.hash !== attempt.hash || saved!.nonce !== attempt.nonce) setAttempt(saved);
        setOutcome(next);
        if (next === 'confirmed' && forgetCreation(saved!)) {
          clearDraft();
          created.current(attempt.predicted);
        }
      } catch {
        if (current) setOutcome('unknown');
      } finally {
        inFlight = false;
        if (current) setChecking(false);
      }
    };
    void check();
    const timer = setInterval(() => void check(), 5_000);
    return () => { current = false; clearInterval(timer); };
  }, [pub, attempt, walletChainId, me, recheck, tx.busy]);
  const [live, setLive] = useState<Awaited<ReturnType<typeof policyEconomics>> & { edgeBps: number; mintFee: bigint; vrfFee?: bigint; productLimits: Awaited<ReturnType<typeof readProductLimits>>; settingsHash: Hex; bucket: Bucket }>();
  const [loadError, setLoadError] = useState<string>();
  const [loadTry, setLoadTry] = useState(0);
  const [wallet, setWallet] = useState<bigint>();
  useEffect(() => {
    if (!pub) return;
    (async () => {
      // One block for everything the creator reviews: the economics, the mint fee and the hash that binds both (plus the
      // factory's default spending bucket, so a bucket change after review also refuses creation).
      const block = await pub.getBlock();
      const at = { blockNumber: block.number };
      const [economics, settingsHash, mintFee, capacity, refill] = await Promise.all([
        pub.readContract({ ...at, address: FACTORY, abi: balancerFactoryAbi, functionName: 'economics' }) as Promise<Economics>,
        pub.readContract({ ...at, address: FACTORY, abi: balancerFactoryAbi, functionName: 'creationSettingsHash' }) as Promise<Hex>,
        pub.readContract({ ...at, address: SHAPES, abi: shapesAbi, functionName: 'mintFee' }),
        pub.readContract({ ...at, address: FACTORY, abi: balancerFactoryAbi, functionName: 'defaultBucketCapacity' }),
        pub.readContract({ ...at, address: FACTORY, abi: balancerFactoryAbi, functionName: 'defaultBucketRefill' }),
      ]);
      const [costs, edgeBps, vrfFee, productLimits] = await Promise.all([
        policyEconomics(pub, economics, undefined, block),
        pub.readContract({ address: FWA_FACTORY, abi: fwaFactoryAbi, functionName: 'edgeBps' }),
        liveVrfFee(pub), readProductLimits(pub, FACTORY, block.number),
      ]);
      setLive({ ...costs, edgeBps, mintFee, vrfFee, productLimits, settingsHash, bucket: { capacity, refill } });
      setLoadError(undefined);
    })().catch((e) => setLoadError(explain(e)));
  }, [pub, loadTry]);
  useEffect(() => { if (!loadError) return; const t = setTimeout(() => setLoadTry((n) => n + 1), 30_000); return () => clearTimeout(t); }, [loadError]);
  useEffect(() => { if (pub && me) pub.getBalance({ address: me }).then(setWallet).catch(() => undefined); }, [pub, me, tx.busy]);
  if (attempt) return <main className="page narrow-page">
    <h1 className="title t2">Pool creation</h1>
    <p className="lead">{creationStatus(outcome)}</p>
    <p className="note">Account {attempt.creator} · Chain {attempt.chainId}</p>
    <p className="note">Predicted pool {attempt.predicted}</p>
    {attempt.hash && <p className="note mono">Transaction {attempt.hash}</p>}
    <button className="btn" disabled={checking} onClick={() => setRecheck((n) => n + 1)}>{checking ? 'Checking…' : 'Check creation'}</button>
    {canRetryCreation(outcome, attempt, { chainId: walletChainId, creator: me, factory: FACTORY }) && <button className="btn sec" onClick={() => rejectCreation(attempt)}>Return to saved design</button>}
    {(tx.busy || tx.msg) && <p className="txline">{tx.busy ? `${tx.busy}…` : tx.msg?.text}</p>}
  </main>;
  // The designer shows without current fees: costs stay hidden and creation blocked until they load.
  // Until the factory economics load, nothing is budgeted for paid upkeep (paidUpkeepEnabled false) and creation is blocked.
  const fees = live ?? { paidUpkeepEnabled: false, baseFee: 0n, gasPrice: 0n, chainTimestamp: 0n, edgeBps: 0, mintFee: 0n, policyUnavailable: true, mintFeeUnavailable: true, feesLoading: !loadError };
  // Only the fields Design reads; a pool that does not exist has no target, listings or balance.
  const d = { target: 0n, markupBps: 0, listings: [], balance: 0n, creatorCredit: 0n, creatorRevenueBps: 0, proceeds: 0n, awaitingUpkeep: 0, activeShapes: ZERO, names: {}, balancer: ZERO_ADDR, enabled: false, paidUpkeepEnabled: true, mintFeeCap: fees.mintFee, ...fees } as unknown as D;
  return <Design d={d} tx={tx} mode={me ? 'new' : 'preview'} me={me} create={{ wallet, prereq, onCreated, trackCreation, rejectCreation, resumeCreation: setAttempt, reviewedHash: live?.settingsHash, bucket: live?.bucket, reload: () => setLoadTry((n) => n + 1) }} />;
}

type Pub = NonNullable<ReturnType<typeof usePublicClient>>;
const nftLabel = (n: DraftNft) => `${n.name ?? short(n.collection!)} #${n.tokenId}`;

/**
 * True when a collection accepts a transfer to an EOA but refuses one to a contract. Such a collection lets a hostile
 * buyer (a contract that never claims its refund) lock a drawn NFT in FWA escrow.
 */
async function refusesContracts(pub: Pub, me: Address, list: DraftNft[]) {
  const sim = (n: DraftNft, to: Address) => pub.simulateContract({ address: n.collection!, abi: erc721Abi, functionName: 'transferFrom', args: [me, to, BigInt(n.tokenId!)], account: me }).then(() => true, () => false);
  return (await Promise.all(list.map(async (n) => (await sim(n, '0x000000000000000000000000000000000000dEaD')) && !(await sim(n, SHAPES))))).some(Boolean);
}

/** NFTs whose collection will not approve `balancer` (e.g. marketplace allowlists), with the reason. */
async function refusedApprovals(pub: Pub, me: Address, balancer: Address, list: DraftNft[]) {
  return (await Promise.all(list.map((n) => pub.simulateContract({ address: n.collection!, abi: erc721Abi, functionName: 'approve', args: [balancer, BigInt(n.tokenId!)], account: me })
    .then(() => undefined, (e) => `${nftLabel(n)} (${explain(e)})`)))).filter(Boolean) as string[];
}

/** FWA lists at most 20 NFTs per transaction (MAX_INVENTORY_BATCH); a longer list is sent in batches. There is no
 *  limit on the total. */
const LIST_BATCH = 20;
const listSteps = (ns: DraftNft[], write: (batch: { collection: Address; tokenId: bigint; base: bigint }[]) => Promise<Hash | undefined>) => {
  const steps: Step[] = [];
  for (let k = 0; k < ns.length; k += LIST_BATCH) {
    const batch = ns.slice(k, k + LIST_BATCH);
    const label = ns.length <= LIST_BATCH ? `List ${ns.length === 1 ? 'your NFT' : `${word(ns.length)} NFTs`}` : `List NFTs ${k + 1} to ${k + batch.length} of ${ns.length}`;
    steps.push([label, () => write(batch.map((n) => ({ collection: n.collection!, tokenId: BigInt(n.tokenId!), base: ethOr(n.value, 0n) })))]);
  }
  return steps;
};

/** One approval per NFT, skipped when the pool is already approved. */
const approveSteps = (pub: Pub, tx: Tx, me: Address, balancer: Address, list: DraftNft[]): Step[] => list.map((n) => {
  const id = BigInt(n.tokenId!);
  return [`Approve ${nftLabel(n)}`, async () => {
    const [one, all] = await Promise.all([
      pub.readContract({ address: n.collection!, abi: approvalAbi, functionName: 'getApproved', args: [id] }).catch(() => ZERO_ADDR),
      pub.readContract({ address: n.collection!, abi: approvalAbi, functionName: 'isApprovedForAll', args: [me, balancer] }).catch(() => false),
    ]);
    if (all || (one as string).toLowerCase() === balancer.toLowerCase()) return undefined;
    return tx.write({ address: n.collection!, abi: erc721Abi, functionName: 'approve', args: [balancer, id] });
  }];
});

/** Upkeep, skipped when there is nothing for it to do; anyone (including a keeper) can run it later. The precheck
 *  simulates exactly as the send will (EIP-1559 fees from the node, the creator account), so NoUpkeepNeeded is not
 *  misjudged at gas price 0, where upkeep's reward bound is lower than at inclusion. */
const upkeepStep = (pub: Pub, tx: Tx, me: Address, balancer: Address): Step => ['Run upkeep', async () => {
  const call = { address: balancer, abi: poolBalancerAbi, functionName: 'performUpkeepUnpaid' as const };
  const needed = await prepareWrite(pub, me, call).then(() => true, () => false);
  return needed ? tx.write(call) : undefined;
}];

// Grid shades by prize rank, smallest first; the top Shape prize is white, NFTs are outlined.
const SHADES = ['#333', '#555', '#7a7a7a', '#b5b5b5'];

type Mode = 'preview' | 'new' | 'pool';
type Create = { wallet?: bigint; prereq?: Prereq; onCreated: (b: Address) => void; trackCreation: (attempt: CreationAttempt, previous?: CreationAttempt) => void; rejectCreation: (attempt: CreationAttempt) => void; resumeCreation: (attempt: CreationAttempt) => void; reviewedHash?: Hex; bucket?: Bucket; reload?: () => void };
type Bucket = { capacity: bigint; refill: bigint };

/**
 * One Design page for every stage: a preview before connecting (no NFTs until a wallet is connected), a pool about to be created
 * (each NFT is chosen from the wallet), and an existing pool (listed NFTs are fixed; more can be added). The button
 * runs every transaction the design needs, in order.
 */
type DesignProps = { d: D; tx: Tx; mode: Mode; me?: Address; create?: Create };
function Design(props: DesignProps) {
  if (props.mode === 'pool' && (props.d.policyUnavailable || props.d.mintFeeUnavailable)) return <main className="page"><p className="lead">Current economic quotes are unavailable.</p><p>Use Overview to withdraw earnings, and Settings for maintenance.</p></main>;
  return <DesignEditor {...props} />;
}
function DesignEditor({ d, tx, mode, me, create }: DesignProps) {
  const pub = usePublicClient();
  const values = useConfirmValues();
  const fresh = mode !== 'pool';
  const has = d.target !== 0n;
  const [draft] = useState(() => (fresh ? loadDraft() : undefined));
  const listed = d.listings.filter((l) => l.kind === 1 && isSelectable(l));
  const listedKeys = new Set(d.listings.filter((l) => l.kind === 1 && l.state === 1).map((l) => nftKey(l.collection, l.tokenId)));
  const nftName = (l: Listing) => `${d.names[l.collection] ?? short(l.collection)} #${l.tokenId}`;
  const [nfts, setNfts] = useState<DraftNft[]>(() => draft?.nfts ?? []);
  const [picking, setPicking] = useState<number>();
  // Listed rows stay fixed while new NFTs are selected.
  const isListed = (n: DraftNft) => !!n.collection && listedKeys.has(nftKey(n.collection, n.tokenId!));
  const pending = nfts.map((n, i) => ({ n, i })).filter(({ n }) => !isListed(n));
  // Every NFT the design counts: listed ones, then rows with a value. Once connected, only rows with a chosen token.
  const rows = [
    ...listed.map((l) => ({ key: `l${l.id}`, name: nftName(l), base: l.base })),
    ...pending.filter(({ n }) => n.collection).map(({ n, i }) => ({ key: `d${i}`, name: nftLabel(n), base: ethOr(n.value, 0n) })).filter((r) => r.base > 0n),
  ];
  const bases = rows.map((r) => r.base);
  const curatedPrices = listed.map((l) => l.price);
  // Factory product limits (live; the constructor values until they load). A saved pool may keep a design above them.
  const limits = d.productLimits ?? INITIAL_LIMITS;
  const markupRange = markupSliderRange(limits, has ? d.markupBps : 0);
  const [markup, setMarkup] = useState(has ? d.markupBps / 100 : draft?.markup ?? DEFAULT_MARKUP);
  useEffect(() => { if (!has) setMarkup((m) => Math.min(Math.max(m, markupRange.min), markupRange.max)); }, [has, markupRange.min, markupRange.max]);
  const savedCounts = has ? unpackPlan(d.target) : ZERO;
  const [restricted, setRestricted] = useState<string>();
  const [refused, setRefused] = useState<string>();
  const [staleReview, setStaleReview] = useState<Hex>();
  const [open, setOpen] = useState({ bonus: false, numbers: false });
  const [gridView, setGridView] = useState<'inventory' | 'draws'>('inventory');
  const [how, setHow] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const salt = useMemo(() => draft?.salt ?? `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, '0')).join('')}` as Hash, []);
  const creationStarting = useRef(false);
  const toggle = (k: keyof typeof open) => setOpen({ ...open, [k]: !open[k] });
  const markupBps = Math.round(markup * 100);
  // Actual FWA prices of the Shape prizes listed now, by size: the current (saved) board is priced on these, a
  // new/changed design on the planner's computed prices (see `inputs` below).
  const livePrices: bigint[][] = [];
  for (const l of d.listings) if (l.kind === 2 && isSelectable(l)) (livePrices[l.denom] ??= []).push(l.price);
  const maxPrizes = prizeLimit(limits, shapeCount(savedCounts));
  const base: DesignInputs = {
    curatedBases: bases, curatedPrices, markupBps, edgeBps: Number(d.edgeBps), mintFee: d.mintFee, restockFee: d.restockFee ?? 0n, maxPrizes,
    have: d.activeShapes, baseFee: d.baseFee, unreconciled: d.awaitingUpkeep, paidUpkeepEnabled: d.paidUpkeepEnabled, economics: d.economics, restockFees: d.restockFees, keeperQuotes: d.keeperQuotes,
  };
  // The prize count of each of the 16 sizes: the one record of the mix. Presets compute it; hand edits change it.
  const [counts, setCounts] = useState<Counts>(() => (has ? savedCounts
    : draft?.counts?.length === 16 ? draft.counts : draft ? mixOf(draft.small ?? DEFAULT_SMALL, draft.bonus) : defaultCounts(base)));
  // The preset last applied, until a count is changed by hand. While it is applied, the mix follows the draw price it
  // depends on (markup, curated NFTs, fees), as each preset is defined against it.
  const savedStyle = (): Style | undefined => (savedCounts.some((n, i) => i > 0 && n > 0) ? undefined : 'lowPrice');
  const [style, setStyle] = useState<Style | undefined>(() => (has ? savedStyle() : draft?.style === null ? undefined : GAME_STYLES.find((g) => g.key === draftStyle(draft))?.key ?? 'balanced'));
  const maxSmall = useMemo(() => (style ? presetMaxSmall(style, base) : maxPrizes - (shapeCount(counts) - counts[0])),
    [style, style ? '' : counts.join(), bases.join(), markupBps, d.mintFee, d.edgeBps, d.restockFees?.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (style) setCounts((c) => presetCounts(style, base, Math.min(c[0], maxSmall)));
  }, [style, bases.join(), markupBps, d.mintFee, d.edgeBps, d.restockFees?.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = shapeCount(counts);
  const target = packPlan(counts);
  // A saved pool shows its listed prizes at their actual prices until the design differs from it; a projection of an
  // edited design prices the new Shapes at the current markup instead. So does a saved pool with fewer Shape prizes
  // listed than its target: the listed board alone has no draw price to show.
  const edited = !has || target !== d.target || markupBps !== d.markupBps || pending.some(({ n }) => n.collection);
  const listedCounts = listedShapeCounts(d.listings);
  const stocking = has && shapeCount(listedCounts) < shapeCount(savedCounts);
  const projected = stocking && !edited;
  const actual = has && !edited && !stocking;
  const inputs: DesignInputs = actual ? { ...base, shapePrices: livePrices } : base;
  const suggestedRate = suggestedCreatorRevenueBps(counts, base);
  // Earnings are what the markup brings in above the 10% that runs the pool. A new pool takes this rate; saving an
  // existing pool's markup or mix sets it again.
  const [curatedRequired, setCuratedRequired] = useState(!!draft?.curatedRequired);
  // Until a design is saved on chain, keep it in this browser so it survives connecting, reloading and a failed step.
  const current = (): Draft => ({ salt, curatedRequired, markup, counts, style: style ?? null, nfts });
  useEffect(() => {
    if (fresh) saveDraft(current());
  }, [has, markup, counts.join(), style, nfts, curatedRequired]); // eslint-disable-line react-hooks/exhaustive-deps
  const setNft = (i: number, x: Partial<DraftNft>) => { setNfts(nfts.map((n, j) => (j === i ? { ...n, ...x } : n))); };
  const reset = () => {
    setPicking(undefined);
    setOpen({ bonus: false, numbers: false });
    if (has) {
      setMarkup(d.markupBps / 100); setStyle(savedStyle()); setCounts(savedCounts);
      return;
    }
    setMarkup(DEFAULT_MARKUP); setStyle('balanced'); setCounts(defaultCounts(base));
    setNfts([]);
  };
  // Exact counts by hand; any size may be zero.
  const setCountAt = (i: number, n: number) => { setStyle(undefined); setCounts(counts.map((x, j) => (j === i ? Math.max(0, n) : x))); };
  const choose = (st: Style) => { setStyle(st); setCounts(presetCounts(st, base, Math.min(counts[0], presetMaxSmall(st, base)))); };
  // The pool-size control steps through the 0.01 ETH Shapes: a preset recomputes its mix at that count.
  const setSmall = (n: number) => setCounts(style ? presetCounts(style, base, n) : counts.map((x, j) => (j === 0 ? n : x)));
  const ready = total > 0;
  const quotedCounts = actual ? listedCounts : counts;
  // Prices and costs need current fees; without them every figure shows as a dash.
  const ev = ready && !d.policyUnavailable && !d.mintFeeUnavailable ? evaluate(quotedCounts, inputs) : undefined;
  // Player return figures are against the full price a player pays: the draw price plus FWA's VRF fee (gas is on top).
  const vrfKnown = d.vrfFee !== undefined;
  const view = ev && playerView(ev).top ? playerView(ev) : undefined;
  // Fill gate (D8): a mix whose prize weight is small pauses sales while draws are unreconciled, before the backlog
  // threshold does. A new pool takes the defaults.
  const backlog = d.backlogThreshold ?? MAX_BATCH;
  const pausesAt = pendingDrawsAdmitted(counts, d.fillGateBps ?? FILL_GATE_DEFAULT_BPS, backlog) + 1;
  // Saving (configure) is needed for a new design, a markup or mix change, or to accept a changed Shapes mint fee,
  // higher or lower. Configure binds the fee shown here as the accepted cap and reverts if the live fee is above it.
  const feeOnly = has && markupBps === d.markupBps && target === d.target && d.mintFee !== d.mintFeeCap;
  const configChanged = !has || markupBps !== d.markupBps || target !== d.target || feeOnly;
  const reviewedRate = fresh || (configChanged && !d.legacy) ? suggestedRate : d.creatorRevenueBps;
  const rateChange = has && !d.legacy && reviewedRate !== d.creatorRevenueBps;
  const revenueValid = Number.isInteger(reviewedRate) && reviewedRate >= 0 && reviewedRate <= 10_000;
  // The reserve uses the accepted fee (PoolBalancer.requiredReserve): a pending configure accepts the live fee.
  const savedReserveFee = d.mintFeeCap;
  const reserveMintFee = configChanged ? d.mintFee : savedReserveFee;
  const fundForOpen = fresh || d.enabled || !has;
  const needed = ready ? ethNeeded(counts, { ...inputs, mintFee: reserveMintFee, enabled: fundForOpen }) : 0n;
  const capital = ready ? reserveBreakdownAt(counts, d.activeShapes, reserveMintFee, d.awaitingUpkeep, d.paidUpkeepEnabled ? d.economics : undefined, d.baseFee, fundForOpen) : undefined;
  // An existing pool being edited: each figure shows its value after saving, with the value now beside it.
  const savedEv = !has ? undefined : stocking ? evaluate(savedCounts, { ...base, markupBps: d.markupBps })
    : evaluate(listedCounts, { ...base, markupBps: d.markupBps, shapePrices: livePrices });
  const savedView = savedEv && playerView(savedEv).top ? playerView(savedEv) : undefined;
  const editing = has && configChanged && !!savedEv;
  const now = (before: string, after: string) => (editing && before !== after ? <span className="was">now {before}</span> : null);
  // Round by one micro-ETH; larger rounding would dominate a small working-capital buffer.
  const roundFunding = (value: bigint) => ((value + 10n ** 12n - 1n) / 10n ** 12n) * 10n ** 12n;
  const deposit = fresh ? roundFunding(needed) : 0n;
  const left = [...d.activeShapes];
  const extra = mode === 'pool' ? d.listings.filter((l) => l.kind === 2 && l.state === 1 && l.fwaStatus === 1 && left[l.denom] > counts[l.denom] && left[l.denom]--).slice(0, 20) : [];
  const redeemed = extra.reduce((sum, listing) => sum + DENOMS[listing.denom], 0n);
  const have = fresh ? deposit : d.balance - d.creatorCredit + redeemed;
  const shortBy = needed > have ? roundFunding(needed - have) : 0n;
  const econ = ready && revenueValid && !d.policyUnavailable && !d.mintFeeUnavailable ? economics(quotedCounts, { ...inputs, creatorRevenueBps: reviewedRate }) : undefined;
  const tierOf = (i: number) => view?.tiers.find((t) => t.kind === 'shape' && t.size === i);

  // Out of 100 draws: whole draws per prize group by largest remainder, NFTs grouped.
  const groups = view ? [
    ...(view.curated > 0 ? [{ key: 'nft', i: -1, p: view.curated, nft: true, value: 0n, n: 0 }] : []),
    ...BY_VALUE.filter((i) => quotedCounts[i] > 0).map((i) => ({ key: `s${i}`, i, n: quotedCounts[i], p: tierOf(i)?.odds ?? 0, nft: false, value: DENOMS[i] })),
  ] : [];
  const raw = groups.map((g) => g.p * 100);
  const whole = raw.map(Math.floor);
  raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]).slice(0, 100 - whole.reduce((a, b) => a + b, 0)).forEach(([, i]) => whole[i]++);
  const shapeGroups = groups.filter((g) => !g.nft);
  const sizes = BY_VALUE.filter((i) => quotedCounts[i] > 0);
  const shadeOf = (i: number) => (i === sizes[sizes.length - 1] && sizes.length > 1 ? '#fff' : SHADES[Math.min(SHADES.length - 1, sizes.indexOf(i))]);
  const ordered = groups.map((g, k) => ({ g, n: whole[k] })).sort((a, b) => b.n - a.n);
  const cells = ordered.flatMap(({ g, n }) => Array(n).fill(g) as (typeof groups)[number][]);
  const sw = (g: (typeof groups)[number]) => (g.nft ? { border: '2px solid #fff' } : { background: shadeOf(g.i) });
  const legend = (g: (typeof groups)[number], n: number) => {
    const verb = n <= 1 ? 'wins' : 'win';
    if (g.nft) return `${verb} ${rows.length === 1 ? `your NFT, ${rows[0].name}` : 'one of your NFTs'}`;
    const v = Number(formatEther(g.value)) / Number(formatEther(view!.cost));
    const what = `${g.n === 1 && shapeGroups.length > 1 && g === shapeGroups[shapeGroups.length - 1] ? 'the' : 'a'} ${prizeLabel(g.i)}`;
    return `${verb} ${what}${v < 1 ? ', less than the draw price' : `, ${v.toFixed(1)}× the draw price`}`;
  };

  // Inventory: one square per item in the pool, each with its own chance per draw.
  // Same group order as the 100-draw view (most frequent first), so the two views line up.
  const curatedTiers = view?.tiers.filter((t) => t.kind === 'curated') ?? [];
  const items: InvItem[] = view ? ordered.flatMap(({ g }): InvItem[] => {
    if (g.nft) return curatedTiers.map((t, k) => ({
      key: `n${k}`, label: rows[k]?.name ?? `Curated NFT ${k + 1}`, nft: true, value: t.value, price: t.listPrice, p: t.odds, mult: t.multiple, style: sw(g),
    }));
    const t = tierOf(g.i);
    return t ? Array.from({ length: g.n }, (_, j) => ({
      key: `s${g.i}-${j}`, label: prizeLabel(g.i), nft: false, value: t.value, price: t.listPrice, p: t.odds / g.n, mult: t.multiple, style: sw(g),
    })) : [];
  }) : [];
  // Each NFT's chance per draw, a result of its value and the rest of the pool.
  const oddsOf = (key: string) => { const k = rows.findIndex((r) => r.key === key); return k < 0 ? undefined : curatedTiers[k]?.odds; };
  const oddsLine = (key: string) => { const p = oddsOf(key); return p ? `Won about ${oneIn(p)} draws` : undefined; };
  const common = view?.tiers.reduce((a, t) => (t.odds > a.odds ? t : a), view.tiers[0]);
  const prize = (t: NonNullable<typeof common>) => (t.kind === 'curated' ? 'A curated NFT' : `A ${t.label}`);
  const topText = (v: NonNullable<typeof view>) => `${v.top.kind === 'curated' ? 'Curated NFT' : v.top.label} · ${v.top.multiple.toFixed(1)}×`;
  const avgText = (v: NonNullable<typeof view>) => `${(v.avgReturn * 100).toFixed(0)}% of the price`;
  const playBlock = view ? (
    <div className="players">
      <h3 className="ctl">For players</h3>
      {bases.length > 0 && <div className="kv"><span className="k">Win a curated NFT</span><span>{oneIn(view.curated)}{savedView && now(oneIn(savedView.curated), oneIn(view.curated))}</span></div>}
      <div className="kv"><span className="k">Win more than the draw price</span><span>{oneIn(view.winMore)}{savedView && now(oneIn(savedView.winMore), oneIn(view.winMore))}</span></div>
      <div className="kv"><span className="k">Top prize</span><span>{topText(view)}{savedView && now(topText(savedView), topText(view))}</span></div>
      <div className="kv"><span className="k">Average prize</span><span>{avgText(view)}{savedView && now(avgText(savedView), avgText(view))}</span></div>
    </div>
  ) : null;
  const payBlock = (
    <div>
      <span className="soft" style={{ fontSize: 15 }}>Draw price</span>
      <div className="pay">{ev
        ? <><span className="figure">{eth(ev.drawPrice, 5)}</span><span className="unit">ETH / draw</span></>
        : <span className="figure ghost">—</span>}</div>
      {ev && projected && <p className="note">Projected: {shapeCount(listedCounts) === 0 ? 'prizes not listed yet' : 'some prizes not listed yet'}.</p>}
      {ev && savedEv && editing && savedEv.drawPrice !== ev.drawPrice && <p className="note">{stocking ? 'Saved design, projected:' : 'Now'} {eth(savedEv.drawPrice, 5)} ETH{markupBps !== d.markupBps ? '. Listed prizes keep their price until they are won and restocked.' : '.'}</p>}
      {ev && pausesAt < backlog && <p className="note">{pausesAt === 1
        ? 'With this mix, a new purchase waits while an earlier draw is unreconciled. More small Shapes let more draws run at once.'
        : `With this mix, new purchases pause once ${pausesAt} earlier draws are unreconciled. A batch can put more draws in flight. More small Shapes raise the threshold.`}</p>}
    </div>
  );
  const gridBlock = (
    <div>
      <div className="seg" role="group" aria-label="View">
        <button aria-pressed={gridView === 'inventory' || !view} onClick={() => setGridView('inventory')}>Inventory</button>
        <button aria-pressed={gridView === 'draws' && !!view} disabled={!view} onClick={() => setGridView('draws')}>Out of 100 draws</button>
      </div>
      {!view ? null
        : gridView === 'inventory' ? <InventoryGrid items={items} />
          : <div className="grid100" aria-hidden="true">{cells.map((g, k) => <span key={k} style={sw(g)} />)}</div>}
      {view && <button className="disclose" style={{ fontSize: 14 }} aria-expanded={showKey} onClick={() => setShowKey(!showKey)}>{showKey ? 'Hide key ▴' : 'Show key ▾'}</button>}
      {view && showKey && (gridView === 'inventory' ? (
        <div className="legend">
          {ordered.map(({ g }) => (g.nft
            ? <div key={g.key}><span className="sw" style={sw(g)} /><span><b>{bases.length}</b> curated NFT{bases.length === 1 ? '' : 's'} · {oneIn(view.curated)} draws for any of them</span></div>
            : <div key={g.key}><span className="sw" style={sw(g)} /><span><b>{g.n}</b> × {prizeLabel(g.i)} · each {oneIn(g.p / g.n)}</span></div>))}
        </div>
      ) : (
        <div className="legend">
          {ordered.map(({ g, n }) => (
            <div key={g.key}><span className="sw" style={sw(g)} /><span><b>{n === 0 ? '<1' : n}</b> {legend(g, n)}{g.p < 0.05 && <span className="muted"> ({oneIn(g.p)})</span>}</span></div>
          ))}
          <p className="note">Rounded to whole draws.</p>
        </div>
      ))}
    </div>
  );
  const figureEth = (v: bigint | undefined, dp = 3) => (v === undefined
    ? <span className="figure-s muted">—</span>
    : <span><span className="figure-s">{eth(v, dp)}</span><span className="unit">ETH</span></span>);
  // What saving does, in order. The predicted address receives approvals before atomic creation.
  const toList = pending.filter(({ n }) => n.collection && ethOr(n.value, 0n) > 0n).map(({ n }) => n);
  // Prizes above a smaller mix are unlisted and redeemed (up to 20 per transaction; the rest from Settings).
  const nftWord = (k: number) => `${k === 1 ? 'your' : word(k)} NFT${k === 1 ? '' : 's'}`;
  const actions = mode === 'new'
    ? [toList.length > 0 && `approve ${nftWord(toList.length)}`, `create the configured pool with ${eth(deposit, 6)} ETH and enter stocking`].filter(Boolean) as string[]
    : [configChanged && (feeOnly ? `accept the ${eth(d.mintFee, 6)} ETH Shapes mint fee` : 'save the design'),
      rateChange && `set the earnings rate to ${reviewedRate / 100}% of sales`, toList.length > 0 && `approve and list ${nftWord(toList.length)}`,
      shortBy > 0n && `deposit ${eth(shortBy, 6)} ETH`, extra.length > 0 && `unlist ${word(extra.length)} extra prizes`,
      (toList.length > 0 || configChanged) && 'run upkeep'].filter(Boolean) as string[];
  const confirmations = mode === 'new' ? toList.length + 1
    : (shortBy > 0n ? 1 : 0) + (toList.length ? toList.length + Math.ceil(toList.length / LIST_BATCH) : 0) + (configChanged ? 1 : 0) + (rateChange ? 1 : 0) + (extra.length ? 1 : 0) + (actions.length ? 1 : 0);
  const sentence = (xs: string[]) => cap(xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] ?? '');
  const wallet = create?.wallet;
  const blocked = (d as { feesLoading?: boolean }).feesLoading ? 'Loading current fees…'
    : d.policyUnavailable ? 'Current fees are unavailable. Retrying.'
    : d.mintFeeUnavailable ? 'The Shapes mint fee is unavailable.'
    : !revenueValid ? 'Choose pool creator earnings from 0% to 100%.'
    : !markupAllowed(limits, markupBps, has ? d.markupBps : 0) ? `Choose a markup from ${limits.minMarkupBps / 100}% to ${limits.maxMarkupBps / 100}%${has && !limits.fixed ? `, or keep ${d.markupBps / 100}%` : ''}.`
    : mode === 'new' && toList.length > LIST_BATCH ? 'Create with up to 20 curated NFTs. Add the others after creation.'
    : !ready ? undefined
    : !ev?.feasible ? undefined
        : mode === 'new' && create?.prereq && !(create.prereq.creation && create.prereq.impl) ? 'Pool creation is not available right now.'
            : (mode === 'new' ? deposit : shortBy) > (wallet ?? 2n ** 255n) ? `Your wallet has ${eth(wallet)} ETH.`
              : !actions.length ? 'Saved. Nothing has changed.' : undefined;
  const restrictKey = toList.map((n) => nftKey(n.collection!, n.tokenId!)).join();

  // On a configured pool: the saved design next to the one being edited.
  // The "Now" column is the board as listed: the saved markup and each Shape's actual FWA price.
  const run = async () => {
    if (!pub || !me || blocked) return;
    if (mode === 'new') {
      const saved = loadDraft()?.creation;
      if (saved) { create?.resumeCreation(saved); return; }
      if (creationStarting.current) return;
      creationStarting.current = true;
    }
    try {
      // The creation binds the keeper settings the creator reviewed; changed ones need a new review, not a silent swap.
      const reviewedHash = create?.reviewedHash;
      if (mode === 'new' && (!reviewedHash || await pub.readContract({ address: FACTORY, abi: balancerFactoryAbi, functionName: 'creationSettingsHash' }) !== reviewedHash)) {
        setStaleReview(reviewedHash ?? '0x');
        return;
      }
      if (restricted !== restrictKey && await refusesContracts(pub, me, toList)) { setRestricted(restrictKey); return; }
      const balancer = mode === 'new'
        ? (await pub.readContract({ address: FACTORY, abi: balancerFactoryAbi, functionName: 'predictBalancer', args: [me, salt] })) as Address
        : d.balancer;
      const refused = await refusedApprovals(pub, me, balancer, toList);
      setRefused(refused.length ? `This pool cannot list ${refused.join(', ')}: the collection does not let this pool take the NFT. Choose another NFT.` : undefined);
      if (refused.length) return;
      const B = { address: balancer, abi: poolBalancerAbi } as const;
      const steps: Step[] = [];
      steps.push(...approveSteps(pub, tx, me, balancer, toList));
      if (mode === 'new') {
        const config = { markupBps, creatorRevenueBps: reviewedRate, target, mintFeeCap: d.mintFee, curatedRequired: curatedRequired && toList.length > 0, settingsHash: reviewedHash! };
        const curated = toList.map((n) => ({ collection: n.collection!, tokenId: BigInt(n.tokenId!), base: ethOr(n.value, 0n) }));
        const attempt: CreationAttempt = { chainId: chain.id, factory: FACTORY, creator: me, salt, predicted: balancer,
          config: { ...config, target: String(target), mintFeeCap: String(d.mintFee) },
          curated: curated.map((n) => ({ ...n, tokenId: String(n.tokenId), base: String(n.base) })), value: String(deposit) };
        saveDraft(current());
        steps.push(['Create and stock pool', async () => {
          await submitCreation(attempt,
            (beforeWallet) => tx.write({ address: FACTORY, abi: balancerFactoryAbi, functionName: 'createBalancer',
              args: [salt, config, curated], value: deposit }, beforeWallet),
            { existing: () => loadDraft()?.creation, store: create!.trackCreation, reject: create!.rejectCreation }, pub);
          const outcome = await waitForCreation(pub, loadDraft()!.creation!,
            { chainId: chain.id, factory: FACTORY, creator: me }, create!.trackCreation);
          if (outcome !== 'confirmed') throw new Error(creationStatus(outcome));
          return undefined;
        }]);
      } else {
        // community-v1 configure takes no accepted fee: it accepts the fee live when the transaction runs.
        if (configChanged) steps.push([feeOnly ? 'Accept mint fee' : 'Save design', () => d.legacy
          ? tx.write({ address: balancer, abi: d.legacy.poolBalancerAbi, functionName: 'configure', args: [markupBps, target] })
          : tx.write({ ...B, functionName: 'configure', args: [markupBps, target, d.mintFee] })]);
        if (rateChange) steps.push(rateStep(tx, balancer, reviewedRate));
        steps.push(...listSteps(toList, (batch) => tx.write({ ...B, functionName: 'listCuratedBatch', args: [batch] })));
        if (shortBy > 0n) steps.push([`Deposit ${eth(shortBy, 6)} ETH`, () => tx.write({ ...B, functionName: 'depositETH', value: shortBy })]);
        if (extra.length) steps.push(['Unlist extra prizes', () => tx.write({ ...B, functionName: 'unlistShapes', args: [extra.map((listing) => listing.id)] })]);
        steps.push(upkeepStep(pub, tx, me, balancer));
      }
      if (!(await values.confirm(toList))) return;
      const ok = await tx.send(mode === 'new' ? 'Create pool' : 'Save', steps, mode === 'new' ? 15_000 : undefined);
      if (mode !== 'new' && ok) { clearDraft(); setNfts([]); }
    } finally {
      creationStarting.current = false;
    }
  };

  // A new pool follows the factory's keeper economics; these are the values the creation binds.
  const e = d.economics as Economics | undefined;
  const creationEconomics = mode !== 'pool' && <div className="kv-group" style={{ marginBottom: 16 }}>
    <span className="label">Keeper pay rates: follow factory (default)</span>
    {e ? <>
      <div className="kv"><span className="k">Work fee per processed or reconciled draw and listed Shape</span><span>{formatEther(e.workFee)} ETH</span></div>
      <div className="kv"><span className="k">Gas price ceiling</span><span>{formatGwei(e.gasPriceCeiling)} gwei</span></div>
      <div className="kv"><span className="k">Maximum payment per call</span><span>{formatEther(maxPaymentOf(e))} ETH</span></div>
      <div className="kv"><span className="k">Maximum restocking charge per Shape</span><span>{formatEther(maxSurchargeOf(e))} ETH</span></div>
      {create?.bucket && <>
        <div className="kv"><span className="k">Spending limit</span><span>{formatEther(create.bucket.capacity)} ETH</span></div>
        <div className="kv"><span className="k">Spending limit refill</span><span title={`${create.bucket.refill} wei per second`}>{formatEther(refillPerDay(create.bucket.refill))} ETH per day</span></div>
      </>}
    </> : <p className="note">Loading.</p>}
    <p className="note">Factory rate changes apply to the pool immediately. The pool keeps this spending limit. After creation you can keep the factory's current rates or set your own, and change the spending limit, in Settings.</p>
  </div>;
  const staleShown = mode === 'new' && staleReview !== undefined && staleReview === (create?.reviewedHash ?? '0x');
  const save = mode === 'preview' ? (
    <div className="pin">
      {creationEconomics}
      <ConnectButton.Custom>{({ openConnectModal }) => <button className="btn lg" onClick={() => { markConnectIntent(); openConnectModal(); }}>Connect wallet to create this pool</button>}</ConnectButton.Custom>
    </div>
  ) : (
    <div className="pin">
      {creationEconomics}
      {staleShown && <div style={{ marginBottom: 12 }} role="alert">
        <p className="note error">The factory's keeper pay rates, default spending limit or the Shapes mint fee changed since this review.</p>
        <button className="btn sec" onClick={() => create?.reload?.()}>Refresh to review the current values</button>
      </div>}
      {restricted === restrictKey && toList.length > 0 && (
        <p className="note error" style={{ marginBottom: 12 }}>A collection here refuses transfers to contracts. A buyer using a contract that never claims its refund can lock that NFT in FWA escrow permanently. In a pool with few listings, that can cost the buyer much less than the NFT is worth.</p>
      )}
      <button className="btn lg" disabled={!!tx.busy || !!blocked || !ready || !ev?.feasible || staleShown} onClick={run}>
        {tx.busy ? `${tx.busy}…` : restricted === restrictKey && toList.length ? 'Continue anyway' : mode === 'new' ? `Create pool with ${eth(deposit, 2)} ETH` : feeOnly ? `Accept the ${eth(d.mintFee, 6)} ETH mint fee` : 'Save changes'}
      </button>
      {has && !d.mintFeeUnavailable && d.mintFee !== d.mintFeeCap && <p className="note" style={{ marginTop: 10 }}>Shapes mint fee: {eth(d.mintFee, 6)} ETH now, {eth(d.mintFeeCap, 6)} ETH accepted. Saving accepts {d.legacy ? 'the fee live when the transaction runs' : `at most ${eth(d.mintFee, 6)} ETH`}.</p>}
      {blocked && <p className="note" style={{ marginTop: 10 }}>{blocked}</p>}
      {refused && <p className="note error" style={{ marginTop: 10 }}>{refused}</p>}
      {fresh && tx.msg && !tx.msg.ok && <p className="note error" style={{ marginTop: 10 }}>{tx.msg.text}</p>}
    </div>
  );

  // One row per NFT: listed ones are fixed; a chosen one takes a value; an unchosen one (or none yet) is a placeholder.
  const chooser = (i: number) => picking === i && me && (
    <NftChooser me={me}
      exclude={[...listedKeys, ...nfts.filter((x, j) => j !== i && x.collection).map((x) => nftKey(x.collection!, x.tokenId!))]}
      onPick={(xs) => {
        const at = nfts[i] ?? DEFAULT_NFT;
        setPicking(undefined);
        setNfts([...nfts.slice(0, i), { ...at, ...xs[0], value: floorValue(xs[0].floor) }, ...nfts.slice(i + 1),
          ...xs.slice(1).map((x) => ({ ...x, value: floorValue(x.floor) }))]);
      }} />
  );
  const removeRow = (i: number) => { setPicking(undefined); setNfts(nfts.filter((_, j) => j !== i)); };
  const placeholder = (i: number) => (
    <Fragment key={`p${i}`}>
      <div className="nft-empty">
        <div className="slot" aria-hidden="true">+</div>
        <div className="id"><div className="t">No curated NFTs</div><div className="s">{mode === 'preview' ? 'Optional. Connect a wallet to choose one from it.' : 'Optional. Choose one from your wallet, then set its value.'}</div></div>
        {mode === 'preview'
          ? <ConnectButton.Custom>{({ openConnectModal }) => <button className="btn" onClick={() => { markConnectIntent(); openConnectModal(); }}>Connect wallet</button>}</ConnectButton.Custom>
          : <button className="btn" onClick={() => setPicking(picking === i ? undefined : i)}>{picking === i ? 'Cancel' : 'Choose from your wallet'}</button>}
        {i < nfts.length && pending.length > 1 && <button className="link quiet rm" onClick={() => removeRow(i)}>Remove</button>}
      </div>
      {chooser(i)}
    </Fragment>
  );
  const unchosenRows = pending.filter(({ n }) => !n.collection).map(({ i }) => i);
  const slots = listed.length + pending.length === 0 ? [nfts.length] : unchosenRows;
  const nftGroup = (
    <div className="group">
      <div className="group-head">
        <span className="mk mk-nft" aria-hidden="true" />
        <div><h2>Curated NFTs</h2><p className="desc">Optional rare prizes from your wallet. The value is your asking price: across the draws until it is won, players pay about that. A higher value makes it rarer.</p></div>
      </div>
      <div className="group-body nfts-list">
        {listed.map((l) => (
          <div className="nft-row" key={l.id.toString()}>
            <Thumb n={{ collection: l.collection, tokenId: l.tokenId }} />
            <div className="id"><div className="t"><a className="tlink" href={openSeaAsset(l.collection, l.tokenId)} target="_blank" rel="noreferrer" title="View on OpenSea">{nftName(l)}</a></div><div className="s">Listed{oddsLine(`l${l.id}`) && ` · ${oddsLine(`l${l.id}`)}`}</div></div>
            <div className="val"><span className="vl">Value</span><span className="big-v">{eth(l.base)} <small>ETH</small></span></div>
          </div>
        ))}
        {pending.map(({ n, i }) => {
          if (unchosenRows.includes(i)) return placeholder(i);
          const name = nftLabel(n);
          const sub = [oddsLine(`d${i}`), n.floor && `collection floor ${floorText(n.floor)}`].filter(Boolean).join(' · ');
          return (
            <div className="nft-row" key={i}>
              {n.collection && <Thumb key={nftKey(n.collection, n.tokenId!)} n={{ collection: n.collection, tokenId: BigInt(n.tokenId!), image: n.image }} />}
              <div className="id">
                <div className="t">{n.collection ? <a className="tlink" href={openSeaAsset(n.collection, n.tokenId!)} target="_blank" rel="noreferrer" title="View on OpenSea">{name}</a> : name}</div>
                {sub && <div className="s">{sub}</div>}
              </div>
              <div className="val">
                <label className="vl" htmlFor={`nft-value-${i}`}>Value</label>
                <div className="field"><input id={`nft-value-${i}`} className="big" aria-label={`Value of ${name}`} value={n.value} onChange={(e) => setNft(i, { value: e.target.value })} inputMode="decimal" /><span className="u">ETH</span></div>
              </div>
              <button className="link quiet rm" aria-label={`Remove ${name}`} onClick={() => removeRow(i)}>Remove</button>
            </div>
          );
        })}
        {slots.filter((i) => i === nfts.length).map(placeholder)}
        {!slots.length && (
          <div>
            <button className="link" onClick={() => setPicking(picking === nfts.length ? undefined : nfts.length)}>{picking === nfts.length ? 'Cancel' : '+ Add another curated NFT'}</button>
            {chooser(nfts.length)}
          </div>
        )}
        {fresh && rows.length > 0 && (
          <label className="check" style={{ marginTop: 14 }}>
            <input type="checkbox" checked={curatedRequired} onChange={(e) => setCuratedRequired(e.target.checked)} />
            <span>Pause purchases while no curated NFT is available</span>
          </label>
        )}
      </div>
    </div>
  );

  return (
    <main className="page cols design">
      {values.modal}
      <section>
        {mode === 'pool'
          ? <h2 className="title t2">Prices & mix</h2>
          : <h1 className="title">Design your pool</h1>}
        <p className="lead">{has
          ? `What players pay and which Shapes the pool keeps. Your ${rows.length === 1 ? 'NFT stays' : `${rows.length} NFTs stay`} as listed; change ${rows.length === 1 ? 'it' : 'them'} on the NFTs tab.`
          : 'Players pay a draw price and win one prize at random. Your pool holds two kinds of prizes: curated NFTs from your wallet, and Shapes you fund with ETH.'}</p>
        <div className="row" style={{ marginTop: 14, gap: 24 }}>
          {!has && <button className="disclose" aria-expanded={how} onClick={() => setHow(!how)}>How a pool works {how ? '▴' : '▾'}</button>}
          <button className="link quiet" onClick={reset}>{has ? 'Reset to saved' : 'Reset to defaults'}</button>
        </div>
        {how && !has && (
          <ol className="how">
            <li>Players pay a draw price on FWA. Every draw wins one prize: one of your NFTs or a Shape.</li>
            <li>Your NFTs are the prizes you give away. You set each one's value; a lower value is won more often.</li>
            <li>A Shape is a token that holds a fixed amount of ETH, from 0.01 to 100. The winner can redeem it for that ETH.</li>
            <li>Your ETH buys the Shapes. When one is won, upkeep uses available operating ETH and collected sales to replace it. A shortage can delay replenishment.</li>
            <li>Shape markup changes listing prices. Your earnings are what the markup brings in above 10%; the rest of each sale stays in the pool to restock it. Curated NFTs carry no markup.</li>
            <li><a className="link" href="#how">More in How it works</a></li>
          </ol>
        )}

        {!has && nftGroup}

        <div className="group">
          <div className="group-head">
            <span className="mk mk-shapes" aria-hidden="true"><span style={{ background: '#333' }} /><span style={{ background: '#7a7a7a' }} /><span style={{ background: '#fff' }} /></span>
            <div><h2>Shapes</h2><p className="desc">ETH-backed prizes that make up most draws. Upkeep replenishes won Shapes when operating ETH is available.</p></div>
          </div>
          <div className="group-body">
            <div>
              <h3 className="ctl" id="style-label">Shape style</h3>
              <div className="tiles" role="group" aria-labelledby="style-label">
                {GAME_STYLES.map((g) => (
                  <button key={g.key} aria-pressed={style === g.key} onClick={() => choose(g.key)}>
                    <span className="t">{g.label}</span><span className="s">{g.hint}</span>
                  </button>
                ))}
              </div>
              <div className="row" style={{ marginTop: 14, gap: 16 }}>
                <button className="disclose" aria-expanded={open.bonus} onClick={() => toggle('bonus')}>Adjust prizes by hand {open.bonus ? '▴' : '▾'}</button>
                {bases.length > 0 && !ready ? <span className="note error">No mix reaches these odds.</span>
                  : !style && ready && <span className="note">Custom: {mixText(counts)}</span>}
              </div>
              {open.bonus && (
                <div style={{ marginTop: 14 }}>
                  <p className="note" style={{ marginBottom: 6 }}>Exact prize counts. Any size can be zero. Bigger prizes raise the draw price and the ETH needed.</p>
                  {BY_VALUE.map((i) => {
                    const t = counts[i] ? tierOf(i) : undefined;
                    return (
                      <div className="mixrow" key={i}>
                        <div><div className="t">{prizeLabel(i)}</div>{t && <div className="s">Each {oneIn(t.odds / counts[i])} draws · {t.multiple.toFixed(1)}× the draw</div>}</div>
                        <div className="stepper end">
                          <button aria-label={`One fewer ${prizeLabel(i)}`} disabled={!counts[i]} onClick={() => setCountAt(i, counts[i] - 1)}>−</button>
                          <output aria-live="polite">{counts[i]}</output>
                          <button aria-label={`One more ${prizeLabel(i)}`} disabled={total >= maxPrizes} onClick={() => setCountAt(i, counts[i] + 1)}>+</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="rule">
              <div className="ctl-row"><label className="ctl" htmlFor="small">Shape pool size</label><span className="big-v">{total} <small>prize{total === 1 ? '' : 's'}</small></span></div>
              <input id="small" type="range" min={style ? 1 : 0} max={maxSmall} step={1} value={counts[0]} aria-valuetext={`${total} prizes`}
                onChange={(e) => setSmall(Number(e.target.value))} />
              <p className="note">More prizes make curated NFTs rarer and the draw cheaper.</p>
            </div>
            <div className="rule">
              <div className="ctl-row"><label className="ctl" htmlFor="markup">Shape markup</label><span className="big-v">{markup}%</span></div>
              <input id="markup" type="range" min={markupRange.min} max={markupRange.max} step={0.25} value={markup} onChange={(e) => setMarkup(Number(e.target.value))} />
              <p className="note">Added to each new Shape listing price.</p>
              <p className="note" style={{ marginTop: 6 }}>Each new Shape's price also includes a restocking charge that follows gas when it is listed. <a className="link" href="#how-restock">How the restocking charge works</a></p>
              {has && <p className="note" style={{ marginTop: 6 }}>A markup change applies to Shapes listed after it. Listed prizes keep their price.</p>}
            </div>
            <div className="rule"><LimitsNote limits={limits} currentPrizes={shapeCount(savedCounts)} /></div>
          </div>
        </div>

        <div className="mobile-only" style={{ marginTop: 40 }}>{payBlock}{gridBlock}{playBlock}</div>

      </section>

      <section className="sticky results">
        <div className="desktop-only">{payBlock}</div>
        <div className="desktop-only">{gridBlock}</div>
        {playBlock && <div className="desktop-only">{playBlock}</div>}
        <div className="totals">
          {fresh ? (
            <div><span>To create the pool</span>{figureEth(ev && deposit, 6)}</div>
          ) : (
            <>
              <div><span>Required operating capital{savedEv && now(`${eth(ethNeeded(savedCounts, { ...base, mintFee: savedReserveFee, enabled: fundForOpen }))} ETH`, `${eth(needed)} ETH`)}</span>{figureEth(ev && needed, 6)}</div>
              <div><span>Available in the pool</span>{figureEth(have)}</div>
              {shortBy > 0n
                ? <div><b>Deposited when you save</b>{figureEth(shortBy, 6)}</div>
                : <div><span>Above the operating requirement</span>{figureEth(ev && have - needed, 6)}</div>}
            </>
          )}
          <div><span>Expected pool creator earnings per draw</span><span>{econ ? `${perDraw(econ.creatorEarningsPerDraw)} ETH` : 'Unavailable'}</span></div>
          <div><span>Expected revenue retained by the pool</span><span>{econ ? `${perDraw(econ.retainedRevenuePerDraw)} ETH` : 'Unavailable'}</span></div>
          <div><span>Expected replacement backing</span><span>{econ ? `${perDraw(econ.replacementCostsPerDraw)} ETH` : 'Unavailable'}</span></div>
          <div><span>Expected mint costs</span><span>{econ ? `${perDraw(econ.mintFeesPerDraw)} ETH` : 'Unavailable'}</span></div>
          <div><span>Estimated keeper costs</span><span>{econ?.keeperPayPerDraw === undefined ? 'Unavailable' : `${perDraw(econ.keeperPayPerDraw)} ETH`}</span></div>
          <div><span>Replenishment margin or shortfall</span><span>{econ?.marginPerDraw === undefined ? 'Unavailable' : `${signed(econ.marginPerDraw)} ETH`}</span></div>
        </div>
        {d.listings.some(isStaged) && <p className="note" role="status">Current odds exclude staged prizes. Edited mix projections assume future activation.</p>}
        {!d.restockQuoteVerified && <p className="note" role="status">Restocking charges and player prices are unverified estimates.</p>}
        {reviewedRate === 10_000 ? <p className="note error">100% leaves no new owner proceeds for pool operations.</p>
          : econ?.marginPerDraw !== undefined && econ.marginPerDraw < 0 && <p className="note error">Sales do not cover replenishment.</p>}
        <p className="note">Capital is quoted at current gas. Higher gas or mint fees can require more ETH. Missing prizes may be replenished in stages.</p>
        {!d.paidUpkeepEnabled && <p className="note">Keeper pay is off. Setup and restocking need someone to run maintenance unpaid; the caller pays transaction gas.</p>}
        {save}
        {view && ev && econ && (
          <div>
            <button className="disclose" aria-expanded={open.numbers} onClick={() => toggle('numbers')}>All numbers {open.numbers ? '▴' : '▾'}</button>
            {open.numbers && (
              <div className="numbers">
                <div className="kv-group">
                  <span className="label">For players</span>
                  <div className="kv"><span className="k">{projected ? 'Draw price, projected' : 'Draw price'}</span><span>{eth(ev.drawPrice, 5)} ETH</span></div>
                  {vrfKnown && <div className="kv"><span className="k">FWA's randomness fee, at today's gas</span><span>{eth(d.vrfFee!, 5)} ETH</span></div>}
                  {common && <div className="kv"><span className="k">Most draws ({pctOf(common.odds)})</span><span>{prize(common)} · {common.multiple.toFixed(2)}×</span></div>}
                  {bases.length > 0 && <div className="kv"><span className="k">Wins a curated NFT</span><span>{oneIn(view.curated)} · {pctOf(view.curated)}</span></div>}
                  <div className="kv"><span className="k">Wins more than the draw price</span><span>{oneIn(view.winMore)} · {pctOf(view.winMore)}</span></div>
                  <div className="kv"><span className="k">Wins 2× or more</span><span>{oneIn(view.win2x)} · {pctOf(view.win2x)}</span></div>
                  <div className="kv"><span className="k">Top prize</span><span>{eth(view.top.value, 3).replace(/\.?0+$/, '')} ETH · {oneIn(view.top.odds)}</span></div>
                  <div className="kv"><span className="k">Average prize value</span><span>{(view.avgReturn * 100).toFixed(0)}% of the draw price</span></div>
                </div>
                <div className="kv-group">
                  <span className="label">For you</span>
                  {fresh && <>
                    <div className="kv"><span className="k">Initial mint fees</span><span>{eth((capital?.inventoryCost ?? 0n) - capitalOf(counts), 6)} ETH</span></div>
                    <div className="kv"><span className="k">Initial paid listing budget</span><span>{eth(capital?.listingBudget ?? 0n, 6)} ETH</span></div>
                    <div className="kv"><span className="k">Maintenance buffer</span><span>{eth(capital?.workingBuffer ?? 0n, 6)} ETH</span></div>
                    {deposit > needed && <div className="kv"><span className="k">Rounded up</span><span>{eth(deposit - needed, 6)} ETH</span></div>}
                  </>}
                  <div className="kv"><span className="k">Prize backing</span><span>{eth(ev.capital)} ETH</span></div>
                  <div className="kv"><span className="k">{fresh ? 'Needed to open' : 'Required operating capital'}</span><span>{eth(needed)} ETH</span></div>
                  <div className="kv"><span className="k">{fresh ? 'Deposited' : 'Available'}</span><span>{eth(have)} ETH</span></div>
                  <div className="kv"><span className="k">Keeper pay per draw, from your ETH</span><span>{econ.keeperCostKnown ? `${econ.keeperPayPerDraw?.toFixed(5)} ETH` : 'Quote unavailable'}</span></div>
                  <div className="kv"><span className="k">Mint and restocking fees per draw</span><span>{(econ.mintFeesPerDraw + econ.restockFeesPerDraw).toFixed(5)} ETH</span></div>
                  <div className="kv"><span className="k">Restocking charge per Shape at current gas</span><span>{eth(d.restockFee!, 5)} ETH</span></div>
                </div>
                {mode !== 'preview' && !blocked && ev.feasible && actions.length > 0 && <p className="note" style={{ marginTop: 14 }}>{sentence(actions)}. Up to {confirmations} confirmations in your wallet.</p>}
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

function Nfts({ d, tx, isCreator, me, setTab }: { d: D; tx: Tx; isCreator: boolean; me: Address; setTab: (t: Tab) => void }) {
  const B = { address: d.balancer, abi: poolBalancerAbi } as const;
  const curated = d.listings.filter((l) => l.kind === 1 && l.state === 1 && (isSelectable(l) || isStaged(l)));
  const selectableCurated = curated.filter(isSelectable);
  const [edit, setEdit] = useState<{ id: bigint; value: string }>();
  const [stray, setStray] = useState({ open: false, collection: '', tokenId: '' });
  const odds = (l: Listing) => (d.totalWeight ? Number(l.weight) / Number(d.totalWeight) : 0);
  const name = (l: Listing) => `${d.names[l.collection] ?? short(l.collection)} #${l.tokenId}`;
  return (
    <main className="page cols design">
      <section>
        <h2 className="title t2">NFTs</h2>
        <div className="group">
          <div className="group-head">
            <span className="mk mk-nft" aria-hidden="true" />
            <div><h2>Curated NFTs</h2><p className="desc">{selectableCurated.length === 1 ? 'One NFT' : `${word(selectableCurated.length)} NFTs`} players can win. The value is your asking price; a higher value makes it rarer.</p></div>
          </div>
          <div className="group-body nfts-list">
            {d.historyLoading && <p className="note">Loading failed delivery history…</p>}
            {d.historyError && <p className="note error">Failed delivery history unavailable: {d.historyError}</p>}
            {curated.length === 0 && d.pending.length === 0 && <p className="note">No curated NFTs listed.</p>}
            {curated.map((l) => {
              const editing = edit?.id === l.id;
              return (
                <div className="nft-row" key={l.id.toString()}>
                  <Thumb n={{ collection: l.collection, tokenId: l.tokenId }} />
                  <div className="id">
                    <div className="t"><a className="tlink" href={openSeaAsset(l.collection, l.tokenId)} target="_blank" rel="noreferrer" title="View on OpenSea">{name(l)}</a></div>
                    <div className="s">{isStaged(l) ? 'Staged · not selectable yet' : `Won about ${oneIn(odds(l))} draws`}</div>
                  </div>
                  <div className="val">
                    <span className="vl">Value</span>
                    {editing
                      ? <div className="field"><input className="big" aria-label={`New value of ${name(l)}`} value={edit.value} onChange={(e) => setEdit({ id: l.id, value: e.target.value })} inputMode="decimal" autoFocus /><span className="u">ETH</span></div>
                      : <span className="big-v">{eth(l.base)} <small>ETH</small></span>}
                  </div>
                  {isCreator && (
                    <div className="acts">
                      {editing
                        ? <>
                            <button className="btn" disabled={!!tx.busy || !edit.value} onClick={() => tx.send('Change value', [() => tx.write({ ...B, functionName: 'updateCuratedPrice', args: [l.id, ethOr(edit.value, 0n)] })]).then((ok) => ok && setEdit(undefined))}>Save</button>
                            <button className="link quiet" onClick={() => setEdit(undefined)}>Cancel</button>
                          </>
                        : <>
                            <button className="link" onClick={() => setEdit({ id: l.id, value: eth(l.base) })}>Change value</button>
                            <button className="link quiet" disabled={!!tx.busy} onClick={() => tx.send('Withdraw', [() => tx.write({ ...B, functionName: 'withdrawCurated', args: [l.id, me] })])}>Withdraw</button>
                          </>}
                    </div>
                  )}
                </div>
              );
            })}
            {d.pending.map((l) => {
              const refunded = l.fwaStatus === L_DELIVERY_REFUNDED;
              return (
                <div className="nft-row" key={l.id.toString()}>
                  <div className="thumb">{l.kind === 2 ? 'Shape' : 'NFT'}</div>
                  <div className="id">
                    <div className="t">{l.kind === 2 ? prizeLabel(l.denom) : name(l)}</div>
                    <div className="s">{refunded ? 'Drawn. FWA refunded the buyer; you can take it back.' : 'Drawn. FWA could not deliver it. Anyone can retry for 7 days; after that the winner can take a refund, then you can take it back.'}</div>
                  </div>
                  {refunded && isCreator && <div className="acts"><button className="link" disabled={!!tx.busy} onClick={() => tx.send(l.kind === 1 ? 'Recover' : 'Recover and redeem', [() => tx.write({ ...B, functionName: 'recoverRefunded', args: [l.id, me] })])}>Recover</button></div>}
                </div>
              );
            })}
          </div>
        </div>
      </section>
      {isCreator && (
        <section className="sticky results">
          <AddNft d={d} tx={tx} me={me} setTab={setTab} />
          <div className="section">
            <button className="disclose quiet" onClick={() => setStray({ ...stray, open: !stray.open })}>Return an NFT sent to the pool directly {stray.open ? '▴' : '▾'}</button>
            {stray.open && (
              <>
                <label className="form-label" htmlFor="stray-c">Collection address</label>
                <div className="field"><input id="stray-c" className="mono" placeholder="0x…" value={stray.collection} onChange={(e) => setStray({ ...stray, collection: e.target.value })} /></div>
                <label className="form-label" htmlFor="stray-t">Token ID</label>
                <div className="field"><input id="stray-t" value={stray.tokenId} onChange={(e) => setStray({ ...stray, tokenId: e.target.value })} inputMode="numeric" /></div>
                <button className="btn sec" style={{ marginTop: 14 }} disabled={!!tx.busy || !stray.collection || !stray.tokenId} onClick={() => tx.send('Return NFT', [() => tx.write({ ...B, functionName: 'recoverUntrackedNFT', args: [stray.collection as Address, BigInt(stray.tokenId), me] })])}>Return to my wallet</button>
                <p className="note" style={{ marginTop: 8 }}>Only NFTs the pool holds outside FWA. Listed and drawn NFTs stay with FWA.</p>
              </>
            )}
          </div>
        </section>
      )}
    </main>
  );
}

/** A modal that lists each curated NFT with the value it will be listed at, before any transaction is sent. `confirm`
 *  resolves true on Confirm and false on Back or Escape; with no NFTs it resolves true at once. */
function useConfirmValues() {
  const [ask, setAsk] = useState<{ items: DraftNft[]; done: (ok: boolean) => void }>();
  const confirm = (items: DraftNft[]) => (items.length ? new Promise<boolean>((done) => setAsk({ items, done })) : Promise.resolve(true));
  const close = (ok: boolean) => { ask?.done(ok); setAsk(undefined); };
  return { confirm, modal: ask && <ConfirmValuesModal items={ask.items} onClose={close} /> };
}

function ConfirmValuesModal({ items, onClose }: { items: DraftNft[]; onClose: (ok: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="modal" aria-labelledby="confirm-values" onCancel={(e) => { e.preventDefault(); onClose(false); }}>
    <h2 className="h" id="confirm-values">Confirm NFT values</h2>
    <p className="desc">Each NFT is listed on FWA at the value below.</p>
    <div className="modal-rows">
      {items.map((n) => {
        const v = Number(n.value);
        const below = !!n.floor && v < n.floor;
        return <div className="kv" key={nftKey(n.collection!, n.tokenId!)}>
          <span className="k">{nftLabel(n)}{n.floor !== undefined && <span className={`sub${below ? ' error' : ''}`}>{n.value === floorValue(n.floor) ? 'Collection floor' : below ? `Below the ${floorValue(n.floor)} ETH collection floor` : `Collection floor ${floorValue(n.floor)} ETH`}</span>}</span>
          <span className="v">{n.value} ETH</span>
        </div>;
      })}
    </div>
    <div className="acts">
      <button className="btn" autoFocus onClick={() => onClose(true)}>Confirm {items.length === 1 ? 'value' : `${items.length} values`}</button>
      <button className="btn sec" onClick={() => onClose(false)}>Back</button>
    </div>
  </dialog>;
}

/** Lists one more NFT on a live pool, showing what it does to the draw price and NFT odds under the saved mix first. */
function AddNft({ d, tx, me, setTab }: { d: D; tx: Tx; me: Address; setTab: (t: Tab) => void }) {
  const pub = usePublicClient();
  const [picks, setPicks] = useState<DraftNft[]>([]);
  const [choosing, setChoosing] = useState(true);
  const [restricted, setRestricted] = useState<string>();
  const [refused, setRefused] = useState<string>();
  const listed = d.listings.filter((l) => l.kind === 1 && isSelectable(l));
  const bases = listed.map((l) => l.base);
  const keyOf = (n: DraftNft) => nftKey(n.collection!, n.tokenId!);
  const key = picks.map(keyOf).join();
  const ready = picks.length > 0 && picks.every((n) => ethOr(n.value, 0n) > 0n);
  const values = useConfirmValues();
  const newBases = picks.map((n) => ethOr(n.value, 0n)).filter((v) => v > 0n);
  const plan = d.target ? listedShapeCounts(d.listings) : undefined;
  const livePrices: bigint[][] = [];
  for (const l of d.listings) if (l.kind === 2 && isSelectable(l)) (livePrices[l.denom] ??= []).push(l.price);
  const inputs: DesignInputs = {
    curatedBases: bases, curatedPrices: listed.map((l) => l.price), markupBps: d.markupBps, creatorRevenueBps: d.creatorRevenueBps, edgeBps: Number(d.edgeBps), mintFee: d.mintFee, restockFee: d.restockFee!,
    shapePrices: livePrices, have: d.activeShapes, baseFee: d.baseFee, unreconciled: d.awaitingUpkeep, paidUpkeepEnabled: d.paidUpkeepEnabled, economics: d.economics, restockFees: d.restockFees, keeperQuotes: d.keeperQuotes,
  };
  const before = !d.policyUnavailable && !d.mintFeeUnavailable && plan && bases.length ? evaluate(plan, inputs) : undefined;
  const after = !d.policyUnavailable && !d.mintFeeUnavailable && plan && newBases.length ? evaluate(plan, { ...inputs, curatedBases: [...bases, ...newBases] }) : undefined;
  const what = picks.length === 1 ? nftLabel(picks[0]) : `${word(picks.length)} NFTs`;
  const list = async () => {
    if (!pub || !ready) return;
    if (restricted !== key && await refusesContracts(pub, me, picks)) { setRestricted(key); return; }
    const r = await refusedApprovals(pub, me, d.balancer, picks);
    setRefused(r.length ? `This pool cannot list ${r.join(', ')}: the collection does not let this pool take the NFT.` : undefined);
    if (r.length) return;
    if (!(await values.confirm(picks))) return;
    const ok = await tx.send('List NFTs', [
      ...approveSteps(pub, tx, me, d.balancer, picks),
      ...listSteps(picks, (batch) => tx.write({ address: d.balancer, abi: poolBalancerAbi, functionName: 'listCuratedBatch', args: [batch] })),
      upkeepStep(pub, tx, me, d.balancer),
    ]);
    if (ok) { setPicks([]); setChoosing(true); setRestricted(undefined); }
  };
  return (
    <>
      {values.modal}
      <h2 className="ctl" style={{ fontSize: 22 }}>Add NFTs</h2>
      {picks.map((n, i) => (
        <div className="mixrow" key={keyOf(n)} style={i === 0 ? { marginTop: 12 } : undefined}>
          <Thumb n={{ collection: n.collection!, tokenId: BigInt(n.tokenId!), image: n.image }} small />
          <div style={{ minWidth: 0 }}>
            <div className="t"><a className="tlink" href={openSeaAsset(n.collection!, n.tokenId!)} target="_blank" rel="noreferrer" title="View on OpenSea">{nftLabel(n)}</a></div>
            {n.floor && <div className="s">Collection floor {floorText(n.floor)}</div>}
          </div>
          <div className="field end" style={{ width: 140 }}><input aria-label={`Value of ${nftLabel(n)}`} placeholder="Your value" value={n.value} onChange={(e) => setPicks(picks.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} inputMode="decimal" /><span className="u">ETH</span></div>
          <button className="link quiet" aria-label={`Remove ${nftLabel(n)}`} onClick={() => setPicks(picks.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      {choosing || !picks.length ? (
        <NftChooser me={me} exclude={[...d.listings.filter((l) => l.kind === 1 && l.state === 1).map((l) => nftKey(l.collection, l.tokenId)), ...picks.map(keyOf)]}
          onPick={(xs) => { setPicks([...picks, ...xs.map((x) => ({ ...x, value: floorValue(x.floor) }))]); setChoosing(false); setRefused(undefined); }} />
      ) : <button className="disclose" style={{ marginTop: 12 }} onClick={() => setChoosing(true)}>+ Add more</button>}
      {after && (
        <div className="section">
          <span className="label">With {picks.length === 1 ? 'this NFT' : 'these NFTs'}</span>
          <div className="kv"><span className="k">Draw price</span><span>{before ? `${eth(before.drawPrice, 5)} → ` : ''}{eth(after.drawPrice, 5)} ETH</span></div>
          <div className="kv"><span className="k">Chance of one of your NFTs</span><span>{before ? `${pctOf(before.curatedOddsPpm / 1e6)} → ` : ''}{pctOf(after.curatedOddsPpm / 1e6)}</span></div>
          {!after.feasible && <p className="note error" style={{ marginTop: 10 }}>With {picks.length === 1 ? 'this NFT' : 'these NFTs'} the saved mix breaks your limits: {after.reasons.join('; ').toLowerCase()}. Purchases stay closed until you change it on <button className="link" style={{ fontSize: 13 }} onClick={() => setTab('mix')}>Prices & mix</button>.</p>}
        </div>
      )}
      {restricted === key && key && (
        <p className="note error" style={{ marginTop: 16 }}>A collection here refuses transfers to contracts. A buyer using a contract that never claims its refund can lock that NFT in FWA escrow permanently. In a pool with few listings, that can cost the buyer much less than the NFT is worth.</p>
      )}
      {refused && <p className="note error" style={{ marginTop: 16 }}>{refused}</p>}
      {picks.length > 0 && (
        <button className="btn lg" style={{ marginTop: 20 }} disabled={!!tx.busy || !ready} onClick={list}>
          {tx.busy ? `${tx.busy}…` : restricted === key && key ? 'List anyway' : ready ? `List ${what}` : 'Set a value for each NFT'}
        </button>
      )}
      {picks.length > 0 && <p className="note" style={{ marginTop: 8 }}>New listings may be staged while draws settle.</p>}
    </>
  );
}

/** The live pool: what players pay, what is listed right now, where the ETH is, and what it earns. */
function Overview({ d, tx, isCreator, me, setTab }: { d: D; tx: Tx; isCreator: boolean; me: Address; setTab: (t: Tab) => void }) {
  const B = { address: d.balancer, abi: poolBalancerAbi } as const;
  const [mode, setMode] = useState<'deposit' | 'claim'>();
  const [amount, setAmount] = useState('');
  const [assume, setAssume] = useState({ open: false, perDay: '40' });
  const [how, setHow] = useState(false);
  const [allClaims, setAllClaims] = useState(false);
  const pub = usePublicClient();
  const plan = d.target ? unpackPlan(d.target) : ZERO;
  const actualShapes = listedShapeCounts(d.listings);
  const backing = actualShapes.reduce((sum, n, i) => sum + BigInt(n) * DENOMS[i], 0n);
  const staged = d.listings.filter(isStaged);
  const stagedBacking = listedShapeCounts(staged, 5).reduce((sum, n, i) => sum + BigInt(n) * DENOMS[i], 0n);
  const activateCount = activationBatch(d.listings, d.unsettled);
  const curated = d.listings.filter((l) => l.kind === 1 && l.state === 1 && l.fwaStatus === 1);
  const bases = curated.map((l) => l.base);
  // Earnings run on the board as listed: each Shape prize keeps its actual FWA price (markup and fees at listing time).
  const livePrices: bigint[][] = [];
  for (const l of d.listings) if (l.kind === 2 && isSelectable(l)) (livePrices[l.denom] ??= []).push(l.price);
  const econ = !d.policyUnavailable && !d.mintFeeUnavailable && plan.some(Boolean)
    ? economics(actualShapes, { curatedBases: bases, curatedPrices: curated.map((l) => l.price), markupBps: d.markupBps, creatorRevenueBps: d.creatorRevenueBps, edgeBps: Number(d.edgeBps), mintFee: d.mintFee, restockFee: d.restockFee!, baseFee: d.baseFee, paidUpkeepEnabled: d.paidUpkeepEnabled, shapePrices: livePrices, economics: d.economics, restockFees: d.restockFees, keeperQuotes: d.keeperQuotes })
    : undefined;
  const month = econ ? econ.creatorEarningsPerDraw * (Number(assume.perDay) || 0) * 30 : 0;
  const missing = plan.reduce((sum, n, i) => sum + Math.max(0, n - actualShapes[i]), 0);
  const expectedFees = d.listings.filter((listing) => listing.kind === 2 && (isSelectable(listing) || isStaged(listing))).reduce((sum, listing) => sum + listing.price - listing.base, 0n);
  const fund = d.balance - d.creatorCredit;
  const idle = d.required !== undefined && fund > d.required ? fund - d.required : 0n;
  const short_ = d.required !== undefined && d.required > fund ? d.required - fund : 0n;
  // E9 / D1: prizes missing because the pool is short of ETH. The creator adds the ETH, or keeps the design without them.
  const trimmed = plan.map((n, i) => Math.min(n, actualShapes[i])) as Counts;
  const gone = plan.map((n, i) => (n > actualShapes[i] ? i : -1)).filter((i) => i >= 0);
  const goneLabel = missing === 1 ? `the ${prizeLabel(gone[0])}` : 'the missing prizes';
  const opening = !d.enabled && !d.retired ? requiredReserveAt(plan, d.activeShapes, d.mintFeeCap, d.awaitingUpkeep, d.paidUpkeepEnabled ? d.economics : undefined, d.baseFee) : 0n;
  const openingShortfall = opening > fund ? opening - fund : 0n;
  const reopen = !d.enabled && !d.retired && openingShortfall > 0n;
  const suggestedDeposit = openingShortfall > short_ ? openingShortfall : short_;
  const withdrawable = d.surplus ?? d.creatorCredit;
  const start = (m: 'deposit' | 'claim') => { setMode(mode === m ? undefined : m); setAmount(m === 'claim' ? formatEther(withdrawable) : suggestedDeposit > 0n ? formatEther(suggestedDeposit) : '0.01'); };
  const deposit = (value: bigint): Step => () => tx.write({ ...B, functionName: 'depositETH', value });
  const check = rateCheck(d);

  // Live inventory: every listing FWA can draw now, weighted as FWA weights it.
  const cost = d.fee; // the draw price; FWA's randomness fee and gas are not included
  const live = d.listings.filter((l) => l.weight > 0n);
  const tw = live.reduce((s, l) => s + l.weight, 0n);
  const sizes = [...new Set(live.filter((l) => l.kind === 2).map((l) => l.denom))].sort((x, y) => BY_VALUE.indexOf(x) - BY_VALUE.indexOf(y));
  const look = (l: Listing): React.CSSProperties => (l.kind === 1 ? { border: '1.5px solid #fff' }
    : { background: sizes.length > 1 && l.denom === sizes[sizes.length - 1] ? '#fff' : SHADES[Math.min(SHADES.length - 1, sizes.indexOf(l.denom))] });
  const nftName = (l: Listing) => `${d.names[l.collection] ?? short(l.collection)} #${l.tokenId}`;
  // Shapes first, smallest (most often drawn) first; NFTs last, as in the designer.
  const ordered = [...live].sort((x, y) => (y.kind - x.kind) || (BY_VALUE.indexOf(x.denom) - BY_VALUE.indexOf(y.denom)) || (y.weight > x.weight ? 1 : -1));
  const items: InvItem[] = ordered.map((l) => {
    const value = l.kind === 2 ? DENOMS[l.denom] : l.base;
    return { key: l.id.toString(), label: l.kind === 2 ? prizeLabel(l.denom) : nftName(l), nft: l.kind === 1, value, price: l.price,
      p: tw ? Number(l.weight) / Number(tw) : 0, mult: cost ? Number(value) / Number(cost) : 0, style: look(l) };
  });
  const nfts = items.filter((x) => x.nft);
  const nftOdds = nfts.reduce((a, x) => a + x.p, 0);
  const rowSizes = BY_VALUE.filter((i) => plan[i] > 0 || actualShapes[i] > 0);
  const missingCells = gone.flatMap((i) => Array.from({ length: plan[i] - actualShapes[i] }, (_, k) => ({ key: `${i}-${k}`, label: prizeLabel(i) })));
  // Expected value of one draw's prize, over what FWA can draw now.
  const avgPrize = items.reduce((a, x) => a + x.p * Number(formatEther(x.value)), 0);
  const price = Number(formatEther(cost ?? 0n));
  const L = d.ledger;
  const claims = L?.claims ?? [];

  return (
    <main className="page cols ov">
      <section>
        <div className="blk">
          <h2 className="h">Draw price</h2>
          <div style={{ marginTop: 12 }}><span className="fig56">{d.fee ? eth(d.fee, 5) : '–'}</span><span className="u13">ETH</span></div>
          <p className="desc">What a player pays for one draw. It follows the prizes listed and your markup, so it moves as prizes are won and restocked.{d.vrfFee !== undefined && ` FWA adds its own randomness fee on top, about ${eth(d.vrfFee, 5)} ETH at current gas.`}</p>
        </div>

        <div className="blk">
          <div className="blk-head"><h2 className="h">Prizes</h2>{isCreator && <button className="link" onClick={() => setTab('mix')}>Change prices or mix</button>}</div>
          <p className="desc">Your target mix against what's listed on FWA now. Each draw wins one listed prize; smaller prizes come up more often.</p>
          {items.length ? <InventoryGrid items={items} missing={missingCells} /> : <p className="foot">No prizes are listed on FWA right now.</p>}
          <div className="ptab" role="table" aria-label="Prizes">
            <div className="tr th" role="row"><span>Prize</span><span>Listed</span><span>Chance per draw</span></div>
            {rowSizes.map((i) => {
              const xs = items.filter((x) => !x.nft && x.label === prizeLabel(i));
              const short = actualShapes[i] < plan[i];
              return <div className="tr" role="row" key={i}>
                <span><span className={`sw${xs.length ? '' : ' miss'}`} style={xs[0]?.style} />{prizeLabel(i)}</span>
                <span className={short ? 'error' : undefined}>{actualShapes[i]} of {plan[i]}</span>
                <span>{xs.length ? oneIn(xs[0].p) : <span className="off">Not drawable</span>}</span>
              </div>;
            })}
            {nfts.length > 0 && <div className="tr" role="row">
              <span><span className="sw" style={{ border: '1.5px solid #fff' }} />{nfts.length} curated NFT{nfts.length === 1 ? '' : 's'}</span>
              <span>{nfts.length}</span><span>{oneIn(nftOdds)}</span>
            </div>}
            {staged.length > 0 && <div className="tr" role="row">
              <span>{staged.length} staged · waiting for draws to settle</span>
              <span />
              <span>{isCreator && activateCount > 0n && <button className="link" disabled={!!tx.busy} onClick={() => activateListings(d, tx)}>Activate staged listings</button>}</span>
            </div>}
            {items.length > 0 && <div className="tr sum" role="row"><span>Average prize value</span><span /><span>{avgPrize.toFixed(5)} ETH</span></div>}
          </div>
          {items.length > 0 && <p className="foot">{price > 0 && `${Math.round((avgPrize / price) * 100)}% of the draw price, across the prizes listed now. `}If several draws land before the pool restocks, the price can drift and FWA refunds those draws; the randomness fee isn't refunded.</p>}
        </div>

        <div className="blk">
          <h2 className="h">Lifetime results</h2>
          <p className="desc">Draw sales against what the pool paid out, since it was created, including under previous creators.</p>
          {d.historyLoading && <p className="foot">Updating pool history…</p>}
          {d.historyError && <p className="foot error">Pool history unavailable: {d.historyError}</p>}
          {L && <>
            <div className="kvs">
              <div className="kv"><span className="k">Draw sales</span><span>{signedEth(L.sales)} ETH</span></div>
              <div className="kv"><span className="k">Prizes won by players</span><span>{signedEth(-L.prizesWon)} ETH</span></div>
              <div className="kv"><span className="k">Shapes mint fees</span><span>{signedEth(-L.mintFees)} ETH</span></div>
              <div className="kv"><span className="k">Paid to keepers</span><span>{signedEth(-L.keeperPay)} ETH</span></div>
              <div className="kv sum"><span className="k">Operating result</span><span className={L.operatingResult < 0n ? 'error' : undefined}>{signedEth(L.operatingResult)} ETH</span></div>
            </div>
            <p className="foot">Through block {L.throughBlock.toLocaleString()}. Leaves out deposits and withdrawals (under ETH in the pool), wallet gas and the value of curated NFTs won. Early on, a few large wins can outweigh many sales.{L.nftsWon > 0 && ` Players won ${word(L.nftsWon)} curated ${L.nftsWon === 1 ? 'NFT' : 'NFTs'} with listed values totalling ${eth(L.nftValues, 5)} ETH.`}</p>
          </>}
        </div>
        {L && L.wins.length > 0 && <div className="blk">
          <h2 className="h">Recent draws</h2>
          <p className="desc">The last few prizes won. The pool restocks each win at its next maintenance.</p>
          <div className="kvs hist">
            {L.wins.map((w) => {
              const nft = w.kind === 1 ? d.listings.find((l) => l.id === w.listingId) : undefined;
              return <div className="kv" key={`${w.block}-${w.index}`}>
                <span>{w.kind === 2 ? prizeLabel(w.denom) : nft ? nftName(nft) : 'Curated NFT'}</span>
                <span style={{ color: 'var(--ink-foot)' }}>Block {w.block.toLocaleString()}</span>
              </div>;
            })}
          </div>
        </div>}
      </section>

      <section className="sticky">
        <div className="blk" id="operating-eth">
          <div className="blk-head">
            <h2 className="h">Operating ETH</h2>
            {d.required === undefined ? <span className="tag">–</span>
              : short_ > 0n ? <span className="tag bad">{ethUp(short_)} ETH short</span>
                : reopen ? <span className="tag bad">{ethUp(openingShortfall)} ETH to reopen</span>
                  : <span className="tag">Funded</span>}
          </div>
          <p className="desc">ETH the pool spends to restock prizes players win and to pay keepers for maintenance. It needs enough to restock your full target mix.</p>
          {d.required !== undefined && <>
            <div className="bar" aria-hidden>
              <i style={{ width: `${d.required > 0n && fund < d.required ? Number((fund > 0n ? fund : 0n) * 10_000n / d.required) / 100 : 100}%` }} />
              {short_ > 0n && <b style={{ width: `${Number(short_ * 10_000n / d.required) / 100}%` }} />}
            </div>
            <div className="bar-l"><span><b>{eth(fund, 5)}</b> ETH in the pool</span><span><b>{eth(d.required, 5)}</b> ETH needed</span></div>
          </>}
          {d.required !== undefined && d.enabled && short_ > 0n && <>
            <p className="warn">{missing > 0
              ? `That's why ${goneLabel} ${missing === 1 ? "isn't" : "aren't"} listed. Add the difference to list ${missing === 1 ? 'it' : 'them'} and cover maintenance, or drop ${missing === 1 ? 'it' : 'them'} from your mix.`
              : "Maintenance uses what's available until this is topped up."}</p>
            {isCreator && pub && <div className="acts">
              <button className="btn" disabled={!!tx.busy} onClick={() => tx.send(`Add ${ethUp(short_)} ETH`, [deposit(short_), upkeepStep(pub, tx, me, d.balancer)])}>Add {ethUp(short_)} ETH</button>
              {missing > 0 && <button className="btn sec" disabled={!!tx.busy || !trimmed.some(Boolean)} onClick={() => {
                const rate = d.legacy || d.restockFee === undefined ? d.creatorRevenueBps : rateFor(d, trimmed);
                tx.send(`Drop ${goneLabel}`, [() => tx.write({ ...B, functionName: 'configure', args: [d.markupBps, packPlan(trimmed), d.mintFeeCap] }),
                  ...(rate !== d.creatorRevenueBps ? [rateStep(tx, d.balancer, rate)] : []), upkeepStep(pub, tx, me, d.balancer)]);
              }}>Drop {goneLabel}</button>}
              <button className="link" onClick={() => start('deposit')}>Other amount</button>
            </div>}
          </>}
          {reopen && isCreator && <div className="acts">
            <button className="btn" disabled={!!tx.busy} onClick={() => tx.send('Add ETH and reopen', [deposit(openingShortfall), () => tx.write({ ...B, functionName: 'open' })])}>Add {ethUp(openingShortfall)} ETH and reopen</button>
            <button className="link" onClick={() => start('deposit')}>Other amount</button>
          </div>}
          {d.required !== undefined && short_ === 0n && !reopen && <>
            <p className="foot">{eth(idle, 5)} ETH spare, included in Withdraw. Spare ETH also shortens restocking after big wins.</p>
            {isCreator && <div className="acts"><button className={mode === 'deposit' ? 'btn' : 'btn sec'} onClick={() => start('deposit')}>Add ETH</button></div>}
          </>}
          {d.required === undefined && <p className="foot">Operating requirement unavailable.</p>}
          {!d.paidUpkeepEnabled && <p className="foot">Paid upkeep is off. Maintenance waits for someone to run it unpaid. {isCreator && <button className="link" style={{ fontSize: 13 }} onClick={() => setTab('settings')}>Settings</button>}</p>}
          {isCreator && mode === 'deposit' && (
            <div className="acts">
              <div className="field" style={{ width: 180 }}><input aria-label="Deposit amount" className="big" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /><span className="u">ETH</span></div>
              <button className="btn" disabled={!!tx.busy || !amount} onClick={() => tx.send('Deposit', [deposit(ethOr(amount, 0n))]).then((ok) => ok && setMode(undefined))}>Deposit {amount || '0'} ETH</button>
            </div>
          )}
        </div>

        <div className="blk">
          <h2 className="h">Your earnings</h2>
          <p className="desc">Your share of every draw sale: {d.creatorRevenueBps / 100}%, set by your markup and mix. It builds up as draws settle and you can withdraw it any time.</p>
          {check?.stale && <>
            <p className="warn">Out of date. Your markup and mix now set {check.suggested / 100}%.</p>
            {isCreator && <div className="acts"><button className="btn sec" disabled={!!tx.busy} onClick={() => tx.send('Update earnings rate', [rateStep(tx, d.balancer, check.suggested)])}>Update to {check.suggested / 100}%</button></div>}
          </>}
          <div style={{ marginTop: 20 }}><span className="fig32">{eth(withdrawable, 5)}</span><span className="u13">ETH ready to withdraw</span></div>
          {isCreator && <div className="acts">
            <button className="btn" disabled={!!tx.busy || withdrawable === 0n} onClick={() => tx.send('Withdraw', [() => tx.write({ ...B, functionName: 'claimSurplus', args: [withdrawable, me] })])}>Withdraw {ethDown(withdrawable)} ETH</button>
            <button className="link" disabled={withdrawable === 0n} onClick={() => start('claim')}>Other amount</button>
          </div>}
          {isCreator && mode === 'claim' && (
            <div className="acts">
              <div className="field" style={{ width: 180 }}><input aria-label="Withdraw amount" className="big" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /><span className="u">ETH</span></div>
              <button className="btn" disabled={!!tx.busy || !amount} onClick={() => tx.send('Withdraw', [() => tx.write({ ...B, functionName: 'claimSurplus', args: [ethOr(amount, 0n), me] })]).then((ok) => ok && setMode(undefined))}>Withdraw {amount || '0'} ETH</button>
            </div>
          )}
          <p className="foot">{d.surplus === undefined ? 'Operating surplus unavailable. Earnings remain withdrawable.' : "Withdrawals take earnings first, then any operating ETH above what's needed."}{d.surplus !== undefined && d.surplus < idle && ' More becomes available as pending draws settle.'}</p>
          {econ ? <>
            <div className="kvs">
              <div className="kv"><span className="k">Estimated earnings</span><span className={month < 0 ? 'error' : undefined}>{signed(month)} ETH a month</span></div>
            </div>
            <p className="foot">{perDraw(econ.creatorEarningsPerDraw)} ETH a draw, at {assume.perDay} draws a day. <button className="link" style={{ fontSize: 13 }} onClick={() => setAssume({ ...assume, open: !assume.open })}>Change</button>. Assumes sales continue at today's mix. <button className="link" style={{ fontSize: 13 }} onClick={() => setHow(!how)}>How this is worked out</button></p>
            {assume.open && <div className="acts"><div className="field" style={{ width: 150 }}><input aria-label="Draws per day" value={assume.perDay} onChange={(e) => setAssume({ ...assume, perDay: e.target.value })} inputMode="numeric" /><span className="u">/DAY</span></div></div>}
            {how && <div className="kvs">
              <div className="kv"><span className="k">Expected settled owner proceeds</span><span>{econ.ownerProceeds.toFixed(5)} ETH</span></div>
              <div className="kv"><span className="k">Revenue retained per draw</span><span>{perDraw(econ.retainedRevenuePerDraw)} ETH</span></div>
              <div className="kv"><span className="k">Expected replacement mint costs</span><span>{econ.mintFeesPerDraw.toFixed(5)} ETH</span></div>
              <div className="kv"><span className="k">Expected surcharge in drawn prizes</span><span>{econ.restockFeesPerDraw.toFixed(5)} ETH</span></div>
              <div className="kv"><span className="k">Estimated keeper pay</span><span>−{econ.keeperCostKnown ? `${econ.keeperPayPerDraw?.toFixed(5)} ETH` : 'Quote unavailable'}</span></div>
              <p className="foot">Earnings are separate from overall pool creator net results. Demand, replacement backing, mint costs and keeper costs affect those results.</p>
            </div>}
          </> : <p className="foot">{d.policyUnavailable ? 'Estimate unavailable while keeper quotes cannot be read.' : d.mintFeeUnavailable ? 'Estimate unavailable while the mint fee cannot be read.' : 'Earnings appear once an NFT is listed and a mix is saved.'}</p>}
          <h3 className="sub">Withdrawals</h3>
          {L ? (claims.length ? <div className="kvs hist" style={{ marginTop: 8 }}>
            {(allClaims ? claims : claims.slice(0, 5)).map((c) => {
              const url = txUrl(c.hash);
              return <div className="kv" key={`${c.hash}-${c.index}`}>
                <span className="k">Block {c.block.toLocaleString()}{c.to.toLowerCase() !== me.toLowerCase() && ` · to ${short(c.to)}`}</span>
                <span>{eth(c.amount, 5)} ETH{url && <> · <a href={url} target="_blank" rel="noreferrer">↗</a></>}</span>
              </div>;
            })}
            {claims.length > 5 && <button className="link" style={{ marginTop: 12 }} onClick={() => setAllClaims(!allClaims)}>{allClaims ? 'Show fewer' : `Show all ${claims.length}`}</button>}
          </div> : <p className="foot">No withdrawals yet.</p>) : <p className="foot">{d.historyError ? 'Withdrawal history unavailable.' : 'Loading withdrawals…'}</p>}
        </div>

        <div className="blk">
          <div className="blk-head"><h2 className="h">ETH in the pool</h2><span className="total">{eth(backing + stagedBacking + d.balance + d.proceeds, 5)} ETH</span></div>
          <p className="desc">Everything the pool holds, what it's for, and where it came from.</p>
          <div className="kvs">
            <div className="kv"><span className="k">Backing listed prizes</span><span>{eth(backing, 5)} ETH</span></div>
            {stagedBacking > 0n && <div className="kv"><span className="k">Staged prize backing</span><span>{eth(stagedBacking, 5)} ETH</span></div>}
            <div className="kv"><span className="k">Operating ETH</span><span>{eth(fund, 5)} ETH</span></div>
            <div className="kv"><span className="k">Your earnings</span><span>{eth(d.creatorCredit, 5)} ETH</span></div>
            {d.proceeds > 0n && <div className="kv"><span className="k">Sales waiting to be collected</span><span>{eth(d.proceeds, 5)} ETH</span></div>}
          </div>
          {d.proceeds > 0n && <div className="acts"><button className="btn sec" disabled={!!tx.busy} onClick={() => tx.send('Collect from sales', [() => tx.write({ ...B, functionName: 'collectProceeds' })])}>Collect {eth(d.proceeds, 5)} ETH</button></div>}
          <h3 className="sub">Where it came from</h3>
          {L ? <>
            <div className="kvs" style={{ marginTop: 8 }}>
              <Flows label="Deposited" flows={L.depositors} total={L.deposited} sign={1n} me={me} />
              <Flows label="Withdrawn" flows={L.recipients} total={L.withdrawn} sign={-1n} me={me} />
              <div className="kv"><span className="k">Operating result</span><span className={L.operatingResult < 0n ? 'error' : undefined}>{signedEth(L.operatingResult)} ETH</span></div>
              <div className="kv"><span className="k">Sent without a deposit</span><span>{signedEth(L.reconciliation)} ETH</span></div>
              <div className="kv sum"><span className="k">ETH in the pool</span><span>{eth(L.held, 5)} ETH</span></div>
            </div>
          </> : <p className="foot">{d.historyError ? 'Pool history unavailable.' : 'Updating pool history…'}</p>}
          <p className="foot">Listed Shapes also carry {eth(expectedFees, 5)} ETH in fees, collected when they're drawn and not counted above.</p>
        </div>
      </section>
    </main>
  );
}

/** Deposits or withdrawals: one row naming the single participant ("by you"), or a total with a row per participant. */
function Flows({ label, flows, total, sign, me }: { label: string; flows: { participant: Address; amount: bigint }[]; total: bigint; sign: bigint; me: Address }) {
  const who = (a: Address) => (a.toLowerCase() === me.toLowerCase() ? 'you' : short(a));
  if (flows.length <= 1) {
    return <div className="kv"><span className="k">{label}{flows[0] && ` ${sign > 0n ? 'by' : 'to'} ${who(flows[0].participant)}`}</span><span>{signedEth(sign * total)} ETH</span></div>;
  }
  return <>
    <div className="kv"><span className="k">{label}</span><span>{signedEth(sign * total)} ETH</span></div>
    {flows.map((f) => <div className="kv" key={f.participant}><span className="k mono">{short(f.participant)}{f.participant.toLowerCase() === me.toLowerCase() && ' (you)'}</span><span>{eth(f.amount, 5)} ETH</span></div>)}
  </>;
}

/** The earnings rate for a mix at the pool's markup, every Shape priced at the current markup and fees: the rate the
 *  design page sets when markup or mix is saved. */
function rateFor(d: D, counts: Counts, shapePrices?: bigint[][]) {
  const curated = d.listings.filter((l) => l.kind === 1 && isSelectable(l));
  return suggestedCreatorRevenueBps(counts, { curatedBases: curated.map((l) => l.base), curatedPrices: curated.map((l) => l.price),
    shapePrices, markupBps: d.markupBps, edgeBps: Number(d.edgeBps), mintFee: d.mintFee, restockFee: d.restockFee!, baseFee: d.baseFee });
}

/** The stored rate is current when it is within max(0.25 points, 10%) of the rate for the saved design, or for the board
 *  as listed (listings keep the restocking fee of their listing time, so gas moves the first alone). */
function rateCheck(d: D) {
  if (d.legacy || d.restockFee === undefined || !d.target) return undefined;
  const counts = unpackPlan(d.target);
  const shapePrices: bigint[][] = [];
  for (const l of d.listings) if (l.kind === 2 && isSelectable(l)) (shapePrices[l.denom] ??= []).push(l.price);
  const suggested = rateFor(d, counts);
  const near = (bps: number) => Math.abs(d.creatorRevenueBps - bps) <= Math.max(25, bps / 10);
  return { suggested, stale: !near(suggested) && !near(rateFor(d, counts, shapePrices)) };
}

const rateStep = (tx: Tx, balancer: Address, bps: number): Step =>
  ['Update earnings rate', () => tx.write({ address: balancer, abi: poolBalancerAbi, functionName: 'setCreatorRevenueBps', args: [bps] })];

const GROUPS = [
  ['general', 'General'], ['pauses', 'Automatic pauses'], ['maintenance', 'Maintenance'], ['handoff', 'Hand off or retire'],
] as const;

function Settings({ d, tx }: { d: D; tx: Tx }) {
  const pub = usePublicClient();
  const B = { address: d.balancer, abi: poolBalancerAbi } as const;
  const [ens, setEns] = useState<{ open: boolean; name: string; forward?: string | null }>({ open: false, name: '' });
  const [step, setStep] = useState<'transfer' | 'retire'>();
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [at, setAt] = useState<string>('general');
  const backing = d.activeShapes.reduce((s, n, i) => s + BigInt(n) * DENOMS[i], 0n);
  useEffect(() => {
    if (!ens.name) return;
    let live = true;
    pub?.getEnsAddress({ name: normalize(ens.name) }).then((a) => live && setEns((e) => ({ ...e, forward: a }))).catch(() => live && setEns((e) => ({ ...e, forward: null })));
    return () => { live = false; };
  }, [pub, ens.name]);
  const forwardOk = ens.forward?.toLowerCase() === d.balancer.toLowerCase();
  // The index marks the group nearest the top of the viewport.
  useEffect(() => {
    const els = GROUPS.map(([id]) => document.getElementById(`set-${id}`)).filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver((entries) => {
      const top = entries.filter((e) => e.isIntersecting).sort((x, y) => x.boundingClientRect.top - y.boundingClientRect.top)[0];
      if (top) setAt(top.target.id.slice(4));
    }, { rootMargin: '0px 0px -60% 0px' });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
  const go = (id: string) => { setAt(id); document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const write = (label: string, functionName: string, args: unknown[] = []) =>
    tx.send(label, [() => tx.write({ ...B, functionName: functionName as never, args: args as never })]);
  const group = (id: string, title: string, desc: string, rows: React.ReactNode) => (
    <div className="grp" id={`set-${id}`}>
      <h2 className="h">{title}</h2>
      <p className="desc">{desc}</p>
      {rows}
    </div>
  );
  return (
    <main className="page st">
      <nav className="idx" aria-label="Settings sections">
        {GROUPS.map(([id, title]) => <button key={id} aria-current={at === id} onClick={() => go(id)}>{title}</button>)}
      </nav>
      <section>
        {group('general', 'General', 'Whether players can buy draws, and how the pool appears in other apps.', <>
          <SRow label="Purchases" desc="Closing stops new draws. Draws already bought still settle." value={d.retired ? 'Retired' : d.enabled ? 'Open' : 'Closed'}>
            {d.enabled
              ? <button className="obtn" disabled={!!tx.busy} onClick={() => write('Close purchases', 'close')}>Close purchases</button>
              : <button className="obtn" disabled={!!tx.busy || d.target === 0n || d.retired} onClick={() => write('Open purchases', 'open')}>Open purchases</button>}
          </SRow>
          {d.curatedRequired !== undefined && (
            <SRow label="When no curated NFT is available" desc="For example after a player wins your last one, until you list another.">
              <div className="seg" role="group" aria-label="When no curated NFT is available">
                <button aria-pressed={d.curatedRequired} disabled={!!tx.busy} onClick={() => !d.curatedRequired && write('Pause purchases without a curated NFT', 'setCuratedRequired', [true])}>Pause purchases</button>
                <button aria-pressed={!d.curatedRequired} disabled={!!tx.busy} onClick={() => d.curatedRequired && write('Keep selling Shapes', 'setCuratedRequired', [false])}>Keep selling Shapes</button>
              </div>
            </SRow>
          )}
          <SRow label="ENS name" desc="Apps show the name instead of the address. You need to own the name, and its ETH address must point to this pool."
            value={<span className="mono">{d.ensName ?? 'None'}</span>}
            wide={ens.open && <>
              <div className="row">
                <div className="field" style={{ flex: 1 }}><input aria-label="ENS name" className="mono" placeholder="name.eth" value={ens.name} onChange={(e) => setEns({ ...ens, name: e.target.value, forward: undefined })} /></div>
                <button className="obtn" disabled={!!tx.busy || !ens.name} onClick={() => write('Set ENS name', 'setENSName', [ens.name])}>Set name</button>
                {d.ensName && <button className="obtn" disabled={!!tx.busy} onClick={() => write('Clear ENS name', 'setENSName', [''])}>Clear</button>}
              </div>
              {ens.name && ens.forward !== undefined && (
                <p className={`note${forwardOk ? '' : ' error'}`} style={{ marginTop: 8 }}>
                  {forwardOk ? `${ens.name} points to this pool.` : `${ens.name} points to ${ens.forward ? short(ens.forward) : 'nothing'}. Set its ETH address to ${short(d.balancer)} in the ENS app.`}
                </p>
              )}
            </>}>
            <button className="obtn" onClick={() => setEns({ ...ens, open: !ens.open, name: ens.name || d.ensName || '' })}>{ens.open ? 'Cancel' : d.ensName ? 'Change' : 'Set name'}</button>
          </SRow>
        </>)}
        {group('pauses', 'Automatic pauses', "Purchases pause on their own when either limit is reached, and resume once it clears. They stop the pool selling draws it can't back.",
          <AutomaticPauses d={d} tx={tx} />)}
        {group('maintenance', 'Maintenance', 'Maintenance restocks won prizes and settles draws. Keepers run it and are paid from operating ETH. You can always run it yourself, unpaid.',
          d.legacy ? <>
            <SRow label="Who can run it" desc="Set by the factory for every pool." value={d.keepersRestricted ? 'Approved keepers only' : 'Anyone'} />
            <SRow label="Keeper payment policy" desc="Legacy pools propose a policy, wait two days, then activate it."
              wide={<LegacyKeeperPay d={{ ...d, legacy: d.legacy, keeperPolicy: d.keeperPolicy!, recommendedPolicy: d.recommendedPolicy! }} tx={tx} />} />
            <SRow label="Run maintenance now" desc="Unpaid, from your wallet. Use it when a keeper hasn't.">
              <button className="obtn" disabled={!!tx.busy} onClick={() => tx.send('Run maintenance', [() => tx.write({ address: d.balancer, abi: d.legacy!.poolBalancerAbi, functionName: 'performUpkeepUnpaid' })])}>Run maintenance</button>
            </SRow>
          </> : d.keeper ? <Maintenance d={{ ...d, keeper: d.keeper }} tx={tx} /> : <p className="foot">Keeper settings unavailable.</p>)}
        {group('handoff', 'Hand off or retire', 'These affect players, so each asks you to confirm. Listed from least to most final.', <>
          <SRow label="Transfer to another creator"
            desc={<>Nothing changes until they accept. Earnings not yet withdrawn go with the pool.{d.pendingCreator !== ZERO_ADDR && ` Offered to ${short(d.pendingCreator)}.`}</>}
            wide={step === 'transfer' && <div className="row">
              <div className="field" style={{ flex: 1 }}><input aria-label="New creator address" className="mono" placeholder="0x…" value={next} onChange={(e) => setNext(e.target.value)} /></div>
              <button className="obtn" disabled={!!tx.busy || !/^0x[0-9a-fA-F]{40}$/.test(next)} onClick={() => tx.send('Offer pool', [() => tx.write({ ...B, functionName: 'transferCreator', args: [next as Address] })])}>Offer pool</button>
            </div>}>
            <button className="obtn" onClick={() => setStep(step === 'transfer' ? undefined : 'transfer')}>{step === 'transfer' ? 'Cancel' : 'Offer pool'}</button>
          </SRow>
          <SRow label="Unlist Shapes" desc={`Moves the ${eth(backing, 5)} ETH backing listed Shapes into operating ETH, 20 per transaction, so you can withdraw it.`}
            meta={d.enabled ? 'Close purchases first.' : undefined}>
            <button className="obtn" disabled={!!tx.busy || d.enabled || backing === 0n} onClick={() => tx.send('Unlist Shapes', [() => tx.write({ ...B, functionName: 'unlistShapes', args: [d.listings.filter((l) => l.kind === 2 && l.state === 1).slice(0, 20).map((l) => l.id)] })])}>Unlist</button>
          </SRow>
          <SRow label="Retire pool" desc={d.retired ? 'Retired. Withdrawals still work.' : 'Stops sales for good. Withdrawals still work.'}
            meta={d.retired ? undefined : 'Close purchases first, then type RETIRE to confirm.'}
            wide={step === 'retire' && <div className="row">
              <div className="field" style={{ flex: 1 }}><input aria-label="Type RETIRE to confirm" className="mono" placeholder="RETIRE" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>
              <button className="obtn danger" disabled={!!tx.busy || d.enabled || confirm !== 'RETIRE'} onClick={() => tx.send('Retire', [() => tx.write({ ...B, functionName: 'retire' })])}>Retire for good</button>
            </div>}>
            <button className="obtn danger" disabled={d.retired} onClick={() => setStep(step === 'retire' ? undefined : 'retire')}>{step === 'retire' ? 'Cancel' : 'Retire'}</button>
          </SRow>
        </>)}
      </section>
    </main>
  );
}

const SHOWN = 120;

/** Picks one NFT for a Design row: from the wallet scan, or by contract and token ID. */
function NftChooser({ me, exclude, onPick }: { me: Address; exclude: string[]; onPick: (xs: Omit<DraftNft, 'value'>[]) => void }) {
  const pub = usePublicClient();
  const [manual, setManual] = useState(false);
  const [m, setM] = useState({ collection: '', tokenId: '' });
  const [err, setErr] = useState<string>();
  const useManual = async () => {
    const collection = m.collection.trim() as Address;
    // Only a token this wallet owns can be listed; check before it becomes part of the design.
    const owner = await pub!.readContract({ address: collection, abi: erc721Abi, functionName: 'ownerOf', args: [BigInt(m.tokenId)] }).catch(() => undefined) as string | undefined;
    if (owner?.toLowerCase() !== me.toLowerCase()) { setErr('This wallet does not own that token.'); return; }
    if (exclude.includes(nftKey(collection, m.tokenId))) { setErr('That NFT is already in this design.'); return; }
    const name = await (pub!.readContract({ address: collection, abi: nameAbi, functionName: 'name' }) as Promise<string>).catch(() => short(collection));
    onPick([{ collection, tokenId: m.tokenId, name }]);
  };
  return (
    <div className="chooser">
      <WalletPicker me={me} listed={exclude}
        onPick={(ns, c) => onPick(ns.map((n) => ({ collection: n.collection, tokenId: n.tokenId.toString(), name: c.name, image: n.image, floor: c.floor, slug: c.slug })))} onEmpty={() => setManual(true)} />
      <button className="disclose quiet" style={{ marginTop: 14 }} onClick={() => setManual(!manual)}>Enter a contract and token ID instead {manual ? '▴' : '▾'}</button>
      {manual && (
        <>
          <label className="form-label" htmlFor="collection">Collection address</label>
          <div className="field"><input id="collection" className="mono" placeholder="0x…" value={m.collection} onChange={(e) => { setErr(undefined); setM({ ...m, collection: e.target.value }); }} /></div>
          <label className="form-label" htmlFor="token">Token ID</label>
          <div className="field"><input id="token" placeholder="e.g. 31" value={m.tokenId} onChange={(e) => { setErr(undefined); setM({ ...m, tokenId: e.target.value }); }} inputMode="numeric" /></div>
          <button className="btn sec" style={{ marginTop: 12 }} disabled={!/^0x[0-9a-fA-F]{40}$/.test(m.collection.trim()) || !/^\d+$/.test(m.tokenId)} onClick={useManual}>Use this NFT</button>
          {err && <p className="note error" style={{ marginTop: 8 }}>{err}</p>}
        </>
      )}
      <p className="note" style={{ marginTop: 12 }}>List only collections you trust: a collection whose contract can move or freeze tokens can take or strand an NFT listed here.</p>
    </div>
  );
}

const floorText = (f?: number) => (f === undefined ? undefined : f >= 1 ? `${f.toFixed(2)} ETH` : f >= 0.001 ? `${f.toPrecision(2)} ETH` : '<0.001 ETH');

/**
 * Finding an NFT in a large wallet: collections first, most valuable (OpenSea floor) at the top, with collections that
 * have no recent price folded away; then the chosen collection's tokens with images.
 */
function WalletPicker({ me, listed, onPick, onEmpty }: { me: Address; listed: string[]; onPick: (ns: WalletNft[], c: Collection) => void; onEmpty: () => void }) {
  const pub = usePublicClient();
  const [cols, setCols] = useState<Collection[]>();
  const [error, setError] = useState<string>();
  const [q, setQ] = useState('');
  const [rest, setRest] = useState(false);
  const [col, setCol] = useState<Collection>();
  const [tokens, setTokens] = useState<WalletNft[]>();
  const [chosen, setChosen] = useState<string[]>([]);
  useEffect(() => {
    if (!pub) return;
    let live = true;
    setCols(undefined); setError(undefined);
    walletCollections(pub, me, chain.id, [SHAPES])
      .then((r) => { if (!live) return; setCols(r); if (!r.length) onEmpty(); })
      .catch((e) => { if (!live) return; setError((e as Error & { shortMessage?: string }).shortMessage ?? (e as Error).message); onEmpty(); });
    return () => { live = false; };
  }, [pub, me]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!col) return;
    let live = true;
    setTokens(undefined); setChosen([]);
    collectionTokens(me, col).then((t) => live && setTokens(t), () => live && setTokens([]));
    return () => { live = false; };
  }, [col, me]);
  const keyOf = (n: { collection: string; tokenId: bigint | string }) => nftKey(n.collection, n.tokenId);
  const words = q.trim().toLowerCase();
  const match = (c: Collection) => !words || `${c.name} ${c.address}`.toLowerCase().includes(words);
  const priced = (cols ?? []).filter((c) => c.floor && match(c));
  const unpriced = (cols ?? []).filter((c) => !c.floor && match(c));
  const row = (c: Collection) => (
    <button key={c.address} onClick={() => setCol(c)}>
      <span className="thumb cimg">{c.image ? <img src={c.image} alt="" loading="lazy" /> : null}</span>
      <span className="cl-id"><span className="t">{c.name}</span><span className="s">{c.count} in your wallet</span></span>
      <span className="cl-floor">{c.floor ? <><span className="muted">Floor</span> {floorText(c.floor)}</> : <span className="muted">No recent price</span>}</span>
    </button>
  );
  if (col) {
    const shown = (tokens ?? []).filter((n) => !listed.includes(keyOf(n)));
    return (
      <div style={{ marginTop: 14 }}>
        <div className="section-head" style={{ marginBottom: 10 }}>
          <button className="link quiet" onClick={() => { setCol(undefined); setTokens(undefined); }}>← All collections</button>
        </div>
        <div className="t" style={{ fontWeight: 700 }}><a className="tlink" href={col.slug ? `https://opensea.io/collection/${col.slug}` : `https://opensea.io/assets/ethereum/${col.address}`} target="_blank" rel="noreferrer" title="View on OpenSea">{col.name}</a></div>
        <p className="note" style={{ margin: '2px 0 12px' }}>{col.floor ? `Floor ${floorText(col.floor)} on OpenSea` : 'No recent price on OpenSea'}</p>
        {!tokens && <p className="note">Loading your tokens…</p>}
        {tokens && !shown.length && <p className="note">No tokens left to choose in this collection.</p>}
        {tokens && shown.length > 0 && <p className="note" style={{ marginBottom: 8 }}>Select one or more.</p>}
        <div className="picker" role="listbox" aria-multiselectable="true" aria-label={`Your ${col.name} tokens`}>
          {shown.slice(0, SHOWN).map((n) => (
            <button key={keyOf(n)} role="option" aria-selected={chosen.includes(keyOf(n))} title={`${n.name} #${n.tokenId}`}
              onClick={() => setChosen((c) => (c.includes(keyOf(n)) ? c.filter((k) => k !== keyOf(n)) : [...c, keyOf(n)]))}>
              <Thumb n={n} />
              <span className="pid">#{n.tokenId.toString()}</span>
            </button>
          ))}
        </div>
        {shown.length > SHOWN && <p className="note" style={{ marginTop: 8 }}>Showing {SHOWN} of {shown.length}.</p>}
        <button className="btn" style={{ marginTop: 14 }} disabled={!chosen.length} onClick={() => onPick(shown.filter((n) => chosen.includes(keyOf(n))), col)}>
          {chosen.length ? `Add ${chosen.length} NFT${chosen.length === 1 ? '' : 's'}` : 'Select NFTs to add'}
        </button>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 14 }}>
      {!cols && !error && <p className="note">Finding the NFTs in your wallet…</p>}
      {error && <p className="note error">Could not read your wallet ({error}). Enter a contract and token ID instead.</p>}
      {cols && cols.length === 0 && <p className="note">No NFTs found in this wallet. Enter a contract and token ID instead.</p>}
      {cols && cols.length > 0 && (
        <>
          {cols.length > 6 && <div className="field" style={{ marginBottom: 10 }}><input aria-label="Search your collections" placeholder="Search collections" value={q} onChange={(e) => setQ(e.target.value)} /></div>}
          <div className="collist">{priced.map(row)}</div>
          {unpriced.length > 0 && (
            <>
              <button className="disclose quiet" style={{ marginTop: 12 }} onClick={() => setRest(!rest)}>{unpriced.length} collection{unpriced.length === 1 ? '' : 's'} with no recent price {rest || !priced.length ? '▴' : '▾'}</button>
              {(rest || !priced.length) && <div className="collist">{unpriced.map(row)}</div>}
            </>
          )}
          <p className="note" style={{ marginTop: 10 }}>Sorted by OpenSea floor price, highest first. Spam collections are hidden.</p>
        </>
      )}
    </div>
  );
}

/** NFT image, fetched only once the tile scrolls into view. */
function Thumb({ n, small }: { n: Pick<WalletNft, 'collection' | 'tokenId' | 'image'>; small?: boolean }) {
  const pub = usePublicClient();
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null | undefined>(n.image);
  useEffect(() => {
    const el = ref.current;
    if (!el || !pub || n.image) return;
    let live = true;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      nftImage(pub, n.collection, n.tokenId).then((u) => live && setSrc(u ?? null), () => live && setSrc(null));
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => { live = false; io.disconnect(); };
  }, [pub, n.collection, n.tokenId]);
  return <span ref={ref} className={small ? 'thumb pt sm' : 'thumb pt'}>{src ? <img src={src} alt="" loading="lazy" onError={() => setSrc(null)} /> : <span>{src === null ? 'No image' : ''}</span>}</span>;
}

type InvItem = { key: string; label: string; nft: boolean; value: bigint; price: bigint; p: number; mult: number; style: React.CSSProperties };

/** One square per pool item; hovering, focusing or tapping a square shows its chance, value and price. */
function InventoryGrid({ items, missing = [] }: { items: InvItem[]; missing?: { key: string; label: string }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ i: number; x: number; y: number }>();
  const show = (i: number, el: HTMLElement) => {
    const w = ref.current?.clientWidth ?? 0;
    const x = el.offsetLeft + el.offsetWidth / 2;
    setTip({ i, x: Math.min(Math.max(x, 120), Math.max(120, w - 120)), y: el.offsetTop + el.offsetHeight + 8 });
  };
  const it = tip && items[tip.i];
  return (
    <div className="inv" ref={ref} onMouseLeave={() => setTip(undefined)}>
      <div className="grid100" role="list" aria-label="Pool inventory">
        {items.map((x, i) => (
          <button key={x.key} role="listitem" className="cell" style={x.style}
            aria-label={`${x.label}: ${oneIn(x.p)} draws, worth ${eth(x.value)} ETH`}
            onMouseEnter={(e) => show(i, e.currentTarget)} onFocus={(e) => show(i, e.currentTarget)} onClick={(e) => show(i, e.currentTarget)}
            onBlur={() => setTip(undefined)} />
        ))}
        {missing.map((m) => <span key={`miss-${m.key}`} role="listitem" className="cell miss" title={`${m.label}, missing`} aria-label={`${m.label}, missing`} />)}
      </div>
      {it && (
        <div className="tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
          <div className="tt">{it.label}</div>
          <div className="kvline"><span className="muted">Chance per draw</span><span>{oneIn(it.p)} · {pctOf(it.p)}</span></div>
          <div className="kvline"><span className="muted">{it.nft ? 'Your value' : 'Redeems for'}</span><span>{eth(it.value, 4)} ETH</span></div>
          <div className="kvline"><span className="muted">Price on FWA</span><span>{eth(it.price, 5)} ETH</span></div>
          <div className="kvline"><span className="muted">Worth vs draw price</span><span>{it.mult.toFixed(2)}×</span></div>
        </div>
      )}
    </div>
  );
}
