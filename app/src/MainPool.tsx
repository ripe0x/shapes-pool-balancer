import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { formatEther, parseEther, type Address } from 'viem';
import { packManagerAbi, packManagerFactoryAbi, packVaultAbi } from '../../shared/main-pool-abi';
import { chain } from './chain';
import { explain } from './errors';
import { MainPoolSettings } from './MainPoolSettings';
import { CallerFundedExit, CheckpointContributions } from './MainPoolExit';
import { creationNotSubmitted } from './creation';
import { createLatestRefresh } from './refresh';
import { eth, short, useTx } from './App';
import {
  MAIN_POOL_INTERACTIVE, MAIN_MANAGER_INTERACTIVE, MAIN_POOL_VISIBLE, MANAGER_FACTORY, MANAGER_PARAMS, VAULT, mainTabForProducts, checkCreation, clearManagerCreation,
  depositShares, findManagers, loadManagerCreation, managerStatus, packCost, packsFor, readManager, readVault, redeemCharge, renewalWaits,
  saveManagerCreation, vaultStatus, previewManager, type CreationState, type Manager, type ManagerCreation, type Vault,
} from './main-pool';

export type MainTab = 'overview' | 'vault' | 'manager';
/** Without a manager factory there is nothing to compare: the section is the vault alone. */
export const mainTabFor = (t: MainTab): MainTab => mainTabForProducts(t, !!VAULT, !!MANAGER_FACTORY);
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
  return usePolled<Vault>(pub && VAULT && MAIN_POOL_INTERACTIVE ? `${pub.chain.id}:${VAULT}:${me ?? ''}` : undefined, () => readVault(pub!, VAULT!, me));
}

export function useManager(manager: Address | undefined) {
  const pub = usePublicClient();
  return usePolled<Manager>(pub && manager ? `${pub.chain.id}:${manager}` : undefined, () => readManager(pub!, manager!));
}

function useManagers(me?: Address) {
  const pub = usePublicClient();
  return usePolled(pub && me && MANAGER_FACTORY && MAIN_MANAGER_INTERACTIVE ? `${pub.chain.id}:${MANAGER_FACTORY}:${me}` : undefined, () => findManagers(pub!, MANAGER_FACTORY!, me!));
}

function Connect({ label = 'Connect wallet', className = 'btn' }: { label?: string; className?: string }) {
  return <ConnectButton.Custom>{({ openConnectModal }) => <button className={className} onClick={openConnectModal}>{label}</button>}</ConnectButton.Custom>;
}

