# App repair re-attack: cross-tab reservation loss

**Repair revision:** `5b1fb2ccc6690041197c0e6e2f959375cc9e7577`; parent `2d9d16bf289817eff1831263e48c8b5412a3855f`. **Time:** 2026-11-23 01:29–01:31 UTC, about two minutes. This is an informed re-attack. I stopped after the first repair break, as instructed.

## Security finding — executed storage transition, wallet consequence reasoned

`app/src/App.tsx` uses `since = Date.now()` as the only identity for a tab's pending-transfer reservation. Two tabs can receive the same millisecond timestamp. If both read an empty slot before either writes, Tab A reserves, Tab B reserves and later saves its pending transaction hash, then Tab A's wallet rejects, A's catch calls `releasePending(key, since)`. That helper deletes the slot whenever the timestamp matches, even though B owns the latest record. The next ETH transfer sees no guard record while B's transfer may still be pending.

The [probe](app-cross-tab-release.mjs) extracts and executes the repair candidate's exact `loadPending`, `savePending` and `releasePending` implementations in separate JavaScript VM contexts against Node's native Web Storage. It asserts both initial reads are empty, B's hash is present after B saves, and A's release erases it. This is an executed interleaving of real storage operations, **not** an executed two-browser-wallet transfer. The test does not supply any RPC or protocol response. The likelihood of simultaneous millisecond timestamps and browser scheduling was not measured.

**ETH consequence at launch scale:** if B was sending 5 ETH to a Balancer, a subsequent 5 ETH transfer can be allowed. Under R73, the extra contribution is irrevocable pool capital and claimable surplus may go to the creator. The full 10 ETH transfer sequence was not executed here; that consequence follows from the earlier step A real-transfer witnesses plus this guard-loss transition. **Smallest fix:** give every reservation a collision-resistant per-attempt identifier and remove only the record with that exact identifier; also make reservation acquisition atomic across tabs so the two initial empty reads cannot both lead to wallet submission.

**Command:** `node --experimental-webstorage --localstorage-file=/private/tmp/fwa-launch-5b1fb2c-C/audit/launch-C/app-cross-tab-release.db audit/launch-C/app-cross-tab-release.mjs > audit/launch-C/app-cross-tab-release.log`; **exit 0**, 0.46 seconds. [Output](app-cross-tab-release.log) reports B's hash before A's error and no record afterward. The temporary Web Storage database is not needed for reproduction and can be removed after review. No Anvil, fork transaction, deployment, broadcast, commit or push was performed in this stopped slice.

## Other repair paths not reached

The higher-nonce wallet queue, reload, blocked/cleared storage, 24-hour expiry, wallet error without a second tab, and successful replacement/cancellation were not re-executed after this finding. They need a subsequent authorized re-attack after a fix. In particular, `transferState` returns `{ unresolved: false }` for a hashless, nonce-less record exactly at the 24-hour boundary; whether an actual pending transaction can then still mine was not tested here.

## Things that don't make sense

- A millisecond timestamp is used as ownership proof for another tab's reservation. It can collide, and the helper cannot tell which tab wrote the current record.
- The reservation read and write are separate storage calls, so two tabs may both pass the empty check before either wallet opens.
