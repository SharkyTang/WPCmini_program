import { describe, expect, it } from "vitest";
import {
  buildStoragePath,
  canAddGalleryImages,
  countActiveFilters,
  mergeTagValues,
  moveItem,
  normalizeValues,
} from "./caseLogic";
import { EMPTY_FILTERS } from "../constants";

describe("caseLogic", () => {
  it("normalizes legacy values objects without duplicates", () => {
    expect(normalizeValues({ values: ["礼盒", "礼盒", " 瓶标 "] })).toEqual([
      "礼盒",
      "瓶标",
    ]);
  });

  it("applies all three batch tag modes", () => {
    expect(mergeTagValues(["礼盒"], ["瓶标"], "append")).toEqual(["礼盒", "瓶标"]);
    expect(mergeTagValues(["礼盒", "瓶标"], ["礼盒"], "remove")).toEqual(["瓶标"]);
    expect(mergeTagValues(["礼盒"], ["外箱"], "replace")).toEqual(["外箱"]);
  });

  it("moves an item without mutating the source", () => {
    const source = ["a", "b", "c"];
    expect(moveItem(source, 2, 0)).toEqual(["c", "a", "b"]);
    expect(source).toEqual(["a", "b", "c"]);
  });

  it("fails closed before gallery uploads when admin writes are disabled", () => {
    expect(canAddGalleryImages(false, 1, 9, false, false)).toBe(false);
    expect(canAddGalleryImages(true, 1, 9, false, false)).toBe(true);
    expect(canAddGalleryImages(true, 9, 9, false, false)).toBe(false);
  });

  it("builds a deterministic retry-safe encoded CloudBase path", () => {
    const first = buildStoragePath("user/name+1", "mutation-01", " 正面 展示.PNG", 0);
    const second = buildStoragePath("user/name+1", "mutation-01", " 正面 展示.PNG", 0);
    expect(first).toBe(second);
    expect(first).toBe(
      "wine-packaging/admin-web/user%2Fname%2B1/mutation-01/01-正面-展示.png",
    );
    expect(() => buildStoragePath("", "batch", "a.jpg", 0)).toThrow("管理员 UID");
  });

  it("counts compound filters", () => {
    expect(
      countActiveFilters({
        ...EMPTY_FILTERS,
        keyword: "青瓷",
        styles: ["国风", "简约"],
        visibility: "hidden",
      }),
    ).toBe(4);
  });
});
