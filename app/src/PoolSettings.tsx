// Pool settings rows: automatic pauses (low prizes, draws waiting to settle); maintenance (keeper pay, spending limit,
// keeper pay rates); product limits; and the legacy route.
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { usePublicClient } from 'wagmi';
import { formatEther, formatGwei, parseEther, parseGwei, type Abi, type Address, type Hash } from 'viem';
import { balancerFactoryAbi, poolBalancerAbi } from '../../shared/abi';
import { MAX_BATCH, maxPaymentOf, maxSurchargeOf, pendingDrawsAdmitted, unpackPlan, type Economics } from '../../shared/planner';
import { legacyFactory, type LegacyFactory } from '../../shared/legacy';
import {
  BACKLOG_DEFAULT, FILL_GATE_DEFAULT_BPS, LEGACY_LIMITS, maxUnsettled, refillPerDay, validBacklog, validFillGate, type ProductLimits,
} from './limits';
import type { TransactionStep } from './tx';

type Pub = NonNullable<ReturnType<typeof usePublicClient>>;
// Method syntax: useTx's write is an overloaded wagmi mutation, compared bivariantly.
type Tx = { busy?: string; send(label: string, steps: TransactionStep[]): Promise<boolean>; write(params: Record<string, unknown>): Promise<Hash> };
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export const readProductLimits = async (pub: Pub, factory: Address, blockNumber?: bigint): Promise<ProductLimits> => {
  const [maxPrizes, minMarkupBps, maxMarkupBps] = await pub.readContract({ address: factory, abi: balancerFactoryAbi, functionName: 'productLimits', blockNumber });
  return { maxPrizes, minMarkupBps, maxMarkupBps };
};

/** The pool's factory decides its ABI and limits: a legacy factory's pools have fixed limits and admission. */
export async function poolGeneration(pub: Pub, balancer: Address, factory: Address, blockNumber: bigint) {
  const legacy = legacyFactory(factory);
  if (legacy) return { legacy, abi: legacy.poolBalancerAbi, productLimits: LEGACY_LIMITS, fillGateBps: FILL_GATE_DEFAULT_BPS, backlogThreshold: BACKLOG_DEFAULT };
  const r = (functionName: 'fillGateBps' | 'backlogThreshold') => pub.readContract({ address: balancer, abi: poolBalancerAbi, functionName, blockNumber });
  const [productLimits, fillGateBps, backlogThreshold] = await Promise.all([readProductLimits(pub, factory, blockNumber), r('fillGateBps'), r('backlogThreshold')]);
  return { legacy: undefined as LegacyFactory | undefined, abi: poolBalancerAbi as Abi, productLimits, fillGateBps, backlogThreshold };
}

export const LegacyTag = ({ legacy }: { legacy?: LegacyFactory }) => legacy
  ? <span className="label legacy-tag" title={`Created by the ${legacy.label} factory ${legacy.factory}`}>Legacy · {legacy.label}</span>
  : null;


/** A Settings row: label, description and meta on the left; the current value and one control on the right; an
 *  optional full-width part (an inline form) below. */
export function SRow({ label, desc, meta, value, children, wide }: { label: ReactNode; desc?: ReactNode; meta?: ReactNode; value?: ReactNode; children?: ReactNode; wide?: ReactNode }) {
  return <div className="srow">
    <div>
      <div className="lab">{label}</div>
      {desc && <p className="sd">{desc}</p>}
      {meta && <p className="meta">{meta}</p>}
    </div>
    <div className="ctl-col">{value !== undefined && value !== '' && <span>{value}</span>}{children}</div>
    {wide && <div className="wide">{wide}</div>}
  </div>;
}

