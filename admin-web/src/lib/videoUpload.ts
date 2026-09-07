import type { VideoFileMetadata } from "../types";

export interface VideoUploadLimits {
  maxBytes: number;
  maxDurationSeconds: number;
  maxLongEdge: number;
  maxShortEdge: number;
}

export interface VideoMetadataCandidate {
  duration: number;
  width: number;
  height: number;
}

const VIDEO_METADATA_TIMEOUT_MS = 15_000;
const POSTER_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const POSTER_EXTENSIONS = /\.(?:jpe?g|png|webp)$/i;

function fileExtension(fileName: string): string {
  const match = /\.([^.]+)$/.exec(fileName.trim());
  return match ? match[1].toLowerCase() : "";
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

export function formatVideoDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.ceil(Number(seconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(safeSeconds % 60).padStart(2, "0")}`;
}

export function validateVideoMetadata(
  file: Pick<File, "name" | "type" | "size">,
  metadata: VideoMetadataCandidate,
  limits: VideoUploadLimits,
): VideoFileMetadata {
  if (fileExtension(file.name) !== "mp4") {
    throw new Error("仅支持 MP4 视频，请先转换格式后再上传");
  }
  if (file.type && file.type.toLowerCase() !== "video/mp4") {
    throw new Error("文件类型不是 video/mp4，请重新选择 MP4 视频");
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error("视频文件为空或大小无效");
  }
  if (file.size > limits.maxBytes) {
    throw new Error(`视频不能超过 ${formatFileSize(limits.maxBytes)}`);
  }
  if (!Number.isFinite(metadata.duration) || metadata.duration <= 0) {
    throw new Error("无法读取视频时长，请重新选择可正常播放的 MP4 视频");
  }
  const durationSeconds = Math.ceil(metadata.duration);
  if (durationSeconds > limits.maxDurationSeconds) {
    throw new Error(`视频不能超过 ${limits.maxDurationSeconds} 秒`);
  }
  if (
    !Number.isFinite(metadata.width) ||
    !Number.isFinite(metadata.height) ||
    metadata.width <= 0 ||
    metadata.height <= 0
  ) {
    throw new Error("无法读取视频分辨率，请重新选择可正常播放的 MP4 视频");
  }
  const width = Math.round(metadata.width);
  const height = Math.round(metadata.height);
  if (
    Math.max(width, height) > limits.maxLongEdge ||
    Math.min(width, height) > limits.maxShortEdge
  ) {
    throw new Error("视频分辨率不能超过 1080p（横屏 1920×1080，竖屏 1080×1920）");
  }
  return {
    durationSeconds,
    width,
    height,
    fileSizeBytes: file.size,
  };
}

export function validateVideoPosterFile(
  file: Pick<File, "name" | "type" | "size">,
  maxBytes: number,
): void {
  if (!POSTER_EXTENSIONS.test(file.name) || (file.type && !POSTER_TYPES.has(file.type.toLowerCase()))) {
    throw new Error("封面仅支持 JPEG、PNG 或 WebP 图片");
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error("封面文件为空或大小无效");
  }
  if (file.size > maxBytes) {
    throw new Error(`封面不能超过 ${formatFileSize(maxBytes)}`);
  }
}

async function assertMp4Signature(file: File): Promise<void> {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const signature = String.fromCharCode(...header.slice(4, 8));
  if (header.length < 12 || signature !== "ftyp") {
    throw new Error("文件内容不是有效的 MP4 视频");
  }
}

function readBrowserVideoMetadata(file: File): Promise<VideoMetadataCandidate> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const objectUrl = URL.createObjectURL(file);
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
      callback();
    };
    const timeout = window.setTimeout(() => {
      finish(() => reject(new Error("读取视频信息超时，请重新选择视频")));
    }, VIDEO_METADATA_TIMEOUT_MS);
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => {
      finish(() => resolve({
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      }));
    };
    video.onerror = () => {
      finish(() => reject(new Error("无法解析视频，请确认文件为可播放的 MP4（H.264 + AAC）")));
    };
    video.src = objectUrl;
  });
}

export async function inspectCaseVideoFile(
  file: File,
  limits: VideoUploadLimits,
): Promise<VideoFileMetadata> {
  // Cheap checks run before the browser allocates a decoder for a large file.
  validateVideoMetadata(file, { duration: 1, width: 1, height: 1 }, {
    ...limits,
    maxDurationSeconds: Number.MAX_SAFE_INTEGER,
    maxLongEdge: Number.MAX_SAFE_INTEGER,
    maxShortEdge: Number.MAX_SAFE_INTEGER,
  });
  await assertMp4Signature(file);
  return validateVideoMetadata(file, await readBrowserVideoMetadata(file), limits);
}
