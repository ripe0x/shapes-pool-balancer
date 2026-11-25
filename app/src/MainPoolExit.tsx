import { useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { formatEther, parseEther, type Abi, type Address, type Hash } from 'viem';
import { packVaultAbi } from '../../shared/main-pool-abi';
import { useTx } from './App';
import { creationNotSubmitted } from './creation';
import { explain } from './errors';
import { chain } from './chain';
import { assertMigrationIntent, assertMigrationReady, changeMigrationDetails, migrationPendingContext, migrationReviewIntent, migrationSpendKey, reconcileMigration, reviewMigration, validateMigration, type Migration } from './main-manager-migration';
import { assertExitReplacementNonce, exitSpendKey, parseSpend, readContributions, reserveExitReplacement, reserveExitSpend, reviewExit, settleExitSpend, signedExitMaximum, withExitSpendLock, type ExitReview, type SavedExitSpend } from './main-pool-exit';
import { assertTransactionIntent, reviewedIntent } from './tx';
import { managerExitSpendKey, reviewManagerExit, requireManagerQueueProgress, validateManagerExitIntent, validateManagerExitPending } from './main-manager-exit';

export function CheckpointContributions({ vault, payer, refresh }: { vault: Address; payer: Address; refresh: () => void }) {
  const pub = usePublicClient();
  const tx = useTx(() => { load(); refresh(); });
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Awaited<ReturnType<typeof readContributions>>>();
  const [error, setError] = useState<string>();
  const load = () => pub && readContributions(pub, vault, payer, page).then((result) => { setData(result); setError(undefined); }).catch((e) => setError(explain(e)));
  useEffect(() => {
    let live = true;
    const run = () => pub && readContributions(pub, vault, payer, page).then((result) => { if (live) { setData(result); setError(undefined); } }).catch((e) => { if (live) setError(explain(e)); });
    void run();
    const timer = setInterval(() => { if (!document.hidden) void run(); }, 30000);
    return () => { live = false; clearInterval(timer); };
  }, [pub, vault, payer, page]);
  const claimable = data?.rows.filter((c) => c.refund > 0n) ?? [];
  return <details className="group mp-contributions"><summary className="group-head"><h2>Checkpoint contributions and refunds</h2></summary><div className="group-body">
    <p className="note">Contributions remain separate from deposit principal. Unused sponsorship belongs to its payer after the era closes.</p>
    {data?.rows.map((c) => <div className="kv" key={String(c.id)}><span className="k">Contribution {c.id.toString()} · era {c.era.toString()}</span>
      <span>{formatEther(c.amount)} ETH · {c.claimed ? 'claimed' : c.closed ? `${formatEther(c.refund)} ETH refundable` : 'funding pending work'}</span></div>)}
    {data && !data.complete && <p className="note">Loading contribution history through block {data.through.toString()}. Each refresh reads a bounded block range.</p>}
    {data?.complete && !data.knownCount && <p className="note">No contributions from this wallet.</p>}
    <div className="acts"><button className="btn sec" disabled={!!tx.busy || !claimable.length} onClick={() => tx.send('Claim checkpoint refunds', [() => tx.write({
      address: vault, abi: packVaultAbi as Abi, functionName: 'claimCheckpointRefund', args: [claimable.map((c) => c.id)],
    })])}>Claim {formatEther(claimable.reduce((total, c) => total + c.refund, 0n))} ETH</button>
      <button className="link" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous 16</button>
      <button className="link" disabled={!data || (page + 1) * 16 >= data.knownCount} onClick={() => setPage(page + 1)}>Next 16</button>
    </div>
    {(error || tx.msg) && <p className={`note${error || !tx.msg?.ok ? ' error' : ''}`} role="status">{error ?? tx.msg?.text}</p>}
  </div></details>;
}

export function CallerFundedExit({ vault, holder, refresh, manager = false, enabled = true, migration }: { vault: Address; holder: Address; refresh: () => void; manager?: boolean; enabled?: boolean; migration?: Migration }) {
  const pub = usePublicClient();
  const tx = useTx(refresh);
  const key = migration ? migrationSpendKey(chain.id, vault, holder, migration.destination) : (manager ? managerExitSpendKey : exitSpendKey)(chain.id, vault, holder);
  const formId = migration ? `migration-${vault}-${migration.destination}` : `exit-${vault}`;
  const readSaved = (): SavedExitSpend | undefined => {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as SavedExitSpend | null;
    if (!value) return undefined;
    if (value.chainId !== chain.id || value.vault.toLowerCase() !== vault.toLowerCase() || value.holder.toLowerCase() !== holder.toLowerCase()) throw new Error('Stored exit spending belongs to another account.');
    return value;
  };
  const [saved, setSaved] = useState<SavedExitSpend | undefined>(() => { try { return readSaved(); } catch { return undefined; } });
  const [limit, setLimit] = useState(() => saved ? formatEther(BigInt(saved.limit)) : '');
  const [review, setReview] = useState<ExitReview>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [recoveryHash, setRecoveryHash] = useState('');
  // Only callers holding the per-account Web Lock may mutate this durable record.
  const persist = (next: SavedExitSpend) => { localStorage.setItem(key, JSON.stringify(next)); setSaved(next); };
  const validatePending = async (current: SavedExitSpend) => {
    if (migration) {
      if (!current.migration || current.migration.destination.toLowerCase() !== migration.destination.toLowerCase()) throw new Error('The stored migration destination changed.');
      const facts = await validateMigration(pub!, vault, holder, current.migration.destination);
      if (current.pending) assertMigrationIntent(vault, holder, migrationPendingContext(current.migration, current.pending), facts.fwa, { from: holder, to: current.pending.to ?? vault, input: current.pending.input, value: BigInt(current.pending.value) });
    } else if (manager) await validateManagerExitPending(pub!, current);
    else if (current.pending?.to && current.pending.to.toLowerCase() !== vault.toLowerCase()) throw new Error('The pending vault exit targets another contract.');
  };
  const reconcileLocked = async (current: SavedExitSpend) => {
    await validatePending(current);
    const observed = migration ? await reconcileMigration(pub!, current) : current;
    const next = migration && observed.migration?.blocked ? observed : await settleExitSpend(pub!, observed);
    if (migration && (next.pending || next.migration?.blocked || next.migration?.recheck || next.migration?.anchor?.hash !== current.migration?.anchor?.hash)) setReview(undefined);
    if (next !== current) { persist(next); refresh(); }
    return next;
  };
  useEffect(() => {
    const updated = (event: StorageEvent) => {
      if (event.key !== key) return;
      try { setSaved(readSaved()); if (migration) setReview(undefined); } catch (e) { setError(explain(e)); }
    };
    window.addEventListener('storage', updated);
    return () => window.removeEventListener('storage', updated);
  }, [key]);
  useEffect(() => {
    if (!pub || (!migration && !saved?.pending?.hash)) return;
    let live = true;
    let polling = false;
    const run = () => {
      if (polling) return;
      polling = true;
      return withExitSpendLock(key, async () => {
      if (!live) return;
      const current = readSaved();
      if (current && (migration || current.pending?.hash)) await reconcileLocked(current);
      }).catch((e) => { if (live) { if (migration) setReview(undefined); setError(explain(e)); } }).finally(() => { polling = false; });
    };
    void run();
    const timer = setInterval(() => { void run(); }, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [pub, key, saved?.pending?.hash, !!migration]);
  const prepare = async () => {
    if (!pub || !enabled) return;
    setLoading(true); setError(undefined); setReview(undefined);
    try {
      const requested = parseEther(limit);
      if (requested <= 0n) throw new Error('Enter a positive total wallet spending limit.');
      const current = await withExitSpendLock(key, async () => {
        const durable = readSaved();
        let next = durable ? await reconcileLocked(durable) : { chainId: chain.id, vault, holder, limit: String(requested), debited: '0', temporaryFunding: '0', actualGas: '0', ...(migration ? { migration } : {}) };
        if (migration) assertMigrationReady(next);
        if (next.pending) throw new Error('The previous wallet step is unresolved. Its maximum debit remains reserved. Check your wallet before continuing.');
        if (requested < BigInt(next.debited)) throw new Error('The limit cannot be lower than signed maxima already reserved.');
        if (migration && next.migration) {
          const old = next.migration;
          const sameDetails = old.ethAmount === migration.ethAmount && JSON.stringify(old.manualIds ?? []) === JSON.stringify(migration.manualIds ?? []);
          if (!sameDetails) next = { ...next, migration: changeMigrationDetails(old, migration) };
        }
        if (migration && next.migration && (next.migration.proofCursor ?? 0) >= next.migration.packIds.length) next = { ...next, migration: { ...next.migration, proofCursor: 0 } };
        next = { ...next, limit: String(requested) };
        persist(next);
        return next;
      });
      if (migration) {
        await withExitSpendLock(key, async () => {
          const latest = readSaved()!;
          if (latest.pending) throw new Error('A wallet step is already pending.');
          const result = await reviewMigration(pub, vault, holder, parseSpend(latest), latest.migration!);
          if (result.migration) persist({ ...latest, migration: result.migration });
          if (result.checkedOnly) setError(result.checkMessage ?? 'Checked another bounded page of preserved packs. Review the next page to continue.');
          else setReview(result);
        });
      } else setReview(await (manager ? reviewManagerExit : reviewExit)(pub, vault, holder, parseSpend(current)));
    } catch (e) { setError(explain(e)); }
    finally { setLoading(false); }
  };
  const execute = async () => {
    if (!pub || !enabled || !review || review.done) return;
    setError(undefined); setLoading(true);
    try {
      await withExitSpendLock(key, async () => {
        const current = readSaved();
        if (!current) throw new Error('The durable spending review is unavailable. Review again.');
        const before = await reconcileLocked(current);
        if (migration) assertMigrationReady(before);
        const prepared = review.prepared;
        const intent = migration ? migrationReviewIntent(review) : reviewedIntent(prepared);
        if (migration) {
          const facts = await validateMigration(pub, vault, holder, migration.destination);
          assertMigrationIntent(vault, holder, before.migration!, facts.fwa, intent);
          const currentStep = await reviewMigration(pub, vault, holder, parseSpend(before), before.migration!);
          if (currentStep.done || currentStep.checkedOnly) throw new Error('Migration progress changed. Review the next bounded step again.');
          assertTransactionIntent(migrationReviewIntent(currentStep), intent);
          if (review.call.functionName === 'processAcquisitions') await requireManagerQueueProgress(pub, prepared);
        } else if (manager) {
          await validateManagerExitIntent(pub, vault, holder, reviewedIntent(prepared), true);
          if (prepared.address.toLowerCase() !== vault.toLowerCase()) await requireManagerQueueProgress(pub, prepared);
        }
        const minimumNonce = await pub.getTransactionCount({ address: holder, blockTag: 'pending' });
        const reserved = reserveExitSpend(before, review.reviewedLimit, review.maximumDebit, {
          id: crypto.randomUUID(), minimumNonce, maximumDebit: String(review.maximumDebit), value: String(prepared.value), input: intent.input, to: intent.to,
        });
        let pending = false;
        await tx.send(review.call.label, [async () => {
          try {
            const reserve = () => { persist(reserved); pending = true; };
            const hash = review.call.transfer ? await tx.transferReviewed(prepared as never, reserve) : await tx.write(prepared, reserve);
            let sent = { ...reserved, pending: { ...reserved.pending!, hash } };
            persist(sent);
            const transaction = await pub.getTransaction({ hash }).catch(() => undefined);
            if (transaction) {
              assertTransactionIntent({ chainId: sent.chainId, from: holder, to: sent.pending.to ?? vault, input: sent.pending.input, value: BigInt(sent.pending.value) }, transaction);
              sent = { ...sent, pending: { ...sent.pending, nonce: transaction.nonce } };
              persist(sent);
              persist(reserveExitReplacement(sent, signedExitMaximum(transaction)));
            }
            return hash;
          } catch (e) {
            if (pending && creationNotSubmitted(e)) persist(before);
            throw e;
          }
        }]);
        const after = readSaved();
        if (after?.pending?.hash) await reconcileLocked(after);
      });
    } catch (e) { setError(explain(e)); }
    finally { setReview(undefined); setLoading(false); }
  };
  const spend = saved ? parseSpend(saved) : undefined;
  const track = async () => {
    if (!pub || !enabled || !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash)) return;
    try {
      await withExitSpendLock(key, async () => {
        const current = readSaved();
        if (!current?.pending) throw new Error('No unresolved wallet step remains.');
        if (current.pending.id !== saved?.pending?.id) throw new Error('The pending wallet step changed. Refresh before tracking a transaction.');
        await validatePending(current);
        const transaction = await pub.getTransaction({ hash: recoveryHash as Hash });
        assertExitReplacementNonce(current.pending, transaction.nonce);
        assertTransactionIntent({ chainId: current.chainId, from: current.holder, to: current.pending.to ?? current.vault,
          input: current.pending.input, value: BigInt(current.pending.value) }, transaction);
        const bounded = reserveExitReplacement(current, signedExitMaximum(transaction));
        const next = { ...bounded, pending: { ...bounded.pending!, nonce: transaction.nonce, hash: recoveryHash as Hash } };
        persist(next); await reconcileLocked(next); setError(undefined);
      });
    } catch (e) { setError(explain(e)); }
  };
  const raisePendingLimit = async () => {
    try {
      const requested = parseEther(limit);
      await withExitSpendLock(key, async () => {
        const current = readSaved();
        if (!current?.pending) throw new Error('No pending wallet step remains. Review the next step instead.');
        if (requested <= BigInt(current.limit)) throw new Error('Enter an explicitly higher flow limit.');
        const next = { ...current, limit: String(requested) };
        persist(next);
        if (next.pending?.hash) await reconcileLocked(next);
      });
      setError(undefined);
    } catch (e) { setError(explain(e)); }
  };
  return <details className={`group mp-exit${migration ? ' mp-migration' : manager ? ' mp-manager-exit' : ''}`} id={migration ? formId : manager ? `manager-exit-${vault}` : undefined}><summary className="group-head"><h2>{migration ? 'Migrate packs intact' : manager ? 'Complete an owner-paid manager exit' : 'Complete a caller-funded withdrawal'}</h2></summary><div className="group-body">
    <p className="note">{migration ? `Packs move intact to ${migration.destination}. Source and destination listings pause. This flow never enables exit mode or redeems a pack. Each step requires your review. ETH transfer: ${formatEther(BigInt(saved?.migration?.ethAmount ?? migration.ethAmount))} ETH.` : manager ? 'You pay wallet gas to stop investment, recover settlements, process eligible FWA requests, unlist, redeem packs, collect earnings and withdraw ETH to your wallet. Each bounded step needs its own confirmation. FWA randomness, request deadlines and crown exit delays can require waiting.' : 'You pay wallet gas for bounded settlement, unlisting, pack redemption, checkpoints and claims. Each step requires its own confirmation. FWA settlement and quiet checkpoint windows can require waiting.'}</p>
    {!enabled && <p className="note error">Only the current owner can close this manager.</p>}
    <label className="ctl" htmlFor={`${formId}-limit`}>Total wallet debit limit (ETH)</label>
    <input id={`${formId}-limit`} className="input" inputMode="decimal" value={limit} disabled={!enabled || !!tx.busy || loading} onChange={(e) => { setLimit(e.target.value); setReview(undefined); }} />
    <p className="note">Every signed maximum stays reserved toward this limit, including reverted steps. Refunds, claims and lower observed gas do not replenish it.</p>
    <p className="note">The limit covers app-reviewed requests. Wallet changes already signed cannot be undone; a larger signed maximum blocks further steps until explicitly reviewed.</p>
    {spend && <div className="kvs">
      <div className="kv"><span className="k">Maximum reserved toward the limit</span><span>{formatEther(spend.debited)} ETH</span></div>
      <div className="kv"><span className="k">Gas expense observed in first receipts</span><span>{formatEther(spend.actualGas)} ETH</span></div>
      <div className="kv"><span className="k">ETH sent observed in first receipts</span><span>{formatEther(spend.temporaryFunding)} ETH</span></div>
      <p className="note">Observed amounts can change after a chain reorganization. The reserved maximum is retained.</p>
    </div>}
    {saved?.pending && <p className="note" role="status">{saved.pending.hash ? `Waiting for ${saved.pending.hash}.` : 'Wallet outcome is unknown. The maximum debit remains reserved. Check your wallet before another action.'}</p>}
    {saved?.pending && <div>
      <button className="btn sec" disabled={!enabled || loading || !!tx.busy} onClick={raisePendingLimit}>Raise the pending step's flow limit</button>
      <label className="ctl" htmlFor={`${formId}-hash`}>Transaction or replacement hash from your wallet</label>
      <input id={`${formId}-hash`} className="input" value={recoveryHash} onChange={(e) => setRecoveryHash(e.target.value)} spellCheck={false} />
      <button className="btn sec" disabled={!enabled || !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash)} onClick={track}>Track the reviewed transaction</button>
    </div>}
    <button className="btn sec" disabled={!enabled || loading || !!tx.busy || !!saved?.pending} onClick={prepare}>{loading ? 'Reviewing…' : migration ? 'Review next migration step' : manager ? 'Review next manager exit step' : 'Review next exit step'}</button>
    {review && (review.done ? <p className="note" role="status">{migration ? 'Migration complete for the tracked packs and reviewed ETH transfer. Destination listings remain under its owner’s control.' : manager ? 'Manager closeout complete: no booked packs, pending receipts, FWA earnings or ETH remain.' : 'No deposit, unlocked shares, redemption or priced claim remains. Check contribution refunds separately.'}</p>
      : <div role="status"><h3>{review.call.label}</h3>
        <div className="kv"><span className="k">Estimated wallet gas expense</span><span>{formatEther(review.expectedWalletGas)} ETH</span></div>
        <div className="kv"><span className="k">ETH sent</span><span>{formatEther(review.call.value ?? 0n)} ETH</span></div>
        <div className="kv"><span className="k">Maximum wallet debit for this step</span><span>{formatEther(review.maximumDebit)} ETH</span></div>
        <p className="note">Reviewed at block {review.reviewedBlock.toString()}. Required recovery runs even when keeper reimbursement would be unprofitable.</p>
        <button className="btn" disabled={!enabled || !!tx.busy || loading || !!saved?.pending} onClick={execute}>Confirm this bounded step</button>
      </div>)}
    {(error || tx.msg) && <p className={`note${error || !tx.msg?.ok ? ' error' : ''}`} role="status">{error ?? tx.msg?.text}</p>}
  </div></details>;
}