/** Automatic pauses: the fill gate (Low prizes) and the unsettled-draw backlog. Legacy pools have both fixed. */
export function AutomaticPauses({ d, tx }: { d: { balancer: Address; target: bigint; fillGateBps: number; backlogThreshold: number; legacy?: LegacyFactory }; tx: Tx }) {
  const [gate, setGate] = useState(String(d.fillGateBps / 100));
  const [backlog, setBacklog] = useState(String(d.backlogThreshold));
  const gateBps = Math.round(Number(gate) * 100);
  const backlogN = Number(backlog);
  const gateOk = gate.trim() !== '' && validFillGate(gateBps);
  const backlogOk = backlog.trim() !== '' && validBacklog(backlogN);
  const counts = unpackPlan(d.target);
  // A fully stocked target with every other check passing: the fill gate alone.
  const admitted = (bps: number) => pendingDrawsAdmitted(counts, bps, Number.MAX_SAFE_INTEGER);
  const set = (label: string, functionName: string, value: number) =>
    tx.send(label, [() => tx.write({ address: d.balancer, abi: poolBalancerAbi, functionName, args: [value] })]);
  const lowDesc = "Pause when the prizes left fall below this share of your target. Smaller prizes count for more because they're drawn more often, and each unsettled draw counts as a 0.01 ETH Shape already won.";
  const waitDesc = (n: number) => `Pause at this many unsettled draws. One purchase can add up to ${MAX_BATCH} at once, so up to ${maxUnsettled(n)} can be waiting.`;
  if (d.legacy) return <>
    <SRow label="Low prizes" desc={lowDesc} value={`${FILL_GATE_DEFAULT_BPS / 100}%`} meta="Fixed on legacy pools." />
    <SRow label="Draws waiting to settle" desc={waitDesc(MAX_BATCH)} value={String(MAX_BATCH)} meta="Fixed on legacy pools." />
  </>;
  const pausesAt = (bps: number) => { const n = admitted(bps) + 1; return `${n} unsettled draw${n === 1 ? '' : 's'}`; };
  return <>
    <SRow label="Low prizes" desc={lowDesc} value={`${d.fillGateBps / 100}%`}
      meta={<>{d.target !== 0n && gateOk && `With the full target listed, this pauses at ${pausesAt(gateBps)}${gateBps !== d.fillGateBps ? ` (now ${pausesAt(d.fillGateBps)})` : ''}. `}Default {FILL_GATE_DEFAULT_BPS / 100}%.</>}>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <div className="field"><input aria-label="Low prizes, % of target" type="number" min="0" max="100" step="0.01" value={gate} onChange={(e) => setGate(e.target.value)} /><span className="u">%</span></div>
        <button className="obtn" disabled={!!tx.busy || !gateOk || gateBps === d.fillGateBps} onClick={() => set('Change low prizes pause', 'setFillGateBps', gateBps)}>Apply</button>
      </div>
      {!gateOk && <span className="err">Enter 0% to 100%.</span>}
    </SRow>
    <SRow label="Draws waiting to settle" desc={waitDesc(backlogOk ? backlogN : d.backlogThreshold)} value={String(d.backlogThreshold)} meta={`Default ${BACKLOG_DEFAULT}.`}>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <div className="field"><input aria-label="Draws waiting to settle" type="number" min="1" max="65535" step="1" value={backlog} onChange={(e) => setBacklog(e.target.value)} /></div>
        <button className="obtn" disabled={!!tx.busy || !backlogOk || backlogN === d.backlogThreshold} onClick={() => set('Change draws waiting to settle', 'setBacklogThreshold', backlogN)}>Apply</button>
      </div>
      {!backlogOk && <span className="err">Enter a whole number from 1 to 65,535.</span>}
    </SRow>
  </>;
}

