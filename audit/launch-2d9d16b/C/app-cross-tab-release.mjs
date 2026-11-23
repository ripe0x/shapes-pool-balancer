import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the repair candidate's exact storage helpers in two tab contexts against
// Node's native Web Storage. No RPC response or protocol party is supplied.
const source = readFileSync(new URL('../../app/src/App.tsx', import.meta.url), 'utf8');
const start = source.indexOf('const NO_STORAGE =');
const end = source.indexOf('\nfunction useTx(', start);
assert(start >= 0 && end > start);
const helpers = ts.transpileModule(`${source.slice(start, end)}\nexport { loadPending, savePending, releasePending };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tab = () => {
  const realm = { exports: {}, localStorage };
  vm.runInNewContext(helpers, realm);
  return realm.exports;
};

localStorage.clear();
const a = tab();
const b = tab();
const key = 'pending-transfer:31337:0x00000000000000000000000000000000000d0e03:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const since = Date.now(); // two tabs can reserve within the same millisecond
const first = { chainId: 31337, from: '0x00000000000000000000000000000000000d0e03',
  to: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', since };
const second = { ...first, hash: `0x${'22'.repeat(32)}` };

assert.equal(a.loadPending(key), undefined);
assert.equal(b.loadPending(key), undefined);
a.savePending(key, first);
b.savePending(key, second);
assert.equal(a.loadPending(key).hash, second.hash);

// Tab A's wallet rejects after tab B has a pending transfer. The catch path in
// useTx.write calls releasePending(key, since); the guard compares no tab ID.
assert(source.includes('if (key) releasePending(key, since);'));
a.releasePending(key, since);
assert.equal(b.loadPending(key), undefined);
console.log(JSON.stringify({ sameMillisecondReservation: true, secondHashBeforeError: second.hash,
  recordAfterFirstTabWalletError: null, secondTransferCanStillBePending: true }));
