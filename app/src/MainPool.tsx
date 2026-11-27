import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { formatEther, parseEther, type Address } from 'viem';
import { packManagerAbi, packManagerFactoryAbi, packVaultAbi } from '../../shared/main-pool-abi';
import { chain } from './chain';
import { explain } from './errors';
import { creationNotSubmitted } from './creation';
import { createLatestRefresh } from './refresh';
import { eth, short, useTx } from './App';
import {
  HAND_SIZES, MAX_PACKS, MAX_PER_SIZE, decodeMix, encodeMix, fundingFor, mixText, packCount, presetMix, scaleMix, sizeLabel, sizesOf,
  type PackMix, type PackStyle,
} from '../../shared/manager-design';
import {
  MAIN_POOL_OPEN, MANAGER_FACTORY, MANAGER_PARAMS, MIN_DEPOSIT, POSITION_VALUE, VAULT, checkCreation, clearManagerCreation,
  depositShares, findManagers, loadManagerCreation, managerStatus, packCost, packsFor, readManager, readVault, redeemCharge,
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

/** One pack's ETH per size from PackManagerFactory.preview (its opening cash less the reserve), at current gas and
 *  mint fee; undefined until read. */
function usePackCosts(sizes: number[]) {
  const pub = usePublicClient();
  const key = sizes.join(',');
  const [costs, setCosts] = useState<{ key: string; perPack: Record<number, bigint>; error?: string }>();
  useEffect(() => {
    if (!pub || !MANAGER_FACTORY || !sizes.length) return;
    let live = true;
    Promise.all(sizes.map(async (u) => {
      const [, , , , openingCash] = await pub.readContract({ address: MANAGER_FACTORY!, abi: packManagerFactoryAbi, functionName: 'preview',
        args: [{ ...MANAGER_PARAMS, packUnitsMask: 1n << BigInt(u) }] });
      return [u, openingCash - MANAGER_PARAMS.reserve] as const;
    })).then((rows) => live && setCosts({ key, perPack: Object.fromEntries(rows) }),
      (e) => live && setCosts({ key, perPack: {}, error: explain(e) }));
    return () => { live = false; };
  }, [pub, key]);
  return costs?.key === key ? costs : undefined;
}

/** The pack mix controls, as in the community designer: a preset, the pack count it scales to, and exact counts by
 *  hand (which leave the preset). `perPack` is one pack's ETH per size when known. */
function PackDesigner({ style, mix, perPack, onChange }: { style?: PackStyle; mix: PackMix; perPack?: Record<number, bigint>;
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
            <div className="tiles" role="group" aria-label="Pack style">
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
                <p className="note" style={{ marginBottom: 6 }}>Exact pack counts. Any size can be zero.</p>
                {shown.map((u) => (
                  <div className="mixrow" key={u}>
                    <div><div className="t">{sizeLabel(u)}</div>{perPack?.[u] !== undefined && <div className="s">{ethText(perPack[u])} ETH each</div>}</div>
                    <div className="stepper end">
                      <button aria-label={`One fewer ${sizeLabel(u)}`} disabled={!mix[u]} onClick={() => setCountAt(u, (mix[u] ?? 0) - 1)}>−</button>
                      <output aria-live="polite">{mix[u] ?? 0}</output>
                      <button aria-label={`One more ${sizeLabel(u)}`} disabled={total >= MAX_PACKS || (mix[u] ?? 0) >= MAX_PER_SIZE} onClick={() => setCountAt(u, (mix[u] ?? 0) + 1)}>+</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="rule" style={{ marginTop: 24 }}>
              <div className="ctl-row"><label className="ctl" htmlFor="packs">Number of packs</label><span className="big-v">{total}</span></div>
              <input id="packs" type="range" min={1} max={MAX_PACKS} step={1} value={Math.max(1, total)} aria-valuetext={`${total} packs`}
                onChange={(e) => setTotal(Number(e.target.value))} />
              <p className="note">With one pack the result is mostly luck.</p>
            </div>
    </>
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
  const sizes = sizesOf(mix);
  const costs = usePackCosts(sizes);
  const value = costs && !costs.error ? fundingFor(mix, costs.perPack, MANAGER_PARAMS.reserve) : undefined;
  const wallet = useBalance(me);
  const disabled = !MANAGER_FACTORY ? 'Manager creation is not open yet'
    : !total ? 'Choose at least one pack'
    : costs?.error ? 'Current costs are unavailable'
    : value === undefined ? 'Reading current costs'
    : wallet !== undefined && value > wallet ? `Your wallet has ${eth(wallet)} ETH` : undefined;
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
  return (
    <>
      <StatusBar head="No manager yet." body="Nothing is sent until you create it and confirm in your wallet." />
      <main className="page cols design mp">
        <section>
          <h1 className="title">Create a personal manager</h1>
          <p className="lead">It runs the shared vault's strategy with only your ETH. You own it from the moment it is created; the factory keeps no control and charges no fee.</p>
          <Group title="Packs" desc="Shape packs your manager builds and keeps listed on FWA's main pool. Each pack posts backing at the same ratio to its value.">
            <PackDesigner style={style} mix={mix} perPack={costs?.perPack} onChange={keep} />
          </Group>
        </section>
        <section className="sticky results">
          <div className="kvs">
            {sizes.map((u) => (
              <div className="kv" key={u}><span className="k">{mix[u]} × {sizeLabel(u)}</span><span>{costs?.perPack[u] === undefined ? '–' : `${ethText(costs.perPack[u] * BigInt(mix[u]))} ETH`}</span></div>
            ))}
            <div className="kv"><span className="k">Operating reserve</span><span>{ethText(MANAGER_PARAMS.reserve)} ETH</span></div>
            <div className="kv"><span className="k">To fund</span><span>{value === undefined ? '–' : `${ethText(value)} ETH`}</span></div>
            <div className="kv"><span className="k">Fee</span><span>None</span></div>
          </div>
          {costs?.error && <p className="note error" role="status">{costs.error}</p>}
          <div className="pin">
            {!me ? <Connect className="btn lg" />
              : <button className="btn lg" disabled={!!tx.busy || !!disabled} onClick={run}>{tx.busy ? `${tx.busy}…` : disabled ?? `Create manager with ${ethText(value!)} ETH`}</button>}
            <TxHelper tx={tx}>One confirmation.</TxHelper>
          </div>
        </section>
      </main>
    </>
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

function ManagerPage({ manager, v, me, count, index, setIndex }: { manager: Address; v?: Vault; me: Address; count: number; index: number; setIndex: (i: number) => void }) {
  const { data: m, error, refresh } = useManager(manager);
  const tx = useTx(refresh);
  const [mode, setMode] = useState<'add' | 'withdraw'>();
  const [amount, setAmount] = useState('');
  const [confirmExit, setConfirmExit] = useState(false);
  const [numbers, setNumbers] = useState(false);
  const pub = usePublicClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ style?: PackStyle; mix: PackMix }>({ mix: {} });
  if (!m) return <p className={`txline${error ? ' bad' : ''}`}>{error ?? 'Loading your manager…'}</p>;
  const M = { address: manager, abi: packManagerAbi } as const;
  // One more pack's ETH: its Shapes, this manager's live backing and the work to build it (the vault's quote).
  const cost = v && m.edge[2] ? packCost(m.edge[1], v.deployCharge) : undefined;
  const st = managerStatus(m, cost);
  const seg = mode ?? (m.book.listed === 0 ? 'add' : 'withdraw');
  const value = parse(amount);
  const busy = !!tx.busy;
  const owner = m.owner.toLowerCase() === me.toLowerCase();
  const disabled = !owner ? 'Only the owner can do this' : !value ? 'Enter an amount'
    : seg === 'withdraw' && value > m.balance ? `${eth(m.balance)} ETH is available`
    : seg === 'add' && v?.holder && value > v.holder.wallet ? `Your wallet has ${eth(v.holder.wallet)} ETH` : undefined;
  const label = disabled ?? (seg === 'withdraw' ? `Withdraw ${amount} ETH` : `Add ${amount} ETH`);
  const submit = () => {
    if (!value) return;
    tx.send(label, [seg === 'withdraw' ? () => tx.write({ ...M, functionName: 'withdraw', args: [me, value] }) : () => tx.transfer(manager, value)])
      .then((ok) => ok && setAmount(''));
  };
  const targetMix = decodeMix(m.design);
  const target = sizesOf(targetMix);
  // The design sets counts; packUnitsMask must admit exactly the chosen sizes, so it changes with them when needed.
  const saveMix = async () => {
    const { design, mask } = encodeMix(draft.mix);
    const steps = [() => tx.write({ ...M, functionName: 'setDesign', args: [design] })];
    if (mask !== m.params.packUnitsMask) steps.push(async () => tx.write({ ...M, functionName: 'setParams',
      args: [{ ...m.params, packUnitsMask: mask }, await pub!.readContract({ ...M, functionName: 'configurationHash' })] } as never));
    if (await tx.send('Save packs', steps)) setEditing(false);
  };
  const control = (name: string, fn: string, args: unknown[]) => tx.send(name, [() => tx.write({ ...M, functionName: fn, args } as never)]);
  const squares: CSSProperties[] = [
    ...Array<CSSProperties>(m.book.listed).fill({ background: '#fff' }),
    ...Array<CSSProperties>(m.book.bought).fill({ outline: '2px dashed #fff', outlineOffset: -2 }),
    ...Array<CSSProperties>(m.book.idle).fill({ background: '#333' }),
  ];
  const canList = cost === undefined ? undefined : packsFor(m.balance + (value ?? 0n), m.params.reserve, cost);
  const budget = (cap: bigint, rate: bigint, now: bigint) => `${eth(now, 4)} of ${eth(cap, 3)} ETH · ${eth(rate, 3)} ETH a day`;
  return (
    <>
      <StatusBar head={st.head} body={st.body} link={{ href: etherscan(manager), label: 'Manager on Etherscan ↗' }} />
      {error && <p className="txline bad">{error}</p>}
      <main className="page cols design mp">
        <section>
          <h1 className="title">Your manager</h1>
          {count > 1 && (
            <select className="select" style={{ marginTop: 14 }} value={index} aria-label="Manager" onChange={(e) => setIndex(Number(e.target.value))}>
              {Array.from({ length: count }, (_, i) => <option key={i} value={i}>Manager {i + 1} of {count}</option>)}
            </select>
          )}
          <div className="addr"><span className="mono">{manager}</span><button className="link quiet" onClick={() => navigator.clipboard?.writeText(manager)}>Copy address</button></div>
          <p className="lead">Your own account on FWA's main pool. Only you can withdraw. The factory that created it has no access.</p>
          {!owner && <p className="note error" style={{ marginTop: 10 }}>The connected wallet does not own this manager.</p>}
          <Group title="Packs" desc={target.length ? `Target: ${mixText(targetMix)}. Held: ${target.map((u) => `${m.held[u] ?? 0} × ${(u / 100).toFixed(2)}`).join(', ')}.` : 'No pack counts set. Keepers build the smallest allowed pack size.'}>
            <div className="group-body tight">
              {squares.length > 0 ? <div className="packs" aria-hidden="true">{squares.map((s, i) => <span key={i} style={s} />)}</div> : <p className="note">No packs yet. Keepers build them from the manager's ETH.</p>}
              <div className="legend row-legend">
                {m.book.listed > 0 && <div><span className="sw" style={{ background: '#fff' }} />Listed {m.book.listed}</div>}
                {m.book.bought > 0 && <div><span className="sw" style={{ border: '1px dashed #fff' }} />Bought, waiting on keep or bid {m.book.bought}</div>}
                {m.book.idle > 0 && <div><span className="sw" style={{ background: '#333' }} />Idle {m.book.idle}</div>}
              </div>
              {editing ? (
                <div style={{ marginTop: 14 }}>
                  <PackDesigner style={draft.style} mix={draft.mix} onChange={(style, mix) => setDraft({ style, mix })} />
                  <p className="note" style={{ marginTop: 10 }}>Lower counts stop new builds of that size. Packs already held stay listed.</p>
                  <span className="row" style={{ marginTop: 14 }}>
                    <button className="link quiet" onClick={() => setEditing(false)}>Cancel</button>
                    <button className="btn sec" disabled={busy || !owner || !packCount(draft.mix)} onClick={saveMix}>Save packs</button>
                  </span>
                </div>
              ) : <button className="btn sec" style={{ marginTop: 14 }} disabled={busy || !owner} onClick={() => { setDraft({ mix: target.length ? targetMix : presetMix('small', 1) }); setEditing(true); }}>Change packs</button>}
              <div className="kvs">
                <div className="kv"><span className="k">Kept by buyers, then rebuilt</span><span>{m.keeps}</span></div>
                <div className="kv"><span className="k">Bid back, then relisted</span><span>{m.bids}</span></div>
              </div>
            </div>
          </Group>
          <Group title="Controls">
            <div className="rows">
              <div>
                <div><h3 className="ctl">Pause new listings</h3><p className="h">Listed packs stay listed. Resume any time.</p></div>
                <button className="btn sec" disabled={busy || !owner || m.exiting} onClick={() => control(m.listingPaused ? 'Resume listings' : 'Pause new listings', 'setListingPaused', [!m.listingPaused])}>{m.listingPaused ? 'Resume' : 'Pause'}</button>
              </div>
              <div>
                <div><h3 className="ctl">Exit mode</h3><p className="h">{confirmExit ? 'Every pack will be unlisted and turned back into ETH. Confirm to send.' : 'Unlists every pack and turns it back into ETH. You can leave exit mode later.'}</p></div>
                {m.exiting
                  ? <button className="btn sec" disabled={busy || !owner} onClick={() => control('Leave exit mode', 'setExiting', [false])}>Leave exit mode</button>
                  : confirmExit
                    ? <span className="row"><button className="link quiet" onClick={() => setConfirmExit(false)}>Cancel</button><button className="btn sec" disabled={busy} onClick={() => { setConfirmExit(false); control('Start exit', 'setExiting', [true]); }}>Confirm exit</button></span>
                    : <button className="btn sec" disabled={busy || !owner} onClick={() => setConfirmExit(true)}>Start exit</button>}
              </div>
              <div>
                <div><h3 className="ctl">Withdraw idle packs</h3><p className="h">Takes unlisted packs to your wallet.{m.book.idle === 0 ? ' None are idle now.' : ''}</p></div>
                <button className="btn sec" disabled={busy || !owner || m.book.idle === 0} onClick={() => control('Withdraw packs', 'withdrawPacks', [me, BigInt(m.book.idle)])}>Withdraw packs</button>
              </div>
            </div>
          </Group>
        </section>
        <section className="sticky results">
          <div>
            <span className="soft" style={{ fontSize: 15 }}>Value</span>
            <div className="pay"><span className="figure">{eth(m.book.nav)}</span><span className="unit">ETH</span></div>
          </div>
          <div className="seg" role="group" aria-label="Action">
            <button aria-pressed={seg === 'add'} onClick={() => { setMode('add'); setAmount(''); }}>Add ETH</button>
            <button aria-pressed={seg === 'withdraw'} onClick={() => { setMode('withdraw'); setAmount(''); }}>Withdraw</button>
          </div>
          <Amount label="Amount" value={amount} onChange={setAmount} unit="ETH" max={seg === 'withdraw' ? () => setAmount(formatEther(m.balance)) : undefined} />
          <div className="kvs">
            {seg === 'withdraw' ? <>
              <div className="kv"><span className="k">Available now</span><span>{eth(m.balance)} ETH</span></div>
              <div className="kv"><span className="k">In listed packs</span><span>{eth(m.book.inListed)} ETH</span></div>
              {m.book.inBought > 0n && <div className="kv"><span className="k">In the bought pack{m.book.bought === 1 ? '' : 's'}</span><span>{eth(m.book.inBought)} ETH</span></div>}
            </> : <>
              <div className="kv"><span className="k">Packs it can list</span><span>{canList === undefined ? '–' : canList.toString()}</span></div>
              <div className="kv"><span className="k">Reserve kept</span><span>{eth(m.params.reserve)} ETH</span></div>
            </>}
          </div>
          <div className="pin">
            <button className="btn lg" disabled={busy || !!disabled} onClick={submit}>{tx.busy ? `${tx.busy}…` : label}</button>
            <TxHelper tx={tx}>{seg === 'withdraw' ? 'To withdraw ETH in listed packs, start exit mode.' : undefined}</TxHelper>
          </div>
          <button className="disclose" aria-expanded={numbers} onClick={() => setNumbers(!numbers)}>All numbers {numbers ? '▴' : '▾'}</button>
          {numbers && (
            <div className="kvs">
              <div className="kv"><span className="k">Reserve</span><span>{eth(m.params.reserve, 4)} ETH</span></div>
              <div className="kv"><span className="k">Routine keeper budget</span><span>{budget(m.params.routineCap, m.params.routineRate, m.budget[0])}</span></div>
              <div className="kv"><span className="k">Essential keeper budget</span><span>{budget(m.params.essentialCap, m.params.essentialRate, m.budget[1])}</span></div>
              <div className="kv"><span className="k">Gas ceiling</span><span>{(Number(m.params.gasCeiling) / 1e9).toFixed(2)} gwei</span></div>
              <div className="kv"><span className="k">Min edge</span><span>{(m.params.minEdgeBps / 100).toFixed(2)}%</span></div>
              <div className="kv"><span className="k">Pack sizes allowed</span><span>{Array.from({ length: 31 }, (_, u) => u).filter((u) => (m.params.packUnitsMask >> BigInt(u)) & 1n).map((u) => (u / 100).toFixed(2)).join(', ')} ETH</span></div>
              <div className="kv"><span className="k">Shapes mint fee now</span><span>{eth(m.mintFee, 4)} ETH a Shape</span></div>
              <div className="kv"><span className="k">Keeper pay to date</span><span>{eth(m.keeperPay, 5)} ETH</span></div>
              <div className="kv"><span className="k">Withdrawn to date</span><span>{eth(m.withdrawn, 4)} ETH</span></div>
              <div className="kv"><span className="k">Token rewards claimed and burned</span><span>{eth(m.tokensBurned, 2)} FWA · valued at 0</span></div>
            </div>
          )}
        </section>
      </main>
    </>
  );
}

