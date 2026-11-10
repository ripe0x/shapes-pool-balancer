import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, useConnect, useDisconnect, usePublicClient, useWriteContract } from 'wagmi';
import { BaseError, ContractFunctionRevertedError, formatEther, keccak256, parseAbi, parseAbiItem, parseEther, toBytes, type Address, type Hash } from 'viem';
import { normalize } from 'viem/ens';
import { balancerFactoryAbi, erc721Abi, fwaPoolAbi, poolBalancerAbi, shapesAbi } from '../../shared/abi';
import {
  DENOM_LABELS, DENOMS, MAX_KEEPER_REWARD, MAX_PLANS, MAX_SHAPES_PER_PLAN, capitalOf, economics, enumeratePlans, evaluate, packPlan, unpackPlan, type Counts,
} from '../../shared/planner';
import { chain, ETHERSCAN, FACTORY, FROM_BLOCK, FWA_POOL_URL } from './chain';

const SHAPES: Address = '0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0';
const FWA_FACTORY: Address = '0x8919814D825a5Af238cC04DE06b1C18c9eaA477C';
const fwaFactoryAbi = parseAbi(['function edgeBps() view returns (uint16)', 'function poolCreationEnabled() view returns (bool)', 'function implementation() view returns (address)']);
const CREATED = parseAbiItem('event BalancerCreated(address indexed creator, address indexed balancer, address indexed pool, bytes32 salt)');
const DRAWN = parseAbiItem('event ItemDrawn(uint256 indexed listingId, uint8 kind, uint8 denom, bool delivered)');
const L_DELIVERY_REFUNDED = 7;

export const STATUS: Record<number, string> = {
  0: 'Open: purchases admitted',
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

const fmt = (wei: bigint | undefined, d = 4) => (wei === undefined ? '-' : Number(formatEther(wei)).toFixed(d));
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
    const [fee, proceeds, totalWeight, retired, unsettled, mintFee, edgeBps] = await Promise.all([
      p<bigint>('acquisitionFee'), p<bigint>('ownerProceeds'), p<bigint>('totalWeight'), p<boolean>('retired'),
      p<bigint>('unsettledAcquisitionCount'),
      pub.readContract({ address: SHAPES, abi: shapesAbi, functionName: 'mintFee' }) as Promise<bigint>,
      pub.readContract({ address: FWA_FACTORY, abi: fwaFactoryAbi, functionName: 'edgeBps' }) as Promise<number>,
    ]);
    const listing = async (id: bigint): Promise<Listing> => {
      const [it, l] = await Promise.all([r<readonly [number, number, number, bigint, bigint]>('items', [id]), p<readonly [Address, Address, Address, bigint, bigint, bigint, bigint, number]>('listings', [id])]);
      return { id, kind: it[0], denom: it[1], state: it[2], base: it[3], price: it[4], collection: l[0], tokenId: l[3], weight: l[7] === 1 ? l[4] : 0n, fwaStatus: l[7] };
    };
    const listings = await Promise.all(activeIds.map(listing));
    const pending = (await Promise.all(failedIds.map(listing))).filter((l) => l.state === 2);
    return {
      balancer: b, pool, creator, pendingCreator, enabled, repricing, lastStatus, admission, upkeep, required, surplus, balance, plans, activePlan,
      config: { maxDrawPrice: config[0], minCuratedOddsBps: config[1], markupBps: config[2] },
      checkpoint: { valid: checkpoint[0], reserve: checkpoint[4] },
      activeShapes: activeShapes.map(Number),
      fee, proceeds, totalWeight, retired, unsettled, mintFee, edgeBps, listings, pending,
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
  // Simulate before sending so a revert is reported by name, whatever the wallet does with estimation.
  const write = (async (params: Record<string, unknown>) => {
    await pub!.simulateContract({ ...params, account: address } as never);
    return writeContractAsync(params as never);
  }) as typeof writeContractAsync;
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
    } catch (e) {
      setMsg({ ok: false, text: `${label}: ${explain(e)}` });
    } finally {
      setBusy(undefined);
      onDone();
    }
  };
  return { send, busy, msg, write };
}

