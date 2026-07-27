const {
  normalizeCaseRecord,
  normalizeBannerRecord,
  buildFallbackBanners,
} = require("./caseData");

const CASE_COLLECTION = "wine_packaging";
const BANNER_COLLECTION = "home_banners";
const IMAGE_URL_FUNCTION = "caseAdmin";
const PAGE_SIZE = 20;
const TEMP_FILE_URL_BATCH_SIZE = 50;

let visibleCasesCache = null;
let visibleBannersCache = null;
const tempFileUrlCache = new Map();

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

  const responses = await Promise.all(
    chunkList(fileIDs, TEMP_FILE_URL_BATCH_SIZE).map((fileList) =>
      wx.cloud.getTempFileURL({ fileList })
    )
  );
  return responses.reduce((map, response) => {
    (response.fileList || []).forEach((item) => {
      if (item && item.fileID && item.tempFileURL) {
        map[item.fileID] = item.tempFileURL;
      }
    });
    return map;
  }, {});
}

function resolveImageUrl(fileID, tempUrlMap = {}) {
  return tempUrlMap[fileID] || (isCloudFileId(fileID) ? "" : fileID);
}

function isStableCaseId(id) {
  return typeof id === "string" && id.indexOf("case_") === 0;
}

async function getTempUrlMap(fileIds) {
  const uniqueFileIds = Array.from(new Set(fileIds.filter(isCloudFileId)));
  if (!uniqueFileIds.length) return {};
  const tempUrlMap = {};
  const missingFileIds = [];

  uniqueFileIds.forEach((fileID) => {
    if (tempFileUrlCache.has(fileID)) {
      tempUrlMap[fileID] = tempFileUrlCache.get(fileID);
    } else {
      missingFileIds.push(fileID);
    }
  });

  if (!missingFileIds.length) return tempUrlMap;

  try {
    const responses = await Promise.all(
      chunkList(missingFileIds, TEMP_FILE_URL_BATCH_SIZE).map((fileList) =>
        callImageUrlFunction("getVisibleImageUrls", fileList)
      )
    );
    return responses.reduce((map, urlMap) => {
      Object.keys(urlMap).forEach((fileID) => {
        const url = urlMap[fileID];
        tempFileUrlCache.set(fileID, url);
        map[fileID] = url;
      });
      return map;
    }, tempUrlMap);
  } catch (error) {
    console.warn("图片临时链接云函数获取失败，将尝试客户端兼容方式", error);
    try {
      const fallbackMap = await getDirectTempUrlMap(missingFileIds);
      Object.keys(fallbackMap).forEach((fileID) => {
        tempFileUrlCache.set(fileID, fallbackMap[fileID]);
        tempUrlMap[fileID] = fallbackMap[fileID];
      });
    } catch (fallbackError) {
      console.warn("图片临时链接客户端兼容方式失败，请确认 caseAdmin 云函数已部署", fallbackError);
    }
    return tempUrlMap;
  }
}

async function attachCaseImageUrls(cases) {
  const tempUrlMap = await getTempUrlMap(cases.map((item) => item.coverImage));
  return cases.map((item) => ({
    ...item,
    coverImageUrl: resolveImageUrl(item.coverImage, tempUrlMap),
  }));
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
      throw new Error(`案例不存在：${id}`);
    }
    const cases = await attachCaseImageUrls([normalizeCaseRecord(record)]);
    return cases[0];
  }

  try {
    const response = await db.collection(CASE_COLLECTION).doc(id).get();
    const cases = await attachCaseImageUrls([normalizeCaseRecord(response.data)]);
    return cases[0];
  } catch (error) {
    const response = await db
      .collection(CASE_COLLECTION)
      .where({ caseId: id })
      .limit(1)
      .get();
    const record = (response.data || [])[0];
    if (!record) throw error;
    const cases = await attachCaseImageUrls([normalizeCaseRecord(record)]);
    return cases[0];
  }
}

module.exports = {
  CASE_COLLECTION,
  BANNER_COLLECTION,
  attachCaseImageUrls,
  fetchVisibleCases,
  fetchVisibleBanners,
  fetchCaseById,
  clearCloudDataCache,
};
