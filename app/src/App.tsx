import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useConnect, usePublicClient, useWriteContract } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { BaseError, ContractFunctionRevertedError, formatEther, keccak256, parseAbi, parseAbiItem, parseEther, toBytes, type Address, type Hash } from 'viem';
import { normalize } from 'viem/ens';
import { balancerFactoryAbi, erc721Abi, fwaPoolAbi, poolBalancerAbi, shapesAbi } from '../../shared/abi';
import {
  BY_VALUE, DENOMS, MAX_SHAPES_PER_PLAN, capitalOf, economics, packPlan, prizeLabel, unpackPlan, type Counts,
} from '../../shared/planner';
import { BIG_WIN_SHARE, JACKPOT_MULTIPLE, available, describe, ethNeeded, mixOf, playerView, shapeTotal, styleBonus, type DesignInputs, type Style } from '../../shared/design';
import { chain, FACTORY, FROM_BLOCK, FWA_POOL_URL } from './chain';
import { prepareWrite } from './tx';
import { HowItWorks } from './HowItWorks';
import { collectionTokens, nftImage, openSeaAsset, walletCollections, type Collection, type WalletNft } from './wallet';

const SHAPES: Address = '0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0';
const FWA_FACTORY: Address = '0x8919814D825a5Af238cC04DE06b1C18c9eaA477C';
const fwaFactoryAbi = parseAbi(['function edgeBps() view returns (uint16)', 'function poolCreationEnabled() view returns (bool)', 'function implementation() view returns (address)']);
const CREATED = parseAbiItem('event BalancerCreated(address indexed creator, address indexed balancer, address indexed pool, bytes32 salt)');
const DRAWN = parseAbiItem('event ItemDrawn(uint256 indexed listingId, uint8 kind, uint8 denom, bool delivered)');
const L_DELIVERY_REFUNDED = 7;
const nameAbi = parseAbi(['function name() view returns (string)']);

/** PoolBalancer.admissionStatus codes. */
export const STATUS: Record<number, string> = {
  0: 'Open',
  1: 'Closed by creator',
  2: 'Stocking the prizes',
  3: 'No NFTs listed',
  4: 'Busy: draws settling',
  5: 'Shapes mint fee rose',
  6: 'Prizes running low',
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

interface Listing { id: bigint; kind: number; denom: number; state: number; base: bigint; price: bigint; collection: Address; tokenId: bigint; weight: bigint; fwaStatus: number }

function useBalancer(b?: Address) {
  const pub = usePublicClient();
  const [data, setData] = useState<Awaited<ReturnType<typeof load>>>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    if (!pub || !b) throw new Error('no client');
    const r = <T,>(functionName: string, args: unknown[] = []) =>
      pub.readContract({ address: b, abi: poolBalancerAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
    const pool = await r<Address>('pool');
    const p = <T,>(functionName: string, args: unknown[] = []) =>
      pub.readContract({ address: pool, abi: fwaPoolAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
    const [creator, pendingCreator, markupBps, target, enabled, admission, required, surplus, activeIds, activeShapes, balance, mintFeeCap, reconciled] =
      await Promise.all([
        r<Address>('creator'), r<Address>('pendingCreator'), r<number>('markupBps'), r<bigint>('target'),
        r<boolean>('enabled'), r<number>('admissionStatus'),
        r<bigint>('requiredReserve'), r<bigint>('withdrawableSurplus'), r<bigint[]>('getActiveIds'),
        r<number[]>('getActiveShapes'), pub.getBalance({ address: b }), r<bigint>('mintFeeCap'), r<bigint>('reconciledSequence'),
      ]);
    // Upkeep is needed exactly when simulating it succeeds.
    const upkeep = await pub.simulateContract({ address: b, abi: poolBalancerAbi, functionName: 'performUpkeep', account: b })
      .then(() => ({ needed: true }), () => ({ needed: false }));
    // Drawn items whose FWA delivery failed are not scanned on chain; find them from events.
    const drawn = await pub.getLogs({ address: b, event: DRAWN, fromBlock: FROM_BLOCK });
    const failedIds = [...new Set(drawn.filter((l) => !l.args.delivered).map((l) => l.args.listingId!))];
    const [fee, proceeds, totalWeight, retired, unsettled, lastIssued, mintFee, edgeBps] = await Promise.all([
      p<bigint>('acquisitionFee'), p<bigint>('ownerProceeds'), p<bigint>('totalWeight'), p<boolean>('retired'),
      p<bigint>('unsettledAcquisitionCount'), p<bigint>('lastIssuedSequence'),
      pub.readContract({ address: SHAPES, abi: shapesAbi, functionName: 'mintFee' }) as Promise<bigint>,
      pub.readContract({ address: FWA_FACTORY, abi: fwaFactoryAbi, functionName: 'edgeBps' }) as Promise<number>,
    ]);
    const listing = async (id: bigint): Promise<Listing> => {
      const [it, l] = await Promise.all([r<readonly [number, number, number, bigint, bigint]>('items', [id]), p<readonly [Address, Address, Address, bigint, bigint, bigint, bigint, number]>('listings', [id])]);
      return { id, kind: it[0], denom: it[1], state: it[2], base: it[3], price: it[4], collection: l[0], tokenId: l[3], weight: l[7] === 1 ? l[4] : 0n, fwaStatus: l[7] };
    };
    const listings = await Promise.all(activeIds.map(listing));
    const pending = (await Promise.all(failedIds.map(listing))).filter((l) => l.state === 2);
    const collections = [...new Set([...listings, ...pending].filter((l) => l.kind === 1).map((l) => l.collection))];
    const names: Record<string, string> = Object.fromEntries(await Promise.all(collections.map(async (c) =>
      [c, await (pub.readContract({ address: c, abi: nameAbi, functionName: 'name' }) as Promise<string>).catch(() => short(c))] as const)));
    const ensName = await pub.getEnsName({ address: b }).catch(() => null);
    return {
      balancer: b, pool, creator, pendingCreator, enabled, admission, upkeep, required, surplus, balance, target, markupBps: Number(markupBps),
      activeShapes: activeShapes.map(Number), mintFeeCap, awaitingUpkeep: Number(lastIssued - reconciled),
      fee, proceeds, totalWeight, retired, unsettled, mintFee, edgeBps, listings, pending, names, ensName,
    };
  }, [pub, b]);
  const refresh = useCallback(() => {
    if (!b) return;
    load().then((d) => { setData(d); setError(undefined); }).catch((e) => setError(String(e.shortMessage ?? e.message ?? e)));
  }, [load, b]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 15_000); return () => clearInterval(t); }, [refresh]);
  return { data, error, refresh };
}

const ERRORS: Record<string, string> = {
  NoUpkeepNeeded: 'nothing to do right now',
  WithdrawLocked: 'draws are settling on FWA; try again in a minute',
  InsufficientSurplus: 'amount exceeds claimable surplus',
  Unauthorized: 'only the creator can do this',
  NotClosed: 'close purchases first',
  InvalidPlan: `the mix needs 1 to ${MAX_SHAPES_PER_PLAN} prizes`,
  ShapesNotCurated: 'Shapes cannot be listed as curated NFTs',
  ProtectedAsset: 'this contract does not hold that NFT outside FWA (listed, pending or not owned)',
  InvalidItem: 'not available for this action (check its FWA status)',
};

function explain(e: unknown): string {
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = reverted?.data?.errorName;
    // Error(string) reverts carry their message as the reason.
    if (name === 'Error' && reverted?.reason) return reverted.reason;
    if (name) return ERRORS[name] ?? name;
    return e.shortMessage;
  }
  return (e as Error).message;
}

