const { normalizeCaseRecord } = require("./caseData");

const CASE_CATALOG_FUNCTION = "caseCatalog";
const CATALOG_IMAGE_ID_LIMIT = 24;
const DETAIL_PATCH_BATCH_LIMIT = 9;
const LEGACY_FALLBACK_CODES = new Set([
  "-501000",
  "FUNCTION_NOT_FOUND",
  "UNKNOWN_ACTION",
]);
const LEGACY_FALLBACK_MESSAGES = new Set([
  "function not found",
  "云函数不存在",
  "unknown action",
  "未知案例目录操作",
]);

let catalogUnavailableForSession = false;
const unavailableActions = new Set();

function createCatalogError(code, message) {
  const error = new Error(message || "案例目录请求失败");
  error.code = code;
  return error;
}

function normalizeErrorCode(error) {
  const rawCode = error && (error.code || error.errCode);
  return rawCode === undefined || rawCode === null
    ? ""
    : String(rawCode).trim().toUpperCase();
}

function normalizeCompatibilityMessage(error) {
  const rawMessage = error && (error.errMsg || error.message);
  if (typeof rawMessage !== "string") return "";
  return rawMessage
    .trim()
    .replace(/^cloud\.callFunction:fail\s*/i, "")
    .trim()
    .toLowerCase();
}

function classifyCaseCatalogError(error) {
  const code = normalizeErrorCode(error);
  const message = normalizeCompatibilityMessage(error);
  const allowLegacyFallback = code
    ? LEGACY_FALLBACK_CODES.has(code)
    : LEGACY_FALLBACK_MESSAGES.has(message);
  let kind = "unknown";
  if (allowLegacyFallback) {
    kind = code === "UNKNOWN_ACTION" || message === "unknown action" || message === "未知案例目录操作"
      ? "unsupported_action"
      : "function_unavailable";
  } else if (code === "CASE_NOT_FOUND") {
    kind = "not_found";
  } else if (code.indexOf("CATALOG_INVALID_") === 0) {
    kind = "invalid_response";
  } else if (/timeout|network|request:fail|connection/.test(message)) {
    kind = "network";
  } else if (code) {
    kind = "service";
  }
  return { code, kind, allowLegacyFallback };
}

function isLegacyCatalogFallbackAllowed(error) {
  return classifyCaseCatalogError(error).allowLegacyFallback;
}

function normalizeFunctionResult(response) {
  const result = response && response.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw createCatalogError(
      "CATALOG_INVALID_RESULT",
      "案例目录返回结构无效"
    );
  }
  if (result.ok === false) {
    throw createCatalogError(
      result.code || "CASE_CATALOG_ERROR",
      result.message || "案例目录请求失败"
    );
  }
  if (result.ok !== true) {
    throw createCatalogError(
      "CATALOG_INVALID_RESULT",
      "案例目录返回缺少成功标记"
    );
  }
  return result;
}

async function callCaseCatalog(action, payload = {}) {
  if (catalogUnavailableForSession || unavailableActions.has(action)) {
    throw createCatalogError(
      unavailableActions.has(action) ? "UNKNOWN_ACTION" : "FUNCTION_NOT_FOUND",
      "案例目录服务在当前会话不可用"
    );
  }
  if (!wx.cloud) {
    throw new Error("当前基础库不支持云开发");
  }
  try {
    const response = await wx.cloud.callFunction({
      name: CASE_CATALOG_FUNCTION,
      data: {
        action,
        ...payload,
      },
    });
    return normalizeFunctionResult(response);
  } catch (error) {
    const classification = classifyCaseCatalogError(error);
    if (classification.allowLegacyFallback) {
      if (classification.kind === "unsupported_action") {
        unavailableActions.add(action);
      } else {
        catalogUnavailableForSession = true;
      }
    }
    throw error;
  }
}

function normalizeRevision(value) {
  const revision = Number(value);
  return Number.isFinite(revision) && revision >= 0 ? revision : 0;
}

function requireArray(value, code = "CATALOG_INVALID_ITEMS") {
  if (!Array.isArray(value)) {
    throw createCatalogError(code, "案例目录列表结构无效");
  }
  if (value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw createCatalogError(code, "案例目录列表成员无效");
  }
  return value;
}

