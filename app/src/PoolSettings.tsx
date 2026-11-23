// Pool settings outside keeper economics: purchase pauses (fill gate, backlog), product limits and the legacy route.
import { useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { formatEther, type Abi, type Address, type Hash } from 'viem';
import { balancerFactoryAbi, poolBalancerAbi } from '../../shared/abi';
import { MAX_BATCH, pendingDrawsAdmitted, unpackPlan } from '../../shared/planner';
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
