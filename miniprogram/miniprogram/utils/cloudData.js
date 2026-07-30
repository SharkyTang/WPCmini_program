const {
  normalizeCaseRecord,
  normalizeBannerRecord,
  buildFallbackBanners,
} = require("./caseData");

const CASE_COLLECTION = "wine_packaging";
const BANNER_COLLECTION = "home_banners";
const IMAGE_URL_FUNCTION = "caseAdmin";
const PAGE_SIZE = 20;
const TEMP_FILE_URL_BATCH_SIZE = 20;
const TEMP_FILE_URL_CACHE_TTL = 30 * 60 * 1000;

let visibleCasesCache = null;
let visibleBannersCache = null;
const tempFileUrlCache = new Map();
const tempFileUrlRequests = new Map();

function shouldForceRefresh(options = {}) {
  return Boolean(options && options.forceRefresh);
}

function copyList(items) {
  return (items || []).map((item) => ({ ...item }));
}

function clearCloudDataCache(options = {}) {
  visibleCasesCache = null;
  visibleBannersCache = null;
  if (options.clearTempUrls !== false) {
    tempFileUrlCache.clear();
    tempFileUrlRequests.clear();
  }
}

function getDb() {
  if (!wx.cloud) {
    throw new Error("当前基础库不支持云开发");
  }
  return wx.cloud.database();
}

