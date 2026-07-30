const crypto = require("node:crypto");

const MAX_FILES = 9;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const DISPLAY_LONG_EDGE = 1600;
const THUMBNAIL_SIZE = 640;
const THUMBNAIL_TARGET_BYTES = 100 * 1024;
const BANNER_LONG_EDGE = 1080;
const BANNER_TARGET_BYTES = 180 * 1024;
const IMAGE_VARIANT_VERSION = 2;

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
    displayPath: `wine-packaging/variants/v2/${digest}/display.jpg`,
    thumbnailPath: `wine-packaging/variants/v2/${digest}/thumbnail.jpg`,
    bannerPath: `wine-packaging/variants/v2/${digest}/banner.jpg`,
  };
}

async function buildThumbnailBuffer(sharpFactory, sourceBuffer) {
  let quality = 68;
  let buffer = null;
  while (true) {
    buffer = await sharpFactory(sourceBuffer, { failOn: "none" })
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
    if (buffer.length <= THUMBNAIL_TARGET_BYTES || quality <= 20) break;
    quality = Math.max(20, quality - 8);
  }
  return { buffer, quality };
}

async function buildBannerBuffer(sharpFactory, sourceBuffer) {
  let quality = 72;
  let buffer = null;
  while (true) {
    buffer = await sharpFactory(sourceBuffer, { failOn: "none" })
      .rotate()
      .toColorspace("srgb")
      .resize({
        width: BANNER_LONG_EDGE,
        height: BANNER_LONG_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({
        quality,
        mozjpeg: true,
      })
      .toBuffer();
    if (buffer.length <= BANNER_TARGET_BYTES || quality <= 12) break;
    quality = Math.max(12, quality - 8);
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

  const source = sharpFactory(sourceBuffer, { failOn: "none" }).rotate();
  const metadata = await source.metadata();
  const displayBuffer = await sharpFactory(sourceBuffer, { failOn: "none" })
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
  const banner = await buildBannerBuffer(sharpFactory, sourceBuffer);

  return {
    metadata: {
      width: metadata.width || 0,
      height: metadata.height || 0,
      sourceBytes: sourceBuffer.length,
      displayBytes: displayBuffer.length,
      thumbnailBytes: thumbnail.buffer.length,
      thumbnailQuality: thumbnail.quality,
      bannerBytes: banner.buffer.length,
      bannerQuality: banner.quality,
      variantVersion: IMAGE_VARIANT_VERSION,
    },
    displayBuffer,
    thumbnailBuffer: thumbnail.buffer,
    bannerBuffer: banner.buffer,
  };
}

module.exports = {
  BANNER_LONG_EDGE,
  BANNER_TARGET_BYTES,
  DISPLAY_LONG_EDGE,
  IMAGE_VARIANT_VERSION,
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