export function App() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const pub = usePublicClient();
  const [mine, setMine] = useState<Address[]>([]);
  const [selected, setSelected] = useState<Address>();
  const [prereq, setPrereq] = useState<{ creation: boolean; impl: boolean }>();

  const loadMine = useCallback(async () => {
    if (!pub || !address || !FACTORY) return;
    const logs = await pub.getLogs({ address: FACTORY, event: CREATED, args: { creator: address }, fromBlock: FROM_BLOCK });
    const list = logs.map((l) => l.args.balancer!);
    setMine(list);
    if (!selected && list.length) setSelected(list[list.length - 1]);
  }, [pub, address, selected]);
  useEffect(() => { loadMine().catch(() => undefined); }, [loadMine]);
  useEffect(() => {
    if (!pub) return;
    Promise.all([
      pub.readContract({ address: FWA_FACTORY, abi: fwaFactoryAbi, functionName: 'poolCreationEnabled' }),
      pub.readContract({ address: FWA_FACTORY, abi: fwaFactoryAbi, functionName: 'implementation' }),
    ]).then(([c, i]) => setPrereq({ creation: c as boolean, impl: (i as string).toLowerCase() === '0x85faf92967705dc45535ebca74d6333f6bcbfee7' })).catch(() => undefined);
  }, [pub]);

  return (
    <div className="page">
      <header>
        <div>
          <h1>Shapes Pool Balancer</h1>
          <p className="muted">Creator console. Players buy on FWA directly.</p>
        </div>
        {isConnected ? (
          <div className="row">
            <span className="mono">{short(address!)}</span>
            <button className="ghost" onClick={() => disconnect()}>Disconnect</button>
          </div>
        ) : (
          <div className="row">
            {connectors.map((c) => (
              <button key={c.uid} className={c.type === 'mock' ? 'ghost' : ''} onClick={() => connect({ connector: c, chainId: chain.id })}>
                {c.type === 'mock' ? 'Local dev account' : 'Connect wallet'}
              </button>
            ))}
          </div>
        )}
      </header>
      {!FACTORY && <div className="card warn">VITE_FACTORY is not set. See app/.env.example.</div>}
      {isConnected && (
        <>
          <Create prereq={prereq} onCreated={() => loadMine()} />
          {mine.length > 0 && (
            <div className="card">
              <h2>Your Balancers</h2>
              <div className="row wrap">
                {mine.map((b) => (
                  <button key={b} className={b === selected ? '' : 'ghost'} onClick={() => setSelected(b)}>{short(b)}</button>
                ))}
              </div>
            </div>
          )}
          {selected && <Dashboard balancer={selected} me={address!} />}
        </>
      )}
    </div>
  );
}

function Create({ prereq, onCreated }: { prereq?: { creation: boolean; impl: boolean }; onCreated: () => void }) {
  const [deposit, setDeposit] = useState('1');
  const { send, busy, msg, write } = useTx(onCreated);
  const salt = useMemo(() => `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, '0')).join('')}` as `0x${string}`, []);
  return (
    <div className="card">
      <h2>Create a pool</h2>
      <p className="muted">Deploys your Balancer, which creates and permanently owns a new FWA standard pool. The Balancer address is the pool owner FWA shows.</p>
      <ul className="checks">
        <li className={prereq?.creation ? 'ok' : 'bad'}>FWA pool creation {prereq?.creation ? 'enabled' : 'disabled'}</li>
        <li className={prereq?.impl ? 'ok' : 'bad'}>FWA implementation {prereq?.impl ? 'is the reviewed one' : 'changed: creation will revert'}</li>
      </ul>
      <div className="row">
        <label>Initial ETH deposit <input value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" /></label>
        <button disabled={!!busy || !prereq?.creation || !prereq?.impl} onClick={() => send('Create Balancer', [() => write({ address: FACTORY, abi: balancerFactoryAbi, functionName: 'createBalancer', args: [salt], value: parseEther(deposit || '0') })])}>
          {busy ?? 'Create'}
        </button>
      </div>
      {msg && <p className={msg.ok ? 'okText' : 'badText'}>{msg.text}</p>}
    </div>
  );
}

/** Shapes mint gas varies with each block's seed, so add headroom to the node's estimate. */
async function upkeepGas(pub: ReturnType<typeof usePublicClient>, balancer: Address, from: Address) {
  const est = await pub!.estimateContractGas({ address: balancer, abi: poolBalancerAbi, functionName: 'performUpkeep', account: from });
  return (est * 13n) / 10n;
}

function Dashboard({ balancer, me }: { balancer: Address; me: Address }) {
  const pub = usePublicClient();
  const { data: d, error, refresh } = useBalancer(balancer);
  const tx = useTx(refresh);
  if (error) return <div className="card warn">{error}</div>;
  if (!d) return <div className="card">Loading…</div>;
  const isCreator = d.creator.toLowerCase() === me.toLowerCase();
  const B = { address: balancer, abi: poolBalancerAbi } as const;
  const w = tx.write;
  const plan = d.plans.length ? unpackPlan(d.plans[d.activePlan]) : Array(9).fill(0);
  return (
    <>
      <div className="card">
        <div className="row spread">
          <h2>Status</h2>
          <a href={FWA_POOL_URL(d.pool)} target="_blank" rel="noreferrer">Open pool on FWA ↗</a>
        </div>
        <p className={d.admission === 0 ? 'okText big' : 'badText big'}>{STATUS[d.admission] ?? `Status ${d.admission}`}</p>
        <div className="grid">
          <Stat label="Balancer" value={<a href={ETHERSCAN(balancer)} target="_blank" rel="noreferrer" className="mono">{short(balancer)}</a>} />
          <Stat label="FWA pool" value={<span className="mono">{short(d.pool)}</span>} />
          <Stat label="Draw price (excl. VRF fee)" value={`${fmt(d.fee, 5)} ETH`} />
          <Stat label="Ceiling" value={`${fmt(d.config.maxDrawPrice, 5)} ETH`} />
          <Stat label="Unsettled FWA purchases" value={d.unsettled.toString()} />
          <Stat label="Upkeep needed" value={d.upkeep.needed ? 'Yes' : 'No'} />
        </div>
        {!isCreator && <p className="muted">You are not this Balancer's creator. Actions are read-only except maintenance.</p>}
        {d.pendingCreator.toLowerCase() === me.toLowerCase() && (
          <button disabled={!!tx.busy} onClick={() => tx.send('Accept creator role', [() => w({ ...B, functionName: 'acceptCreator' })])}>Accept creator role</button>
        )}
        <div className="row wrap">
          <button disabled={!!tx.busy} onClick={() => tx.send('Run upkeep', [async () => w({ ...B, functionName: 'performUpkeep', gas: await upkeepGas(pub!, balancer, me) })])}>Run upkeep</button>
          {isCreator && (d.enabled
            ? <button className="ghost" disabled={!!tx.busy} onClick={() => tx.send('Close purchases', [() => w({ ...B, functionName: 'close' })])}>Close purchases</button>
            : <button disabled={!!tx.busy || d.retired || !d.plans.length} onClick={() => tx.send('Open purchases', [() => w({ ...B, functionName: 'open' })])}>Open purchases</button>)}
        </div>
      </div>
      <div className="toast" role="status" aria-live="polite"><TxMsg tx={tx} /></div>

      <Economics d={d} plan={plan} />
      <Funds d={d} tx={tx} isCreator={isCreator} me={me} />
      <Inventory d={d} plan={plan} />
      <Curated d={d} tx={tx} isCreator={isCreator} me={me} />
      {isCreator && <Configure d={d} tx={tx} />}
      <Ens d={d} tx={tx} isCreator={isCreator} />
      {isCreator && <PoolPage d={d} tx={tx} />}
      {isCreator && <Lifecycle d={d} tx={tx} me={me} />}
    </>
  );
}

type D = NonNullable<ReturnType<typeof useBalancer>['data']>;
type Tx = ReturnType<typeof useTx>;

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div>{value}</div>
    </div>
  );
}