function StatusBar({ head, body, link }: { head: string; body: string; link?: { href?: string; label: string } }) {
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
    <main className={`home${MAIN_POOL_VISIBLE ? '' : ' single'}`}>
      <section>
        <span className="eyebrow">For creators</span>
        <h1 className="title">Community pools</h1>
        <p className="lead">Run your own pool on FWA. Players pay a draw price and win one prize at random: a curated NFT from your wallet, or a Shape you fund with ETH.</p>
        <div className="acts">
          <button className="btn big" onClick={onNew}>Create a community pool</button>
          {hasPools && <button className="link" onClick={onList}>Your community pools →</button>}
        </div>
      </section>
      {MAIN_POOL_VISIBLE && (
        <section>
          <span className="eyebrow">For depositors</span>
          <h1 className="title">Main pool</h1>
          <p className="lead">Earn on FWA's main pool. Your ETH builds 0.03 ETH Shape packs and lists them. Deposit with other holders, or run your own manager.</p>
          <div className="acts">
            {MAIN_POOL_INTERACTIVE && <button className="btn big" onClick={() => onMain('vault')}>Deposit in the shared vault</button>}
            {MANAGER_FACTORY && <button className="link" onClick={() => onMain('manager')}>Personal managers →</button>}
          </div>
          {v && <p className="fact">Shared vault: {eth(v.book.nav, 2)} ETH {v.book.navCurrent ? 'current value' : 'booked principal'}, {v.book.listed} packs listed.</p>}
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
  const tabs = TABS.filter((x) => x.key === 'overview' ? !!VAULT && !!MANAGER_FACTORY : x.key === 'vault' ? !!VAULT : !!MANAGER_FACTORY);
  return (
    <>
      {tabs.length > 1 && (
        <nav className="tabs sub" aria-label="Main pool">
          {tabs.map((x) => <button key={x.key} aria-current={t === x.key ? 'page' : undefined} onClick={() => setTab(x.key)}>{x.label}</button>)}
        </nav>
      )}
      {t === 'overview' && <Compare v={vault.data} hasManager={!!managers.data?.managers.length} setTab={setTab} />}
      {t === 'vault' && (MAIN_POOL_INTERACTIVE ? <VaultPage vault={vault} me={me} />
        : <Soon title="Shared vault" lead="Deposit ETH with other holders. The vault builds Shape packs, lists them on FWA's main pool, and you own a share of everything it holds." />)}
      {t === 'manager' && (MAIN_MANAGER_INTERACTIVE ? <ManagerTab me={me} managers={managers} />
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
  ['In and out', 'Priced at an eligible quiet-window checkpoint.', 'Idle ETH any time. Listed packs return through exit mode.'],
];

function Compare({ v, hasManager, setTab }: { v?: Vault; hasManager: boolean; setTab: (t: MainTab) => void }) {
  const pub = usePublicClient();
  const preview = usePolled(pub && MANAGER_FACTORY ? `manager-preview:${pub.chain.id}:${MANAGER_FACTORY}:${MANAGER_PARAMS.acceptedMintFee}` : undefined, () => previewManager(pub!, MANAGER_FACTORY!, MANAGER_PARAMS));
  const onePack = preview.data === undefined ? '–' : ethText(preview.data.openingCash, 3);
  const rows: [string, string, string][] = [
    ...COMPARE,
    ['Initial capital', 'Any deposit above the account minimum.', `Funding estimate: ${onePack} ETH for one pack, maintenance reserve and renewal float. Listing is conditional.`],
    ['Cost', v === undefined ? '–' : v.requestCharge > 0n ? `${ethText(v.requestCharge, 5)} ETH per deposit or redemption. No vault fee.` : 'Checkpoint already funded. No vault fee.',
      'Creation gas. No factory fee.'],
    ['Ownership', 'You own vault shares.', 'You own the manager and its settings.'],
  ];
  const head = (k: 'vault' | 'manager') => (k === 'vault'
    ? <><h2>Shared vault</h2><p>Deposit with other holders and own a share of everything the vault holds.</p>{MAIN_POOL_INTERACTIVE ? <button className="btn big" onClick={() => setTab('vault')}>Deposit ETH</button> : <button className="btn big" disabled>Coming soon</button>}</>
    : <><h2>Personal manager</h2><p>Create your own account that runs the same strategy with only your ETH.</p>{MAIN_MANAGER_INTERACTIVE ? <button className="btn sec big" onClick={() => setTab('manager')}>{hasManager ? 'Open your manager' : 'Create a manager'}</button> : <button className="btn sec big" disabled>Coming soon</button>}</>);
  return (
    <main className="page mp-overview">
      <div className="intro">
        <h1 className="title">Earn on FWA's main pool</h1>
        <p className="lead">Your ETH builds 0.03 ETH Shape packs and lists them on the main pool with ETH backing. When a buyer keeps a pack, the backing comes back and a new pack is built. Returned packs follow the account's renewal mode: fresh paid replacement or reuse.</p>
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
  const value = parse(amount);
  const busy = !!tx.busy;

  // Deposit: ETH in, shares out at the next checkpoint. Redeem: shares in, ETH to claim after it.
  const fee = mode === 'deposit' ? v.requestCharge : value === undefined ? v.requestCharge : redeemCharge(value, v);
  const net = value !== undefined && value > v.requestCharge ? value - v.requestCharge : 0n;
  const building = (net * v.deployCharge) / (v.referencePositionValue + v.deployCharge);
  const disabled = !me ? undefined
    : !value ? 'Enter an amount'
    : mode === 'deposit' ? (v.depositsPaused || v.windingDown ? 'Deposits are paused'
      : value < v.params.minDeposit + v.requestCharge ? 'Below the minimum deposit'
      : v.lastNav + v.pendingDepositTotal + value - v.requestCharge > v.params.tvlCap ? "Above the vault's deposit limit"
      : h && value > h.wallet ? `Your wallet has ${eth(h.wallet)} ETH` : undefined)
    : h && value > h.shares ? `You have ${shares3(h.shares)} shares` : undefined;
  const label = disabled ?? (mode === 'deposit' ? `Deposit ${amount} ETH` : `Redeem ${amount} shares`);
  const submit = () => {
    if (!value) return;
    const step = mode === 'deposit'
      ? () => tx.write({ ...V, functionName: 'deposit', args: [v.configHash], value })
      : () => tx.write({ ...V, functionName: 'requestRedeem', args: [value, v.configHash], value: redeemCharge(value, v) });
    tx.send(label, [step]).then((ok) => ok && setAmount(''));
  };
  const cancel = () => tx.send('Cancel deposit', [() => tx.write({ ...V, functionName: 'cancelDeposit' })]);
  const claim = () => tx.send('Claim', [() => tx.write({ ...V, functionName: 'claim' })]);
  const parts = [['Shapes in packs', v.book.tracked], ['Backing posted on FWA', v.book.backing], [v.book.navCurrent ? 'FWA fees not yet collected' : 'Known FWA credit; active fees unpriced', v.book.fees], ['Free cash', v.book.freeEth]] as const;

  return (
    <>
      <StatusBar {...st} link={{ href: etherscan(VAULT), label: 'Vault on Etherscan ↗' }} />
      <RenewalStatus account={v} />
      {error && <p className="txline bad">{error}</p>}
      <main className="page cols design mp">
        <section>
          <h1 className="title">Shared vault</h1>
          <p className="lead">Deposit ETH with other holders. The vault builds Shape packs, lists them on FWA's main pool, and you own a share of everything it holds.</p>
          <button className="disclose" style={{ marginTop: 14 }} aria-expanded={how} onClick={() => setHow(!how)}>How the vault works {how ? '▴' : '▾'}</button>
          {how && (
            <ol className="how">
              <li>Deposits and redemptions wait for the next checkpoint, which runs at most once per 12-hour interval in an eligible quiet window.</li>
              <li>Gross escrow can be cancelled until pricing. Unused checkpoint sponsorship is refunded separately after its era closes.</li>
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
          <Group title="Where the vault's ETH is" desc={`${eth(v.book.nav, 2)} ETH of ${v.book.navCurrent ? 'current book value' : 'booked principal; NAV pending maintenance'}. ${v.book.listed} packs listed. Fresh launch packs contain three paid 0.01 ETH Shapes.`}>
            <div className="group-body tight">
              <div className="hiw-bar" role="img" aria-label={parts.map(([l, x]) => `${l} ${eth(x, 2)} ETH`).join(', ')}>
                {parts.map(([l, x], i) => <span key={l} style={{ flexGrow: Number(formatEther(x)), background: BAR[i] }} />)}
              </div>
              <div className="kvs">
                {parts.map(([l, x], i) => <div className="kv" key={l}><span className="sw" style={{ background: BAR[i] }} /><span className="k">{l}</span><span>{eth(x, 2)} ETH</span></div>)}
                <div className="kv"><span className="k">Recovery packs awaiting incremental redemption</span><span>{v.book.recovery}</span></div>
              </div>
              <p className="note">Held apart for holders, not counted above: {eth(v.pendingDepositTotal, 2)} ETH in deposits waiting for pricing, {eth(v.claims, 2)} ETH in claims.</p>
            </div>
          </Group>
          {me && v.requestCharge > 0n && (v.pendingDepositTotal > 0n || v.lockedShares > 0n) && <Group title="Required checkpoint funding"><div className="group-body">
            <div className="kv"><span className="k">Current sponsorship topup</span><span>{ethText(v.requestCharge, 6)} ETH</span></div>
            <p className="note">Unused sponsorship is claimable by its payer after the era closes.</p>
            <button className="btn sec" disabled={busy} onClick={() => tx.send('Fund required checkpoint', [() => tx.write({ address: V.address, abi: packVaultAbi, functionName: 'fundCheckpoint', args: [v.configHash], value: v.requestCharge })])}>Contribute {ethText(v.requestCharge, 6)} ETH</button>
          </div></Group>}
          {me && <><CheckpointContributions key={`refunds:${VAULT}:${me}`} vault={VAULT} payer={me} refresh={refresh} />
            <CallerFundedExit key={`exit:${VAULT}:${me}`} vault={VAULT} holder={me} refresh={refresh} /></>}
          <MainPoolSettings key={VAULT} address={VAULT} vault params={v.params} configHash={v.configHash} mintFee={v.mintFee} tx={tx} enabled={me?.toLowerCase() === v.owner.toLowerCase()} />
        </section>

        <section className="sticky results">
          <div>
            <span className="soft" style={{ fontSize: 15 }}>One share is worth</span>
            <div className="pay"><span className="figure">{Number(formatEther(v.pricePerShare)).toFixed(4)}</span><span className="unit">ETH</span></div>
            <p className="note">{!v.historyComplete && v.epoch > 0n ? 'At the last checkpoint. History loading.' : v.lastCheckpoint ? `At the last checkpoint, ${ago(v.now - v.lastCheckpoint.at)}.` : 'At the seed price. No checkpoint yet.'}</p>
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
              <div className="kv"><span className="k">Estimated construction allowance at commitment</span><span>{ethText(building, 6)} ETH</span></div>
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
              <div className="kv"><span className="k">Open listings</span><span>{v.book.openCount.toString()}</span></div>
              <div className="kv"><span className="k">Recovery packs awaiting bounded redemption</span><span>{v.book.recovery}</span></div>
              <div className="kv"><span className="k">Allocated exposure</span><span>{eth(v.book.allocated, 4)} ETH</span></div>
              <div className="kv"><span className="k">Last checkpoint block</span><span>{!v.historyComplete ? 'History loading' : v.lastCheckpoint ? v.lastCheckpoint.block.toString() : 'None yet'}</span></div>
              <div className="kv"><span className="k">Next checkpoint window</span><span>{nextWindow(v)}</span></div>
              <div className="kv"><span className="k">Actual primary mint fees paid</span><span>{v.historyComplete ? `${eth(v.actualMintFees, 6)} ETH` : 'History loading'}</span></div>
              <div className="kv"><span className="k">Keeper pay since the last checkpoint</span><span>{v.historyComplete ? `${eth(v.keeperPaySince, 5)} ETH` : 'History loading'}</span></div>
              <div className="kv"><span className="k">Token rewards claimed and burned</span><span>{v.historyComplete ? `${eth(v.tokensBurned, 2)} FWA · valued at 0` : 'History loading'}</span></div>
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

function ManagerTab({ me, managers }: { me?: Address; managers: ReturnType<typeof useManagers> }) {
  const pub = usePublicClient();
  const wallet = usePolled<bigint>(pub && me ? `manager-wallet:${pub.chain.id}:${me}` : undefined, () => pub!.getBalance({ address: me! }));
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
  const created = () => { setRecord(loadManagerCreation()); managers.refresh(); wallet.refresh(); };

  if (me && !managers.data) return <p className={`txline${managers.error ? ' bad' : ''}`}>{managers.error ?? 'Looking for your managers…'}</p>;
  if (mine) return <CreationView record={mine} state={creation} onDiscard={() => { clearManagerCreation(); setRecord(undefined); setCreation(undefined); }} />;
  const selected = list[Math.min(index, list.length - 1)];
  if (!me || !selected) return <CreateManager wallet={wallet.data} me={me} onCreated={created} />;
  return <ManagerPage key={selected} manager={selected} wallet={wallet.data} refreshWallet={wallet.refresh} me={me} count={list.length} index={list.indexOf(selected)} setIndex={setIndex} />;
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
const loadAmount = () => { try { return (JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as { amount?: string } | null)?.amount ?? '1.00'; } catch { return '1.00'; } };

function CreateManager({ wallet, me, onCreated }: { wallet?: bigint; me?: Address; onCreated: () => void }) {
  const pub = usePublicClient();
  const tx = useTx(() => undefined);
  const [params, setParams] = useState(MANAGER_PARAMS);
  const [amount, setAmountState] = useState(loadAmount);
  const setAmount = (a: string) => { setAmountState(a); try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ amount: a })); } catch { /* storage unavailable */ } };
  const value = parse(amount);
  const preview = usePolled(pub && MANAGER_FACTORY ? `manager-preview:${pub.chain.id}:${MANAGER_FACTORY}:${params.acceptedMintFee}` : undefined, () => previewManager(pub!, MANAGER_FACTORY!, params));
  const quoted = preview.data;
  const cost = quoted ? quoted.openingCash - params.reserve - quoted.floatRequired : undefined;
  const threshold = quoted?.openingCash;
  const packs = cost !== undefined && value !== undefined ? packsFor(value, params.reserve + (quoted?.floatRequired ?? 0n), cost) : undefined;
  const disabled = !quoted ? preview.error ?? 'Current costs are unavailable'
    : quoted.mintFee > params.acceptedMintFee ? 'Accept the current mint fee first'
    : !value ? 'Enter an amount'
    : value < threshold! ? `At least ${ethText(threshold!, 2)} ETH for this funding estimate`
    : me && wallet === undefined ? 'Wallet balance unavailable' : wallet !== undefined && value > wallet ? `Your wallet has ${eth(wallet)} ETH` : undefined;
  const run = async () => {
    if (!pub || !me || !value || disabled || !MANAGER_FACTORY || !quoted) return;
    const record: ManagerCreation = { chainId: chain.id, factory: MANAGER_FACTORY, owner: me, value: String(value),
      fromBlock: String(await pub.getBlockNumber()), since: Date.now() };
    const ok = await tx.send('Create manager', [['Create manager', async () => {
      let hash;
      try {
        // Saved before the wallet opens, so a reload during or after signing resumes this creation.
        hash = await tx.write({ address: MANAGER_FACTORY!, abi: packManagerFactoryAbi, functionName: 'create', args: [me, params, quoted.configHash], value },
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
          <p className="note">Provisional local candidate: 0.03 ETH packs, 70,000 bps backing, fresh paid replacements, one renewal float, 25 bps uplift limit.</p>
          {quoted && <Group title="Conditional opening funding estimate"><div className="group-body">
            <div className="kv"><span className="k">Shapes principal per pack</span><span>{ethText(quoted.principal)} ETH</span></div>
            <div className="kv"><span className="k">FWA backing per pack</span><span>{ethText(quoted.backing)} ETH</span></div>
            <div className="kv"><span className="k">Fresh mint fees per pack</span><span>{ethText(quoted.mintCost)} ETH</span></div>
            <div className="kv"><span className="k">Renewal float</span><span>{ethText(quoted.floatRequired)} ETH</span></div>
            <div className="kv"><span className="k">Maintenance reserve</span><span>{ethText(params.reserve)} ETH</span></div>
            <div className="kv"><span className="k">Live / accepted mint fee per Shape</span><span>{ethText(quoted.mintFee)} / {ethText(params.acceptedMintFee)} ETH</span></div>
            <p className="note">Funding estimate includes quoted initial keeper work. FWA admission and live economics are checked on the created manager. Creation starts idle; wallet creation gas is additional.</p>
            {quoted.mintFee !== params.acceptedMintFee && <button className="btn sec" onClick={() => setParams((p) => ({ ...p, acceptedMintFee: quoted.mintFee }))}>Use {ethText(quoted.mintFee, 6)} ETH as this manager's accepted mint fee maximum</button>}
          </div></Group>}
          <Group title="Before you start">
            <div className="rows">
              <div><div><h3 className="ctl">About {threshold === undefined ? '–' : ethText(threshold, 2)} ETH funds this one-pack estimate</h3><p>With few packs, individual acquisition outcomes have a large effect. Returns are not guaranteed.</p></div></div>
            </div>
          </Group>
        </section>
        <section className="sticky results">
          <Amount label="Fund it with" value={amount} onChange={setAmount} unit="ETH" />
          <div className="kvs">
            <div className="kv"><span className="k">Estimated packs if admitted</span><span>{packs === undefined ? '–' : packs.toString()}</span></div>
            <div className="kv"><span className="k">To create</span><span>Creation gas varies</span></div>
            <div className="kv"><span className="k">Fee</span><span>None</span></div>
          </div>
          <div className="pin">
            {!me ? <Connect className="btn lg" />
              : <button className="btn lg" disabled={!!tx.busy || !!disabled} onClick={run}>{tx.busy ? `${tx.busy}…` : disabled ?? `Create idle manager with ${amount} ETH`}</button>}
            <TxHelper tx={tx}>One confirmation.</TxHelper>
          </div>
        </section>
      </main>
    </>
  );
}

function ManagerPage({ manager, wallet, refreshWallet, me, count, index, setIndex }: { manager: Address; wallet?: bigint; refreshWallet: () => void; me: Address; count: number; index: number; setIndex: (i: number) => void }) {
  const { data: m, error, refresh } = useManager(manager);
  const changed = () => { refresh(); refreshWallet(); };
  const tx = useTx(changed);
  const [mode, setMode] = useState<'add' | 'withdraw'>();
  const [amount, setAmount] = useState('');
  const [numbers, setNumbers] = useState(false);
  if (!m) return <p className={`txline${error ? ' bad' : ''}`}>{error ?? 'Loading your manager…'}</p>;
  const M = { address: manager, abi: packManagerAbi } as const;
  // Each manager prices its own recipe and work under its own configuration.
  const cost = m.edge[2] ? packCost(m.packValue, m.edge[1], m.buildCost) : undefined;
  const st = managerStatus(m, cost);
  const seg = mode ?? (m.book.listed === 0 ? 'add' : 'withdraw');
  const value = parse(amount);
  const busy = !!tx.busy;
  const owner = m.owner.toLowerCase() === me.toLowerCase();
  const disabled = !owner ? 'Only the owner can do this' : !value ? 'Enter an amount'
    : seg === 'withdraw' && value > m.balance ? `${eth(m.balance)} ETH is available`
    : seg === 'add' && wallet === undefined ? 'Wallet balance unavailable' : seg === 'add' && wallet !== undefined && value > wallet ? `Your wallet has ${eth(wallet)} ETH` : undefined;
  const label = disabled ?? (seg === 'withdraw' ? `Withdraw ${amount} ETH` : `Add ${amount} ETH`);
  const submit = () => {
    if (!value) return;
    tx.send(label, [seg === 'withdraw' ? () => tx.write({ ...M, functionName: 'withdraw', args: [me, value] }) : () => tx.transfer(manager, value)])
      .then((ok) => ok && setAmount(''));
  };
  const control = (name: string, fn: string, args: unknown[]) => tx.send(name, [() => tx.write({ ...M, functionName: fn, args } as never)]);
  const squares: CSSProperties[] = [
    ...Array<CSSProperties>(Math.min(64, m.book.listed)).fill({ background: '#fff' }),
    ...Array<CSSProperties>(Math.min(64, m.book.bought)).fill({ outline: '2px dashed #fff', outlineOffset: -2 }),
    ...Array<CSSProperties>(Math.min(64, m.book.idle)).fill({ background: '#333' }),
  ];
  const canList = cost === undefined ? undefined : packsFor(m.balance + (value ?? 0n), m.operatingReserve, cost);
  const budget = (cap: bigint, rate: bigint, now: bigint) => `${eth(now, 4)} of ${eth(cap, 3)} ETH · ${eth(rate, 3)} ETH a day`;
  return (
    <>
      <StatusBar head={st.head} body={st.body} link={{ href: etherscan(manager), label: 'Manager on Etherscan ↗' }} />
      <RenewalStatus account={m} />
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
          <Group title="Packs" desc={`Selected fresh recipe: ${ethText(m.packValue, 2)} ETH, ${m.mintCount} paid primary mints.${m.edge[2] ? ` New backing: ${ethText(m.edge[1], 4)} ETH.` : ''} Existing packs retain their contents.`}>
            <div className="group-body tight">
              {squares.length > 0 ? <div className="packs" aria-hidden="true">{squares.map((s, i) => <span key={i} style={s} />)}</div> : <p className="note">{m.book.recovery > 0 ? 'Recovery inventory awaits incremental redemption.' : "No packs yet. Keepers build them from the manager's ETH."}</p>}
              <div className="legend row-legend">
                {m.book.listed > 0 && <div><span className="sw" style={{ background: '#fff' }} />Listed {m.book.listed}</div>}
                {m.book.bought > 0 && <div><span className="sw" style={{ border: '1px dashed #fff' }} />Bought, waiting on keep or bid {m.book.bought}</div>}
                {m.book.idle > 0 && <div><span className="sw" style={{ background: '#333' }} />Idle {m.book.idle}</div>}
                {m.book.recovery > 0 && <div>Recovery packs {m.book.recovery}</div>}
              </div>
              <div className="kvs">
                <div className="kv"><span className="k">Keep receipts recorded</span><span>{m.historyComplete ? m.recordedKeeps : 'History loading'}</span></div>
                <div className="kv"><span className="k">Other resolved selections</span><span>{m.historyComplete ? m.otherResolved : 'History loading'}</span></div>
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
                <div><h3 className="ctl">Exit mode</h3><p className="h">{m.exiting ? 'New investment is stopped. Review each owner-paid closeout step below.' : 'Complete closeout below stops investment first. Exit work is not automatic.'}</p></div>
                {m.exiting
                  ? <button className="btn sec" disabled={busy || !owner} onClick={() => control('Leave exit mode', 'setExiting', [false])}>Leave exit mode</button>
                  : <a className="link" href={`#manager-exit-${manager}`} onClick={(event) => { event.preventDefault(); document.getElementById(`manager-exit-${manager}`)?.scrollIntoView(); }}>Review closeout below</a>}
              </div>
              <div>
                <div><h3 className="ctl">Withdraw idle packs</h3><p className="h">Takes unlisted packs to your wallet.{m.book.idle === 0 ? ' None are idle now.' : ''}</p></div>
                <button className="btn sec" disabled={busy || !owner || m.book.idle === 0} onClick={() => control('Withdraw packs', 'withdrawPacks', [me, BigInt(Math.min(16, m.book.idle))])}>Withdraw up to 16 packs</button>
              </div>
            </div>
          </Group>
          <CallerFundedExit manager vault={manager} holder={me} refresh={changed} enabled={owner} />
          <MainPoolSettings key={manager} address={manager} params={m.params} configHash={m.configHash} mintFee={m.mintFee} tx={tx} enabled={owner} />
        </section>
        <section className="sticky results">
          <div>
            <span className="soft" style={{ fontSize: 15 }}>{m.book.navCurrent ? 'Value' : 'Booked principal; NAV pending maintenance'}</span>
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
              <div className="kv"><span className="k">Backing on FWA</span><span>{eth(m.book.inListed)} ETH</span></div>
              {m.book.inBought > 0n && <div className="kv"><span className="k">Allocated Shapes</span><span>{eth(m.book.inBought)} ETH</span></div>}
            </> : <>
              <div className="kv"><span className="k">Packs it can list</span><span>{canList === undefined ? '–' : canList.toString()}</span></div>
              <div className="kv"><span className="k">Reserve kept</span><span>{eth(m.params.reserve)} ETH</span></div>
            </>}
          </div>
          <div className="pin">
            <button className="btn lg" disabled={busy || !!disabled} onClick={submit}>{tx.busy ? `${tx.busy}…` : label}</button>
            <TxHelper tx={tx}>{seg === 'withdraw' ? 'For listed or recovery packs, use the owner-paid closeout below.' : undefined}</TxHelper>
          </div>
          <button className="disclose" aria-expanded={numbers} onClick={() => setNumbers(!numbers)}>All numbers {numbers ? '▴' : '▾'}</button>
          {numbers && (
            <div className="kvs">
              <div className="kv"><span className="k">Reserve</span><span>{eth(m.params.reserve, 4)} ETH</span></div>
              <div className="kv"><span className="k">Actual primary mint fees paid</span><span>{m.historyComplete ? `${eth(m.actualMintFees, 6)} ETH` : 'History loading'}</span></div>
              <div className="kv"><span className="k">Routine keeper budget</span><span>{budget(m.params.routineCap, m.params.routineRate, m.budget[0])}</span></div>
              <div className="kv"><span className="k">Essential keeper budget</span><span>{budget(m.params.essentialCap, m.params.essentialRate, m.budget[1])}</span></div>
              <div className="kv"><span className="k">Gas ceiling</span><span>{(Number(m.params.gasCeiling) / 1e9).toFixed(2)} gwei</span></div>
              <div className="kv"><span className="k">Min edge</span><span>{(m.params.minEdgeBps / 100).toFixed(2)}%</span></div>
              <div className="kv"><span className="k">Shapes mint fee now</span><span>{eth(m.mintFee, 4)} ETH a Shape</span></div>
              <div className="kv"><span className="k">Keeper pay to date</span><span>{m.historyComplete ? `${eth(m.keeperPay, 5)} ETH` : 'History loading'}</span></div>
              <div className="kv"><span className="k">Withdrawn to date</span><span>{m.historyComplete ? `${eth(m.withdrawn, 4)} ETH` : 'History loading'}</span></div>
              <div className="kv"><span className="k">Token rewards claimed and burned</span><span>{m.historyComplete ? `${eth(m.tokensBurned, 2)} FWA · valued at 0` : 'History loading'}</span></div>
            </div>
          )}
        </section>
      </main>
    </>
  );
}


function RenewalStatus({ account }: { account: Pick<Manager, 'params' | 'mintFee' | 'renewalState' | 'budget' | 'operatingReserve' | 'minimumRenewalQuote' | 'renewalCashRequired' | 'renewalInventoryReady' | 'mintCount' | 'packValue' | 'keeperCash' | 'edge'> }) {
  const [returned, kept, float, cash] = account.renewalState;
  const waits = renewalWaits(account);
  return <div className="group-body main-renewal-state" role="status">
    <div className="kv"><span className="k">Selected fresh pack value / primary mints</span><span>{eth(account.packValue, 2)} ETH / {account.mintCount.toString()}</span></div>
    <div className="kv"><span className="k">Live / accepted mint fee per Shape</span><span>{eth(account.mintFee, 6)} / {eth(account.params.acceptedMintFee, 6)} ETH</span></div>
    <div className="kv"><span className="k">Renewal</span><span>{account.params.renewalMode === 0 ? 'Fresh after acquisition; every fresh Shape pays a mint fee' : 'Reuse returned packs'}</span></div>
    <div className="kv"><span className="k">Eligible returned / kept replacements</span><span>{returned.toString()} / {kept.toString()}</span></div>
    <div className="kv"><span className="k">Maintenance reserve / renewal float</span><span>{eth(account.params.reserve, 5)} / {eth(float, 5)} ETH</span></div>
    <div className="kv"><span className="k">Renewal cash available</span><span>{eth(cash, 5)} ETH</span></div>
    <div className="kv"><span className="k">Routine cash / spending permission</span><span>{eth(account.keeperCash, 5)} / {eth(account.budget[0], 5)} ETH</span></div>
    {waits.feeNotAccepted && <p className="note error">Fresh minting waits: the live mint fee exceeds the accepted maximum.</p>}
    {account.params.packUnitsMask === 0n && <p className="note">Fresh minting is disabled. Existing unselected inventory may still be relisted.</p>}
    {returned > 0n && !account.renewalInventoryReady && <p className="note">Eligible return needs recovery or bounded inventory discovery.</p>}
    {!account.edge[2] && <p className="note">New listing admission is currently unavailable.</p>}
    {account.minimumRenewalQuote > 0n && <div className="kv"><span className="k">Quoted renewal work before fee collection</span><span>{eth(account.minimumRenewalQuote, 6)} ETH</span></div>}
    {waits.cashShort && <p className="note error">Renewal needs cash or eligible fee collection. Raising spending permission adds no ETH.</p>}
    {waits.allowanceTooSmall && <p className="note error">Renewal waits for spending permission. The allowance cannot cover the quoted renewal work.</p>}
  </div>;
}
