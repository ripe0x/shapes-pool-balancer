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
import { chain, ETHERSCAN, FACTORY, FROM_BLOCK, FWA_POOL_URL } from './chain';
import { prepareWrite } from './tx';

const SHAPES: Address = '0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0';
const FWA_FACTORY: Address = '0x8919814D825a5Af238cC04DE06b1C18c9eaA477C';
const fwaFactoryAbi = parseAbi(['function edgeBps() view returns (uint16)', 'function poolCreationEnabled() view returns (bool)', 'function implementation() view returns (address)']);
const CREATED = parseAbiItem('event BalancerCreated(address indexed creator, address indexed balancer, address indexed pool, bytes32 salt)');
const DRAWN = parseAbiItem('event ItemDrawn(uint256 indexed listingId, uint8 kind, uint8 denom, bool delivered)');
const L_DELIVERY_REFUNDED = 7;

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
    return {
      balancer: b, pool, creator, pendingCreator, enabled, repricing, lastStatus, admission, upkeep, required, surplus, balance, plans, activePlan,
      config: { maxDrawPrice: config[0], minCuratedOddsBps: config[1], markupBps: config[2] },
      checkpoint: { valid: checkpoint[0], reserve: checkpoint[4] },
      activeShapes: activeShapes.map(Number),
      fee, proceeds, totalWeight, retired, unsettled, mintFee, edgeBps, vrfFee, listings, pending, baseFee,
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

export function App() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const pub = usePublicClient();
  const [mine, setMine] = useState<Address[]>([]);
  const [selected, setSelected] = useState<Address>();
  const [prereq, setPrereq] = useState<{ creation: boolean; impl: boolean }>();

  const loadMine = useCallback(async () => {
    if (!pub || !address || !FACTORY) return;
    const logs = await pub.getLogs({ address: FACTORY, event: CREATED, args: { creator: address }, fromBlock: FROM_BLOCK });
    const list = logs.map((l) => l.args.balancer!);
    setMine(list);
    // Keep the selection only if it belongs to the connected account (it changes when the wallet switches accounts).
    setSelected((s) => (s && list.includes(s) ? s : list[list.length - 1]));
  }, [pub, address]);
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
        <div className="row">
          <ConnectButton showBalance={false} />
          {!isConnected && connectors.filter((c) => c.type === 'mock').map((c) => (
            <button key={c.uid} className="ghost" onClick={() => connect({ connector: c, chainId: chain.id })}>Local dev account</button>
          ))}
        </div>
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
          <button disabled={!!tx.busy} onClick={() => tx.send('Run upkeep', [() => w({ ...B, functionName: 'performUpkeep' })])}>Run upkeep</button>
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
        <p className="badText">This collection refuses transfers to contracts. A buyer using a contract that never claims its refund can lock this NFT in FWA escrow permanently. In a pool with few listings, doing so can cost the buyer much less than the NFT is worth. Neither this warning nor the pool prevents it.</p>
      )}
      <p className="muted small">List only collections you trust: a collection whose contract can move or freeze tokens can take or strand an NFT listed here.</p>
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

const STYLES: { key: Style; label: string; hint: string }[] = [
  { key: 'steady', label: 'Low draw price', hint: 'Lowest draw price your NFT odds allow' },
  { key: 'balanced', label: 'More big wins', hint: 'Most chances to win 2× the draw or more' },
  { key: 'jackpot', label: 'Jackpot', hint: 'Largest Shape prize your budget allows' },
];
const ZERO: Counts = Array(9).fill(0);
const oneIn = (p: number) => (p <= 0 ? '–' : p >= 0.995 ? 'always' : `1 in ${1 / p < 10 ? (1 / p).toFixed(1) : Math.round(1 / p).toLocaleString()}`);
const pctOf = (p: number) => `${(p * 100).toFixed(p < 0.01 ? 2 : 1)}%`;
const mixText = (c: Counts) => c.map((n, j) => (n ? `${n} × ${DENOM_LABELS[j]}` : '')).filter(Boolean).join(', ') || 'no Shapes';
const ethOr = (s: string, fallback: bigint) => { try { return parseEther(s || '0'); } catch { return fallback; } };

