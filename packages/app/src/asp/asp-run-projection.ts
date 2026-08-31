const DEFAULT_RUN_PROJECTION_TIMEOUT_MS = 1_000;
const PROJECTED_RUN_TTL_MS = 10_000;

type RunWaiter = {
  resolve: () => void;
  timeout: ReturnType<typeof setTimeout>;
};

const projectedRuns = new Map<string, number>();
const runWaiters = new Map<string, Set<RunWaiter>>();

export function notifyAspRunProjected(sessionId: string, runId: string): void {
  const key = runProjectionKey(sessionId, runId);
  projectedRuns.set(key, Date.now());
  pruneProjectedRuns();

  const waiters = runWaiters.get(key);
  if (!waiters) return;
  runWaiters.delete(key);
  for (const waiter of waiters) {
    clearTimeout(waiter.timeout);
    waiter.resolve();
  }
}

export function waitForAspRunProjection(
  sessionId: string,
  runId: string,
  timeoutMs = DEFAULT_RUN_PROJECTION_TIMEOUT_MS,
): Promise<void> {
  const key = runProjectionKey(sessionId, runId);
  if (projectedRuns.has(key)) return Promise.resolve();
  if (timeoutMs <= 0) return Promise.resolve();

  return new Promise((resolve) => {
    const waiter: RunWaiter = {
      resolve,
      timeout: setTimeout(() => {
        const waiters = runWaiters.get(key);
        if (waiters) {
          waiters.delete(waiter);
          if (!waiters.size) runWaiters.delete(key);
        }
        resolve();
      }, timeoutMs),
    };

    const waiters = runWaiters.get(key);
    if (waiters) waiters.add(waiter);
    else runWaiters.set(key, new Set([waiter]));
  });
}

function runProjectionKey(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`;
}

function pruneProjectedRuns(): void {
  const cutoff = Date.now() - PROJECTED_RUN_TTL_MS;
  for (const [key, projectedAt] of projectedRuns) {
    if (projectedAt < cutoff) projectedRuns.delete(key);
  }
}