function normalizeCatalogCard(record = {}) {
  const item = normalizeCaseRecord({
    ...record,
    _id: record.id || record._id,
    coverImage: record.imageFileId || record.coverImage,
    coverThumbnail: record.imageFileId || record.coverThumbnail,
  });
  return {
    ...item,
    imageFileId: record.imageFileId || item.coverThumbnail || item.coverImage,
    coverImageUrl: record.thumbnailUrl || record.coverImageUrl || "",
    thumbnailUrl: record.thumbnailUrl || record.coverImageUrl || "",
    imageLoadState: record.thumbnailUrl || record.coverImageUrl ? "ready" : "failed",
    imageRetryCount: 0,
  };
}

function normalizeHomeFeed(result = {}) {
  const notModified = result.notModified === true;
  if (!notModified) {
    requireArray(result.banners);
    requireArray(result.popularCases);
    requireArray(result.latestCases);
  }
  return {
    revision: normalizeRevision(result.revision),
    notModified,
    feedModeUsed:
      typeof result.feedModeUsed === "string" ? result.feedModeUsed : "legacy",
    banners: notModified ? [] : result.banners,
    popularCases: notModified ? [] : result.popularCases.map(normalizeCatalogCard),
    latestCases: notModified ? [] : result.latestCases.map(normalizeCatalogCard),
  };
}

async function fetchHomeFeed(options = {}) {
  const result = await callCaseCatalog("getHomeFeed", {
    knownRevision: options.knownRevision,
    knownFeedMode: options.knownFeedMode,
    feedMode: options.feedMode || "indexed_v2",
  });
  return normalizeHomeFeed(result);
}

async function fetchCatalogSnapshot(options = {}) {
  const result = await callCaseCatalog("getCatalogSnapshot", {
    knownRevision: options.knownRevision,
  });
  const notModified = result.notModified === true;
  if (!notModified) requireArray(result.items);
  return {
    revision: normalizeRevision(result.revision),
    notModified,
    items: notModified ? [] : result.items.map(normalizeCatalogCard),
  };
}

function normalizeCatalogImageIds(ids = []) {
  if (!Array.isArray(ids)) return [];
  return Array.from(
    new Set(
      ids
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter(Boolean)
    )
  ).slice(0, CATALOG_IMAGE_ID_LIMIT);
}

async function fetchCatalogImageUrls(ids = []) {
  const requestedIds = normalizeCatalogImageIds(ids);
  if (!requestedIds.length) return {};
  const result = await callCaseCatalog("getCatalogImageUrls", {
    ids: requestedIds,
  });
  if (
    !result.images
    || typeof result.images !== "object"
    || Array.isArray(result.images)
  ) {
    throw createCatalogError(
      "CATALOG_INVALID_RESULT",
      "案例图片映射结构无效"
    );
  }
  const images = result.images;
  return requestedIds.reduce((map, id) => {
    const image = images[id];
    if (!image || typeof image !== "object") return map;
    map[id] = {
      imageFileId:
        typeof image.imageFileId === "string" ? image.imageFileId : "",
      thumbnailUrl:
        typeof image.thumbnailUrl === "string" ? image.thumbnailUrl : "",
    };
    return map;
  }, {});
}

function normalizeDetailItem(record = {}, metadata = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw createCatalogError("CATALOG_INVALID_RESULT", "案例详情结构无效");
  }
  const item = normalizeCaseRecord({
    ...record,
    _id: record.id || record._id,
  });
  const gallerySource = requireArray(record.gallery || []);
  const gallery = gallerySource.map((image, index) => {
    const source = image && typeof image === "object" ? image : {};
    const displayUrl = typeof source.displayUrl === "string" ? source.displayUrl : "";
    const heroUrl = typeof source.heroUrl === "string" ? source.heroUrl : "";
    const thumbnailUrl =
      typeof source.thumbnailUrl === "string" ? source.thumbnailUrl : "";
    const downloadUrl = typeof source.downloadUrl === "string" ? source.downloadUrl : "";
    return {
      index: Number.isInteger(source.index) ? source.index : index,
      fileID: typeof source.fileID === "string" ? source.fileID : "",
      url: displayUrl || heroUrl,
      heroUrl,
      displayUrl,
      thumbnailUrl: thumbnailUrl || heroUrl || displayUrl,
      downloadUrl: downloadUrl || displayUrl,
      hydrated: source.hydrated === true || Boolean(displayUrl),
    };
  });
  const firstImage = gallery[0];
  return {
    ...item,
    detailSchemaVersion: Number(metadata.detailSchemaVersion) || 1,
    detailMode: metadata.detailMode || "legacy",
    gallery,
    galleryImages: gallery.map((image) => image.fileID).filter(Boolean),
    coverImage: firstImage ? firstImage.fileID : item.coverImage,
    coverImageUrl:
      (typeof record.coverImageUrl === "string" && record.coverImageUrl) ||
      (firstImage && (firstImage.heroUrl || firstImage.displayUrl)) ||
      "",
  };
}

