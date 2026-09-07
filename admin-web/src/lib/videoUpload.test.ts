import { describe, expect, it } from "vitest";
import {
  formatVideoDuration,
  validateVideoMetadata,
  validateVideoPosterFile,
} from "./videoUpload";

const limits = {
  maxBytes: 100 * 1024 * 1024,
  maxDurationSeconds: 120,
  maxLongEdge: 1920,
  maxShortEdge: 1080,
};

function videoFile(overrides: Partial<Pick<File, "name" | "type" | "size">> = {}) {
  return {
    name: "case.mp4",
    type: "video/mp4",
    size: 100 * 1024 * 1024,
    ...overrides,
  } as Pick<File, "name" | "type" | "size">;
}

describe("case video upload validation", () => {
  it("accepts the exact 100MB, 120-second and 1080p boundaries", () => {
    expect(validateVideoMetadata(videoFile(), {
      duration: 120,
      width: 1920,
      height: 1080,
    }, limits)).toEqual({
      durationSeconds: 120,
      width: 1920,
      height: 1080,
      fileSizeBytes: 100 * 1024 * 1024,
    });
    expect(validateVideoMetadata(videoFile(), {
      duration: 119.01,
      width: 1080,
      height: 1920,
    }, limits).durationSeconds).toBe(120);
  });

  it("rejects files one byte or one fractional second over the limits", () => {
    expect(() => validateVideoMetadata(videoFile({ size: limits.maxBytes + 1 }), {
      duration: 120,
      width: 1920,
      height: 1080,
    }, limits)).toThrow("100 MB");
    expect(() => validateVideoMetadata(videoFile(), {
      duration: 120.01,
      width: 1920,
      height: 1080,
    }, limits)).toThrow("120 秒");
  });

  it("rejects MOV, mismatched MIME, unreadable metadata and 4K", () => {
    expect(() => validateVideoMetadata(videoFile({ name: "iphone.mov", type: "video/quicktime" }), {
      duration: 30,
      width: 1080,
      height: 1920,
    }, limits)).toThrow("仅支持 MP4");
    expect(() => validateVideoMetadata(videoFile({ type: "application/octet-stream" }), {
      duration: 30,
      width: 1080,
      height: 1920,
    }, limits)).toThrow("video/mp4");
    expect(() => validateVideoMetadata(videoFile(), {
      duration: Number.NaN,
      width: 1920,
      height: 1080,
    }, limits)).toThrow("无法读取视频时长");
    expect(() => validateVideoMetadata(videoFile(), {
      duration: 30,
      width: 3840,
      height: 2160,
    }, limits)).toThrow("1080p");
  });

  it("validates poster format and exact 5MB boundary", () => {
    expect(() => validateVideoPosterFile({
      name: "poster.webp",
      type: "image/webp",
      size: 5 * 1024 * 1024,
    } as File, 5 * 1024 * 1024)).not.toThrow();
    expect(() => validateVideoPosterFile({
      name: "poster.gif",
      type: "image/gif",
      size: 100,
    } as File, 5 * 1024 * 1024)).toThrow("JPEG、PNG 或 WebP");
    expect(() => validateVideoPosterFile({
      name: "poster.jpg",
      type: "image/jpeg",
      size: 5 * 1024 * 1024 + 1,
    } as File, 5 * 1024 * 1024)).toThrow("5.0 MB");
  });

  it("formats duration for previews", () => {
    expect(formatVideoDuration(88)).toBe("01:28");
  });
});
