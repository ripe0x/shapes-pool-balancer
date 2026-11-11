import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, useConnect, usePublicClient, useWriteContract } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { BaseError, ContractFunctionRevertedError, decodeFunctionResult, encodeFunctionData, formatEther, keccak256, parseAbi, parseAbiItem, parseEther, toBytes, type Address, type Hash } from 'viem';
import { normalize } from 'viem/ens';
import { balancerFactoryAbi, erc721Abi, fwaPoolAbi, poolBalancerAbi, shapesAbi } from '../../shared/abi';
import {
  DENOM_LABELS, DENOMS, MAX_PLANS, MAX_SHAPES_PER_PLAN, economics, packPlan, unpackPlan, type Counts,
} from '../../shared/planner';
import { available, describe, ethNeeded, playerView, recommend, type DesignInputs, type Style } from '../../shared/design';
import { chain, FACTORY, FROM_BLOCK, FWA_POOL_URL } from './chain';
import { prepareWrite } from './tx';

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
  const send = async (label: string, calls: (() => Promise<Hash>)[]) => {
    setBusy(label);
    setMsg(undefined);
    try {
      for (const c of calls) {
        const hash = await c();
        const rc = await pub!.waitForTransactionReceipt({ hash });
        if (rc.status !== 'success') throw new Error(`${label} reverted`);
      }
      setMsg({ ok: true, text: `${label}: confirmed` });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: `${label}: ${explain(e)}` });
      return false;
    } finally {
      setBusy(undefined);
      onDone();
    }
  };
  return { send, busy, msg, write };
}

type D = NonNullable<ReturnType<typeof useBalancer>['data']>;
type Tx = ReturnType<typeof useTx>;
type Tab = 'design' | 'nfts' | 'funds' | 'settings';
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