async function fetchAll(collectionName, options = {}) {
  const db = getDb();
  const where = options.where || {};
  const orderField = options.orderField || "sortOrder";
  const orderDirection = options.orderDirection || "asc";
  const records = [];
  let offset = 0;

  while (true) {
    const response = await db
      .collection(collectionName)
      .where(where)
      .orderBy(orderField, orderDirection)
      .skip(offset)
      .limit(PAGE_SIZE)
      .get();
    const page = response.data || [];
    records.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return records;
}

function isCloudFileId(value) {
  return typeof value === "string" && value.indexOf("cloud://") === 0;
}

function chunkList(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function callImageUrlFunction(action, fileIDs) {
  if (!wx.cloud || !fileIDs.length) return {};

  const response = await wx.cloud.callFunction({
    name: IMAGE_URL_FUNCTION,
    data: {
      action,
      fileIDs,
    },
  });
  const result = (response && response.result) || {};
  if (result.ok === false) {
    throw new Error(result.message || "图片链接获取失败");
  }
  return result.urls || {};
}

async function getDirectTempUrlMap(fileIDs) {
  if (!wx.cloud || !wx.cloud.getTempFileURL || !fileIDs.length) return {};

  const map = {};
  for (const fileList of chunkList(fileIDs, TEMP_FILE_URL_BATCH_SIZE)) {
    const response = await wx.cloud.getTempFileURL({ fileList });
    (response.fileList || []).forEach((item) => {
      if (item && item.fileID && item.tempFileURL) {
        map[item.fileID] = item.tempFileURL;
      }
    });
  }
  return map;
}

function resolveImageUrl(fileID, tempUrlMap = {}) {
  return tempUrlMap[fileID] || (isCloudFileId(fileID) ? "" : fileID);
}

function isStableCaseId(id) {
  return typeof id === "string" && id.indexOf("case_") === 0;
}

async function getTempUrlMap(fileIds, options = {}) {
  const uniqueFileIds = Array.from(new Set(fileIds.filter(isCloudFileId)));
  if (!uniqueFileIds.length) return {};
  const tempUrlMap = {};
  const missingFileIds = [];

  const now = Date.now();
  uniqueFileIds.forEach((fileID) => {
    const cached = tempFileUrlCache.get(fileID);
    if (!options.forceRefresh && cached && cached.expiresAt > now) {
      tempUrlMap[fileID] = cached.url;
    } else {
      missingFileIds.push(fileID);
    }
  });

  if (!missingFileIds.length) return tempUrlMap;

  const loadMissingUrls = async () => {
    const map = {};
    for (const fileList of chunkList(missingFileIds, TEMP_FILE_URL_BATCH_SIZE)) {
      const urlMap = await callImageUrlFunction("getVisibleImageUrls", fileList);
      Object.keys(urlMap).forEach((fileID) => {
        const url = urlMap[fileID];
        tempFileUrlCache.set(fileID, { url, expiresAt: Date.now() + TEMP_FILE_URL_CACHE_TTL });
        map[fileID] = url;
      });
    }
    return map;
  };

  const requestKey = missingFileIds.slice().sort().join("|");
  try {
    if (!tempFileUrlRequests.has(requestKey)) {
      tempFileUrlRequests.set(requestKey, loadMissingUrls().finally(() => tempFileUrlRequests.delete(requestKey)));
    }
    return { ...tempUrlMap, ...(await tempFileUrlRequests.get(requestKey)) };
  } catch (error) {
    console.warn("图片临时链接云函数获取失败，将尝试客户端兼容方式", error);
    try {
      const fallbackMap = await getDirectTempUrlMap(missingFileIds);
      Object.keys(fallbackMap).forEach((fileID) => {
        tempFileUrlCache.set(fileID, { url: fallbackMap[fileID], expiresAt: Date.now() + TEMP_FILE_URL_CACHE_TTL });
        tempUrlMap[fileID] = fallbackMap[fileID];
      });
    } catch (fallbackError) {
      console.warn("图片临时链接客户端兼容方式失败，请确认 caseAdmin 云函数已部署", fallbackError);
    }
    return tempUrlMap;
  }
}

function getCaseDisplayImage(item, options = {}) {
  if (options.preferBanner === true) {
    return item.coverBanner || item.coverThumbnail || item.coverImage;
  }
  return options.preferThumbnail !== false ? item.coverThumbnail || item.coverImage : item.coverImage;
}

function getCaseGalleryImages(item = {}) {
  const images = Array.isArray(item.galleryImages) && item.galleryImages.length
    ? item.galleryImages
    : [item.coverImage];
  return Array.from(new Set(images.filter(Boolean)));
}

async function attachCaseImageUrls(cases, options = {}) {
  const imageFileIds = cases.map((item) => getCaseDisplayImage(item, options));
  const tempUrlMap = await getTempUrlMap(imageFileIds, options);
  return cases.map((item) => ({
    ...item,
    imageFileId: getCaseDisplayImage(item, options),
    coverImageUrl: resolveImageUrl(getCaseDisplayImage(item, options), tempUrlMap),
    imageLoadState: "ready",
    imageRetryCount: 0,
  }));
}

async function attachCaseDetailImageUrls(cases) {
  const imageFileIds = cases.flatMap((item) => [
    ...getCaseGalleryImages(item),
    ...(item.galleryThumbnails || []),
    item.coverThumbnail,
  ].filter(Boolean));
  const tempUrlMap = await getTempUrlMap(imageFileIds);
  return cases.map((item) => {
    const galleryImages = getCaseGalleryImages(item);
    const galleryThumbnails =
      Array.isArray(item.galleryThumbnails) ? item.galleryThumbnails : [];
    const gallery = galleryImages.map((fileID, index) => {
      const thumbnailFileID =
        galleryThumbnails[index] || item.coverThumbnail || fileID;
      const url = resolveImageUrl(fileID, tempUrlMap);
      return {
        fileID,
        url,
        thumbnailUrl: resolveImageUrl(thumbnailFileID, tempUrlMap) || url,
        downloadUrl: url,
      };
    });
    return {
      ...item,
      galleryImages,
      sourceGalleryImages: item.sourceGalleryImages || galleryImages,
      galleryThumbnails,
      gallery,
      coverImage: galleryImages[0] || item.coverImage,
      coverImageUrl: gallery[0] ? gallery[0].url : "",
    };
  });
}

async function refreshImageUrl(fileID) {
  const urls = await getTempUrlMap([fileID], { forceRefresh: true });
  return resolveImageUrl(fileID, urls);
}

async function attachBannerImageUrls(banners) {
  const tempUrlMap = await getTempUrlMap(banners.map((item) => item.image));
  return banners.map((item) => ({
    ...item,
    imageUrl: resolveImageUrl(item.image, tempUrlMap),
  }));
}

async function fetchVisibleCases(options = {}) {
  const includeImageUrls = options.includeImageUrls !== false;

  if (!shouldForceRefresh(options) && visibleCasesCache) {
    const cachedCases = copyList(visibleCasesCache);
    return includeImageUrls ? attachCaseImageUrls(cachedCases) : cachedCases;
  }
  const records = await fetchAll(CASE_COLLECTION, {
    where: { isVisible: true },
    orderField: "sortOrder",
  });
  const cases = records.map(normalizeCaseRecord);
  visibleCasesCache = copyList(cases);
  return includeImageUrls ? attachCaseImageUrls(cases) : copyList(cases);
}

async function fetchVisibleBanners(cases, options = {}) {
  if (!shouldForceRefresh(options) && visibleBannersCache) {
    return copyList(visibleBannersCache);
  }
  const records = await fetchAll(BANNER_COLLECTION, {
    where: { isVisible: true },
    orderField: "sortOrder",
  });
  const banners = buildFallbackBanners(records.map(normalizeBannerRecord), cases);
  visibleBannersCache = await attachBannerImageUrls(banners);
  return copyList(visibleBannersCache);
}

function createCaseNotFoundError(id) {
  const error = new Error(`案例不存在：${id}`);
  error.code = "CASE_NOT_FOUND";
  return error;
}

async function fetchCaseById(id) {
  const db = getDb();
  if (isStableCaseId(id)) {
    const response = await db
      .collection(CASE_COLLECTION)
      .where({ caseId: id })
      .limit(1)
      .get();
    const record = (response.data || [])[0];
    if (!record) {
      throw createCaseNotFoundError(id);
    }
    const cases = await attachCaseDetailImageUrls([normalizeCaseRecord(record)]);
    return cases[0];
  }

  try {
    const response = await db.collection(CASE_COLLECTION).doc(id).get();
    const cases = await attachCaseDetailImageUrls([normalizeCaseRecord(response.data)]);
    return cases[0];
  } catch (error) {
    const response = await db
      .collection(CASE_COLLECTION)
      .where({ caseId: id })
      .limit(1)
      .get();
    const record = (response.data || [])[0];
    if (!record) throw createCaseNotFoundError(id);
    const cases = await attachCaseDetailImageUrls([normalizeCaseRecord(record)]);
    return cases[0];
  }
}

module.exports = {
  CASE_COLLECTION,
  BANNER_COLLECTION,
  attachCaseImageUrls,
  attachCaseDetailImageUrls,
  fetchVisibleCases,
  fetchVisibleBanners,
  fetchCaseById,
  getTempUrlMap,
  refreshImageUrl,
  clearCloudDataCache,
};
