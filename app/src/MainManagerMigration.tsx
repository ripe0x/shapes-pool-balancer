import { useState } from 'react';
import { getAddress, parseEther, type Address } from 'viem';
import { CallerFundedExit } from './MainPoolExit';
import type { Migration } from './main-manager-migration';

export function MainManagerMigration({ source, owner, enabled, refresh }: { source: Address; owner: Address; enabled: boolean; refresh: () => void }) {
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('0');
  const [ids, setIds] = useState('');
  const [migration, setMigration] = useState<Migration>();
  const [error, setError] = useState<string>();
  const configure = () => {
    try {
      const parsed = ids.trim() ? ids.trim().split(/[\s,]+/).map((id) => { if (!/^\d+$/.test(id)) throw new Error('Enter numeric pack IDs.'); return String(BigInt(id)); }) : [];
      if (parsed.length > 16 || new Set(parsed).size !== parsed.length) throw new Error('Supply at most 16 distinct held pack IDs.');
      const value = parseEther(amount);
      if (value < 0n) throw new Error('Enter a nonnegative ETH transfer.');
      const target = getAddress(destination);
      if (target.toLowerCase() === source.toLowerCase()) throw new Error('Choose a different destination manager.');
      setMigration({ destination: target, ethAmount: String(value), ethSent: false, packIds: parsed, manualIds: parsed }); setError(undefined);
    } catch (e) { setError((e as Error).message); }
  };
  return <div className="group mp-settings"><div className="group-head"><h2>Move packs to another manager</h2></div><div className="group-body">
    <p className="note">Both managers must belong to you and use the configured official factory. Packs keep their existing Shapes. Both managers must leave exit mode first. Listings pause at both ends until you choose to resume them. Only sealed canonical packs with at most 30 Shapes can be imported. Withdrawn packs remain at the destination before import.</p>
    <p className="note">The wallet ETH amount uses one signed nonce. Matching replacements remain possible; a reverted attempt is not retried automatically at a new nonce.</p>
    <label className="ctl">Destination manager<input className="input" aria-label="Destination manager" value={destination} disabled={!enabled || !!migration} onChange={(e) => setDestination(e.target.value)} /></label>
    <label className="ctl">Wallet ETH to transfer after migration<input className="input" aria-label="Wallet ETH to transfer after migration" inputMode="decimal" value={amount} disabled={!enabled || !!migration} onChange={(e) => setAmount(e.target.value)} /></label>
    <label className="ctl">Already held destination pack IDs (optional, up to 16)<input className="input" aria-label="Already held destination pack IDs" value={ids} disabled={!enabled || !!migration} onChange={(e) => setIds(e.target.value)} /></label>
    <button className="btn sec" disabled={!enabled || !!migration} onClick={configure}>Review migration destination</button>
    {migration && <button className="link" onClick={() => setMigration(undefined)}>Edit reviewed migration details</button>}
    {error && <p className="note error" role="alert">{error}</p>}
    {migration && <CallerFundedExit key={`${source}:${migration.destination}`} manager migration={migration} vault={source} holder={owner} enabled={enabled} refresh={refresh} />}
  </div></div>;
}
