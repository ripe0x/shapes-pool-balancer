import { MAX_BATCH } from '../../shared/planner';

/** BalancerFactory.productLimits(): bounds on newly submitted designs (creation and configure). */
export interface ProductLimits {
  maxPrizes: number;
  minMarkupBps: number;
  maxMarkupBps: number;
  /** community-v1 hardcodes its limits and has no exception for a pool's current design. */
  fixed?: boolean;
}

/** BalancerFactory constructor values, shown until the live limits load. */
export const INITIAL_LIMITS: ProductLimits = { maxPrizes: 1_000, minMarkupBps: 1_000, maxMarkupBps: 10_000 };
/** community-v1 PoolInventory.validateTarget: 1 to 1,000 prizes, markup 1,000 to 10,000 bps. */
export const LEGACY_LIMITS: ProductLimits = { ...INITIAL_LIMITS, fixed: true };

/** PoolInventory.validateTarget: a new design may hold up to max(current target prizes, maxPrizes). */
export const prizeLimit = (l: ProductLimits, currentPrizes: number) => (l.fixed ? l.maxPrizes : Math.max(currentPrizes, l.maxPrizes));

/** PoolInventory.validateTarget: in range, or unchanged from the pool's current (nonzero) markup. */
export const markupAllowed = (l: ProductLimits, markupBps: number, currentMarkupBps: number) =>
  (markupBps >= l.minMarkupBps && markupBps <= l.maxMarkupBps) || (!l.fixed && markupBps !== 0 && markupBps === currentMarkupBps);

/** Slider bounds in percent: the factory range, widened to include a current markup that the pool may keep. */
export function markupSliderRange(l: ProductLimits, currentMarkupBps: number) {
  const keep = !l.fixed && currentMarkupBps > 0;
  const lo = keep ? Math.min(l.minMarkupBps, currentMarkupBps) : l.minMarkupBps;
  const hi = keep ? Math.max(l.maxMarkupBps, currentMarkupBps) : l.maxMarkupBps;
  return { min: lo / 100, max: hi / 100 };
}

export const FILL_GATE_DEFAULT_BPS = 7_000;
export const BACKLOG_DEFAULT = MAX_BATCH;
/** PoolBalancer.setFillGateBps accepts 0 to 10,000. */
export const validFillGate = (bps: number) => Number.isInteger(bps) && bps >= 0 && bps <= 10_000;
/** PoolBalancer.setBacklogThreshold accepts 1 to the uint16 maximum. */
export const validBacklog = (t: number) => Number.isInteger(t) && t >= 1 && t <= 0xffff;
/** FWA checks admission before a purchase of up to MAX_BATCH draws, so a threshold T leaves at most T + 4 unsettled. */
export const maxUnsettled = (backlogThreshold: number) => backlogThreshold + MAX_BATCH - 1;
