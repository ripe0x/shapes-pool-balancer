import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { formatEther, parseEther, type Address } from 'viem';
import { packManagerAbi, packManagerFactoryAbi, packVaultAbi } from '../../shared/main-pool-abi';
import { chain } from './chain';
import { explain } from './errors';
import { creationNotSubmitted } from './creation';
import { createLatestRefresh } from './refresh';
import { InventoryGrid, SHADES, TxLine, eth, oneIn, pctOf, short, useTx, type InvItem } from './App';
import { SRow } from './PoolSettings';
import { weightOf } from '../../shared/planner';
import {
  HAND_SIZES, MAX_PACKS, MAX_PER_SIZE, backingOf, decodeMix, encodeMix, mixText, packCount, presetMix, scaleMix, shareOf, sizeLabel, sizesOf,
  type PackMix, type PackStyle,
} from '../../shared/manager-design';
import {
  MAIN_POOL_OPEN, MANAGER_FACTORY, MANAGER_PARAMS, MIN_DEPOSIT, POSITION_VALUE, VAULT, checkCreation, clearManagerCreation,
  depositShares, findManagers, loadManagerCreation, managerStatus, packCost, packsFor, readMainPool, readManager, readVault, redeemCharge,
  saveManagerCreation, vaultStatus, type CreationState, type Manager, type ManagerCreation, type Vault,
} from './main-pool';

export type MainTab = 'overview' | 'vault' | 'manager';
/** Without a manager factory there is nothing to compare: the section is the vault alone. */
export const mainTabFor = (t: MainTab): MainTab => (MANAGER_FACTORY ? t : 'vault');
const TABS: { key: MainTab; label: string }[] = [
  { key: 'overview', label: 'Overview' }, { key: 'vault', label: 'Shared vault' }, { key: 'manager', label: 'Your manager' },
];
const etherscan = (a: string) => (chain.id === 1 ? `https://etherscan.io/address/${a}` : undefined);
const shares3 = (x: bigint | undefined) => (x === undefined ? '–' : Number(formatEther(x)).toFixed(3));
const parse = (s: string) => { try { return s.trim() ? parseEther(s.trim()) : undefined; } catch { return undefined; } };
const ago = (seconds: bigint) => {
  const s = Number(seconds);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};
const ethText = (wei: bigint, d = 4) => Number(formatEther(wei)).toFixed(d).replace(/\.?0+$/, '') || '0';

/** A snapshot read on load, every 30 s while the tab is visible, at once when it returns, and on `refresh`. A failed
 *  refresh keeps the last snapshot and reports the error; `key` names every input the read depends on. */
function usePolled<T>(key: string | undefined, load: () => Promise<T>) {
  const [state, setState] = useState<{ key: string; value?: T; error?: string }>();
  const loader = useRef(load);
  loader.current = load;
  const queue = useRef<ReturnType<typeof createLatestRefresh<void, T>>>();
  useEffect(() => {
    if (!key) return;
    const q = createLatestRefresh<void, T>(() => loader.current(), (e) => {
      if (e.state === 'ready') setState({ key, value: e.value });
      if (e.state === 'error') setState((s) => ({ key, value: s?.key === key ? s.value : undefined, error: explain(e.error) }));
    });
    queue.current = q;
    q.request();
    const timer = setInterval(() => { if (!document.hidden) q.request(); }, 30_000);
    const onVisible = () => { if (!document.hidden) q.request(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); q.dispose(); };
  }, [key]);
  const current = state?.key === key ? state : undefined;
  return { data: current?.value, error: current?.error, refresh: () => queue.current?.request() };
}

export function useVault(me?: Address) {
  const pub = usePublicClient();
  return usePolled<Vault>(pub && VAULT ? `${pub.chain.id}:${VAULT}:${me ?? ''}` : undefined, () => readVault(pub!, VAULT!, me));
}

export function useManager(manager: Address | undefined) {
  const pub = usePublicClient();
  return usePolled<Manager>(pub && manager ? `${pub.chain.id}:${manager}` : undefined, () => readManager(pub!, manager!));
}

function useManagers(me?: Address) {
  const pub = usePublicClient();
  return usePolled(pub && me && MANAGER_FACTORY ? `${pub.chain.id}:${MANAGER_FACTORY}:${me}` : undefined, () => findManagers(pub!, MANAGER_FACTORY!, me!));
}

function Connect({ label = 'Connect wallet', className = 'btn' }: { label?: string; className?: string }) {
  return <ConnectButton.Custom>{({ openConnectModal }) => <button className={className} onClick={openConnectModal}>{label}</button>}</ConnectButton.Custom>;
}

export function StatusBar({ head, body, link }: { head: string; body: string; link?: { href?: string; label: string } }) {
  return (
    <div className="status bar" role="status">
      <span><b>{head}</b> {body}</span>
      {link?.href && <a className="actions quiet" href={link.href} target="_blank" rel="noreferrer">{link.label}</a>}
    </div>
  );
}

// ------------------------------------------------------------------ Home

export function Home({ hasPools, onNew, onList, onMain }: { hasPools: boolean; onNew: () => void; onList: () => void; onMain: (t: MainTab) => void }) {
  const { data: v } = useVault();
  return (
    <main className={`home${VAULT ? '' : ' single'}`}>
      <section>
        <span className="eyebrow">For creators</span>
        <h1 className="title">Community pools</h1>
        <p className="lead">Run your own pool on FWA. Players pay a draw price and win one prize at random: a curated NFT from your wallet, or a Shape you fund with ETH.</p>
        <div className="acts">
          <button className="btn big" onClick={onNew}>Create a community pool</button>
          {hasPools && <button className="link" onClick={onList}>Your community pools →</button>}
        </div>
      </section>
      {VAULT && (
        <section>
          <span className="eyebrow">For depositors</span>
          <h1 className="title">Main pool</h1>
          <p className="lead">Earn on FWA's main pool. Your ETH builds 0.06 ETH Shape packs and lists them. Deposit with other holders, or run your own manager.</p>
          <div className="acts">
            <button className="btn big" onClick={() => onMain('vault')}>Deposit in the shared vault</button>
            {MANAGER_FACTORY && <button className="link" onClick={() => onMain('manager')}>Create a manager →</button>}
          </div>
          {v && <p className="fact">Shared vault: {eth(v.book.nav, 2)} ETH, {v.book.listed} packs listed.</p>}
        </section>
      )}
    </main>
  );
}

// ------------------------------------------------------------------ Main pool section

export function MainPool({ tab, setTab }: { tab: MainTab; setTab: (t: MainTab) => void }) {
  const { address: me } = useAccount();
  const vault = useVault(me);
  const managers = useManagers(me);
  const t = mainTabFor(tab);
  return (
    <>
      {MANAGER_FACTORY && (
        <nav className="tabs sub" aria-label="Main pool">
          {TABS.map((x) => <button key={x.key} aria-current={t === x.key ? 'page' : undefined} onClick={() => setTab(x.key)}>{x.label}</button>)}
        </nav>
      )}
      {t === 'overview' && <Compare v={vault.data} hasManager={!!managers.data?.managers.length} setTab={setTab} />}
      {t === 'vault' && (MAIN_POOL_OPEN ? <VaultPage vault={vault} me={me} />
        : <Soon title="Shared vault" lead="Deposit ETH with other holders. The vault builds Shape packs, lists them on FWA's main pool, and you own a share of everything it holds." />)}
      {t === 'manager' && (MAIN_POOL_OPEN ? <ManagerTab v={vault.data} me={me} managers={managers} />
        : <Soon title="Personal manager" lead="Your own account that runs the shared vault's strategy with only your ETH. You own it from the moment it is created; the factory keeps no control and charges no fee." />)}
    </>
  );
}

function Soon({ title, lead }: { title: string; lead: string }) {
  return (
    <>
      <StatusBar head="Coming soon." body="Not open for deposits yet." />
      <main className="page">
        <h1 className="title">{title}</h1>
        <p className="lead">{lead}</p>
        <a className="disclose" href="#how-main">How the main pool works ▾</a>
      </main>
    </>
  );
}

const COMPARE: [string, string, string][] = [
  ['Your ETH', 'Pooled with other holders. You hold shares.', 'In a contract only you can withdraw from.'],
  ['In and out', 'Priced at the next checkpoint, within 12 h.', 'Idle ETH any time. Listed packs return through exit mode.'],
];

