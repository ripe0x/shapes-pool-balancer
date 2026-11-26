// Request checks for the site's read-only RPC proxy (netlify/functions/rpc.mts). The Alchemy URL, which carries the
// key, exists only in the functions runtime; these checks keep the proxy from becoming a general relay for it.

/** Read methods the dashboard uses. Signing and sending stay in the visitor's wallet. */
export const READ_METHODS = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas',
  'eth_feeHistory', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getLogs', 'eth_getBlockByNumber',
  'eth_getBlockByHash', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getTransactionCount',
  'eth_createAccessList',
]);

export const MAX_BODY_BYTES = 200_000;
export const MAX_BATCH = 50;
const SITE = 'https://pools.shapes.ripe.wtf';

/** The reason a JSON-RPC body is refused, or undefined when every call is an allowed read. */
export function refuseRpc(body: unknown): string | undefined {
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > MAX_BATCH) return `send 1 to ${MAX_BATCH} calls`;
  for (const c of calls) {
    const method = (c as { method?: unknown } | null)?.method;
    if (typeof method !== 'string' || !READ_METHODS.has(method)) return `method not allowed: ${String(method)}`;
  }
  return undefined;
}

/** Browsers always send Origin on POST; only this site's own pages (production and its deploy URLs) may use the proxy.
 *  A non-browser client can forge Origin, so this limits casual reuse of the quota, not determined abuse. */
export function originAllowed(origin: string | null, env: Record<string, string | undefined>): boolean {
  if (!origin) return false;
  return [SITE, env.URL, env.DEPLOY_URL, env.DEPLOY_PRIME_URL].some((o) => o && o === origin);
}
