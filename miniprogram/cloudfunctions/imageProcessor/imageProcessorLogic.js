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

function parseContext(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function firstText(source = {}, keys = []) {
  for (const key of keys) {
    const value = trimText(source && source[key]);
    if (value) return value;
  }
  return "";
}

function resolveAdminActor(context = {}, env = {}) {
  const runtime = parseContext(env.TCB_CONTEXT_CNFG);
  const openid =
    firstText(context, ["OPENID", "openid"]) ||
    firstText(runtime, ["OPENID", "openid"]);
  if (openid) {
    return { authenticated: true, actor: { type: "wechat_openid", id: openid } };
  }
  const uidKeys = [
    "UID",
    "uid",
    "UUID",
    "uuid",
    "TCB_UUID",
    "CLOUDBASE_UID",
    "CLOUDBASE_USER_ID",
    "USER_ID",
  ];
  const uid =
    firstText(context, uidKeys) ||
    firstText(runtime, uidKeys) ||
    firstText(env, ["TCB_UUID", "CLOUDBASE_UID", "CLOUDBASE_USER_ID"]);
  return uid
    ? { authenticated: true, actor: { type: "cloudbase_uid", id: uid } }
    : { authenticated: false, actor: null };
}

function isAdminActor(actor, env = {}) {
  if (!actor || !actor.id) return false;
  if (actor.type === "wechat_openid") {
    return isAdminOpenid(actor.id, env.ADMIN_OPENIDS);
  }
  if (actor.type === "cloudbase_uid") {
    return parseOpenidSet(env.CASE_ADMIN_UIDS).has(actor.id);
  }
  return false;
}

function isWebWriteEnabled(value) {
  return ["1", "true", "yes", "on"].includes(trimText(value).toLowerCase());
}

function isCloudFileId(value) {
  return trimText(value).indexOf("cloud://") === 0;
}

function getCloudFilePath(fileID) {
  const value = trimText(fileID);
  if (!isCloudFileId(value)) return "";
  const body = value.slice("cloud://".length);
  const slashIndex = body.indexOf("/");
  return slashIndex === -1 ? "" : body.slice(slashIndex + 1);
}

function isWebAdminUploadFile(fileID, uid) {
  const path = getCloudFilePath(fileID);
  const normalizedUid = trimText(uid);
  if (!path || !normalizedUid || path.includes("..")) return false;
  const parts = path.split("/").filter(Boolean);
  return (
    parts.length >= 5 &&
    parts[0] === "wine-packaging" &&
    parts[1] === "admin-web" &&
    [normalizedUid, encodeURIComponent(normalizedUid)].includes(parts[2]) &&
    Boolean(parts[3]) &&
    /\.(?:jpe?g|png|webp)$/i.test(parts.slice(4).join("/"))
  );
}

function detectSupportedImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return "";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "png";
  }
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "webp";
  }
  return "";
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
  detectSupportedImageType,
  generateVariantBuffers,
  getCloudFilePath,
  isAdminActor,
  isAdminOpenid,
  isWebAdminUploadFile,
  isWebWriteEnabled,
  normalizeSourceFiles,
  resolveAdminActor,
  trimText,
};