function TxMsg({ tx }: { tx: Tx }) {
  if (tx.busy) return <p className="muted">{tx.busy}…</p>;
  return tx.msg ? <p className={tx.msg.ok ? 'okText' : 'badText'}>{tx.msg.text}</p> : null;
}

const curatedOddsBps = (d: D) => {
  if (!d.totalWeight) return 0;
  const cw = d.listings.filter((l) => l.kind === 1).reduce((s, l) => s + l.weight, 0n);
  return Number((cw * 10_000n) / d.totalWeight);
};

function Economics({ d, plan }: { d: D; plan: Counts }) {
  const [gas, setGas] = useState('0.2');
  const [perDay, setPerDay] = useState('40');
  const bases = d.listings.filter((l) => l.kind === 1).map((l) => l.base);
  const backing = d.activeShapes.reduce((s, n, i) => s + BigInt(n) * DENOMS[i], 0n);
  const funded = d.enabled && d.balance >= d.required;
  const econ = bases.length && plan.some(Boolean)
    ? economics(plan, { curatedBases: bases, markupBps: d.config.markupBps, edgeBps: Number(d.edgeBps), mintFee: d.mintFee }, { gasPriceGwei: Number(gas) || 0, drawsPerUpkeep: 1, safety: 0.25 })
    : undefined;
  const month = econ ? econ.expectedNetPerDraw * (Number(perDay) || 0) * 30 : 0;
  return (
    <div className="card">
      <h2>Economics</h2>
      <div className="row wrap">
        <span className={funded ? 'pill ok' : 'pill bad'}>{funded ? 'Funded' : 'Not funded'}</span>
        {econ && <span className={econ.outlook === 'sustainable' ? 'pill ok' : 'pill bad'}>{econ.outlook === 'sustainable' ? 'Projected sustainable' : 'Projected loss'}</span>}
      </div>
      <p className="muted small">
        Funded: ETH covers the next purchase batch and its maintenance. Projected outcomes come from a model
        with the assumptions below; they are estimates, not guarantees.
      </p>
      <div className="grid">
        <Stat label="Draw price (excl. VRF fee)" value={`${fmt(d.fee, 5)} ETH`} />
        <Stat label="Curated odds" value={pct(curatedOddsBps(d))} />
        <Stat label="Shape backing listed" value={`${fmt(backing, 3)} ETH`} />
        <Stat label="Required reserve" value={`${fmt(d.required)} ETH`} />
        <Stat label="Available surplus" value={`${fmt(d.surplus)} ETH`} />
        <Stat label="Shapes mint fee" value={`${fmt(d.mintFee, 4)} ETH`} />
        {econ && (
          <>
            <Stat label="Maintenance cost / draw" value={`${econ.overheadPerDraw.toFixed(5)} ETH`} />
            <Stat label="Projected minimum markup" value={Number.isFinite(econ.minMarkupBps) ? pct(econ.minMarkupBps) : '-'} />
            <Stat label="Expected net / draw" value={<span className={econ.expectedNetPerDraw < 0 ? 'badText' : ''}>{econ.expectedNetPerDraw.toFixed(5)} ETH</span>} />
            <Stat label="Expected result / 30 days" value={<span className={month < 0 ? 'badText' : ''}>{month.toFixed(4)} ETH</span>} />
          </>
        )}
      </div>
      {econ?.belowModeledMarkup && <p className="badText">Markup {pct(d.config.markupBps)} is below the modeled sustainable level of {pct(econ.minMarkupBps)} at these assumptions.</p>}
      {d.admission !== 0 && <p className="badText">Restriction: {STATUS[d.admission] ?? `status ${d.admission}`}</p>}
      <div className="row wrap">
        <label>Gas assumption (gwei) <input className="narrow" value={gas} onChange={(e) => setGas(e.target.value)} inputMode="decimal" /></label>
        <label>Draws per day <input className="narrow" value={perDay} onChange={(e) => setPerDay(e.target.value)} inputMode="numeric" /></label>
      </div>
    </div>
  );
}