/** community-v1 keeper policy: changes are proposed, wait two days, then activate. Calls use the community-v1 ABI. */
export function LegacyKeeperPay({ d, tx }: { d: { balancer: Address; keeperPolicy: Address; recommendedPolicy: Address; paidUpkeepEnabled: boolean; policyMaxReward: bigint; chainTimestamp: bigint; blockNumber: bigint; legacy: LegacyFactory }; tx: Tx }) {
  const pub = usePublicClient();
  const [candidate, setCandidate] = useState<string>(d.recommendedPolicy);
  const [pending, setPending] = useState<{ policy: Address; at: bigint }>();
  const abi = d.legacy.poolBalancerAbi;
  useEffect(() => {
    if (!pub) return;
    const r = (functionName: string) => pub.readContract({ address: d.balancer, abi, functionName, blockNumber: d.blockNumber }) as Promise<unknown>;
    Promise.all([r('pendingKeeperPolicy'), r('policyActivationTime')])
      .then(([policy, at]) => setPending({ policy: policy as Address, at: BigInt(at as bigint) })).catch(() => setPending(undefined));
  }, [pub, d.balancer, d.blockNumber, abi]);
  const write = (label: string, functionName: string, args: unknown[] = []) => tx.send(label, [() => tx.write({ address: d.balancer, abi, functionName, args })]);
  const valid = /^0x[0-9a-fA-F]{40}$/.test(candidate);
  const proposed = pending && pending.policy !== ZERO_ADDR;
  return <div>
    <div className="kv"><span className="k">Active policy</span><span title={d.keeperPolicy}>{short(d.keeperPolicy)}</span></div>
    <div className="kv"><span className="k">Pay keepers</span><span>{d.paidUpkeepEnabled ? 'On' : 'Off'}</span></div>
    <div className="kv"><span className="k">Policy payment ceiling</span><span>{Number(formatEther(d.policyMaxReward)).toFixed(5)} ETH</span></div>
    <div className="row" style={{ gap: 16, marginTop: 16 }}>
      {d.paidUpkeepEnabled && <button className="obtn" disabled={!!tx.busy} onClick={() => write('Turn off keeper pay', 'setPaidUpkeepEnabled', [false])}>Turn off keeper pay</button>}
    </div>
    <label htmlFor="legacy-policy" className="ctl" style={{ display: 'block', marginTop: 24 }}>Replacement policy address</label>
    <input id="legacy-policy" className="input" value={candidate} onChange={(e) => setCandidate(e.target.value)} spellCheck={false} autoComplete="off" style={{ width: '100%' }} />
    <button className="btn" style={{ marginTop: 16 }} disabled={!!tx.busy || !valid} onClick={() => write('Propose keeper policy', 'proposeKeeperPolicy', [candidate])}>Propose policy · 2 day delay</button>
    {proposed && <div style={{ marginTop: 20 }}>
      <div className="kv"><span className="k">Pending policy</span><span title={pending.policy}>{short(pending.policy)}</span></div>
      <div className="kv"><span className="k">Activation time</span><time dateTime={new Date(Number(pending.at) * 1000).toISOString()}>{new Date(Number(pending.at) * 1000).toLocaleString()}</time></div>
      <div className="row" style={{ gap: 16, marginTop: 12 }}>
        <button className="btn sec" disabled={!!tx.busy} onClick={() => write('Cancel keeper policy', 'cancelKeeperPolicy')}>Cancel proposal</button>
        <button className="btn" disabled={!!tx.busy || d.chainTimestamp < pending.at} onClick={() => write('Activate keeper policy', 'activateKeeperPolicy')}>Activate policy</button>
      </div>
    </div>}
    <p className="note" style={{ marginTop: 12 }}>Legacy pools change policy after a two-day wait. Turning keeper pay back on uses the same proposal.</p>
  </div>;
}

type Funding = { required: bigint; shortfall: bigint };
export type Keeper = Awaited<ReturnType<typeof readKeeper>>;

/** The pool's effective keeper economics, their source, the factory's current economics, the spending bucket, and the
 *  maintenance funding each needs now. Reads carry a gas price: eth_call otherwise runs at basefee 0. */
