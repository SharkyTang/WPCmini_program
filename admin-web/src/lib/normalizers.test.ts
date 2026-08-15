import { describe, expect, it } from "vitest";
import { normalizeAdminConfig, normalizeCaseRecord, toCasePayload } from "./normalizers";
import { SCENE_VALUES } from "./sceneOptions";

describe("normalizers", () => {
  it("preserves gallery URL indexes and never exposes cloud IDs as URLs", () => {
    const item = normalizeCaseRecord({
      _id: "one",
      title: "案例",
      galleryImages: ["cloud://env/a.jpg", "cloud://env/b.jpg"],
      galleryImageUrls: ["https://example.com/a.jpg", ""],
    });
    expect(item.galleryImageUrls).toEqual(["https://example.com/a.jpg", ""]);
    expect(item.coverImageUrl).toBe("https://example.com/a.jpg");
  });

  it("serializes multi-value fields with the established values shape", () => {
    expect(
      toCasePayload({
        title: "案例",
        packageTypes: ["礼盒"],
        styles: ["国风"],
        scenes: ["婚宴"],
        homeSections: ["banner"],
      }),
    ).toMatchObject({
      packageTypes: { values: ["礼盒"] },
      styles: { values: ["国风"] },
      scenes: { values: ["婚宴"] },
      homeSections: { values: ["banner"] },
    });
  });

  it("uses safe configuration defaults for partial server config", () => {
    const config = normalizeAdminConfig({
      writeEnabled: false,
      permanentDeleteEnabled: true,
      activitySyncEnabled: true,
      limits: { gallery: 6 },
    });
    expect(config.writeEnabled).toBe(false);
    expect(config.permanentDeleteEnabled).toBe(true);
    expect(config.activitySyncEnabled).toBe(true);
    expect(config.limits.gallery).toBe(6);
    expect(config.options.packageTypes).toContain("礼盒");
  });

  it("keeps writes disabled when an old or partial response omits the flag", () => {
    expect(normalizeAdminConfig({}).writeEnabled).toBe(false);
    expect(normalizeAdminConfig({}).permanentDeleteEnabled).toBe(false);
    expect(normalizeAdminConfig({}).activitySyncEnabled).toBe(false);
    expect(normalizeAdminConfig({ writeEnabled: true }).writeEnabled).toBe(true);
  });

  it("补齐旧服务端缺少的四个宴席场景并保留规范顺序", () => {
    const config = normalizeAdminConfig({
      options: {
        scenes: [
          "婚宴",
          "送礼",
          "商务招待",
          "节庆礼赠",
          "商超陈列",
          "电商展示",
          "企业纪念",
        ],
      },
    });

    expect(config.options.scenes).toEqual(SCENE_VALUES);
  });
});