function Funds({ d, tx, isCreator, me }: { d: D; tx: Tx; isCreator: boolean; me: Address }) {
  const [dep, setDep] = useState('0.5');
  const [claim, setClaim] = useState('');
  const B = { address: d.balancer, abi: poolBalancerAbi } as const;
  return (
    <div className="card">
      <h2>Funds</h2>
      <div className="grid">
        <Stat label="Liquid ETH" value={`${fmt(d.balance)} ETH`} />
        <Stat label="Required reserve" value={`${fmt(d.required)} ETH`} />
        <Stat label="Claimable surplus" value={`${fmt(d.surplus)} ETH`} />
        <Stat label="Uncollected FWA proceeds" value={`${fmt(d.proceeds)} ETH`} />
      </div>
      <p className="muted small">The reserve covers restoring the plan, the five most expensive Shape replacements and one maximum keeper reward. Claimable surplus is what the contract will release now; it is not a profit forecast.</p>
      <div className="row wrap">
        <label>Deposit <input value={dep} onChange={(e) => setDep(e.target.value)} inputMode="decimal" /></label>
        <button disabled={!!tx.busy} onClick={() => tx.send('Deposit', [() => tx.write({ ...B, functionName: 'depositETH', value: parseEther(dep || '0') })])}>Deposit</button>
        <button className="ghost" disabled={!!tx.busy || d.proceeds === 0n} onClick={() => tx.send('Collect proceeds', [() => tx.write({ ...B, functionName: 'collectProceeds' })])}>Collect proceeds</button>
      </div>
      {isCreator && (
        <div className="row wrap">
          <label>Claim <input value={claim} placeholder={fmt(d.surplus)} onChange={(e) => setClaim(e.target.value)} inputMode="decimal" /></label>
          <button disabled={!!tx.busy || d.surplus === 0n} onClick={() => tx.send('Claim surplus', [() => tx.write({ ...B, functionName: 'claimSurplus', args: [claim ? parseEther(claim) : d.surplus, me] })])}>Claim to my wallet</button>
        </div>
      )}
    </div>
  );
}

function Inventory({ d, plan }: { d: D; plan: Counts }) {
  return (
    <div className="card">
      <h2>Shapes inventory</h2>
      <p className="muted small">Active plan {d.activePlan + 1} of {d.plans.length || 0}. Shapes are listed at backing × (1 + markup). Shapes above a new plan's target are redeemed for their backing.</p>
      <table>
        <thead><tr><th>Denomination</th><th>Target</th><th>Listed</th><th>Missing</th><th>Backing listed</th></tr></thead>
        <tbody>
          {DENOMS.map((amt, i) => (plan[i] || d.activeShapes[i]) ? (
            <tr key={i}>
              <td>{DENOM_LABELS[i]} ETH</td><td>{plan[i]}</td><td>{d.activeShapes[i]}</td>
              <td className={plan[i] > d.activeShapes[i] ? 'badText' : ''}>{Math.max(0, plan[i] - d.activeShapes[i])}</td>
              <td>{fmt(amt * BigInt(d.activeShapes[i]), 2)}</td>
            </tr>
          ) : null)}
        </tbody>
      </table>
    </div>
  );
}

