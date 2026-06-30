const {
  normalizeCaseRecord,
  normalizeBannerRecord,
  buildFallbackBanners,
} = require("./caseData");

const CASE_COLLECTION = "wine_packaging";
const BANNER_COLLECTION = "home_banners";
const PAGE_SIZE = 20;
const TEMP_FILE_URL_BATCH_SIZE = 50;

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

async function getTempUrlMap(fileIds) {
  const uniqueFileIds = Array.from(new Set(fileIds.filter(isCloudFileId)));
  if (!uniqueFileIds.length) return {};

  try {
    const responses = await Promise.all(
      chunkList(uniqueFileIds, TEMP_FILE_URL_BATCH_SIZE).map((fileList) =>
        wx.cloud.getTempFileURL({ fileList })
      )
    );
    return responses.reduce((map, response) => {
      (response.fileList || []).forEach((item) => {
        map[item.fileID] = item.tempFileURL || item.fileID;
      });
      return map;
    }, {});
  } catch (error) {
    console.warn("图片临时链接获取失败，将尝试直接使用 cloudID", error);
    return {};
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

async function fetchVisibleCases() {
  const records = await fetchAll(CASE_COLLECTION, {
    where: { isVisible: true },
    orderField: "sortOrder",
  });
  const cases = records.map(normalizeCaseRecord);
  return attachCaseImageUrls(cases);
}

async function fetchVisibleBanners(cases) {
  const records = await fetchAll(BANNER_COLLECTION, {
    where: { isVisible: true },
    orderField: "sortOrder",
  });
  const banners = buildFallbackBanners(records.map(normalizeBannerRecord), cases);
  return attachBannerImageUrls(banners);
}

async function fetchCaseById(id) {
  const db = getDb();
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
};
