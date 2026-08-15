export interface LatestAsyncSaverOptions {
  debounceMs?: number;
  onError?: (error: unknown) => void;
}

export interface LatestAsyncSaver<T> {
  /**
   * Replaces any snapshot that has not started saving yet and restarts the
   * debounce window.
   */
  schedule(snapshot: T): void;
  /**
   * Saves the latest pending snapshot immediately and waits until the saver is
   * idle. Snapshots scheduled while a save is running are also drained.
   */
  flush(): Promise<void>;
  /**
   * Drops the pending snapshot. An already-running save cannot be cancelled.
   */
  cancel(): void;
}

const DEFAULT_DEBOUNCE_MS = 400;

export function createLatestAsyncSaver<T>(
  save: (snapshot: T) => void | Promise<void>,
  options: LatestAsyncSaverOptions = {},
): LatestAsyncSaver<T> {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new RangeError("debounceMs must be a finite, non-negative number");
  }

  let pendingSnapshot: T | undefined;
  let hasPendingSnapshot = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let runningSave: Promise<void> | null = null;

  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const reportError = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // Error reporting must not poison the saver or block later snapshots.
    }
  };

  const startPendingSave = (): Promise<void> | null => {
    if (runningSave || !hasPendingSnapshot) return runningSave;

    const snapshot = pendingSnapshot as T;
    pendingSnapshot = undefined;
    hasPendingSnapshot = false;

    const task = Promise.resolve()
      .then(() => save(snapshot))
      .catch(reportError);

    let trackedTask: Promise<void>;
    trackedTask = task.finally(() => {
      if (runningSave !== trackedTask) return;
      runningSave = null;

      // If the debounce elapsed while the previous save was running, persist
      // the one latest snapshot now. A live timer means the debounce window is
      // still open and will start it later.
      if (hasPendingSnapshot && timer === null) {
        startPendingSave();
      }
    });
    runningSave = trackedTask;
    return trackedTask;
  };

  const schedule = (snapshot: T) => {
    pendingSnapshot = snapshot;
    hasPendingSnapshot = true;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      startPendingSave();
    }, debounceMs);
  };

  const flush = async () => {
    clearTimer();

    while (runningSave || hasPendingSnapshot) {
      if (!runningSave) startPendingSave();
      const activeSave = runningSave;
      if (activeSave) await activeSave;
      clearTimer();
    }
  };

  const cancel = () => {
    clearTimer();
    pendingSnapshot = undefined;
    hasPendingSnapshot = false;
  };

  return { schedule, flush, cancel };
}