/** One sentence for the pool's state, and the action that resolves it. */
function statusLine(d: D): { head: string; body: string; act?: 'upkeep' | 'open' | 'nfts' | 'design' | 'funds' } {
  if (d.retired) return { head: 'Retired.', body: 'The pool no longer sells draws. Withdrawals still work.' };
  if (!d.plans.length) return { head: 'Not set up.', body: d.listings.some((l) => l.kind === 1) ? 'Design the pool and save it, then open purchases.' : 'List one of your NFTs, then design the pool.', act: d.listings.some((l) => l.kind === 1) ? 'design' : 'nfts' };
  switch (d.admission) {
    case 0: return { head: 'Open.', body: 'Players can buy draws. Nothing needs attention.' };
    case 1: return { head: 'Closed.', body: 'You closed purchases.', act: 'open' };
    case 2: return { head: 'Needs upkeep.', body: 'Run upkeep to restore the mix and reopen.', act: 'upkeep' };
    case 3: return { head: 'Settling.', body: 'A purchase on FWA is being settled. Upkeep follows.' };
    case 4: return { head: 'Closed.', body: 'List one of your NFTs to reopen.', act: 'nfts' };
    case 5: return { head: 'Closed.', body: 'No saved mix meets your price and NFT odds limits.', act: 'design' };
    case 6: return { head: 'Closed.', body: `Deposit ${eth(d.required > d.balance ? d.required - d.balance : 0n)} ETH to cover the reserve.`, act: 'funds' };
    case 7: return { head: 'Needs upkeep.', body: 'The Shapes mint fee changed.', act: 'upkeep' };
    case 8: return { head: 'Closed.', body: 'The FWA price is above your highest draw price.', act: 'design' };
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
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<Tab>('design');
  const [prereq, setPrereq] = useState<{ creation: boolean; impl: boolean }>();
  const [loaded, setLoaded] = useState(false);

  const loadMine = useCallback(async () => {
    if (!pub || !address || !FACTORY) return;
    const logs = await pub.getLogs({ address: FACTORY, event: CREATED, args: { creator: address }, fromBlock: FROM_BLOCK });
    const list = logs.map((l) => l.args.balancer!);
    setMine(list);
    setLoaded(true);
    // Keep the selection only if it belongs to the connected account (it changes when the wallet switches accounts).
    setSelected((s) => (s && list.includes(s) ? s : list[list.length - 1]));
    const ens = await Promise.all(list.map((b) => pub.getEnsName({ address: b }).catch(() => null)));
    setNames(Object.fromEntries(list.map((b, i) => [b, ens[i] ?? `Pool ${short(b)}`])));
  }, [pub, address]);
  useEffect(() => { setLoaded(false); loadMine().catch(() => undefined); }, [loadMine]);
  useEffect(() => {
    if (!pub) return;
    Promise.all([
      pub.readContract({ address: FWA_FACTORY, abi: fwaFactoryAbi, functionName: 'poolCreationEnabled' }),
      pub.readContract({ address: FWA_FACTORY, abi: fwaFactoryAbi, functionName: 'implementation' }),
    ]).then(([c, i]) => setPrereq({ creation: c as boolean, impl: (i as string).toLowerCase() === '0x85faf92967705dc45535ebca74d6333f6bcbfee7' })).catch(() => undefined);
  }, [pub]);

  const dev = connectors.filter((c) => c.type === 'mock');
  const showPool = isConnected && selected && !creating;
  const switcher = mine.length > 0 && (
    <select className="select" aria-label="Pool" value={creating ? 'new' : selected}
      onChange={(e) => { if (e.target.value === 'new') setCreating(true); else { setCreating(false); setSelected(e.target.value as Address); } }}>
      {mine.map((b) => <option key={b} value={b}>{names[b] ?? `Pool ${short(b)}`}</option>)}
      <option value="new">New pool…</option>
    </select>
  );
  return (
    <>
      <header className="topbar">
        <span className="wordmark">FWA Pool Balancer</span>
        {showPool && (
          <nav className="tabs" aria-label="Sections">
            {(['design', 'nfts', 'funds', 'settings'] as Tab[]).map((t) => (
              <button key={t} aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>{t === 'nfts' ? 'NFTs' : cap(t)}</button>
            ))}
          </nav>
        )}
        {isConnected && (
          <div className="right">
            {switcher}
            <ConnectButton.Custom>
              {({ account, openAccountModal }) => <button className="account" onClick={openAccountModal}>{account ? short(account.address) : ''}</button>}
            </ConnectButton.Custom>
          </div>
        )}
      </header>
      {!FACTORY && <p className="txline bad">VITE_FACTORY is not set. See app/.env.example.</p>}
      {!isConnected && (
        <main className="connect">
          <h1 className="hero">Connect a wallet to manage your pools.</h1>
          <p className="lead">Your pools and their funds are listed here. Players buy draws on FWA, not on this site.</p>
          <div className="row" style={{ marginTop: 36 }}>
            <ConnectButton.Custom>{({ openConnectModal }) => <button className="btn lg" style={{ width: 'auto', minWidth: 200 }} onClick={openConnectModal}>Connect wallet</button>}</ConnectButton.Custom>
            {dev.map((c) => <button key={c.uid} className="btn sec lg" style={{ width: 'auto' }} onClick={() => connect({ connector: c, chainId: chain.id })}>Local dev account</button>)}
          </div>
          {dev.length > 0 && <p className="note" style={{ marginTop: 16 }}>Local dev account appears on local test networks only.</p>}
        </main>
      )}
      {isConnected && loaded && (!selected || creating) && (
        <Create prereq={prereq} first={!mine.length} me={address!} onCancel={mine.length ? () => setCreating(false) : undefined}
          onCreated={() => { setCreating(false); setTab('nfts'); loadMine(); }} />
      )}
      {showPool && <PoolView key={selected} balancer={selected!} me={address!} tab={tab} setTab={setTab} switcher={switcher} />}
    </>
  );
}

function Create({ prereq, first, me, onCreated, onCancel }: { prereq?: { creation: boolean; impl: boolean }; first: boolean; me: Address; onCreated: () => void; onCancel?: () => void }) {
  const pub = usePublicClient();
  const [deposit, setDeposit] = useState('0.600');
  const [wallet, setWallet] = useState<bigint>();
  const { send, busy, msg, write } = useTx(() => undefined);
  const salt = useMemo(() => `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, '0')).join('')}` as `0x${string}`, []);
  useEffect(() => { pub?.getBalance({ address: me }).then(setWallet).catch(() => undefined); }, [pub, me, busy]);
  const ok = prereq?.creation && prereq?.impl;
  const create = async () => {
    if (await send('Create pool', [() => write({ address: FACTORY, abi: balancerFactoryAbi, functionName: 'createBalancer', args: [salt], value: ethOr(deposit, 0n) })])) onCreated();
  };
  return (
    <main className="page narrow-page">
      <h1 className="title">{first ? 'Create your first pool' : 'Create a pool'}</h1>
      <p className="lead">A pool holds your NFTs and the ETH-backed Shapes that players can win. You can add more ETH later.</p>
      <div className="section">
        <span className="label">After this</span>
        <div className="mixrow"><span className="mono muted">1</span><span>List one of your NFTs</span></div>
        <div className="mixrow"><span className="mono muted">2</span><span>Design the pool and open it</span></div>
      </div>
      <label className="form-label" htmlFor="deposit" style={{ marginTop: 36 }}>How much ETH to start with?</label>
      <div className="field"><input id="deposit" className="big" value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" /><span className="u">ETH</span></div>
      {wallet !== undefined && <p className="note" style={{ marginTop: 8 }}>You have {eth(wallet)} ETH in this wallet.</p>}
      <div className="section">
        <div className="kv"><span className="k">Pool creation is enabled</span><span>{prereq ? (prereq.creation ? 'Yes' : 'No') : '…'}</span></div>
        <div className="kv"><span className="k">Contract is the reviewed version</span><span>{prereq ? (prereq.impl ? 'Yes' : 'No: creation will fail') : '…'}</span></div>
      </div>
      <button className="btn lg" style={{ marginTop: 32 }} disabled={!!busy || !ok} onClick={create}>{busy ? `${busy}…` : `Create pool with ${deposit || '0'} ETH`}</button>
      {msg && !msg.ok && <p className="note error" style={{ marginTop: 12 }}>{msg.text}</p>}
      {onCancel && <button className="link quiet" style={{ marginTop: 16 }} onClick={onCancel}>Cancel</button>}
    </main>
  );
}

function PoolView({ balancer, me, tab, setTab, switcher }: { balancer: Address; me: Address; tab: Tab; setTab: (t: Tab) => void; switcher: React.ReactNode }) {
  const { data: d, error, refresh } = useBalancer(balancer);
  const tx = useTx(refresh);
  if (error) return <p className="txline bad">{error}</p>;
  if (!d) return <p className="txline">Loading…</p>;
  const isCreator = d.creator.toLowerCase() === me.toLowerCase();
  const B = { address: balancer, abi: poolBalancerAbi } as const;
  const st = statusLine(d);
  const action = st.act === 'upkeep' ? <button className="link" disabled={!!tx.busy} onClick={() => tx.send('Run upkeep', [() => tx.write({ ...B, functionName: 'performUpkeep' })])}>Run upkeep</button>
    : st.act === 'open' && isCreator ? <button className="link" disabled={!!tx.busy} onClick={() => tx.send('Open purchases', [() => tx.write({ ...B, functionName: 'open' })])}>Open purchases</button>
      : st.act === 'nfts' || st.act === 'design' || st.act === 'funds' ? <button className="link" onClick={() => setTab(st.act as Tab)}>{st.act === 'nfts' ? 'Add an NFT' : st.act === 'funds' ? 'Deposit' : 'Design'}</button>
        : null;
  return (
    <>
      <div className="switcher-row mobile-only">{switcher}</div>
      <div className="status" role="status">
        <span><b>{st.head}</b> {st.body}</span>
        <span className="actions">
          {action}
          {d.upkeep.needed && st.act !== 'upkeep' && <button className="link quiet" disabled={!!tx.busy} onClick={() => tx.send('Run upkeep', [() => tx.write({ ...B, functionName: 'performUpkeep' })])}>Run upkeep</button>}
          {isCreator && d.enabled && <button className="link quiet" disabled={!!tx.busy} onClick={() => tx.send('Close purchases', [() => tx.write({ ...B, functionName: 'close' })])}>Close purchases</button>}
          {isCreator && !d.enabled && st.act !== 'open' && d.plans.length > 0 && !d.retired && <button className="link quiet" disabled={!!tx.busy} onClick={() => tx.send('Open purchases', [() => tx.write({ ...B, functionName: 'open' })])}>Open purchases</button>}
          <a href={FWA_POOL_URL(d.pool)} target="_blank" rel="noreferrer">Pool on FWA ↗</a>
        </span>
      </div>
      {(tx.busy || tx.msg) && <p className={`txline${tx.msg && !tx.msg.ok ? ' bad' : ''}`} aria-live="polite">{tx.busy ? `${tx.busy}…` : tx.msg!.text}</p>}
      {d.pendingCreator.toLowerCase() === me.toLowerCase() && (
        <p className="txline">You were offered this pool. <button className="link" disabled={!!tx.busy} onClick={() => tx.send('Accept pool', [() => tx.write({ ...B, functionName: 'acceptCreator' })])}>Accept</button></p>
      )}
      {!isCreator && <p className="txline">You are not this pool's creator. You can run upkeep; other changes need the creator.</p>}
      {tab === 'design' && (isCreator ? <Design d={d} tx={tx} setTab={setTab} /> : <main className="page"><p className="lead">Only the creator can design this pool.</p></main>)}
      {tab === 'nfts' && <Nfts d={d} tx={tx} isCreator={isCreator} me={me} />}
      {tab === 'funds' && <Funds d={d} tx={tx} isCreator={isCreator} me={me} />}
      {tab === 'settings' && (isCreator ? <Settings d={d} tx={tx} /> : <main className="page"><p className="lead">Only the creator can change settings.</p></main>)}
    </>
  );
}

const STYLES: { key: Style; label: string; hint: string }[] = [
  { key: 'steady', label: 'Low draw price', hint: 'Cheapest draw your NFT odds allow' },
  { key: 'balanced', label: 'More big wins', hint: 'Most chances to win 2× the draw or more' },
  { key: 'jackpot', label: 'Jackpot', hint: 'Largest Shape prize your budget allows' },
];
// Grid shades by prize rank, smallest first; the top Shape prize is white, NFTs are outlined.
const SHADES = ['#333', '#555', '#7a7a7a', '#b5b5b5'];

function Design({ d, tx, setTab }: { d: D; tx: Tx; setTab: (t: Tab) => void }) {
  const has = d.plans.length > 0;
  const curated = d.listings.filter((l) => l.kind === 1 && l.state === 1);
  const bases = curated.map((l) => l.base);
  const [budget, setBudget] = useState(eth(available(d.balance, d.activeShapes, ZERO)));
  const [markup, setMarkup] = useState(has ? d.config.markupBps / 100 : 15);
  const [floor, setFloor] = useState(has ? d.config.minCuratedOddsBps / 100 : 5);
  const [style, setStyle] = useState<Style>();
  const [counts, setCounts] = useState<Counts>(has ? unpackPlan(d.plans[d.activePlan]) : ZERO);
  const [fallbacks, setFallbacks] = useState<Counts[]>(has ? d.plans.filter((_, i) => i !== d.activePlan).map(unpackPlan) : []);
  // Shown rounded up to 6 decimals, so re-saving never lowers the saved ceiling.
  const [ceiling, setCeiling] = useState(has ? String(Math.ceil(Number(formatEther(d.config.maxDrawPrice)) * 1e6) / 1e6) : '');
  const [gas, setGas] = useState('1');
  const [note, setNote] = useState<string>();
  const [open, setOpen] = useState({ mix: false, fallbacks: false, advanced: false, numbers: false });
  const toggle = (k: keyof typeof open) => setOpen({ ...open, [k]: !open[k] });
  const markupBps = Math.round(markup * 100);
  const floorBps = Math.round(floor * 100);
  const inputs: DesignInputs = {
    curatedBases: bases, markupBps, edgeBps: Number(d.edgeBps), mintFee: d.mintFee, budget: ethOr(budget, 0n),
    have: d.activeShapes, baseFee: d.baseFee, minCuratedOddsBps: floorBps, vrfFee: d.vrfFee,
  };
  const pick = (st: Style) => {
    const r = recommend(st, inputs);
    setStyle(st);
    if (!r.best) { setNote('No mix fits this budget and NFT chance. Raise the budget or lower the minimum chance.'); return; }
    setNote(undefined);
    setCounts(r.best);
    setFallbacks(r.fallbacks);
  };
  // Pick the first style once for a pool that has never been designed.
  useEffect(() => { if (!has && bases.length && !style) pick('steady'); }, [bases.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = counts.reduce((a, b) => a + b, 0);
  const setCount = (i: number, n: number) => { setStyle(undefined); setCounts(counts.map((x, j) => (j === i ? Math.max(0, n) : x))); };
  const ready = bases.length > 0 && total > 0;
  const ev = ready ? describe(counts, inputs) : undefined;
  const view = ev ? playerView(ev, markupBps, d.vrfFee) : undefined;
  const plans = [counts, ...fallbacks];
  // Default ceiling: 25% above the highest draw price among the saved mixes, so fallbacks stay admissible.
  const autoCeiling = ready ? (plans.map((c) => describe(c, inputs).drawPrice).reduce((a, b) => (b > a ? b : a), 0n) * 125n) / 100n : 0n;
  const ceilingWei = ceiling ? ethOr(ceiling, autoCeiling) : autoCeiling;
  const checked = ready ? describe(counts, inputs, ceilingWei) : undefined;
  const needed = ready ? ethNeeded(counts, inputs) : 0n;
  const have = available(d.balance, d.activeShapes, counts);
  const econ = ready ? economics(counts, inputs, { gasPriceGwei: Number(gas) || 1, drawsPerUpkeep: 1, safety: 0.25 }) : undefined;
  const affordable = (i: number) => 2n * (DENOMS[i] + d.mintFee) <= inputs.budget;
  const addable = DENOMS.map((_, i) => i).filter((i) => !counts[i] && affordable(i));
  const tooBig = DENOMS.map((_, i) => i).filter((i) => !affordable(i));
  const tierOf = (i: number) => view?.tiers.find((t) => t.kind === 'shape' && t.label.startsWith(`${DENOM_LABELS[i]} ETH`));
  const nftName = (l: Listing) => `${d.names[l.collection] ?? short(l.collection)} #${l.tokenId}`;
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
    const verb = n === 1 ? 'wins' : 'win';
    if (g.nft) return `${verb} ${curated.length === 1 ? `your NFT, ${nftName(curated[0])}` : 'one of your NFTs'}`;
    const v = Number(formatEther(g.value)) / Number(formatEther(view!.cost));
    const what = g.n === 1 && shapeGroups.length > 1 && g === shapeGroups[shapeGroups.length - 1] ? `the ${DENOM_LABELS[g.i]} ETH Shape` : `a ${DENOM_LABELS[g.i]} ETH Shape`;
    return `${verb} ${what}${v < 1 ? ', less than they paid' : `, ${v.toFixed(1)}× what they paid`}`;
  };

  if (!bases.length) {
    return (
      <main className="page">
        <h1 className="title">Design your pool</h1>
        <p className="lead">List at least one of your NFTs first. Prices and chances depend on your NFTs.</p>
        <button className="btn" style={{ marginTop: 24 }} onClick={() => setTab('nfts')}>Add an NFT</button>
      </main>
    );
  }


  const payBlock = view && ev ? (
    <div className="result-block">
      <span className="soft" style={{ fontSize: 14 }}>Players pay</span>
      <div style={{ marginTop: 8 }}><span className="figure">{eth(view.cost, 5)}</span><span className="unit">ETH per draw</span></div>
      <p className="note" style={{ marginTop: 10 }}>{eth(ev.drawPrice, 5)} draw price plus a {eth(d.vrfFee, 5)} randomness (VRF) fee</p>
    </div>
  ) : null;
  const gridBlock = view ? (
        <div className="result-block">
          <h2 className="h3">Out of 100 draws</h2>
          <div className="grid100" aria-hidden="true">{cells.map((g, k) => <span key={k} style={sw(g)} />)}</div>
          <div className="legend">
            {ordered.map(({ g, n }) => (
              <div key={g.key}><span className="sw" style={sw(g)} /><span><b>{n === 0 ? '<1' : n}</b> {legend(g, n)}{g.p < 0.05 && <span className="muted"> ({oneIn(g.p)})</span>}</span></div>
            ))}
          </div>
          <p className="note" style={{ marginTop: 14 }}>Rounded to whole draws. On average a prize is worth {(view.avgReturn * 100).toFixed(0)}% of what the player paid.</p>
        </div>
  ) : null;

  const save = (
    <div className="pin">
      <button className="btn lg" disabled={!!tx.busy || !ready || !checked?.feasible}
        onClick={() => tx.send('Save configuration', [() => tx.write({
          address: d.balancer, abi: poolBalancerAbi, functionName: 'configure',
          args: [{ maxDrawPrice: ceilingWei, minCuratedOddsBps: floorBps, markupBps }, plans.slice(0, MAX_PLANS).map(packPlan)],
        })])}>Save configuration</button>
    </div>
  );

  return (
    <main className="page cols">
      <section>
        <h1 className="title">Design your pool</h1>
        <p className="lead">Choose a style and set two limits. The right side shows what players get.</p>

        <div className="step">
          <div className="step-head"><span className="n">1</span><h2 className="h3">Choose a style</h2></div>
          <div className="options" role="group" aria-label="Style">
            {STYLES.map((s) => (
              <button key={s.key} aria-pressed={style === s.key} onClick={() => pick(s.key)}>
                <span><span className="t">{s.label}</span><span className="s">{s.hint}</span></span>
                {style === s.key && <span className="sel">SELECTED</span>}
              </button>
            ))}
          </div>
          {note && <p className="note error" style={{ marginTop: 10 }}>{note}</p>}
        </div>
        {view && <div className="mobile-only" style={{ marginTop: 32 }}>{payBlock}{gridBlock}</div>}

        <div className="step">
          <div className="step-head"><span className="n">2</span><h2 className="h3">Set your limits</h2></div>
          <div className="limit">
            <div className="top"><label htmlFor="markup">Your markup</label><b>{markup}%</b></div>
            <input id="markup" type="range" min={0} max={100} step={0.25} value={markup} onChange={(e) => { setMarkup(Number(e.target.value)); if (style) pick(style); }} />
            <p className="note">Higher markup raises the draw price and what you keep.</p>
          </div>
          <div className="limit">
            <div className="top"><label htmlFor="floor">Minimum chance of one of your NFTs</label><b>{floor}%</b></div>
            <input id="floor" type="range" min={0} max={50} step={0.5} value={floor} onChange={(e) => setFloor(Number(e.target.value))} onPointerUp={() => style && pick(style)} onKeyUp={() => style && pick(style)} />
            <p className="note">Raising it leaves room for fewer small Shapes, so the draw price goes up.</p>
          </div>
          <div className="budget">
            <div><label htmlFor="budget" style={{ fontSize: 15 }}>Budget</label><p className="note">You have {eth(available(d.balance, d.activeShapes, ZERO))} ETH available.</p></div>
            <div className="field"><input id="budget" className="big" value={budget} onChange={(e) => setBudget(e.target.value)} onBlur={() => style && pick(style)} inputMode="decimal" /><span className="u">ETH</span></div>
          </div>
        </div>

        <div className="step">
          <div className="step-head">
            <span className="n">3</span><h2 className="h3">Fine-tune the mix <span className="muted">· optional</span></h2>
            {open.mix && <button className="disclose end" onClick={() => toggle('mix')}>Close ▴</button>}
          </div>
          {!open.mix ? (
            <div className="summary">
              <span>{curated.length} of your NFTs and {total} Shape{total === 1 ? '' : 's'}</span>
              <button className="disclose" onClick={() => toggle('mix')}>Adjust ▾</button>
            </div>
          ) : (
            <>
              <p className="note" style={{ marginBottom: 12 }}>Cheaper prizes come up more often. Adding small Shapes lowers the draw price and makes your NFT rarer.</p>
              {curated.map((l, k) => {
                const t = view?.tiers.filter((x) => x.kind === 'curated')[k];
                return (
                  <div className="mixrow" key={l.id.toString()}>
                    <div><div className="t">{nftName(l)}</div><div className="s">Your NFT · {t ? oneIn(t.odds) : '–'} draws</div></div>
                    <span className="end note">Fixed</span>
                  </div>
                );
              })}
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
                {tooBig.length > 0 && `${DENOM_LABELS[tooBig[0]]} to 100 ETH sizes need a larger budget. `}{total} of {MAX_SHAPES_PER_PLAN} Shapes used.
              </p>
            </>
          )}
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
            <div className="desktop-only">{payBlock}</div>
            {!open.numbers ? (
              <>
                <div className="desktop-only">{gridBlock}</div>
                <div className="result-block kvline">
                  <div><div>To open, you need</div><p className="note">You have {eth(have)} ETH. {fits ? 'This fits.' : `Deposit ${eth(needed - have)} more.`}</p></div>
                  <div><span className="figure-s">{eth(needed)}</span><span className="unit">ETH</span></div>
                </div>
                <div className="result-block kvline">
                  <div><div>You keep, per draw</div><p className="note">On average, after costs</p></div>
                  <div><span className={`figure-s${econ.expectedNetPerDraw < 0 ? ' error' : ''}`}>{signed(econ.expectedNetPerDraw)}</span><span className="unit">ETH</span></div>
                </div>
                {econ.belowModeledMarkup && <p className="note error">Markup is below the {pct(econ.minMarkupBps)} that covers costs.</p>}
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
                  <div className="kv"><span className="k">Lowest markup that covers costs</span><span>{Number.isFinite(econ.minMarkupBps) ? pct(econ.minMarkupBps) : '–'}</span></div>
                </div>
              </div>
            )}
          </>
        ) : <p className="lead">Pick a style or add Shapes to see what players get.</p>}
      </section>
    </main>
  );
}

function Nfts({ d, tx, isCreator, me }: { d: D; tx: Tx; isCreator: boolean; me: Address }) {
  const pub = usePublicClient();
  const B = { address: d.balancer, abi: poolBalancerAbi } as const;
  const curated = d.listings.filter((l) => l.kind === 1 && l.state === 1);
  const [form, setForm] = useState({ collection: '', tokenId: '', base: '' });
  const [edit, setEdit] = useState<{ id: bigint; value: string }>();
  const [restricted, setRestricted] = useState<string>();
  const [stray, setStray] = useState({ open: false, collection: '', tokenId: '' });
  const key = `${form.collection}:${form.tokenId}`;
  const list = () => tx.send('List NFT', [
    () => tx.write({ address: form.collection as Address, abi: erc721Abi, functionName: 'approve', args: [d.balancer, BigInt(form.tokenId)] }),
    () => tx.write({ ...B, functionName: 'listCurated', args: [form.collection as Address, BigInt(form.tokenId), ethOr(form.base, 0n)] }),
  ]).then((ok) => { setRestricted(undefined); if (ok) setForm({ collection: '', tokenId: '', base: '' }); });
  // A collection that refuses transfers to contracts lets a hostile buyer (a contract that never refunds) lock a
  // drawn NFT in FWA escrow. Simulate a transfer from the creator to a contract address before listing.
  const checkAndList = async () => {
    if (restricted === key) return list();
    const sim = (to: Address) => pub!.simulateContract({ address: form.collection as Address, abi: erc721Abi, functionName: 'transferFrom', args: [me, to, BigInt(form.tokenId)], account: me }).then(() => true, () => false);
    const [toContract, toEoa] = await Promise.all([sim(SHAPES), sim('0x000000000000000000000000000000000000dEaD')]);
    if (toEoa && !toContract) { setRestricted(key); return; }
    return list();
  };
  const odds = (l: Listing) => (d.totalWeight ? Number(l.weight) / Number(d.totalWeight) : 0);
  const name = (l: Listing) => `${d.names[l.collection] ?? short(l.collection)} #${l.tokenId}`;
  return (
    <main className="page cols">
      <section>
        <h1 className="title">Your NFTs</h1>
        <p className="lead">Players can win these. The value you set decides how often: a lower value means it is won more often.</p>
        <div className="section">
          {curated.length === 0 && d.pending.length === 0 && <p className="note">No NFTs listed. Purchases stay closed until you list one.</p>}
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
          <h2 className="h3" style={{ fontSize: 22 }}>Add an NFT</h2>
          <label className="form-label" htmlFor="collection">Collection address</label>
          <div className="field"><input id="collection" className="mono" placeholder="0x…" value={form.collection} onChange={(e) => setForm({ ...form, collection: e.target.value })} /></div>
          <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label className="form-label" htmlFor="token">Token ID</label>
              <div className="field"><input id="token" placeholder="e.g. 31" value={form.tokenId} onChange={(e) => setForm({ ...form, tokenId: e.target.value })} inputMode="numeric" /></div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label className="form-label" htmlFor="value">Your value</label>
              <div className="field"><input id="value" placeholder="0.000" value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })} inputMode="decimal" /><span className="u">ETH</span></div>
            </div>
          </div>
          {restricted === key && (
            <p className="note error" style={{ marginTop: 16 }}>This collection refuses transfers to contracts. A buyer using a contract that never claims its refund can lock this NFT in FWA escrow permanently. In a pool with few listings, that can cost the buyer much less than the NFT is worth.</p>
          )}
          <button className="btn lg" style={{ marginTop: 20 }} disabled={!!tx.busy || !form.collection || !form.tokenId || !form.base} onClick={checkAndList}>{restricted === key ? 'List anyway' : 'List NFT'}</button>
          <p className="note" style={{ marginTop: 14 }}>List only collections you trust: a collection whose contract can move or freeze tokens can take or strand an NFT listed here.</p>
          <p className="note" style={{ marginTop: 8 }}>Listing closes purchases until upkeep runs.</p>
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

