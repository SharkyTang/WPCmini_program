import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CaseTagList } from "./CaseVisuals";

describe("CaseTagList", () => {
  it("在列表标签中显示场景别名", () => {
    render(
      <CaseTagList
        item={{
          packageTypes: ["礼盒"],
          styles: ["喜庆"],
          priceLevel: "高端款",
          scenes: ["婚宴"],
          statuses: [],
        }}
      />,
    );

    expect(screen.getByText("婚宴/喜宴", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("婚宴", { exact: true })).not.toBeInTheDocument();
  });
});
