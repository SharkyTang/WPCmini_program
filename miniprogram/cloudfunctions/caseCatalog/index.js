const cloud = require("wx-server-sdk");
const {
  USER_LIBRARY_LIMITS,
  buildCatalogSnapshot,
  buildDetail,
  buildHomeFeed,
  chunkList,
  collectDetailImageFileIds,
  collectHomeImageFileIds,
  getCardImageFileId,
  getLibraryType,
  mergeUserLibrary,
  normalizeCaseRecord,
  trimText,
} = require("./caseCatalogLogic");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;
const CASE_COLLECTION = "wine_packaging";
const BANNER_COLLECTION = "home_banners";
const META_COLLECTION = "catalog_meta";
const META_DOCUMENT_ID = "current";
const SERVER_PAGE_SIZE = 100;
const LOOKUP_CHUNK_SIZE = 10;
const URL_BATCH_SIZE = 50;
const LOOKUP_CONCURRENCY = 4;

function ok(data = {}) {
  return { ok: true, ...data };
}

function fail(code, message) {
  return { ok: false, code, message };
}

async function getRevision() {
  try {
    const response = await db.collection(META_COLLECTION).doc(META_DOCUMENT_ID).get();
    const revision = Number(response && response.data && response.data.revision);
    return Number.isFinite(revision) && revision > 0 ? revision : 1;
  } catch (error) {
    return 1;
  }
}

function isKnownRevision(event, revision) {
  const knownRevision = Number(event && event.knownRevision);
  return Number.isFinite(knownRevision) && knownRevision === revision;
}

async function fetchAll(collectionName, options = {}) {
  const records = [];
  let offset = 0;
  while (true) {
    let query = db.collection(collectionName);
    if (options.where) query = query.where(options.where);
    if (options.field) query = query.field(options.field);
    if (options.orderField) {
      query = query.orderBy(options.orderField, options.orderDirection || "asc");
    }
    const response = await query.skip(offset).limit(SERVER_PAGE_SIZE).get();
    const page = response.data || [];
    records.push(...page);
    if (page.length < SERVER_PAGE_SIZE) break;
    offset += SERVER_PAGE_SIZE;
  }
  return records;
}

function uniqueCloudFileIds(fileIDs = []) {
  return Array.from(
    new Set(
      fileIDs.filter(
        (fileID) => typeof fileID === "string" && fileID.indexOf("cloud://") === 0
      )
    )
  );
}

async function getTempUrlMap(fileIDs = []) {
  const chunks = chunkList(uniqueCloudFileIds(fileIDs), URL_BATCH_SIZE);
  const responses = await Promise.all(
    chunks.map((fileList) => cloud.getTempFileURL({ fileList }))
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

const CARD_FIELDS = {
  _id: true,
  caseId: true,
  title: true,
  wineType: true,
  packageTypes: true,
  styles: true,
  priceLevel: true,
  scenes: true,
  statuses: true,
  homeSections: true,
  sortOrder: true,
  isPinned: true,
  isVisible: true,
  coverImage: true,
  coverThumbnail: true,
};

async function getHomeFeed(event) {
  const revision = await getRevision();
  if (isKnownRevision(event, revision)) {
    return ok({ revision, notModified: true });
  }
  const [caseRecords, bannerRecords] = await Promise.all([
    fetchAll(CASE_COLLECTION, {
      where: { isVisible: true },
      field: CARD_FIELDS,
      orderField: "sortOrder",
    }),
    fetchAll(BANNER_COLLECTION, {
      where: { isVisible: true },
      field: {
        _id: true,
        caseId: true,
        title: true,
        image: true,
        sortOrder: true,
        isVisible: true,
      },
      orderField: "sortOrder",
    }),
  ]);
  const urlMap = await getTempUrlMap(
    collectHomeImageFileIds(caseRecords, bannerRecords)
  );
  return ok({
    revision,
    notModified: false,
    ...buildHomeFeed(caseRecords, bannerRecords, urlMap),
  });
}

async function getCatalogSnapshot(event) {
  const revision = await getRevision();
  if (isKnownRevision(event, revision)) {
    return ok({ revision, notModified: true });
  }
  const records = await fetchAll(CASE_COLLECTION, {
    where: { isVisible: true },
    field: CARD_FIELDS,
    orderField: "sortOrder",
  });
  const urlMap = await getTempUrlMap(
    records.map((record) => getCardImageFileId(normalizeCaseRecord(record)))
  );
  return ok({
    revision,
    notModified: false,
    items: buildCatalogSnapshot(records, urlMap),
  });
}

async function findCaseById(id) {
  if (!id) return null;
  try {
    const response = await db.collection(CASE_COLLECTION).doc(id).get();
    if (response.data && response.data.isVisible !== false) return response.data;
  } catch (error) {
    // Stable case ids are resolved below.
  }
  const response = await db
    .collection(CASE_COLLECTION)
    .where({ caseId: id, isVisible: true })
    .limit(1)
    .get();
  return (response.data || [])[0] || null;
}

async function getCaseDetail(event) {
  const id = trimText(event.id);
  if (!id) return fail("INVALID_ID", "缺少案例 ID");
  const record = await findCaseById(id);
  if (!record) return fail("CASE_NOT_FOUND", "案例不存在或已隐藏");
  const urlMap = await getTempUrlMap(collectDetailImageFileIds(record));
  return ok({ item: buildDetail(record, urlMap) });
}

async function runWithConcurrency(tasks, concurrency = LOOKUP_CONCURRENCY) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker())
  );
  return results;
}

