import { useState } from 'react';
import { usePublicClient } from 'wagmi';
import { formatEther, formatGwei, parseEther, parseGwei, type Address, type Hash, type Hex } from 'viem';
import { packManagerAbi, packVaultAbi } from '../../shared/main-pool-abi';
import { GAS_FIELDS, type Params } from './main-pool';
import { explain } from './errors';
import type { TransactionStep } from './tx';

type Tx = { busy?: string; send(label: string, steps: TransactionStep[]): Promise<boolean>; write(params: Record<string, unknown>): Promise<Hash> };
type Field = { key: Exclude<keyof Params, 'gasSchedule' | 'acceptedMintFee'>; label: string; unit: 'bps' | 'count' | 'ETH' | 'gwei' };
const FIELDS: Field[] = [
  { key: 'backingRatioBps', label: 'Backing ratio', unit: 'bps' },
  { key: 'upliftBoundBps', label: 'Maximum unresolved keep uplift', unit: 'bps' },
  { key: 'renewalFloatCount', label: 'Replacement packs held as renewal float', unit: 'count' },
  { key: 'reserve', label: 'Maintenance reserve', unit: 'ETH' },
  { key: 'minDeposit', label: 'Minimum deposit', unit: 'ETH' },
  { key: 'minDistribution', label: 'Minimum distribution', unit: 'ETH' },
  { key: 'tvlCap', label: 'Deposit cap', unit: 'ETH' },
  { key: 'minEdgeBps', label: 'Minimum selection edge', unit: 'bps' },
  { key: 'bufferBps', label: 'Listing buffer', unit: 'bps' },
  { key: 'distributionBps', label: 'Gain distribution', unit: 'bps' },
  { key: 'payMarkupBps', label: 'Routine keeper gas markup', unit: 'bps' },
  { key: 'keeperShareBps', label: 'Maximum optional payment share', unit: 'bps' },
  { key: 'gasCeiling', label: 'Routine gas ceiling', unit: 'gwei' },
  { key: 'essentialCeiling', label: 'Exit gas ceiling', unit: 'gwei' },
  { key: 'maxTip', label: 'Priority allowance', unit: 'gwei' },
  { key: 'workFee', label: 'Fee per verified service unit', unit: 'ETH' },
  { key: 'routineCap', label: 'Routine spending capacity', unit: 'ETH' },
  { key: 'routineRate', label: 'Routine refill per day', unit: 'ETH' },
  { key: 'essentialCap', label: 'Exit spending capacity', unit: 'ETH' },
  { key: 'essentialRate', label: 'Exit refill per day', unit: 'ETH' },
];
const label = (key: string) => key.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`);
export function settingsDraft(params: Params): Record<string, string> {
  return Object.fromEntries([
    ...FIELDS.map((f) => [f.key, f.unit === 'ETH' ? formatEther(params[f.key] as bigint)
      : f.unit === 'gwei' ? formatGwei(params[f.key] as bigint) : String(params[f.key])]),
    ['renewalMode', String(params.renewalMode)], ['packUnitsMask', String(params.packUnitsMask)],
    ...GAS_FIELDS.map((key) => [`gas.${key}`, String(params.gasSchedule[key])]),
  ]);
}
export function parseSettings(draft: Record<string, string>, current: Params): Params {
  const next = { ...current, gasSchedule: { ...current.gasSchedule } };
  for (const f of FIELDS) {
    const text = draft[f.key]?.trim();
    if (!text || !/^\d+(\.\d+)?$/.test(text)) throw new Error(`Enter a nonnegative ${f.label.toLowerCase()}.`);
    const precision = f.unit === 'ETH' ? 18 : f.unit === 'gwei' ? 9 : 0;
    if ((text.split('.')[1]?.length ?? 0) > precision) throw new Error(`${f.label} has too many decimal places.`);
    const value = f.unit === 'ETH' ? parseEther(text) : f.unit === 'gwei' ? parseGwei(text) : BigInt(text);
    if (typeof current[f.key] === 'number' && value > 0xffffffffn) throw new Error(`${f.label} exceeds its supported range.`);
    (next as unknown as Record<string, unknown>)[f.key] = typeof current[f.key] === 'number' ? Number(value) : value;
  }
  next.renewalMode = Number(draft.renewalMode);
  if (next.renewalMode !== 0 && next.renewalMode !== 1) throw new Error('Choose a renewal mode.');
  next.packUnitsMask = BigInt(draft.packUnitsMask);
  if (next.packUnitsMask < 0n || next.packUnitsMask >> 31n || next.packUnitsMask & 7n) throw new Error('Choose pack sizes from 0.03 to 0.30 ETH.');
  for (const key of GAS_FIELDS) {
    const value = draft[`gas.${key}`];
    if (!/^\d+$/.test(value ?? '') || BigInt(value) > 0xffffffffn) throw new Error(`Enter a gas allowance from 0 to 4,294,967,295 for ${label(key)}.`);
    next.gasSchedule[key] = Number(value);
  }
  return next;
}

export function MainPoolSettings({ address, vault = false, params, configHash, mintFee, tx, enabled }: {
  address: Address; vault?: boolean; params: Params; configHash: Hex; mintFee: bigint; tx: Tx; enabled: boolean;
}) {
  const pub = usePublicClient();
  const [draft, setDraft] = useState(() => settingsDraft(params));
  const [review, setReview] = useState<{ params: Params; hash: Hex }>();
  const [error, setError] = useState<string>();
  const abi = vault ? packVaultAbi : packManagerAbi;
  const change = (key: string, value: string) => { setDraft((d) => ({ ...d, [key]: value })); setReview(undefined); setError(undefined); };
  const reviewChanges = () => {
    try { setReview({ params: parseSettings(draft, params), hash: configHash }); setError(undefined); }
    catch (e) { setError(explain(e)); }
  };
  const save = () => review && tx.send('Save account settings', [async () => {
    const live = await pub!.readContract({ address, abi, functionName: 'configurationHash' as never });
    if (live !== review.hash) throw new Error('The account settings or live mint fee changed. Refresh and review again.');
    return tx.write({ address, abi, functionName: 'setParams', args: [review.params, review.hash] });
  }]).then((ok) => { if (ok) setReview(undefined); });
  const mask = (() => { try { return BigInt(draft.packUnitsMask); } catch { return 0n; } })();
  return <details className="group mp-settings">
    <summary className="group-head"><h2>Owner settings</h2></summary>
    <div className="group-body">
      <p className="note">Changes apply immediately. Raising spending capacity supplies no ETH and does not refill spent allowance.</p>
      <p className="note">70,000 bps backing and 25 bps uplift are provisional local evaluation settings.</p>
      <div className="kv"><span className="k">Live mint fee per Shape</span><span>{formatEther(mintFee)} ETH</span></div>
      <div className="kv"><span className="k">Accepted mint fee maximum</span><span>{formatEther(params.acceptedMintFee)} ETH</span></div>
      <button className="btn sec" disabled={!enabled || !!tx.busy || params.acceptedMintFee === mintFee} onClick={() =>
        tx.send('Accept current mint fee', [() => tx.write({ address, abi, functionName: 'acceptMintFee', args: [mintFee, configHash] })])}>
        Accept {formatEther(mintFee)} ETH per fresh Shape
      </button>
      <p className="note">Fresh replacement pays a mint fee for every new Shape. Reusing returned packs pays no new primary mint fee.</p>
      <label className="ctl" htmlFor={`renewal-${address}`}>Renewal mode</label>
      <select id={`renewal-${address}`} className="input" disabled={!enabled || !!tx.busy} value={draft.renewalMode} onChange={(e) => change('renewalMode', e.target.value)}>
        <option value="0">Fresh after acquisition</option><option value="1">Reuse returned packs</option>
      </select>
      <fieldset disabled={!enabled || !!tx.busy}>
        <legend>Allowed fresh pack values</legend>
        <p className="note">No sizes selected disables fresh builds. Existing inventory keeps its actual contents.</p>
        {Array.from({ length: 28 }, (_, i) => i + 3).map((units) => <label key={units} style={{ display: 'inline-block', margin: '6px 12px 6px 0' }}>
          <input type="checkbox" checked={!!(mask & (1n << BigInt(units)))} onChange={(e) => change('packUnitsMask', String(e.target.checked ? mask | (1n << BigInt(units)) : mask & ~(1n << BigInt(units))))} /> {(units / 100).toFixed(2)} ETH
        </label>)}
      </fieldset>
      <div className="kvs">{FIELDS.filter((f) => vault || !['minDeposit', 'minDistribution', 'distributionBps', 'tvlCap'].includes(f.key)).map((f) =>
        <label className="kv" key={f.key}><span className="k">{f.label} ({f.unit})</span>
          <input className="input" inputMode="decimal" disabled={!enabled || !!tx.busy} value={draft[f.key]} onChange={(e) => change(f.key, e.target.value)} />
        </label>)}</div>
      <details><summary>Quoted gas schedule</summary><p className="note">Allowances price verified work. They do not change transaction work limits.</p>
        {GAS_FIELDS.map((key) => <label className="kv" key={key}><span className="k">{label(key)} (gas)</span>
          <input className="input" inputMode="numeric" disabled={!enabled || !!tx.busy} value={draft[`gas.${key}`]} onChange={(e) => change(`gas.${key}`, e.target.value)} />
        </label>)}
      </details>
      <div className="acts"><button className="btn sec" disabled={!enabled || !!tx.busy} onClick={reviewChanges}>Review settings</button>
        <button className="link" disabled={!!tx.busy} onClick={() => { setDraft(settingsDraft(params)); setReview(undefined); setError(undefined); }}>Reset to current</button></div>
      {review && <div role="status"><table><thead><tr><th>Setting</th><th>Current</th><th>Reviewed</th></tr></thead><tbody>
        {Object.entries(settingsDraft(review.params)).filter(([key, value]) => settingsDraft(params)[key] !== value).map(([key, value]) =>
          <tr key={key}><th>{FIELDS.find((f) => f.key === key)?.label ?? label(key.replace('gas.', 'Gas '))}</th><td>{settingsDraft(params)[key]}</td><td>{value}</td></tr>)}
        </tbody></table><p className="note">Reviewed at configuration {review.hash.slice(0, 12)}. Accepted mint fee remains {formatEther(review.params.acceptedMintFee)} ETH.</p>
        {review.hash !== configHash && <p className="note error">Configuration changed. Review again.</p>}
        <button className="btn" disabled={!enabled || !!tx.busy || review.hash !== configHash} onClick={save}>Save reviewed settings</button></div>}
      {error && <p role="alert" className="note error">{error}</p>}
    </div>
  </details>;
}
