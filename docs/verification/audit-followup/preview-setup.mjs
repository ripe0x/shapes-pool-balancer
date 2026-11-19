import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = '/private/tmp/fwa-credit-atomic';
const evidencePath = resolve(repository, 'docs/verification/creation-replacement/transactions.json');
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
const successful = evidence.records.find(r => r.label === 'same-calldata repriced successful atomic creation');
if (!successful?.original || !successful.replacementHash) throw new Error('Actual recorded successful replacement is required.');
process.env.VITE_CHAIN_ID = '31337';
process.env.VITE_RPC_URL = 'http://127.0.0.1:18795';
process.env.VITE_FACTORY = successful.original.factory;
process.env.VITE_FROM_BLOCK = '26382399';
process.env.VITE_DEV_ACCOUNT = successful.original.creator;

async function browserReview() {
  const { createPublicClient, http } = await import('viem');
  const { reviewedIntent, runTransactionSteps, confirmAction } = await import('/src/tx.ts');
  const { balancerFactoryAbi } = await import('/@fs/private/tmp/fwa-credit-atomic/shared/abi.ts');
  const evidence = await fetch('/action-evidence.json').then(r => r.json());
  const pub = createPublicClient({ transport: http('http://127.0.0.1:18795', { retryCount: 0 }), cacheTime: 0 });
  const cases = [
    { key: 'cancelled', label: 'Cancelled action', record: 'mined cancellation with live callback and reload', expected: 'rejected', count: 0 },
    { key: 'reverted', label: 'Reverted replacement', record: 'same-calldata repriced real revert with live callback and reload', expected: 'rejected', count: 0 },
    { key: 'repriced', label: 'Same-intent repricing', record: 'same-calldata repriced successful atomic creation', expected: 'confirmed', count: 1 },
    { key: 'unavailable', label: 'Included transaction unavailable', record: 'same-calldata repriced successful atomic creation', expected: 'unverified', count: 0, unavailable: true },
  ];
  const heading = document.getElementById('identity');
  heading.textContent = 'RPC http://127.0.0.1:18795 · checking real chain identity…';
  const chainId = await pub.getChainId();
  if (chainId !== 31337) throw new Error('Wrong local chain: ' + chainId);
  heading.textContent = 'RPC http://127.0.0.1:18795 · chain ' + chainId + ' · reads only';
  for (const item of cases) {
    const record = evidence.records.find(r => r.label === item.record);
    if (!record?.original || !record.replacementHash) throw new Error('Recorded case is missing: ' + item.key);
    const a = record.original;
    const intent = reviewedIntent({ account: a.creator, chainId: a.chainId, address: a.factory, abi: balancerFactoryAbi,
      functionName: 'createBalancer', args: [a.salt, { ...a.config, target: BigInt(a.config.target), mintFeeCap: BigInt(a.config.mintFeeCap) },
        a.curated.map(n => ({ ...n, tokenId: BigInt(n.tokenId), base: BigInt(n.base) }))], value: BigInt(a.value) });
    const section = document.createElement('section');
    const title = document.createElement('h2'); title.textContent = item.label; section.append(title);
    const original = document.createElement('p'); original.textContent = 'Reviewed original: ' + a.hash; section.append(original);
    const candidate = document.createElement('p'); candidate.textContent = 'Actual mined candidate: ' + record.replacementHash; section.append(candidate);
    const button = document.createElement('button'); button.textContent = 'Check ' + item.label.toLowerCase(); section.append(button);
    const output = document.createElement('pre'); output.id = 'result-' + item.key; output.setAttribute('aria-live', 'polite');
    output.textContent = 'Not run. Expected ' + item.expected + '; dependent steps ' + item.count + '.'; section.append(output);
    button.addEventListener('click', async () => {
      button.disabled = true; let dependentSteps = 0;
      output.textContent = 'Checking actual mined receipt and production confirmation…';
      const client = item.unavailable ? {
        getChainId: () => pub.getChainId(),
        waitForTransactionReceipt: parameters => pub.waitForTransactionReceipt(parameters),
        // The only injected behavior is an off-chain lookup failure. No successful answer is supplied.
        getTransaction: async () => { throw new Error('Deliberate included-transaction RPC failure'); },
      } : pub;
      let outcome = 'confirmed', message = 'Reviewed action confirmed.';
      try {
        await runTransactionSteps(item.label, [
          ['Inspect recorded mined candidate', async () => record.replacementHash],
          ['Dependent program step', async () => { dependentSteps++; return undefined; }],
        ], () => undefined, hash => confirmAction(client, hash, intent, 5000));
      } catch (error) {
        message = error.message;
        outcome = message.includes('unverified') ? 'unverified' : 'rejected';
      }
      const passed = outcome === item.expected && dependentSteps === item.count;
      output.textContent = JSON.stringify({ case: item.key, passed, outcome, message, dependentSteps,
        originalHash: a.hash, minedHash: record.replacementHash, chainId, broadcasts: 0 }, null, 2);
      output.dataset.passed = String(passed); button.disabled = false;
    });
    document.getElementById('cases').append(section);
  }
}

const { createServer, loadConfigFromFile, mergeConfig } = await import(pathToFileURL(resolve(repository, 'node_modules/vite/dist/node/index.js')).href);
const config = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(repository, 'app/vite.config.ts'));
const reviewPlugin = {
  name: 'read-only-action-review',
  resolveId(id) { if (id === '/action-review-entry.js') return '\0action-review-entry'; },
  load(id) { if (id === '\0action-review-entry') return '(' + browserReview.toString() + ')().catch(error => { document.getElementById("identity").textContent = "Setup failed: " + error.message; });'; },
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url === '/action-evidence.json') {
        response.setHeader('Content-Type', 'application/json'); response.end(readFileSync(evidencePath)); return;
      }
      if (request.url !== '/action-review' && request.url !== '/action-review/') return next();
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Read-only action confirmation review</title><style>body{font:16px system-ui;max-width:920px;margin:32px auto;padding:0 20px;color:#182025}section{border-top:1px solid #ccd3d8;margin-top:24px;padding:12px 0}p{overflow-wrap:anywhere}button{padding:12px 18px;font:inherit;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f6;padding:16px}[data-passed="true"]{border-left:4px solid #247941}[data-passed="false"]{border-left:4px solid #b62424}</style></head><body><h1>Read-only generic confirmation review</h1><p id="identity" role="status">Loading production helpers…</p><p>Uses production tx.ts orchestration and confirmation with actual recorded mined replacements. No wallet requests or broadcasts. This checks retrospective receipt handling, not a wallet cancellation click or original-hash replacement discovery.</p><p><a href="/">Open the real dashboard</a></p><div id="cases"></div><script type="module" src="/action-review-entry.js"></script></body></html>');
    });
  },
};
const server = await createServer(mergeConfig(config.config, {
  configFile: false,
  plugins: [reviewPlugin],
  server: { host: '127.0.0.1', port: 5212, strictPort: true, fs: { allow: [repository] } },
}));
await server.listen();
console.log(JSON.stringify({ dashboard: 'http://127.0.0.1:5212/', actionReview: 'http://127.0.0.1:5212/action-review',
  rpc: process.env.VITE_RPC_URL, chainId: 31337, factory: process.env.VITE_FACTORY,
  creator: successful.original.creator, actualPool: successful.original.predicted, broadcasts: 0 }));