function Curated({ d, tx, isCreator, me }: { d: D; tx: Tx; isCreator: boolean; me: Address }) {
  const [form, setForm] = useState({ collection: '', tokenId: '', base: '' });
  const [reprice, setReprice] = useState<Record<string, string>>({});
  const B = { address: d.balancer, abi: poolBalancerAbi } as const;
  const curated = d.listings.filter((l) => l.kind === 1 && l.state === 1);
  const [stray, setStray] = useState({ collection: '', tokenId: '' });
  const [restricted, setRestricted] = useState<string>();
  const pub = usePublicClient();
  const list = () => tx.send('Approve and list', [
    () => tx.write({ address: form.collection as Address, abi: erc721Abi, functionName: 'approve', args: [d.balancer, BigInt(form.tokenId)] }),
    () => tx.write({ ...B, functionName: 'listCurated', args: [form.collection as Address, BigInt(form.tokenId), parseEther(form.base)] }),
  ]).then(() => setRestricted(undefined));
  // A collection that refuses transfers to contracts lets a hostile buyer (a contract that never refunds) lock a
  // drawn NFT in FWA escrow. Simulate a transfer from the creator to a contract address before listing.
  const checkAndList = async () => {
    const key = `${form.collection}:${form.tokenId}`;
    if (restricted === key) return list(); // creator confirmed
    const toContract = await pub!.simulateContract({ address: form.collection as Address, abi: erc721Abi, functionName: 'transferFrom', args: [me, SHAPES, BigInt(form.tokenId)], account: me }).then(() => true, () => false);
    const toEoa = await pub!.simulateContract({ address: form.collection as Address, abi: erc721Abi, functionName: 'transferFrom', args: [me, '0x000000000000000000000000000000000000dEaD', BigInt(form.tokenId)], account: me }).then(() => true, () => false);
    if (toEoa && !toContract) { setRestricted(key); return; }
    return list();
  };
  return (
    <div className="card">
      <h2>Curated NFTs</h2>
      <table>
        <thead><tr><th>Listing</th><th>NFT</th><th>Your value</th><th>FWA price</th><th>Odds</th><th></th></tr></thead>
        <tbody>
          {curated.map((l) => (
            <tr key={l.id.toString()}>
              <td>#{l.id.toString()}</td>
              <td className="mono">{short(l.collection)} #{l.tokenId.toString()}</td>
              <td>{fmt(l.base)}</td>
              <td>{fmt(l.price)}</td>
              <td>{d.totalWeight ? pct(Number((l.weight * 10_000n) / d.totalWeight)) : '-'}</td>
              <td>
                {isCreator && (
                  <div className="row">
                    <input className="narrow" aria-label={`New value for listing ${l.id}`} placeholder="new value" value={reprice[l.id.toString()] ?? ''} onChange={(e) => setReprice({ ...reprice, [l.id.toString()]: e.target.value })} />
                    <button className="ghost" disabled={!!tx.busy || !reprice[l.id.toString()]} onClick={() => tx.send('Reprice', [() => tx.write({ ...B, functionName: 'updateCuratedPrice', args: [l.id, parseEther(reprice[l.id.toString()])] })])}>Reprice</button>
                    <button className="ghost" disabled={!!tx.busy} onClick={() => tx.send('Withdraw', [() => tx.write({ ...B, functionName: 'withdrawCurated', args: [l.id, me] })])}>Withdraw</button>
                  </div>
                )}
              </td>
            </tr>
          ))}
          {d.pending.map((l) => {
            const refunded = l.fwaStatus === L_DELIVERY_REFUNDED;
            return (
              <tr key={l.id.toString()}>
                <td>#{l.id.toString()}</td>
                <td className="mono">{l.kind === 2 ? `${DENOM_LABELS[l.denom]} ETH Shape` : `${short(l.collection)} #${l.tokenId.toString()}`}</td>
                <td>{fmt(l.base)}</td>
                <td colSpan={2}>{refunded ? 'Drawn; delivery refunded to the buyer' : 'Drawn; FWA delivery failed, awaiting retry or buyer refund'}</td>
                <td>
                  {refunded && l.kind === 1 && isCreator && <button className="ghost" disabled={!!tx.busy} onClick={() => tx.send('Recover', [() => tx.write({ ...B, functionName: 'recoverCuratedNFT', args: [l.id, me] })])}>Recover</button>}
                  {refunded && l.kind === 2 && <button className="ghost" disabled={!!tx.busy} onClick={() => tx.send('Recover and redeem', [() => tx.write({ ...B, functionName: 'recoverRefundedShape', args: [l.id] })])}>Recover and redeem</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {curated.length === 0 && <p className="muted">No curated NFTs listed. Purchases stay closed until you add one.</p>}
      {isCreator && (
        <div className="row wrap">
          <input aria-label="Collection address" placeholder="Collection 0x…" value={form.collection} onChange={(e) => setForm({ ...form, collection: e.target.value })} />
          <input className="narrow" aria-label="Token ID" placeholder="Token ID" value={form.tokenId} onChange={(e) => setForm({ ...form, tokenId: e.target.value })} />
          <input className="narrow" aria-label="Value (ETH)" placeholder="Value (ETH)" value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })} />
          <button disabled={!!tx.busy || !form.collection || !form.tokenId || !form.base} onClick={checkAndList}>
            {restricted === `${form.collection}:${form.tokenId}` ? 'List anyway' : 'Approve and list'}
          </button>
        </div>
      )}
      {restricted && restricted === `${form.collection}:${form.tokenId}` && (
        <p className="badText">This collection refuses transfers to contracts. A buyer using a contract that never claims its refund could leave this NFT locked in FWA. The risk is highest in pools with few listings.</p>
      )}
      <p className="muted small">The FWA price is your value × (1 + markup). Odds are inversely proportional to price. Listing, repricing and withdrawing need FWA's purchase queue to be idle and reconciled; run upkeep afterwards to reopen.</p>
      {isCreator && (
        <>
          <h3>Return an NFT sent to the Balancer directly</h3>
          <div className="row wrap">
            <input aria-label="Stray NFT collection" placeholder="Collection 0x…" value={stray.collection} onChange={(e) => setStray({ ...stray, collection: e.target.value })} />
            <input className="narrow" aria-label="Stray NFT token ID" placeholder="Token ID" value={stray.tokenId} onChange={(e) => setStray({ ...stray, tokenId: e.target.value })} />
            <button className="ghost" disabled={!!tx.busy || !stray.collection || !stray.tokenId} onClick={() => tx.send('Return NFT', [() => tx.write({ ...B, functionName: 'recoverUntrackedNFT', args: [stray.collection as Address, BigInt(stray.tokenId), me] })])}>Return to my wallet</button>
          </div>
          <p className="muted small">Only NFTs the Balancer holds outside FWA. Listed and drawn NFTs stay in FWA custody.</p>
        </>
      )}
    </div>
  );
}

function Configure({ d, tx }: { d: D; tx: Tx }) {
  const [maxDraw, setMaxDraw] = useState(d.plans.length ? formatEther(d.config.maxDrawPrice) : '0.05');
  const [minOdds, setMinOdds] = useState(d.plans.length ? String(d.config.minCuratedOddsBps / 100) : '1');
  const [maxCap, setMaxCap] = useState(d.plans.length ? formatEther(capitalOf(unpackPlan(d.plans[0]))) : '1');
  const [markup, setMarkup] = useState(d.plans.length ? String(d.config.markupBps / 100) : '15');
  const [gas, setGas] = useState('1');
  const [allowed, setAllowed] = useState<number[]>([0, 1, 2]);
  const [maxShapes, setMaxShapes] = useState('20');
  const [chosen, setChosen] = useState<Counts[]>([]);
  const [manual, setManual] = useState<string>('');
  const bases = d.listings.filter((l) => l.kind === 1 && l.state === 1).map((l) => l.base);
  const inputs = { curatedBases: bases, markupBps: Math.round(Number(markup) * 100), edgeBps: Number(d.edgeBps), mintFee: d.mintFee };
  let limits: { maxDrawPrice: bigint; minCuratedOddsBps: number; maxShapeCapital: bigint } | undefined;
  try { limits = { maxDrawPrice: parseEther(maxDraw), minCuratedOddsBps: Math.round(Number(minOdds) * 100), maxShapeCapital: parseEther(maxCap) }; } catch { limits = undefined; }
  const cost = { gasPriceGwei: Number(gas) || 1, drawsPerUpkeep: 1, safety: 0.25 };
  const result = useMemo(() => (limits && bases.length ? enumeratePlans(inputs, limits, allowed, Math.min(MAX_SHAPES_PER_PLAN, Number(maxShapes) || 1), cost) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [maxDraw, minOdds, maxCap, markup, gas, allowed.join(), maxShapes, bases.join()]);
  const preview = chosen[0] ? evaluate(chosen[0], inputs, limits) : undefined;
  const econ = chosen[0] ? economics(chosen[0], inputs, cost) : undefined;
  const addManual = () => {
    const c = manual.split(',').map((x) => Number(x.trim() || 0));
    while (c.length < 9) c.push(0);
    setChosen([...chosen, c.slice(0, 9)].slice(0, MAX_PLANS));
  };
  return (
    <div className="card">
      <h2>Configure</h2>
      <div className="grid">
        <label>Max draw price (ETH, excl. VRF) <input value={maxDraw} onChange={(e) => setMaxDraw(e.target.value)} /></label>
        <label>Min curated odds (%) <input value={minOdds} onChange={(e) => setMinOdds(e.target.value)} /></label>
        <label>Max Shapes capital (ETH, planner filter) <input value={maxCap} onChange={(e) => setMaxCap(e.target.value)} /></label>
        <label>Operating markup (%) <input value={markup} onChange={(e) => setMarkup(e.target.value)} /></label>
        <label>Max Shapes per plan <input value={maxShapes} onChange={(e) => setMaxShapes(e.target.value)} /></label>
        <label>Gas price assumption (gwei) <input value={gas} onChange={(e) => setGas(e.target.value)} /></label>
      </div>
      <div className="row wrap">
        <span className="muted small">Denominations:</span>
        {DENOM_LABELS.map((l, i) => (
          <label key={i} className="chip">
            <input type="checkbox" checked={allowed.includes(i)} onChange={(e) => setAllowed(e.target.checked ? [...allowed, i].sort() : allowed.filter((x) => x !== i))} /> {l}
          </label>
        ))}
      </div>
      {bases.length === 0 && <p className="badText">List at least one curated NFT to plan.</p>}
      {result && (
        result.plans.length === 0
          ? <p className="badText">Infeasible: no Shapes mix over these denominations meets the price ceiling, odds floor and capital filter together. Raise the ceiling or capital, lower the odds floor, or change curated values.</p>
          : (
            <table>
              <thead><tr><th>Plan</th><th>Draw price</th><th>Curated odds</th><th>Capital</th><th>Batch reserve</th><th>Net / draw*</th><th></th></tr></thead>
              <tbody>
                {result.plans.slice(0, 8).map((p, i) => (
                  <tr key={i}>
                    <td className="mono small">{p.counts.map((n, j) => (n ? `${n}×${DENOM_LABELS[j]}` : '')).filter(Boolean).join(' ')}</td>
                    <td>{fmt(p.ev.drawPrice, 5)}</td><td>{pct(p.ev.curatedOddsBps)}</td><td>{fmt(p.ev.capital, 2)}</td><td>{fmt(p.ev.requiredReserve)}</td>
                    <td className={p.net < 0 ? 'badText' : ''}>{p.net.toFixed(5)}</td>
                    <td><button className="ghost" disabled={chosen.length >= MAX_PLANS} onClick={() => setChosen([...chosen, p.counts])}>Add</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      )}
      <p className="muted small">*Expected creator gain per draw after mint fees and keeper gas at the assumed gas price. Randomized outcomes vary; individual draws can lose money.</p>
      <div className="row wrap">
        <input aria-label="Manual plan: counts for 0.01,0.05,0.1,0.5,1,5,10,50,100" placeholder="Manual plan: counts for 0.01,0.05,0.1,0.5,1,5,10,50,100" value={manual} onChange={(e) => setManual(e.target.value)} />
        <button className="ghost" onClick={addManual}>Add manual plan</button>
      </div>
      {chosen.length > 0 && (
        <>
          <h3>Selected plans (first is preferred; later ones are fallbacks)</h3>
          <ol>{chosen.map((c, i) => <li key={i} className="mono small">{c.map((n, j) => (n ? `${n}×${DENOM_LABELS[j]}` : '')).filter(Boolean).join(' ')} <button className="ghost" onClick={() => setChosen(chosen.filter((_, k) => k !== i))}>Remove</button></li>)}</ol>
          {preview && econ && (
            <>
              <div className="grid">
                <Stat label="Draw price" value={`${fmt(preview.drawPrice, 5)} ETH`} />
                <Stat label="Curated odds" value={pct(preview.curatedOddsBps)} />
                <Stat label="Shapes backing" value={`${fmt(preview.capital, 3)} ETH`} />
                <Stat label="Required reserve" value={`${fmt(preview.requiredReserve + MAX_KEEPER_REWARD)} ETH`} />
                <Stat label="Initial mint fees" value={`${fmt(preview.initialMintFees)} ETH`} />
                <Stat label="Total ETH committed" value={`${fmt(preview.capital + preview.initialMintFees + preview.requiredReserve + MAX_KEEPER_REWARD, 3)} ETH`} />
                <Stat label="Keeper cost / upkeep" value={`${econ.keeperCostPerUpkeepEth.toFixed(5)} ETH`} />
                <Stat label="Projected minimum markup" value={Number.isFinite(econ.minMarkupBps) ? pct(econ.minMarkupBps) : '-'} />
                <Stat label="Expected net / draw" value={<span className={econ.expectedNetPerDraw < 0 ? 'badText' : ''}>{econ.expectedNetPerDraw.toFixed(5)} ETH</span>} />
              </div>
              {!preview.feasible && <p className="badText">{preview.reasons.join('; ')}</p>}
              {econ.outlook === 'loss'
                ? <p className="badText">Projected loss at these assumptions. You can still submit it while it is funded.</p>
                : econ.belowModeledMarkup && <p className="badText">Markup is below the modeled sustainable level of {pct(econ.minMarkupBps)}.</p>}
              <table>
                <thead><tr><th>Tier</th><th>Count</th><th>FWA price</th><th>Odds</th></tr></thead>
                <tbody>{preview.tiers.map((t, i) => <tr key={i}><td>{t.label}</td><td>{t.count}</td><td>{fmt(t.listPrice, 5)}</td><td>{(t.oddsPpm / 10_000).toFixed(3)}%</td></tr>)}</tbody>
              </table>
            </>
          )}
          <button
            disabled={!!tx.busy || !limits}
            onClick={() => tx.send('Configure', [() => tx.write({
              address: d.balancer, abi: poolBalancerAbi, functionName: 'configure',
              args: [{ maxDrawPrice: limits!.maxDrawPrice, minCuratedOddsBps: limits!.minCuratedOddsBps, markupBps: inputs.markupBps }, chosen.map(packPlan)],
            })])}
          >Submit configuration</button>
          <p className="muted small">Changing the markup reprices every listing during upkeep; purchases stay closed until repricing completes.</p>
        </>
      )}
    </div>
  );
}

function Ens({ d, tx, isCreator }: { d: D; tx: Tx; isCreator: boolean }) {
  const pub = usePublicClient();
  const [name, setName] = useState('');
  const [reverse, setReverse] = useState<string | null>();
  const [forward, setForward] = useState<string | null>();
  useEffect(() => {
    pub?.getEnsName({ address: d.balancer }).then(setReverse).catch(() => setReverse(null));
  }, [pub, d.balancer, tx.busy]);
  useEffect(() => {
    const n = name || reverse;
    if (!n) { setForward(undefined); return; }
    pub?.getEnsAddress({ name: normalize(n) }).then((a) => setForward(a)).catch(() => setForward(null));
  }, [pub, name, reverse]);
  const ok = forward?.toLowerCase() === d.balancer.toLowerCase();
  return (
    <div className="card">
      <h2>ENS name</h2>
      <p className="muted small">FWA shows the pool owner, which is this Balancer. A primary name needs both records: the reverse record set here, and your ENS name's ETH address set to the Balancer ({short(d.balancer)}) in the ENS app. Optional.</p>
      <p>Primary name: <strong>{reverse ?? 'none'}</strong></p>
      {(name || reverse) && <p className={ok ? 'okText' : 'badText'}>{ok ? '✓ Forward record resolves to this Balancer' : `✗ ${name || reverse} resolves to ${forward ? short(forward) : 'nothing'}; set its ETH address to the Balancer`}</p>}
      {isCreator && (
        <div className="row wrap">
          <input aria-label="ENS name" placeholder="name.eth" value={name} onChange={(e) => setName(e.target.value)} />
          <button disabled={!!tx.busy || !name} onClick={() => tx.send('Set ENS name', [() => tx.write({ address: d.balancer, abi: poolBalancerAbi, functionName: 'setENSName', args: [name] })])}>Set reverse name</button>
          <button className="ghost" disabled={!!tx.busy} onClick={() => tx.send('Clear ENS name', [() => tx.write({ address: d.balancer, abi: poolBalancerAbi, functionName: 'clearENSName' })])}>Clear</button>
        </div>
      )}
    </div>
  );
}

/** FWA's pool-page profile, in its schema's key order (the hash covers JSON.stringify of exactly this). */
const PROFILE_KEYS = ['avatarUrl', 'bannerUrl', 'description', 'websiteUrl', 'xUrl', 'discordUrl'] as const;

function PoolPage({ d, tx }: { d: D; tx: Tx }) {
  const [name, setName] = useState('');
  const [profile, setProfile] = useState<Record<string, string>>(Object.fromEntries(PROFILE_KEYS.map((k) => [k, ''])));
  const [result, setResult] = useState<string>();
  const publish = async () => {
    const metadata = { name, profile: Object.fromEntries(PROFILE_KEYS.map((k) => [k, profile[k] ?? ''])) };
    const issuedAt = new Date().toISOString();
    const hash = keccak256(toBytes(JSON.stringify(metadata)));
    await tx.send('Approve pool page', [() => tx.write({ address: d.balancer, abi: poolBalancerAbi, functionName: 'approvePoolPage', args: [issuedAt, hash] })]);
    // The Balancer ignores signature bytes. 66 zero bytes: viem-style verifiers reject very short signatures
    // before calling ERC-1271, and a non-65-byte value cannot be read as an ECDSA signature.
    const body = { pool: d.pool, issuedAt, metadata, signature: `0x${'00'.repeat(66)}` };
    if (chain.id !== 1) {
      setResult(`Approved on this test chain. On mainnet the dashboard would now submit to FWA: ${JSON.stringify(body)}`);
      return;
    }
    try {
      const res = await fetch('https://pools.fwa.fun/api/fwa/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      setResult(res.ok ? 'FWA accepted the page.' : `FWA rejected it (${res.status}): ${await res.text()}`);
    } catch (e) {
      setResult(`Could not reach FWA from this page: ${(e as Error).message}`);
    }
  };
  return (
    <div className="card">
      <h2>FWA pool page</h2>
      <p className="muted small">FWA asks the pool owner to sign page edits. The Balancer approves exactly one FWA page message per submission, through ERC-1271. FWA has not confirmed that it accepts contract owners.</p>
      <div className="grid">
        <label>Name (2–64 characters) <input value={name} onChange={(e) => setName(e.target.value)} /></label>
        {PROFILE_KEYS.map((k) => (
          <label key={k}>{k} <input value={profile[k]} onChange={(e) => setProfile({ ...profile, [k]: e.target.value })} /></label>
        ))}
      </div>
      <button disabled={!!tx.busy || name.length < 2 || name.length > 64} onClick={publish}>Approve and publish</button>
      {result && <p className="muted small">{result}</p>}
    </div>
  );
}

function Lifecycle({ d, tx, me }: { d: D; tx: Tx; me: Address }) {
  const [next, setNext] = useState('');
  const [confirmRetire, setConfirmRetire] = useState('');
  const B = { address: d.balancer, abi: poolBalancerAbi } as const;
  return (
    <div className="card">
      <h2>Recover capital and retire</h2>
      <p className="muted small">Close purchases first. Unwind withdraws listed Shapes (up to 20 per call) and redeems them for their exact backing; then claim the ETH. Withdraw curated NFTs from the table above.</p>
      <div className="row wrap">
        <button className="ghost" disabled={!!tx.busy || d.enabled} onClick={() => tx.send('Unwind', [() => tx.write({ ...B, functionName: 'unwind', args: [20n] })])}>Unwind Shapes</button>
      </div>
      <p className="muted small">Retiring the FWA pool is permanent: it never accepts purchases again. Withdrawals still work. Type RETIRE to enable.</p>
      <div className="row wrap">
        <input className="narrow" value={confirmRetire} onChange={(e) => setConfirmRetire(e.target.value)} aria-label="Type RETIRE to confirm" placeholder="RETIRE" />
        <button className="danger" disabled={!!tx.busy || d.enabled || d.retired || confirmRetire !== 'RETIRE'} onClick={() => tx.send('Retire', [() => tx.write({ ...B, functionName: 'retire' })])}>Retire pool</button>
      </div>
      <h3>Transfer creator role</h3>
      <div className="row wrap">
        <input aria-label="New creator address" placeholder="New creator 0x…" value={next} onChange={(e) => setNext(e.target.value)} />
        <button className="ghost" disabled={!!tx.busy || !next} onClick={() => tx.send('Start transfer', [() => tx.write({ ...B, functionName: 'transferCreator', args: [next as Address] })])}>Start transfer</button>
      </div>
      {d.pendingCreator !== '0x0000000000000000000000000000000000000000' && <p className="muted small">Pending creator: {short(d.pendingCreator)}. The new address must accept.</p>}
    </div>
  );
}
