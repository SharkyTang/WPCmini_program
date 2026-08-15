import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UploadQueueItem } from "../types";
import {
  buildUploadedCaseDraft,
  createLatestRequestGuard,
  createUploadPageSessionGuard,
  createUploadRegistrationReconciler,
  createUploadStatusReconciler,
  ensureUploadItemRegistered,
  type PendingUploadStatusSync,
  QueueItemRow,
  removeRegisteredUploadItem,
  reportRegisteredUploadItemStatus,
  UploadPageSessionInactiveError,
  uploadTitleDraftStoreKey,
} from "./UploadPage";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function queueItem(): UploadQueueItem {
  return {
    id: "queue-1",
    mutationId: "mutation-1",
    uploadBatchId: "batch-1",
    files: [new File(["image"], "原始标题.png", { type: "image/png" })],
    previews: ["blob:preview-1"],
    title: "原始标题",
    packageTypes: [],
    scenes: [],
    status: "waiting",
    progress: 0,
    error: "",
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("QueueItemRow", () => {
  it("keeps title editing out of the heavy queue snapshot", () => {
    const onPatch = vi.fn();
    const onDraftTitleChange = vi.fn();
    render(
      <QueueItemRow
        item={queueItem()}
        packageOptions={[]}
        sceneOptions={[]}
        running={false}
        selected={false}
        onOpenCreated={() => undefined}
        onDraftTitleChange={onDraftTitleChange}
        onPatch={onPatch}
        onRemove={() => undefined}
        onRetry={() => undefined}
        onToggleSelected={() => undefined}
      />,
    );

    const input = screen.getByDisplayValue("原始标题");
    fireEvent.change(input, { target: { value: "新的案例标题" } });

    expect(input).toHaveValue("新的案例标题");
    expect(onPatch).not.toHaveBeenCalled();
    expect(onDraftTitleChange).toHaveBeenCalledWith(
      "queue-1",
      "新的案例标题",
    );

    fireEvent.blur(input);
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("uses lazy asynchronous previews and reports selection without changing the item", () => {
    const onToggleSelected = vi.fn();
    render(
      <QueueItemRow
        item={queueItem()}
        packageOptions={[]}
        sceneOptions={[]}
        running={false}
        selected={false}
        onOpenCreated={() => undefined}
        onDraftTitleChange={() => undefined}
        onPatch={() => undefined}
        onRemove={() => undefined}
        onRetry={() => undefined}
        onToggleSelected={onToggleSelected}
      />,
    );

    const preview = screen.getByRole("img", { name: "原始标题 1" });
    expect(preview).toHaveAttribute("loading", "lazy");
    expect(preview).toHaveAttribute("decoding", "async");

    fireEvent.click(screen.getByRole("checkbox"));
    expect(onToggleSelected).toHaveBeenCalledWith("queue-1", true);
  });

  it("separates title drafts by administrator UID", () => {
    expect(uploadTitleDraftStoreKey("uid-a")).not.toBe(
      uploadTitleDraftStoreKey("uid-b"),
    );
    expect(uploadTitleDraftStoreKey("uid-a")).toContain("uid-a");
  });

  it("carries the selected usage scenes into the create-case draft", () => {
    const item = { ...queueItem(), scenes: ["宴会", "收藏"] };
    const draft = buildUploadedCaseDraft(item, {
      sources: ["cloud://source"],
      variants: [{
        sourceFileID: "cloud://source",
        displayFileID: "cloud://display",
        thumbnailFileID: "cloud://thumbnail",
        bannerFileID: "cloud://banner",
      }],
    });

    expect(draft.scenes).toEqual(["宴会", "收藏"]);
    expect(draft.isVisible).toBe(false);
  });
});

describe("upload synchronization reliability", () => {
  it("reactivates the current UID guard after the StrictMode effect cycle", () => {
    const guard = createUploadPageSessionGuard("uid-current");
    const onUpload = vi.fn();

    function GuardedUploadProbe() {
      useEffect(() => {
        guard.activate();
        return () => guard.deactivate();
      }, []);
      return (
        <button
          type="button"
          onClick={() => {
            if (guard.isActive()) onUpload();
          }}
        >
          开始上传
        </button>
      );
    }

    const view = render(
      <StrictMode>
        <GuardedUploadProbe />
      </StrictMode>,
    );

    expect(guard.isActive()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "开始上传" }));
    expect(onUpload).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(guard.isActive()).toBe(false);
  });

  it("does not reactivate an old UID guard when a new UID guard mounts", () => {
    const oldGuard = createUploadPageSessionGuard("uid-old");
    oldGuard.deactivate();
    const newGuard = createUploadPageSessionGuard("uid-new");
    newGuard.activate();

    expect(oldGuard.isActive()).toBe(false);
    expect(newGuard.isActive()).toBe(true);
    expect(newGuard.generation).toBeGreaterThan(oldGuard.generation);
  });

  it("does not acknowledge a delayed registration after the account switches", async () => {
    const guard = createUploadPageSessionGuard("uid-old");
    const completion = deferred();
    const registered = new Set<string>();
    const register = vi.fn(() => completion.promise);
    const item = queueItem();
    const result = ensureUploadItemRegistered(
      register,
      item,
      registered,
      guard.isActive,
    );

    expect(register).toHaveBeenCalledTimes(1);
    guard.deactivate();
    completion.resolve();

    await expect(result).rejects.toBeInstanceOf(UploadPageSessionInactiveError);
    expect(registered.has(item.mutationId)).toBe(false);
  });

  it("does not continue a delayed registration into a status RPC after switching", async () => {
    const guard = createUploadPageSessionGuard("uid-old");
    const completion = deferred();
    const register = vi.fn(() => completion.promise);
    const update = vi.fn().mockResolvedValue(undefined);
    const item = queueItem();
    const result = reportRegisteredUploadItemStatus(
      register,
      update,
      item,
      { status: "failed" },
      new Set(),
      guard.isActive,
    );

    expect(register).toHaveBeenCalledTimes(1);
    guard.deactivate();
    completion.resolve();

    await expect(result).rejects.toBeInstanceOf(UploadPageSessionInactiveError);
    expect(update).not.toHaveBeenCalled();
  });

  it("does not acknowledge a delayed status RPC after the account switches", async () => {
    const guard = createUploadPageSessionGuard("uid-old");
    const completion = deferred();
    const item = queueItem();
    const registered = new Set([item.mutationId]);
    const update = vi.fn(() => completion.promise);
    const result = reportRegisteredUploadItemStatus(
      vi.fn(),
      update,
      item,
      { status: "failed" },
      registered,
      guard.isActive,
    );
    await Promise.resolve();

    expect(update).toHaveBeenCalledTimes(1);
    guard.deactivate();
    completion.resolve();

    await expect(result).rejects.toBeInstanceOf(UploadPageSessionInactiveError);
  });

  it("does not acknowledge a delayed remove RPC after the account switches", async () => {
    const guard = createUploadPageSessionGuard("uid-old");
    const completion = deferred();
    const item = queueItem();
    const registered = new Set([item.mutationId]);
    const remove = vi.fn(() => completion.promise);
    const result = removeRegisteredUploadItem(
      vi.fn(),
      remove,
      item,
      registered,
      guard.isActive,
    );
    await Promise.resolve();

    expect(remove).toHaveBeenCalledTimes(1);
    guard.deactivate();
    completion.resolve();

    await expect(result).rejects.toBeInstanceOf(UploadPageSessionInactiveError);
  });

  it("retries idempotent registration after the first attempt fails", async () => {
    const registered = new Set<string>();
    const register = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ ok: true });
    const item = queueItem();

    await expect(
      ensureUploadItemRegistered(register, item, registered),
    ).rejects.toThrow("temporary failure");
    expect(registered.has(item.mutationId)).toBe(false);

    await ensureUploadItemRegistered(register, item, registered);
    await ensureUploadItemRegistered(register, item, registered);

    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenLastCalledWith([
      expect.objectContaining({
        mutationId: item.mutationId,
        imageCount: 1,
      }),
    ]);
  });

  it("registers a missing task before reporting its first stage", async () => {
    const registered = new Set<string>();
    const register = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ ok: true });
    const update = vi.fn().mockResolvedValue({ ok: true });
    const item = queueItem();
    const patch = { status: "uploading" as const, title: item.title };

    await expect(
      reportRegisteredUploadItemStatus(register, update, item, patch, registered),
    ).rejects.toThrow("temporary failure");
    expect(update).not.toHaveBeenCalled();

    await reportRegisteredUploadItemStatus(register, update, item, patch, registered);
    expect(update).toHaveBeenCalledWith(item.mutationId, patch);
  });

  it("rejects stale polling responses after a newer request was applied", () => {
    const guard = createLatestRequestGuard();
    const older = guard.issue();
    const newer = guard.issue();

    expect(guard.canApply(newer)).toBe(true);
    expect(guard.canApply(older)).toBe(false);
  });

  it("reconciles an initially failed waiting task on the next five-second tick", async () => {
    vi.useFakeTimers();
    const item = queueItem();
    const registered = new Set<string>();
    const registering = new Set<string>();
    const register = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ ok: true });
    const reconciler = createUploadRegistrationReconciler({
      getItems: () => [item],
      register,
      registeredMutationIds: registered,
      registeringMutationIds: registering,
    });

    await reconciler.reconcileNow();
    expect(register).toHaveBeenCalledTimes(1);
    expect(registered.has(item.mutationId)).toBe(false);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(register).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(register).toHaveBeenCalledTimes(2);
    expect(registered.has(item.mutationId)).toBe(true);
    reconciler.stop();
  });

  it("cancels reconciliation retries when the current account page unmounts", async () => {
    vi.useFakeTimers();
    const item = queueItem();
    const register = vi.fn().mockRejectedValue(new Error("offline"));
    const reconciler = createUploadRegistrationReconciler({
      getItems: () => [item],
      register,
      registeredMutationIds: new Set(),
      registeringMutationIds: new Set(),
    });

    await reconciler.reconcileNow();
    expect(register).toHaveBeenCalledTimes(1);
    reconciler.stop();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(register).toHaveBeenCalledTimes(1);
  });

  it("replays a failed terminal status after five seconds and stops after acknowledgement", async () => {
    vi.useFakeTimers();
    const item = { ...queueItem(), status: "failed" as const, error: "上传失败" };
    const entry: PendingUploadStatusSync = {
      item,
      patch: { status: "failed" as const, error: item.error },
      attemptId: 1,
    };
    let pending = [entry];
    const replay = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const acknowledge = vi.fn((acknowledged: PendingUploadStatusSync) => {
      pending = pending.filter(
        (candidate) => candidate.attemptId !== acknowledged.attemptId,
      );
    });
    const reconciler = createUploadStatusReconciler({
      getPending: () => pending,
      replay,
      acknowledge,
    });

    await reconciler.reconcileNow();
    expect(replay).toHaveBeenCalledTimes(1);
    expect(acknowledge).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(replay).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(replay).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(pending).toEqual([]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(replay).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    reconciler.stop();
  });

  it("cancels terminal-status replay when the current account page unmounts", async () => {
    vi.useFakeTimers();
    const item = { ...queueItem(), status: "failed" as const };
    const entry: PendingUploadStatusSync = {
      item,
      patch: { status: "failed" as const },
      attemptId: 1,
    };
    const replay = vi.fn().mockRejectedValue(new Error("offline"));
    const acknowledge = vi.fn();
    const reconciler = createUploadStatusReconciler({
      getPending: () => [entry],
      replay,
      acknowledge,
    });

    await reconciler.reconcileNow();
    expect(replay).toHaveBeenCalledTimes(1);
    reconciler.stop();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(replay).toHaveBeenCalledTimes(1);
    expect(acknowledge).not.toHaveBeenCalled();
  });
});
