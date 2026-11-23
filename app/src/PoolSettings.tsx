// Pool settings: keeper economics, spending bucket and paid upkeep; purchase pauses (fill gate, backlog); product
// limits; and the legacy route.
import { useEffect, useState, type ReactElement } from 'react';
import { usePublicClient } from 'wagmi';
import { formatEther, formatGwei, parseEther, parseGwei, type Abi, type Address, type Hash } from 'viem';
import { balancerFactoryAbi, poolBalancerAbi } from '../../shared/abi';
import { MAX_BATCH, maxPaymentOf, maxSurchargeOf, pendingDrawsAdmitted, unpackPlan, type Economics } from '../../shared/planner';
import { legacyFactory, type LegacyFactory } from '../../shared/legacy';
import {
  BACKLOG_DEFAULT, FILL_GATE_DEFAULT_BPS, LEGACY_LIMITS, maxUnsettled, validBacklog, validFillGate, type ProductLimits,
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

/** Total inventory limits next to the per-transaction batch limits, as the factory and FWA enforce them. */
export function LimitsNote({ limits, currentPrizes }: { limits: ProductLimits; currentPrizes: number }) {
  const above = !limits.fixed && currentPrizes > limits.maxPrizes;
  return <div className="kv-group">
    <span className="label">Limits</span>
    <div className="kv"><span className="k">Shape and Pack prizes in a design</span><span>{above ? `${currentPrizes} (current; factory limit ${limits.maxPrizes})` : `Up to ${limits.maxPrizes.toLocaleString()}`}</span></div>
    <div className="kv"><span className="k">Shape markup</span><span>{limits.minMarkupBps / 100}% to {limits.maxMarkupBps / 100}%</span></div>
    <div className="kv"><span className="k">Curated NFTs</span><span>No total limit · 20 per listing transaction</span></div>
    <div className="kv"><span className="k">Draws per FWA purchase</span><span>Up to {MAX_BATCH}</span></div>
  </div>;
}

/** Creator purchase pauses: the fill gate and the unsettled-draw backlog. Legacy pools have both fixed. */
export function PurchasePauses({ d, tx }: { d: { balancer: Address; target: bigint; fillGateBps: number; backlogThreshold: number; legacy?: LegacyFactory }; tx: Tx }) {
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
  if (d.legacy) return <div className="section">
    <h2 className="h3">Purchase pauses</h2>
    <div className="kv"><span className="k">Fill gate</span><span>70% of the target's weight</span></div>
    <div className="kv"><span className="k">Unsettled draws that pause purchases</span><span>{MAX_BATCH}</span></div>
    <p className="note">Fixed on legacy pools.</p>
  </div>;
  return <div className="section">
    <h2 className="h3">Purchase pauses</h2>
    <div className="kv"><span className="k">Fill gate</span><span>{d.fillGateBps / 100}% of the target's weight</span></div>
    <label htmlFor="fill-gate" className="ctl">New fill gate, % of the target's weight</label>
    <div className="row">
      <div className="field"><input id="fill-gate" type="number" min="0" max="100" step="0.01" value={gate} onChange={(e) => setGate(e.target.value)} /><span>%</span></div>
      <button className="btn" disabled={!!tx.busy || !gateOk || gateBps === d.fillGateBps} onClick={() => set('Change fill gate', 'setFillGateBps', gateBps)}>Apply</button>
    </div>
    <p className="note">A prize's weight is 1 ÷ its backing. Each unreconciled draw counts as the loss of the heaviest prize, a 0.01 ETH Shape. Purchases pause while the remaining weight is below this share of the target's weight. At 0%, purchases pause only when the unreconciled draws' weight exceeds the remaining weight. Default {FILL_GATE_DEFAULT_BPS / 100}%.</p>
    {d.target !== 0n && gateOk && <p className="note">With the saved target fully stocked, purchases pause at {admitted(gateBps) + 1} unreconciled draw{admitted(gateBps) === 0 ? '' : 's'}{gateBps !== d.fillGateBps ? ` (now ${admitted(d.fillGateBps) + 1})` : ''}.</p>}
    {!gateOk && <p className="note error">Enter 0% to 100%.</p>}
    <div className="kv" style={{ marginTop: 20 }}><span className="k">Unsettled draws that pause purchases</span><span>{d.backlogThreshold}</span></div>
    <label htmlFor="backlog" className="ctl">New threshold</label>
    <div className="row">
      <div className="field"><input id="backlog" type="number" min="1" max="65535" step="1" value={backlog} onChange={(e) => setBacklog(e.target.value)} /></div>
      <button className="btn" disabled={!!tx.busy || !backlogOk || backlogN === d.backlogThreshold} onClick={() => set('Change backlog threshold', 'setBacklogThreshold', backlogN)}>Apply</button>
    </div>
    <p className="note">FWA checks this before a purchase of up to {MAX_BATCH} draws, so up to {backlogOk ? maxUnsettled(backlogN) : `threshold + ${MAX_BATCH - 1}`} draws can be unsettled. Closing purchases stops new draws. Default {BACKLOG_DEFAULT}.</p>
    {!backlogOk && <p className="note error">Enter a whole number from 1 to 65,535.</p>}
  </div>;
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
  return <div className="section">
    <h2 className="h3" style={{ fontSize: 22, marginBottom: 12 }}>Keeper payment policy</h2>
    <div className="kv"><span className="k">Active policy</span><span title={d.keeperPolicy}>{short(d.keeperPolicy)}</span></div>
    <div className="kv"><span className="k">Paid upkeep</span><span>{d.paidUpkeepEnabled ? 'Enabled' : 'Disabled'}</span></div>
    <div className="kv"><span className="k">Policy payment ceiling</span><span>{Number(formatEther(d.policyMaxReward)).toFixed(5)} ETH</span></div>
    <div className="row" style={{ gap: 16, marginTop: 16 }}>
      {d.paidUpkeepEnabled && <button className="btn sec" disabled={!!tx.busy} onClick={() => write('Disable paid upkeep', 'setPaidUpkeepEnabled', [false])}>Disable paid upkeep</button>}
      <button className="btn sec" disabled={!!tx.busy} onClick={() => write('Run unpaid maintenance', 'performUpkeepUnpaid')}>Run unpaid maintenance</button>
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
    <p className="note" style={{ marginTop: 12 }}>Legacy pools change policy after a two-day delay. Re-enabling paid upkeep uses the same proposal.</p>
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
const SOURCE = ['Following the factory', "This pool's own values", 'Pinned'];
const SOURCE_NOTE = [
  'Factory changes apply to this pool immediately.',
  'Factory changes do not apply to this pool.',
  'Every economic value stays as pinned until you follow the factory again. Factory changes do not apply to this pool.',
];

type Unit = 'address' | 'eth' | 'gwei' | 'gas';
const FIELDS: readonly [keyof Economics & string, string, Unit][] = [
  ['policy', 'Pricing policy', 'address'],
  ['workFee', 'Work fee per reconciled draw and listed Shape', 'eth'],
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
];
const showField = (e: Economics, key: keyof Economics, unit: Unit) => {
  const v = e[key];
  return unit === 'eth' ? formatEther(v as bigint) : unit === 'gwei' ? formatGwei(v as bigint) : String(v);
};
const display = (e: Economics, key: keyof Economics, unit: Unit) =>
  unit === 'address' ? short(String(e[key])) : unit === 'gas' ? `${num(Number(e[key]))} gas` : unit === 'eth' ? ethx(e[key] as bigint) : gweix(e[key] as bigint);
/** A field typed in its unit, within its on-chain width; undefined when invalid. */
function parseField(text: string, unit: Unit): string | bigint | number | undefined {
  const s = text.trim();
  try {
    if (unit === 'address') return /^0x[0-9a-fA-F]{40}$/.test(s) ? s : undefined;
    if (unit === 'gas') return /^\d+$/.test(s) && BigInt(s) <= U32 ? Number(s) : undefined;
    if (!/^\d*\.?\d+$/.test(s)) return undefined;
    const v = unit === 'eth' ? parseEther(s) : parseGwei(s);
    return v <= U64 ? v : undefined;
  } catch { return undefined; }
}
const parseEth = (text: string) => /^\d*\.?\d+$/.test(text.trim()) ? parseEther(text.trim()) : undefined;

function EconomicsRows({ e, version }: { e: Economics; version?: bigint }) {
  return <>
    {FIELDS.map(([key, label, unit]) => <div className="kv" key={key}>
      <span className="k">{label}</span>
      <span title={unit === 'address' ? String(e[key]) : undefined}>{display(e, key, unit)}{key === 'policy' && version !== undefined ? ` · V${version}` : ''}</span>
    </div>)}
    <div className="kv"><span className="k">Maximum payment per call</span><span>{ethx(maxPaymentOf(e))}</span></div>
    <div className="kv"><span className="k">Maximum restocking charge per Shape</span><span>{ethx(maxSurchargeOf(e))}</span></div>
  </>;
}

type KeeperView = { balancer: Address; keeper: Keeper; paidUpkeepEnabled: boolean; version?: bigint; policyUnavailable: boolean; restockFee?: bigint };

/** Keeper economics (follow, local, pinned), paid upkeep and the spending bucket of a current-factory pool. */
export function KeeperEconomics({ d, tx }: { d: KeeperView; tx: Tx }) {
  const k = d.keeper;
  const [editing, setEditing] = useState(false);
  const write = (label: string, functionName: string, args: unknown[] = [], value?: bigint) =>
    tx.send(label, [() => tx.write({ address: d.balancer, abi: poolBalancerAbi, functionName, args, ...(value ? { value } : {}) })]);
  const deposit = (amount: bigint) => amount > 0n &&
    <button className="btn sec" disabled={!!tx.busy} onClick={() => write('Deposit ETH', 'depositETH', [], amount)}>Deposit {formatEther(amount)} ETH</button>;
  const followNeed = toDeposit(d.paidUpkeepEnabled, k.current, k.follow);
  return <>
    <div className="section">
      <h2 className="h3">Keeper economics</h2>
      <div className="kv"><span className="k">Source</span><span>{SOURCE[k.source] ?? `Unknown (${k.source})`}</span></div>
      <p className="note">{SOURCE_NOTE[k.source]}</p>
      {d.policyUnavailable && <p className="note error" role="alert">Policy quotes unavailable.</p>}
      <EconomicsRows e={k.economics} version={d.version} />
      <div className="kv"><span className="k">0.01 ETH Shape restocking charge now</span><span>{d.restockFee === undefined ? 'Unavailable' : ethx(d.restockFee)}</span></div>
      <div className="kv"><span className="k">Maintenance budget</span><span>{ethx(k.current.required)}</span></div>
      {d.paidUpkeepEnabled && k.current.shortfall > 0n && <div style={{ marginTop: 12 }}>
        <p className="note error" role="alert">Operating ETH is {ethx(k.current.shortfall)} below the maintenance budget. Paid upkeep pays only from operating ETH and the spending bucket. Unpaid upkeep, claims and recovery stay available.</p>
        {deposit(k.current.shortfall)}
      </div>}
      <div className="row" style={{ gap: 16, marginTop: 16 }}>
        {k.source !== 0 && <button className="btn" disabled={!!tx.busy || followNeed > 0n} onClick={() => write('Follow factory economics', 'followFactoryEconomics')}>Follow factory</button>}
        {k.source !== 2 && <button className="btn sec" disabled={!!tx.busy} onClick={() => write('Pin keeper economics', 'pinEconomics')}>Pin current values</button>}
        <button className="btn sec" onClick={() => setEditing(!editing)}>{editing ? 'Cancel editing' : 'Edit local values'}</button>
      </div>
      <p className="note" style={{ marginTop: 12 }}>Following applies factory changes immediately. Pinning keeps every current value, including the pricing policy. Editing makes the values this pool's own. Paid upkeep and the spending bucket stay as they are.</p>
      {k.source !== 0 && <details style={{ marginTop: 16 }}>
        <summary className="disclose quiet">Factory values now</summary>
        <EconomicsRows e={k.factoryEconomics} />
        <div className="kv"><span className="k">Maintenance budget when following</span><span>{ethx(k.follow.required)}</span></div>
        {followNeed > 0n && <div style={{ marginTop: 12 }}><p className="note error">Following needs {ethx(followNeed)} more operating ETH first.</p>{deposit(followNeed)}</div>}
      </details>}
      {editing && <LocalEconomicsForm key={FIELDS.map(([key]) => String(k.economics[key])).join()} d={d} tx={tx} write={write} deposit={deposit} />}
    </div>
    <PaidUpkeep d={d} tx={tx} write={write} deposit={deposit} />
    <KeeperBucket key={`${k.capacity}-${k.refill}`} d={d} tx={tx} write={write} />
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
  }, [candidateKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const next = funding?.key === candidateKey ? funding : undefined;
  const need = next?.next ? toDeposit(d.paidUpkeepEnabled, k.current, next.next) : 0n;
  const unchanged = !!candidate && k.source === 1 && sameEconomics(candidate, k.economics);
  const policyOnly = !!candidate && !sameEconomics(candidate, k.economics) && sameEconomics({ ...k.economics, policy: candidate.policy }, candidate);
  const save = () => candidate && (policyOnly
    ? write('Change pricing policy', 'setKeeperPolicy', [candidate.policy])
    : write('Set local keeper economics', 'setLocalEconomics', [candidate]));
  return <div style={{ marginTop: 20 }}>
    <datalist id="known-policies">{[...new Set([k.economics.policy, k.factoryEconomics.policy])].map((p) => <option key={p} value={p} />)}</datalist>
    {FIELDS.map(([key, label, unit]) => <div key={key} style={{ marginTop: 12 }}>
      <label htmlFor={`econ-${key}`} className="form-label">{label}</label>
      <div className="field">
        <input id={`econ-${key}`} className={unit === 'address' ? 'mono' : undefined} list={unit === 'address' ? 'known-policies' : undefined} inputMode={unit === 'address' ? undefined : 'decimal'}
          spellCheck={false} autoComplete="off" value={text[key]} onChange={(ev) => setText({ ...text, [key]: ev.target.value })} />
        {unit !== 'address' && <span className="u">{unit === 'eth' ? 'ETH' : unit === 'gwei' ? 'GWEI' : 'GAS'}</span>}
      </div>
    </div>)}
    {invalid.length > 0 && <p className="note error" style={{ marginTop: 12 }}>Check: {invalid.join(', ')}.</p>}
    {candidate && <div style={{ marginTop: 16 }}>
      <div className="kv"><span className="k">Maximum payment per call</span><span>{ethx(maxPaymentOf(candidate))}</span></div>
      <div className="kv"><span className="k">Maximum restocking charge per Shape</span><span>{ethx(maxSurchargeOf(candidate))}</span></div>
      <div className="kv"><span className="k">Maintenance budget</span><span>{next?.next ? ethx(next.next.required) : next?.error ? 'Unavailable' : 'Checking…'}</span></div>
      {need > 0n && <div style={{ marginTop: 12 }}><p className="note error">These values need {ethx(need)} more operating ETH first.</p>{deposit(need)}</div>}
    </div>}
    <button className="btn" style={{ marginTop: 16 }} disabled={!!tx.busy || !candidate || unchanged || !next?.next || need > 0n} onClick={save}>{policyOnly ? 'Use this pricing policy' : 'Save local values'}</button>
    <p className="note" style={{ marginTop: 12 }}>Saved values apply immediately and factory changes stop applying to this pool. Existing listings keep their prices. A larger maintenance budget needs operating ETH first; missing prizes do not.</p>
  </div>;
}

function PaidUpkeep({ d, tx, write, deposit }: { d: KeeperView; tx: Tx } & Writers) {
  const k = d.keeper;
  // Re-enabling compares the effective maintenance budget against no paid exposure.
  const enableNeed = d.paidUpkeepEnabled ? 0n : k.current.shortfall;
  return <div className="section">
    <h2 className="h3">Paid upkeep</h2>
    <div className="kv"><span className="k">Paid upkeep</span><span>{d.paidUpkeepEnabled ? 'Enabled' : 'Disabled'}</span></div>
    <div className="row" style={{ gap: 16, marginTop: 16 }}>
      {d.paidUpkeepEnabled
        ? <button className="btn sec" disabled={!!tx.busy} onClick={() => write('Disable paid upkeep', 'setPaidUpkeepEnabled', [false])}>Disable paid upkeep</button>
        : <button className="btn" disabled={!!tx.busy || enableNeed > 0n} onClick={() => write('Enable paid upkeep', 'setPaidUpkeepEnabled', [true])}>Enable paid upkeep</button>}
      <button className="btn sec" disabled={!!tx.busy} onClick={() => write('Run unpaid maintenance', 'performUpkeepUnpaid')}>Run unpaid maintenance</button>
    </div>
    {enableNeed > 0n && <div style={{ marginTop: 12 }}><p className="note error">Enabling needs {ethx(enableNeed)} more operating ETH first.</p>{deposit(enableNeed)}</div>}
    <p className="note" style={{ marginTop: 12 }}>Disabling takes effect immediately. A disable stays through factory updates, policy changes and pinning. Only the creator can enable it again.</p>
  </div>;
}

function KeeperBucket({ d, tx, write }: { d: KeeperView; tx: Tx } & Pick<Writers, 'write'>) {
  const k = d.keeper;
  const [cap, setCap] = useState(formatEther(k.capacity));
  const [perDay, setPerDay] = useState(formatEther(k.refill * DAY));
  const capWei = parseEth(cap);
  const dayWei = parseEth(perDay);
  // The contract stores wei per second: an ETH-per-day entry rounds down to whole wei per second.
  const refill = dayWei === undefined ? undefined : dayWei / DAY;
  const ok = capWei !== undefined && capWei <= U128 && refill !== undefined && refill <= U96;
  const changed = ok && (capWei !== k.capacity || refill !== k.refill);
  return <div className="section">
    <h2 className="h3">Spending bucket</h2>
    <div className="kv"><span className="k">Capacity</span><span>{ethx(k.capacity)}</span></div>
    <div className="kv"><span className="k">Refill</span><span title={`${k.refill} wei per second`}>{ethx(k.refill * DAY)} per day</span></div>
    <div className="kv"><span className="k">Available now</span><span>{ethx(k.available)}</span></div>
    <label htmlFor="bucket-cap" className="form-label" style={{ marginTop: 16, display: 'block' }}>Capacity</label>
    <div className="field"><input id="bucket-cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} /><span className="u">ETH</span></div>
    <label htmlFor="bucket-refill" className="form-label" style={{ marginTop: 12, display: 'block' }}>Refill per day</label>
    <div className="field"><input id="bucket-refill" inputMode="decimal" value={perDay} onChange={(e) => setPerDay(e.target.value)} /><span className="u">ETH / DAY</span></div>
    {ok && refill! * DAY !== dayWei && <p className="note" style={{ marginTop: 8 }}>Stored as {refill!.toString()} wei per second: {formatEther(refill! * DAY)} ETH per day.</p>}
    {!ok && <p className="note error" style={{ marginTop: 8 }}>Enter amounts in ETH.</p>}
    <button className="btn" style={{ marginTop: 16 }} disabled={!!tx.busy || !changed} onClick={() => write('Change spending bucket', 'setKeeperBucket', [capWei, refill])}>Apply</button>
    <p className="note" style={{ marginTop: 12 }}>The bucket limits how fast paid upkeep spends. A change first adds the time since the last update at the old rate, keeps spent allowance spent and lowers the available allowance to a lower capacity. A higher capacity adds no allowance. The new rate applies from the change.</p>
  </div>;
}
