const {
  normalizeCaseRecord,
  normalizeBannerRecord,
  buildFallbackBanners,
} = require("./caseData");

const CASE_COLLECTION = "wine_packaging";
const BANNER_COLLECTION = "home_banners";
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
        wx.cloud.getTempFileURL({ fileList })
      )
    );
    return responses.reduce((map, response) => {
      (response.fileList || []).forEach((item) => {
        const url = item.tempFileURL || item.fileID;
        tempFileUrlCache.set(item.fileID, url);
        map[item.fileID] = url;
      });
      return map;
    }, tempUrlMap);
  } catch (error) {
    console.warn("图片临时链接获取失败，将尝试直接使用 cloudID", error);
    return tempUrlMap;
  }
}

async function attachCaseImageUrls(cases) {
  const tempUrlMap = await getTempUrlMap(cases.map((item) => item.coverImage));
  return cases.map((item) => ({
    ...item,
    coverImageUrl: tempUrlMap[item.coverImage] || item.coverImage,
  }));
}

async function attachBannerImageUrls(banners) {
  const tempUrlMap = await getTempUrlMap(banners.map((item) => item.image));
  return banners.map((item) => ({
    ...item,
    imageUrl: tempUrlMap[item.image] || item.image,
  }));
}

async function fetchVisibleCases(options = {}) {
  if (!shouldForceRefresh(options) && visibleCasesCache) {
    return copyList(visibleCasesCache);
  }
  const records = await fetchAll(CASE_COLLECTION, {
    where: { isVisible: true },
    orderField: "sortOrder",
  });
  const cases = records.map(normalizeCaseRecord);
  visibleCasesCache = await attachCaseImageUrls(cases);
  return copyList(visibleCasesCache);
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
  fetchVisibleCases,
  fetchVisibleBanners,
  fetchCaseById,
  clearCloudDataCache,
};