function useTx(onDone: () => void) {
  const pub = usePublicClient();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  // Simulate before sending so a revert is reported by name, and send with 30% gas-limit headroom over the estimate.
  const write = (async (params: Record<string, unknown>) =>
    writeContractAsync((await prepareWrite(pub!, address, params)) as never)) as typeof writeContractAsync;
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  // The last failure, readable right after `send` resolves (state updates land a render later).
  const failure = useRef<string>();
  // A step may carry its own label (shown as "label (2 of 5)") and may return undefined to skip itself.
  const send = async (label: string, calls: Step[]) => {
    let current = label;
    setBusy(label);
    setMsg(undefined);
    try {
      for (const [k, c] of calls.entries()) {
        const [name, run] = Array.isArray(c) ? c : [label, c];
        current = name;
        setBusy(Array.isArray(c) && calls.length > 1 ? `${name} (${k + 1} of ${calls.length})` : name);
        const hash = await run();
        if (!hash) continue;
        const rc = await pub!.waitForTransactionReceipt({ hash });
        if (rc.status !== 'success') throw new Error(`${name} reverted`);
      }
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
  return { send, busy, msg, write, failure };
}

type Step = (() => Promise<Hash | undefined>) | [string, () => Promise<Hash | undefined>];
type D = NonNullable<ReturnType<typeof useBalancer>['data']>;
type Tx = ReturnType<typeof useTx>;
type Tab = 'overview' | 'nfts' | 'mix' | 'settings';
const TAB_LABELS: Record<Tab, string> = { overview: 'Overview', nfts: 'NFTs', mix: 'Prices & mix', settings: 'Settings' };
const ZERO: Counts = Array(9).fill(0);
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const eth = (wei: bigint | undefined, d = 3) => (wei === undefined ? '–' : Number(formatEther(wei)).toFixed(d));
const signed = (x: number, d = 5) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
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
function statusLine(d: D): { head: string; body: string; act?: 'upkeep' | 'open' | Tab; label?: string } {
  if (d.retired) return { head: 'Retired.', body: 'The pool no longer sells draws. Withdrawals still work.' };
  if (d.target === 0n) return { head: 'Not set up.', body: 'Finish the design and save it to open purchases.' };
  const owed = d.required > d.balance ? d.required - d.balance : 0n;
  switch (d.admission) {
    case 0: return d.upkeep.needed
      ? { head: 'Open.', body: 'Drawn prizes are waiting to be restocked.', act: 'upkeep' }
      : { head: 'Open.', body: 'Players can buy draws. Nothing needs attention.' };
    case 1: return { head: 'Closed.', body: 'You closed purchases.', act: 'open' };
    case 2: return owed > 0n
      ? { head: 'Stocking.', body: `Deposit ${eth(owed)} ETH to stock the prizes.`, act: 'overview', label: 'Deposit' }
      : { head: 'Stocking.', body: 'Purchases open once every prize is listed.', act: 'upkeep' };
    case 3: return { head: 'Closed.', body: 'List one of your NFTs to reopen.', act: 'nfts', label: 'Add an NFT' };
    case 4: return { head: 'Busy.', body: 'Draws are settling on FWA. Purchases resume in a moment.' };
    case 5: return { head: 'Paused.', body: 'The Shapes mint fee rose. Save the design again to accept it.', act: 'mix', label: 'Prices & mix' };
    case 6: return owed > 0n
      ? { head: 'Paused.', body: `Prizes are running low. Deposit ${eth(owed)} ETH to restock.`, act: 'overview', label: 'Deposit' }
      : { head: 'Paused.', body: 'Prizes are running low. Run upkeep to restock.', act: 'upkeep' };
    default: return { head: 'Check the pool.', body: STATUS[d.admission] ?? `Status ${d.admission}.`, act: 'upkeep' };
  }
}

export function App() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const pub = usePublicClient();
  const [mine, setMine] = useState<Address[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Address>();
  // Which page a connected wallet sees; undefined until its pools are loaded.
  const [page, setPage] = useState<'list' | 'pool' | 'new'>();
  const [tab, setTab] = useState<Tab>('overview');
  const [prereq, setPrereq] = useState<{ creation: boolean; impl: boolean }>();
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string>();
  // How it works lives at #how, so it can be linked to and the back button leaves it.
  const [help, setHelpState] = useState(() => location.hash === '#how');
  useEffect(() => { const h = () => { const on = location.hash === '#how'; setHelpState(on); if (on) window.scrollTo(0, 0); }; window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h); }, []);
  const setHelp = (on: boolean) => { if (on !== (location.hash === '#how')) location.hash = on ? 'how' : ''; setHelpState(on); if (on) window.scrollTo(0, 0); };

  const loadMine = useCallback(async () => {
    if (!pub || !address || !FACTORY) return;
    const logs = await pub.getLogs({ address: FACTORY, event: CREATED, args: { creator: address }, fromBlock: FROM_BLOCK });
    const list = logs.map((l) => l.args.balancer!);
    setMine(list);
    // Keep the selection only if it belongs to the connected account (it changes when the wallet switches accounts).
    setSelected((s) => (s && list.includes(s) ? s : list.length === 1 ? list[0] : undefined));
    // Connecting from the preview continues the design being worked on, even for a wallet that already has pools.
    // Otherwise: no pools opens a new one, one pool opens it, several open the list.
    const intent = takeConnectIntent();
    setPage((p) => (intent || !list.length ? 'new' : p ?? (list.length === 1 ? 'pool' : 'list')));
    setLoaded(true);
    const ens = await Promise.all(list.map((b) => pub.getEnsName({ address: b }).catch(() => null)));
    setNames(Object.fromEntries(list.flatMap((b, i) => (ens[i] ? [[b, ens[i]!]] : []))));
  }, [pub, address]);
  useEffect(() => { setLoaded(false); setPage(undefined); loadMine().catch(() => undefined); }, [loadMine]);
  useEffect(() => {
    if (!pub) return;
    Promise.all([
      pub.readContract({ address: FWA_FACTORY, abi: fwaFactoryAbi, functionName: 'poolCreationEnabled' }),
      pub.readContract({ address: FWA_FACTORY, abi: fwaFactoryAbi, functionName: 'implementation' }),
    ]).then(([c, i]) => setPrereq({ creation: c as boolean, impl: (i as string).toLowerCase() === '0x85faf92967705dc45535ebca74d6333f6bcbfee7' })).catch(() => undefined);
  }, [pub]);

  const dev = connectors.filter((c) => c.type === 'mock');
  const fresh = !isConnected || (loaded && page === 'new');
  const open = (b: Address) => { setNotice(undefined); setTab('overview'); setSelected(b); setPage('pool'); };
  return (
    <>
      <header className="topbar">
        <a className="wordmark" href="/" onClick={(e) => { e.preventDefault(); setHelp(false); if (isConnected && loaded) setPage(mine.length ? 'list' : 'new'); window.scrollTo(0, 0); }}>FWA Pool Balancer</a>
        <nav className="topnav" aria-label="Main">
          {isConnected && loaded && <button aria-current={!help && page === 'list' ? 'page' : undefined} onClick={() => { setHelp(false); setPage('list'); }}>Your pools</button>}
          <button aria-current={help ? 'page' : undefined} onClick={() => setHelp(true)}>How it works</button>
        </nav>
        {!isConnected && (
          <div className="right">
            {dev.map((c) => <button key={c.uid} className="btn sec" onClick={() => { markConnectIntent(); connect({ connector: c, chainId: chain.id }); }}>Local dev account</button>)}
            <ConnectButton.Custom>{({ openConnectModal }) => <button className="btn" onClick={() => { markConnectIntent(); openConnectModal(); }}>Connect wallet</button>}</ConnectButton.Custom>
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
      {help && <HowItWorks onDesign={() => { setHelp(false); if (isConnected) setPage('new'); }} />}
      <div hidden={help}>
      {fresh && (
        <div className="status">
          <span>{isConnected ? <><b>New pool.</b> Nothing is sent until you create it and confirm in your wallet.</> : <><b>Preview.</b> Design a pool. Nothing is sent until you connect a wallet and create it.</>}</span>
          {isConnected && mine.length > 0 && <span className="actions"><button className="link quiet" onClick={() => setPage('list')}>Back to your pools</button></span>}
        </div>
      )}
      {isConnected && !loaded && <p className="txline">Loading your pools…</p>}
      {fresh && (
        <NewPool me={isConnected ? address : undefined} prereq={prereq}
          onCreated={(b, failure) => { open(b); setNotice(failure); loadMine(); }} />
      )}
      {isConnected && loaded && page === 'list' && <PoolList pools={mine} names={names} onOpen={open} onNew={() => { setNotice(undefined); setPage('new'); }} />}
      {isConnected && loaded && page === 'pool' && selected && <PoolView key={selected} balancer={selected} me={address!} tab={tab} setTab={setTab} onBack={() => setPage('list')} notice={notice} />}
      </div>
    </>
  );
}

/** The short state of a pool for the list: from its admission status, or "Not set up" before a design is saved. */
const HEADS: Record<number, string> = { 0: 'Open', 1: 'Closed', 2: 'Stocking', 3: 'Closed: no NFTs', 4: 'Busy', 5: 'Paused: mint fee', 6: 'Paused: low prizes' };

/** Every pool this wallet created, with its state and ETH, and the way to start another. */
function PoolList({ pools, names, onOpen, onNew }: { pools: Address[]; names: Record<string, string>; onOpen: (b: Address) => void; onNew: () => void }) {
  const pub = usePublicClient();
  const [info, setInfo] = useState<Record<string, { head: string; eth: bigint }>>({});
  useEffect(() => {
    if (!pub) return;
    let live = true;
    Promise.all(pools.map(async (b) => {
      const r = <T,>(functionName: string) => pub.readContract({ address: b, abi: poolBalancerAbi, functionName: functionName as never }) as Promise<T>;
      const [admission, target, shapes, balance] = await Promise.all([r<number>('admissionStatus'), r<bigint>('target'), r<number[]>('getActiveShapes'), pub.getBalance({ address: b })]);
      const backing = shapes.reduce((s, n, i) => s + BigInt(n) * DENOMS[i], 0n);
      return [b, { head: target ? HEADS[admission] ?? 'Check the pool' : 'Not set up', eth: balance + backing }] as const;
    })).then((rows) => live && setInfo(Object.fromEntries(rows))).catch(() => undefined);
    return () => { live = false; };
  }, [pub, pools]);
  return (
    <main className="page narrow-page">
      <div className="section-head"><h1 className="title t2">Your pools</h1><button className="btn" onClick={onNew}>New pool</button></div>
      {!pools.length && <p className="note" style={{ marginTop: 16 }}>You have no pools yet.</p>}
      <div className="poollist">
        {[...pools].reverse().map((b) => (
          <button key={b} onClick={() => onOpen(b)}>
            <span className="pl-id"><span className="t">{names[b] ?? `Pool ${short(b)}`}</span>{names[b] && <span className="mono muted">{short(b)}</span>}</span>
            <span className="pl-state">{info[b]?.head ?? '…'}</span>
            <span className="pl-eth mono">{info[b] ? `${eth(info[b].eth)} ETH` : ''}</span>
            <span aria-hidden="true" className="muted">→</span>
          </button>
        ))}
      </div>
    </main>
  );
}

function PoolView({ balancer, me, tab, setTab, onBack, notice }: { balancer: Address; me: Address; tab: Tab; setTab: (t: Tab) => void; onBack: () => void; notice?: string }) {
  const { data: d, error, refresh } = useBalancer(balancer);
  const tx = useTx(refresh);
  if (error) return <p className="txline bad">{error}</p>;
  if (!d) return <p className="txline">Loading…</p>;
  const isCreator = d.creator.toLowerCase() === me.toLowerCase();
  const B = { address: balancer, abi: poolBalancerAbi } as const;
  const st = statusLine(d);
  // A pool created but never configured continues in the designer.
  const setup = d.target === 0n && isCreator && !d.retired;
  const tabs: Tab[] = setup ? ['overview', 'nfts', 'settings'] : ['overview', 'nfts', 'mix', 'settings'];
  const upkeep = () => tx.send('Run upkeep', [() => tx.write({ ...B, functionName: 'performUpkeep' })]);
  const action = st.act === 'upkeep' ? <button className="link" disabled={!!tx.busy} onClick={upkeep}>Run upkeep</button>
    : st.act === 'open' && isCreator ? <button className="link" disabled={!!tx.busy} onClick={() => tx.send('Open purchases', [() => tx.write({ ...B, functionName: 'open' })])}>Open purchases</button>
      : st.act && st.act !== tab && st.act !== 'open' ? <button className="link" onClick={() => setTab(st.act as Tab)}>{st.label}</button>
        : null;
  return (
    <>
      <div className="poolhead">
        <div className="ph-row">
          <div className="ph-id">
            <span className="crumb"><button className="link quiet" onClick={onBack}>Your pools</button> /</span>
            <h1 className="ph-name">{poolName(d)}</h1>
            <div className="ph-meta">
              <span className="mono">{d.balancer}</span>
              <button className="link quiet" onClick={() => navigator.clipboard?.writeText(d.balancer)}>Copy address</button>
              <a href={FWA_POOL_URL(d.pool)} target="_blank" rel="noreferrer">Pool on FWA ↗</a>
            </div>
          </div>
        </div>
        <nav className="tabs" aria-label="Sections">
          {tabs.map((t) => <button key={t} aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>{setup && t === 'overview' ? 'Finish setup' : TAB_LABELS[t]}</button>)}
        </nav>
      </div>
      <div className="status" role="status">
        <span><b>{st.head}</b> {st.body}</span>
        <span className="actions">
          {action}
          {d.upkeep.needed && st.act !== 'upkeep' && <button className="link quiet" disabled={!!tx.busy} onClick={upkeep}>Run upkeep</button>}
          {isCreator && d.enabled && <button className="link quiet" disabled={!!tx.busy} onClick={() => tx.send('Close purchases', [() => tx.write({ ...B, functionName: 'close' })])}>Close purchases</button>}
          {isCreator && !d.enabled && st.act !== 'open' && d.target !== 0n && !d.retired && <button className="link quiet" disabled={!!tx.busy} onClick={() => tx.send('Open purchases', [() => tx.write({ ...B, functionName: 'open' })])}>Open purchases</button>}
        </span>
      </div>
      {(tx.busy || tx.msg) && <p className={`txline${tx.msg && !tx.msg.ok ? ' bad' : ''}`} aria-live="polite">{tx.busy ? `${tx.busy}…` : tx.msg!.text}</p>}
      {notice && !tx.busy && !tx.msg && <p className="txline bad" role="alert">{notice}</p>}
      {d.pendingCreator.toLowerCase() === me.toLowerCase() && (
        <p className="txline">You were offered this pool. <button className="link" disabled={!!tx.busy} onClick={() => tx.send('Accept pool', [() => tx.write({ ...B, functionName: 'acceptCreator' })])}>Accept</button></p>
      )}
      {!isCreator && <p className="txline">You are not this pool's creator. You can run upkeep; other changes need the creator.</p>}
      {tab === 'overview' && (setup ? <Design d={d} tx={tx} mode="pool" me={me} /> : <Overview d={d} tx={tx} isCreator={isCreator} me={me} setTab={setTab} />)}
      {tab === 'nfts' && <Nfts d={d} tx={tx} isCreator={isCreator} me={me} setTab={setTab} />}
      {tab === 'mix' && (isCreator ? <Design d={d} tx={tx} mode="pool" me={me} /> : <main className="page"><p className="lead">Only the creator can change prices and the mix.</p></main>)}
      {tab === 'settings' && (isCreator ? <Settings d={d} tx={tx} /> : <main className="page"><p className="lead">Only the creator can change settings.</p></main>)}
    </>
  );
}

/** An NFT row on the Design page: its value, and once a wallet is connected, which token it is. */
type DraftNft = { value: string; collection?: Address; tokenId?: string; name?: string; image?: string; floor?: number; slug?: string };
/** Design work not yet saved on chain: one for the pool not yet created, and one per pool whose design is unsaved. */
type Draft = { markup: number; small?: number; style?: Style | null; bonus?: Counts; nfts?: DraftNft[]; values?: string[] };
const draftKey = (b?: Address) => (b ? `pool-design-draft:${b.toLowerCase()}` : 'pool-design-draft');
const loadDraft = (b?: Address): Draft | undefined => { try { return JSON.parse(localStorage.getItem(draftKey(b)) ?? 'null') ?? undefined; } catch { return undefined; } };
const saveDraft = (x: Draft, b?: Address) => { try { localStorage.setItem(draftKey(b), JSON.stringify(x)); } catch { /* storage unavailable */ } };
const clearDraft = (b?: Address) => { try { localStorage.removeItem(draftKey(b)); } catch { /* storage unavailable */ } };
const INTENT_KEY = 'connect-from-preview';
const markConnectIntent = () => { try { sessionStorage.setItem(INTENT_KEY, '1'); } catch { /* storage unavailable */ } };
const takeConnectIntent = () => { try { const v = sessionStorage.getItem(INTENT_KEY); sessionStorage.removeItem(INTENT_KEY); return !!v; } catch { return false; } };
const DEFAULT_NFT: DraftNft = { value: '0.050' };
const DEFAULT_MARKUP = 25;
const DEFAULT_SMALL = 10;
const GAME_STYLES: { key: Style; label: string; hint: string }[] = [
  { key: 'steady', label: 'Low draw price', hint: 'Cheap draws. Most draws win a small Shape; your NFT is the big prize.' },
  { key: 'board', label: 'Balanced', hint: 'Prizes in steady steps: 0.01, 0.02, 0.05, 0.1 and 0.5 ETH, in ape-Ball\'s proportions.' },
  { key: 'balanced', label: 'More big wins', hint: `About 1 in ${Math.round(1 / BIG_WIN_SHARE)} draws wins 2× the price or more.` },
  { key: 'jackpot', label: 'Jackpot', hint: `Adds one Shape worth about ${JACKPOT_MULTIPLE}× the draw price.` },
];
/** Prize sizes offered for adjusting by hand, smallest first: 0.05 to 25 ETH (Shapes and Packs), plus any size a style
 *  picked. */
const BONUS = BY_VALUE.filter((i) => DENOMS[i] >= 5n * 10n ** 16n && DENOMS[i] <= 25n * 10n ** 18n);
const nftKey = (collection: string, tokenId: bigint | string) => `${collection}:${tokenId}`.toLowerCase();
const approvalAbi = parseAbi(['function getApproved(uint256 tokenId) view returns (address)', 'function isApprovedForAll(address owner, address operator) view returns (bool)']);
type Prereq = { creation: boolean; impl: boolean };

/** The Design page for a pool that does not exist yet: live fees from chain; NFTs and budget from the draft. */
function NewPool({ me, prereq, onCreated }: { me?: Address; prereq?: Prereq; onCreated: Create['onCreated'] }) {
  const pub = usePublicClient();
  const tx = useTx(() => undefined);
  const [live, setLive] = useState<{ edgeBps: number; mintFee: bigint }>();
  const [wallet, setWallet] = useState<bigint>();
  useEffect(() => {
    if (!pub) return;
    Promise.all([
      pub.readContract({ address: FWA_FACTORY, abi: fwaFactoryAbi, functionName: 'edgeBps' }) as Promise<number>,
      pub.readContract({ address: SHAPES, abi: shapesAbi, functionName: 'mintFee' }) as Promise<bigint>,
    ]).then(([edgeBps, mintFee]) => setLive({ edgeBps, mintFee }))
      .catch(() => undefined);
  }, [pub]);
  useEffect(() => { if (pub && me) pub.getBalance({ address: me }).then(setWallet).catch(() => undefined); }, [pub, me, tx.busy]);
  if (!live) return <main className="page"><p className="lead">Loading current fees…</p></main>;
  // Only the fields Design reads; a pool that does not exist has no target, listings or balance.
  const d = { target: 0n, markupBps: 0, listings: [], balance: 0n, activeShapes: ZERO, names: {}, balancer: ZERO_ADDR, enabled: false, ...live } as unknown as D;
  return <Design d={d} tx={tx} mode={me ? 'new' : 'preview'} me={me} create={{ wallet, prereq, onCreated }} />;
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

/** Upkeep, skipped when there is nothing for it to do; anyone (including a keeper) can run it later. */
const upkeepStep = (pub: Pub, tx: Tx, me: Address, balancer: Address): Step => ['Run upkeep', async () =>
  (await pub.simulateContract({ address: balancer, abi: poolBalancerAbi, functionName: 'performUpkeep', account: me }).then(() => true, () => false))
    ? tx.write({ address: balancer, abi: poolBalancerAbi, functionName: 'performUpkeep' }) : undefined];

// Grid shades by prize rank, smallest first; the top Shape prize is white, NFTs are outlined.
const SHADES = ['#333', '#555', '#7a7a7a', '#b5b5b5'];

type Mode = 'preview' | 'new' | 'pool';
type Create = { wallet?: bigint; prereq?: Prereq; onCreated: (b: Address, failure?: string) => void };

/**
 * One Design page for every stage: a preview before connecting (NFTs are values only), a pool about to be created
 * (each NFT is chosen from the wallet), and an existing pool (listed NFTs are fixed; more can be added). The button
 * runs every transaction the design needs, in order.
 */
function Design({ d, tx, mode, me, create }: { d: D; tx: Tx; mode: Mode; me?: Address; create?: Create }) {
  const pub = usePublicClient();
  const fresh = mode !== 'pool';
  const has = d.target !== 0n;
  const [draft] = useState(() => (fresh ? loadDraft() : has ? undefined : loadDraft(d.balancer)));
  const listed = d.listings.filter((l) => l.kind === 1 && l.state === 1);
  const listedKeys = new Set(listed.map((l) => nftKey(l.collection, l.tokenId)));
  const nftName = (l: Listing) => `${d.names[l.collection] ?? short(l.collection)} #${l.tokenId}`;
  const [nfts, setNfts] = useState<DraftNft[]>(() => draft?.nfts ?? draft?.values?.map((value) => ({ value })) ?? (fresh || !listed.length ? [DEFAULT_NFT] : []));
  const [picking, setPicking] = useState<number>();
  // Rows already listed (a resumed draft) show as listed, not twice.
  const isListed = (n: DraftNft) => !!n.collection && listedKeys.has(nftKey(n.collection, n.tokenId!));
  const pending = nfts.map((n, i) => ({ n, i })).filter(({ n }) => !isListed(n));
  const rowName = (n: DraftNft, k: number) => (n.collection ? `${n.name ?? short(n.collection)} #${n.tokenId}` : pending.length + listed.length === 1 ? 'Your NFT' : `NFT ${k + 1}`);
  // Every NFT the design counts: listed ones, then rows with a value.
  const rows = [
    ...listed.map((l) => ({ key: `l${l.id}`, name: nftName(l), base: l.base })),
    ...pending.map(({ n, i }, k) => ({ key: `d${i}`, name: rowName(n, listed.length + k), base: ethOr(n.value, 0n) })).filter((r) => r.base > 0n),
  ];
  const bases = rows.map((r) => r.base);
  const [markup, setMarkup] = useState(has ? d.markupBps / 100 : draft?.markup ?? DEFAULT_MARKUP);
  const savedCounts = has ? unpackPlan(d.target) : ZERO;
  // Pool size: how many 0.01 ETH Shapes. More of them make the NFTs rarer and the draw cheaper.
  const [small, setSmall] = useState(has ? savedCounts[0] : draft?.small ?? DEFAULT_SMALL);
  // A saved pool shows its saved mix until something changes.
  const [edited, setEdited] = useState(!has);
  const [restricted, setRestricted] = useState<string>();
  const [refused, setRefused] = useState<string>();
  const [open, setOpen] = useState({ bonus: false, numbers: false });
  const [gridView, setGridView] = useState<'inventory' | 'draws'>('inventory');
  const [how, setHow] = useState(fresh);
  const salt = useMemo(() => `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, '0')).join('')}` as `0x${string}`, []);
  const toggle = (k: keyof typeof open) => setOpen({ ...open, [k]: !open[k] });
  const markupBps = Math.round(markup * 100);
  const base: DesignInputs = {
    curatedBases: bases, markupBps, edgeBps: Number(d.edgeBps), mintFee: d.mintFee,
    have: d.activeShapes,
  };
  // Bonus prizes: Shapes on top of the small ones. A style picks them; adjusting them by hand makes the mix custom.
  const [custom, setCustom] = useState<Counts>(() => (has ? savedCounts.map((n, i) => (i === 0 ? 0 : n)) : draft?.bonus ?? ZERO));
  const [style, setStyle] = useState<Style | undefined>(() => (has ? (custom.some(Boolean) ? undefined : 'steady') : draft?.style === null ? undefined : GAME_STYLES.some((g) => g.key === draft?.style) ? draft!.style! : 'board'));
  const initial = useRef({ style, custom, small });
  const bonus = useMemo(() => (style ? styleBonus(style, base, small) : custom),
    [style, custom.join(), small, bases.join(), markupBps, d.mintFee]); // eslint-disable-line react-hooks/exhaustive-deps
  const room = MAX_SHAPES_PER_PLAN - shapeTotal(bonus);
  const smallUsed = Math.max(0, Math.min(small, room));
  const counts = edited ? mixOf(smallUsed, bonus) : savedCounts;
  const inputs = base;
  const change = <T,>(set: (v: T) => void) => (v: T) => { setEdited(true); set(v); };
  // Until a design is saved on chain, keep it in this browser so it survives connecting, reloading and a failed step.
  const current = (): Draft => ({ markup, small, style: style ?? null, bonus: custom, nfts });
  useEffect(() => {
    if (!has) saveDraft(current(), fresh ? undefined : d.balancer);
  }, [has, markup, small, style, custom, nfts]); // eslint-disable-line react-hooks/exhaustive-deps
  const setNft = (i: number, x: Partial<DraftNft>) => { setEdited(true); setNfts(nfts.map((n, j) => (j === i ? { ...n, ...x } : n))); };
  const reset = () => {
    setPicking(undefined);
    setOpen({ bonus: false, numbers: false });
    if (has) {
      setEdited(false); setMarkup(d.markupBps / 100);
      setStyle(initial.current.style); setCustom(initial.current.custom); setSmall(initial.current.small);
      return;
    }
    setMarkup(DEFAULT_MARKUP); setSmall(DEFAULT_SMALL); setStyle('board'); setCustom(ZERO);
    setNfts(fresh || !listed.length ? [DEFAULT_NFT] : []);
  };
  const total = counts.reduce((a, b) => a + b, 0);
  const setBonusAt = (i: number, n: number) => { setEdited(true); setStyle(undefined); setCustom(bonus.map((x, j) => (j === i ? Math.max(0, n) : x))); };
  const choose = (st: Style) => { setEdited(true); setStyle(st); };
  const ready = bases.length > 0 && total > 0;
  const ev = ready ? describe(counts, inputs) : undefined;
  // Player figures are against the draw price; FWA's randomness fee and gas are set at draw time.
  const view = ev ? playerView(ev, markupBps, 0n) : undefined;
  const target = packPlan(counts);
  const needed = ready ? ethNeeded(counts, inputs) : 0n;
  // A new pool is created with what it needs, rounded up to 0.01 ETH. A saved pool counts the prizes unlisting would redeem.
  const deposit = fresh ? ((needed + 10n ** 16n - 1n) / 10n ** 16n) * 10n ** 16n : 0n;
  const have = fresh ? deposit : available(d.balance, d.activeShapes, counts);
  const shortBy = needed > have ? ((needed - have + 10n ** 16n - 1n) / 10n ** 16n) * 10n ** 16n : 0n;
  // Costs counted: Shapes mint fees and keeper rewards. Gas is set at draw time and is not estimated.
  const econ = ready ? economics(counts, inputs, { gasPriceGwei: 0, drawsPerUpkeep: 1, safety: 0.25 }) : undefined;
  const tierOf = (i: number) => view?.tiers.find((t) => t.kind === 'shape' && t.size === i);

  // Out of 100 draws: whole draws per prize group by largest remainder, NFTs grouped.
  const groups = view ? [
    ...(view.curated > 0 ? [{ key: 'nft', i: -1, p: view.curated, nft: true, value: 0n, n: 0 }] : []),
    ...BY_VALUE.filter((i) => counts[i] > 0).map((i) => ({ key: `s${i}`, i, n: counts[i], p: tierOf(i)?.odds ?? 0, nft: false, value: DENOMS[i] })),
  ] : [];
  const raw = groups.map((g) => g.p * 100);
  const whole = raw.map(Math.floor);
  raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]).slice(0, 100 - whole.reduce((a, b) => a + b, 0)).forEach(([, i]) => whole[i]++);
  const shapeGroups = groups.filter((g) => !g.nft);
  const shade = (g: (typeof groups)[number]) => (g.nft ? 'nft' : g === shapeGroups[shapeGroups.length - 1] && shapeGroups.length > 1 ? '#fff' : SHADES[Math.min(SHADES.length - 1, shapeGroups.indexOf(g))]);
  const ordered = groups.map((g, k) => ({ g, n: whole[k] })).sort((a, b) => b.n - a.n);
  const cells = ordered.flatMap(({ g, n }) => Array(n).fill(g) as (typeof groups)[number][]);
  const sw = (g: (typeof groups)[number]) => (shade(g) === 'nft' ? { border: '1.5px solid #fff' } : { background: shade(g) });
  const legend = (g: (typeof groups)[number], n: number) => {
    const verb = n <= 1 ? 'wins' : 'win';
    if (g.nft) return `${verb} ${rows.length === 1 ? `your NFT, ${rows[0].name}` : 'one of your NFTs'}`;
    const v = Number(formatEther(g.value)) / Number(formatEther(view!.cost));
    const what = `${g.n === 1 && shapeGroups.length > 1 && g === shapeGroups[shapeGroups.length - 1] ? 'the' : 'a'} ${prizeLabel(g.i)}`;
    return `${verb} ${what}${v < 1 ? ', less than they paid' : `, ${v.toFixed(1)}× what they paid`}`;
  };

  // Inventory: one square per item in the pool, each with its own chance per draw.
  const nftGroup = groups.find((g) => g.nft);
  // Same group order as the 100-draw view (most frequent first), so the two views line up.
  const curatedTiers = view?.tiers.filter((t) => t.kind === 'curated') ?? [];
  const items: InvItem[] = view ? ordered.flatMap(({ g }): InvItem[] => {
    if (g.nft) return curatedTiers.map((t, k) => ({
      key: `n${k}`, label: rows[k]?.name ?? `Your NFT ${k + 1}`, nft: true, value: t.value, price: t.listPrice, p: t.odds, mult: t.multiple, style: sw(g),
    }));
    const t = tierOf(g.i);
    return t ? Array.from({ length: g.n }, (_, j) => ({
      key: `s${g.i}-${j}`, label: prizeLabel(g.i), nft: false, value: t.value, price: t.listPrice, p: t.odds / g.n, mult: t.multiple, style: sw(g),
    })) : [];
  }) : [];
  // Each NFT's chance per draw, a result of its value and the rest of the pool.
  const oddsOf = (key: string) => { const k = rows.findIndex((r) => r.key === key); return k < 0 ? undefined : view?.tiers.filter((t) => t.kind === 'curated')[k]?.odds; };
  const oddsLine = (key: string) => { const p = oddsOf(key); return p ? `Won about ${oneIn(p)} draws` : undefined; };
  // The player's side of one draw: the usual result, the chances of beating the price, the top prize and the average.
  const common = view?.tiers.reduce((a, t) => (t.odds > a.odds ? t : a), view.tiers[0]);
  const prize = (t: NonNullable<typeof common>) => (t.kind === 'curated' ? (rows.length > 1 ? 'One of your NFTs' : 'Your NFT') : `A ${t.label}`);
  const playBlock = view && common ? (
    <div className="result-block">
      <h2 className="h3">What a player gets</h2>
      <div className="kv"><span className="k">Most draws ({pctOf(common.odds)})</span><span>{prize(common)} · {common.multiple.toFixed(2)}× the price</span></div>
      <div className="kv"><span className="k">Win more than they paid</span><span>{oneIn(view.winMore)} · {pctOf(view.winMore)}</span></div>
      <div className="kv"><span className="k">Win 2× the price or more</span><span>{oneIn(view.win2x)} · {pctOf(view.win2x)}</span></div>
      <div className="kv"><span className="k">Top prize</span><span>{prize(view.top)} · {view.top.multiple.toFixed(1)}× · {oneIn(view.top.odds)}</span></div>
      {view.top.kind !== 'curated' && <div className="kv"><span className="k">{rows.length > 1 ? 'One of your NFTs' : 'Your NFT'}</span><span>{oneIn(view.curated)}</span></div>}
      <div className="kv"><span className="k">Average prize</span><span>{(view.avgReturn * 100).toFixed(0)}% of the price</span></div>
    </div>
  ) : null;
  const payBlock = view && ev ? (
    <div className="result-block">
      <span className="soft" style={{ fontSize: 14 }}>Players pay</span>
      <div style={{ marginTop: 8 }}><span className="figure">{eth(ev.drawPrice, 5)}</span><span className="unit">ETH per draw</span></div>
      <p className="note" style={{ marginTop: 10 }}>Draw price. FWA's randomness (VRF) fee and gas are added at draw time.</p>
    </div>
  ) : null;
  const gridBlock = view ? (
        <div className="result-block">
          <div className="seg" role="group" aria-label="View">
            <button aria-pressed={gridView === 'inventory'} onClick={() => setGridView('inventory')}>Inventory</button>
            <button aria-pressed={gridView === 'draws'} onClick={() => setGridView('draws')}>Out of 100 draws</button>
          </div>
          {gridView === 'inventory' ? (
            <>
              <InventoryGrid items={items} />
              <div className="legend">
                {ordered.map(({ g }) => (g.nft
                  ? <div key={g.key}><span className="sw" style={sw(g)} /><span><b>{rows.length}</b> of your NFTs · {oneIn(view.curated)} draws for any of them</span></div>
                  : <div key={g.key}><span className="sw" style={sw(g)} /><span><b>{g.n}</b> × {prizeLabel(g.i)} · each {oneIn(g.p / g.n)}</span></div>))}
              </div>
              <p className="note" style={{ marginTop: 14 }}>Each square is one item in the pool. Hover or tap a square for its chance and value. Cheaper items come up more often.</p>
              <p className="note" style={{ marginTop: 6 }}>Won prizes are restocked automatically, so the pool stays at this mix.</p>
            </>
          ) : (
            <>
          <div className="grid100" aria-hidden="true">{cells.map((g, k) => <span key={k} style={sw(g)} />)}</div>
          <div className="legend">
            {ordered.map(({ g, n }) => (
              <div key={g.key}><span className="sw" style={sw(g)} /><span><b>{n === 0 ? '<1' : n}</b> {legend(g, n)}{g.p < 0.05 && <span className="muted"> ({oneIn(g.p)})</span>}</span></div>
            ))}
          </div>
          <p className="note" style={{ marginTop: 14 }}>Rounded to whole draws. On average a prize is worth {(view.avgReturn * 100).toFixed(0)}% of what the player paid.</p>
            </>
          )}
        </div>
  ) : null;

  // What saving does, in order. A new pool is created first; its address is known in advance from the salt.
  const toList = pending.filter(({ n }) => n.collection && ethOr(n.value, 0n) > 0n).map(({ n }) => n);
  const unchosen = mode !== 'preview' && pending.some(({ n }) => !n.collection);
  // Saving again also accepts a raised Shapes mint fee.
  const configChanged = !has || markupBps !== d.markupBps || target !== d.target || d.mintFee > d.mintFeeCap;
  const willOpen = !has && !d.enabled;
  // Prizes above a smaller mix are unlisted and redeemed (up to 20 per transaction; the rest from Settings).
  const left = [...d.activeShapes];
  const extra = mode === 'pool' ? d.listings.filter((l) => l.kind === 2 && l.state === 1 && left[l.denom] > counts[l.denom] && left[l.denom]--).map((l) => l.id).slice(0, 20) : [];
  const nftWord = (k: number) => `${k === 1 ? 'your' : word(k)} NFT${k === 1 ? '' : 's'}`;
  const actions = [
    mode === 'new' && `create the pool with ${eth(deposit, 2)} ETH`,
    mode === 'pool' && shortBy > 0n && `deposit ${eth(shortBy, 2)} ETH`,
    toList.length > 0 && `approve and list ${nftWord(toList.length)}`,
    configChanged && 'save the design',
    extra.length > 0 && `unlist ${word(extra.length)} extra prize${extra.length === 1 ? '' : 's'}`,
    willOpen && 'open purchases',
    (mode === 'new' || toList.length > 0 || configChanged) && (has ? 'run upkeep' : 'run the first upkeep'),
  ].filter(Boolean) as string[];
  const confirmations = (mode === 'new' || shortBy > 0n ? 1 : 0) + (toList.length ? toList.length + 1 : 0) + (configChanged ? 1 : 0) + (extra.length ? 1 : 0) + (willOpen ? 1 : 0) + (actions.length ? 1 : 0);
  const sentence = (xs: string[]) => cap(xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] ?? '');
  const wallet = create?.wallet;
  const blocked = !ready ? undefined
    : unchosen ? 'Choose which NFT each row is, or remove the row.'
      : !ev?.feasible ? undefined
        : mode === 'new' && create?.prereq && !(create.prereq.creation && create.prereq.impl) ? 'Pool creation is not available right now.'
            : (mode === 'new' ? deposit : shortBy) > (wallet ?? 2n ** 255n) ? `Your wallet has ${eth(wallet)} ETH.`
              : !actions.length ? 'Saved. Nothing has changed.' : undefined;
  const restrictKey = toList.map((n) => nftKey(n.collection!, n.tokenId!)).join();

  // On a configured pool: the saved design next to the one being edited.
  const savedEv = has && bases.length ? describe(savedCounts, { ...inputs, markupBps: d.markupBps }) : undefined;
  const savedView = savedEv ? playerView(savedEv, d.markupBps, 0n) : undefined;
  const compare = has && savedEv && savedView && view && ev ? (
    <div className="result-block" style={{ paddingTop: 0 }}>
      <span className="label">{configChanged ? 'Now → after saving' : 'Now'}</span>
      {([
        // Listed prizes keep their price: a markup change reaches the draw price as prizes are won and restocked.
        ['Players pay', `${eth(savedView.cost, 5)} ETH`, `${eth(view.cost, 5)} ETH${markupBps !== d.markupBps ? ' as prizes restock' : ''}`],
        ['Chance of one of your NFTs', pctOf(savedView.curated), pctOf(view.curated)],
        ['Shapes', mixText(savedCounts), mixText(counts)],
        ['Your markup', `${d.markupBps / 100}%`, `${markup}%`],
        ['Kept in the pool while open', `${eth(ethNeeded(savedCounts, inputs))} ETH`, `${eth(needed)} ETH`],
      ] as const).map(([k, a, b]) => (
        <div className="kv" key={k}><span className="k">{k}</span><span>{a === b || !configChanged ? a : <><span className="muted">{a} →</span> <b>{b}</b></>}</span></div>
      ))}
    </div>
  ) : null;
  const run = async () => {
    if (!pub || !me) return;
    if (restricted !== restrictKey && await refusesContracts(pub, me, toList)) { setRestricted(restrictKey); return; }
    const balancer = mode === 'new'
      ? (await pub.readContract({ address: FACTORY, abi: balancerFactoryAbi, functionName: 'predictBalancer', args: [me, salt] })) as Address
      : d.balancer;
    const refused = await refusedApprovals(pub, me, balancer, toList);
    setRefused(refused.length ? `This pool cannot list ${refused.join(', ')}: the collection does not let this pool take the NFT. Choose another NFT.` : undefined);
    if (refused.length) return;
    const B = { address: balancer, abi: poolBalancerAbi } as const;
    const steps: Step[] = [];
    if (mode === 'new') steps.push(['Create pool', () => tx.write({ address: FACTORY, abi: balancerFactoryAbi, functionName: 'createBalancer', args: [salt], value: deposit })]);
    steps.push(...approveSteps(pub, tx, me, balancer, toList));
    if (toList.length) steps.push([`List ${nftWord(toList.length)}`, () => tx.write({ ...B, functionName: 'listCuratedBatch', args: [toList.map((n) => ({ collection: n.collection!, tokenId: BigInt(n.tokenId!), base: ethOr(n.value, 0n) }))] })]);
    if (mode === 'pool' && shortBy > 0n) steps.push([`Deposit ${eth(shortBy, 2)} ETH`, () => tx.write({ ...B, functionName: 'depositETH', value: shortBy })]);
    if (configChanged) steps.push(['Save design', () => tx.write({ ...B, functionName: 'configure', args: [markupBps, target] })]);
    if (extra.length) steps.push(['Unlist extra prizes', () => tx.write({ ...B, functionName: 'unlistShapes', args: [extra] })]);
    if (willOpen) steps.push(['Open purchases', () => tx.write({ ...B, functionName: 'open' })]);
    // Upkeep is skipped when there is nothing for it to do; anyone (including a keeper) can run it later.
    steps.push(upkeepStep(pub, tx, me, balancer));
    const ok = await tx.send(mode === 'new' ? 'Create pool' : 'Save', steps);
    if (ok) { clearDraft(fresh ? undefined : d.balancer); setNfts([]); }
    if (mode === 'new') {
      const created = ((await pub.getCode({ address: balancer }).catch(() => undefined)) ?? '0x').length > 2;
      if (!created) return;
      // The design moves to the new pool; a failed step continues on its Design page.
      if (!ok) saveDraft(current(), balancer);
      clearDraft();
      create?.onCreated(balancer, ok ? undefined : `The pool was created. ${tx.failure.current} Finish below.`);
    }
  };

  const save = mode === 'preview' ? (
    <div className="pin">
      <ConnectButton.Custom>{({ openConnectModal }) => <button className="btn lg" disabled={!ready} onClick={() => { markConnectIntent(); openConnectModal(); }}>Connect wallet to create this pool</button>}</ConnectButton.Custom>
      <p className="note" style={{ marginTop: 10 }}>Next you choose which NFTs from your wallet, then create the pool. This design stays as it is.</p>
    </div>
  ) : (
    <div className="pin">
      {restricted === restrictKey && toList.length > 0 && (
        <p className="note error" style={{ marginBottom: 12 }}>A collection here refuses transfers to contracts. A buyer using a contract that never claims its refund can lock that NFT in FWA escrow permanently. In a pool with few listings, that can cost the buyer much less than the NFT is worth.</p>
      )}
      <button className="btn lg" disabled={!!tx.busy || !!blocked || !ready || !ev?.feasible} onClick={run}>
        {tx.busy ? `${tx.busy}…` : restricted === restrictKey && toList.length ? 'Continue anyway' : mode === 'new' ? `Create pool with ${eth(deposit, 2)} ETH` : has ? 'Save changes' : 'Save and open'}
      </button>
      {blocked && <p className="note" style={{ marginTop: 10 }}>{blocked}</p>}
      {refused && <p className="note error" style={{ marginTop: 10 }}>{refused}</p>}
      {!blocked && ev?.feasible && actions.length > 0 && <p className="note" style={{ marginTop: 10 }}>{sentence(actions)}. Up to {confirmations} confirmations in your wallet.</p>}
      {mode === 'new' && wallet !== undefined && !blocked && <p className="note" style={{ marginTop: 6 }}>You have {eth(wallet)} ETH in this wallet.</p>}
      {fresh && tx.msg && !tx.msg.ok && <p className="note error" style={{ marginTop: 10 }}>{tx.msg.text}</p>}
    </div>
  );

  return (
    <main className="page cols">
      <section>
        {mode === 'pool'
          ? <h2 className="title t2">{has ? 'Prices & mix' : 'Finish setting up your pool'}</h2>
          : <h1 className="title">Design your pool</h1>}
        <p className="lead">{has
          ? `What players pay and which Shapes the pool keeps. Your ${rows.length === 1 ? 'NFT stays' : `${rows.length} NFTs stay`} as listed; change ${rows.length === 1 ? 'it' : 'them'} on the NFTs tab.`
          : 'Players pay a draw price and win one prize at random. Your pool holds two kinds of prizes: your NFTs, and Shapes you fund with ETH.'}</p>
        <div className="row" style={{ marginTop: 14, gap: 24 }}>
          {!has && <button className="disclose quiet" onClick={() => setHow(!how)}>How a pool works {how ? '▴' : '▾'}</button>}
          {!has && <a className="link quiet" style={{ fontSize: 14 }} href="#how">More in How it works</a>}
          <button className="link quiet" style={{ fontSize: 14 }} onClick={reset}>{has ? 'Reset to saved' : 'Reset to defaults'}</button>
        </div>
        {how && !has && (
          <ol className="how">
            <li>Players pay a draw price on FWA. Every draw wins one prize: one of your NFTs or a Shape.</li>
            <li>Your NFTs are the prizes you give away. You set each one's value; a lower value is won more often.</li>
            <li>A Shape is a token that holds a fixed amount of ETH, from 0.01 to 100. The winner can redeem it for that ETH.</li>
            <li>Your ETH buys the Shapes. When one is won, the pool replaces it with the same prize, paid from your ETH and the draw payments, so the mix stays as you set it.</li>
            <li>Your markup is part of every draw price, and it is yours. You can withdraw ETH the pool does not need.</li>
          </ol>
        )}

        {!has && <div className="step">
          <div className="step-head"><span className="n">1</span><h2 className="h3">Your NFTs</h2></div>
          <p className="note" style={{ marginBottom: 10 }}>The value is your asking price: across the draws until it is won, players pay about that plus your markup. A higher value makes it rarer.{mode === 'preview' && ' You choose which NFTs after connecting a wallet.'}</p>
          {listed.map((l) => (
            <div className="mixrow" key={l.id.toString()}>
              <Thumb n={{ collection: l.collection, tokenId: l.tokenId }} small />
              <div><div className="t"><a className="tlink" href={openSeaAsset(l.collection, l.tokenId)} target="_blank" rel="noreferrer" title="View on OpenSea">{nftName(l)}</a></div><div className="s">Listed{oddsLine(`l${l.id}`) && ` · ${oddsLine(`l${l.id}`)}`}</div></div>
              <span className="end mono">{eth(l.base)} ETH</span>
            </div>
          ))}
          {pending.map(({ n, i }, k) => (
            <Fragment key={i}>
              <div className="mixrow">
                {n.collection && <Thumb key={nftKey(n.collection, n.tokenId!)} n={{ collection: n.collection, tokenId: BigInt(n.tokenId!), image: n.image }} small />}
                <div style={{ minWidth: 0 }}>
                  <div className="t">{n.collection ? <a className="tlink" href={openSeaAsset(n.collection, n.tokenId!)} target="_blank" rel="noreferrer" title="View on OpenSea">{rowName(n, listed.length + k)}</a> : rowName(n, listed.length + k)}</div>
                  {(oddsLine(`d${i}`) || n.floor) && <div className="s">{[oddsLine(`d${i}`), n.floor && `collection floor ${floorText(n.floor)}`].filter(Boolean).join(' · ')}</div>}
                  {mode !== 'preview' && <button className="link" style={{ fontSize: 13 }} onClick={() => setPicking(picking === i ? undefined : i)}>{picking === i ? 'Cancel' : n.collection ? 'Change' : 'Choose from your wallet'}</button>}
                </div>
                <div className="field end" style={{ width: 150 }}><input aria-label={`Value of ${rowName(n, listed.length + k)}`} value={n.value} onChange={(e) => setNft(i, { value: e.target.value })} inputMode="decimal" /><span className="u">ETH</span></div>
                <button className="link quiet" aria-label={`Remove ${rowName(n, listed.length + k)}`} disabled={!listed.length && pending.length === 1} onClick={() => { setPicking(undefined); setNfts(nfts.filter((_, j) => j !== i)); }}>×</button>
              </div>
              {picking === i && me && (
                <NftChooser me={me} limit={20 - listed.length - pending.length + 1} exclude={[...listedKeys, ...nfts.filter((x, j) => j !== i && x.collection).map((x) => nftKey(x.collection!, x.tokenId!))]}
                  onPick={(xs) => {
                    setEdited(true); setPicking(undefined);
                    setNfts([...nfts.slice(0, i), { ...nfts[i], ...xs[0] }, ...nfts.slice(i + 1), ...xs.slice(1).map((x) => ({ value: nfts[i].value, ...x }))]);
                  }} />
              )}
            </Fragment>
          ))}
          {listed.length + pending.length < 20 && <button className="disclose" style={{ marginTop: 12 }} onClick={() => { setNfts([...nfts, { value: pending[pending.length - 1]?.n.value || DEFAULT_NFT.value }]); if (mode !== 'preview') setPicking(nfts.length); }}>+ Add an NFT</button>}
        </div>}

        <div className="step">
          <div className="step-head"><span className="n">{has ? 1 : 2}</span><h2 className="h3">Game style</h2></div>
          <div className="options" role="group" aria-label="Game style">
            {GAME_STYLES.map((g) => (
              <button key={g.key} aria-pressed={style === g.key} onClick={() => choose(g.key)}>
                <span><span className="t">{g.label}</span><span className="s">{g.hint}</span></span>
                {style === g.key && <span className="sel">SELECTED</span>}
              </button>
            ))}
          </div>
          <div className="summary">
            <span>{ready ? <>{style ? '' : 'Custom: '}{mixText(counts)}</> : bases.length ? 'No mix reaches these odds.' : 'Add an NFT with a value.'}</span>
            <button className="disclose" onClick={() => toggle('bonus')}>{open.bonus ? 'Close ▴' : 'Adjust prizes ▾'}</button>
          </div>
          {open.bonus && (
            <>
              <p className="note" style={{ margin: '10px 0 6px' }}>Prizes on top of the small Shapes. The small Shapes adjust to keep your NFT odds. Bigger prizes raise the draw price and the ETH needed.</p>
              {[...new Set([...BONUS, ...bonus.flatMap((n, i) => (n ? [i] : []))])].sort((x, y) => BY_VALUE.indexOf(x) - BY_VALUE.indexOf(y)).map((i) => {
                const t = bonus[i] ? tierOf(i) : undefined;
                return (
                  <div className="mixrow" key={i}>
                    <div><div className="t">{prizeLabel(i)}</div>{t && <div className="s">Each {oneIn(t.odds / counts[i])} draws · {t.multiple.toFixed(1)}× the draw</div>}</div>
                    <div className="stepper end">
                      <button aria-label={`One fewer ${prizeLabel(i)}`} disabled={!bonus[i]} onClick={() => setBonusAt(i, bonus[i] - 1)}>−</button>
                      <output aria-live="polite">{bonus[i]}</output>
                      <button aria-label={`One more ${prizeLabel(i)}`} disabled={total >= MAX_SHAPES_PER_PLAN} onClick={() => setBonusAt(i, bonus[i] + 1)}>+</button>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
        {view && <div className="mobile-only" style={{ marginTop: 32 }}>{payBlock}{gridBlock}{playBlock}</div>}

        <div className="step">
          <div className="step-head"><span className="n">{has ? 2 : 3}</span><h2 className="h3">Pool size</h2></div>
          <div className="limit" style={{ marginTop: 0 }}>
            <div className="top"><label htmlFor="small">Small prizes (0.01 ETH Shapes)</label><b>{smallUsed}</b></div>
            <input id="small" type="range" min={shapeTotal(bonus) ? 0 : 1} max={room} step={1} value={smallUsed}
              onChange={(e) => change(setSmall)(Number(e.target.value))} />
            <p className="note">More small prizes make your NFTs rarer and the draw cheaper. A pool holds up to {MAX_SHAPES_PER_PLAN} Shapes.</p>
            <p className="note" style={{ marginTop: 6 }}>The pool keeps this mix: each prize that is won is replaced with the same prize, paid from the pool's ETH. Your NFTs are not replaced.</p>
          </div>
          {ready && view && (
            <div className="summary">
              <span>{rows.length > 1 ? 'An NFT' : 'Your NFT'} {oneIn(view.curated)} draws <span className="muted">· players pay {eth(view.cost, 5)} ETH</span></span>
            </div>
          )}
        </div>

        <div className="step">
          <div className="step-head"><span className="n">{has ? 3 : 4}</span><h2 className="h3">Your markup</h2></div>
          <div className="limit" style={{ marginTop: 0 }}>
            <div className="top"><label htmlFor="markup">Added to every draw price, and yours to keep</label><b>{markup}%</b></div>
            <input id="markup" type="range" min={0} max={100} step={0.25} value={markup} onChange={(e) => change(setMarkup)(Number(e.target.value))} />
            {econ && markupBps < econ.breakEvenBps && Number.isFinite(econ.breakEvenBps)
              ? <p className="note error">Below {pct(econ.breakEvenBps)}, mint fees and keeper rewards cost more than you keep. <button className="link" style={{ fontSize: 13 }} onClick={() => change(setMarkup)(Math.ceil(econ.breakEvenBps / 100))}>Use {Math.ceil(econ.breakEvenBps / 100)}%</button></p>
              : econ?.belowModeledMarkup && Number.isFinite(econ.minMarkupBps)
                ? <p className="note">Covers mint fees and keeper rewards. {pct(econ.minMarkupBps)} adds a 25% safety margin.</p>
                : <p className="note">Higher markup raises the draw price.</p>}
            <p className="note">Gas and FWA's randomness fee are set at draw time and are not included.</p>
          </div>
        </div>

        <div style={{ marginTop: 32 }}>{save}</div>
        {has && <p className="note" style={{ marginTop: 14 }}>A markup change applies to prizes listed after it. Listed prizes keep their price.</p>}
      </section>

      <section className="sticky">
        {view && ev && econ ? (
          <>
            {compare}
            <div className="desktop-only">{payBlock}</div>
            {!open.numbers ? (
              <>
                <div className="desktop-only">{gridBlock}</div>
                {fresh ? (
                  <div className="result-block">
                    <div className="kvline"><div><div>ETH to create the pool</div><p className="note">Deposited when you create it</p></div><div><span className="figure-s">{eth(deposit, 2)}</span><span className="unit">ETH</span></div></div>
                    <div className="kv"><span className="k">In Shapes</span><span>{eth(capitalOf(counts))} ETH</span></div>
                    <div className="kv"><span className="k">Mint fees, a spare top prize and upkeep</span><span>{eth(needed - capitalOf(counts))} ETH</span></div>
                    {deposit > needed && <div className="kv"><span className="k">Rounded up</span><span>{eth(deposit - needed)} ETH</span></div>}
                  </div>
                ) : (
                  <div className="result-block">
                    <div className="kv"><span className="k">Kept in the pool while open</span><span>{eth(needed)} ETH</span></div>
                    <div className="kv"><span className="k">Available in the pool</span><span>{eth(have)} ETH</span></div>
                    {shortBy > 0n
                      ? <div className="kv"><span className="k"><b>Deposited when you save</b></span><span><b>{eth(shortBy, 2)} ETH</b></span></div>
                      : <div className="kv"><span className="k">Not used</span><span>{eth(have - needed)} ETH</span></div>}
                  </div>
                )}
                <div className="result-block kvline">
                  <div><div>You keep, per draw</div><p className="note">On average, after costs</p></div>
                  <div><span className={`figure-s${econ.expectedNetPerDraw < 0 ? ' error' : ''}`}>{signed(econ.expectedNetPerDraw)}</span><span className="unit">ETH</span></div>
                </div>
                <div className="result-block"><button className="disclose" onClick={() => toggle('numbers')}>All numbers ▾</button></div>
                <div className="desktop-only">{playBlock}</div>
              </>
            ) : (
              <div className="result-block">
                <div className="section-head"><h2 className="h3">All numbers</h2><button className="disclose" onClick={() => toggle('numbers')}>Close ▴</button></div>
                <div className="kv-group">
                  <span className="label">For players</span>
                  <div className="kv"><span className="k">Draw price</span><span>{eth(ev.drawPrice, 5)} ETH</span></div>
                  <div className="kv"><span className="k">Wins one of your NFTs</span><span>{oneIn(view.curated)} · {pctOf(view.curated)}</span></div>
                  <div className="kv"><span className="k">Wins more than they paid</span><span>{oneIn(view.winMore)} · {pctOf(view.winMore)}</span></div>
                  <div className="kv"><span className="k">Wins 2× or more</span><span>{oneIn(view.win2x)} · {pctOf(view.win2x)}</span></div>
                  <div className="kv"><span className="k">Top prize</span><span>{eth(view.top.value, 3).replace(/\.?0+$/, '')} ETH · {oneIn(view.top.odds)}</span></div>
                  <div className="kv"><span className="k">Average prize value</span><span>{(view.avgReturn * 100).toFixed(0)}% of cost</span></div>
                </div>
                <div className="kv-group">
                  <span className="label">For you</span>
                  <div className="kv"><span className="k">ETH held in Shapes</span><span>{eth(ev.capital)} ETH</span></div>
                  <div className="kv"><span className="k">{fresh ? 'Needed to open' : 'Kept in the pool while open'}</span><span>{eth(needed)} ETH</span></div>
                  <div className="kv"><span className="k">{fresh ? 'Deposited' : 'Available'}</span><span>{eth(have)} ETH</span></div>
                  <div className="kv"><span className="k">You keep per draw</span><span>{signed(econ.expectedNetPerDraw)} ETH</span></div>
                  <div className="kv"><span className="k">Markup that covers costs with a 25% margin</span><span>{Number.isFinite(econ.minMarkupBps) ? pct(econ.minMarkupBps) : '–'}</span></div>
                </div>
              </div>
            )}
          </>
        ) : <p className="lead">{bases.length ? 'Pick a style or add Shapes to see what players get.' : 'Add an NFT with a value to see what players get.'}</p>}
      </section>
    </main>
  );
}

function Nfts({ d, tx, isCreator, me, setTab }: { d: D; tx: Tx; isCreator: boolean; me: Address; setTab: (t: Tab) => void }) {
  const B = { address: d.balancer, abi: poolBalancerAbi } as const;
  const curated = d.listings.filter((l) => l.kind === 1 && l.state === 1);
  const [edit, setEdit] = useState<{ id: bigint; value: string }>();
  const [stray, setStray] = useState({ open: false, collection: '', tokenId: '' });
  const odds = (l: Listing) => (d.totalWeight ? Number(l.weight) / Number(d.totalWeight) : 0);
  const name = (l: Listing) => `${d.names[l.collection] ?? short(l.collection)} #${l.tokenId}`;
  return (
    <main className="page cols">
      <section>
        <h2 className="title t2">Your NFTs</h2>
        <p className="lead">Players can win these. A lower value is won more often.</p>
        <div className="section">
          {curated.length === 0 && d.pending.length === 0 && <p className="note">No NFTs listed. Purchases stay closed until you add one.</p>}
          {curated.map((l) => (
            <div className="nft" key={l.id.toString()}>
              <Thumb n={{ collection: l.collection, tokenId: l.tokenId }} />
              <div>
                <div className="t"><a className="tlink" href={openSeaAsset(l.collection, l.tokenId)} target="_blank" rel="noreferrer" title="View on OpenSea">{name(l)}</a></div>
                <div className="s">Your value {eth(l.base)} ETH · price on FWA {eth(l.price, 5)} ETH</div>
                <div className="s">Won about {oneIn(odds(l))} draws</div>
                {edit?.id === l.id && (
                  <div className="row" style={{ marginTop: 10 }}>
                    <div className="field" style={{ width: 160 }}><input aria-label="New value" value={edit.value} onChange={(e) => setEdit({ id: l.id, value: e.target.value })} inputMode="decimal" /><span className="u">ETH</span></div>
                    <button className="btn" disabled={!!tx.busy || !edit.value} onClick={() => tx.send('Change value', [() => tx.write({ ...B, functionName: 'updateCuratedPrice', args: [l.id, ethOr(edit.value, 0n)] })]).then((ok) => ok && setEdit(undefined))}>Save {edit.value || '0'} ETH</button>
                  </div>
                )}
              </div>
              {isCreator && (
                <div className="acts">
                  <button className="link" onClick={() => setEdit(edit?.id === l.id ? undefined : { id: l.id, value: eth(l.base) })}>{edit?.id === l.id ? 'Cancel' : 'Change value'}</button>
                  <button className="link quiet" disabled={!!tx.busy} onClick={() => tx.send('Withdraw', [() => tx.write({ ...B, functionName: 'withdrawCurated', args: [l.id, me] })])}>Withdraw</button>
                </div>
              )}
            </div>
          ))}
          {d.pending.map((l) => {
            const refunded = l.fwaStatus === L_DELIVERY_REFUNDED;
            return (
              <div className="nft" key={l.id.toString()}>
                <div className="thumb">{l.kind === 2 ? 'Shape' : 'NFT'}</div>
                <div>
                  <div className="t">{l.kind === 2 ? prizeLabel(l.denom) : name(l)}</div>
                  <div className="s">{refunded ? 'Drawn. FWA refunded the buyer; you can take it back.' : 'Drawn. FWA could not deliver it yet; it retries or refunds the buyer after 7 days.'}</div>
                </div>
                <div className="acts">
                  {refunded && isCreator && <button className="link" disabled={!!tx.busy} onClick={() => tx.send(l.kind === 1 ? 'Recover' : 'Recover and redeem', [() => tx.write({ ...B, functionName: 'recoverRefunded', args: [l.id, me] })])}>Recover</button>}
                </div>
              </div>
            );
          })}
        </div>
      </section>
      {isCreator && (
        <section>
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

/** Lists one more NFT on a live pool, showing what it does to the draw price and NFT odds under the saved mix first. */
function AddNft({ d, tx, me, setTab }: { d: D; tx: Tx; me: Address; setTab: (t: Tab) => void }) {
  const pub = usePublicClient();
  const [picks, setPicks] = useState<DraftNft[]>([]);
  const [choosing, setChoosing] = useState(true);
  const [restricted, setRestricted] = useState<string>();
  const [refused, setRefused] = useState<string>();
  const listed = d.listings.filter((l) => l.kind === 1 && l.state === 1);
  const bases = listed.map((l) => l.base);
  const keyOf = (n: DraftNft) => nftKey(n.collection!, n.tokenId!);
  const key = picks.map(keyOf).join();
  const ready = picks.length > 0 && picks.every((n) => ethOr(n.value, 0n) > 0n);
  const newBases = picks.map((n) => ethOr(n.value, 0n)).filter((v) => v > 0n);
  const room = 20 - listed.length;
  const plan = d.target ? unpackPlan(d.target) : undefined;
  const inputs: DesignInputs = {
    curatedBases: bases, markupBps: d.markupBps, edgeBps: Number(d.edgeBps), mintFee: d.mintFee,
    have: d.activeShapes,
  };
  const before = plan && bases.length ? describe(plan, inputs) : undefined;
  const after = plan && newBases.length ? describe(plan, { ...inputs, curatedBases: [...bases, ...newBases] }) : undefined;
  const cost = (ev: ReturnType<typeof describe>) => ev.drawPrice;
  const what = picks.length === 1 ? nftLabel(picks[0]) : `${word(picks.length)} NFTs`;
  const list = async () => {
    if (!pub || !ready) return;
    if (restricted !== key && await refusesContracts(pub, me, picks)) { setRestricted(key); return; }
    const r = await refusedApprovals(pub, me, d.balancer, picks);
    setRefused(r.length ? `This pool cannot list ${r.join(', ')}: the collection does not let this pool take the NFT.` : undefined);
    if (r.length) return;
    const ok = await tx.send('List NFTs', [
      ...approveSteps(pub, tx, me, d.balancer, picks),
      [`List ${what}`, () => tx.write({ address: d.balancer, abi: poolBalancerAbi, functionName: 'listCuratedBatch', args: [picks.map((n) => ({ collection: n.collection!, tokenId: BigInt(n.tokenId!), base: ethOr(n.value, 0n) }))] })],
      upkeepStep(pub, tx, me, d.balancer),
    ]);
    if (ok) { setPicks([]); setChoosing(true); setRestricted(undefined); }
  };
  return (
    <>
      <h2 className="h3" style={{ fontSize: 22 }}>Add NFTs</h2>
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
        <NftChooser me={me} limit={room - picks.length} exclude={[...listed.map((l) => nftKey(l.collection, l.tokenId)), ...picks.map(keyOf)]}
          onPick={(xs) => { setPicks([...picks, ...xs.map((x) => ({ value: '', ...x }))]); setChoosing(false); setRefused(undefined); }} />
      ) : picks.length < room && <button className="disclose" style={{ marginTop: 12 }} onClick={() => setChoosing(true)}>+ Add more</button>}
      {after && (
        <div className="section">
          <span className="label">With {picks.length === 1 ? 'this NFT' : 'these NFTs'}</span>
          <div className="kv"><span className="k">Players pay</span><span>{before ? `${eth(cost(before), 5)} → ` : ''}{eth(cost(after), 5)} ETH</span></div>
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
      <p className="note" style={{ marginTop: 8 }}>Listing closes purchases until upkeep runs; upkeep runs right after.</p>
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
  const plan = d.target ? unpackPlan(d.target) : ZERO;
  const backing = d.activeShapes.reduce((s, n, i) => s + BigInt(n) * DENOMS[i], 0n);
  const bases = d.listings.filter((l) => l.kind === 1 && l.state === 1).map((l) => l.base);
  const econ = bases.length && plan.some(Boolean)
    ? economics(plan, { curatedBases: bases, markupBps: d.markupBps, edgeBps: Number(d.edgeBps), mintFee: d.mintFee }, { gasPriceGwei: 0, drawsPerUpkeep: 1, safety: 0.25 })
    : undefined;
  const month = econ ? econ.expectedNetPerDraw * (Number(assume.perDay) || 0) * 30 : 0;
  const missing = plan.reduce((s, n, i) => s + Math.max(0, n - d.activeShapes[i]), 0);
  const planned = plan.reduce((a, b) => a + b, 0);
  const idle = d.balance > d.required ? d.balance - d.required : 0n;
  const short_ = d.required > d.balance ? d.required - d.balance : 0n;
  const start = (m: 'deposit' | 'claim') => { setMode(mode === m ? undefined : m); setAmount(m === 'claim' ? eth(d.surplus, 6) : '0.100'); };

  // Live inventory: every listing FWA can draw now, weighted as FWA weights it.
  const cost = d.fee; // the draw price; FWA's randomness fee and gas are set at draw time
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
  const nftOdds = items.filter((x) => x.nft).reduce((a, x) => a + x.p, 0);

  return (
    <main className="page cols">
      <section>
        <div className="result-block" style={{ paddingTop: 0 }}>
          <span className="soft" style={{ fontSize: 14 }}>Players pay</span>
          <div style={{ marginTop: 8 }}><span className="figure">{d.fee ? eth(cost, 5) : '–'}</span><span className="unit">ETH per draw</span></div>
          {d.fee > 0n && <p className="note" style={{ marginTop: 10 }}>Draw price at {d.markupBps / 100}% markup. FWA's randomness (VRF) fee and gas are added at draw time.</p>}
        </div>
        <div className="result-block">
          <div className="section-head"><h2 className="h3">In the pool now</h2>{isCreator && <button className="link" onClick={() => setTab('mix')}>Change prices or mix</button>}</div>
          {items.length ? (
            <>
              <InventoryGrid items={items} />
              <div className="legend">
                {sizes.map((dn) => {
                  const xs = items.filter((x) => !x.nft && x.label === prizeLabel(dn));
                  return <div key={dn}><span className="sw" style={xs[0].style} /><span><b>{xs.length}</b> × {prizeLabel(dn)} · each {oneIn(xs[0].p)}</span></div>;
                })}
                {nftOdds > 0 && <div><span className="sw" style={{ border: '1.5px solid #fff' }} /><span><b>{items.filter((x) => x.nft).length}</b> of your NFTs · {oneIn(nftOdds)} draws for any of them</span></div>}
              </div>
              <p className="note" style={{ marginTop: 14 }}>Each square is one item listed on FWA. Hover or tap a square for its chance and value.</p>
            </>
          ) : <p className="note">Nothing is listed on FWA right now.</p>}
          {planned > 0 && missing > 0 && <p className="note" style={{ marginTop: 8 }}>{missing} of {planned} planned Shapes are not listed yet. Upkeep lists them.</p>}
        </div>
      </section>

      <section className="sticky">
        <div className="result-block" style={{ paddingTop: 0 }}>
          <h2 className="h3">Your ETH</h2>
          <div className="kv"><span className="k">In Shapes</span><span>{eth(backing)} ETH</span></div>
          <div className="kv"><span className="k">Kept for restocking</span><span>{eth(d.required)} ETH</span></div>
          <div className="kv"><span className="k">Not used</span><span>{eth(idle)} ETH</span></div>
          {short_ > 0n && <div className="kv"><span className="k error">Short of the reserve</span><span className="error">{eth(short_)} ETH</span></div>}
          <div className="kv"><span className="k"><b>Total in the pool</b></span><span><b>{eth(backing + d.balance)} ETH</b></span></div>
          {d.proceeds > 0n && <div className="kv"><span className="k">Sales waiting to be collected</span><span>{eth(d.proceeds)} ETH</span></div>}
          {isCreator && idle > backing + d.required && <p className="note" style={{ marginTop: 10 }}>Most of this ETH is not used. Add Shapes on <button className="link" style={{ fontSize: 13 }} onClick={() => setTab('mix')}>Prices & mix</button>, or withdraw it.</p>}
          <div className="row" style={{ marginTop: 16 }}>
            {d.proceeds > 0n && <button className="btn" disabled={!!tx.busy} onClick={() => tx.send('Collect from sales', [() => tx.write({ ...B, functionName: 'collectProceeds' })])}>Collect {eth(d.proceeds)} ETH</button>}
            <button className={mode === 'deposit' ? 'btn' : 'btn sec'} onClick={() => start('deposit')}>Deposit</button>
            {isCreator && <button className={mode === 'claim' ? 'btn' : 'btn sec'} disabled={d.surplus === 0n} onClick={() => start('claim')}>Withdraw unused</button>}
          </div>
          {isCreator && d.surplus < idle && <p className="note" style={{ marginTop: 8 }}>{eth(d.surplus)} ETH can be withdrawn now. The rest once pending draws settle.</p>}
          {mode && (
            <div className="row" style={{ marginTop: 12 }}>
              <div className="field" style={{ width: 180 }}><input aria-label={mode === 'deposit' ? 'Deposit amount' : 'Withdraw amount'} className="big" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /><span className="u">ETH</span></div>
              <button className="btn" disabled={!!tx.busy || !amount} onClick={() => tx.send(mode === 'deposit' ? 'Deposit' : 'Withdraw', [() => tx.write(mode === 'deposit'
                ? { ...B, functionName: 'depositETH', value: ethOr(amount, 0n) }
                : { ...B, functionName: 'claimSurplus', args: [ethOr(amount, 0n), me] })]).then((ok) => ok && setMode(undefined))}>
                {mode === 'deposit' ? `Deposit ${amount || '0'} ETH` : `Withdraw ${amount || '0'} ETH to your wallet`}
              </button>
            </div>
          )}
        </div>

        <div className="result-block">
          <h2 className="h3">Earnings</h2>
          {econ ? (
            <>
              <div className="row" style={{ gap: 40, marginTop: 12 }}>
                <div><span className="note">Per draw</span><div><span className={`figure-s${econ.expectedNetPerDraw < 0 ? ' error' : ''}`}>{signed(econ.expectedNetPerDraw)}</span><span className="unit">ETH</span></div></div>
                <div><span className="note">Every 30 days</span><div><span className={`figure-s${month < 0 ? ' error' : ''}`}>{signed(month)}</span><span className="unit">ETH</span></div></div>
              </div>
              <p className="note" style={{ marginTop: 10 }}>Assumes {assume.perDay} draws a day. Gas is set at draw time and is not included. <button className="link" style={{ fontSize: 13 }} onClick={() => setAssume({ ...assume, open: !assume.open })}>Change</button></p>
              {assume.open && (
                <div className="row" style={{ marginTop: 10 }}>
                  <div className="field" style={{ width: 150 }}><input aria-label="Draws per day" value={assume.perDay} onChange={(e) => setAssume({ ...assume, perDay: e.target.value })} inputMode="numeric" /><span className="u">/DAY</span></div>
                </div>
              )}
              <button className="disclose" style={{ marginTop: 16 }} onClick={() => setHow(!how)}>How this is worked out {how ? '▴' : '▾'}</button>
              {how && (
                <div style={{ marginTop: 12 }}>
                  <div className="kv"><span className="k">Average prize value on FWA</span><span>{econ.ownerProceeds.toFixed(5)} ETH</span></div>
                  <div className="kv"><span className="k">Your markup share</span><span>{econ.grossMarginPerDraw.toFixed(5)} ETH</span></div>
                  <div className="kv"><span className="k">Mint fees and keeper rewards</span><span>−{econ.overheadPerDraw.toFixed(5)} ETH</span></div>
                  <div className="kv"><span className="k">Markup that covers costs with a 25% margin</span><span>{Number.isFinite(econ.minMarkupBps) ? pct(econ.minMarkupBps) : '–'}</span></div>
                  <p className="note" style={{ marginTop: 10 }}>An estimate from the current mix. Single draws vary; short runs can lose money either way.</p>
                </div>
              )}
            </>
          ) : <p className="note" style={{ marginTop: 8 }}>Earnings appear once an NFT is listed and a mix is saved.</p>}
        </div>
      </section>
    </main>
  );
}

/** FWA's pool-page profile, in its schema's key order (the hash covers JSON.stringify of exactly this). */
const PROFILE_KEYS = ['avatarUrl', 'bannerUrl', 'description', 'websiteUrl', 'xUrl', 'discordUrl'] as const;
const PROFILE_LABELS: Record<string, string> = { avatarUrl: 'Avatar URL', bannerUrl: 'Banner URL', websiteUrl: 'Website', xUrl: 'X', discordUrl: 'Discord' };

function Settings({ d, tx }: { d: D; tx: Tx }) {
  const pub = usePublicClient();
  const B = { address: d.balancer, abi: poolBalancerAbi } as const;
  const [name, setName] = useState('');
  const [profile, setProfile] = useState<Record<string, string>>(Object.fromEntries(PROFILE_KEYS.map((k) => [k, ''])));
  const [more, setMore] = useState(false);
  const [result, setResult] = useState<string>();
  const [ens, setEns] = useState<{ open: boolean; name: string; forward?: string | null }>({ open: false, name: '' });
  const [step, setStep] = useState<'transfer' | 'retire'>();
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const backing = d.activeShapes.reduce((s, n, i) => s + BigInt(n) * DENOMS[i], 0n);
  useEffect(() => {
    if (!ens.name) return;
    let live = true;
    pub?.getEnsAddress({ name: normalize(ens.name) }).then((a) => live && setEns((e) => ({ ...e, forward: a }))).catch(() => live && setEns((e) => ({ ...e, forward: null })));
    return () => { live = false; };
  }, [pub, ens.name]);
  const publish = async () => {
    const metadata = { name, profile: Object.fromEntries(PROFILE_KEYS.map((k) => [k, profile[k] ?? ''])) };
    const issuedAt = new Date().toISOString();
    const hash = keccak256(toBytes(JSON.stringify(metadata)));
    if (!(await tx.send('Approve pool page', [() => tx.write({ ...B, functionName: 'approvePoolPage', args: [issuedAt, hash] })]))) return;
    // The Balancer ignores signature bytes. 66 zero bytes: viem-style verifiers reject very short signatures
    // before calling ERC-1271, and a non-65-byte value cannot be read as an ECDSA signature.
    const body = { pool: d.pool, issuedAt, metadata, signature: `0x${'00'.repeat(66)}` };
    if (chain.id !== 1) { setResult('Approved on this test network. On mainnet the page is then sent to FWA.'); return; }
    try {
      const res = await fetch('https://pools.fwa.fun/api/fwa/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      setResult(res.ok ? 'FWA accepted the page.' : `FWA rejected it (${res.status}): ${await res.text()}`);
    } catch (e) {
      setResult(`Could not reach FWA from this page: ${(e as Error).message}`);
    }
  };
  const forwardOk = ens.forward?.toLowerCase() === d.balancer.toLowerCase();
  return (
    <main className="page cols">
      <section>
        <h2 className="title t2">Settings</h2>
        <div className="section">
          <h2 className="h3" style={{ fontSize: 22 }}>Page on FWA</h2>
          <label className="form-label" htmlFor="pname">Pool name</label>
          <div className="field"><input id="pname" value={name} onChange={(e) => setName(e.target.value)} placeholder="2 to 64 characters" /></div>
          <label className="form-label" htmlFor="about">About</label>
          <div className="field area"><textarea id="about" value={profile.description} onChange={(e) => setProfile({ ...profile, description: e.target.value })} /></div>
          <button className="disclose quiet" style={{ marginTop: 12 }} onClick={() => setMore(!more)}>Links and images {more ? '▴' : '▾'}</button>
          {more && PROFILE_KEYS.filter((k) => k !== 'description').map((k) => (
            <div key={k}><label className="form-label" htmlFor={k}>{PROFILE_LABELS[k]}</label><div className="field"><input id={k} value={profile[k]} onChange={(e) => setProfile({ ...profile, [k]: e.target.value })} /></div></div>
          ))}
          <div className="row" style={{ marginTop: 20, gap: 16 }}>
            <button className="btn" disabled={!!tx.busy || name.length < 2 || name.length > 64} onClick={publish}>Approve and publish</button>
            <span className="note">One confirmation in your wallet. FWA has not confirmed it accepts pool owners that are contracts.</span>
          </div>
          {result && <p className="note" style={{ marginTop: 10 }}>{result}</p>}
        </div>
        <div className="section">
          <h2 className="h3" style={{ fontSize: 22, marginBottom: 12 }}>ENS name</h2>
          <div className="kv">
            <span className="mono">{d.ensName ?? 'None'}</span>
            <button className="link" onClick={() => setEns({ ...ens, open: !ens.open, name: ens.name || d.ensName || '' })}>{ens.open ? 'Cancel' : 'Change'}</button>
          </div>
          {ens.open && (
            <>
              <div className="row" style={{ marginTop: 12 }}>
                <div className="field" style={{ flex: 1 }}><input aria-label="ENS name" className="mono" placeholder="name.eth" value={ens.name} onChange={(e) => setEns({ ...ens, name: e.target.value, forward: undefined })} /></div>
                <button className="btn" disabled={!!tx.busy || !ens.name} onClick={() => tx.send('Set ENS name', [() => tx.write({ ...B, functionName: 'setENSName', args: [ens.name] })])}>Set name</button>
                {d.ensName && <button className="btn sec" disabled={!!tx.busy} onClick={() => tx.send('Clear ENS name', [() => tx.write({ ...B, functionName: 'setENSName', args: [''] })])}>Clear</button>}
              </div>
              {ens.name && ens.forward !== undefined && (
                <p className={`note${forwardOk ? '' : ' error'}`} style={{ marginTop: 8 }}>
                  {forwardOk ? `${ens.name} points to this pool.` : `${ens.name} points to ${ens.forward ? short(ens.forward) : 'nothing'}. Set its ETH address to ${short(d.balancer)} in the ENS app.`}
                </p>
              )}
            </>
          )}
        </div>
      </section>
      <section>
        <h2 className="h3" style={{ fontSize: 22 }}>Close down</h2>
        <p className="note" style={{ margin: '8px 0 20px' }}>Get your ETH back or hand the pool to someone else. These steps affect players, so each one asks you to confirm.</p>
        <div className="kv">
          <div><div style={{ fontWeight: 700 }}>Unlist prizes</div><p className="note">{d.enabled ? 'Close purchases first.' : `Returns the ${eth(backing)} ETH held in prizes to the pool, 20 at a time.`}</p></div>
          <button className="link" disabled={!!tx.busy || d.enabled || backing === 0n} onClick={() => tx.send('Unlist prizes', [() => tx.write({ ...B, functionName: 'unlistShapes', args: [d.listings.filter((l) => l.kind === 2 && l.state === 1).slice(0, 20).map((l) => l.id)] })])}>Unlist</button>
        </div>
        <div className="kv">
          <div><div style={{ fontWeight: 700 }}>Transfer to another creator</div><p className="note">{d.pendingCreator !== ZERO_ADDR ? `Offered to ${short(d.pendingCreator)}. They accept before anything changes.` : 'They accept before anything changes.'}</p></div>
          <button className="link" onClick={() => setStep(step === 'transfer' ? undefined : 'transfer')}>{step === 'transfer' ? 'Cancel' : 'Start'}</button>
        </div>
        {step === 'transfer' && (
          <div className="row" style={{ padding: '12px 0' }}>
            <div className="field" style={{ flex: 1 }}><input aria-label="New creator address" className="mono" placeholder="0x…" value={next} onChange={(e) => setNext(e.target.value)} /></div>
            <button className="btn" disabled={!!tx.busy || !/^0x[0-9a-fA-F]{40}$/.test(next)} onClick={() => tx.send('Start transfer', [() => tx.write({ ...B, functionName: 'transferCreator', args: [next as Address] })])}>Offer pool</button>
          </div>
        )}
        <div className="kv">
          <div><div style={{ fontWeight: 700 }}>Retire pool</div><p className="note">{d.retired ? 'Retired.' : `Closes ${poolName(d)} for good. You type RETIRE to confirm.`}</p></div>
          <button className="link danger" disabled={d.retired} onClick={() => setStep(step === 'retire' ? undefined : 'retire')}>{step === 'retire' ? 'Cancel' : 'Retire'}</button>
        </div>
        {step === 'retire' && (
          <div className="row" style={{ padding: '12px 0' }}>
            <div className="field" style={{ flex: 1 }}><input aria-label="Type RETIRE to confirm" className="mono" placeholder="RETIRE" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>
            <button className="btn" disabled={!!tx.busy || d.enabled || confirm !== 'RETIRE'} onClick={() => tx.send('Retire', [() => tx.write({ ...B, functionName: 'retire' })])}>Retire for good</button>
            {d.enabled && <p className="note" style={{ width: '100%' }}>Close purchases first.</p>}
          </div>
        )}
      </section>
    </main>
  );
}

const SHOWN = 120;

/** Picks one NFT for a Design row: from the wallet scan, or by contract and token ID. */
function NftChooser({ me, exclude, limit = 20, onPick }: { me: Address; exclude: string[]; limit?: number; onPick: (xs: Omit<DraftNft, 'value'>[]) => void }) {
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
      <WalletPicker me={me} listed={exclude} limit={limit}
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
function WalletPicker({ me, listed, limit, onPick, onEmpty }: { me: Address; listed: string[]; limit: number; onPick: (ns: WalletNft[], c: Collection) => void; onEmpty: () => void }) {
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
        {tokens && shown.length > 0 && <p className="note" style={{ marginBottom: 8 }}>Select one or more.{limit < shown.length ? ` Up to ${limit} more.` : ''}</p>}
        <div className="picker" role="listbox" aria-multiselectable="true" aria-label={`Your ${col.name} tokens`}>
          {shown.slice(0, SHOWN).map((n) => (
            <button key={keyOf(n)} role="option" aria-selected={chosen.includes(keyOf(n))} title={`${n.name} #${n.tokenId}`}
              disabled={!chosen.includes(keyOf(n)) && chosen.length >= limit}
              onClick={() => setChosen((c) => (c.includes(keyOf(n)) ? c.filter((k) => k !== keyOf(n)) : c.length < limit ? [...c, keyOf(n)] : c))}>
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
function InventoryGrid({ items }: { items: InvItem[] }) {
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
      </div>
      {it && (
        <div className="tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
          <div className="tt">{it.label}</div>
          <div className="kvline"><span className="muted">Chance per draw</span><span>{oneIn(it.p)} · {pctOf(it.p)}</span></div>
          <div className="kvline"><span className="muted">{it.nft ? 'Your value' : 'Redeems for'}</span><span>{eth(it.value, 4)} ETH</span></div>
          <div className="kvline"><span className="muted">Price on FWA</span><span>{eth(it.price, 5)} ETH</span></div>
          <div className="kvline"><span className="muted">Worth vs draw cost</span><span>{it.mult.toFixed(2)}×</span></div>
        </div>
      )}
    </div>
  );
}