function Compare({ v, hasManager, setTab }: { v?: Vault; hasManager: boolean; setTab: (t: MainTab) => void }) {
  const cost = v && v.edge[2] ? packCost(v.edge[1], v.deployCharge) : undefined;
  const onePack = cost === undefined ? '–' : ethText(cost + MANAGER_PARAMS.reserve, 2);
  const rows: [string, string, string][] = [
    ...COMPARE,
    ['Smallest amount', 'Any deposit above a small minimum.', `About ${onePack} ETH for one pack. 0.5 to 1 ETH spreads the outcome.`],
    ['Cost', v === undefined ? '–' : v.requestCharge > 0n ? `${ethText(v.requestCharge, 5)} ETH per deposit or redemption. No vault fee.` : 'No request charge until the next checkpoint. No vault fee.',
      'About 474,000 gas to create. No factory fee.'],
    ['Same capital, modelled', 'Earned more in every run: one reserve, more ETH at work.', 'Less, because more ETH sits idle.'],
  ];
  const head = (k: 'vault' | 'manager') => (k === 'vault'
    ? <><h2>Shared vault</h2><p>Deposit with other holders and own a share of everything the vault holds.</p>{MAIN_POOL_OPEN ? <button className="btn big" onClick={() => setTab('vault')}>Deposit ETH</button> : <button className="btn big" disabled>Coming soon</button>}</>
    : <><h2>Personal manager</h2><p>Create your own account that runs the same strategy with only your ETH.</p>{MAIN_POOL_OPEN ? <button className="btn sec big" onClick={() => setTab('manager')}>{hasManager ? 'Open your manager' : 'Create a manager'}</button> : <button className="btn sec big" disabled>Coming soon</button>}</>);
  return (
    <main className="page mp-overview">
      <div className="intro">
        <h1 className="title">Earn on FWA's main pool</h1>
        <p className="lead">Your ETH builds 0.06 ETH Shape packs and lists them on the main pool with ETH backing. When a buyer keeps a pack, the backing comes back and a new pack is built. When a buyer bids instead, the pack comes back and is listed again.</p>
        <a className="disclose" href="#how-main">How the main pool works ▾</a>
      </div>
      <div className="compare">
        <div />
        <div className="ch">{head('vault')}</div>
        <div className="ch">{head('manager')}</div>
        {rows.map(([k, a, b]) => <Row key={k} cells={[k, a, b]} />)}
      </div>
      <div className="compare-cards">
        {(['vault', 'manager'] as const).map((k, i) => (
          <div className="group" key={k}>
            <div className="group-head"><div className="ch">{head(k)}</div></div>
            <div className="group-body">{rows.map(([label, ...xs]) => <div key={label}><span className="k">{label}</span><span>{xs[i]}</span></div>)}</div>
          </div>
        ))}
      </div>
    </main>
  );
}
const Row = ({ cells: [k, a, b] }: { cells: [string, string, string] }) => <><span className="k">{k}</span><span>{a}</span><span>{b}</span></>;

// ------------------------------------------------------------------ Shared vault

function Group({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="group">
      <div className="group-head"><div><h2>{title}</h2>{desc && <p className="desc">{desc}</p>}</div></div>
      {children}
    </div>
  );
}

const BAR = ['#fff', '#7a7a7a', '#b5b5b5', '#333'];

function VaultPage({ vault, me }: { vault: ReturnType<typeof useVault>; me?: Address }) {
  const { data: v, error, refresh } = vault;
  const tx = useTx(refresh);
  const [mode, setMode] = useState<'deposit' | 'redeem'>('deposit');
  const [amount, setAmount] = useState('');
  const [how, setHow] = useState(false);
  const [numbers, setNumbers] = useState(false);
  if (!VAULT) return null;
  if (!v) return <p className={`txline${error ? ' bad' : ''}`}>{error ?? 'Loading the shared vault…'}</p>;
  const st = vaultStatus(v);
  const h = v.holder;
  const V = { address: VAULT, abi: packVaultAbi } as const;
  const pub = usePublicClient();
  // Holder flows carry the vault's configuration hash, so a parameter change between reading and signing reverts.
  const expected = () => pub!.readContract({ ...V, functionName: 'configurationHash' });
  const value = parse(amount);
  const busy = !!tx.busy;

  // Deposit: ETH in, shares out at the next checkpoint. Redeem: shares in, ETH to claim after it.
  const fee = mode === 'deposit' ? v.requestCharge : value === undefined ? v.requestCharge : redeemCharge(value, v);
  const net = value !== undefined && value > v.requestCharge ? value - v.requestCharge : 0n;
  const building = (net * v.deployCharge) / (POSITION_VALUE + v.deployCharge);
  const disabled = !me ? undefined
    : !value ? 'Enter an amount'
    : mode === 'deposit' ? (v.depositsPaused || v.windingDown ? 'Deposits are paused'
      : value < MIN_DEPOSIT + v.requestCharge ? 'Below the minimum deposit'
      : v.lastNav + v.pendingDepositTotal + value - v.requestCharge > v.params.tvlCap ? "Above the vault's deposit limit"
      : h && value > h.wallet ? `Your wallet has ${eth(h.wallet)} ETH` : undefined)
    : h && value > h.shares ? `You have ${shares3(h.shares)} shares` : undefined;
  const label = disabled ?? (mode === 'deposit' ? `Deposit ${amount} ETH` : `Redeem ${amount} shares`);
  const submit = () => {
    if (!value) return;
    const step = mode === 'deposit'
      ? async () => tx.write({ ...V, functionName: 'deposit', args: [await expected()], value })
      : async () => tx.write({ ...V, functionName: 'requestRedeem', args: [value, await expected()], value: redeemCharge(value, v) });
    tx.send(label, [step]).then((ok) => ok && setAmount(''));
  };
  const cancel = () => tx.send('Cancel deposit', [() => tx.write({ ...V, functionName: 'cancelDeposit' })]);
  const claim = () => tx.send('Claim', [() => tx.write({ ...V, functionName: 'claim' })]);
  const parts = [['Shapes in packs', v.book.tracked], ['Backing posted on FWA', v.book.backing], ['FWA fees not yet collected', v.book.fees], ['Free cash', v.book.freeEth]] as const;

  return (
    <>
      <StatusBar {...st} link={{ href: etherscan(VAULT), label: 'Vault on Etherscan ↗' }} />
      {error && <p className="txline bad">{error}</p>}
      <main className="page cols design mp">
        <section>
          <h1 className="title">Shared vault</h1>
          <p className="lead">Deposit ETH with other holders. The vault builds Shape packs, lists them on FWA's main pool, and you own a share of everything it holds.</p>
          <button className="disclose" style={{ marginTop: 14 }} aria-expanded={how} onClick={() => setHow(!how)}>How the vault works {how ? '▴' : '▾'}</button>
          {how && (
            <ol className="how">
              <li>Deposits and redemptions wait for the next checkpoint, which runs once every 12 hours in FWA's quiet window and prices them all at once.</li>
              <li>Until its checkpoint, a deposit can be cancelled for a full refund.</li>
              <li>A redemption locks shares. Each checkpoint fills it from the vault's free ETH; the rest stays invested until it is filled. Filled ETH is yours to claim.</li>
              <li><a className="link" href="#how-main">More in How it works</a></li>
            </ol>
          )}
          <Group title="Your position" desc="Shares can't be transferred. Redeem them for ETH at a checkpoint.">
            {!me || !h ? (
              <div className="group-body connect-row"><span className="soft">Connect a wallet to see your position.</span><Connect /></div>
            ) : (
              <div className="cells2">
                <div><span className="k">Value</span><span className="v">{eth((h.shares * v.pricePerShare) / 10n ** 18n)}<span className="unit">ETH</span></span></div>
                <div><span className="k">Shares</span><span className="v">{shares3(h.shares)}</span></div>
                <div>
                  <span className="k">Waiting for the checkpoint</span>
                  {h.pendingDeposit > 0n && <><span className="v">{eth(h.pendingDeposit)}<span className="unit">ETH deposit</span></span><button className="link" disabled={busy} onClick={cancel}>Cancel deposit</button></>}
                  {h.redeeming > 0n && <span className="v">{shares3(h.redeeming)}<span className="unit">shares to redeem</span></span>}
                  {h.pendingDeposit === 0n && h.redeeming === 0n && <span className="v muted">0</span>}
                </div>
                <div>
                  <span className="k">Ready to claim</span>
                  <span className={`v${h.claimable ? '' : ' muted'}`}>{h.claimable === undefined ? '–' : h.claimable === 0n ? '0' : eth(h.claimable)}<span className="unit">ETH</span></span>
                  {!!h.claimable && <button className="link" disabled={busy} onClick={claim}>Claim {eth(h.claimable)} ETH</button>}
                </div>
              </div>
            )}
          </Group>
          <Group title="Where the vault's ETH is" desc={`${eth(v.book.nav, 2)} ETH across ${v.book.listed} listed packs. Each pack is one 0.05 and one 0.01 ETH Shape.`}>
            <div className="group-body tight">
              <div className="hiw-bar" role="img" aria-label={parts.map(([l, x]) => `${l} ${eth(x, 2)} ETH`).join(', ')}>
                {parts.map(([l, x], i) => <span key={l} style={{ flexGrow: Number(formatEther(x)), background: BAR[i] }} />)}
              </div>
              <div className="kvs">
                {parts.map(([l, x], i) => <div className="kv" key={l}><span className="sw" style={{ background: BAR[i] }} /><span className="k">{l}</span><span>{eth(x, 2)} ETH</span></div>)}
              </div>
              <p className="note">Held apart for holders, not counted above: {eth(v.pendingDepositTotal, 2)} ETH in deposits waiting for pricing, {eth(v.claims, 2)} ETH in claims.</p>
            </div>
          </Group>
        </section>

        <section className="sticky results">
          <div>
            <span className="soft" style={{ fontSize: 15 }}>One share is worth</span>
            <div className="pay"><span className="figure">{Number(formatEther(v.pricePerShare)).toFixed(4)}</span><span className="unit">ETH</span></div>
            <p className="note">{v.lastCheckpoint ? `At the last checkpoint, ${ago(v.now - v.lastCheckpoint.at)}.` : 'At the seed price. No checkpoint yet.'}</p>
          </div>
          <div className="seg" role="group" aria-label="Action">
            <button aria-pressed={mode === 'deposit'} onClick={() => { setMode('deposit'); setAmount(''); }}>Deposit</button>
            <button aria-pressed={mode === 'redeem'} onClick={() => { setMode('redeem'); setAmount(''); }}>Redeem</button>
          </div>
          <Amount label="Amount" value={amount} onChange={setAmount} unit={mode === 'deposit' ? 'ETH' : 'SHARES'}
            max={mode === 'redeem' && h ? () => setAmount(formatEther(h.shares)) : undefined} />
          <div className="kvs">
            {mode === 'deposit' ? <>
              <div className="kv"><span className="k">You get about</span><span>{shares3(value ? depositShares(value, v) : 0n)} shares</span></div>
              <div className="kv"><span className="k">Priced</span><span>Next checkpoint</span></div>
              <div className="kv"><span className="k">Request charge</span><span>{ethText(fee, 6)} ETH</span></div>
              <div className="kv"><span className="k">Building and listing charge</span><span>{ethText(building, 6)} ETH</span></div>
            </> : <>
              <div className="kv"><span className="k">You get about</span><span>{eth(value ? (value * v.pricePerShare) / 10n ** 18n : 0n)} ETH</span></div>
              <div className="kv"><span className="k">Priced</span><span>Next checkpoint</span></div>
              <div className="kv"><span className="k">Request charge</span><span>{ethText(fee, 6)} ETH</span></div>
              <div className="kv"><span className="k">Then</span><span>Claim when priced</span></div>
            </>}
          </div>
          <div className="pin">
            {!me ? <Connect className="btn lg" />
              : <button className="btn lg" disabled={busy || !!disabled} onClick={submit}>{tx.busy ? `${tx.busy}…` : label}</button>}
            <TxHelper tx={tx}>{mode === 'deposit' ? 'You can cancel until it is priced.' : 'Locked shares are filled at checkpoints.'}</TxHelper>
          </div>
          <button className="disclose" aria-expanded={numbers} onClick={() => setNumbers(!numbers)}>All numbers {numbers ? '▴' : '▾'}</button>
          {numbers && (
            <div className="kvs">
              <div className="kv"><span className="k">Total shares</span><span>{shares3(v.totalShares)}</span></div>
              <div className="kv"><span className="k">High-water mark</span><span>{Number(formatEther(v.highWaterMark)).toFixed(4)} ETH a share</span></div>
              <div className="kv"><span className="k">Free cash</span><span>{eth(v.book.freeEth, 4)} ETH</span></div>
              <div className="kv"><span className="k">Reserve</span><span>{eth(v.params.reserve, 4)} ETH</span></div>
              <div className="kv"><span className="k">Open listings</span><span>{v.book.ids.length}</span></div>
              <div className="kv"><span className="k">Allocated exposure</span><span>{eth(v.book.allocated, 4)} ETH</span></div>
              <div className="kv"><span className="k">Last checkpoint block</span><span>{v.lastCheckpoint ? v.lastCheckpoint.block.toString() : 'None yet'}</span></div>
              <div className="kv"><span className="k">Next checkpoint window</span><span>{nextWindow(v)}</span></div>
              <div className="kv"><span className="k">Keeper pay since the last checkpoint</span><span>{eth(v.keeperPaySince, 5)} ETH</span></div>
              <div className="kv"><span className="k">Token rewards claimed and burned</span><span>{eth(v.tokensBurned, 2)} FWA · valued at 0</span></div>
            </div>
          )}
        </section>
      </main>
    </>
  );
}

