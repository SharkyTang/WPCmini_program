import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UploadQueueItem } from "../types";
import { QueueItemRow } from "./UploadPage";

afterEach(cleanup);

function queueItem(): UploadQueueItem {
  return {
    id: "queue-1",
    mutationId: "mutation-1",
    uploadBatchId: "batch-1",
    files: [new File(["image"], "原始标题.png", { type: "image/png" })],
    previews: ["blob:preview-1"],
    title: "原始标题",
    packageTypes: [],
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
});
