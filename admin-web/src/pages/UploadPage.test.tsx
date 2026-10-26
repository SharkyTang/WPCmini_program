import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UploadQueueItem } from "../types";
import {
  buildUploadedCaseDraft,
  createUploadPageSessionGuard,
  QueueItemRow,
  uploadTitleDraftStoreKey,
} from "./UploadPage";

afterEach(() => {
  cleanup();
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

  it("keeps a failed local item retryable", () => {
    const item = { ...queueItem(), status: "failed" as const, error: "上传失败" };
    const onRetry = vi.fn();
    render(
      <QueueItemRow
        item={item}
        packageOptions={[]}
        sceneOptions={[]}
        running={false}
        selected={false}
        onOpenCreated={() => undefined}
        onDraftTitleChange={() => undefined}
        onPatch={() => undefined}
        onRemove={() => undefined}
        onRetry={onRetry}
        onToggleSelected={() => undefined}
      />,
    );

    expect(screen.getByText("上传失败")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(onRetry).toHaveBeenCalledWith(item);
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

describe("upload session safety", () => {
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

});