/** One checkpoint per 12-hour interval: once this interval's has run, the next can run from the next interval. */
function nextWindow(v: Vault) {
  const interval = 12n * 3600n;
  const current = v.now / interval;
  if (v.lastCheckpointInterval < current) return 'This interval, in FWA\'s quiet window';
  return `From ${new Date(Number((current + 1n) * interval) * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
}

function Amount({ label, value, onChange, unit, max }: { label: string; value: string; onChange: (s: string) => void; unit: string; max?: () => void }) {
  return (
    <div>
      <label className="soft" style={{ fontSize: 14 }} htmlFor="mp-amount">{label}</label>
      <div className="field amt"><input id="mp-amount" className="big" inputMode="decimal" placeholder="0.00" value={value} onChange={(e) => onChange(e.target.value)} />
        <span className="u">{unit}{max && <> · <button className="link max" onClick={max}>MAX</button></>}</span></div>
    </div>
  );
}

function TxHelper({ tx, children }: { tx: ReturnType<typeof useTx>; children?: ReactNode }) {
  if (tx.busy) return <p className="note">{tx.busy}…</p>;
  if (tx.msg && !tx.msg.ok) return <p className="note error">{tx.msg.text}</p>;
  if (tx.msg) return <p className="note">{tx.msg.text}</p>;
  return children ? <p className="note">{children}</p> : null;
}

// ------------------------------------------------------------------ Personal manager

function ManagerTab({ v, me, managers }: { v?: Vault; me?: Address; managers: ReturnType<typeof useManagers> }) {
  const pub = usePublicClient();
  const [index, setIndex] = useState(0);
  const [record, setRecord] = useState<ManagerCreation | undefined>(() => loadManagerCreation());
  const [creation, setCreation] = useState<CreationState>();
  const mine = record && me && record.owner.toLowerCase() === me.toLowerCase() && record.chainId === chain.id
    && record.factory.toLowerCase() === MANAGER_FACTORY?.toLowerCase() ? record : undefined;
  const list = managers.data?.managers ?? [];
  // A saved creation is checked until the chain shows its outcome; once created, its manager opens.
  useEffect(() => {
    if (!pub || !mine || !managers.data) return;
    let live = true;
    const check = () => checkCreation(pub, mine, managers.data!.created).then((s) => {
      if (!live) return;
      setCreation(s);
      if (s.state === 'created') {
        clearManagerCreation(); setRecord(undefined);
        const at = list.findIndex((m) => m.toLowerCase() === s.manager.toLowerCase());
        if (at >= 0) setIndex(at); else managers.refresh();
      }
    }).catch(() => live && setCreation({ state: 'unknown' }));
    void check();
    const timer = setInterval(() => { managers.refresh(); }, 5_000);
    return () => { live = false; clearInterval(timer); };
  }, [pub, mine?.hash, mine?.since, managers.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const created = () => { setRecord(loadManagerCreation()); managers.refresh(); };

  if (me && !managers.data) return <p className={`txline${managers.error ? ' bad' : ''}`}>{managers.error ?? 'Looking for your managers…'}</p>;
  if (mine) return <CreationView record={mine} state={creation} onDiscard={() => { clearManagerCreation(); setRecord(undefined); setCreation(undefined); }} />;
  const selected = list[Math.min(index, list.length - 1)];
  if (!me || !selected) return <CreateManager me={me} onCreated={created} />;
  return <ManagerPage key={selected} manager={selected} v={v} me={me} count={list.length} index={list.indexOf(selected)} setIndex={setIndex} />;
}

function CreationView({ record, state, onDiscard }: { record: ManagerCreation; state?: CreationState; onDiscard: () => void }) {
  const text = !state ? 'Checking your manager creation…'
    : state.state === 'pending' ? 'Your manager is being created. This page opens it once the transaction confirms.'
    : state.state === 'failed' ? state.reason
    : state.state === 'created' ? 'Manager created.'
    : 'Creation confirmation is unavailable. Check your wallet before trying again.';
  return (
    <>
      <StatusBar head="Creating your manager." body={`${eth(BigInt(record.value), 2)} ETH from ${short(record.owner)}.`} />
      <main className="page narrow-page">
        <h1 className="title t2">Manager creation</h1>
        <p className="lead">{text}</p>
        {record.hash && <p className="note mono" style={{ marginTop: 14 }}>Transaction {record.hash}</p>}
        {state?.state === 'failed' && <button className="btn" style={{ marginTop: 20 }} onClick={onDiscard}>Back to create</button>}
      </main>
    </>
  );
}

const DRAFT_KEY = 'manager-draft';
type MixDraft = { style?: PackStyle | null; mix?: PackMix };
const loadMixDraft = (): MixDraft => { try { return (JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as MixDraft | null) ?? {}; } catch { return {}; } };
const PACK_STYLE_TILES: { key: PackStyle; label: string; hint: string }[] = [
  { key: 'small', label: 'Small packs', hint: '0.03 ETH packs. Lowest entry.' },
  { key: 'balanced', label: 'Balanced', hint: '0.03, 0.05 and 0.10 ETH packs.' },
  { key: 'large', label: 'Large packs', hint: '0.10 ETH packs. One mint fee each.' },
];
const DEFAULT_PACKS = 3;

/** One pack's cost per size from PackManagerFactory.preview at current gas and mint fee: its Shapes, backing, mint fees,
 *  and in `total` also its build pay (opening cash less the reserve). Undefined until read. */
type PackCost = { principal: bigint; backing: bigint; mint: bigint; total: bigint };
function usePackCosts(sizes: number[], params: object = MANAGER_PARAMS) {
  const pub = usePublicClient();
  const key = `${sizes.join(',')}:${(params as { backingRatioBps: number }).backingRatioBps}`;
  const [costs, setCosts] = useState<{ key: string; perPack: Record<number, PackCost>; error?: string }>();
  useEffect(() => {
    if (!pub || !MANAGER_FACTORY || !sizes.length) return;
    let live = true;
    Promise.all(sizes.map(async (u) => {
      const [, principal, backing, mint, openingCash] = await pub.readContract({ address: MANAGER_FACTORY!, abi: packManagerFactoryAbi, functionName: 'preview',
        args: [{ ...(params as typeof MANAGER_PARAMS), packUnitsMask: 1n << BigInt(u) }] });
      return [u, { principal, backing, mint, total: openingCash - (params as typeof MANAGER_PARAMS).reserve }] as const;
    })).then((rows) => live && setCosts({ key, perPack: Object.fromEntries(rows) }),
      (e) => live && setCosts({ key, perPack: {}, error: explain(e) }));
    return () => { live = false; };
  }, [pub, key]);
  return costs?.key === key ? costs : undefined;
}

/** The main pool's total weight and draw price, read once. */
function useMainPool() {
  const pub = usePublicClient();
  const [pool, setPool] = useState<{ totalWeight: bigint; drawPrice: bigint }>();
  useEffect(() => {
    if (!pub) return;
    let live = true;
    readMainPool(pub).then((p) => live && setPool(p), () => undefined);
    return () => { live = false; };
  }, [pub]);
  return pool;
}

/** Pack shades as in the community designer: with several sizes the largest is white, the rest darkest first. */
const shadeOf = (u: number, sizes: number[]): CSSProperties =>
  ({ background: sizes.length > 1 && u === sizes[sizes.length - 1] ? '#fff' : SHADES[Math.min(SHADES.length - 1, sizes.indexOf(u))] });

type MixView = { sizes: number[]; each: Record<number, number>; any: number; drawPrice: bigint; backing: (u: number) => bigint };
/** A mix as the main pool would hold it: each pack's chance per draw is its weight over the pool's weight with the mix
 *  listed in place of `listedWeight`, the weight the manager lists now. */
function mixView(mix: PackMix, pool: { totalWeight: bigint; drawPrice: bigint } | undefined, bps: number, listedWeight = 0n): MixView | undefined {
  if (!pool) return undefined;
  const sizes = sizesOf(mix);
  const backing = (u: number) => backingOf(u, bps);
  const total = pool.totalWeight - listedWeight + sizes.reduce((t, u) => t + weightOf(backing(u)) * BigInt(mix[u]), 0n);
  const each = Object.fromEntries(sizes.map((u) => [u, shareOf(weightOf(backing(u)), total)]));
  return { sizes, each, any: sizes.reduce((t, u) => t + each[u] * mix[u], 0), drawPrice: pool.drawPrice, backing };
}

/** One square per pack, most numerous size first, as the community inventory. */
function mixItems(mix: PackMix, view: MixView): InvItem[] {
  return [...view.sizes].sort((a, b) => mix[b] - mix[a] || a - b).flatMap((u) => Array.from({ length: mix[u] }, (_, j) => ({
    key: `${u}-${j}`, label: sizeLabel(u), nft: false, value: view.backing(u), price: view.backing(u), p: view.each[u],
    mult: Number(view.backing(u)) / Number(view.drawPrice), style: shadeOf(u, view.sizes),
  })));
}

/** The community designer's side blocks for a pack mix: the headline chance, the inventory or 100-draw grid with its
 *  key, and the main pool facts. */
function usePackBlocks({ mix, view, note }: { mix: PackMix; view?: MixView; note?: string }) {
  const [gridView, setGridView] = useState<'inventory' | 'draws'>('inventory');
  const [showKey, setShowKey] = useState(false);
  const other: CSSProperties = { boxShadow: 'inset 0 0 0 1px var(--line-control)' };
  // Whole draws out of 100, largest remainder, the rest to other listings.
  const groups = view ? view.sizes.map((u) => ({ u, raw: view.each[u] * mix[u] * 100 })) : [];
  const whole = groups.map((g) => Math.floor(g.raw));
  const spare = Math.round(groups.reduce((t, g) => t + g.raw, 0)) - whole.reduce((a, b) => a + b, 0);
  groups.map((g, k) => [g.raw - whole[k], k] as const).sort((a, b) => b[0] - a[0]).slice(0, Math.max(0, spare)).forEach(([, k]) => whole[k]++);
  const rest = 100 - whole.reduce((a, b) => a + b, 0);
  const cells = [...groups.flatMap((g, k) => Array<CSSProperties>(whole[k]).fill(shadeOf(g.u, view!.sizes))), ...Array<CSSProperties>(rest).fill(other)];
  const pay = (
    <div>
      <h2 className="side-h">Chance per draw</h2>
      <div className="pay">{view && view.any > 0
        ? <><span className="fig56">{oneIn(view.any)}</span><span className="u13">DRAWS</span></>
        : <span className="fig56 ghost">—</span>}</div>
      {view && view.any > 0 && note && <p className="note">{note}</p>}
    </div>
  );
  const play = view && view.any > 0 ? (
    <div className="players">
      <div className="kv"><span className="k">Main pool draw price</span><span>{eth(view.drawPrice, 5)} ETH</span></div>
      <div className="kv"><span className="k">A picked pack pays</span><span>{view.sizes.map((u) => eth(view.backing(u), 4)).join(' · ')} ETH</span></div>
    </div>
  ) : null;
  const grid = (
    <div>
      <div className="grid-head">
        <div className="seg sm" role="group" aria-label="View">
          <button aria-pressed={gridView === 'inventory' || !view} onClick={() => setGridView('inventory')}>Inventory</button>
          <button aria-pressed={gridView === 'draws' && !!view} disabled={!view} onClick={() => setGridView('draws')}>Out of 100 draws</button>
        </div>
        {view && <button className="disclose key" aria-expanded={showKey} onClick={() => setShowKey(!showKey)}>Key {showKey ? '▴' : '▾'}</button>}
      </div>
      <div className="g20">
        {!view ? null : gridView === 'inventory' ? <InventoryGrid items={mixItems(mix, view).slice(0, 100)} />
          : <div className="grid100" aria-hidden="true">{cells.map((s, k) => <span key={k} style={s} />)}</div>}
      </div>
      {view && gridView === 'inventory' && packCount(mix) > 100 && <p className="note">+ {(packCount(mix) - 100).toLocaleString()} more</p>}
      {view && showKey && (gridView === 'inventory' ? (
        <div className="legend">
          {view.sizes.map((u) => <div key={u}><span className="sw" style={shadeOf(u, view.sizes)} /><span><b>{mix[u]}</b> × {sizeLabel(u)} · each {oneIn(view.each[u])}</span></div>)}
        </div>
      ) : (
        <div className="legend">
          {groups.map((g, k) => <div key={g.u}><span className="sw" style={shadeOf(g.u, view.sizes)} /><span><b>{whole[k] === 0 ? '<1' : whole[k]}</b> pick one of your {sizeLabel(g.u)}s</span></div>)}
          <div><span className="sw" style={other} /><span><b>{rest}</b> pick another listing</span></div>
          <p className="note">Rounded to whole draws.</p>
        </div>
      ))}
    </div>
  );
  return { pay, play, grid };
}

/** The pack mix controls, as in the community designer: a preset, the pack count it scales to, and exact counts by
 *  hand (which leave the preset). */
function PackDesigner({ style, mix, view, onChange }: { style?: PackStyle; mix: PackMix; view?: MixView;
  onChange: (style: PackStyle | undefined, mix: PackMix) => void }) {
  const [byHand, setByHand] = useState(false);
  const total = packCount(mix);
  const choose = (st: PackStyle) => onChange(st, presetMix(st, total));
  const setTotal = (n: number) => onChange(style, style ? presetMix(style, n) : scaleMix(mix, n));
  const setCountAt = (u: number, n: number) => {
    const next = { ...mix, [u]: Math.max(0, Math.min(MAX_PER_SIZE, n)) };
    if (!next[u]) delete next[u];
    onChange(undefined, next);
  };
  const shown = [...new Set([...HAND_SIZES, ...sizesOf(mix)])].sort((a, b) => a - b);
  return (
    <>
      <div>
        <div className="tiles three" role="group" aria-label="Pack style">
          {PACK_STYLE_TILES.map((g) => (
            <button key={g.key} aria-pressed={style === g.key} onClick={() => choose(g.key)}>
              <span className="t">{g.label}</span><span className="s">{g.hint}</span>
            </button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 14, gap: 16 }}>
          <button className="disclose" aria-expanded={byHand} onClick={() => setByHand(!byHand)}>Adjust packs by hand {byHand ? '▴' : '▾'}</button>
          {!style && total > 0 && <span className="note">Custom: {mixText(mix)}</span>}
        </div>
        {byHand && (
          <div style={{ marginTop: 14 }}>
            <p className="note" style={{ marginBottom: 6 }}>Exact pack counts. Any size can be zero. Bigger packs need more ETH and come up less often.</p>
            {shown.map((u) => {
              const b = view && mix[u] ? view.backing(u) : undefined;
              return (
                <div className="mixrow" key={u}>
                  <div><div className="t">{sizeLabel(u)}</div>{b !== undefined && <div className="s">Each {oneIn(view!.each[u])} draws · {(Number(b) / Number(view!.drawPrice)).toFixed(1)}× the draw</div>}</div>
                  <div className="stepper end">
                    <button aria-label={`One fewer ${sizeLabel(u)}`} disabled={!mix[u]} onClick={() => setCountAt(u, (mix[u] ?? 0) - 1)}>−</button>
                    <output aria-live="polite">{mix[u] ?? 0}</output>
                    <button aria-label={`One more ${sizeLabel(u)}`} disabled={total >= MAX_PACKS || (mix[u] ?? 0) >= MAX_PER_SIZE} onClick={() => setCountAt(u, (mix[u] ?? 0) + 1)}>+</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="rule">
        <div className="ctl-row"><label className="ctl" htmlFor="packs">Number of packs</label><span className="big-v">{total}</span></div>
        <input id="packs" type="range" min={1} max={MAX_PACKS} step={1} value={Math.max(1, total)} aria-valuetext={`${total} packs`}
          onChange={(e) => setTotal(Number(e.target.value))} />
        <p className="note">More packs come up more often. With one pack the result is mostly luck.</p>
      </div>
    </>
  );
}

/** ETH breakdown of building `count` packs per size, as the community cost rows. */
function costParts(counts: PackMix, perPack: Record<number, PackCost>) {
  const t = { principal: 0n, backing: 0n, mint: 0n, total: 0n };
  for (const u of sizesOf(counts)) {
    const c = perPack[u], n = BigInt(counts[u]);
    if (!c) return undefined;
    t.principal += c.principal * n; t.backing += c.backing * n; t.mint += c.mint * n; t.total += c.total * n;
  }
  return t;
}

/** The community designer's layout for a manager's packs. `fresh` is creation; otherwise it is the Packs tab of a
 *  live manager. */
function ManagerDesign({ fresh, style, mix, onChange, onReset, view, note, error, side, pin }: {
  fresh: boolean; style?: PackStyle; mix: PackMix; onChange: (style: PackStyle | undefined, mix: PackMix) => void; onReset: () => void;
  view?: MixView; note?: string; error?: string; side: ReactNode; pin: ReactNode }) {
  const [how, setHow] = useState(false);
  const [numbers, setNumbers] = useState(false);
  const blocks = usePackBlocks({ mix, view, note });
  const secHead = (n: string, t: string, desc: string) => (
    <div className="sec-head"><span className="sec-n">{n}</span><div><h2 className="sec-t">{t}</h2><p className="sec-d">{desc}</p></div></div>
  );
  return (
    <main className="page cols design">
      <section>
        {fresh
          ? <><span className="crumb">Main pool /</span><h1 className="page-t">Design your manager</h1></>
          : <h2 className="title t2">Packs</h2>}
        <p className="lead">{fresh
          ? 'Your own account on the main pool. It builds Shape packs from your ETH and keeps them listed. You own it from the moment it is created; the factory keeps no control and charges no fee.'
          : 'How many packs of each size the manager keeps listed on the main pool.'}</p>
        <div className="row" style={{ marginTop: 14, gap: 24 }}>
          {fresh && <button className="disclose" aria-expanded={how} onClick={() => setHow(!how)}>How a manager works {how ? '▴' : '▾'}</button>}
          <button className="link quiet" onClick={onReset}>{fresh ? 'Reset to defaults' : 'Reset to saved'}</button>
        </div>
        {how && fresh && (
          <ol className="how">
            <li>Every draw on the main pool picks one listing. Packs with lower backing come up more often.</li>
            <li>When a pack is picked, the buyer keeps it or takes its backing in ETH. Either way the manager is paid and lists a pack again.</li>
            <li>Backing is {(MANAGER_PARAMS.backingRatioBps / 10_000).toFixed(4)}× pack value, so a kept pack repays its Shapes and mint fees.</li>
            <li>Only you can withdraw. Exit mode turns every pack back into ETH.</li>
          </ol>
        )}
        <div className="dsec">
          {secHead('01', 'Packs', 'Shape packs your manager builds and keeps listed. When one is picked, the manager lists a pack again.')}
          <div className="sec-body">
            <PackDesigner style={style} mix={mix} view={view} onChange={onChange} />
          </div>
        </div>
        <div className="mobile-only" style={{ marginTop: 40 }}>{blocks.pay}{blocks.play}{blocks.grid}</div>
        <div className="dsec">
          {secHead('02', fresh ? 'Before you create' : 'Before you save', 'Costs are quoted at current gas and mint fees. If either rises, packs need more ETH and are built in stages.')}
          <div className="sec-body">
            {!fresh && <p className="note">Lower counts stop new builds of that size. Packs already listed stay listed.</p>}
            <p className="note">The operating reserve of {eth(MANAGER_PARAMS.reserve, 5)} ETH stays in the manager to pay keepers.</p>
            {error && <p className="note error" role="status">{error}</p>}
            {view && (
              <div>
                <button className="disclose" aria-expanded={numbers} onClick={() => setNumbers(!numbers)}>All numbers {numbers ? '▴' : '▾'}</button>
                {numbers && (
                  <div className="numbers">
                    <div className="kv-group">
                      <span className="label">Main pool</span>
                      <div className="kv"><span className="k">Draw price</span><span>{eth(view.drawPrice, 5)} ETH</span></div>
                      <div className="kv"><span className="k">One of your packs picked</span><span>{oneIn(view.any)} · {pctOf(view.any)}</span></div>
                      {view.sizes.map((u) => <div className="kv" key={u}><span className="k">Each {sizeLabel(u)}</span><span>{oneIn(view.each[u])} · backing {eth(view.backing(u), 5)} ETH</span></div>)}
                    </div>
                    <div className="kv-group">
                      <span className="label">For you</span>
                      <div className="kv"><span className="k">Backing</span><span>{(MANAGER_PARAMS.backingRatioBps / 10_000).toFixed(4)}× pack value</span></div>
                      <div className="kv"><span className="k">Operating reserve</span><span>{eth(MANAGER_PARAMS.reserve, 5)} ETH</span></div>
                      <div className="kv"><span className="k">Factory fee</span><span>None</span></div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>
      <section className="sticky results side">
        <div className="desktop-only">{blocks.pay}</div>
        {blocks.play && <div className="desktop-only">{blocks.play}</div>}
        <div className="desktop-only">{blocks.grid}</div>
        {side}
        {pin}
      </section>
    </main>
  );
}

function CreateManager({ me, onCreated }: { me?: Address; onCreated: () => void }) {
  const pub = usePublicClient();
  const tx = useTx(() => undefined);
  const [saved] = useState(loadMixDraft);
  const [style, setStyleState] = useState<PackStyle | undefined>(saved.mix && saved.style === null ? undefined : saved.style ?? 'small');
  const [mix, setMixState] = useState<PackMix>(saved.mix && packCount(saved.mix) ? saved.mix : presetMix(saved.style ?? 'small', DEFAULT_PACKS));
  const keep = (st: PackStyle | undefined, m: PackMix) => {
    setStyleState(st); setMixState(m);
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ style: st ?? null, mix: m })); } catch { /* storage unavailable */ }
  };
  const total = packCount(mix);
  const costs = usePackCosts(sizesOf(mix));
  const pool = useMainPool();
  const view = mixView(mix, pool, MANAGER_PARAMS.backingRatioBps);
  const parts = costs && !costs.error ? costParts(mix, costs.perPack) : undefined;
  const value = parts && parts.total + MANAGER_PARAMS.reserve;
  const wallet = useBalance(me);
  const disabled = !MANAGER_FACTORY ? 'Manager creation is not open yet'
    : !total ? 'Choose at least one pack'
    : costs?.error ? 'Current costs are unavailable'
    : value === undefined ? 'Reading current costs'
    : wallet !== undefined && value > wallet ? `Your wallet has ${eth(wallet, 5)} ETH` : undefined;
  const run = async () => {
    if (!pub || !me || !value || disabled || !MANAGER_FACTORY) return;
    const { design, mask } = encodeMix(mix);
    const params = { ...MANAGER_PARAMS, packUnitsMask: mask };
    const record: ManagerCreation = { chainId: chain.id, factory: MANAGER_FACTORY, owner: me, value: String(value),
      fromBlock: String(await pub.getBlockNumber()), since: Date.now() };
    const ok = await tx.send('Create manager', [['Create manager', async () => {
      const expected = await pub.readContract({ address: MANAGER_FACTORY!, abi: packManagerFactoryAbi, functionName: 'configHashFor', args: [params] });
      let hash;
      try {
        // Saved before the wallet opens, so a reload during or after signing resumes this creation.
        hash = await tx.write({ address: MANAGER_FACTORY!, abi: packManagerFactoryAbi, functionName: 'create', args: [me, params, design, expected], value },
          () => saveManagerCreation(record));
      } catch (e) {
        if (creationNotSubmitted(e)) clearManagerCreation();
        throw e;
      }
      const seen = await pub.getTransaction({ hash }).catch(() => undefined);
      try { saveManagerCreation({ ...record, hash, nonce: seen?.nonce }); } catch { /* the hashless record still resumes */ }
      return hash;
    }]]);
    if (ok) onCreated();
  };
  const pinPrice = <span className="pin-price">{value !== undefined ? <><b>{eth(value, 5)}</b> ETH</> : '–'}</span>;
  return (
    <ManagerDesign fresh style={style} mix={mix} onChange={keep} onReset={() => keep('small', presetMix('small', DEFAULT_PACKS))}
      view={view} note="Projected. Packs aren't listed until the manager is created." error={costs?.error}
      side={(
        <div className="cost">
          <div className="sum"><span>To create the manager</span><span><b>{value === undefined ? '–' : eth(value, 5)}</b><span className="u13">ETH</span></span></div>
          {parts && <>
            <div className="sub"><span>Pack Shapes</span><span>{eth(parts.principal, 5)}</span></div>
            <div className="sub"><span>Pack backing</span><span>{eth(parts.backing, 5)}</span></div>
            <div className="sub"><span>Shapes mint fees</span><span>{eth(parts.mint, 5)}</span></div>
            <div className="sub"><span>Listing budget and reserve</span><span>{eth(value! - parts.principal - parts.backing - parts.mint, 5)}</span></div>
          </>}
          <div className="row2"><span className="k">Factory fee</span><span>None</span></div>
        </div>
      )}
      pin={<>
        <div className="pin">
          {disabled && me && <p className="note" style={{ marginBottom: 12 }}>{disabled}</p>}
          <div className="pin-bar">
            {pinPrice}
            {!me ? <Connect className="btn lg" label="Connect wallet to create this manager" />
              : <button className="btn lg" disabled={!!tx.busy || !!disabled} onClick={run}>{tx.busy ? `${tx.busy}…` : `Create manager · ${value === undefined ? '–' : eth(value, 5)} ETH`}</button>}
          </div>
          <TxHelper tx={tx} />
        </div>
        {me && <div className="wsteps">
          <span className="lbl">1 wallet confirmation</span>
          <ol><li><span className="n">1</span><span>Create the manager and deposit {value === undefined ? '–' : eth(value, 5)} ETH</span></li></ol>
        </div>}
      </>} />
  );
}

/** The connected wallet's ETH, read once per address; undefined until read. */
function useBalance(me?: Address) {
  const pub = usePublicClient();
  const [bal, setBal] = useState<{ me: Address; wei: bigint }>();
  useEffect(() => {
    if (!pub || !me) return;
    let live = true;
    pub.getBalance({ address: me }).then((wei) => live && setBal({ me, wei }), () => undefined);
    return () => { live = false; };
  }, [pub, me]);
  return bal && bal.me === me ? bal.wei : undefined;
}

type ManagerTab = 'overview' | 'packs' | 'settings';
const MANAGER_TABS: [ManagerTab, string][] = [['overview', 'Overview'], ['packs', 'Packs'], ['settings', 'Settings']];

/** A live manager, laid out as a community pool: header, tabs, status, then the tab. */
function ManagerPage({ manager, v, me, count, index, setIndex }: { manager: Address; v?: Vault; me: Address; count: number; index: number; setIndex: (i: number) => void }) {
  const { data: m, error, refresh } = useManager(manager);
  const tx = useTx(refresh);
  const [tab, setTab] = useState<ManagerTab>('overview');
  if (!m) return <p className={`txline${error ? ' bad' : ''}`}>{error ?? 'Loading your manager…'}</p>;
  const cost = v && m.edge[2] ? packCost(m.edge[1], v.deployCharge) : undefined;
  const st = managerStatus(m, cost);
  const owner = m.owner.toLowerCase() === me.toLowerCase();
  return (
    <div className="pp">
      <div className="poolhead">
        <div className="ph-row">
          <div className="ph-id">
            <span className="crumb">Main pool /</span>
            <h1 className="ph-name">Your manager</h1>
            <div className="ph-meta">
              <span className="mono">{manager}</span>
              <button className="link quiet" onClick={() => navigator.clipboard?.writeText(manager)}>Copy address</button>
              {etherscan(manager) && <a href={etherscan(manager)} target="_blank" rel="noreferrer">Manager on Etherscan ↗</a>}
              {count > 1 && (
                <select className="select" value={index} aria-label="Manager" onChange={(e) => setIndex(Number(e.target.value))}>
                  {Array.from({ length: count }, (_, i) => <option key={i} value={i}>Manager {i + 1} of {count}</option>)}
                </select>
              )}
            </div>
          </div>
        </div>
        <nav className="tabs" aria-label="Sections">
          {MANAGER_TABS.map(([t, label]) => <button key={t} aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>{label}</button>)}
        </nav>
      </div>
      <div className="status" role="status"><span><b>{st.head}</b> {st.body}</span></div>
      <TxLine tx={tx} />
      {error && <p className="txline bad">{error}</p>}
      {!owner && <p className="txline">You are not the manager's owner. Changes need the owner's wallet.</p>}
      {tab === 'overview' && <ManagerOverview m={m} manager={manager} me={me} owner={owner} tx={tx} setTab={setTab} />}
      {tab === 'packs' && (owner ? <EditPacks m={m} manager={manager} tx={tx} onDone={() => setTab('overview')} />
        : <main className="page"><p className="lead">Only the owner can change packs.</p></main>)}
      {tab === 'settings' && <ManagerSettings m={m} manager={manager} me={me} owner={owner} tx={tx} />}
    </div>
  );
}

type LiveManager = NonNullable<ReturnType<typeof useManager>['data']>;
type ManagerTx = ReturnType<typeof useTx>;

/** Each listed position's units and backing, by size. */
const listedBySize = (m: LiveManager) => {
  const by: Record<number, bigint[]> = {};
  for (const p of m.book.active) (by[Number(p.value / 10n ** 16n)] ??= []).push(p.backing);
  return by;
};

function ManagerOverview({ m, manager, me, owner, tx, setTab }: { m: LiveManager; manager: Address; me: Address; owner: boolean; tx: ManagerTx; setTab: (t: ManagerTab) => void }) {
  const [mode, setMode] = useState<'deposit' | 'claim'>();
  const [amount, setAmount] = useState('');
  const target = decodeMix(m.design);
  const listed = listedBySize(m);
  const sizes = [...new Set([...sizesOf(target), ...Object.keys(listed).map(Number)])].sort((a, b) => a - b);
  const costs = usePackCosts(sizesOf(target), m.params);
  const toBuild: PackMix = Object.fromEntries(sizesOf(target).map((u) => [u, Math.max(0, target[u] - (m.held[u] ?? 0))]));
  const buildCost = costs && !costs.error ? costParts(toBuild, costs.perPack)?.total : undefined;
  const needed = buildCost === undefined ? undefined : buildCost + m.params.reserve;
  const short_ = needed !== undefined && needed > m.balance ? needed - m.balance : 0n;
  const missingPacks = sizesOf(toBuild).reduce((t, u) => t + toBuild[u], 0);
  const chance = (b: bigint) => shareOf(weightOf(b), m.pool.totalWeight);
  const items: InvItem[] = [...sizes].sort((a, b) => (listed[b]?.length ?? 0) - (listed[a]?.length ?? 0) || a - b).flatMap((u) => (listed[u] ?? []).map((b, j) => ({
    key: `${u}-${j}`, label: sizeLabel(u), nft: false, value: b, price: b, p: chance(b), mult: Number(b) / Number(m.pool.drawPrice), style: shadeOf(u, sizes),
  })));
  const missing = sizesOf(toBuild).flatMap((u) => Array.from({ length: Math.max(0, target[u] - (listed[u]?.length ?? 0)) }, (_, j) => ({ key: `${u}-${j}`, label: sizeLabel(u) })));
  const any = items.reduce((t, x) => t + x.p, 0);
  const deposit = (wei: bigint) => tx.send(`Add ${eth(wei, 5)} ETH`, [() => tx.transfer(manager, wei)]);
  const value = parse(amount);
  const start = (k: 'deposit' | 'claim') => { setMode(mode === k ? undefined : k); setAmount(''); };
  const signedEth = (w: bigint) => `${w < 0n ? '−' : ''}${eth(w < 0n ? -w : w, 5)}`;
  return (
    <main className="page cols ov">
      <section>
        <div className="blk">
          <h2 className="h">Value</h2>
          <div style={{ marginTop: 12 }}><span className="fig56">{eth(m.book.nav, 5)}</span><span className="u13">ETH</span></div>
          <p className="desc">ETH in the manager and in the packs it lists. Only you can withdraw; the factory that created it has no access.</p>
        </div>

        <div className="blk">
          <div className="blk-head"><h2 className="h">Packs</h2>{owner && <button className="link" onClick={() => setTab('packs')}>Change packs</button>}</div>
          <p className="desc">Your target mix against what's listed on FWA now. Each draw picks one listing; packs with lower backing come up more often.</p>
          {items.length || missing.length ? <InventoryGrid items={items} missing={missing} /> : <p className="foot">No packs are listed on FWA right now.</p>}
          <div className="ptab" role="table" aria-label="Packs">
            <div className="tr th" role="row"><span>Pack</span><span>Listed</span><span>Chance per draw</span></div>
            {sizes.map((u) => (
              <div className="tr" role="row" key={u}>
                <span><span className={`sw${listed[u]?.length ? '' : ' miss'}`} style={listed[u]?.length ? shadeOf(u, sizes) : undefined} />{sizeLabel(u)}</span>
                <span className={(listed[u]?.length ?? 0) < (target[u] ?? 0) ? 'error' : undefined}>{listed[u]?.length ?? 0} of {target[u] ?? 0}</span>
                <span>{listed[u]?.length ? oneIn(chance(listed[u][0])) : <span className="off">Not listed</span>}</span>
              </div>
            ))}
            {m.book.bought > 0 && <div className="tr" role="row"><span>{m.book.bought} bought · waiting on keep or bid</span><span /><span /></div>}
            {m.book.idle > 0 && <div className="tr" role="row"><span>{m.book.idle} idle · not listed</span><span /><span /></div>}
            {items.length > 0 && <div className="tr sum" role="row"><span>One of your packs picked</span><span /><span>{oneIn(any)}</span></div>}
          </div>
          {items.length > 0 && <p className="foot">At the main pool's current listings and its {eth(m.pool.drawPrice, 5)} ETH draw price.</p>}
        </div>

        <div className="blk">
          <h2 className="h">Lifetime results</h2>
          <p className="desc">What happened to picked packs, and what the manager paid, since it was created.</p>
          <div className="kvs">
            <div className="kv"><span className="k">Kept by buyers, then rebuilt</span><span>{m.keeps}</span></div>
            <div className="kv"><span className="k">Bid back, then relisted</span><span>{m.bids}</span></div>
            <div className="kv"><span className="k">Paid to keepers</span><span>{signedEth(-m.keeperPay)} ETH</span></div>
            <div className="kv"><span className="k">Token rewards claimed and burned</span><span>{eth(m.tokensBurned, 2)} FWA</span></div>
          </div>
          <p className="foot">Through block {m.blockNumber.toLocaleString()}. Leaves out deposits and withdrawals.</p>
        </div>
      </section>

      <section className="sticky">
        <div className="blk" id="operating-eth">
          <div className="blk-head">
            <h2 className="h">Operating ETH</h2>
            {needed === undefined ? <span className="tag">–</span> : short_ > 0n ? <span className="tag bad">{eth(short_, 5)} ETH short</span> : <span className="tag">Funded</span>}
          </div>
          <p className="desc">ETH the manager uses to build the packs in your target and to pay keepers. It keeps a {eth(m.params.reserve, 5)} ETH reserve.</p>
          {needed !== undefined && <>
            <div className="bar" aria-hidden>
              <i style={{ width: `${needed > 0n && m.balance < needed ? Number(m.balance * 10_000n / needed) / 100 : 100}%` }} />
              {short_ > 0n && <b style={{ width: `${Number(short_ * 10_000n / needed) / 100}%` }} />}
            </div>
            <div className="bar-l"><span><b>{eth(m.balance, 5)}</b> ETH in the manager</span><span><b>{eth(needed, 5)}</b> ETH needed</span></div>
          </>}
          {short_ > 0n && <>
            <p className="warn">{`That's why ${missingPacks === 1 ? "one pack isn't" : `${missingPacks} packs aren't`} built yet. Add the difference to build ${missingPacks === 1 ? 'it' : 'them'}, or lower the counts.`}</p>
            {owner && <div className="acts">
              <button className="btn" disabled={!!tx.busy} onClick={() => deposit(short_)}>Add {eth(short_, 5)} ETH</button>
              <button className="link" onClick={() => setTab('packs')}>Change packs</button>
              <button className="link" onClick={() => start('deposit')}>Other amount</button>
            </div>}
          </>}
          {needed !== undefined && short_ === 0n && <>
            <p className="foot">{eth(m.balance - needed, 5)} ETH spare, included in Withdraw.</p>
            {owner && <div className="acts"><button className={mode === 'deposit' ? 'btn' : 'btn sec'} onClick={() => start('deposit')}>Add ETH</button></div>}
          </>}
          {owner && mode === 'deposit' && (
            <div className="acts">
              <div className="field" style={{ width: 180 }}><input aria-label="Deposit amount" className="big" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /><span className="u">ETH</span></div>
              <button className="btn" disabled={!!tx.busy || !value} onClick={() => value && deposit(value).then((ok) => ok && setMode(undefined))}>Deposit {amount || '0'} ETH</button>
            </div>
          )}
        </div>

        <div className="blk">
          <h2 className="h">Withdraw ETH</h2>
          <div className="kvs">
            <div className="kv"><span className="k">Not in packs</span><span>{eth(m.balance, 5)} ETH</span></div>
            <div className="kv"><span className="k">In listed packs</span><span>{eth(m.book.inListed, 5)} ETH</span></div>
            <div className="kv sum"><span className="k">Total available to withdraw</span><span>{eth(m.balance, 5)} ETH</span></div>
          </div>
          {owner && <div className="acts">
            <button className="btn" disabled={!!tx.busy || m.balance === 0n} onClick={() => tx.send('Withdraw', [() => tx.write({ address: manager, abi: packManagerAbi, functionName: 'withdraw', args: [me, m.balance] })])}>Withdraw {eth(m.balance, 5)} ETH</button>
            <button className="link" disabled={m.balance === 0n} onClick={() => start('claim')}>Other amount</button>
          </div>}
          {owner && mode === 'claim' && (
            <div className="acts">
              <div className="field" style={{ width: 180 }}><input aria-label="Withdraw amount" className="big" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /><span className="u">ETH</span></div>
              <button className="btn" disabled={!!tx.busy || !value || value > m.balance} onClick={() => value && tx.send('Withdraw', [() => tx.write({ address: manager, abi: packManagerAbi, functionName: 'withdraw', args: [me, value] })]).then((ok) => ok && setMode(undefined))}>Withdraw {amount || '0'} ETH</button>
            </div>
          )}
          <p className="foot">ETH in listed packs comes back when they are picked, or all at once with exit mode in Settings.</p>
        </div>

        <div className="blk">
          <div className="blk-head"><h2 className="h">ETH in the manager</h2><span className="total">{eth(m.book.nav, 5)} ETH</span></div>
          <p className="desc">Everything the manager holds and what it's for.</p>
          <div className="kvs">
            <div className="kv"><span className="k">Listed packs, Shapes and backing</span><span>{eth(m.book.inListed, 5)} ETH</span></div>
            {m.book.inBought > 0n && <div className="kv"><span className="k">Bought packs, waiting on keep or bid</span><span>{eth(m.book.inBought, 5)} ETH</span></div>}
            {m.book.fees > 0n && <div className="kv"><span className="k">Draw fees earned, not yet collected</span><span>{eth(m.book.fees, 5)} ETH</span></div>}
            <div className="kv"><span className="k">Not in packs</span><span>{eth(m.balance, 5)} ETH</span></div>
          </div>
          <p className="foot">Withdrawn to date: {eth(m.withdrawn, 5)} ETH.</p>
        </div>
      </section>
    </main>
  );
}

