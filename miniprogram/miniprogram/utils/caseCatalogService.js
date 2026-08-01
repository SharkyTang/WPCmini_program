const { normalizeCaseRecord } = require("./caseData");

const CASE_CATALOG_FUNCTION = "caseCatalog";
const CATALOG_IMAGE_ID_LIMIT = 24;

function normalizeFunctionResult(response) {
  const result = (response && response.result) || {};
  if (result.ok === false) {
    const error = new Error(result.message || "案例目录请求失败");
    error.code = result.code || "CASE_CATALOG_ERROR";
    throw error;
  }
  return result;
}

async function callCaseCatalog(action, payload = {}) {
  if (!wx.cloud) {
    throw new Error("当前基础库不支持云开发");
  }
  const response = await wx.cloud.callFunction({
    name: CASE_CATALOG_FUNCTION,
    data: {
      action,
      ...payload,
    },
  });
  return normalizeFunctionResult(response);
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
  return {
    revision: Number(result.revision) || 1,
    notModified: result.notModified === true,
    banners: result.banners || [],
    popularCases: (result.popularCases || []).map(normalizeCatalogCard),
    latestCases: (result.latestCases || []).map(normalizeCatalogCard),
  };
}

async function fetchHomeFeed(options = {}) {
  const result = await callCaseCatalog("getHomeFeed", {
    knownRevision: options.knownRevision,
  });
  return normalizeHomeFeed(result);
}

async function fetchCatalogSnapshot(options = {}) {
  const result = await callCaseCatalog("getCatalogSnapshot", {
    knownRevision: options.knownRevision,
  });
  return {
    revision: Number(result.revision) || 1,
    notModified: result.notModified === true,
    items: (result.items || []).map(normalizeCatalogCard),
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
  const images = result.images && typeof result.images === "object"
    ? result.images
    : {};
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

function normalizeDetailItem(record = {}) {
  const item = normalizeCaseRecord({
    ...record,
    _id: record.id || record._id,
  });
  const gallery = (record.gallery || []).map((image) => ({
    fileID: image.fileID || "",
    url: image.displayUrl || "",
    thumbnailUrl: image.thumbnailUrl || image.displayUrl || "",
    downloadUrl: image.downloadUrl || image.displayUrl || "",
  }));
  return {
    ...item,
    gallery,
    galleryImages: gallery.map((image) => image.fileID).filter(Boolean),
    coverImage: gallery[0] ? gallery[0].fileID : item.coverImage,
    coverImageUrl: gallery[0] ? gallery[0].url : record.coverImageUrl || "",
  };
}

async function fetchCaseDetail(id) {
  const result = await callCaseCatalog("getCaseDetail", { id });
  return normalizeDetailItem(result.item || {});
}

async function fetchUserLibrary(type) {
  const result = await callCaseCatalog("listUserLibrary", { type });
  return (result.items || []).map((item) => ({
    recordId: item.recordId || "",
    viewedAt: item.viewedAt || null,
    viewCount: Number(item.viewCount) || 0,
    caseItem: normalizeCatalogCard(item.caseItem || {}),
  }));
}

module.exports = {
  CASE_CATALOG_FUNCTION,
  callCaseCatalog,
  fetchCaseDetail,
  fetchCatalogImageUrls,
  fetchCatalogSnapshot,
  fetchHomeFeed,
  fetchUserLibrary,
  normalizeCatalogCard,
  normalizeCatalogImageIds,
  normalizeDetailItem,
  normalizeHomeFeed,
};
