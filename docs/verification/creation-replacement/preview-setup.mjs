import { createServer } from '/private/tmp/fwa-credit-atomic/node_modules/vite/dist/node/index.js';
import { readFileSync } from 'node:fs';
const root = '/private/tmp/fwa-credit-atomic';
process.env.VITE_CHAIN_ID = '31337';
process.env.VITE_RPC_URL = 'http://127.0.0.1:18795';
process.env.VITE_FACTORY = '0xCd171B437d9329C2654128645944fbC05C9AA2BF';
process.env.VITE_FROM_BLOCK = '26382399';
process.env.VITE_DEV_ACCOUNT = '0x00000000000000000000000000000000000ce001';
const server = await createServer({ configFile: `${root}/app/vite.config.ts`, server: { host: '127.0.0.1', port: 5210, strictPort: true }, plugins: [{
  name: 'actual-saved-attempt-test-setup',
  configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      const paths = { '/__replacement-fixture/cancel': 'cancelled', '/__replacement-fixture/revert': 'reverted' };
      const outcome = paths[request.url];
      if (!outcome) return next();
      const evidence = JSON.parse(readFileSync(`${root}/docs/verification/creation-replacement/transactions.json`, 'utf8'));
      const record = evidence.records.find(record => record.outcome === outcome);
      if (!record) { response.statusCode = 503; return response.end('Actual replacement case has not completed.'); }
      const attempt = record.original;
      // Restore actual pre-replacement browser persistence; all confirmation answers still come from the real child node.
      const draft = { salt: attempt.salt, creation: attempt, markup: 25, creatorRevenueBps: attempt.config.creatorRevenueBps,
        nfts: attempt.curated.map(nft => ({ collection: nft.collection, tokenId: nft.tokenId, value: String(Number(nft.base) / 1e18) })) };
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><title>Actual saved creation attempt</title><script>localStorage.setItem('pool-design-draft', ${JSON.stringify(JSON.stringify(draft))}); location.replace('/');</script>`);
    });
  },
}] });
await server.listen();
console.log('Replacement preview http://127.0.0.1:5210; actual persisted original attempts only; no receipt or state response stubs.');
