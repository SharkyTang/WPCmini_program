import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestAsyncSaver } from "./latestAsyncSaver";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createLatestAsyncSaver", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces consecutive schedules and saves only the latest snapshot", async () => {
    vi.useFakeTimers();
    const save = vi.fn<(snapshot: number) => void>();
    const saver = createLatestAsyncSaver(save, { debounceMs: 50 });

    saver.schedule(1);
    saver.schedule(2);
    saver.schedule(3);

    await vi.advanceTimersByTimeAsync(49);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await saver.flush();
    expect(save.mock.calls).toEqual([[3]]);
  });

  it("keeps only the latest snapshot scheduled during an active save", async () => {
    vi.useFakeTimers();
    const firstSave = deferred();
    const saved: number[] = [];
    const save = vi.fn(async (snapshot: number) => {
      saved.push(snapshot);
      if (snapshot === 1) await firstSave.promise;
    });
    const saver = createLatestAsyncSaver(save, { debounceMs: 20 });

    saver.schedule(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(saved).toEqual([1]);

    saver.schedule(2);
    saver.schedule(3);
    await vi.advanceTimersByTimeAsync(20);
    expect(saved).toEqual([1]);

    firstSave.resolve();
    await saver.flush();
    expect(saved).toEqual([1, 3]);
  });

  it("flushes immediately and cancel drops only work that has not started", async () => {
    vi.useFakeTimers();
    const save = vi.fn<(snapshot: string) => void>();
    const saver = createLatestAsyncSaver(save, { debounceMs: 1_000 });

    saver.schedule("flush-now");
    await saver.flush();
    expect(save.mock.calls).toEqual([["flush-now"]]);

    saver.schedule("cancel-me");
    saver.cancel();
    await vi.runAllTimersAsync();
    await saver.flush();
    expect(save.mock.calls).toEqual([["flush-now"]]);

    saver.schedule("still-reusable");
    await saver.flush();
    expect(save.mock.calls).toEqual([["flush-now"], ["still-reusable"]]);
  });

  it("reports save errors and continues with later snapshots", async () => {
    vi.useFakeTimers();
    const failure = new Error("disk full");
    const onError = vi.fn();
    const save = vi.fn(async (snapshot: number) => {
      if (snapshot === 1) throw failure;
    });
    const saver = createLatestAsyncSaver(save, { debounceMs: 10, onError });

    saver.schedule(1);
    await vi.advanceTimersByTimeAsync(10);
    await saver.flush();
    expect(onError).toHaveBeenCalledWith(failure);

    saver.schedule(2);
    await saver.flush();
    expect(save.mock.calls).toEqual([[1], [2]]);
  });
});