export async function readKeeper(pub: Pub, balancer: Address, factory: Address, block: { number: bigint | null; baseFeePerGas: bigint | null }) {
  const at = { blockNumber: block.number!, gasPrice: (block.baseFeePerGas ?? 0n) + 50_000_000n, gas: 2_000_000n };
  const r = <T,>(functionName: string, args: unknown[] = []) =>
    pub.readContract({ ...at, address: balancer, abi: poolBalancerAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
  const [economics, source, capacity, refill, available, factoryEconomics] = await Promise.all([
    r<Economics>('effectiveEconomics'), r<number>('economicsSource'), r<bigint>('keeperBucketCapacity'),
    r<bigint>('keeperBucketRefill'), r<bigint>('availableKeeperAllowance'),
    pub.readContract({ ...at, address: factory, abi: balancerFactoryAbi, functionName: 'economics' }) as Promise<Economics>,
  ]);
  const funding = (e: Economics): Promise<Funding> =>
    r<readonly [bigint, bigint]>('maintenanceFunding', [e]).then(([required, shortfall]) => ({ required, shortfall }));
  const [current, follow] = await Promise.all([funding(economics), funding(factoryEconomics)]);
  return { economics, source, capacity, refill, available, factoryEconomics, current, follow, funding };
}

/** Operating ETH a creator change needs first (KeeperPolicyCalls.select): only a larger maintenance budget than the
 *  current one, and only while paid upkeep is on. Missing prizes never count. */
const toDeposit = (paid: boolean, current: Funding, next: Funding) => paid && next.required > current.required ? next.shortfall : 0n;
const sameEconomics = (a: Economics, b: Economics) =>
  FIELDS.every(([key]) => String(a[key]).toLowerCase() === String(b[key]).toLowerCase());

const ethx = (x: bigint) => `${formatEther(x)} ETH`;
const gweix = (x: bigint) => `${formatGwei(x)} gwei`;
const num = (n: number) => n.toLocaleString('en-US');
const DAY = 86_400n;
const U32 = 2n ** 32n - 1n, U64 = 2n ** 64n - 1n, U96 = 2n ** 96n - 1n, U128 = 2n ** 128n - 1n;
type Unit = 'eth' | 'gwei' | 'gas' | 'blocks';
const FIELDS: readonly [keyof Economics & string, string, Unit][] = [
  ['workFee', 'Work fee per processed or reconciled draw and listed Shape', 'eth'],
  ['gasPriceCeiling', 'Gas price ceiling', 'gwei'],
  ['priorityAllowance', 'Priority allowance', 'gwei'],
  ['maxGas', 'Reimbursable gas per call', 'gas'],
  ['overheadGas', 'Overhead gas per call', 'gas'],
  ['restockGas', 'Restocking gas per Shape', 'gas'],
  ['restockFlat', 'Restocking flat charge per Shape', 'eth'],
  ['baseGas', 'Gas bound per call', 'gas'],
  ['processGas', 'Gas bound per processed draw', 'gas'],
  ['reconcileGas', 'Gas bound per reconciled draw', 'gas'],
  ['shapeGas', 'Gas bound per listed Shape', 'gas'],
  ['prizeGas', 'Gas bound per listed prize', 'gas'],
  ['processGraceBlocks', 'Wait before processing a stuck draw', 'blocks'],
  ['pausedProcessGraceBlocks', 'Wait before processing a stuck draw while sales are paused', 'blocks'],
];
const showField = (e: Economics, key: keyof Economics, unit: Unit) => {
  const v = e[key];
  return unit === 'eth' ? formatEther(v as bigint) : unit === 'gwei' ? formatGwei(v as bigint) : String(v);
};
const display = (e: Economics, key: keyof Economics, unit: Unit) =>
  unit === 'gas' ? `${num(Number(e[key]))} gas` : unit === 'blocks' ? `${num(Number(e[key]))} blocks` : unit === 'eth' ? ethx(e[key] as bigint) : gweix(e[key] as bigint);
/** A field typed in its unit, within its on-chain width; undefined when invalid. */
function parseField(text: string, unit: Unit): bigint | number | undefined {
  const s = text.trim();
  try {
    if (unit === 'gas') return /^\d+$/.test(s) && BigInt(s) <= U32 ? Number(s) : undefined;
    if (unit === 'blocks') return /^\d+$/.test(s) && BigInt(s) <= 65_535n ? Number(s) : undefined;
    if (!/^\d*\.?\d+$/.test(s)) return undefined;
    const v = unit === 'eth' ? parseEther(s) : parseGwei(s);
    return v <= U64 ? v : undefined;
  } catch { return undefined; }
}
const parseEth = (text: string) => /^\d*\.?\d+$/.test(text.trim()) ? parseEther(text.trim()) : undefined;

function EconomicsRows({ e }: { e: Economics }) {
  return <>
    {FIELDS.map(([key, label, unit]) => <div className="kv" key={key}>
      <span className="k">{label}</span>
      <span>{display(e, key, unit)}</span>
    </div>)}
    <div className="kv"><span className="k">Maximum payment per call</span><span>{ethx(maxPaymentOf(e))}</span></div>
    <div className="kv"><span className="k">Maximum restocking charge per Shape</span><span>{ethx(maxSurchargeOf(e))}</span></div>
  </>;
}

type KeeperView = { balancer: Address; keeper: Keeper; paidUpkeepEnabled: boolean; policyUnavailable: boolean; restockFee?: bigint; keepersRestricted: boolean };

/** Maintenance of a current-factory pool: paid upkeep, who keeps, the spending limit, keeper pay rates (follow or local;
 *  "Keep the factory's current rates" saves the factory's values as local) and unpaid maintenance. */
export function Maintenance({ d, tx }: { d: KeeperView; tx: Tx }) {
  const k = d.keeper;
  const [editing, setEditing] = useState(false);
  const [rates, setRates] = useState(false);
  const [limit, setLimit] = useState(false);
  const write = (label: string, functionName: string, args: unknown[] = [], value?: bigint) =>
    tx.send(label, [() => tx.write({ address: d.balancer, abi: poolBalancerAbi, functionName, args, ...(value ? { value } : {}) })]);
  const deposit = (amount: bigint) => amount > 0n &&
    <button className="obtn" disabled={!!tx.busy} onClick={() => write('Deposit ETH', 'depositETH', [], amount)}>Deposit {formatEther(amount)} ETH</button>;
  // Keeping and following both adopt `k.factoryEconomics` as read at this view's block, so they need the same funding.
  const followNeed = toDeposit(d.paidUpkeepEnabled, k.current, k.follow);
  const pinned = k.source === 1 && sameEconomics(k.economics, k.factoryEconomics);
  // Re-enabling compares the effective maintenance budget against no paid exposure.
  const enableNeed = d.paidUpkeepEnabled ? 0n : k.current.shortfall;
  const own = k.source === 1 || editing;
  return <>
    <SRow label="Pay keepers" desc="Off means maintenance waits until someone runs it unpaid. Turning it on needs operating ETH to cover the maintenance budget."
      value={d.paidUpkeepEnabled ? 'On' : 'Off'}
      meta={enableNeed > 0n && <span className="error">Turning it on needs {formatEther(enableNeed)} more operating ETH first.</span>}>
      {d.paidUpkeepEnabled
        ? <button className="obtn" disabled={!!tx.busy} onClick={() => write('Turn off keeper pay', 'setPaidUpkeepEnabled', [false])}>Turn off</button>
        : <button className="obtn" disabled={!!tx.busy || enableNeed > 0n} onClick={() => write('Turn on keeper pay', 'setPaidUpkeepEnabled', [true])}>Turn on</button>}
      {deposit(enableNeed)}
    </SRow>
    <SRow label="Who can run it" desc="Set by the factory for every pool." value={d.keepersRestricted ? 'Approved keepers only' : 'Anyone'} />
    <SRow label="Spending limit" desc="Caps how fast keepers can spend this pool's ETH. Spent allowance refills at a daily rate, up to the cap."
      value={`${formatEther(k.capacity)} ETH · ${formatEther(refillPerDay(k.refill))} a day`} meta={`${formatEther(k.available)} ETH available now.`}
      wide={limit && <SpendingLimitForm key={`${k.capacity}-${k.refill}`} k={k} tx={tx} write={write} />}>
      <button className="obtn" onClick={() => setLimit(!limit)}>{limit ? 'Cancel' : 'Edit'}</button>
    </SRow>
    <SRow label="Keeper pay rates" desc="Work fee, gas ceiling and gas bounds. Following the factory applies its changes immediately; your own rates stay fixed until you change them."
      meta={<>Maintenance budget at these rates: {Number(formatEther(k.current.required)).toFixed(5)} ETH.{d.policyUnavailable && <span className="error"> Keeper quotes unavailable.</span>}
        {d.paidUpkeepEnabled && k.current.shortfall > 0n && <span className="error"> Operating ETH is {ethx(k.current.shortfall)} below it. Paid maintenance pays only from operating ETH and the spending limit.</span>}
        {followNeed > 0n && <span className="error"> Following or keeping the factory's rates needs {formatEther(followNeed)} more operating ETH first.</span>}</>}
      wide={<>
        <button className="disclose" style={{ marginTop: 4 }} onClick={() => setRates(!rates)}>All 14 rates {rates ? '▴' : '▾'}</button>
        {rates && <div style={{ marginTop: 12 }}>
          <EconomicsRows e={k.economics} />
          <div className="kv"><span className="k">0.01 ETH Shape restocking charge now</span><span>{d.restockFee === undefined ? 'Unavailable' : ethx(d.restockFee)}</span></div>
          {(k.source !== 0 || !pinned) && <>
            <p className="meta" style={{ marginTop: 20, fontWeight: 600 }}>Factory rates now</p>
            <EconomicsRows e={k.factoryEconomics} />
            <div className="kv"><span className="k">Maintenance budget when following</span><span>{ethx(k.follow.required)}</span></div>
          </>}
          {editing && <LocalEconomicsForm key={FIELDS.map(([key]) => String(k.economics[key])).join()} d={d} tx={tx} write={write} deposit={deposit} />}
        </div>}
      </>}>
      <div className="seg" role="group" aria-label="Keeper pay rates">
        <button aria-pressed={!own} disabled={!!tx.busy || (k.source !== 0 && followNeed > 0n)}
          onClick={() => { setEditing(false); if (k.source !== 0) write('Follow factory rates', 'followFactoryEconomics'); }}>Follow factory</button>
        <button aria-pressed={own} onClick={() => { setEditing(true); setRates(true); }}>Set my own</button>
      </div>
      {!pinned && <button className="ulink" disabled={!!tx.busy || followNeed > 0n} onClick={() => write("Keep the factory's current rates", 'setLocalEconomics', [k.factoryEconomics])}>Keep the factory's current rates</button>}
      {deposit(d.paidUpkeepEnabled && k.current.shortfall > 0n ? k.current.shortfall : followNeed)}
    </SRow>
    <SRow label="Run maintenance now" desc="Unpaid, from your wallet. Use it when a keeper hasn't.">
      <button className="obtn" disabled={!!tx.busy} onClick={() => write('Run maintenance', 'performUpkeepUnpaid')}>Run maintenance</button>
    </SRow>
  </>;
}

type Writers = { write: (label: string, functionName: string, args?: unknown[], value?: bigint) => Promise<boolean>; deposit: (amount: bigint) => false | ReactElement };

function LocalEconomicsForm({ d, tx, write, deposit }: { d: KeeperView; tx: Tx } & Writers) {
  const k = d.keeper;
  const [text, setText] = useState(() => Object.fromEntries(FIELDS.map(([key, , unit]) => [key, showField(k.economics, key, unit)])) as Record<string, string>);
  const [funding, setFunding] = useState<{ key: string; next?: Funding; error?: boolean }>();
  const parsed = FIELDS.map(([key, , unit]) => [key, parseField(text[key] ?? '', unit)] as const);
  const invalid = parsed.filter(([, v]) => v === undefined).map(([key]) => FIELDS.find((f) => f[0] === key)![1]);
  const candidate = invalid.length ? undefined : Object.fromEntries(parsed) as unknown as Economics;
  const candidateKey = candidate ? FIELDS.map(([key]) => String(candidate[key])).join() : '';
  useEffect(() => {
    if (!candidate) return;
    let live = true;
    k.funding(candidate).then((next) => live && setFunding({ key: candidateKey, next }), () => live && setFunding({ key: candidateKey, error: true }));
    return () => { live = false; };
  }, [candidateKey, k]); // eslint-disable-line react-hooks/exhaustive-deps -- k: re-check after every refresh (a deposit)
  const next = funding?.key === candidateKey ? funding : undefined;
  const need = next?.next ? toDeposit(d.paidUpkeepEnabled, k.current, next.next) : 0n;
  const unchanged = !!candidate && k.source === 1 && sameEconomics(candidate, k.economics);
  const save = () => candidate && write('Set my keeper pay rates', 'setLocalEconomics', [candidate]);
  return <div style={{ marginTop: 20 }}>
    {FIELDS.map(([key, label, unit]) => <div key={key} style={{ marginTop: 12 }}>
      <label htmlFor={`econ-${key}`} className="form-label">{label}</label>
      <div className="field">
        <input id={`econ-${key}`} inputMode="decimal"
          spellCheck={false} autoComplete="off" value={text[key]} onChange={(ev) => setText({ ...text, [key]: ev.target.value })} />
        <span className="u">{unit === 'eth' ? 'ETH' : unit === 'gwei' ? 'GWEI' : unit === 'blocks' ? 'BLOCKS' : 'GAS'}</span>
      </div>
    </div>)}
    {invalid.length > 0 && <p className="note error" style={{ marginTop: 12 }}>Check: {invalid.join(', ')}.</p>}
    {candidate && <div style={{ marginTop: 16 }}>
      <div className="kv"><span className="k">Maximum payment per call</span><span>{ethx(maxPaymentOf(candidate))}</span></div>
      <div className="kv"><span className="k">Maximum restocking charge per Shape</span><span>{ethx(maxSurchargeOf(candidate))}</span></div>
      <p className="note">At the {formatGwei(candidate.gasPriceCeiling)} gwei gas price ceiling. Added per Shape to listed prize prices, on top of the markup. The markup limits do not cap it.</p>
      <div className="kv"><span className="k">Maintenance budget</span><span>{next?.next ? ethx(next.next.required) : next?.error ? 'Unavailable' : 'Checking…'}</span></div>
      {need > 0n && <div style={{ marginTop: 12 }}><p className="note error">These values need {formatEther(need)} more operating ETH first.</p>{deposit(need)}</div>}
    </div>}
    <button className="btn" style={{ marginTop: 16 }} disabled={!!tx.busy || !candidate || unchanged || !next?.next || need > 0n} onClick={save}>Save my rates</button>
    <p className="note" style={{ marginTop: 12 }}>Saved rates apply immediately and factory changes stop applying to this pool. Existing listings keep their prices. A larger maintenance budget needs operating ETH first; missing prizes do not.</p>
  </div>;
}

function SpendingLimitForm({ k, tx, write }: { k: Keeper; tx: Tx } & Pick<Writers, 'write'>) {
  const [cap, setCap] = useState(formatEther(k.capacity));
  const [perDay, setPerDay] = useState(formatEther(refillPerDay(k.refill)));
  const capWei = parseEth(cap);
  const dayWei = parseEth(perDay);
  // The contract stores wei per second: an ETH-per-day entry rounds down to whole wei per second.
  const refill = dayWei === undefined ? undefined : dayWei / DAY;
  const ok = capWei !== undefined && capWei <= U128 && refill !== undefined && refill <= U96;
  const changed = ok && (capWei !== k.capacity || refill !== k.refill);
  return <div style={{ marginTop: 4 }}>
    <label htmlFor="bucket-cap" className="form-label">Cap</label>
    <div className="field" style={{ width: 220 }}><input id="bucket-cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} /><span className="u">ETH</span></div>
    <label htmlFor="bucket-refill" className="form-label">Refill per day</label>
    <div className="field" style={{ width: 220 }}><input id="bucket-refill" inputMode="decimal" value={perDay} onChange={(e) => setPerDay(e.target.value)} /><span className="u">ETH / DAY</span></div>
    {ok && refillPerDay(refill!) !== dayWei && <p className="note" style={{ marginTop: 8 }}>Stored as {refill!.toString()} wei per second: {formatEther(refillPerDay(refill!))} ETH per day.</p>}
    {!ok && <p className="err" style={{ marginTop: 8 }}>Enter amounts in ETH.</p>}
    <button className="obtn" style={{ marginTop: 16 }} disabled={!!tx.busy || !changed} onClick={() => write('Change spending limit', 'setKeeperBucket', [capWei, refill])}>Apply</button>
    <p className="note" style={{ marginTop: 12 }}>A change first adds the time since the last update at the old rate, keeps spent allowance spent and lowers the available allowance to a lower cap. A higher cap adds no allowance. The new rate applies from the change.</p>
  </div>;
}
