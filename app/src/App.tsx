import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useConnect, usePublicClient, useWriteContract } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { BaseError, ContractFunctionRevertedError, decodeFunctionResult, encodeFunctionData, formatEther, keccak256, parseAbi, parseAbiItem, parseEther, toBytes, type Address, type Hash } from 'viem';
import { normalize } from 'viem/ens';
import { balancerFactoryAbi, erc721Abi, fwaPoolAbi, poolBalancerAbi, shapesAbi } from '../../shared/abi';
import {
  DENOM_LABELS, DENOMS, MAX_PLANS, MAX_SHAPES_PER_PLAN, capitalOf, economics, packPlan, unpackPlan, type Counts,
} from '../../shared/planner';
import { available, describe, ethNeeded, playerView, recommend, type DesignInputs, type Style } from '../../shared/design';
import { chain, FACTORY, FROM_BLOCK, FWA_POOL_URL } from './chain';
import { prepareWrite } from './tx';
import { nftImage, scanWalletNfts, type WalletNft } from './wallet';

const SHAPES: Address = '0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0';
const FWA_FACTORY: Address = '0x8919814D825a5Af238cC04DE06b1C18c9eaA477C';
const fwaFactoryAbi = parseAbi(['function edgeBps() view returns (uint16)', 'function poolCreationEnabled() view returns (bool)', 'function implementation() view returns (address)']);
const CREATED = parseAbiItem('event BalancerCreated(address indexed creator, address indexed balancer, address indexed pool, bytes32 salt)');
const DRAWN = parseAbiItem('event ItemDrawn(uint256 indexed listingId, uint8 kind, uint8 denom, bool delivered)');
const L_DELIVERY_REFUNDED = 7;
const nameAbi = parseAbi(['function name() view returns (string)']);