function Funds({ d, tx, isCreator, me }: { d: D; tx: Tx; isCreator: boolean; me: Address }) {
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
  const funded = d.enabled && d.balance >= d.required;
  const missing = plan.reduce((s, n, i) => s + Math.max(0, n - d.activeShapes[i]), 0);
  const planned = plan.reduce((a, b) => a + b, 0);
  const sizes = DENOMS.map((_, i) => i).filter((i) => plan[i] || d.activeShapes[i]);
  const start = (m: 'deposit' | 'claim') => { setMode(mode === m ? undefined : m); setAmount(m === 'claim' ? eth(d.surplus, 6) : '0.100'); };
  return (
    <main className="page">
      <h1 className="title">Funds</h1>
      <div className="stats">
        <div><span className="soft" style={{ fontSize: 14 }}>In this pool</span><div style={{ marginTop: 10 }}><span className="figure">{eth(d.balance + backing)}</span><span className="unit">ETH</span></div><p className="note">Shapes and reserve included</p></div>
        <div><span className="soft" style={{ fontSize: 14 }}>Kept as reserve</span><div style={{ marginTop: 10 }}><span className="figure">{eth(d.required)}</span><span className="unit">ETH</span></div><p className="note">Needed to keep the pool open</p></div>
        <div><span className="soft" style={{ fontSize: 14 }}>Free to claim</span><div style={{ marginTop: 10 }}><span className="figure">{eth(d.surplus)}</span><span className="unit">ETH</span></div><p className="note">Not needed by the current mix</p></div>
      </div>
      <div className="row" style={{ marginTop: 20 }}>
        {d.proceeds > 0n && <button className="btn" disabled={!!tx.busy} onClick={() => tx.send('Collect from sales', [() => tx.write({ ...B, functionName: 'collectProceeds' })])}>Collect {eth(d.proceeds)} ETH from sales</button>}
        <button className={mode === 'deposit' ? 'btn' : 'btn sec'} onClick={() => start('deposit')}>Deposit</button>
        {isCreator && <button className={mode === 'claim' ? 'btn' : 'btn sec'} disabled={d.surplus === 0n} onClick={() => start('claim')}>Claim surplus</button>}
      </div>
      {mode && (
        <div className="row" style={{ marginTop: 12 }}>
          <div className="field" style={{ width: 200 }}><input aria-label={mode === 'deposit' ? 'Deposit amount' : 'Claim amount'} className="big" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /><span className="u">ETH</span></div>
          <button className="btn" disabled={!!tx.busy || !amount} onClick={() => tx.send(mode === 'deposit' ? 'Deposit' : 'Claim surplus', [() => tx.write(mode === 'deposit'
            ? { ...B, functionName: 'depositETH', value: ethOr(amount, 0n) }
            : { ...B, functionName: 'claimSurplus', args: [ethOr(amount, 0n), me] })]).then((ok) => ok && setMode(undefined))}>
            {mode === 'deposit' ? `Deposit ${amount || '0'} ETH` : `Claim ${amount || '0'} ETH to your wallet`}
          </button>
        </div>
      )}
      <div className="cols" style={{ marginTop: 48 }}>
        <section>
          <h2 className="h3" style={{ fontSize: 22 }}>Shapes</h2>
          <p className="note" style={{ margin: '8px 0 16px' }}>{!planned ? 'No mix saved yet.' : missing === 0 ? `All ${planned} planned Shapes are listed. Nothing is missing.` : `${missing} of ${planned} planned Shapes are missing. Upkeep lists them.`}</p>
          {sizes.map((i) => <div className="kv" key={i}><span>{DENOM_LABELS[i]} ETH</span><span className="note">{d.activeShapes[i]} of {plan[i]} listed</span></div>)}
        </section>
        <section>
          <h2 className="h3" style={{ fontSize: 22 }}>Earnings</h2>
          {econ ? (
            <>
              <p className="note" style={{ margin: '8px 0 16px' }}>
                {!funded ? 'The pool is not funded or not open.' : econ.expectedNetPerDraw >= 0 ? 'The pool is funded and expected to make a small profit.' : 'The pool is funded and expected to lose money at this markup.'}
              </p>
              <div className="row" style={{ gap: 40 }}>
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
                  <div className="kv"><span className="k">Lowest markup that covers costs</span><span>{Number.isFinite(econ.minMarkupBps) ? pct(econ.minMarkupBps) : '–'}</span></div>
                  <p className="note" style={{ marginTop: 10 }}>An estimate from the current mix. Single draws vary; short runs can lose money either way.</p>
                </div>
              )}
            </>
          ) : <p className="note" style={{ marginTop: 8 }}>Earnings appear once an NFT is listed and a mix is saved.</p>}
        </section>
      </div>
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
        <h1 className="title">Settings</h1>
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
