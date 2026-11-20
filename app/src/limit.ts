/** Runs at most `max` calls of `fn` at once; the rest wait in order. Public RPC endpoints reject bursts of about eight
 *  simultaneous requests, while the same requests a few at a time all succeed. */
export function limitConcurrency<A extends unknown[], R>(fn: (...args: A) => Promise<R>, max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (...args: A): Promise<R> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try { return await fn(...args); } finally { active--; waiting.shift()?.(); }
  };
}
