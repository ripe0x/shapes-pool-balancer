import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the exact storage helpers from the candidate in separate contexts (like two tabs),
// using Node's native Web Storage API and no supplied RPC answers.
const source = readFileSync(new URL('../../app/src/App.tsx', import.meta.url), 'utf8');
const start = source.indexOf('const loadPending =');
const end = source.indexOf('\nfunction useTx(', start);
assert(start >= 0 && end > start);
const helpers = ts.transpileModule(`${source.slice(start, end)}\nexport { loadPending, savePending };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tab = () => {
  const realm = { exports: {}, localStorage };
  vm.runInNewContext(helpers, realm);
  return realm.exports;
};
const a = tab();
const b = tab();
const key = 'pending-transfer:31337:0x00000000000000000000000000000000000d0e03:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const first = { hash: `0x${'11'.repeat(32)}`, chainId: 31337, from: '0x00000000000000000000000000000000000d0e03', to: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', nonce: 0 };
const second = { ...first, hash: `0x${'22'.repeat(32)}`, nonce: 1 };

localStorage.clear();
assert.equal(a.loadPending(key), undefined);
assert.equal(b.loadPending(key), undefined);
a.savePending(key, first);
b.savePending(key, second);
assert.equal(a.loadPending(key).hash, second.hash);
console.log('Two contexts read empty storage before either wrote; second save replaced the first hash.');

localStorage.clear();
assert.equal(a.loadPending(key), undefined);
assert.equal(b.loadPending(key), undefined);
console.log('After clearing real Web Storage, both contexts return no pending transfer.');

assert(source.includes('if (earlier && await transferUnresolved(pub!, earlier))'));
assert(source.indexOf('const earlier = loadPending(key)') < source.indexOf('const hash = await writeContractAsync(prepared as never)'));
assert(source.indexOf('const hash = await writeContractAsync(prepared as never)') < source.indexOf('if (key) savePending(key,'));
console.log('Candidate useTx.write checks the record before wallet submission and saves only afterward.');
