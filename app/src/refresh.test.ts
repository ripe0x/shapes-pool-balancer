import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyRefreshEvent, createLatestRefresh, type RefreshEvent, type RefreshState } from './refresh';

// Pure deferred work tests the orchestration used by useBalancer. No service or protocol answers are substituted.
interface Snapshot { pool: string; block: number }
interface Report { ledger: string; pending: number[] }
const snapshot = (block: number, pool = 'A'): Snapshot => ({ pool, block });
const report = (ledger: string, pending: number[] = []): Report => ({ ledger, pending });
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function history() {
  let state: RefreshState<Snapshot, Report> = { loading: true };
  const jobs: { input: Snapshot; work: ReturnType<typeof deferred<Report>> }[] = [];
  const events: RefreshEvent<Snapshot, Report>[] = [];
  let active = 0, maximumActive = 0;
  const queue = createLatestRefresh<Snapshot, Report>((input) => {
    const work = deferred<Report>();
    jobs.push({ input, work }); active++; maximumActive = Math.max(maximumActive, active);
    return work.promise.then((value) => { active--; return value; }, (error) => { active--; throw error; });
  }, (event) => { events.push(event); state = applyRefreshEvent(state, event); });
  return { queue, jobs, events, get state() { return state; }, get maximumActive() { return maximumActive; } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const settle = () => vi.advanceTimersByTimeAsync(0);

it('keeps current refreshes usable when history takes longer than the polling interval', async () => {
  const h = history(); let current = 0;
  const live = createLatestRefresh<void, number>(async () => current + 1, (event) => {
    if (event.state === 'ready') { current = event.value; h.queue.request(snapshot(current)); }
  });
  live.request(); const timer = setInterval(() => live.request(), 15_000);
  await vi.advanceTimersByTimeAsync(31_000);
  expect(current).toBe(3);
  expect(h.jobs).toHaveLength(1);
  expect(h.state.loading).toBe(true);
  expect(h.state.value).toBeUndefined();
  clearInterval(timer); live.dispose(); h.queue.dispose();
  h.jobs[0].work.resolve(report('finished after cleanup')); await settle();
});

it('coalesces multiple current snapshots into one latest follow-up with no overlapping scans', async () => {
  const h = history(); h.queue.request(snapshot(1));
  for (let block = 2; block <= 100; block++) h.queue.request(snapshot(block));
  expect(h.jobs).toHaveLength(1);
  h.jobs[0].work.resolve(report('first')); await settle();
  expect(h.jobs.map((job) => job.input.block)).toEqual([1, 100]);
  expect(h.maximumActive).toBe(1);
  h.jobs[1].work.resolve(report('latest')); await settle();
  expect(h.state.input).toEqual(snapshot(100));
  expect(h.state.loading).toBe(false);
  expect(h.jobs).toHaveLength(2);
});

it('publishes completed history while newer snapshots are queued instead of invalidating it', async () => {
  const h = history(); h.queue.request(snapshot(10)); h.queue.request(snapshot(11));
  h.jobs[0].work.resolve(report('history at 10')); await settle();
  expect(h.state.value?.ledger).toBe('history at 10');
  expect(h.state.input).toEqual(snapshot(10));
  expect(h.state.loading).toBe(true);
  h.jobs[1].work.resolve(report('history at 11')); await settle();
  expect(h.state.value?.ledger).toBe('history at 11');
  expect(h.state.input).toEqual(snapshot(11));
});

it('publishes failed-delivery recovery entries even when current snapshots keep arriving', async () => {
  const h = history(); h.queue.request(snapshot(20));
  const timer = setInterval(() => h.queue.request(snapshot(21)), 15_000);
  await vi.advanceTimersByTimeAsync(46_000);
  h.jobs[0].work.resolve(report('delivery discovery', [31, 32])); await settle();
  expect(h.state.value?.pending).toEqual([31, 32]);
  expect(h.state.input?.block).toBe(20);
  clearInterval(timer); h.queue.dispose();
  h.jobs[1].work.resolve(report('later delivery discovery', [32])); await settle();
});

it.each(['pool switch', 'chain/client switch', 'unmount'])('disposes old work on %s without publishing its result or starting its queued scan', async () => {
  const old = history(); old.queue.request(snapshot(1, 'old')); old.queue.request(snapshot(2, 'old'));
  old.queue.dispose();
  const next = history(); next.queue.request(snapshot(1, 'new'));
  old.jobs[0].work.resolve(report('old pool', [99])); await settle();
  expect(old.events.map((event) => event.state)).toEqual(['loading']);
  expect(old.jobs).toHaveLength(1);
  expect(next.state.value).toBeUndefined();
  next.jobs[0].work.resolve(report('new pool', [42])); await settle();
  expect(next.state.value).toEqual(report('new pool', [42]));
  expect(next.state.input?.pool).toBe('new');
});

it('exposes history failure and recovers on the next successful refresh', async () => {
  const h = history(); h.queue.request(snapshot(1));
  const error = new Error('history unavailable'); h.jobs[0].work.reject(error); await settle();
  expect(h.state.error).toBe(error);
  expect(h.state.loading).toBe(false);
  h.queue.request(snapshot(2));
  expect(h.state.error).toBe(error);
  expect(h.state.loading).toBe(true);
  h.jobs[1].work.resolve(report('recovered', [7])); await settle();
  expect(h.state.value).toEqual(report('recovered', [7]));
  expect(h.state.error).toBeUndefined();
  expect(h.state.loading).toBe(false);
});

it('retains the previous coherent history and recovery entries during a slow refresh and its failure', async () => {
  const h = history(); h.queue.request(snapshot(1));
  h.jobs[0].work.resolve(report('usable history', [8])); await settle();
  h.queue.request(snapshot(2)); h.queue.request(snapshot(3));
  await vi.advanceTimersByTimeAsync(45_000);
  expect(h.state.value).toEqual(report('usable history', [8]));
  expect(h.state.input).toEqual(snapshot(1));
  expect(h.state.loading).toBe(true);
  h.jobs[1].work.reject(new Error('scan failed')); await settle();
  expect(h.state.value).toEqual(report('usable history', [8]));
  expect(h.state.input).toEqual(snapshot(1));
  expect(h.state.error).toBeInstanceOf(Error);
  h.jobs[2].work.resolve(report('fresh history', [9])); await settle();
  expect(h.state.value).toEqual(report('fresh history', [9]));
  expect(h.state.input).toEqual(snapshot(3));
  expect(h.state.error).toBeUndefined();
});
