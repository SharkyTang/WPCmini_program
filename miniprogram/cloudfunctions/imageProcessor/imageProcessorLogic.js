const crypto = require("node:crypto");

const MAX_FILES = 5;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const DISPLAY_LONG_EDGE = 1600;
const THUMBNAIL_SIZE = 640;
const THUMBNAIL_TARGET_BYTES = 100 * 1024;

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseOpenidSet(value) {
  return new Set(
    trimText(value)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function isAdminOpenid(openid, envValue) {
  return Boolean(openid && parseOpenidSet(envValue).has(openid));
}

function isCloudFileId(value) {
  return trimText(value).indexOf("cloud://") === 0;
}

function normalizeSourceFiles(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  return source
    .map((item) => (typeof item === "string" ? item : item && item.fileID))
    .map(trimText)
    .filter(isCloudFileId)
    .filter((fileID) => {
      if (seen.has(fileID)) return false;
      seen.add(fileID);
      return true;
    })
    .slice(0, MAX_FILES);
}

function buildVariantPaths(fileID) {
  const digest = crypto.createHash("sha256").update(fileID).digest("hex").slice(0, 32);
  return {
    displayPath: `wine-packaging/variants/${digest}/display.jpg`,
    thumbnailPath: `wine-packaging/variants/${digest}/thumbnail.jpg`,
  };
}

async function buildThumbnailBuffer(sharpFactory, sourceBuffer) {
  let quality = 68;
  let buffer = null;
  while (quality >= 48) {
    buffer = await sharpFactory(sourceBuffer)
      .rotate()
      .toColorspace("srgb")
      .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
        fit: "cover",
        position: "attention",
        withoutEnlargement: true,
      })
      .jpeg({
        quality,
        mozjpeg: true,
      })
      .toBuffer();
    if (buffer.length <= THUMBNAIL_TARGET_BYTES) break;
    quality -= 8;
  }
  return { buffer, quality };
}

async function generateVariantBuffers(sharpFactory, sourceBuffer) {
  if (!Buffer.isBuffer(sourceBuffer) || !sourceBuffer.length) {
    throw new Error("图片文件为空");
  }
  if (sourceBuffer.length > MAX_SOURCE_BYTES) {
    throw new Error("单张原图不能超过 20MB");
  }

  const source = sharpFactory(sourceBuffer, { failOn: "warning" }).rotate();
  const metadata = await source.metadata();
  const displayBuffer = await sharpFactory(sourceBuffer)
    .rotate()
    .toColorspace("srgb")
    .resize({
      width: DISPLAY_LONG_EDGE,
      height: DISPLAY_LONG_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({
      quality: 80,
      mozjpeg: true,
    })
    .toBuffer();
  const thumbnail = await buildThumbnailBuffer(sharpFactory, sourceBuffer);

  return {
    metadata: {
      width: metadata.width || 0,
      height: metadata.height || 0,
      sourceBytes: sourceBuffer.length,
      displayBytes: displayBuffer.length,
      thumbnailBytes: thumbnail.buffer.length,
      thumbnailQuality: thumbnail.quality,
    },
    displayBuffer,
    thumbnailBuffer: thumbnail.buffer,
  };
}

module.exports = {
  DISPLAY_LONG_EDGE,
  MAX_FILES,
  MAX_SOURCE_BYTES,
  THUMBNAIL_SIZE,
  THUMBNAIL_TARGET_BYTES,
  buildVariantPaths,
  generateVariantBuffers,
  isAdminOpenid,
  normalizeSourceFiles,
  trimText,
};