export const STATUS: Record<number, string> = {
  0: 'Open: the Balancer admits purchases',
  1: 'Closed by creator',
  2: 'Needs upkeep (run maintenance)',
  3: 'Waiting for an FWA purchase batch to settle',
  4: 'No curated NFTs listed',
  5: 'No approved plan meets the price and odds limits',
  6: 'Not enough ETH for the required reserve',
  7: 'Shapes mint fee rose above the funded level (run maintenance)',
  8: 'FWA price above the ceiling',
  9: 'Token purchases active',
  10: 'Repricing listings after a markup change',
  11: 'FWA pool retired or in withdraw-only mode',
  12: 'FWA inventory does not match the plan',
  13: 'Not configured',
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
    const [creator, pendingCreator, config, plans, activePlan, enabled, repricing, lastStatus, admission, required, surplus, activeIds, activeShapes, balance, checkpoint] =
      await Promise.all([
        r<Address>('creator'), r<Address>('pendingCreator'), r<readonly [bigint, number, number]>('config'), r<bigint[]>('getPlans'),
        r<number>('activePlan'), r<boolean>('enabled'), r<boolean>('repricing'), r<number>('lastStatus'), r<number>('admissionStatus'),
        r<bigint>('requiredReserve'), r<bigint>('withdrawableSurplus'), r<bigint[]>('getActiveIds'),
        r<number[]>('getActiveShapes'), pub.getBalance({ address: b }),
        r<readonly [boolean, bigint, bigint, bigint, bigint]>('checkpoint'),
      ]);
    // Upkeep is needed exactly when simulating it succeeds.
    const upkeep = await pub.simulateContract({ address: b, abi: poolBalancerAbi, functionName: 'performUpkeep', account: b })
      .then(() => ({ needed: true }), () => ({ needed: false }));
    // Drawn items whose FWA delivery failed are not scanned on chain; find them from events.
    const drawn = await pub.getLogs({ address: b, event: DRAWN, fromBlock: FROM_BLOCK });
    const failedIds = [...new Set(drawn.filter((l) => !l.args.delivered).map((l) => l.args.listingId!))];
    const baseFee = (await pub.getBlock()).baseFeePerGas ?? 0n;
    const [fee, proceeds, totalWeight, retired, unsettled, mintFee, edgeBps, vrfFee] = await Promise.all([
      p<bigint>('acquisitionFee'), p<bigint>('ownerProceeds'), p<bigint>('totalWeight'), p<boolean>('retired'),
      p<bigint>('unsettledAcquisitionCount'),
      pub.readContract({ address: SHAPES, abi: shapesAbi, functionName: 'mintFee' }) as Promise<bigint>,
      pub.readContract({ address: FWA_FACTORY, abi: fwaFactoryAbi, functionName: 'edgeBps' }) as Promise<number>,
      // FWA charges the VRF fee at the buyer's gas price, so quote one draw at the current network gas price.
      pub.getGasPrice()
        .then((gasPrice) => pub.call({ to: pool, gasPrice, data: encodeFunctionData({ abi: fwaPoolAbi, functionName: 'quoteAcquisitionPrice', args: [1n] }) }))
        .then(({ data }) => decodeFunctionResult({ abi: fwaPoolAbi, functionName: 'quoteAcquisitionPrice', data: data! })[1], () => 0n),
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
      balancer: b, pool, creator, pendingCreator, enabled, repricing, lastStatus, admission, upkeep, required, surplus, balance, plans, activePlan,
      config: { maxDrawPrice: config[0], minCuratedOddsBps: config[1], markupBps: config[2] },
      checkpoint: { valid: checkpoint[0], reserve: checkpoint[4] },
      activeShapes: activeShapes.map(Number),
      fee, proceeds, totalWeight, retired, unsettled, mintFee, edgeBps, vrfFee, listings, pending, baseFee, names, ensName,
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
  PoolBusy: 'an FWA purchase batch is unresolved or not yet reconciled; wait, then run upkeep',
  InsufficientSurplus: 'amount exceeds claimable surplus',
  Unauthorized: 'only the creator can do this',
  NotClosed: 'close purchases first',
  InvalidPlan: 'a plan has no Shapes or more than 40',
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
const mixText = (c: Counts) => {
  const parts = c.map((n, i) => (n ? `${word(n)} ${DENOM_LABELS[i]}` : '')).filter(Boolean);
  if (!parts.length) return 'No Shapes';
  const total = c.reduce((a, b) => a + b, 0);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `${cap(list)} ETH Shape${total > 1 ? 's' : ''}`;
};
const poolName = (d: D) => d.ensName ?? `Pool ${short(d.balancer)}`;

/** One sentence for the pool's state, and the action or tab that resolves it. */
function statusLine(d: D): { head: string; body: string; act?: 'upkeep' | 'open' | Tab; label?: string } {
  if (d.retired) return { head: 'Retired.', body: 'The pool no longer sells draws. Withdrawals still work.' };
  if (!d.plans.length) return { head: 'Not set up.', body: 'Finish the design and save it to open purchases.' };
  switch (d.admission) {
    case 0: return { head: 'Open.', body: 'Players can buy draws. Nothing needs attention.' };
    case 1: return { head: 'Closed.', body: 'You closed purchases.', act: 'open' };
    case 2: return { head: 'Needs upkeep.', body: 'Run upkeep to restore the mix and reopen.', act: 'upkeep' };
    case 3: return { head: 'Settling.', body: 'A purchase on FWA is being settled. Upkeep follows.' };
    case 4: return { head: 'Closed.', body: 'List one of your NFTs to reopen.', act: 'nfts', label: 'Add an NFT' };
    case 5: return { head: 'Closed.', body: 'No saved mix meets your price and NFT odds limits.', act: 'mix', label: 'Prices & mix' };
    case 6: return { head: 'Closed.', body: `Deposit ${eth(d.required > d.balance ? d.required - d.balance : 0n)} ETH to cover the reserve.`, act: 'overview', label: 'Deposit' };
    case 7: return { head: 'Needs upkeep.', body: 'The Shapes mint fee changed.', act: 'upkeep' };
    case 8: return { head: 'Closed.', body: 'The FWA price is above your highest draw price.', act: 'mix', label: 'Prices & mix' };
    case 9: return { head: 'Closed.', body: 'Token purchases are active on FWA.' };
    case 10: return { head: 'Repricing.', body: 'Run upkeep until every listing carries the new markup.', act: 'upkeep' };
    case 11: return { head: 'Withdraw only.', body: 'FWA allows withdrawals only.' };
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
        <span className="wordmark">FWA Pool Balancer</span>
        {isConnected && loaded && (
          <nav className="topnav" aria-label="Main">
            <button aria-current={page === 'list' ? 'page' : undefined} onClick={() => setPage('list')}>Your pools</button>
          </nav>
        )}
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
    </>
  );
}

/** The short state of a pool for the list: from its admission status, or "Not set up" before a design is saved. */
const HEADS: Record<number, string> = { 0: 'Open', 1: 'Closed', 2: 'Needs upkeep', 3: 'Settling', 4: 'Closed: no NFTs', 5: 'Closed: no mix fits', 6: 'Needs ETH', 7: 'Needs upkeep', 8: 'Closed: price above ceiling', 9: 'Closed', 10: 'Repricing', 11: 'Withdraw only', 12: 'Needs upkeep' };

/** Every pool this wallet created, with its state and ETH, and the way to start another. */
function PoolList({ pools, names, onOpen, onNew }: { pools: Address[]; names: Record<string, string>; onOpen: (b: Address) => void; onNew: () => void }) {
  const pub = usePublicClient();
  const [info, setInfo] = useState<Record<string, { head: string; eth: bigint }>>({});
  useEffect(() => {
    if (!pub) return;
    let live = true;
    Promise.all(pools.map(async (b) => {
      const r = <T,>(functionName: string) => pub.readContract({ address: b, abi: poolBalancerAbi, functionName: functionName as never }) as Promise<T>;
      const [admission, plans, shapes, balance] = await Promise.all([r<number>('admissionStatus'), r<bigint[]>('getPlans'), r<number[]>('getActiveShapes'), pub.getBalance({ address: b })]);
      const backing = shapes.reduce((s, n, i) => s + BigInt(n) * DENOMS[i], 0n);
      return [b, { head: plans.length ? HEADS[admission] ?? 'Check the pool' : 'Not set up', eth: balance + backing }] as const;
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
  const setup = !d.plans.length && isCreator && !d.retired;
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
          {isCreator && !d.enabled && st.act !== 'open' && d.plans.length > 0 && !d.retired && <button className="link quiet" disabled={!!tx.busy} onClick={() => tx.send('Open purchases', [() => tx.write({ ...B, functionName: 'open' })])}>Open purchases</button>}
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
type DraftNft = { value: string; collection?: Address; tokenId?: string; name?: string };
/** Design work not yet saved on chain: one for the pool not yet created, and one per pool whose design is unsaved. */
type Draft = { budget: string; markup: number; floor: number; counts: Counts; fallbacks: Counts[]; style?: Style; nfts?: DraftNft[]; values?: string[] };
const draftKey = (b?: Address) => (b ? `pool-design-draft:${b.toLowerCase()}` : 'pool-design-draft');
const loadDraft = (b?: Address): Draft | undefined => { try { return JSON.parse(localStorage.getItem(draftKey(b)) ?? 'null') ?? undefined; } catch { return undefined; } };
const saveDraft = (x: Draft, b?: Address) => { try { localStorage.setItem(draftKey(b), JSON.stringify(x)); } catch { /* storage unavailable */ } };
const clearDraft = (b?: Address) => { try { localStorage.removeItem(draftKey(b)); } catch { /* storage unavailable */ } };
const INTENT_KEY = 'connect-from-preview';
const markConnectIntent = () => { try { sessionStorage.setItem(INTENT_KEY, '1'); } catch { /* storage unavailable */ } };
const takeConnectIntent = () => { try { const v = sessionStorage.getItem(INTENT_KEY); sessionStorage.removeItem(INTENT_KEY); return !!v; } catch { return false; } };
const DEFAULT_NFT: DraftNft = { value: '0.050' };
const nftKey = (collection: string, tokenId: bigint | string) => `${collection}:${tokenId}`.toLowerCase();
/** FWA's VRF fee is this much gas at the buyer's gas price, per purchase (measured on a mainnet-fork pool). */
const VRF_GAS = 2_340_000n;
const approvalAbi = parseAbi(['function getApproved(uint256 tokenId) view returns (address)', 'function isApprovedForAll(address owner, address operator) view returns (bool)']);
type Prereq = { creation: boolean; impl: boolean };

/** The Design page for a pool that does not exist yet: live fees and gas from chain; NFTs and budget from the draft. */
function NewPool({ me, prereq, onCreated }: { me?: Address; prereq?: Prereq; onCreated: Create['onCreated'] }) {
  const pub = usePublicClient();
  const tx = useTx(() => undefined);
  const [live, setLive] = useState<{ edgeBps: number; mintFee: bigint; baseFee: bigint; vrfFee: bigint }>();
  const [wallet, setWallet] = useState<bigint>();
  useEffect(() => {
    if (!pub) return;
    Promise.all([
      pub.readContract({ address: FWA_FACTORY, abi: fwaFactoryAbi, functionName: 'edgeBps' }) as Promise<number>,
      pub.readContract({ address: SHAPES, abi: shapesAbi, functionName: 'mintFee' }) as Promise<bigint>,
      pub.getBlock(), pub.getGasPrice(),
    ]).then(([edgeBps, mintFee, block, gasPrice]) => setLive({ edgeBps, mintFee, baseFee: block.baseFeePerGas ?? 0n, vrfFee: VRF_GAS * gasPrice }))
      .catch(() => undefined);
  }, [pub]);
  useEffect(() => { if (pub && me) pub.getBalance({ address: me }).then(setWallet).catch(() => undefined); }, [pub, me, tx.busy]);
  if (!live) return <main className="page"><p className="lead">Loading current fees…</p></main>;
  // Only the fields Design reads; a pool that does not exist has no plans, listings or balance.
  const d = { plans: [], activePlan: 0, listings: [], balance: 0n, activeShapes: ZERO, names: {}, balancer: ZERO_ADDR, enabled: false, ...live } as unknown as D;
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

const STYLES: { key: Style; label: string; hint: string }[] = [
  { key: 'steady', label: 'Low draw price', hint: 'Cheapest draw your NFT odds allow' },
  { key: 'balanced', label: 'More big wins', hint: 'Most chances to win 2× the draw or more' },
  { key: 'jackpot', label: 'Jackpot', hint: 'Largest Shape prize your budget allows' },
];
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
  const has = d.plans.length > 0;
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
  const [budget, setBudget] = useState(fresh ? draft?.budget ?? '1.000' : eth(available(d.balance, d.activeShapes, ZERO)));
  const [markup, setMarkup] = useState(has ? d.config.markupBps / 100 : draft?.markup ?? 15);
  const [floor, setFloor] = useState(has ? d.config.minCuratedOddsBps / 100 : draft?.floor ?? 5);
  const [style, setStyle] = useState<Style | undefined>(draft?.style);
  const [counts, setCounts] = useState<Counts>(has ? unpackPlan(d.plans[d.activePlan]) : draft?.counts ?? ZERO);
  const [fallbacks, setFallbacks] = useState<Counts[]>(has ? d.plans.filter((_, i) => i !== d.activePlan).map(unpackPlan) : draft?.fallbacks ?? []);
  // Shown rounded up to 6 decimals, so re-saving never lowers the saved ceiling; left as shown, the saved value is kept.
  const savedCeiling = has ? String(Math.ceil(Number(formatEther(d.config.maxDrawPrice)) * 1e6) / 1e6) : '';
  const [ceiling, setCeiling] = useState(savedCeiling);
  const [gas, setGas] = useState('1');
  const [note, setNote] = useState<string>();
  const [restricted, setRestricted] = useState<string>();
  const [refused, setRefused] = useState<string>();
  const [open, setOpen] = useState({ mix: false, fallbacks: false, advanced: false, numbers: false });
  const [gridView, setGridView] = useState<'inventory' | 'draws'>('inventory');
  const [how, setHow] = useState(fresh);
  const salt = useMemo(() => `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, '0')).join('')}` as `0x${string}`, []);
  const toggle = (k: keyof typeof open) => setOpen({ ...open, [k]: !open[k] });
  const markupBps = Math.round(markup * 100);
  const floorBps = Math.round(floor * 100);
  const inputs: DesignInputs = {
    curatedBases: bases, markupBps, edgeBps: Number(d.edgeBps), mintFee: d.mintFee, budget: ethOr(budget, 0n),
    have: d.activeShapes, baseFee: d.baseFee, minCuratedOddsBps: floorBps, vrfFee: d.vrfFee,
  };
  const pick = (st: Style, over: Partial<DesignInputs> = {}) => {
    const r = recommend(st, { ...inputs, ...over });
    setStyle(st);
    if (!r.best) { setNote('No mix fits this budget and NFT chance. Raise the budget or lower the minimum chance.'); return; }
    setNote(undefined);
    setCounts(r.best);
    setFallbacks(r.fallbacks);
  };
  // Until a mix is saved, a chosen style follows the NFTs as they change (a hand-tuned mix is kept as is); with no
  // mix yet, the first style is picked.
  useEffect(() => {
    if (has || !bases.length) return;
    if (style) pick(style);
    else if (!counts.some(Boolean)) pick('steady');
  }, [bases.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  // Until a design is saved on chain, keep it in this browser so it survives connecting, reloading and a failed step.
  const current = (): Draft => ({ budget, markup, floor, counts, fallbacks, style, nfts });
  useEffect(() => {
    if (!has) saveDraft(current(), fresh ? undefined : d.balancer);
  }, [has, budget, markup, floor, counts, fallbacks, style, nfts]); // eslint-disable-line react-hooks/exhaustive-deps
  const setNft = (i: number, x: Partial<DraftNft>) => setNfts(nfts.map((n, j) => (j === i ? { ...n, ...x } : n)));
  const reset = () => {
    const m = has ? d.config.markupBps / 100 : 15;
    const f = has ? d.config.minCuratedOddsBps / 100 : 5;
    const b = fresh ? '1.000' : eth(available(d.balance, d.activeShapes, ZERO));
    setMarkup(m); setFloor(f); setBudget(b); setNote(undefined); setGas('1');
    setOpen({ mix: false, fallbacks: false, advanced: false, numbers: false });
    if (has) {
      setStyle(undefined);
      setCounts(unpackPlan(d.plans[d.activePlan]));
      setFallbacks(d.plans.filter((_, i) => i !== d.activePlan).map(unpackPlan));
      setCeiling(savedCeiling);
      return;
    }
    setCeiling('');
    const fresh1 = fresh || !listed.length;
    setNfts(fresh1 ? [DEFAULT_NFT] : []);
    setPicking(undefined);
    pick('steady', { markupBps: m * 100, minCuratedOddsBps: f * 100, budget: ethOr(b, 0n), curatedBases: [...listed.map((l) => l.base), ...(fresh1 ? [parseEther(DEFAULT_NFT.value)] : [])] });
  };
  const total = counts.reduce((a, b) => a + b, 0);
  const setCount = (i: number, n: number) => { setStyle(undefined); setCounts(counts.map((x, j) => (j === i ? Math.max(0, n) : x))); };
  const ready = bases.length > 0 && total > 0;
  const ev = ready ? describe(counts, inputs) : undefined;
  const view = ev ? playerView(ev, markupBps, d.vrfFee) : undefined;
  const plans = [counts, ...fallbacks];
  // Default ceiling: 25% above the highest draw price among the saved mixes, so fallbacks stay admissible.
  const autoCeiling = ready ? (plans.map((c) => describe(c, inputs).drawPrice).reduce((a, b) => (b > a ? b : a), 0n) * 125n) / 100n : 0n;
  const ceilingWei = has && ceiling === savedCeiling ? d.config.maxDrawPrice : ceiling ? ethOr(ceiling, autoCeiling) : autoCeiling;
  const checked = ready ? describe(counts, inputs, ceilingWei) : undefined;
  const needed = ready ? ethNeeded(counts, inputs) : 0n;
  const balance = fresh ? inputs.budget : d.balance;
  const have = available(balance, d.activeShapes, counts);
  const econ = ready ? economics(counts, inputs, { gasPriceGwei: Number(gas) || 1, drawsPerUpkeep: 1, safety: 0.25 }) : undefined;
  const affordable = (i: number) => 2n * (DENOMS[i] + d.mintFee) <= inputs.budget;
  const addable = DENOMS.map((_, i) => i).filter((i) => !counts[i] && affordable(i));
  const tooBig = DENOMS.map((_, i) => i).filter((i) => !affordable(i));
  const tierOf = (i: number) => view?.tiers.find((t) => t.kind === 'shape' && t.label.startsWith(`${DENOM_LABELS[i]} ETH`));
  const fits = needed <= have;

  // Out of 100 draws: whole draws per prize group by largest remainder, NFTs grouped.
  const groups = view ? [
    ...(view.curated > 0 ? [{ key: 'nft', i: -1, p: view.curated, nft: true, value: 0n, n: 0 }] : []),
    ...counts.map((n, i) => ({ key: `s${i}`, i, n, p: tierOf(i)?.odds ?? 0, nft: false, value: DENOMS[i] })).filter((g) => g.n > 0),
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
    const what = g.n === 1 && shapeGroups.length > 1 && g === shapeGroups[shapeGroups.length - 1] ? `the ${DENOM_LABELS[g.i]} ETH Shape` : `a ${DENOM_LABELS[g.i]} ETH Shape`;
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
      key: `s${g.i}-${j}`, label: `${DENOM_LABELS[g.i]} ETH Shape`, nft: false, value: t.value, price: t.listPrice, p: t.odds / g.n, mult: t.multiple, style: sw(g),
    })) : [];
  }) : [];
  // What stops one more of the smallest Shape in the mix (or 0.01 ETH): the 40-Shape limit, the NFT odds floor or the budget.
  const limitNote = (() => {
    if (!ready) return undefined;
    if (total >= MAX_SHAPES_PER_PLAN) return `The contract allows ${MAX_SHAPES_PER_PLAN} Shapes per mix.`;
    const i = Math.max(0, counts.findIndex((n) => n > 0));
    const more = counts.map((n, j) => (j === i ? n + 1 : n));
    if (describe(more, inputs).curatedOddsBps < floorBps) return `Shapes are limited by your ${floor}% minimum chance of an NFT: each Shape makes your NFTs rarer, cheap ones most. Lower it, or add NFTs, to fit more.`;
    if (ethNeeded(more, inputs) > available(balance, d.activeShapes, more)) return 'Shapes are limited by your budget: each one needs its backing plus reserve.';
    return undefined;
  })();

  const payBlock = view && ev ? (
    <div className="result-block">
      <span className="soft" style={{ fontSize: 14 }}>Players pay</span>
      <div style={{ marginTop: 8 }}><span className="figure">{eth(view.cost, 5)}</span><span className="unit">ETH per draw</span></div>
      <p className="note" style={{ marginTop: 10 }}>{eth(ev.drawPrice, 5)} draw price plus {fresh ? 'about ' : 'a '}{eth(d.vrfFee, 5)} randomness (VRF) fee</p>
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
                  : <div key={g.key}><span className="sw" style={sw(g)} /><span><b>{g.n}</b> × {DENOM_LABELS[g.i]} ETH Shape · each {oneIn(g.p / g.n)}</span></div>))}
              </div>
              <p className="note" style={{ marginTop: 14 }}>Each square is one item in the pool. Hover or tap a square for its chance and value. Cheaper items come up more often.</p>
              {limitNote && <p className="note" style={{ marginTop: 8 }}>{limitNote}</p>}
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
  const configChanged = !has || markupBps !== d.config.markupBps || floorBps !== d.config.minCuratedOddsBps || ceilingWei !== d.config.maxDrawPrice
    || plans.slice(0, MAX_PLANS).map(packPlan).join() !== d.plans.join();
  const willOpen = !has && !d.enabled;
  const nftWord = (k: number) => `${k === 1 ? 'your' : word(k)} NFT${k === 1 ? '' : 's'}`;
  const actions = [
    mode === 'new' && `create the pool with ${budget || '0'} ETH`,
    toList.length > 0 && `approve and list ${nftWord(toList.length)}`,
    configChanged && 'save the design',
    willOpen && 'open purchases',
    (mode === 'new' || toList.length > 0 || configChanged) && (has ? 'run upkeep' : 'run the first upkeep'),
  ].filter(Boolean) as string[];
  const confirmations = (mode === 'new' ? 1 : 0) + (toList.length ? toList.length + 1 : 0) + (configChanged ? 1 : 0) + (willOpen ? 1 : 0) + (actions.length ? 1 : 0);
  const sentence = (xs: string[]) => cap(xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] ?? '');
  const wallet = create?.wallet;
  const blocked = !ready ? undefined
    : unchosen ? 'Choose which NFT each row is, or remove the row.'
      : !checked?.feasible ? undefined
        : mode === 'new' && create?.prereq && !(create.prereq.creation && create.prereq.impl) ? 'Pool creation is not available right now.'
          : mode === 'new' && !fits ? 'Raise the budget to cover what the pool needs to open.'
            : mode === 'new' && wallet !== undefined && ethOr(budget, 0n) > wallet ? `Your wallet has ${eth(wallet)} ETH.`
              : !actions.length ? 'Saved. Nothing has changed.' : undefined;
  const restrictKey = toList.map((n) => nftKey(n.collection!, n.tokenId!)).join();

  // On a configured pool: the saved design next to the one being edited.
  const savedCounts = has ? unpackPlan(d.plans[d.activePlan]) : ZERO;
  const savedEv = has && bases.length ? describe(savedCounts, { ...inputs, markupBps: d.config.markupBps, minCuratedOddsBps: d.config.minCuratedOddsBps }) : undefined;
  const savedView = savedEv ? playerView(savedEv, d.config.markupBps, d.vrfFee) : undefined;
  const compare = has && savedEv && savedView && view && ev ? (
    <div className="result-block" style={{ paddingTop: 0 }}>
      <span className="label">{configChanged ? 'Now → after saving' : 'Now'}</span>
      {([
        ['Players pay', `${eth(savedView.cost, 5)} ETH`, `${eth(view.cost, 5)} ETH`],
        ['Chance of one of your NFTs', pctOf(savedView.curated), pctOf(view.curated)],
        ['Shapes', mixText(savedCounts), mixText(counts)],
        ['Your markup', `${d.config.markupBps / 100}%`, `${markup}%`],
        ['ETH needed to stay open', `${eth(ethNeeded(savedCounts, inputs))} ETH`, `${eth(needed)} ETH`],
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
    if (mode === 'new') steps.push(['Create pool', () => tx.write({ address: FACTORY, abi: balancerFactoryAbi, functionName: 'createBalancer', args: [salt], value: ethOr(budget, 0n) })]);
    steps.push(...approveSteps(pub, tx, me, balancer, toList));
    if (toList.length) steps.push([`List ${nftWord(toList.length)}`, () => tx.write({ ...B, functionName: 'listCuratedBatch', args: [toList.map((n) => ({ collection: n.collection!, tokenId: BigInt(n.tokenId!), base: ethOr(n.value, 0n) }))] })]);
    if (configChanged) steps.push(['Save design', () => tx.write({ ...B, functionName: 'configure', args: [{ maxDrawPrice: ceilingWei, minCuratedOddsBps: floorBps, markupBps }, plans.slice(0, MAX_PLANS).map(packPlan)] })]);
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
      <button className="btn lg" disabled={!!tx.busy || !!blocked || !ready || !checked?.feasible} onClick={run}>
        {tx.busy ? `${tx.busy}…` : restricted === restrictKey && toList.length ? 'Continue anyway' : mode === 'new' ? `Create pool with ${budget || '0'} ETH` : has ? 'Save changes' : 'Save and open'}
      </button>
      {blocked && <p className="note" style={{ marginTop: 10 }}>{blocked}</p>}
      {refused && <p className="note error" style={{ marginTop: 10 }}>{refused}</p>}
      {!blocked && checked?.feasible && actions.length > 0 && <p className="note" style={{ marginTop: 10 }}>{sentence(actions)}. Up to {confirmations} confirmations in your wallet.</p>}
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
          <button className="link quiet" style={{ fontSize: 14 }} onClick={reset}>{has ? 'Reset to saved' : 'Reset to defaults'}</button>
        </div>
        {how && !has && (
          <ol className="how">
            <li>Players pay a draw price on FWA. Every draw wins one prize: one of your NFTs or a Shape.</li>
            <li>Your NFTs are the prizes you give away. You set each one's value; a lower value is won more often.</li>
            <li>A Shape is a token that holds a fixed amount of ETH, from 0.01 to 100. The winner can redeem it for that ETH.</li>
            <li>Your ETH buys the Shapes. When one is won, the pool buys a replacement from your ETH and the draw payments.</li>
            <li>Your markup is part of every draw price, and it is yours. You can withdraw ETH the pool does not need.</li>
          </ol>
        )}

        {!has && <div className="step">
          <div className="step-head"><span className="n">1</span><h2 className="h3">Your NFTs</h2></div>
          <p className="note" style={{ marginBottom: 10 }}>The prizes you give away. A lower value is won more often.{mode === 'preview' && ' You choose which NFTs after connecting a wallet.'}</p>
          {listed.map((l) => (
            <div className="mixrow" key={l.id.toString()}>
              <div><div className="t">{nftName(l)}</div><div className="s">Listed</div></div>
              <span className="end mono">{eth(l.base)} ETH</span>
            </div>
          ))}
          {pending.map(({ n, i }, k) => (
            <Fragment key={i}>
              <div className="mixrow">
                <div style={{ minWidth: 0 }}>
                  <div className="t">{rowName(n, listed.length + k)}</div>
                  {mode !== 'preview' && <button className="link" style={{ fontSize: 13 }} onClick={() => setPicking(picking === i ? undefined : i)}>{picking === i ? 'Cancel' : n.collection ? 'Change' : 'Choose from your wallet'}</button>}
                </div>
                <div className="field end" style={{ width: 150 }}><input aria-label={`Value of ${rowName(n, listed.length + k)}`} value={n.value} onChange={(e) => setNft(i, { value: e.target.value })} inputMode="decimal" /><span className="u">ETH</span></div>
                <button className="link quiet" aria-label={`Remove ${rowName(n, listed.length + k)}`} disabled={!listed.length && pending.length === 1} onClick={() => { setPicking(undefined); setNfts(nfts.filter((_, j) => j !== i)); }}>×</button>
              </div>
              {picking === i && me && (
                <NftChooser me={me} current={n} exclude={[...listedKeys, ...nfts.filter((x, j) => j !== i && x.collection).map((x) => nftKey(x.collection!, x.tokenId!))]}
                  onPick={(x) => { setNft(i, x); setPicking(undefined); }} />
              )}
            </Fragment>
          ))}
          {listed.length + pending.length < 20 && <button className="disclose" style={{ marginTop: 12 }} onClick={() => { setNfts([...nfts, { value: pending[pending.length - 1]?.n.value || DEFAULT_NFT.value }]); if (mode !== 'preview') setPicking(nfts.length); }}>+ Add an NFT</button>}
        </div>}

        <div className="step">
          <div className="step-head"><span className="n">{has ? 1 : 2}</span><h2 className="h3">Shapes</h2></div>
          <p className="note" style={{ marginBottom: 6 }}>ETH prizes that fill the rest of the pool. Each Shape holds 0.01 to 100 ETH, redeemable by the winner.</p>
          <div className="budget">
            <div><label htmlFor="budget" style={{ fontSize: 15 }}>ETH for Shapes</label><p className="note">{fresh ? 'Deposited when you create the pool.' : `${eth(available(d.balance, d.activeShapes, ZERO))} ETH available in this pool.`}</p></div>
            <div className="field"><input id="budget" className="big" value={budget} onChange={(e) => setBudget(e.target.value)} onBlur={() => style && pick(style)} inputMode="decimal" /><span className="u">ETH</span></div>
          </div>

          <span className="form-label" style={{ marginTop: 24 }}>How to spend it</span>
          <div className="options" role="group" aria-label="Shape mix">
            {STYLES.map((s) => (
              <button key={s.key} aria-pressed={style === s.key} onClick={() => pick(s.key)}>
                <span><span className="t">{s.label}</span><span className="s">{s.hint}</span></span>
                {style === s.key && <span className="sel">SELECTED</span>}
              </button>
            ))}
          </div>
          {note && <p className="note error" style={{ marginTop: 10 }}>{note}</p>}

          <div className="limit">
            <div className="top"><label htmlFor="floor">Minimum chance of winning one of your NFTs</label><b>{floor}%</b></div>
            <input id="floor" type="range" min={0} max={50} step={0.5} value={floor} onChange={(e) => setFloor(Number(e.target.value))} onPointerUp={() => style && pick(style)} onKeyUp={() => style && pick(style)} />
            <p className="note">Each Shape makes your NFTs rarer. Shapes stop at this chance.</p>
          </div>

          {!open.mix ? (
            <div className="summary">
              <span>{ready ? <>{mixText(counts)}{fresh && <span className="muted"> · {eth(capitalOf(counts))} ETH in Shapes, {eth(needed > capitalOf(counts) ? needed - capitalOf(counts) : 0n)} ETH for mint fees and reserve</span>}</> : 'No Shapes yet'}</span>
              <button className="disclose" onClick={() => toggle('mix')}>Adjust by hand ▾</button>
            </div>
          ) : (
            <>
              <div className="section-head" style={{ marginTop: 24 }}><span className="form-label" style={{ margin: 0 }}>Adjust by hand</span><button className="disclose" onClick={() => toggle('mix')}>Close ▴</button></div>
              <p className="note" style={{ margin: '6px 0 12px' }}>Cheaper Shapes come up more often. Small Shapes lower the draw price and make your NFTs rarer.</p>
              {DENOMS.map((_, i) => i).filter((i) => counts[i] > 0).map((i) => {
                const t = tierOf(i);
                return (
                  <div className="mixrow" key={i}>
                    <div><div className="t">{DENOM_LABELS[i]} ETH Shapes</div><div className="s">Each {t ? oneIn(t.odds / counts[i]) : '–'} draws · worth {t ? t.multiple.toFixed(2) : '–'}× the cost</div></div>
                    <div className="stepper end">
                      <button aria-label={`One fewer ${DENOM_LABELS[i]} ETH Shape`} onClick={() => setCount(i, counts[i] - 1)}>−</button>
                      <output aria-live="polite">{counts[i]}</output>
                      <button aria-label={`One more ${DENOM_LABELS[i]} ETH Shape`} disabled={total >= MAX_SHAPES_PER_PLAN} onClick={() => setCount(i, counts[i] + 1)}>+</button>
                    </div>
                  </div>
                );
              })}
              {addable.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <span style={{ fontSize: 14 }}>Add a Shape size</span>
                  <div className="chips">{addable.map((i) => <button key={i} className="btn sec" disabled={total >= MAX_SHAPES_PER_PLAN} onClick={() => setCount(i, 1)}>+ {DENOM_LABELS[i]} ETH</button>)}</div>
                </div>
              )}
              <p className="note" style={{ marginTop: 10 }}>
                {tooBig.length > 0 && `${DENOM_LABELS[tooBig[0]]} to 100 ETH sizes need more ETH. `}{total} of {MAX_SHAPES_PER_PLAN} Shapes used.
              </p>
            </>
          )}
        </div>
        {view && <div className="mobile-only" style={{ marginTop: 32 }}>{payBlock}{gridBlock}</div>}

        <div className="step">
          <div className="step-head"><span className="n">{has ? 2 : 3}</span><h2 className="h3">Your markup</h2></div>
          <div className="limit" style={{ marginTop: 0 }}>
            <div className="top"><label htmlFor="markup">Added to every draw price, and yours to keep</label><b>{markup}%</b></div>
            <input id="markup" type="range" min={0} max={100} step={0.25} value={markup} onChange={(e) => setMarkup(Number(e.target.value))} onPointerUp={() => style && pick(style)} onKeyUp={() => style && pick(style)} />
            <p className="note">Higher markup raises the draw price.</p>
          </div>
        </div>

        {open.fallbacks && (
          <div className="section">
            <div className="section-head"><h2 className="h3">Fallback mixes</h2><button className="disclose" onClick={() => toggle('fallbacks')}>Close ▴</button></div>
            <p className="note" style={{ marginBottom: 12 }}>If this mix stops meeting your limits, upkeep switches to the first fallback that does. Up to {MAX_PLANS - 1}.</p>
            {fallbacks.map((c, k) => {
              const f = describe(c, inputs, ceilingWei);
              return (
                <div className="mixrow" key={k}>
                  <div>
                    <div className="t">{k + 1}. {mixText(c)}</div>
                    <div className="s">Draw {eth(f.drawPrice, 5)} ETH · your NFT {oneIn(f.curatedOddsPpm / 1e6)}{!f.feasible && <span className="error"> · {f.reasons.join('; ')}</span>}</div>
                  </div>
                  <button className="link quiet end" onClick={() => setFallbacks(fallbacks.filter((_, j) => j !== k))}>Remove</button>
                </div>
              );
            })}
            {fallbacks.length < MAX_PLANS - 1 && total > 0 && !fallbacks.some((c) => c.join() === counts.join()) && (
              <button className="disclose" style={{ marginTop: 14 }} onClick={() => setFallbacks([...fallbacks, counts])}>+ Save the current mix as a fallback</button>
            )}
          </div>
        )}
        {open.advanced && (
          <div className="section">
            <div className="section-head"><h2 className="h3">Advanced</h2><button className="disclose" onClick={() => toggle('advanced')}>Close ▴</button></div>
            <div className="budget">
              <div><label htmlFor="ceiling" style={{ fontSize: 15 }}>Highest draw price allowed</label><p className="note">Auto is 25% above your highest mix.</p></div>
              <div className="field" style={{ width: 200 }}><input id="ceiling" value={ceiling} placeholder={`Auto ${eth(autoCeiling, 5)}`} onChange={(e) => setCeiling(e.target.value)} inputMode="decimal" /><span className="u">ETH</span></div>
            </div>
            <div className="budget">
              <div><label htmlFor="gas" style={{ fontSize: 15 }}>Gas price for estimates</label><p className="note">Used to estimate your costs.</p></div>
              <div className="field" style={{ width: 200 }}><input id="gas" value={gas} onChange={(e) => setGas(e.target.value)} inputMode="decimal" /><span className="u">GWEI</span></div>
            </div>
          </div>
        )}

        {checked && !checked.feasible && <p className="note error" style={{ marginTop: 24 }}>This mix does not meet your limits: {checked.reasons.join('; ').toLowerCase()}.</p>}
        <div style={{ marginTop: 32 }}>{save}</div>
        {(!open.fallbacks || !open.advanced) && (
          <button className="disclose quiet" style={{ marginTop: 14 }} onClick={() => setOpen({ ...open, fallbacks: true, advanced: true })}>Fallback mixes and advanced settings ▾</button>
        )}
        <p className="note" style={{ marginTop: 14 }}>A markup change reprices every listing during upkeep. Purchases stay closed until it completes.</p>
      </section>

      <section className="sticky">
        {view && ev && econ ? (
          <>
            {compare}
            <div className="desktop-only">{payBlock}</div>
            {!open.numbers ? (
              <>
                <div className="desktop-only">{gridBlock}</div>
                <div className="result-block kvline">
                  <div><div>To open, you need</div><p className="note">{fresh ? 'Your budget leaves' : 'You have'} {eth(have)} ETH. {fits ? 'This fits.' : `${fresh ? 'Raise the budget by' : 'Deposit'} ${eth(needed - have)} ${fresh ? 'ETH' : 'more'}.`}</p></div>
                  <div><span className="figure-s">{eth(needed)}</span><span className="unit">ETH</span></div>
                </div>
                <div className="result-block kvline">
                  <div><div>You keep, per draw</div><p className="note">On average, after costs</p></div>
                  <div><span className={`figure-s${econ.expectedNetPerDraw < 0 ? ' error' : ''}`}>{signed(econ.expectedNetPerDraw)}</span><span className="unit">ETH</span></div>
                </div>
                {econ.belowModeledMarkup && <p className="note error">Markup is below {pct(econ.minMarkupBps)}, the level that covers costs with a 25% margin.</p>}
                <div className="result-block"><button className="disclose" onClick={() => toggle('numbers')}>All numbers ▾</button></div>
              </>
            ) : (
              <div className="result-block">
                <div className="section-head"><h2 className="h3">All numbers</h2><button className="disclose" onClick={() => toggle('numbers')}>Close ▴</button></div>
                <div className="kv-group">
                  <span className="label">For players</span>
                  <div className="kv"><span className="k">Draw price</span><span>{eth(ev.drawPrice, 5)} ETH</span></div>
                  <div className="kv"><span className="k">Randomness (VRF) fee</span><span>{eth(d.vrfFee, 5)} ETH</span></div>
                  <div className="kv"><span className="k">Wins one of your NFTs</span><span>{oneIn(view.curated)} · {pctOf(view.curated)}</span></div>
                  <div className="kv"><span className="k">Wins more than they paid</span><span>{oneIn(view.winMore)} · {pctOf(view.winMore)}</span></div>
                  <div className="kv"><span className="k">Wins 2× or more</span><span>{oneIn(view.win2x)} · {pctOf(view.win2x)}</span></div>
                  <div className="kv"><span className="k">Top prize</span><span>{eth(view.top.value, 3).replace(/\.?0+$/, '')} ETH · {oneIn(view.top.odds)}</span></div>
                  <div className="kv"><span className="k">Average prize value</span><span>{(view.avgReturn * 100).toFixed(0)}% of cost</span></div>
                </div>
                <div className="kv-group">
                  <span className="label">For you</span>
                  <div className="kv"><span className="k">ETH held in Shapes</span><span>{eth(ev.capital)} ETH</span></div>
                  <div className="kv"><span className="k">Needed to open</span><span>{eth(needed)} ETH</span></div>
                  <div className="kv"><span className="k">Available</span><span>{eth(have)} ETH · {fits ? 'fits' : 'short'}</span></div>
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
              <div className="thumb">NFT</div>
              <div>
                <div className="t">{name(l)}</div>
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
                  <div className="t">{l.kind === 2 ? `${DENOM_LABELS[l.denom]} ETH Shape` : name(l)}</div>
                  <div className="s">{refunded ? 'Drawn. FWA refunded the buyer; you can take it back.' : 'Drawn. FWA could not deliver it yet; it retries or refunds the buyer after 7 days.'}</div>
                </div>
                <div className="acts">
                  {refunded && l.kind === 1 && isCreator && <button className="link" disabled={!!tx.busy} onClick={() => tx.send('Recover', [() => tx.write({ ...B, functionName: 'recoverCuratedNFT', args: [l.id, me] })])}>Recover</button>}
                  {refunded && l.kind === 2 && <button className="link" disabled={!!tx.busy} onClick={() => tx.send('Recover and redeem', [() => tx.write({ ...B, functionName: 'recoverRefundedShape', args: [l.id] })])}>Recover</button>}
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
  const [pick, setPick] = useState<DraftNft>({ value: '' });
  const [choosing, setChoosing] = useState(true);
  const [restricted, setRestricted] = useState<string>();
  const [refused, setRefused] = useState<string>();
  const listed = d.listings.filter((l) => l.kind === 1 && l.state === 1);
  const bases = listed.map((l) => l.base);
  const key = pick.collection ? nftKey(pick.collection, pick.tokenId!) : '';
  const newBase = ethOr(pick.value, 0n);
  const plan = d.plans.length ? unpackPlan(d.plans[d.activePlan]) : undefined;
  const inputs: DesignInputs = {
    curatedBases: bases, markupBps: d.config.markupBps, edgeBps: Number(d.edgeBps), mintFee: d.mintFee, budget: 0n,
    have: d.activeShapes, baseFee: d.baseFee, minCuratedOddsBps: d.config.minCuratedOddsBps, vrfFee: d.vrfFee,
  };
  const before = plan && bases.length ? describe(plan, inputs, d.config.maxDrawPrice) : undefined;
  const after = plan && newBase > 0n ? describe(plan, { ...inputs, curatedBases: [...bases, newBase] }, d.config.maxDrawPrice) : undefined;
  const cost = (ev: ReturnType<typeof describe>) => playerView(ev, d.config.markupBps, d.vrfFee).cost;
  const list = async () => {
    if (!pub || !pick.collection) return;
    if (restricted !== key && await refusesContracts(pub, me, [pick])) { setRestricted(key); return; }
    const r = await refusedApprovals(pub, me, d.balancer, [pick]);
    setRefused(r.length ? `This pool cannot list ${r[0]}: the collection does not let this pool take the NFT.` : undefined);
    if (r.length) return;
    const ok = await tx.send('List NFT', [
      ...approveSteps(pub, tx, me, d.balancer, [pick]),
      [`List ${nftLabel(pick)}`, () => tx.write({ address: d.balancer, abi: poolBalancerAbi, functionName: 'listCurated', args: [pick.collection!, BigInt(pick.tokenId!), newBase] })],
      upkeepStep(pub, tx, me, d.balancer),
    ]);
    if (ok) { setPick({ value: '' }); setChoosing(true); setRestricted(undefined); }
  };
  return (
    <>
      <h2 className="h3" style={{ fontSize: 22 }}>Add an NFT</h2>
      {pick.collection && !choosing ? (
        <div className="mixrow" style={{ marginTop: 12 }}>
          <div className="t">{nftLabel(pick)}</div>
          <button className="link end" onClick={() => setChoosing(true)}>Change</button>
        </div>
      ) : (
        <NftChooser me={me} current={pick} exclude={listed.map((l) => nftKey(l.collection, l.tokenId))}
          onPick={(x) => { setPick({ ...pick, ...x }); setChoosing(false); setRefused(undefined); }} />
      )}
      <label className="form-label" htmlFor="value">Your value</label>
      <div className="field"><input id="value" placeholder="0.000" value={pick.value} onChange={(e) => setPick({ ...pick, value: e.target.value })} inputMode="decimal" /><span className="u">ETH</span></div>
      {after && (
        <div className="section">
          <span className="label">With this NFT</span>
          <div className="kv"><span className="k">Players pay</span><span>{before ? `${eth(cost(before), 5)} → ` : ''}{eth(cost(after), 5)} ETH</span></div>
          <div className="kv"><span className="k">Chance of one of your NFTs</span><span>{before ? `${pctOf(before.curatedOddsPpm / 1e6)} → ` : ''}{pctOf(after.curatedOddsPpm / 1e6)}</span></div>
          {!after.feasible && <p className="note error" style={{ marginTop: 10 }}>With this NFT the saved mix breaks your limits: {after.reasons.join('; ').toLowerCase()}. Purchases stay closed until you change it on <button className="link" style={{ fontSize: 13 }} onClick={() => setTab('mix')}>Prices & mix</button>.</p>}
        </div>
      )}
      {restricted === key && key && (
        <p className="note error" style={{ marginTop: 16 }}>This collection refuses transfers to contracts. A buyer using a contract that never claims its refund can lock this NFT in FWA escrow permanently. In a pool with few listings, that can cost the buyer much less than the NFT is worth.</p>
      )}
      {refused && <p className="note error" style={{ marginTop: 16 }}>{refused}</p>}
      <button className="btn lg" style={{ marginTop: 20 }} disabled={!!tx.busy || !pick.collection || newBase === 0n} onClick={list}>
        {tx.busy ? `${tx.busy}…` : restricted === key && key ? 'List anyway' : pick.collection && newBase ? `List ${nftLabel(pick)} at ${pick.value} ETH` : 'List NFT'}
      </button>
      <p className="note" style={{ marginTop: 8 }}>Listing closes purchases until upkeep runs; upkeep runs right after.</p>
    </>
  );
}

/** The live pool: what players pay, what is listed right now, where the ETH is, and what it earns. */
function Overview({ d, tx, isCreator, me, setTab }: { d: D; tx: Tx; isCreator: boolean; me: Address; setTab: (t: Tab) => void }) {
  const B = { address: d.balancer, abi: poolBalancerAbi } as const;
  const [mode, setMode] = useState<'deposit' | 'claim'>();
  const [amount, setAmount] = useState('');
  const [assume, setAssume] = useState({ open: false, perDay: '40', gas: '1' });
  const [how, setHow] = useState(false);
  const plan = d.plans.length ? unpackPlan(d.plans[d.activePlan]) : ZERO;
  const backing = d.activeShapes.reduce((s, n, i) => s + BigInt(n) * DENOMS[i], 0n);
  const bases = d.listings.filter((l) => l.kind === 1 && l.state === 1).map((l) => l.base);
  const econ = bases.length && plan.some(Boolean)
    ? economics(plan, { curatedBases: bases, markupBps: d.config.markupBps, edgeBps: Number(d.edgeBps), mintFee: d.mintFee }, { gasPriceGwei: Number(assume.gas) || 1, drawsPerUpkeep: 1, safety: 0.25 })
    : undefined;
  const month = econ ? econ.expectedNetPerDraw * (Number(assume.perDay) || 0) * 30 : 0;
  const missing = plan.reduce((s, n, i) => s + Math.max(0, n - d.activeShapes[i]), 0);
  const planned = plan.reduce((a, b) => a + b, 0);
  const idle = d.balance > d.required ? d.balance - d.required : 0n;
  const short_ = d.required > d.balance ? d.required - d.balance : 0n;
  const start = (m: 'deposit' | 'claim') => { setMode(mode === m ? undefined : m); setAmount(m === 'claim' ? eth(d.surplus, 6) : '0.100'); };

  // Live inventory: every listing FWA can draw now, weighted as FWA weights it.
  const cost = d.fee + d.vrfFee;
  const live = d.listings.filter((l) => l.weight > 0n);
  const tw = live.reduce((s, l) => s + l.weight, 0n);
  const sizes = [...new Set(live.filter((l) => l.kind === 2).map((l) => l.denom))].sort((x, y) => x - y);
  const look = (l: Listing): React.CSSProperties => (l.kind === 1 ? { border: '1.5px solid #fff' }
    : { background: sizes.length > 1 && l.denom === sizes[sizes.length - 1] ? '#fff' : SHADES[Math.min(SHADES.length - 1, sizes.indexOf(l.denom))] });
  const nftName = (l: Listing) => `${d.names[l.collection] ?? short(l.collection)} #${l.tokenId}`;
  // Shapes first, smallest (most often drawn) first; NFTs last, as in the designer.
  const ordered = [...live].sort((x, y) => (y.kind - x.kind) || (x.denom - y.denom) || (y.weight > x.weight ? 1 : -1));
  const items: InvItem[] = ordered.map((l) => {
    const value = l.kind === 2 ? DENOMS[l.denom] : l.base;
    return { key: l.id.toString(), label: l.kind === 2 ? `${DENOM_LABELS[l.denom]} ETH Shape` : nftName(l), nft: l.kind === 1, value, price: l.price,
      p: tw ? Number(l.weight) / Number(tw) : 0, mult: cost ? Number(value) / Number(cost) : 0, style: look(l) };
  });
  const nftOdds = items.filter((x) => x.nft).reduce((a, x) => a + x.p, 0);

  return (
    <main className="page cols">
      <section>
        <div className="result-block" style={{ paddingTop: 0 }}>
          <span className="soft" style={{ fontSize: 14 }}>Players pay</span>
          <div style={{ marginTop: 8 }}><span className="figure">{d.fee ? eth(cost, 5) : '–'}</span><span className="unit">ETH per draw</span></div>
          {d.fee > 0n && <p className="note" style={{ marginTop: 10 }}>{eth(d.fee, 5)} draw price plus {eth(d.vrfFee, 5)} randomness (VRF) fee · markup {d.config.markupBps / 100}%</p>}
        </div>
        <div className="result-block">
          <div className="section-head"><h2 className="h3">In the pool now</h2>{isCreator && <button className="link" onClick={() => setTab('mix')}>Change prices or mix</button>}</div>
          {items.length ? (
            <>
              <InventoryGrid items={items} />
              <div className="legend">
                {sizes.map((dn) => {
                  const xs = items.filter((x) => !x.nft && x.label.startsWith(`${DENOM_LABELS[dn]} ETH`));
                  return <div key={dn}><span className="sw" style={xs[0].style} /><span><b>{xs.length}</b> × {DENOM_LABELS[dn]} ETH Shape · each {oneIn(xs[0].p)}</span></div>;
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
          <div className="kv"><span className="k">Reserve to replace won Shapes</span><span>{eth(d.required)} ETH</span></div>
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
              <p className="note" style={{ marginTop: 10 }}>Assumes {assume.perDay} draws a day and {assume.gas} gwei gas. <button className="link" style={{ fontSize: 13 }} onClick={() => setAssume({ ...assume, open: !assume.open })}>Change</button></p>
              {assume.open && (
                <div className="row" style={{ marginTop: 10 }}>
                  <div className="field" style={{ width: 150 }}><input aria-label="Draws per day" value={assume.perDay} onChange={(e) => setAssume({ ...assume, perDay: e.target.value })} inputMode="numeric" /><span className="u">/DAY</span></div>
                  <div className="field" style={{ width: 150 }}><input aria-label="Gas price" value={assume.gas} onChange={(e) => setAssume({ ...assume, gas: e.target.value })} inputMode="decimal" /><span className="u">GWEI</span></div>
                </div>
              )}
              <button className="disclose" style={{ marginTop: 16 }} onClick={() => setHow(!how)}>How this is worked out {how ? '▴' : '▾'}</button>
              {how && (
                <div style={{ marginTop: 12 }}>
                  <div className="kv"><span className="k">Average prize value on FWA</span><span>{econ.ownerProceeds.toFixed(5)} ETH</span></div>
                  <div className="kv"><span className="k">Your markup share</span><span>{econ.grossMarginPerDraw.toFixed(5)} ETH</span></div>
                  <div className="kv"><span className="k">Mint fees and upkeep gas</span><span>−{econ.overheadPerDraw.toFixed(5)} ETH</span></div>
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
                {d.ensName && <button className="btn sec" disabled={!!tx.busy} onClick={() => tx.send('Clear ENS name', [() => tx.write({ ...B, functionName: 'clearENSName' })])}>Clear</button>}
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
          <div><div style={{ fontWeight: 700 }}>Unwind Shapes</div><p className="note">{d.enabled ? 'Close purchases first.' : `Returns the ${eth(backing)} ETH held in Shapes to the pool.`}</p></div>
          <button className="link" disabled={!!tx.busy || d.enabled || backing === 0n} onClick={() => tx.send('Unwind', [() => tx.write({ ...B, functionName: 'unwind', args: [20n] })])}>Unwind</button>
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
function NftChooser({ me, current, exclude, onPick }: { me: Address; current: DraftNft; exclude: string[]; onPick: (x: Omit<DraftNft, 'value'>) => void }) {
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
    onPick({ collection, tokenId: m.tokenId, name });
  };
  return (
    <div className="chooser">
      <WalletPicker me={me} selected={{ collection: current.collection ?? '', tokenId: current.tokenId ?? '' }} listed={exclude}
        onPick={(n) => onPick({ collection: n.collection, tokenId: n.tokenId.toString(), name: n.name })} onEmpty={() => setManual(true)} />
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

/** The connected wallet's ERC-721s, found by scanning its transfer history; picking one fills the listing form. */
function WalletPicker({ me, selected, listed, onPick, onEmpty }: { me: Address; selected: { collection: string; tokenId: string }; listed: string[]; onPick: (n: WalletNft) => void; onEmpty: () => void }) {
  const pub = usePublicClient();
  const [nfts, setNfts] = useState<WalletNft[]>();
  const [error, setError] = useState<string>();
  const [q, setQ] = useState('');
  useEffect(() => {
    if (!pub) return;
    let live = true;
    setNfts(undefined); setError(undefined);
    scanWalletNfts(pub, me, chain.id, [SHAPES])
      .then((r) => { if (!live) return; setNfts(r); if (!r.length) onEmpty(); })
      .catch((e) => { if (!live) return; setError((e as Error & { shortMessage?: string }).shortMessage ?? (e as Error).message); onEmpty(); });
    return () => { live = false; };
  }, [pub, me]); // eslint-disable-line react-hooks/exhaustive-deps
  const keyOf = (n: { collection: string; tokenId: bigint | string }) => `${n.collection}:${n.tokenId}`.toLowerCase();
  const sel = keyOf(selected);
  const words = q.trim().toLowerCase();
  const shown = (nfts ?? []).filter((n) => !listed.includes(keyOf(n)) && (!words || `${n.name} #${n.tokenId} ${n.collection}`.toLowerCase().includes(words)));
  const pick = (nfts ?? []).find((n) => keyOf(n) === sel);
  return (
    <div style={{ marginTop: 14 }}>
      <div className="section-head" style={{ marginBottom: 8 }}>
        <span style={{ fontSize: 14 }} className="soft">From your wallet</span>
        {nfts && <span className="label">{shown.length} NFT{shown.length === 1 ? '' : 's'}</span>}
      </div>
      {!nfts && !error && <p className="note">Scanning your wallet for NFTs. The first scan can take a minute; later ones are quick.</p>}
      {error && <p className="note error">Could not scan your wallet ({error}). Enter a contract and token ID instead.</p>}
      {nfts && nfts.length === 0 && <p className="note">No NFTs found in this wallet. Enter a contract and token ID instead.</p>}
      {nfts && nfts.length > 0 && (
        <>
          {nfts.length > 12 && <div className="field" style={{ marginBottom: 10 }}><input aria-label="Search your NFTs" placeholder="Search by name, token ID or contract" value={q} onChange={(e) => setQ(e.target.value)} /></div>}
          <div className="picker" role="listbox" aria-label="Your NFTs">
            {shown.slice(0, SHOWN).map((n) => (
              <button key={keyOf(n)} role="option" aria-selected={keyOf(n) === sel} onClick={() => onPick(n)} title={`${n.name} #${n.tokenId}`}>
                <Thumb n={n} />
                <span className="pn">{n.name}</span>
                <span className="pid">#{n.tokenId.toString()}</span>
              </button>
            ))}
          </div>
          {shown.length > SHOWN && <p className="note" style={{ marginTop: 8 }}>Showing {SHOWN} of {shown.length}. Search to narrow the list.</p>}
          {pick && <p style={{ marginTop: 12, fontSize: 15 }}><span className="muted">Selected:</span> <b>{pick.name} #{pick.tokenId.toString()}</b></p>}
        </>
      )}
    </div>
  );
}

/** NFT image, fetched only once the tile scrolls into view. */
function Thumb({ n }: { n: WalletNft }) {
  const pub = usePublicClient();
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>();
  useEffect(() => {
    const el = ref.current;
    if (!el || !pub) return;
    let live = true;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      nftImage(pub, n.collection, n.tokenId).then((u) => live && setSrc(u ?? null), () => live && setSrc(null));
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => { live = false; io.disconnect(); };
  }, [pub, n.collection, n.tokenId]);
  return <span ref={ref} className="thumb pt">{src ? <img src={src} alt="" loading="lazy" onError={() => setSrc(null)} /> : <span>{src === null ? 'No image' : ''}</span>}</span>;
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
