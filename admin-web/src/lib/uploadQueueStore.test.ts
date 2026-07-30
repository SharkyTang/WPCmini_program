import { describe, expect, it, vi } from "vitest";
import type { UploadQueueItem } from "../types";
import {
  restoreUploadQueue,
  revokeQueuePreviews,
  toPersistedUploadQueue,
} from "./uploadQueueStore";

function item(
  status: UploadQueueItem["status"],
  files = [new File(["image"], "case.png", { type: "image/png" })],
): UploadQueueItem {
  return {
    id: "queue-1",
    mutationId: "mutation-1",
    uploadBatchId: "batch-1",
    files,
    previews: ["blob:preview-1"],
    title: "案例",
    packageTypes: [],
    status,
    progress: 45,
    error: "",
  };
}

describe("uploadQueueStore", () => {
  it("persists retryable files but removes previews and completed blobs", () => {
    const waiting = toPersistedUploadQueue([item("waiting")])[0];
    const done = toPersistedUploadQueue([item("done")])[0];

    expect("previews" in waiting).toBe(false);
    expect(waiting.files).toHaveLength(1);
    expect(waiting.uploadBatchId).toBe("batch-1");
    expect(done.files).toEqual([]);
  });

  it("restores files and converts interrupted work into a retryable failure", () => {
    const persisted = toPersistedUploadQueue([item("processing")]);
    const restored = restoreUploadQueue(
      persisted,
      (file) => `blob:restored-${file.name}`,
    )[0];

    expect(restored.status).toBe("failed");
    expect(restored.files).toHaveLength(1);
    expect(restored.previews).toEqual(["blob:restored-case.png"]);
    expect(restored.error).toContain("安全重试");
    expect(restored.mutationId).toBe("mutation-1");
    expect(restored.uploadBatchId).toBe("batch-1");
  });

  it("revokes only local object URLs", () => {
    const revoke = vi.fn();
    revokeQueuePreviews(
      [{ previews: ["blob:one", "https://example.com/two", "blob:three"] }],
      revoke,
    );
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(["blob:one", "blob:three"]);
  });
});
