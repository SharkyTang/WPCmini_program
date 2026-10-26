const cloud = require("wx-server-sdk");
const {
  USER_LIBRARY_LIMITS,
  buildCatalogSnapshot,
  buildDetail,
  buildDetailPatch,
  buildHomeFeed,
  buildIndexedHomeFeed,
  buildInitialDetail,
  chunkList,
  collectDetailImageFileIds,
  collectDetailPatchFileIds,
  collectDetailVideoFileIds,
  collectHomeImageFileIds,
  collectInitialDetailImageFileIds,
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
const CATALOG_IMAGE_ID_LIMIT = 24;
const CATALOG_IMAGE_ID_MAX_LENGTH = 128;
const DETAIL_GALLERY_LIMIT = 9;
const DETAIL_INITIAL_MODE = "initial_v2";
const DETAIL_PATCH_MODE = "gallery_patch_v2";
const HOME_INDEXED_MODE = "indexed_v2";

function isEnvironmentFlagEnabled(name) {
  if (typeof process === "undefined" || !process.env) return false;
  return ["1", "true", "yes", "on"].includes(
    String(process.env[name] || "").trim().toLowerCase()
  );
}

function ok(data = {}) {
  return { ok: true, ...data };
}

function fail(code, message) {
  return { ok: false, code, message };
}

function stripPublicVideo(item = {}) {
  const result = { ...item };
  delete result.videoUrl;
  delete result.videoPoster;
  delete result.videoDurationSeconds;
  return result;
}

async function getRevision() {
  try {
    const response = await db.collection(META_COLLECTION).doc(META_DOCUMENT_ID).get();
    const revision = Number(response && response.data && response.data.revision);
    if (Number.isFinite(revision) && revision > 0) {
      return { available: true, revision };
    }
    return { available: false, revision: 0 };
  } catch (error) {
    // A missing or temporarily unreadable revision must never validate cached
    // catalog data. The caller still returns a full response for availability.
    return { available: false, revision: 0 };
  }
}

function isKnownRevision(event, revisionState) {
  const knownRevision = Number(event && event.knownRevision);
  return Boolean(
    revisionState
    && revisionState.available
    && Number.isFinite(knownRevision)
    && knownRevision === revisionState.revision
  );
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
  coverBanner: true,
  imageVariantVersion: true,
};

async function getHomeFeed(event) {
  const revisionState = await getRevision();
  const useIndexedFeed =
    event.feedMode === HOME_INDEXED_MODE
    && isEnvironmentFlagEnabled("HOME_FEED_INDEXED_ENABLED");
  const feedModeUsed = useIndexedFeed ? HOME_INDEXED_MODE : "legacy";
  const modeAwareClient = event.feedMode === HOME_INDEXED_MODE;
  const cacheModeMatches = trimText(event.knownFeedMode) === feedModeUsed;
  if (
    isKnownRevision(event, revisionState)
    && (!modeAwareClient || cacheModeMatches)
  ) {
    return ok({
      revision: revisionState.revision,
      notModified: true,
      feedModeUsed,
    });
  }
  if (useIndexedFeed) {
    const [popularResponse, latestResponse, fallbackBannerResponse, bannerResponse] =
      await Promise.all([
        db
          .collection(CASE_COLLECTION)
          .where({ isVisible: true, "homeSections.values": "popular" })
          .field(CARD_FIELDS)
          .orderBy("sortOrder", "asc")
          .orderBy("caseId", "asc")
          .limit(4)
          .get(),
        db
          .collection(CASE_COLLECTION)
          .where({ isVisible: true, "homeSections.values": "latest" })
          .field(CARD_FIELDS)
          .orderBy("sortOrder", "desc")
          // Legacy sorting reverses sortOrder only; caseId remains ascending
          // as the deterministic tie breaker.
          .orderBy("caseId", "asc")
          .limit(6)
          .get(),
        db
          .collection(CASE_COLLECTION)
          .where({ isVisible: true, "homeSections.values": "banner" })
          .field(CARD_FIELDS)
          .orderBy("sortOrder", "asc")
          .orderBy("caseId", "asc")
          .limit(5)
          .get(),
        db
          .collection(BANNER_COLLECTION)
          .where({ isVisible: true })
          .field({
            _id: true,
            caseId: true,
            title: true,
            image: true,
            optimizedImage: true,
            imageVariantVersion: true,
            sortOrder: true,
            isVisible: true,
          })
          .orderBy("sortOrder", "asc")
          .limit(5)
          .get(),
      ]);
    const groups = {
      popularRecords: popularResponse.data || [],
      latestRecords: latestResponse.data || [],
      fallbackBannerRecords: fallbackBannerResponse.data || [],
    };
    const bannerRecords = bannerResponse.data || [];
    const caseRecords = [
      ...groups.popularRecords,
      ...groups.latestRecords,
      ...groups.fallbackBannerRecords,
    ];
    const urlMap = await getTempUrlMap(
      collectHomeImageFileIds(caseRecords, bannerRecords)
    );
    return ok({
      revision: revisionState.revision,
      notModified: false,
      feedModeUsed,
      ...buildIndexedHomeFeed(groups, bannerRecords, urlMap),
    });
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
        optimizedImage: true,
        imageVariantVersion: true,
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
    revision: revisionState.revision,
    notModified: false,
    feedModeUsed,
    ...buildHomeFeed(caseRecords, bannerRecords, urlMap),
  });
}

