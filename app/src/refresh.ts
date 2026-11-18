export type RefreshEvent<Input, Value> =
  | { state: 'loading'; input: Input }
  | { state: 'ready'; input: Input; value: Value; loading: boolean }
  | { state: 'error'; input: Input; error: unknown; loading: boolean };

export interface RefreshState<Input, Value> {
  input?: Input;
  value?: Value;
  loading: boolean;
  error?: unknown;
}

export function applyRefreshEvent<Input, Value>(state: RefreshState<Input, Value>, event: RefreshEvent<Input, Value>): RefreshState<Input, Value> {
  if (event.state === 'ready') return { input: event.input, value: event.value, loading: event.loading };
  if (event.state === 'error') return { ...state, error: event.error, loading: event.loading };
  return { ...state, loading: true };
}

/** Finish useful work before reading the latest queued snapshot; polling cannot starve a slow request. */
export function createLatestRefresh<Input, Value>(
  read: (input: Input) => Promise<Value>,
  publish: (event: RefreshEvent<Input, Value>) => void,
) {
  let next: { input: Input } | undefined;
  let running = false;
  let disposed = false;

  async function drain() {
    while (!disposed && next) {
      const { input } = next;
      next = undefined;
      publish({ state: 'loading', input });
      try {
        const value = await read(input);
        if (!disposed) publish({ state: 'ready', input, value, loading: next !== undefined });
      } catch (error) {
        if (!disposed) publish({ state: 'error', input, error, loading: next !== undefined });
      }
    }
    running = false;
  }

  return {
    request(input: Input) {
      if (disposed) return;
      next = { input };
      if (!running) { running = true; void drain(); }
    },
    dispose() { disposed = true; next = undefined; },
  };
}