/** The Packs tab: the creation layout on a live manager. Saving deposits what building the new counts needs. */
function EditPacks({ m, manager, tx, onDone }: { m: LiveManager; manager: Address; tx: ManagerTx; onDone: () => void }) {
  const pub = usePublicClient();
  const saved = decodeMix(m.design);
  const start = sizesOf(saved).length ? saved : presetMix('small', 1);
  const [draft, setDraft] = useState<{ style?: PackStyle; mix: PackMix }>({ mix: start });
  const sizes = sizesOf(draft.mix);
  const costs = usePackCosts(sizes, m.params);
  const listedWeight = m.book.active.reduce((t, p) => t + weightOf(p.backing), 0n);
  const view = mixView(draft.mix, m.pool, m.params.backingRatioBps, listedWeight);
  const toBuild: PackMix = Object.fromEntries(sizes.map((u) => [u, Math.max(0, draft.mix[u] - (m.held[u] ?? 0))]));
  const build = costs && !costs.error ? costParts(toBuild, costs.perPack)?.total : undefined;
  const needed = build === undefined ? undefined : build + m.params.reserve;
  const shortBy = needed !== undefined && needed > m.balance ? needed - m.balance : 0n;
  const { design, mask } = packCount(draft.mix) ? encodeMix(draft.mix) : { design: 0n, mask: 0n };
  const changed = design !== m.design;
  const M = { address: manager, abi: packManagerAbi } as const;
  // The design sets counts; packUnitsMask must admit exactly the chosen sizes, so it changes with them when needed.
  const actions = [changed && 'Save the pack counts', mask !== m.params.packUnitsMask && 'allow the new pack sizes', changed && shortBy > 0n && `deposit ${eth(shortBy, 5)} ETH`].filter(Boolean) as string[];
  const save = async () => {
    const steps = [() => tx.write({ ...M, functionName: 'setDesign', args: [design] })];
    if (mask !== m.params.packUnitsMask) steps.push(async () => tx.write({ ...M, functionName: 'setParams',
      args: [{ ...m.params, packUnitsMask: mask }, await pub!.readContract({ ...M, functionName: 'configurationHash' })] } as never));
    if (shortBy > 0n) steps.push(() => tx.transfer(manager, shortBy));
    if (await tx.send('Save changes', steps)) onDone();
  };
  const figureEth = (w: bigint | undefined) => (w === undefined
    ? <span className="figure-s muted">—</span>
    : <span><span className="figure-s">{eth(w, 5)}</span><span className="unit">ETH</span></span>);
  return (
    <ManagerDesign fresh={false} style={draft.style} mix={draft.mix} onChange={(style, mix) => setDraft({ style, mix })} onReset={() => setDraft({ mix: start })}
      view={view} note={changed ? 'Projected at the new counts.' : m.book.active.length < packCount(draft.mix) ? 'Projected: some packs not listed yet.' : undefined} error={costs?.error}
      side={(
        <div className="totals">
          <div><span>Needed to build the target</span>{figureEth(needed)}</div>
          <div><span>Available in the manager</span>{figureEth(m.balance)}</div>
          {shortBy > 0n
            ? <div><b>Deposited when you save</b>{figureEth(shortBy)}</div>
            : <div><span>Above what's needed</span>{figureEth(needed === undefined ? undefined : m.balance - needed)}</div>}
        </div>
      )}
      pin={(
        <div className="pin">
          <div className="pin-bar">
            <span className="pin-price">{view ? <><b>{oneIn(view.any)}</b> draws</> : '–'}</span>
            <button className="btn lg" disabled={!!tx.busy || !changed || !packCount(draft.mix)} onClick={save}>{tx.busy ? `${tx.busy}…` : 'Save changes'}</button>
          </div>
          {changed && <p className="note steps-note" style={{ marginTop: 10 }}>{actions.join(', ').replace(/^./, (c) => c.toUpperCase())}. Up to {actions.length} confirmation{actions.length === 1 ? '' : 's'} in your wallet.</p>}
        </div>
      )} />
  );
}

const SETTING_GROUPS: [string, string][] = [['general', 'General'], ['numbers', 'Numbers']];

/** The Settings tab, as the community pool settings: an index and grouped rows. */
function ManagerSettings({ m, manager, me, owner, tx }: { m: LiveManager; manager: Address; me: Address; owner: boolean; tx: ManagerTx }) {
  const [at, setAt] = useState('general');
  const [confirmExit, setConfirmExit] = useState(false);
  const busy = !!tx.busy;
  const control = (name: string, fn: string, args: unknown[]) => tx.send(name, [() => tx.write({ address: manager, abi: packManagerAbi, functionName: fn, args } as never)]);
  const go = (id: string) => { setAt(id); document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const budget = (cap: bigint, rate: bigint, now: bigint) => `${eth(now, 4)} of ${eth(cap, 3)} ETH · ${eth(rate, 3)} ETH a day`;
  const group = (id: string, title: string, desc: string, rows: ReactNode) => (
    <div className="grp" id={`set-${id}`}><h2 className="h">{title}</h2><p className="desc">{desc}</p>{rows}</div>
  );
  return (
    <main className="page st">
      <nav className="idx" aria-label="Settings sections">
        {SETTING_GROUPS.map(([id, title]) => <button key={id} aria-current={at === id} onClick={() => go(id)}>{title}</button>)}
      </nav>
      <section>
        {group('general', 'General', 'Whether the manager lists new packs, and taking everything back out.', <>
          <SRow label="New listings" desc="Pausing stops new listings. Listed packs stay listed." value={m.listingPaused ? 'Paused' : 'On'}>
            <button className="btn sec" disabled={busy || !owner || m.exiting} onClick={() => control(m.listingPaused ? 'Resume listings' : 'Pause new listings', 'setListingPaused', [!m.listingPaused])}>{m.listingPaused ? 'Resume' : 'Pause'}</button>
          </SRow>
          <SRow label="Exit mode" desc={confirmExit ? 'Every pack will be unlisted and turned back into ETH. Confirm to send.' : 'Unlists every pack and turns it back into ETH. You can leave exit mode later.'} value={m.exiting ? 'On' : 'Off'}>
            {m.exiting
              ? <button className="btn sec" disabled={busy || !owner} onClick={() => control('Leave exit mode', 'setExiting', [false])}>Leave exit mode</button>
              : confirmExit
                ? <><button className="link quiet" onClick={() => setConfirmExit(false)}>Cancel</button><button className="btn sec" disabled={busy} onClick={() => { setConfirmExit(false); control('Start exit', 'setExiting', [true]); }}>Confirm exit</button></>
                : <button className="btn sec" disabled={busy || !owner} onClick={() => setConfirmExit(true)}>Start exit</button>}
          </SRow>
          <SRow label="Idle packs" desc="Takes unlisted packs to your wallet." value={String(m.book.idle)}>
            <button className="btn sec" disabled={busy || !owner || m.book.idle === 0} onClick={() => control('Withdraw packs', 'withdrawPacks', [me, BigInt(m.book.idle)])}>Withdraw packs</button>
          </SRow>
        </>)}
        {group('numbers', 'Numbers', 'The settings the manager was created with.', <>
          <SRow label="Backing" value={`${(m.params.backingRatioBps / 10_000).toFixed(4)}× pack value`} />
          <SRow label="Operating reserve" value={`${eth(m.params.reserve, 5)} ETH`} />
          <SRow label="Pack sizes allowed" value={`${Array.from({ length: 31 }, (_, u) => u).filter((u) => (m.params.packUnitsMask >> BigInt(u)) & 1n).map((u) => (u / 100).toFixed(2)).join(', ')} ETH`} />
          <SRow label="Routine keeper budget" value={budget(m.params.routineCap, m.params.routineRate, m.budget[0])} />
          <SRow label="Essential keeper budget" value={budget(m.params.essentialCap, m.params.essentialRate, m.budget[1])} />
          <SRow label="Gas ceiling" value={`${(Number(m.params.gasCeiling) / 1e9).toFixed(2)} gwei`} />
          <SRow label="Minimum edge" value={`${(m.params.minEdgeBps / 100).toFixed(2)}%`} />
          <SRow label="Shapes mint fee now" value={`${eth(m.mintFee, 6)} ETH a Shape`} />
        </>)}
      </section>
    </main>
  );
}