async function getCatalogSnapshot(event) {
  const revisionState = await getRevision();
  if (isKnownRevision(event, revisionState)) {
    return ok({ revision: revisionState.revision, notModified: true });
  }
  const records = await fetchAll(CASE_COLLECTION, {
    where: { isVisible: true },
    field: CARD_FIELDS,
    orderField: "sortOrder",
  });
  return ok({
    revision: revisionState.revision,
    notModified: false,
    // Keep the snapshot small and cacheable. Image URLs are hydrated only for
    // the cards currently visible in the category page.
    items: buildCatalogSnapshot(records),
  });
}

function normalizeCatalogImageIds(value) {
  if (!Array.isArray(value) || value.length > CATALOG_IMAGE_ID_LIMIT) return null;
  const ids = value.map(trimText);
  if (ids.some((id) => !id || id.length > CATALOG_IMAGE_ID_MAX_LENGTH)) {
    return null;
  }
  return Array.from(new Set(ids));
}

function resolveKnownImageUrl(fileID, urlMap = {}) {
  if (!fileID) return "";
  if (urlMap[fileID]) return urlMap[fileID];
  return fileID.indexOf("cloud://") === 0 ? "" : fileID;
}

async function getCatalogImageUrls(event) {
  const ids = normalizeCatalogImageIds(event.ids);
  if (!ids) {
    return fail(
      "INVALID_CATALOG_IMAGE_IDS",
      `案例图片 ID 必须是不超过 ${CATALOG_IMAGE_ID_LIMIT} 项的数组`
    );
  }
  if (!ids.length) return ok({ images: {} });

  // Resolve document ids against visible records before signing any file URL.
  // Client-provided file ids are never accepted by this endpoint.
  const records = await fetchCasesByField("_id", ids);
  const imageRecords = records.map((record) => {
    const item = normalizeCaseRecord(record);
    return {
      id: item.id,
      imageFileId: getCardImageFileId(item, { preferBanner: true }),
    };
  });
  const urlMap = await getTempUrlMap(
    imageRecords.map((item) => item.imageFileId)
  );
  const images = imageRecords.reduce((map, item) => {
    map[item.id] = {
      imageFileId: item.imageFileId,
      thumbnailUrl: resolveKnownImageUrl(item.imageFileId, urlMap),
    };
    return map;
  }, {});
  return ok({ images });
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
  const requestedMode = trimText(event.detailMode);
  const detailV2Enabled = isEnvironmentFlagEnabled("DETAIL_INITIAL_MODE_ENABLED");
  const videoDisplayEnabled = isEnvironmentFlagEnabled("VIDEO_DISPLAY_ENABLED");
  const videoFileIDs = videoDisplayEnabled ? collectDetailVideoFileIds(record) : [];
  if (detailV2Enabled && requestedMode === DETAIL_INITIAL_MODE) {
    const urlMap = await getTempUrlMap(
      [...collectInitialDetailImageFileIds(record), ...videoFileIDs]
    );
    const item = buildInitialDetail(record, urlMap);
    return ok({
      detailSchemaVersion: 2,
      detailMode: DETAIL_INITIAL_MODE,
      item: videoDisplayEnabled ? item : stripPublicVideo(item),
    });
  }
  if (detailV2Enabled && requestedMode === DETAIL_PATCH_MODE) {
    const normalized = normalizeCaseRecord(record);
    const indexes = normalizeDetailIndexes(event.indexes, normalized.galleryImages.length);
    if (!indexes) {
      return fail(
        "INVALID_DETAIL_INDEXES",
        `图库索引必须是不超过 ${DETAIL_GALLERY_LIMIT} 项的唯一整数数组`
      );
    }
    const urlMap = await getTempUrlMap(
      collectDetailPatchFileIds(record, indexes)
    );
    return ok({
      detailSchemaVersion: 2,
      detailMode: DETAIL_PATCH_MODE,
      galleryPatch: buildDetailPatch(record, indexes, urlMap),
    });
  }
  const urlMap = await getTempUrlMap([
    ...collectDetailImageFileIds(record),
    ...videoFileIDs,
  ]);
  const item = buildDetail(record, urlMap);
  return ok({
    item: videoDisplayEnabled ? item : stripPublicVideo(item),
  });
}

function normalizeDetailIndexes(value, galleryLength) {
  if (!Array.isArray(value) || !value.length || value.length > DETAIL_GALLERY_LIMIT) {
    return null;
  }
  const indexes = value.slice();
  if (
    indexes.some(
      (index) =>
        !Number.isInteger(index)
        || index < 0
        || index >= galleryLength
    )
    || new Set(indexes).size !== indexes.length
  ) {
    return null;
  }
  return indexes;
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
    if (action === "getCatalogImageUrls") return getCatalogImageUrls(event);
    if (action === "getCaseDetail") return getCaseDetail(event);
    if (action === "listUserLibrary") return listUserLibrary(event, OPENID);
    return fail("UNKNOWN_ACTION", "未知案例目录操作");
  } catch (error) {
    console.error("caseCatalog error", error);
    return fail("SERVER_ERROR", error.message || "案例目录服务异常");
  }
};