function Configure({ d, tx }: { d: D; tx: Tx }) {
  const has = d.plans.length > 0;
  const bases = d.listings.filter((l) => l.kind === 1 && l.state === 1).map((l) => l.base);
  const [budget, setBudget] = useState(formatEther(available(d.balance, d.activeShapes, ZERO)));
  const [markup, setMarkup] = useState(has ? d.config.markupBps / 100 : 15);
  const [floor, setFloor] = useState(has ? d.config.minCuratedOddsBps / 100 : 5);
  const [style, setStyle] = useState<Style>();
  const [counts, setCounts] = useState<Counts>(has ? unpackPlan(d.plans[d.activePlan]) : ZERO);
  const [fallbacks, setFallbacks] = useState<Counts[]>(has ? d.plans.filter((_, i) => i !== d.activePlan).map(unpackPlan) : []);
  const [ceiling, setCeiling] = useState(has ? formatEther(d.config.maxDrawPrice) : '');
  const [gas, setGas] = useState('1');
  const [note, setNote] = useState<string>();
  const markupBps = Math.round(markup * 100);
  const floorBps = Math.round(floor * 100);
  const inputs: DesignInputs = {
    curatedBases: bases, markupBps, edgeBps: Number(d.edgeBps), mintFee: d.mintFee, budget: ethOr(budget, 0n),
    have: d.activeShapes, baseFee: d.baseFee, minCuratedOddsBps: floorBps, vrfFee: d.vrfFee,
  };
  const pick = (st: Style) => {
    const r = recommend(st, inputs);
    setStyle(st);
    if (!r.best) { setNote('No Shapes mix fits this budget and NFT odds floor. Raise the budget or lower the floor.'); return; }
    setNote(undefined);
    setCounts(r.best);
    setFallbacks(r.fallbacks);
  };
  const total = counts.reduce((a, b) => a + b, 0);
  const setCount = (i: number, n: number) => { setStyle(undefined); setCounts(counts.map((x, j) => (j === i ? n : x))); };
  const ready = bases.length > 0 && total > 0;
  const ev = ready ? describe(counts, inputs) : undefined;
  const view = ev ? playerView(ev, markupBps, d.vrfFee) : undefined;
  const plans = [counts, ...fallbacks];
  // Default ceiling: 25% above the highest draw price among the selected plans, so fallbacks stay admissible.
  const autoCeiling = ready ? (plans.map((c) => describe(c, inputs).drawPrice).reduce((a, b) => (b > a ? b : a), 0n) * 125n) / 100n : 0n;
  const ceilingWei = ceiling ? ethOr(ceiling, autoCeiling) : autoCeiling;
  const checked = ready ? describe(counts, inputs, ceilingWei) : undefined;
  const needed = ready ? ethNeeded(counts, inputs) : 0n;
  const have = available(d.balance, d.activeShapes, counts);
  const econ = ready ? economics(counts, inputs, { gasPriceGwei: Number(gas) || 1, drawsPerUpkeep: 1, safety: 0.25 }) : undefined;
  const largeShown = counts.slice(5).some(Boolean) || inputs.budget >= 10n * 10n ** 18n;
  const rows = DENOMS.map((_, i) => i).filter((i) => i < 5 || largeShown);
  const tierOdds = (i: number) => view?.tiers.find((t) => t.kind === 'shape' && t.label.startsWith(`${DENOM_LABELS[i]} ETH`));
  return (
    <div className="card">
      <h2>Design your pool</h2>
      {bases.length === 0 && <p className="badText">List at least one curated NFT first: odds and prices depend on your NFTs.</p>}
      <div className="grid">
        <label>Budget (ETH) <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" /></label>
        <label>Markup: {markup}% <input type="range" min={0} max={100} value={markup} onChange={(e) => setMarkup(Number(e.target.value))} /></label>
        <label>Minimum chance of one of your NFTs: {floor}% <input type="range" min={0} max={50} step={0.5} value={floor} onChange={(e) => setFloor(Number(e.target.value))} /></label>
      </div>
      <div className="row wrap">
        {STYLES.map((s) => (
          <button key={s.key} className={style === s.key ? '' : 'ghost'} disabled={!bases.length} title={s.hint} onClick={() => pick(s.key)}>{s.label}</button>
        ))}
      </div>
      <p className="muted small">{style ? STYLES.find((s) => s.key === style)!.hint : 'Pick a style for a recommended mix, then adjust it below.'}</p>
      {note && <p className="badText">{note}</p>}

      <table className="mix">
        <thead><tr><th>Prize</th><th>Count</th><th>Chance per draw</th><th>Worth vs draw cost</th></tr></thead>
        <tbody>
          {view?.tiers.filter((t) => t.kind === 'curated').map((t, i) => (
            <tr key={`c${i}`}><td>Your NFT #{i + 1} ({fmt(t.value, 3)} ETH)</td><td>1</td><Odds p={t.odds} /><td>{t.multiple.toFixed(2)}×</td></tr>
          ))}
          {rows.map((i) => {
            const t = tierOdds(i);
            return (
              <tr key={i}>
                <td>{DENOM_LABELS[i]} ETH Shape</td>
                <td>
                  <div className="row">
                    <input type="range" aria-label={`${DENOM_LABELS[i]} ETH Shapes`} min={0} max={Math.min(MAX_SHAPES_PER_PLAN, MAX_SHAPES_PER_PLAN - total + counts[i])} value={counts[i]} onChange={(e) => setCount(i, Number(e.target.value))} />
                    <span className="mono">{counts[i]}</span>
                  </div>
                </td>
                <Odds p={t?.odds ?? 0} />
                <td>{t ? `${t.multiple.toFixed(2)}×` : '–'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">{total} of {MAX_SHAPES_PER_PLAN} Shapes.</p>

      {view && ev && econ && checked && (
        <div className="split">
          <div>
            <h3>What players see</h3>
            <div className="grid">
              <Stat label="Cost per draw" value={<>{fmt(view.cost, 5)} ETH<div className="muted small">{fmt(ev.drawPrice, 5)} + {fmt(d.vrfFee, 5)} VRF fee</div></>} />
              <Stat label="Wins one of your NFTs" value={`${oneIn(view.curated)} (${pctOf(view.curated)})`} />
              <Stat label="Wins more than they paid" value={pctOf(view.winMore)} />
              <Stat label="Wins 2× or more" value={pctOf(view.win2x)} />
              <Stat label="Top prize" value={`${fmt(view.top.value, 3)} ETH, ${oneIn(view.top.odds)}`} />
              <Stat label="Average prize value" value={`${(view.avgReturn * 100).toFixed(0)}% of cost`} />
            </div>
          </div>
          <div>
            <h3>What you need</h3>
            <div className="grid">
              <Stat label="Shapes backing" value={`${fmt(ev.capital, 3)} ETH`} />
              <Stat label="ETH needed to open" value={`${fmt(needed, 3)} ETH`} />
              <Stat label="Available" value={<>{fmt(have, 3)} ETH<div className={needed > have ? 'badText small' : 'okText small'}>{needed > have ? `Deposit ${fmt(needed - have, 3)} more` : 'Fits'}</div></>} />
              <Stat label="Your expected net per draw" value={<span className={econ.expectedNetPerDraw < 0 ? 'badText' : ''}>{econ.expectedNetPerDraw.toFixed(5)} ETH</span>} />
              <Stat label="Minimum sustainable markup" value={Number.isFinite(econ.minMarkupBps) ? pct(econ.minMarkupBps) : '–'} />
            </div>
          </div>
        </div>
      )}
      {checked && !checked.feasible && <p className="badText">{checked.reasons.join('; ')}.</p>}
      {econ?.belowModeledMarkup && <p className="badText">Markup is below the modeled sustainable level of {pct(econ.minMarkupBps)}.</p>}

      <h3>Fallback mixes</h3>
      {fallbacks.length === 0 ? <p className="muted small">None. Picking a style adds them.</p> : (
        <ol className="small">
          {fallbacks.map((c, i) => {
            const f = describe(c, inputs, ceilingWei);
            return (
              <li key={i}>
                {mixText(c)} · draw {fmt(f.drawPrice, 5)} ETH · NFT chance {pct(f.curatedOddsBps)}{!f.feasible && <span className="badText"> · {f.reasons.join('; ')}</span>}{' '}
                <button className="ghost" onClick={() => setFallbacks(fallbacks.filter((_, k) => k !== i))}>Remove</button>
              </li>
            );
          })}
        </ol>
      )}
      <p className="muted small">Upkeep switches to the first fallback that meets your limits when the main mix stops meeting them, for example after one of your NFTs is drawn.</p>

      <details>
        <summary className="small">Advanced</summary>
        <div className="grid">
          <label>Max draw price (ETH, excl. VRF fee) <input value={ceiling} placeholder={`auto: ${fmt(autoCeiling, 5)}`} onChange={(e) => setCeiling(e.target.value)} /></label>
          <label>Keeper gas assumption (gwei) <input value={gas} onChange={(e) => setGas(e.target.value)} inputMode="decimal" /></label>
        </div>
      </details>

      <button
        disabled={!!tx.busy || !ready || !checked?.feasible}
        onClick={() => tx.send('Configure', [() => tx.write({
          address: d.balancer, abi: poolBalancerAbi, functionName: 'configure',
          args: [{ maxDrawPrice: ceilingWei, minCuratedOddsBps: floorBps, markupBps }, plans.slice(0, MAX_PLANS).map(packPlan)],
        })])}
      >Save configuration</button>
      <p className="muted small">A markup change reprices every listing during upkeep; purchases stay closed until it completes.</p>
    </div>
  );
}

function Odds({ p }: { p: number }) {
  return (
    <td>
      <div className="odds"><span className="bar" style={{ width: `${Math.min(100, p * 100)}%` }} /></div>
      <span className="small">{oneIn(p)} · {pctOf(p)}</span>
    </td>
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
    if (!(await tx.send('Approve pool page', [() => tx.write({ address: d.balancer, abi: poolBalancerAbi, functionName: 'approvePoolPage', args: [issuedAt, hash] })]))) return;
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
