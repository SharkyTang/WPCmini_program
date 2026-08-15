import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OrderMoveButtons } from "./OrderMoveButtons";

describe("OrderMoveButtons", () => {
  it("exposes keyboard-focusable moves with descriptive labels and disabled boundaries", () => {
    const onMove = vi.fn();
    render(
      <OrderMoveButtons
        index={0}
        total={3}
        ariaContext="首页轮播中的案例“青瓷礼盒”"
        onMove={onMove}
      />,
    );

    const up = screen.getByRole("button", {
      name: "将首页轮播中的案例“青瓷礼盒”上移",
    });
    const down = screen.getByRole("button", {
      name: "将首页轮播中的案例“青瓷礼盒”下移",
    });
    expect(up).toBeDisabled();
    expect(down).toBeEnabled();

    down.focus();
    expect(down).toHaveFocus();
    fireEvent.click(down);
    expect(onMove).toHaveBeenCalledWith(1);
  });

  it("uses image-specific forward/backward labels and disables the final boundary", () => {
    render(
      <OrderMoveButtons
        index={2}
        total={3}
        axis="horizontal"
        ariaContext="“青瓷礼盒”的第 3 张图片"
        onMove={() => undefined}
      />,
    );

    expect(
      screen.getByRole("button", { name: "将“青瓷礼盒”的第 3 张图片前移" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "将“青瓷礼盒”的第 3 张图片后移" }),
    ).toBeDisabled();
  });
});
