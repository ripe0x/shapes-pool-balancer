// Read-only JSON-RPC proxy to Alchemy. ALCHEMY_MAINNET_URL is a functions-scoped Netlify variable: it is never in the
// build environment, so it cannot be inlined into the dashboard bundle, and no response repeats it.
import { MAX_BODY_BYTES, originAllowed, refuseRpc } from '../lib/rpc';

const reply = (status: number, body: string) =>
  new Response(body, { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status: number, message: string) => reply(status, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message } }));

export default async (req: Request) => {
  if (req.method !== 'POST') return fail(405, 'POST only');
  if (!originAllowed(req.headers.get('origin'), process.env)) return fail(403, 'origin not allowed');
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return fail(413, 'request too large');
  let body: unknown;
  try { body = JSON.parse(text); } catch { return fail(400, 'invalid JSON'); }
  const refused = refuseRpc(body);
  if (refused) return fail(400, refused);
  const upstream = process.env.ALCHEMY_MAINNET_URL;
  if (!upstream) return fail(503, 'proxy not configured');
  const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text }).catch(() => undefined);
  if (!r) return fail(502, 'upstream unavailable');
  return reply(r.status, await r.text());
};
