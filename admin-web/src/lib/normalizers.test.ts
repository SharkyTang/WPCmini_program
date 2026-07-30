import { describe, expect, it } from "vitest";
import { normalizeAdminConfig, normalizeCaseRecord, toCasePayload } from "./normalizers";

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
        homeSections: ["banner"],
      }),
    ).toMatchObject({
      packageTypes: { values: ["礼盒"] },
      styles: { values: ["国风"] },
      homeSections: { values: ["banner"] },
    });
  });

  it("uses safe configuration defaults for partial server config", () => {
    const config = normalizeAdminConfig({ writeEnabled: false, limits: { gallery: 6 } });
    expect(config.writeEnabled).toBe(false);
    expect(config.limits.gallery).toBe(6);
    expect(config.options.packageTypes).toContain("礼盒");
  });

  it("keeps writes disabled when an old or partial response omits the flag", () => {
    expect(normalizeAdminConfig({}).writeEnabled).toBe(false);
    expect(normalizeAdminConfig({ writeEnabled: true }).writeEnabled).toBe(true);
  });
});
