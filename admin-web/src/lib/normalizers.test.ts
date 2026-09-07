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

  it("normalizes optional video metadata and rejects unsafe URLs", () => {
    const item = normalizeCaseRecord({
      _id: "video-case",
      videoUrl: " https://cdn.example.com/case.mp4 ",
      videoPoster: "http://cdn.example.com/poster.jpg",
      videoDurationSeconds: "88",
    });

    expect(item.videoUrl).toBe("https://cdn.example.com/case.mp4");
    expect(item.videoPoster).toBe("");
    expect(item.videoDurationSeconds).toBe(88);
    expect(normalizeCaseRecord({ videoUrl: "https://user:secret@example.com/a.mp4" }).videoUrl).toBe("");
    expect(normalizeCaseRecord({ videoDurationSeconds: 0 }).videoDurationSeconds).toBeNull();
    expect(
      normalizeCaseRecord({
        videoPoster: "https://cdn.example.com/poster.jpg",
        videoDurationSeconds: 88,
      }),
    ).toMatchObject({ videoUrl: "", videoPoster: "", videoDurationSeconds: null });

    expect(normalizeCaseRecord({
      _id: "uploaded-video",
      videoFileID: "cloud://env/wine-packaging/videos/admin/case/video.mp4",
      videoPreviewUrl: "https://cdn.example.com/temp-video.mp4",
      videoPosterFileID: "cloud://env/wine-packaging/videos/admin/case/poster.jpg",
      videoPosterPreviewUrl: "https://cdn.example.com/temp-poster.jpg",
      videoDurationSeconds: 45,
      videoFileSizeBytes: 123456,
    })).toMatchObject({
      videoFileID: "cloud://env/wine-packaging/videos/admin/case/video.mp4",
      videoUrl: "",
      videoPreviewUrl: "https://cdn.example.com/temp-video.mp4",
      videoPosterFileID: "cloud://env/wine-packaging/videos/admin/case/poster.jpg",
      videoPosterPreviewUrl: "https://cdn.example.com/temp-poster.jpg",
      videoDurationSeconds: 45,
      videoFileSizeBytes: 123456,
    });
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

  it("never mixes video fields into the generic case payload", () => {
    const payload = toCasePayload({
      title: "案例",
      videoFileID: "cloud://env/video.mp4",
      videoUrl: "https://cdn.example.com/case.mp4",
      videoPosterFileID: "cloud://env/poster.jpg",
      videoPoster: "https://cdn.example.com/poster.jpg",
      videoDurationSeconds: 88,
      videoFileSizeBytes: 1234,
    });
    expect(payload).toEqual({ title: "案例" });
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
    expect(config.limits.videoUploadBytes).toBe(100 * 1024 * 1024);
    expect(config.limits.videoDurationSeconds).toBe(120);
    expect(config.limits.videoPosterUploadBytes).toBe(5 * 1024 * 1024);
    expect(config.features).toEqual({
      videoUploadEnabled: false,
      videoDisplayEnabled: false,
    });
    expect(config.options.packageTypes).toContain("礼盒");
  });

  it("keeps writes disabled when an old or partial response omits the flag", () => {
    expect(normalizeAdminConfig({}).writeEnabled).toBe(false);
    expect(normalizeAdminConfig({}).permanentDeleteEnabled).toBe(false);
    expect(normalizeAdminConfig({}).activitySyncEnabled).toBe(false);
    expect(normalizeAdminConfig({ writeEnabled: true }).writeEnabled).toBe(true);
    expect(normalizeAdminConfig({
      features: { videoUploadEnabled: true, videoDisplayEnabled: true },
      limits: {
        videoUploadBytes: 42,
        videoDurationSeconds: 9,
        videoPosterUploadBytes: 7,
      },
    })).toMatchObject({
      features: { videoUploadEnabled: true, videoDisplayEnabled: true },
      limits: { videoUploadBytes: 42, videoDurationSeconds: 9, videoPosterUploadBytes: 7 },
    });
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