async function fetchCaseDetail(id, options = {}) {
  const result = await callCaseCatalog("getCaseDetail", {
    id,
    detailMode: options.detailMode || "initial_v2",
  });
  if (!result.item) {
    throw createCatalogError("CATALOG_INVALID_RESULT", "案例详情缺少 item");
  }
  return normalizeDetailItem(result.item, {
    detailSchemaVersion: result.detailSchemaVersion,
    detailMode: result.detailMode,
  });
}

function normalizeDetailPatch(result = {}, indexes = []) {
  const requested = new Set(indexes);
  if (Array.isArray(result.galleryPatch)) {
    return result.galleryPatch
      .filter((image) => image && typeof image === "object")
      .map((image) => ({
        index: Number(image.index),
        fileID: typeof image.fileID === "string" ? image.fileID : "",
        displayUrl:
          typeof image.displayUrl === "string" ? image.displayUrl : "",
        downloadUrl:
          typeof image.downloadUrl === "string"
            ? image.downloadUrl
            : typeof image.displayUrl === "string"
              ? image.displayUrl
              : "",
      }))
      .filter(
        (image) =>
          Number.isInteger(image.index) &&
          requested.has(image.index) &&
          image.fileID &&
          image.displayUrl
      );
  }
  if (result.item) {
    const legacy = normalizeDetailItem(result.item, {
      detailSchemaVersion: result.detailSchemaVersion,
      detailMode: result.detailMode,
    });
    return legacy.gallery
      .filter((image) => requested.has(image.index) && image.displayUrl)
      .map((image) => ({
        index: image.index,
        fileID: image.fileID,
        displayUrl: image.displayUrl,
        downloadUrl: image.downloadUrl || image.displayUrl,
      }));
  }
  throw createCatalogError(
    "CATALOG_INVALID_RESULT",
    "案例图库补丁返回结构无效"
  );
}

function normalizePatchIndexes(indexes = []) {
  if (!Array.isArray(indexes)) return [];
  return Array.from(
    new Set(
      indexes
        .filter((index) => Number.isInteger(index) && index >= 0)
    )
  );
}

async function fetchCaseDetailPatch(id, indexes = []) {
  const requestedIndexes = normalizePatchIndexes(indexes);
  if (!requestedIndexes.length) return [];
  const patches = [];
  for (
    let offset = 0;
    offset < requestedIndexes.length;
    offset += DETAIL_PATCH_BATCH_LIMIT
  ) {
    const batch = requestedIndexes.slice(
      offset,
      offset + DETAIL_PATCH_BATCH_LIMIT
    );
    const result = await callCaseCatalog("getCaseDetail", {
      id,
      detailMode: "gallery_patch_v2",
      indexes: batch,
    });
    if (result.item) {
      return normalizeDetailPatch(result, requestedIndexes);
    }
    patches.push(...normalizeDetailPatch(result, batch));
  }
  return patches;
}

async function fetchUserLibrary(type) {
  const result = await callCaseCatalog("listUserLibrary", { type });
  return requireArray(result.items).map((item) => ({
    recordId: item.recordId || "",
    viewedAt: item.viewedAt || null,
    viewCount: Number(item.viewCount) || 0,
    caseItem: normalizeCatalogCard(item.caseItem || {}),
  }));
}

module.exports = {
  CASE_CATALOG_FUNCTION,
  callCaseCatalog,
  classifyCaseCatalogError,
  fetchCaseDetail,
  fetchCaseDetailPatch,
  fetchCatalogImageUrls,
  fetchCatalogSnapshot,
  fetchHomeFeed,
  fetchUserLibrary,
  isLegacyCatalogFallbackAllowed,
  normalizeCatalogCard,
  normalizeCatalogImageIds,
  normalizeDetailItem,
  normalizeDetailPatch,
  normalizeHomeFeed,
  normalizePatchIndexes,
};
