/** Existing pools use live stored terms; only a new pool may use its reviewed draft override. */
export const effectiveRevenueBps = (stored: number | undefined, draft: number | undefined, suggested: number) =>
  stored ?? draft ?? suggested;
