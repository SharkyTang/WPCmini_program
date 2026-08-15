import { describe, expect, it } from "vitest";
import {
  getSceneLabel,
  getSceneOptions,
  normalizeSceneOptions,
  SCENE_VALUES,
} from "./sceneOptions";

describe("sceneOptions", () => {
  it("使用固定的11个内部值和展示顺序", () => {
    expect(SCENE_VALUES).toEqual([
      "婚宴",
      "百日/满月",
      "生日宴",
      "寿宴",
      "乔迁宴",
      "送礼",
      "商务招待",
      "节庆礼赠",
      "企业纪念",
      "商超陈列",
      "电商展示",
    ]);
  });

  it("只替换婚宴的显示名，不改变选项值", () => {
    expect(getSceneLabel("婚宴")).toBe("婚宴/喜宴");
    expect(getSceneLabel("送礼")).toBe("送礼");
    expect(getSceneOptions(["婚宴"])).toEqual([
      { value: "婚宴", label: "婚宴/喜宴" },
    ]);
  });

  it("为旧服务端的7项配置补齐新值并恢复规范顺序", () => {
    expect(
      normalizeSceneOptions([
        "婚宴",
        "送礼",
        "商务招待",
        "节庆礼赠",
        "商超陈列",
        "电商展示",
        "企业纪念",
      ]),
    ).toEqual(SCENE_VALUES);
  });
});