async function fetchCasesByField(field, ids = []) {
  const tasks = chunkList(Array.from(new Set(ids.filter(Boolean))), LOOKUP_CHUNK_SIZE).map(
    (values) => () =>
      db
        .collection(CASE_COLLECTION)
        .where({ [field]: _.in(values), isVisible: true })
        .field(CARD_FIELDS)
        .limit(values.length)
        .get()
  );
  const responses = await runWithConcurrency(tasks);
  return responses
    .flatMap((response) => response.data || [])
    .filter(Boolean);
}

async function fetchCasesByLibraryRecords(records = []) {
  const docIds = records.map((item) => item.caseDocId).filter(Boolean);
  const legacyCaseIds = records
    .filter((item) => !item.caseDocId)
    .map((item) => item.caseId)
    .filter(Boolean);
  const initialCases = [
    ...(await fetchCasesByField("_id", docIds)),
    ...(await fetchCasesByField("caseId", legacyCaseIds)),
  ];
  const foundDocIds = new Set(initialCases.map((item) => item._id).filter(Boolean));
  const fallbackCaseIds = records
    .filter(
      (item) =>
        item.caseDocId &&
        !foundDocIds.has(item.caseDocId) &&
        item.caseId
    )
    .map((item) => item.caseId);
  const fallbackCases = await fetchCasesByField("caseId", fallbackCaseIds);
  const seen = new Set();
  return [...initialCases, ...fallbackCases].filter((record) => {
    const key = record._id || record.caseId;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function removeStaleLibraryRecords(collectionName, ids = []) {
  await runWithConcurrency(
    ids.map(
      (id) => () => db.collection(collectionName).doc(id).remove()
    )
  );
}

async function listUserLibrary(event, openid) {
  const type = getLibraryType(event.type);
  if (!type) return fail("INVALID_LIBRARY_TYPE", "用户列表类型无效");
  if (!openid) return fail("UNAUTHORIZED", "未获取到微信身份");

  const isFavorites = type === "favorites";
  const collectionName = isFavorites ? "favorites" : "browse_history";
  const orderField = isFavorites ? "createdAt" : "lastViewedAt";
  const response = await db
    .collection(collectionName)
    .where({ _openid: openid })
    .orderBy(orderField, "desc")
    .limit(USER_LIBRARY_LIMITS[type])
    .get();
  const records = response.data || [];
  const cases = await fetchCasesByLibraryRecords(records);
  const urlMap = await getTempUrlMap(
    cases.map((record) => getCardImageFileId(normalizeCaseRecord(record)))
  );
  const result = mergeUserLibrary(type, records, cases, urlMap);
  if (result.staleIds.length) {
    await removeStaleLibraryRecords(collectionName, result.staleIds);
  }
  return ok({
    type,
    items: result.items,
  });
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const action = trimText(event.action);
  try {
    if (action === "getHomeFeed") return getHomeFeed(event);
    if (action === "getCatalogSnapshot") return getCatalogSnapshot(event);
    if (action === "getCaseDetail") return getCaseDetail(event);
    if (action === "listUserLibrary") return listUserLibrary(event, OPENID);
    return fail("UNKNOWN_ACTION", "未知案例目录操作");
  } catch (error) {
    console.error("caseCatalog error", error);
    return fail("SERVER_ERROR", error.message || "案例目录服务异常");
  }
};
